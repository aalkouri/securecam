// Tiny JSON-file persistence for settings and cameras.
// Everything lives in ./data (gitignored) because it holds credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.SECURECAM_DATA || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) {
  return path.join(DATA_DIR, name);
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, value) {
  const target = file(name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

// ---- settings (admin account + session secret) ----
export function getSettings() {
  const settings = readJson('settings.json', {});
  if (!settings.sessionSecret) {
    settings.sessionSecret = crypto.randomBytes(48).toString('hex');
    writeJson('settings.json', settings);
  }
  return settings;
}

export function saveSettings(settings) {
  writeJson('settings.json', settings);
}

// ---- cameras ----
export function getCameras() {
  return readJson('cameras.json', []);
}

export function saveCameras(cameras) {
  writeJson('cameras.json', cameras);
}
