// Periodically grabs one frame from each enabled camera, runs local object
// detection, and writes sightings/alerts to SQLite.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getCameras } from './store.js';
import { gridUrl, isClip, clipPath } from './cameras.js';
import { detect, loadModels, modelStatus } from './detector.js';
import {
  SNAPSHOT_DIR, MIN_SIGHTINGS, getSetting, setSetting, findMatch, createObject,
  updateObjectSignature, recordSighting, counts,
} from './database.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const CAPTURE_TIMEOUT_MS = 15_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function redact(text) {
  return String(text).replace(/(\w+:\/\/)[^@\s/]+@/g, '$1***@');
}

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

// One JPEG frame from the camera, without shelling out or echoing credentials.
function captureFrame(camera) {
  const url = gridUrl(camera);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...inputArgs(url),
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'mjpeg',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let done = false;
    const finish = (err, buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(buffer);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(new Error('Frame capture timed out'));
    }, CAPTURE_TIMEOUT_MS);
    proc.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        proc.kill('SIGKILL');
        finish(new Error('Captured frame is too large'));
      } else chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on('error', (err) => finish(new Error(`Failed to launch ffmpeg: ${err.message}`)));
    proc.on('close', () => {
      if (size && !done) finish(null, Buffer.concat(chunks));
      else if (!done) finish(new Error(redact(stderr.trim().split('\n').pop() || 'No frame captured')));
    });
  });
}

class DetectionLoop {
  constructor() {
    this.timer = null;
    this.busy = false;
    this.lastRun = null;
    this.lastError = null;
    this.processed = 0;
    this.detections = 0;
    // camera:object keys seen on the previous scan, used to tell a still-visible
    // object from a genuine re-arrival.
    this.present = new Set();
  }

  get enabled() {
    return getSetting('detection.enabled', true);
  }

  set enabled(value) {
    setSetting('detection.enabled', Boolean(value));
    if (value) this.start(); else this.stop();
  }

  get intervalMs() {
    return getSetting('detection.intervalMs', 4000);
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this.timer),
      busy: this.busy,
      intervalMs: this.intervalMs,
      sightingGapMs: getSetting('detection.sightingGapMs', 60_000),
      alertCooldownMs: getSetting('detection.alertCooldownMs', 300_000),
      lastRun: this.lastRun,
      lastError: this.lastError,
      processed: this.processed,
      detections: this.detections,
      minSightings: MIN_SIGHTINGS,
      models: modelStatus(),
      ...counts(),
    };
  }

  start() {
    if (this.timer || !this.enabled) return;
    const run = () => { this.tick().catch(() => {}); };
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
    setTimeout(run, 1000).unref();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  restart() {
    this.stop();
    if (this.enabled) this.start();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    this.lastRun = new Date().toISOString();
    try {
      await loadModels();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      this.busy = false;
      return;
    }
    const previouslyPresent = this.present;
    const nowPresent = new Set();
    try {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      const gap = getSetting('detection.sightingGapMs', 60_000);
      const cooldown = getSetting('detection.alertCooldownMs', 300_000);
      for (const camera of getCameras().filter((c) => c.enabled)) {
        try {
          const frame = await captureFrame(camera);
          this.processed += 1;
          const found = await detect(frame);
          for (const item of found) {
            this.detections += 1;
            await this.save(camera, item, gap, cooldown, previouslyPresent, nowPresent);
          }
        } catch (err) {
          console.warn(`Detection failed for ${camera.name}: ${err.message}`);
        }
      }
    } finally {
      this.present = nowPresent;
      this.busy = false;
    }
  }

  async save(camera, item, gap, cooldown, previouslyPresent, nowPresent) {
    const match = findMatch(item.kind, item.embedding, item.fingerprint);
    const seenAt = new Date().toISOString();
    const object = match
      ? match.object
      : createObject(item.kind, item.embedding, item.fingerprint);
    if (match) updateObjectSignature(object.id, item.embedding, item.fingerprint, seenAt);
    const key = `${camera.id}:${object.id}`;
    const wasPresent = previouslyPresent.has(key);
    nowPresent.add(key);

    const snapshot = `${crypto.randomUUID()}.jpg`;
    fs.writeFileSync(path.join(SNAPSHOT_DIR, snapshot), item.snapshot);
    const result = recordSighting({
      object, camera: { id: camera.id, name: camera.name },
      confidence: item.confidence,
      bbox: item.bbox,
      snapshot,
      seenAt,
      sightingGapMs: gap,
      alertCooldownMs: cooldown,
      wasPresent,
    });
    if (!result.sighting) {
      // No sighting was kept, so don't leave an unused snapshot behind.
      fs.unlinkSync(path.join(SNAPSHOT_DIR, snapshot));
    }
  }
}

export const detection = new DetectionLoop();
