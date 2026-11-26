// SQLite storage for detected objects, sightings and alerts.
// Uses the built-in node:sqlite driver — no native module to install.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';

export const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
// Nothing is shown in the UI (and no alert is raised) until an object has been
// seen more than twice. Records are still kept from the first sighting so
// re-identification can build up a history.
export const MIN_SIGHTINGS = 3;
// Face embeddings (ArcFace) use a much lower cosine threshold than the vehicle
// ReID model. Same person is typically >0.35; a stranger is around 0.
export const FACE_THRESHOLD = 0.35;
const REID_THRESHOLD = 0.80;
const db = new DatabaseSync(path.join(DATA_DIR, 'securecam.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS objects (
    id            TEXT PRIMARY KEY,
    identifier    TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,
    name          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    sightings     INTEGER NOT NULL DEFAULT 0,
    embedding     TEXT,
    fingerprint   TEXT
  );

  CREATE TABLE IF NOT EXISTS sightings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id    TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    camera_id    TEXT NOT NULL,
    camera_name  TEXT NOT NULL,
    seen_at      TEXT NOT NULL,
    confidence   REAL NOT NULL,
    bbox         TEXT NOT NULL,
    snapshot     TEXT NOT NULL,
    fingerprint  TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id    TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    sighting_id  INTEGER NOT NULL REFERENCES sightings(id) ON DELETE CASCADE,
    camera_id    TEXT NOT NULL,
    camera_name  TEXT NOT NULL,
    message      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    ack          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sightings_seen_at ON sightings(seen_at DESC);
  CREATE INDEX IF NOT EXISTS sightings_object ON sightings(object_id, seen_at DESC);
  CREATE INDEX IF NOT EXISTS alerts_created_at ON alerts(created_at DESC);
  CREATE INDEX IF NOT EXISTS objects_kind ON objects(kind);
`);

const json = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? json(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function objectRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier,
    kind: row.kind,
    name: row.name,
    firstSeen: row.created_at,
    lastSeen: row.last_seen_at,
    sightings: row.sightings,
    latestSnapshot: row.latest_snapshot || null,
    latestCamera: row.latest_camera || null,
    latestConfidence: row.latest_confidence ?? null,
  };
}

const LATEST = `o.*,
  (SELECT s.snapshot FROM sightings s WHERE s.object_id = o.id ORDER BY s.seen_at DESC LIMIT 1) AS latest_snapshot,
  (SELECT s.camera_name FROM sightings s WHERE s.object_id = o.id ORDER BY s.seen_at DESC LIMIT 1) AS latest_camera,
  (SELECT s.confidence FROM sightings s WHERE s.object_id = o.id ORDER BY s.seen_at DESC LIMIT 1) AS latest_confidence`;

export function listObjects(kind) {
  const rows = kind
    ? db.prepare(`SELECT ${LATEST} FROM objects o WHERE kind = ? AND o.sightings >= ? ORDER BY last_seen_at DESC, created_at DESC`).all(kind, MIN_SIGHTINGS)
    : db.prepare(`SELECT ${LATEST} FROM objects o WHERE o.sightings >= ? ORDER BY last_seen_at DESC, created_at DESC`).all(MIN_SIGHTINGS);
  return rows.map(objectRow);
}

export function getObject(id) {
  return objectRow(db.prepare('SELECT * FROM objects WHERE id = ?').get(id));
}

// Pick the closest known object of the same kind. ReID embeddings are primary;
// a perceptual hash is a fallback for when the ReID model isn't available.
export function findMatch(kind, embedding, fingerprint) {
  const candidates = db.prepare('SELECT * FROM objects WHERE kind = ? AND (embedding IS NOT NULL OR fingerprint IS NOT NULL)').all(kind);
  let best = null;
  for (const row of candidates) {
    let score = null;
    if (embedding && row.embedding) {
      const similarity = cosine(embedding, json(row.embedding, null));
      const threshold = kind === 'person' ? FACE_THRESHOLD : REID_THRESHOLD;
      if (similarity !== null && similarity >= threshold) score = similarity;
    }
    if (score === null && fingerprint && row.fingerprint) {
      const distance = hamming(fingerprint, row.fingerprint);
      if (distance <= 12) score = 1 - distance / 64;
    }
    if (score !== null && (!best || score > best.score)) best = { object: objectRow(row), score };
  }
  return best;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { distance += x & 1; x >>= 1; }
  }
  return distance;
}

const PREFIX = { car: 'CAR', truck: 'TRK', bus: 'BUS', person: 'PER', bicycle: 'BIK', motorcycle: 'MOT', cat: 'CAT', dog: 'DOG' };
const LABEL = { car: 'Car', truck: 'Truck', bus: 'Bus', person: 'Person', bicycle: 'Bicycle', motorcycle: 'Motorcycle', cat: 'Cat', dog: 'Dog' };

export function kindLabel(kind) {
  return LABEL[kind] || kind;
}

export function createObject(kind, embedding, fingerprint) {
  const id = crypto.randomUUID();
  const prefix = PREFIX[kind] || 'OBJ';
  let n = db.prepare('SELECT COUNT(*) AS n FROM objects WHERE kind = ?').get(kind).n + 1;
  let identifier = `${prefix}-${String(n).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM objects WHERE identifier = ?').get(identifier)) {
    n += 1;
    identifier = `${prefix}-${String(n).padStart(4, '0')}`;
  }
  const now = new Date().toISOString();
  const name = `${kindLabel(kind)} ${n}`;
  // Start at 0: recordSighting() increments this, so the count always matches
  // the number of sighting rows and the "seen more than twice" gate is exact.
  db.prepare(`INSERT INTO objects(id, identifier, kind, name, created_at, last_seen_at, sightings, embedding, fingerprint)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(id, identifier, kind, name, now, now,
      embedding ? JSON.stringify(embedding) : null, fingerprint || null);
  return getObject(id);
}

export function renameObject(id, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 64) : '';
  if (!clean) throw new Error('Name is required');
  const result = db.prepare('UPDATE objects SET name = ? WHERE id = ?').run(clean, id);
  if (!result.changes) throw new Error('Object not found');
  return getObject(id);
}

// Removing an object also removes its sightings and alerts (FK cascade).
// Return the snapshot names so the caller can delete the files.
export function deleteObject(id) {
  const snapshots = db.prepare('SELECT snapshot FROM sightings WHERE object_id = ?').all(id)
    .map((row) => row.snapshot);
  const result = db.prepare('DELETE FROM objects WHERE id = ?').run(id);
  if (!result.changes) throw new Error('Object not found');
  return snapshots;
}

export function updateObjectSignature(id, embedding, fingerprint, seenAt) {
  db.prepare(`UPDATE objects SET last_seen_at = ?,
              embedding = COALESCE(?, embedding),
              fingerprint = COALESCE(?, fingerprint) WHERE id = ?`)
    .run(seenAt, embedding ? JSON.stringify(embedding) : null, fingerprint || null, id);
}

function sightingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    objectId: row.object_id,
    objectName: row.name,
    identifier: row.identifier,
    kind: row.kind,
    cameraId: row.camera_id,
    cameraName: row.camera_name,
    seenAt: row.seen_at,
    confidence: row.confidence,
    bbox: json(row.bbox, []),
    snapshot: row.snapshot,
  };
}

const SIGHTING_SELECT = `SELECT s.*, o.name, o.identifier, o.kind FROM sightings s
                         JOIN objects o ON o.id = s.object_id`;

export function listSightings({ objectId, cameraId, kind, limit = 60 } = {}) {
  const where = ['o.sightings >= ?'];
  const args = [MIN_SIGHTINGS];
  if (objectId) { where.push('s.object_id = ?'); args.push(objectId); }
  if (cameraId) { where.push('s.camera_id = ?'); args.push(cameraId); }
  if (kind) { where.push('o.kind = ?'); args.push(kind); }
  const sql = `${SIGHTING_SELECT} WHERE ${where.join(' AND ')}
               ORDER BY s.seen_at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 60, 200)).map(sightingRow);
}

// Build the first MIN_SIGHTINGS sightings quickly (so a newly parked car is
// visible and nameable), then stop recording while it stays in view. A later
// arrival is a new sighting. The gap guards against brief detection flicker.
export function recordSighting({ object, camera, confidence, bbox, snapshot, seenAt, sightingGapMs, alertCooldownMs, wasPresent }) {
  const count = db.prepare('SELECT sightings FROM objects WHERE id = ?').get(object.id).sightings;
  const buildingUp = count < MIN_SIGHTINGS;
  const last = db.prepare(`SELECT seen_at FROM sightings WHERE object_id = ? AND camera_id = ? ORDER BY seen_at DESC LIMIT 1`)
    .get(object.id, camera.id);
  const recent = last && (Date.parse(seenAt) - Date.parse(last.seen_at)) < sightingGapMs;
  if (!buildingUp && (wasPresent || recent)) {
    db.prepare('UPDATE objects SET last_seen_at = ? WHERE id = ?').run(seenAt, object.id);
    return { sighting: null, alert: null };
  }

  const result = db.prepare(`INSERT INTO sightings(object_id, camera_id, camera_name, seen_at, confidence, bbox, snapshot)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(object.id, camera.id, camera.name, seenAt, confidence, JSON.stringify(bbox), snapshot);
  const sightingId = Number(result.lastInsertRowid);
  db.prepare('UPDATE objects SET sightings = sightings + 1, last_seen_at = ? WHERE id = ?').run(seenAt, object.id);

  let alert = null;
  // Stay quiet until we've seen this object more than twice.
  const seen = db.prepare('SELECT sightings FROM objects WHERE id = ?').get(object.id).sightings;
  const lastAlert = db.prepare(`SELECT created_at FROM alerts WHERE object_id = ? AND camera_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(object.id, camera.id);
  const quiet = lastAlert && (Date.parse(seenAt) - Date.parse(lastAlert.created_at)) < alertCooldownMs;
  if (seen >= MIN_SIGHTINGS && !quiet) {
    const message = `${object.name} showed up in camera ${camera.name}`;
    db.prepare(`INSERT INTO alerts(object_id, sighting_id, camera_id, camera_name, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(object.id, sightingId, camera.id, camera.name, message, seenAt);
    alert = { id: sightingId, message, cameraName: camera.name, createdAt: seenAt, objectId: object.id };
  }
  return { sighting: sightingRow(db.prepare(`${SIGHTING_SELECT} WHERE s.id = ?`).get(sightingId)), alert };
}

export function listAlerts({ since = 0, limit = 50 } = {}) {
  return db.prepare(`SELECT a.id, a.object_id, a.sighting_id, a.camera_id, a.camera_name, a.message, a.created_at, a.ack, o.name, o.identifier, o.kind
                     FROM alerts a JOIN objects o ON o.id = a.object_id
                     WHERE a.id > ? AND o.sightings >= ? ORDER BY a.id DESC LIMIT ?`)
    .all(Number(since) || 0, MIN_SIGHTINGS, Math.min(Number(limit) || 50, 200))
    .map((row) => ({
      id: row.id,
      objectId: row.object_id,
      objectName: row.name,
      identifier: row.identifier,
      kind: row.kind,
      cameraId: row.camera_id,
      cameraName: row.camera_name,
      message: row.message,
      createdAt: row.created_at,
      ack: Boolean(row.ack),
    }));
}

export function ackAlerts(ids, all = false) {
  if (all) return db.prepare('UPDATE alerts SET ack = 1 WHERE ack = 0').run().changes;
  const list = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(Number(id))).map(Number) : [];
  if (!list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  return db.prepare(`UPDATE alerts SET ack = 1 WHERE id IN (${placeholders})`).run(...list).changes;
}

export function counts() {
  return {
    objects: db.prepare('SELECT COUNT(*) AS n FROM objects WHERE sightings >= ?').get(MIN_SIGHTINGS).n,
    tracked: db.prepare('SELECT COUNT(*) AS n FROM objects').get().n,
    sightings: db.prepare(`SELECT COUNT(*) AS n FROM sightings s JOIN objects o ON o.id = s.object_id WHERE o.sightings >= ?`).get(MIN_SIGHTINGS).n,
    alerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN objects o ON o.id = a.object_id WHERE o.sightings >= ?`).get(MIN_SIGHTINGS).n,
    unreadAlerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN objects o ON o.id = a.object_id WHERE a.ack = 0 AND o.sightings >= ?`).get(MIN_SIGHTINGS).n,
  };
}

export function closeDatabase() {
  db.close();
}
