// Save a short, browser-playable MP4 for each alert. The always-on grid stream
// is a rolling low-res buffer; a full-quality variant is started on demand when
// an alert happens. Clips are capped at 1080p so five seconds costs about
// 1–2 MB instead of 12 MB at full 4K.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { STREAM_DIR, streams } from './streams.js';
import { gridUrl, hdUrl, isClip, clipPath } from './cameras.js';

export const ALERT_CLIP_DIR = path.join(DATA_DIR, 'alert-clips');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CLIP_VIDEO = [
  '-vf', "scale='min(1920,iw)':-2", '-r', '30', '-an',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
];
const CLIP_SECONDS = 5;
const CLIP_TIMEOUT_MS = 45_000;

function inputArgs(url) {
  if (url.startsWith('test://')) {
    return ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15'];
  }
  const args = [];
  if (isClip(url)) {
    args.push('-stream_loop', '-1', '-re', '-readrate_initial_burst', '2', '-i', clipPath(url));
    return args;
  }
  if (url.startsWith('rtsp')) args.push('-rtsp_transport', 'tcp', '-timeout', '10000000');
  args.push('-i', url);
  return args;
}

function runFfmpeg(args, temp) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let done = false;
    let timedOut = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      // Wait for `close`: on Windows the temp file stays locked until ffmpeg exits.
    }, CLIP_TIMEOUT_MS);
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on('error', (err) => finish(new Error(`Failed to launch ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (timedOut) return finish(new Error('Clip recording timed out'));
      if (code === 0 && fs.existsSync(temp) && fs.statSync(temp).size > 0) return finish(null);
      finish(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function waitForSegments(dir, count, timeoutMs = 10_000) {
  const playlist = path.join(dir, 'index.m3u8');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(playlist, 'utf8').split('\n');
      if (lines.filter((line) => line.trim() && !line.startsWith('#')).length >= count) return true;
    } catch { /* playlist not written yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function recordHls(playlist, temp, startIndex) {
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-live_start_index', String(startIndex),
    '-i', playlist,
    '-t', String(CLIP_SECONDS),
    '-map', '0:v:0', ...CLIP_VIDEO, '-movflags', '+faststart',
    temp,
  ], temp);
}

async function recordDirect(camera, temp) {
  const url = hdUrl(camera) || gridUrl(camera);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputArgs(url),
    '-t', String(CLIP_SECONDS),
    ...CLIP_VIDEO,
    '-movflags', '+faststart', temp,
  ], temp);
}

export function removeAlertClip(name) {
  if (!/^\d+(-\d+)?\.mp4$/i.test(name)) return;
  try { fs.unlinkSync(path.join(ALERT_CLIP_DIR, name)); } catch { /* already gone */ }
}

// Full quality when there is a separate main stream; otherwise the grid feed.
// `false` asks ffmpeg for an H.264 variant the browser can always play.
async function sourceFor(camera) {
  const variant = await streams.hdVariantFor(camera, false).catch(() => null);
  if (!variant) {
    const dir = path.join(STREAM_DIR, `${camera.id}_grid`);
    return { playlist: path.join(dir, 'index.m3u8'), startIndex: -3, waitDir: dir };
  }
  const { key } = streams.ensure(camera, variant);
  const live = await streams.waitLive(key, 20_000);
  if (!live) throw new Error('Full-quality stream did not start in time');
  const dir = path.join(STREAM_DIR, key);
  await waitForSegments(dir, 3);
  return { playlist: path.join(dir, 'index.m3u8'), startIndex: -3, waitDir: dir };
}

export async function recordAlertClip(camera, output) {
  fs.mkdirSync(ALERT_CLIP_DIR, { recursive: true });
  const temp = `${output}.tmp.mp4`;
  fs.rmSync(temp, { force: true });
  try {
    const source = await sourceFor(camera);
    try {
      await recordHls(source.playlist, temp, source.startIndex);
    } catch (hlsErr) {
      console.warn(`HD clip remux failed, retrying direct capture: ${hlsErr.message}`);
      fs.rmSync(temp, { force: true });
      await recordDirect(camera, temp);
    }
    fs.renameSync(temp, output);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}
