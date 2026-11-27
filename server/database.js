// SQLite storage for detected objects, sightings and alerts.
// Uses the built-in node:sqlite driver — no native module to install.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
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
// A named person is only treated as the same person above 40% similarity.
// Anything at or below that is shown again as a possible new person to name.
export const REVIEW_MAX_SCORE = 0.40;
const REVIEW_MIN_SCORE = 0.05;
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

// Older databases predate these columns. Add them in place so existing IDs,
// sightings and alerts are preserved.
function ensureColumn(table, name, definition) {
  const names = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!names.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn('objects', 'named', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('objects', 'candidate_of', 'TEXT');
ensureColumn('objects', 'candidate_score', 'REAL');
ensureColumn('alerts', 'clip', 'TEXT');

const PREFIX = { car: 'CAR', truck: 'TRK', bus: 'BUS', person: 'PER', bicycle: 'BIK', motorcycle: 'MOT', cat: 'CAT', dog: 'DOG' };
const LABEL = { car: 'Car', truck: 'Truck', bus: 'Bus', person: 'Person', bicycle: 'Bicycle', motorcycle: 'Motorcycle', cat: 'Cat', dog: 'Dog' };

// Anything not using the automatic "Person 1" style name was named by the user,
// so hide it from the naming list on upgrade too.
for (const row of db.prepare('SELECT id, kind, identifier, name FROM objects WHERE named = 0').all()) {
  const n = Number(String(row.identifier).split('-')[1]);
  if (row.name !== `${LABEL[row.kind] || row.kind} ${n}`) {
    db.prepare('UPDATE objects SET named = 1 WHERE id = ?').run(row.id);
  }
}

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
    named: Boolean(row.named),
    candidateOf: row.candidate_of || null,
    candidateScore: row.candidate_score ?? null,
    candidateName: row.candidate_name || null,
    firstSeen: row.created_at,
    lastSeen: row.last_seen_at,
    sightings: row.sightings,
    latestSnapshot: row.latest_snapshot || null,
    latestCamera: row.latest_camera || null,
    latestConfidence: row.latest_confidence ?? null,
  };
}

const LATEST = `o.*,
  (SELECT name FROM objects p WHERE p.id = o.candidate_of) AS candidate_name,
  (SELECT s.snapshot FROM sightings s WHERE s.object_id = o.id ORDER BY s.seen_at DESC LIMIT 1) AS latest_snapshot,
  (SELECT s.camera_name FROM sightings s WHERE s.object_id = o.id ORDER BY s.seen_at DESC LIMIT 1) AS latest_camera,
  (SELECT s.confidence FROM sightings s WHERE s.object_id = o.id ORDER BY s.seen_at DESC LIMIT 1) AS latest_confidence`;

// Named objects have already been dealt with. They stay in the database and in
// alerts, but only still-unnamed objects (including low-confidence possible
// matches to a named person) appear here for review.
export function listObjects(kind, all = false) {
  const named = all ? '' : 'AND o.named = 0';
  const rows = kind
    ? db.prepare(`SELECT ${LATEST} FROM objects o WHERE kind = ? ${named} AND o.sightings >= ? ORDER BY last_seen_at DESC, created_at DESC`).all(kind, MIN_SIGHTINGS)
    : db.prepare(`SELECT ${LATEST} FROM objects o WHERE o.sightings >= ? ${named} ORDER BY last_seen_at DESC, created_at DESC`).all(MIN_SIGHTINGS);
  return rows.map(objectRow);
}

export function getObject(id) {
  return objectRow(db.prepare(`SELECT ${LATEST} FROM objects o WHERE o.id = ?`).get(id));
}

// Store each distinct frame once, named by its SHA-256. Looping test videos
// produce the same frame many times; without this every repeat sighting would
// write another identical JPEG.
export function saveSnapshot(buffer) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const name = `${hash}.jpg`;
  if (!fs.existsSync(path.join(SNAPSHOT_DIR, name))) {
    fs.writeFileSync(path.join(SNAPSHOT_DIR, name), buffer);
  }
  return name;
}

// A discarded sighting must not delete a file that another sighting now shares.
export function removeSnapshotIfUnreferenced(name) {
  if (!/^[\w-]+\.jpg$/i.test(name)) return;
  if (db.prepare('SELECT 1 FROM sightings WHERE snapshot = ? LIMIT 1').get(name)) return;
  try { fs.unlinkSync(path.join(SNAPSHOT_DIR, name)); } catch { /* already gone */ }
}

// Fold older UUID-named duplicates into one hash-named file per image, repoint
// the sightings that used them, then remove files no sighting references.
export function cleanupSnapshots() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const groups = new Map();
  for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
    if (!/^[\w-]+\.jpg$/i.test(name)) continue;
    const file = path.join(SNAPSHOT_DIR, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile() || !stat.size) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(name);
  }

  const repoint = db.prepare('UPDATE sightings SET snapshot = ? WHERE snapshot = ?');
  let deduped = 0;
  for (const [hash, names] of groups) {
    const canonical = `${hash}.jpg`;
    let keep = canonical;
    if (!names.includes(canonical)) {
      keep = [...names].sort((a, b) => a.localeCompare(b))[0];
      try {
        fs.renameSync(path.join(SNAPSHOT_DIR, keep), path.join(SNAPSHOT_DIR, canonical));
      } catch { continue; }
    }
    for (const name of names) {
      if (name === keep) continue;
      repoint.run(canonical, name);
      fs.rmSync(path.join(SNAPSHOT_DIR, name), { force: true });
      deduped += 1;
    }
  }

  const referenced = new Set(db.prepare('SELECT DISTINCT snapshot FROM sightings').all()
    .map((row) => row.snapshot));
  let orphans = 0;
  for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
    if (!/^[\w-]+\.jpg$/i.test(name) || referenced.has(name)) continue;
    fs.rmSync(path.join(SNAPSHOT_DIR, name), { force: true });
    orphans += 1;
  }
  return { deduped, orphans };
}

// Score a stored object against a new detection. ReID embeddings are primary;
// a perceptual hash is the fallback when an embedding isn't available.
function scoreRow(row, kind, embedding, fingerprint) {
  if (embedding && row.embedding) {
    const similarity = cosine(embedding, json(row.embedding, null));
    if (similarity !== null) return similarity;
  }
  if (fingerprint && row.fingerprint) {
    const distance = hamming(fingerprint, row.fingerprint);
    if (distance <= 12) return 1 - distance / 64;
  }
  return null;
}

function thresholdFor(row, kind) {
  // Once a person has a name, only a clear face match is silently folded into
  // that record. A 40%-or-less match has to appear again for review.
  if (row.named && kind === 'person') return REVIEW_MAX_SCORE;
  return kind === 'person' ? FACE_THRESHOLD : REID_THRESHOLD;
}

// Pick the closest known object that is confident enough to absorb this image.
export function findMatch(kind, embedding, fingerprint) {
  const candidates = db.prepare('SELECT * FROM objects WHERE kind = ? AND (embedding IS NOT NULL OR fingerprint IS NOT NULL)').all(kind);
  let best = null;
  for (const row of candidates) {
    const score = scoreRow(row, kind, embedding, fingerprint);
    if (score === null || score <= thresholdFor(row, kind)) continue;
    if (!best || score > best.score) best = { object: objectRow(row), score };
  }
  return best;
}

// If the closest known object is already named but only weakly similar, keep
// this image as a new, unconfirmed candidate linked to that name.
export function findReviewCandidate(kind, embedding, fingerprint) {
  if (kind !== 'person') return null;
  const candidates = db.prepare(`SELECT * FROM objects
    WHERE kind = ? AND named = 1 AND embedding IS NOT NULL`).all(kind);
  let best = null;
  for (const row of candidates) {
    const score = scoreRow(row, kind, embedding, fingerprint);
    if (score === null || score <= REVIEW_MIN_SCORE || score > REVIEW_MAX_SCORE) continue;
    if (!best || score > best.score) best = { object: objectRow(row), score };
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

export function kindLabel(kind) {
  return LABEL[kind] || kind;
}

export function createObject(kind, embedding, fingerprint, candidate = null) {
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
  db.prepare(`INSERT INTO objects(id, identifier, kind, name, created_at, last_seen_at, sightings,
              embedding, fingerprint, candidate_of, candidate_score)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(id, identifier, kind, name, now, now,
      embedding ? JSON.stringify(embedding) : null, fingerprint || null,
      candidate?.objectId || null, candidate?.score ?? null);
  return getObject(id);
}

export function renameObject(id, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 64) : '';
  if (!clean) throw new Error('Name is required');
  // A named object is done: confident sightings still alert, but its card
  // leaves the naming page unless a low-confidence possible match appears.
  const result = db.prepare('UPDATE objects SET name = ?, named = 1 WHERE id = ?').run(clean, id);
  if (!result.changes) throw new Error('Object not found');
  return getObject(id);
}

// Removing an object also removes its sightings and alerts (FK cascade).
// Only return files no other sighting still references — snapshots are shared
// when two sightings captured the identical frame.
export function deleteObject(id) {
  const candidates = [...new Set(db.prepare('SELECT snapshot FROM sightings WHERE object_id = ?').all(id)
    .map((row) => row.snapshot))];
  const clips = db.prepare('SELECT clip FROM alerts WHERE object_id = ? AND clip IS NOT NULL').all(id)
    .map((row) => row.clip);
  const result = db.prepare('DELETE FROM objects WHERE id = ?').run(id);
  if (!result.changes) throw new Error('Object not found');
  const stillUsed = new Set(db.prepare('SELECT DISTINCT snapshot FROM sightings').all()
    .map((row) => row.snapshot));
  return { snapshots: candidates.filter((name) => !stillUsed.has(name)), clips };
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
    const inserted = db.prepare(`INSERT INTO alerts(object_id, sighting_id, camera_id, camera_name, message, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`)
      .run(object.id, sightingId, camera.id, camera.name, message, seenAt);
    alert = {
      id: Number(inserted.lastInsertRowid),
      message, cameraName: camera.name, createdAt: seenAt, objectId: object.id,
    };
  }
  return { sighting: sightingRow(db.prepare(`${SIGHTING_SELECT} WHERE s.id = ?`).get(sightingId)), alert };
}

const ALERT_SELECT = `SELECT a.id, a.object_id, a.sighting_id, a.camera_id, a.camera_name,
  a.message, a.created_at, a.ack, a.clip, o.name, o.identifier, o.kind, s.snapshot
  FROM alerts a JOIN objects o ON o.id = a.object_id
  LEFT JOIN sightings s ON s.id = a.sighting_id`;

function alertRow(row) {
  if (!row) return null;
  return {
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
    hasClip: Boolean(row.clip),
    clip: row.clip || null,
    snapshot: row.snapshot || null,
  };
}

export function getAlert(id) {
  return alertRow(db.prepare(`${ALERT_SELECT} WHERE a.id = ?`).get(id));
}

export function listAlerts({ since = 0, limit = 50 } = {}) {
  return db.prepare(`${ALERT_SELECT}
    WHERE a.id > ? AND o.sightings >= ? ORDER BY a.id DESC LIMIT ?`)
    .all(Number(since) || 0, MIN_SIGHTINGS, Math.min(Number(limit) || 50, 200))
    .map(alertRow);
}

export function setAlertClip(id, clip) {
  db.prepare('UPDATE alerts SET clip = ? WHERE id = ?').run(clip, id);
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
    objects: db.prepare('SELECT COUNT(*) AS n FROM objects WHERE sightings >= ? AND named = 0').get(MIN_SIGHTINGS).n,
    tracked: db.prepare('SELECT COUNT(*) AS n FROM objects').get().n,
    sightings: db.prepare(`SELECT COUNT(*) AS n FROM sightings s JOIN objects o ON o.id = s.object_id WHERE o.sightings >= ?`).get(MIN_SIGHTINGS).n,
    alerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN objects o ON o.id = a.object_id WHERE o.sightings >= ?`).get(MIN_SIGHTINGS).n,
    unreadAlerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN objects o ON o.id = a.object_id WHERE a.ack = 0 AND o.sightings >= ?`).get(MIN_SIGHTINGS).n,
  };
}

export function closeDatabase() {
  db.close();
}
