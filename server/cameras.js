// Camera definitions: validation, stream URL derivation, and the
// browser-safe view of a camera (never includes passwords).

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export const CAMERA_TYPES = ['reolink', 'generic'];
const URL_SCHEMES = /^(rtsp|rtsps|http|https|test|clip):\/\//i;

// Recorded clips that can stand in for a camera live in data/clips/. They can
// be used as clip://<filename> or with one of these short test:// aliases,
// which behave like the test://demo source when adding a camera.
export const CLIP_DIR = path.join(DATA_DIR, 'clips');
const CLIP_NAME = /^\w[\w .()-]*\.(mp4|mkv|mov|webm)$/i;
export const TEST_CAMERAS = {
  'reolink-sample': 'reolink-rlc810a-sample.mp4',
  'reolink-night-day': 'reolink-rlc810a-night-day.mp4',
  'drive-thru': 'clip-7409123-uhd.mp4',
  'city-street': 'clip-5266802-uhd.mp4',
  'night-crossing': 'clip-13973346-uhd.mp4',
};

export function isClip(url) {
  return typeof url === 'string' && url.toLowerCase().startsWith('clip://');
}

export function isTest(url) {
  return typeof url === 'string' && url.toLowerCase().startsWith('test://');
}

// Absolute path of a clip:// URL, or null if the name is not allowed.
export function clipPath(url) {
  const name = url.slice('clip://'.length);
  return CLIP_NAME.test(name) ? path.join(CLIP_DIR, name) : null;
}

// Resolve test://<alias> to its clip file. Unknown test URLs stay synthetic
// (test://demo is the original test pattern).
export function testClipPath(url) {
  if (!isTest(url)) return null;
  const raw = url.slice('test://'.length).split(/[/?#]/)[0];
  let alias;
  try { alias = decodeURIComponent(raw); } catch { alias = raw; }
  const name = alias.trim().toLowerCase().replace(/\.(mp4|mkv|mov|webm)$/i, '');
  const file = TEST_CAMERAS[name];
  return file ? path.join(CLIP_DIR, file) : null;
}

// Any URL backed by a local video file, in either URL form.
export function mediaClipPath(url) {
  return isClip(url) ? clipPath(url) : testClipPath(url);
}

// Older loop cameras used clip:// URLs. Switch known files to friendly aliases.
export function migrateTestCameraUrls(cameras) {
  const byFile = new Map(Object.entries(TEST_CAMERAS)
    .map(([alias, file]) => [file.toLowerCase(), alias]));
  let changed = 0;
  const next = cameras.map((cam) => {
    if (!isClip(cam.url)) return cam;
    const alias = byFile.get(cam.url.slice('clip://'.length).toLowerCase());
    if (!alias) return cam;
    changed += 1;
    return { ...cam, url: `test://${alias}` };
  });
  return { cameras: next, changed };
}
const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/;
// Names accept the characters people actually use for rooms and cameras.
// Passwords are deliberately not filtered. URLs only accept standard URL
// syntax, which still allows rtsp://, test:// and clip:// addresses.
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 -]*$/;
const SAFE_USERNAME_RE = /^[a-zA-Z0-9]{1,64}$/;
const SAFE_URL_RE = /^[a-zA-Z0-9._~:/?#@&=+$,%-]+$/;

function safeName(value, label, max) {
  const name = str(value, max);
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`${label} may only use letters, numbers, spaces and hyphens`);
  }
  return name;
}

// Main (full quality) and sub (low-res) stream URLs for a camera.
// `sub` is null when the camera has only one stream.
export function streamUrls(cam) {
  if (cam.type === 'reolink') {
    const auth = `${encodeURIComponent(cam.username)}:${encodeURIComponent(cam.password || '')}@`;
    const base = `rtsp://${auth}${cam.host}:${cam.port || 554}`;
    // Reolink uses these paths even when the stream is actually H.265.
    return { main: `${base}/h264Preview_01_main`, sub: `${base}/h264Preview_01_sub` };
  }
  if (isTest(cam.url) || isClip(cam.url)) {
    // Synthetic or recorded camera: behaves like a two-stream camera
    // (low-res in the grid, full quality in the full view).
    return { main: cam.url, sub: cam.url };
  }
  return { main: cam.url, sub: cam.subUrl || null };
}

// The grid uses the sub stream when there is one; full-screen uses main.
export function gridUrl(cam) {
  const { main, sub } = streamUrls(cam);
  return sub || main;
}

export function hdUrl(cam) {
  const { main, sub } = streamUrls(cam);
  return sub ? main : null;
}

function maskUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url;
  }
}

// Keep the stored password when the user left the masked placeholder in place.
function unmask(nextUrl, oldUrl) {
  if (!nextUrl || !oldUrl || !nextUrl.includes(':****@')) return nextUrl;
  try {
    const next = new URL(nextUrl);
    const old = new URL(oldUrl);
    if (next.password === '****') next.password = old.password;
    return next.toString();
  } catch {
    return nextUrl;
  }
}

function str(v, max = 512) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Validate a create/update payload. `existing` is the stored camera on edit.
export function validateCamera(body, existing) {
  const name = safeName(body.name, 'Name', 100);
  if (!name || name.length > 64) throw new Error('Name is required (max 64 characters)');
  const type = CAMERA_TYPES.includes(body.type) ? body.type : 'generic';
  const enabled = body.enabled !== false;

  // The IP address field also accepts the short test://sample URLs. Treat
  // those as test cameras rather than trying to validate them as hostnames.
  const host = str(body.host, 300);
  const requestedUrl = str(body.url);
  if ((isTest(host) || isClip(host)) && (type === 'reolink' || !requestedUrl)) {
    return validateCamera({ ...body, type: 'generic', url: host }, existing);
  }

  if (type === 'reolink') {
    const host = str(body.host, 300);
    if (!HOST_RE.test(host)) throw new Error('Enter the camera\'s IP address, e.g. 192.168.1.50');
    const port = body.port === undefined || body.port === '' ? 554 : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
    const username = str(body.username, 64);
    if (!username) throw new Error('Username is required (Reolink default is "admin")');
    if (!SAFE_USERNAME_RE.test(username)) throw new Error('Username may only use letters and numbers');
    let password = typeof body.password === 'string' ? body.password : '';
    if (!password && existing?.type === 'reolink') password = existing.password;
    if (!password) throw new Error('Password is required');
    return { name, type, enabled, host, port, username, password };
  }

  const url = unmask(str(body.url), existing?.url);
  if (!SAFE_URL_RE.test(url)) throw new Error('Stream URL contains unsupported characters');
  if (!URL_SCHEMES.test(url)) throw new Error('Stream URL must start with rtsp://, rtsps://, http(s)://, clip:// or test://');
  if (isTest(url)) {
    const file = testClipPath(url);
    if (file && !fs.existsSync(file)) {
      throw new Error(`No such test clip in data/clips: ${url.slice('test://'.length)}`);
    }
  } else if (isClip(url)) {
    const file = clipPath(url);
    if (!file) throw new Error('Clip name must be a plain video filename, e.g. clip://sample.mp4');
    if (!fs.existsSync(file)) throw new Error(`No such clip in data/clips: ${url.slice(7)}`);
  }
  // The form no longer exposes a low-res URL. Keep a stored one when an edit
  // omits it, while still letting older API clients clear it explicitly.
  const subUrlValue = body.subUrl === undefined ? existing?.subUrl || '' : str(body.subUrl);
  const subUrl = unmask(subUrlValue, existing?.subUrl) || null;
  if (subUrl && !URL_SCHEMES.test(subUrl)) throw new Error('Low-res URL must start with rtsp://, rtsps://, http(s)://');
  return { name, type, enabled, url, subUrl };
}

export function publicCamera(cam, extra = {}) {
  const base = {
    id: cam.id,
    name: cam.name,
    type: cam.type || 'generic',
    enabled: cam.enabled,
    hasHd: Boolean(hdUrl(cam)),
    ...extra,
  };
  if (base.type === 'reolink') {
    return { ...base, host: cam.host, port: cam.port || 554, username: cam.username };
  }
  return { ...base, url: maskUrl(cam.url), subUrl: maskUrl(cam.subUrl) };
}
