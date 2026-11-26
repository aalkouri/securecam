// Runs ffmpeg processes that turn camera RTSP feeds into HLS for the browser.
//
// Each camera has up to three stream variants:
//   grid   - always on; the low-res stream shown in the camera grid
//   hd     - on demand; full-quality stream passed through as-is (H.264 or H.265)
//   hd-avc - on demand; full-quality stream converted to H.264 for browsers
//            that can't play H.265
// On-demand variants stop automatically once nobody has fetched them for a while.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { gridUrl, hdUrl, isClip, clipPath } from './cameras.js';

export const STREAM_DIR = path.join(DATA_DIR, 'streams');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
const HD_IDLE_MS = 30_000;
const PROBE_TIMEOUT_MS = 12_000;

export const VARIANTS = ['grid', 'hd', 'hd-avc'];

// ---------- probing ----------

// Ask the camera what it's sending. Resolves { codec, width, height } or throws.
export function probe(url) {
  if (url.startsWith('test://')) return Promise.resolve({ codec: 'test', width: 1920, height: 1080 });
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error'];
    if (url.startsWith('rtsp')) args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
    args.push('-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', isClip(url) ? clipPath(url) : url);
    const proc = spawn(FFPROBE, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`Failed to launch ffprobe: ${e.message}`)); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const s = JSON.parse(out).streams?.[0];
        if (s?.codec_name) return resolve({ codec: s.codec_name, width: s.width, height: s.height });
      } catch { /* fall through */ }
      reject(new Error(friendly(redact(err.trim().split('\n').pop() || 'No video stream found'))));
    });
  });
}

const codecCache = new Map(); // url -> codec

async function codecFor(url) {
  if (!codecCache.has(url)) codecCache.set(url, (await probe(url)).codec);
  return codecCache.get(url);
}

// ---------- ffmpeg arguments ----------

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p'];

function testArgs(camera, variant) {
  const label = camera.name.replace(/[^\w -]/g, '');
  // Windows ffmpeg builds usually lack a fontconfig setup, so point at a font directly.
  const font = process.platform === 'win32' ? ":fontfile='C\\:/Windows/Fonts/arial.ttf'" : '';
  const size = variant === 'grid' ? '640x360' : '1920x1080';
  const fontsize = variant === 'grid' ? 20 : 48;
  const tag = variant === 'grid' ? 'SD' : 'HD';
  const input = [
    '-re', '-f', 'lavfi',
    '-i', `testsrc2=size=${size}:rate=15,drawtext=text='${label} ${tag} %{localtime}'${font}:x=20:y=20:fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black@0.5`,
  ];
  // The synthetic HD stream is H.265, like a Reolink main stream.
  if (variant === 'hd') return [...input, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=30', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'];
  return [...input, ...X264];
}

function cameraArgs(url, codec, variant) {
  const input = [];
  if (isClip(url)) {
    // Recorded clip: loop forever, played at real-time speed like a live feed.
    // The initial burst fills the first HLS segments quickly so playback starts sooner.
    input.push('-stream_loop', '-1', '-re', '-readrate_initial_burst', '8', '-i', clipPath(url));
    // There's no separate low-res file, so shrink the clip for the grid.
    if (variant === 'grid') return [...input, '-vf', 'scale=640:-2', '-r', '15', ...X264];
  } else {
    // Give up on unreachable cameras after 10s (value is in microseconds).
    if (url.startsWith('rtsp')) input.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
    input.push('-i', url);
  }

  if (codec === 'h264') return [...input, '-c:v', 'copy'];
  if (codec === 'hevc' && variant === 'hd') return [...input, '-c:v', 'copy', '-tag:v', 'hvc1'];
  // Anything else gets converted to H.264, capped in size to keep CPU use sane.
  const maxWidth = variant === 'grid' ? 1280 : 1920;
  return [...input, '-vf', `scale='min(${maxWidth},iw)':-2`, ...X264];
}

// ---------- process management ----------

// Delete a stream folder without ever throwing. On Windows a folder stays
// locked until the ffmpeg process inside it has fully exited, so retry.
async function removeDir(dir) {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`Could not remove ${dir}: ${err.code || err.message}`);
  }
}

// Resolves once a child process has exited (immediately if it already has).
function exited(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.once('error', resolve); // never started
    setTimeout(resolve, 5000).unref(); // don't wait forever on a stuck process
  });
}

class StreamManager {
  constructor() {
    this.procs = new Map(); // key -> entry
    this.cleanups = new Map(); // key -> promise for a stopped stream's folder removal
    try {
      fs.rmSync(STREAM_DIR, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Could not clear ${STREAM_DIR}: ${err.code || err.message}`);
    }
    fs.mkdirSync(STREAM_DIR, { recursive: true });
    setInterval(() => this.#reapIdle(), 10_000).unref();
  }

  key(id, variant) {
    return `${id}_${variant}`;
  }

  status(id, variant = 'grid') {
    const entry = this.procs.get(this.key(id, variant));
    if (!entry) return { state: 'stopped' };
    return { state: entry.status, lastError: entry.lastError || null };
  }

  // Mark a stream as being watched (called on every playlist/segment fetch).
  touch(key) {
    const entry = this.procs.get(key);
    if (entry) entry.lastAccess = Date.now();
  }

  // Pick the HD variant for a viewer. H.264 cameras never need converting,
  // so they always use the pass-through variant.
  async hdVariantFor(camera, viewerPlaysHevc) {
    const url = hdUrl(camera);
    if (!url) return null;
    if (viewerPlaysHevc) return 'hd';
    const codec = url.startsWith('test://') ? 'test' : await codecFor(url).catch(() => null);
    return codec === 'h264' ? 'hd' : 'hd-avc';
  }

  // Start a variant if it isn't already running.
  ensure(camera, variant) {
    const key = this.key(camera.id, variant);
    let entry = this.procs.get(key);
    if (entry) {
      entry.lastAccess = Date.now();
      return entry;
    }
    entry = { key, camera, variant, status: 'starting', restarts: 0, stopped: false, lastAccess: Date.now() };
    this.procs.set(key, entry);
    this.#spawn(entry);
    return entry;
  }

  // Resolve true once the variant has a playable playlist, false on timeout.
  async waitLive(key, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = this.procs.get(key);
      if (!entry) return false;
      if (entry.status === 'live') return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  // (Re)start a camera's grid stream and drop any HD streams.
  startCamera(camera) {
    this.stopCamera(camera.id);
    for (const url of [gridUrl(camera), hdUrl(camera)]) if (url) codecCache.delete(url);
    this.ensure(camera, 'grid');
  }

  stopCamera(id) {
    for (const variant of VARIANTS) this.#stop(this.key(id, variant));
  }

  stopAll() {
    for (const key of [...this.procs.keys()]) this.#stop(key);
  }

  async #spawn(entry) {
    const { camera, variant } = entry;
    const dir = path.join(STREAM_DIR, entry.key);
    // A previous process for this stream may still be shutting down.
    await this.cleanups.get(entry.key);
    await removeDir(dir);
    if (entry.stopped) return;
    fs.mkdirSync(dir, { recursive: true });
    // While retrying after a failure, keep reporting "error" until it's live again.
    if (entry.restarts === 0) entry.status = 'starting';

    const url = variant === 'grid' ? gridUrl(camera) : hdUrl(camera);
    let videoArgs;
    try {
      if (url.startsWith('test://')) {
        videoArgs = testArgs(camera, variant);
      } else {
        videoArgs = cameraArgs(url, await codecFor(url), variant);
      }
    } catch (err) {
      return this.#failed(entry, err.message);
    }
    if (entry.stopped) return;

    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...videoArgs,
      '-an',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
      // fMP4 segments are required for H.265 and work fine for H.264.
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      'index.m3u8',
    ];

    // Run inside the stream folder: ffmpeg writes init.mp4 relative to its
    // working directory, not next to the playlist.
    const proc = spawn(FFMPEG, args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    entry.proc = proc;

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    // Consider the stream live once the first playlist is written.
    const readyCheck = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'index.m3u8'))) {
        entry.status = 'live';
        entry.restarts = 0;
        entry.lastError = null;
        clearInterval(readyCheck);
      }
    }, 400);

    proc.on('error', (err) => {
      stderr = `Failed to launch ffmpeg: ${err.message}`;
    });

    proc.on('exit', (code) => {
      clearInterval(readyCheck);
      if (entry.stopped) return;
      // The camera may have changed codec (e.g. a settings change); re-probe next time.
      codecCache.delete(url);
      this.#failed(entry, friendly(redact(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`)));
    });
  }

  #failed(entry, message) {
    if (entry.stopped) return;
    entry.status = 'error';
    entry.lastError = message;
    // Exponential backoff: 2s, 4s, 8s ... capped at 60s.
    const delay = Math.min(60_000, 2_000 * 2 ** entry.restarts);
    entry.restarts += 1;
    entry.timer = setTimeout(() => this.#spawn(entry), delay);
  }

  #stop(key) {
    const entry = this.procs.get(key);
    if (!entry) return;
    entry.stopped = true;
    clearTimeout(entry.timer);
    entry.proc?.kill('SIGKILL');
    this.procs.delete(key);
    const cleanup = exited(entry.proc)
      .then(() => removeDir(path.join(STREAM_DIR, key)))
      .finally(() => {
        if (this.cleanups.get(key) === cleanup) this.cleanups.delete(key);
      });
    this.cleanups.set(key, cleanup);
  }

  #reapIdle() {
    const now = Date.now();
    for (const entry of [...this.procs.values()]) {
      if (entry.variant !== 'grid' && now - entry.lastAccess > HD_IDLE_MS) this.#stop(entry.key);
    }
  }
}

// Turn common ffmpeg failures into something a person can act on.
export function friendly(msg) {
  if (/-138|timed out|Connection timed out/i.test(msg)) return 'Connection timed out — check the IP address and that the camera is on.';
  if (/refused/i.test(msg)) return 'Connection refused — check the port and that RTSP is enabled on the camera.';
  if (/401|Unauthorized/i.test(msg)) return 'Camera rejected the username or password.';
  if (/404|Not Found/i.test(msg)) return 'Stream path not found — check the path after the port in the URL.';
  return msg;
}

// Strip credentials from any URL that ffmpeg echoes back in errors.
function redact(text) {
  return text.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

export const streams = new StreamManager();
