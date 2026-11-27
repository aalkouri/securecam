// Nightly ZIP archives for alert clips. Each completed local day is written to
// one ZIP, indexed in SQLite, and its loose MP4 files are removed. The ZIP is
// unpacked on demand when someone browses that day in the UI.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { DATA_DIR } from './store.js';
import { ALERT_CLIP_DIR } from './clips.js';
import {
  getUnarchivedClips, getArchive, getArchiveClips, listArchives,
  saveArchive, pruneOldArchives,
} from './database.js';

export const ARCHIVE_DIR = path.join(DATA_DIR, 'alert-archives');
export const ARCHIVE_CACHE_DIR = path.join(DATA_DIR, 'archive-cache');
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_CLIP = /^\d+(-\d+)?\.mp4$/i;
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Give a clip that started just before midnight time to finish writing before
// the archive job picks it up.
const MIDNIGHT_DELAY_MS = 2 * 60 * 1000;

export function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function clipMillis(row) {
  // New clips are `<alert id>-<epoch ms>.mp4`; older ones are `<id>.mp4`.
  const match = /^(?:(\d+)-)?(\d+)\.mp4$/i.exec(row.clip || '');
  if (match?.[1]) return Number(match[2]);
  const parsed = Date.parse(row.lastSeen || row.createdAt || '');
  return Number.isNaN(parsed) ? null : parsed;
}

function clipSeenAt(row) {
  const ms = clipMillis(row);
  return ms === null ? (row.lastSeen || row.createdAt) : new Date(ms).toISOString();
}

function archiveDay(date, dayRows) {
  const zipName = `${date}.zip`;
  const zipPath = path.join(ARCHIVE_DIR, zipName);
  const entries = new Map();

  // A late clip may belong to a day that was already archived. Merge into the
  // existing ZIP rather than losing it.
  if (fs.existsSync(zipPath)) {
    try {
      for (const entry of new AdmZip(zipPath).getEntries()) {
        if (!entry.isDirectory && SAFE_CLIP.test(entry.entryName)) {
          entries.set(entry.entryName, entry.getData());
        }
      }
    } catch {
      fs.rmSync(zipPath, { force: true });
    }
  }

  const toRecord = [];
  let added = 0;
  for (const row of dayRows) {
    if (!SAFE_CLIP.test(row.clip)) continue;
    const file = path.join(ALERT_CLIP_DIR, row.clip);
    let bytes = null;
    try {
      if (fs.existsSync(file)) {
        const buffer = fs.readFileSync(file);
        if (buffer.length) bytes = buffer;
      }
    } catch { /* another process may be replacing this clip */ }
    if (bytes && !entries.has(row.clip)) added += 1;
    if (bytes) entries.set(row.clip, bytes);
    if (entries.has(row.clip)) toRecord.push({ ...row, seenAt: clipSeenAt(row) });
  }
  if (!entries.size) return null;

  const zip = new AdmZip();
  for (const [name, bytes] of entries) zip.addFile(name, bytes);
  const temp = `${zipPath}.tmp`;
  fs.rmSync(temp, { force: true });
  zip.writeZip(temp);
  fs.renameSync(temp, zipPath);

  const byteSize = fs.statSync(zipPath).size;
  saveArchive(date, zipName, byteSize, toRecord);
  for (const row of toRecord) {
    fs.rmSync(path.join(ALERT_CLIP_DIR, row.clip), { force: true });
  }
  if (added) {
    console.log(`Alert archive ${date}: ${added} clip${added === 1 ? '' : 's'}, ${(byteSize / 1048576).toFixed(1)} MB`);
  }
  return { clips: added, bytes: byteSize };
}

export function archivePendingDays() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const byDate = new Map();
  for (const row of getUnarchivedClips()) {
    const ms = clipMillis(row);
    if (ms === null) continue;
    const date = localDateKey(ms);
    if (!date) continue;
    byDate.set(date, [...(byDate.get(date) || []), row]);
  }

  const today = localDateKey();
  const cutoff = localDateKey(Date.now() - ARCHIVE_RETENTION_MS);
  const result = { days: 0, clips: 0, bytes: 0 };
  for (const date of [...byDate.keys()].sort()) {
    if (date >= today || (cutoff && date < cutoff)) continue;
    const archived = archiveDay(date, byDate.get(date));
    if (archived?.clips) {
      result.days += 1;
      result.clips += archived.clips;
      result.bytes += archived.bytes;
    }
  }
  return result;
}

export function pruneArchives() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_CACHE_DIR, { recursive: true });
  const cutoff = localDateKey(Date.now() - ARCHIVE_RETENTION_MS);
  const result = { archives: 0, zips: 0 };
  if (!cutoff) return result;
  const expired = pruneOldArchives(cutoff);
  for (const zip of expired.zips) fs.rmSync(path.join(ARCHIVE_DIR, zip), { force: true });
  for (const name of fs.readdirSync(ARCHIVE_CACHE_DIR, { withFileTypes: true })) {
    if (!name.isDirectory() || !SAFE_DATE.test(name.name) || name.name >= cutoff) continue;
    fs.rmSync(path.join(ARCHIVE_CACHE_DIR, name.name), { recursive: true, force: true });
  }
  result.archives = expired.archives;
  result.zips = expired.zips.length;
  return result;
}

export function cleanArchiveCache() {
  fs.mkdirSync(ARCHIVE_CACHE_DIR, { recursive: true });
  for (const entry of fs.readdirSync(ARCHIVE_CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_DATE.test(entry.name)) continue;
    const dir = path.join(ARCHIVE_CACHE_DIR, entry.name);
    const marker = path.join(dir, '.extracted');
    const statPath = fs.existsSync(marker) ? marker : dir;
    try {
      if (Date.now() - fs.statSync(statPath).mtimeMs > CACHE_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* already removed */ }
  }
}

export function runArchiveCycle() {
  const archived = archivePendingDays();
  const pruned = pruneArchives();
  cleanArchiveCache();
  if (pruned.archives) {
    console.log(`Alert archives: expired ${pruned.archives} day${pruned.archives === 1 ? '' : 's'} older than 30 days`);
  }
  return { archived, pruned };
}

function scheduleNextRun() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const target = midnight.getTime() + MIDNIGHT_DELAY_MS;
  const timer = setTimeout(() => {
    try { runArchiveCycle(); } catch (err) { console.warn(`Alert archive job failed: ${err.message}`); }
    scheduleNextRun();
  }, Math.max(1000, target - now.getTime()));
  timer.unref();
}

export function startArchiveJob() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_CACHE_DIR, { recursive: true });
  cleanArchiveCache();
  // Catch up on days missed while the server was off, then run nightly.
  try { runArchiveCycle(); } catch (err) { console.warn(`Alert archive startup pass failed: ${err.message}`); }
  scheduleNextRun();
}

function ensureExtracted(date) {
  if (!SAFE_DATE.test(date)) throw new Error('Invalid archive date');
  const archive = getArchive(date);
  if (!archive) throw new Error('Archive not found');
  const zipPath = path.join(ARCHIVE_DIR, `${date}.zip`);
  if (!fs.existsSync(zipPath)) throw new Error('Archive file is missing');

  const dir = path.join(ARCHIVE_CACHE_DIR, date);
  const marker = path.join(dir, '.extracted');
  const clips = getArchiveClips(date);
  const complete = fs.existsSync(marker)
    && fs.statSync(marker).mtimeMs >= fs.statSync(zipPath).mtimeMs
    && clips.every((clip) => fs.existsSync(path.join(dir, clip.clipName)));
  if (complete) return dir;

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !SAFE_CLIP.test(entry.entryName)) continue;
    fs.writeFileSync(path.join(dir, entry.entryName), entry.getData());
  }
  fs.writeFileSync(marker, new Date().toISOString());
  return dir;
}

export function extractArchive(date) {
  const archive = getArchive(date);
  if (!archive) throw new Error('Archive not found');
  ensureExtracted(date);
  return {
    date,
    clipCount: archive.clipCount,
    clips: getArchiveClips(date).map((clip) => ({
      ...clip,
      hasClip: true,
      clipUrl: `/api/alert-archives/${date}/clip/${encodeURIComponent(clip.clipName)}`,
    })),
  };
}

export function archiveClipPath(date, name) {
  if (!SAFE_DATE.test(date) || !SAFE_CLIP.test(name)) return null;
  if (!getArchiveClips(date).some((clip) => clip.clipName === name)) return null;
  const file = path.join(ensureExtracted(date), name);
  return fs.existsSync(file) ? file : null;
}

export { listArchives };
