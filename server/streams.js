// Manages one ffmpeg process per enabled camera, converting the camera's
// RTSP feed into a rolling HLS playlist the browser can play.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const STREAM_DIR = path.join(DATA_DIR, 'streams');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function inputArgs(camera) {
  // test:// gives a synthetic feed so the app can be tried without hardware.
  if (camera.url.startsWith('test://')) {
    const label = camera.name.replace(/[^\w -]/g, '');
    // Windows ffmpeg builds usually lack a fontconfig setup, so point at a font directly.
    const font = process.platform === 'win32' ? ":fontfile='C\\:/Windows/Fonts/arial.ttf'" : '';
    return [
      '-re', '-f', 'lavfi',
      '-i', `testsrc2=size=1280x720:rate=15,drawtext=text='${label} %{localtime}'${font}:x=20:y=20:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.5`,
    ];
  }
  const args = [];
  // Give up on unreachable cameras after 10s (value is in microseconds).
  if (camera.url.startsWith('rtsp')) args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  args.push('-i', camera.url);
  return args;
}

function videoArgs(camera) {
  // Synthetic feeds and H.265 cameras must be transcoded; most browsers
  // only play H.264 in HLS. "copy" is far cheaper when the camera allows it.
  if (camera.transcode || camera.url.startsWith('test://')) {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'copy'];
}

class StreamManager {
  constructor() {
    this.procs = new Map(); // id -> { proc, status, restarts, timer, lastError }
    fs.rmSync(STREAM_DIR, { recursive: true, force: true });
    fs.mkdirSync(STREAM_DIR, { recursive: true });
  }

  status(id) {
    const entry = this.procs.get(id);
    if (!entry) return { state: 'stopped' };
    return { state: entry.status, lastError: entry.lastError || null };
  }

  start(camera) {
    this.stop(camera.id);
    const entry = { status: 'starting', restarts: 0, stopped: false };
    this.procs.set(camera.id, entry);
    this.#spawn(camera, entry);
  }

  #spawn(camera, entry) {
    const dir = path.join(STREAM_DIR, camera.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs(camera),
      '-an',
      ...videoArgs(camera),
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
      path.join(dir, 'index.m3u8'),
    ];

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    entry.proc = proc;
    // While retrying after a failure, keep reporting "error" until it's live again.
    if (entry.restarts === 0) entry.status = 'starting';

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    // Consider the stream live once the first playlist is written.
    const readyCheck = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'index.m3u8'))) {
        entry.status = 'live';
        entry.restarts = 0;
        clearInterval(readyCheck);
      }
    }, 500);

    proc.on('error', (err) => {
      entry.lastError = `Failed to launch ffmpeg: ${err.message}`;
    });

    proc.on('exit', (code) => {
      clearInterval(readyCheck);
      if (entry.stopped) return;
      entry.status = 'error';
      entry.lastError = friendly(redact(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
      // Exponential backoff: 2s, 4s, 8s ... capped at 60s.
      const delay = Math.min(60_000, 2_000 * 2 ** entry.restarts);
      entry.restarts += 1;
      entry.timer = setTimeout(() => this.#spawn(camera, entry), delay);
    });
  }

  stop(id) {
    const entry = this.procs.get(id);
    if (!entry) return;
    entry.stopped = true;
    clearTimeout(entry.timer);
    entry.proc?.kill('SIGKILL');
    this.procs.delete(id);
    fs.rmSync(path.join(STREAM_DIR, id), { recursive: true, force: true });
  }

  stopAll() {
    for (const id of [...this.procs.keys()]) this.stop(id);
  }
}

// Turn common ffmpeg failures into something a person can act on.
function friendly(msg) {
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
