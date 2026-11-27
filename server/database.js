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

  -- Camera placement hierarchy. Rooms can only belong to one building, and a
  -- camera placement can only reference a room of its own building.
  -- A building belongs to one account; names only have to be unique within it.
  CREATE TABLE IF NOT EXISTS buildings (
    id         TEXT PRIMARY KEY,
    owner_id   INTEGER NOT NULL DEFAULT 1,
    name       TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    UNIQUE (owner_id, name)
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (building_id, name COLLATE NOCASE),
    UNIQUE (building_id, id)
  );

  CREATE TABLE IF NOT EXISTS camera_placements (
    camera_id   TEXT PRIMARY KEY,
    building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE RESTRICT,
    room_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (building_id, room_id) REFERENCES rooms(building_id, id) ON DELETE RESTRICT
  );

  -- One ZIP per local day. Clip metadata is copied here so an archive remains
  -- browsable after its alert row has passed the seven-day retention window.
  CREATE TABLE IF NOT EXISTS alert_archives (
    date       TEXT PRIMARY KEY,
    zip_name   TEXT NOT NULL,
    clip_count INTEGER NOT NULL DEFAULT 0,
    byte_size  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alert_archive_clips (
    archive_date TEXT NOT NULL REFERENCES alert_archives(date) ON DELETE CASCADE,
    alert_id     INTEGER NOT NULL,
    clip_name    TEXT NOT NULL,
    object_name  TEXT,
    identifier   TEXT,
    kind         TEXT,
    camera_name  TEXT,
    message      TEXT,
    seen_at      TEXT,
    snapshot     TEXT,
    PRIMARY KEY (archive_date, clip_name)
  );

  CREATE INDEX IF NOT EXISTS sightings_seen_at ON sightings(seen_at DESC);
  CREATE INDEX IF NOT EXISTS sightings_object ON sightings(object_id, seen_at DESC);
  CREATE INDEX IF NOT EXISTS alerts_created_at ON alerts(created_at DESC);
  CREATE INDEX IF NOT EXISTS objects_kind ON objects(kind);
  CREATE INDEX IF NOT EXISTS rooms_building ON rooms(building_id);
  CREATE INDEX IF NOT EXISTS camera_placements_room ON camera_placements(building_id, room_id);
  CREATE INDEX IF NOT EXISTS archive_clips_name ON alert_archive_clips(clip_name);
  CREATE INDEX IF NOT EXISTS archive_clips_alert ON alert_archive_clips(alert_id);
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
ensureColumn('alerts', 'repeats', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('alerts', 'last_seen_at', 'TEXT');
// Which account an object belongs to. Sightings and alerts belong to their
// object's owner. Everything from before accounts belongs to the admin (id 1).
ensureColumn('objects', 'owner_id', 'INTEGER NOT NULL DEFAULT 1');
// Floor-plan coordinates for each room. Values are percentages of the
// building outline so the plan scales with the browser window.
ensureColumn('rooms', 'x', 'REAL');
ensureColumn('rooms', 'y', 'REAL');
ensureColumn('rooms', 'w', 'REAL');
ensureColumn('rooms', 'h', 'REAL');

// Buildings were first created with names unique across the whole server.
// SQLite cannot drop that constraint in place, so rebuild the table once:
// existing buildings go to the admin (id 1) and keep their ids, so rooms and
// camera placements still point at them.
if (!db.prepare('PRAGMA table_info(buildings)').all().some((col) => col.name === 'owner_id')) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE buildings_new (
      id         TEXT PRIMARY KEY,
      owner_id   INTEGER NOT NULL DEFAULT 1,
      name       TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      UNIQUE (owner_id, name)
    );
    INSERT INTO buildings_new (id, owner_id, name, created_at)
      SELECT id, 1, name, created_at FROM buildings;
    DROP TABLE buildings;
    ALTER TABLE buildings_new RENAME TO buildings;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
db.exec('UPDATE alerts SET last_seen_at = created_at WHERE last_seen_at IS NULL');

// Default floor-plan slots. Rooms are percentages of the building square, so
// a plan looks the same on a laptop and a phone. A few rooms sit in a loose
// grid; larger buildings get more columns and shorter rooms.
function roomLayouts(count) {
  if (count <= 0) return [];
  const cols = Math.min(4, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const gap = 4;
  const w = (92 - (cols - 1) * gap) / cols;
  const rawH = (78 - (rows - 1) * gap) / rows;
  const h = Math.min(30, rawH);
  const totalH = rows * h + (rows - 1) * gap;
  const top = 12 + (78 - totalH) / 2;
  const round = (n) => Number(n.toFixed(2));
  return Array.from({ length: count }, (_, i) => ({
    x: round(4 + (i % cols) * (w + gap)),
    y: round(top + Math.floor(i / cols) * (h + gap)),
    w: round(w),
    h: round(h),
  }));
}

// Older rooms have no coordinates yet. Give each building's rooms a neat
// starting layout without touching rooms the user has already arranged.
db.exec('BEGIN IMMEDIATE');
try {
  const update = db.prepare('UPDATE rooms SET x = ?, y = ?, w = ?, h = ? WHERE id = ?');
  for (const building of db.prepare('SELECT id FROM buildings').all()) {
    const rooms = db.prepare(`SELECT id, x, y, w, h FROM rooms WHERE building_id = ?
      ORDER BY created_at, name COLLATE NOCASE`).all(building.id);
    const layouts = roomLayouts(rooms.length);
    rooms.forEach((room, index) => {
      if (room.x === null || room.y === null || room.w === null || room.h === null) {
        const slot = layouts[index] || { x: 6, y: 20, w: 28, h: 24 };
        update.run(slot.x, slot.y, slot.w, slot.h, room.id);
      }
    });
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

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

// ----- building / room placement -----

function placementName(value, label, required = true) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    if (required) throw new Error(`${label} name is required`);
    return '';
  }
  if (name.length > 100) throw new Error(`${label} name must be 100 characters or fewer`);
  return name;
}

function ownsBuilding(buildingId, ownerId) {
  return Boolean(db.prepare('SELECT 1 FROM buildings WHERE id = ? AND owner_id = ?').get(buildingId, ownerId));
}

export function listBuildings(ownerId) {
  const buildings = db.prepare('SELECT id, name, created_at AS createdAt FROM buildings WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(ownerId);
  const rooms = db.prepare(`SELECT id, building_id AS buildingId, name, created_at AS createdAt,
    x, y, w, h FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE owner_id = ?)
    ORDER BY name COLLATE NOCASE`).all(ownerId);
  return buildings.map((building) => ({
    id: building.id,
    name: building.name,
    createdAt: building.createdAt,
    rooms: rooms.filter((room) => room.buildingId === building.id)
      .map(({ buildingId, ...room }) => room),
  }));
}

export function createBuilding(value, ownerId) {
  const name = placementName(value, 'Building');
  if (db.prepare('SELECT 1 FROM buildings WHERE owner_id = ? AND name COLLATE NOCASE = ?').get(ownerId, name)) {
    throw new Error('A building with that name already exists');
  }
  const building = { id: crypto.randomUUID(), name };
  db.prepare('INSERT INTO buildings (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(building.id, ownerId, building.name, new Date().toISOString());
  return { ...building, rooms: [] };
}

export function createRoom(buildingId, value, ownerId) {
  if (!ownsBuilding(buildingId, ownerId)) throw new Error('Building not found');
  const name = placementName(value, 'Room');
  if (db.prepare(`SELECT 1 FROM rooms WHERE building_id = ? AND name COLLATE NOCASE = ?`)
    .get(buildingId, name)) {
    throw new Error('A room with that name already exists in this building');
  }
  const count = db.prepare('SELECT COUNT(*) AS total FROM rooms WHERE building_id = ?').get(buildingId).total;
  const slot = roomLayouts(count + 1)[count] || { x: 6, y: 20, w: 28, h: 24 };
  const room = { id: crypto.randomUUID(), buildingId, name, ...slot };
  db.prepare(`INSERT INTO rooms (id, building_id, name, created_at, x, y, w, h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(room.id, room.buildingId, room.name, new Date().toISOString(), room.x, room.y, room.w, room.h);
  return room;
}

// Save a room's position or size on the floor plan. Coordinates stay inside
// the building outline, and ownership is checked through the parent building.
export function updateRoomLayout(roomId, ownerId, layout = {}) {
  const current = db.prepare(`SELECT x, y, w, h FROM rooms WHERE id = ?
    AND building_id IN (SELECT id FROM buildings WHERE owner_id = ?)`).get(roomId, ownerId);
  if (!current) return null;
  const x = clamp(layout.x ?? current.x, 0, 92, Number(current.x) || 6);
  const y = clamp(layout.y ?? current.y, 0, 90, Number(current.y) || 12);
  const w = clamp(layout.w ?? current.w, 8, 100 - x, Number(current.w) || 28);
  const h = clamp(layout.h ?? current.h, 10, 100 - y, Number(current.h) || 24);
  const result = db.prepare(`UPDATE rooms SET x = ?, y = ?, w = ?, h = ? WHERE id = ?`)
    .run(x, y, w, h, roomId);
  return result.changes ? { x, y, w, h } : null;
}

export function renameBuilding(buildingId, ownerId, value) {
  if (!ownsBuilding(buildingId, ownerId)) return null;
  const name = placementName(value, 'Building');
  if (db.prepare(`SELECT 1 FROM buildings WHERE owner_id = ? AND name COLLATE NOCASE = ? AND id <> ?`)
    .get(ownerId, name, buildingId)) {
    throw new Error('A building with that name already exists');
  }
  db.prepare('UPDATE buildings SET name = ? WHERE id = ?').run(name, buildingId);
  return { id: buildingId, name };
}

function ownedRoom(roomId, ownerId) {
  return db.prepare(`SELECT r.id, r.building_id AS buildingId FROM rooms r
    WHERE r.id = ? AND r.building_id IN (SELECT id FROM buildings WHERE owner_id = ?)`)
    .get(roomId, ownerId) || null;
}

export function renameRoom(roomId, ownerId, value) {
  const room = ownedRoom(roomId, ownerId);
  if (!room) return null;
  const name = placementName(value, 'Room');
  if (db.prepare(`SELECT 1 FROM rooms WHERE building_id = ? AND name COLLATE NOCASE = ? AND id <> ?`)
    .get(room.buildingId, name, roomId)) {
    throw new Error('A room with that name already exists in this building');
  }
  db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(name, roomId);
  return { id: roomId, buildingId: room.buildingId, name };
}

export function deleteRoom(roomId, ownerId) {
  const room = ownedRoom(roomId, ownerId);
  if (!room) return null;
  const cameras = db.prepare('SELECT COUNT(*) AS total FROM camera_placements WHERE room_id = ?')
    .get(roomId).total;
  if (cameras) {
    throw new Error(`Delete the ${cameras} camera${cameras === 1 ? '' : 's'} in this room first`);
  }
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  return { id: roomId };
}

// Resolve the camera form's placement. Inline "new building" and "new room"
// names are created here; otherwise an existing room must match its building.
export function resolveCameraPlacement(body = {}, existing = null, ownerId) {
  const newBuilding = placementName(body.newBuilding, 'Building', false);
  const newRoom = placementName(body.newRoom, 'Room', false);
  let buildingId = typeof body.buildingId === 'string' ? body.buildingId.trim() : '';
  let roomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';

  if (newBuilding) {
    if (!newRoom) throw new Error('Enter a room name for the new building');
    const building = createBuilding(newBuilding, ownerId);
    buildingId = building.id;
    const room = createRoom(building.id, newRoom, ownerId);
    return { buildingId, roomId: room.id };
  }

  if (!buildingId) {
    if (existing?.buildingId && existing?.roomId) return existing;
    throw new Error('Building is required');
  }
  if (!ownsBuilding(buildingId, ownerId)) throw new Error('Building not found');

  if (newRoom) {
    const room = createRoom(buildingId, newRoom, ownerId);
    return { buildingId, roomId: room.id };
  }

  if (!roomId) {
    if (existing?.buildingId === buildingId && existing?.roomId) return existing;
    throw new Error('Room is required');
  }
  if (!db.prepare('SELECT 1 FROM rooms WHERE id = ? AND building_id = ?').get(roomId, buildingId)) {
    throw new Error('Room does not belong to this building');
  }
  return { buildingId, roomId };
}

export function setCameraPlacement(cameraId, placement) {
  db.prepare(`INSERT INTO camera_placements (camera_id, building_id, room_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(camera_id) DO UPDATE SET building_id = excluded.building_id,
      room_id = excluded.room_id`)
    .run(cameraId, placement.buildingId, placement.roomId, new Date().toISOString());
}

export function deleteCameraPlacement(cameraId) {
  db.prepare('DELETE FROM camera_placements WHERE camera_id = ?').run(cameraId);
}

export function getCameraPlacements() {
  const rows = db.prepare(`SELECT p.camera_id AS cameraId, p.building_id AS buildingId,
      p.room_id AS roomId, b.name AS buildingName, r.name AS roomName
    FROM camera_placements p
    JOIN buildings b ON b.id = p.building_id
    JOIN rooms r ON r.id = p.room_id AND r.building_id = p.building_id`).all();
  return new Map(rows.map((row) => [row.cameraId, row]));
}

// Old installs had no placement data. Give their cameras one fabricated
// building/room so every camera satisfies the new required hierarchy.
// Takes the saved cameras ({ id, ownerId }); each camera is placed in a
// building of its own account, never in someone else's.
export function ensureCameraPlacements(cameras = []) {
  const placed = new Set(db.prepare('SELECT camera_id FROM camera_placements').all().map((row) => row.camera_id));
  const missing = cameras.filter((cam) => typeof cam?.id === 'string' && cam.id && !placed.has(cam.id));
  const result = { fabricated: false, added: 0, building: null };
  if (!missing.length) return result;

  const insert = db.prepare(`INSERT OR IGNORE INTO camera_placements
    (camera_id, building_id, room_id, created_at) VALUES (?, ?, ?, ?)`);
  const now = new Date().toISOString();
  for (const ownerId of new Set(missing.map((cam) => cam.ownerId ?? 1))) {
    let building = listBuildings(ownerId)[0];
    if (!building) {
      building = createBuilding('Main Building', ownerId);
      result.fabricated = true;
    }
    let rooms = db.prepare('SELECT id FROM rooms WHERE building_id = ? ORDER BY created_at, name COLLATE NOCASE')
      .all(building.id);
    if (!rooms.length) rooms = [{ id: createRoom(building.id, 'Default Room', ownerId).id }];
    for (const cam of missing.filter((c) => (c.ownerId ?? 1) === ownerId)) {
      result.added += insert.run(cam.id, building.id, rooms[0].id, now).changes;
    }
    result.building = result.building || { id: building.id, name: building.name };
  }
  return result;
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
export function listObjects(ownerId, kind, all = false) {
  const named = all ? '' : 'AND o.named = 0';
  const rows = kind
    ? db.prepare(`SELECT ${LATEST} FROM objects o WHERE o.owner_id = ? AND kind = ? ${named} AND o.sightings >= ? ORDER BY last_seen_at DESC, created_at DESC`).all(ownerId, kind, MIN_SIGHTINGS)
    : db.prepare(`SELECT ${LATEST} FROM objects o WHERE o.owner_id = ? AND o.sightings >= ? ${named} ORDER BY last_seen_at DESC, created_at DESC`).all(ownerId, MIN_SIGHTINGS);
  return rows.map(objectRow);
}

// With an ownerId, only that account's object is returned.
export function getObject(id, ownerId = null) {
  const row = db.prepare(`SELECT ${LATEST} FROM objects o WHERE o.id = ?`).get(id);
  if (row && ownerId !== null && row.owner_id !== ownerId) return null;
  return objectRow(row);
}

// Whether a stored frame belongs to one of this account's sightings.
export function ownsSnapshot(ownerId, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sightings s JOIN objects o ON o.id = s.object_id
    WHERE s.snapshot = ? AND o.owner_id = ? LIMIT 1`).get(name, ownerId));
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
      // Repoint every alias, including the file just renamed to `canonical`:
      // sightings still reference its old UUID name.
      repoint.run(canonical, name);
      if (name === keep) continue;
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
// Objects are only ever matched against the same account's objects.
export function findMatch(ownerId, kind, embedding, fingerprint) {
  const candidates = db.prepare('SELECT * FROM objects WHERE owner_id = ? AND kind = ? AND (embedding IS NOT NULL OR fingerprint IS NOT NULL)').all(ownerId, kind);
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
export function findReviewCandidate(ownerId, kind, embedding, fingerprint) {
  if (kind !== 'person') return null;
  const candidates = db.prepare(`SELECT * FROM objects
    WHERE owner_id = ? AND kind = ? AND named = 1 AND embedding IS NOT NULL`).all(ownerId, kind);
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

export function createObject(ownerId, kind, embedding, fingerprint, candidate = null) {
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
              embedding, fingerprint, candidate_of, candidate_score, owner_id)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
    .run(id, identifier, kind, name, now, now,
      embedding ? JSON.stringify(embedding) : null, fingerprint || null,
      candidate?.objectId || null, candidate?.score ?? null, ownerId);
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

export function listSightings({ ownerId, objectId, cameraId, kind, limit = 60 } = {}) {
  const where = ['o.owner_id = ?', 'o.sightings >= ?'];
  const args = [ownerId, MIN_SIGHTINGS];
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
  const lastAlert = db.prepare(`SELECT COALESCE(last_seen_at, created_at) AS last_at FROM alerts
    WHERE object_id = ? AND camera_id = ? ORDER BY last_at DESC LIMIT 1`)
    .get(object.id, camera.id);
  const quiet = lastAlert && (Date.parse(seenAt) - Date.parse(lastAlert.last_at)) < alertCooldownMs;
  if (seen >= MIN_SIGHTINGS && !quiet) {
    const message = `${object.name} showed up in camera ${camera.name}`;
    // Repeat sightings fold into one unacknowledged alert so the dropdown and
    // the clip folder don't grow with every re-arrival.
    const active = db.prepare(`SELECT id FROM alerts
      WHERE object_id = ? AND camera_id = ? AND ack = 0 ORDER BY id DESC LIMIT 1`)
      .get(object.id, camera.id);
    let alertId;
    let repeats = 1;
    let createdAt = seenAt;
    if (active) {
      alertId = active.id;
      db.prepare('UPDATE alerts SET sighting_id = ?, last_seen_at = ?, repeats = repeats + 1 WHERE id = ?')
        .run(sightingId, seenAt, alertId);
      const updated = db.prepare('SELECT created_at, repeats FROM alerts WHERE id = ?').get(alertId);
      createdAt = updated.created_at;
      repeats = updated.repeats;
    } else {
      const inserted = db.prepare(`INSERT INTO alerts(object_id, sighting_id, camera_id, camera_name,
        message, created_at, last_seen_at, repeats) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
        .run(object.id, sightingId, camera.id, camera.name, message, seenAt, seenAt);
      alertId = Number(inserted.lastInsertRowid);
    }
    alert = {
      id: alertId, message, cameraName: camera.name, createdAt, lastSeen: seenAt,
      repeats, objectId: object.id,
    };
  }
  return { sighting: sightingRow(db.prepare(`${SIGHTING_SELECT} WHERE s.id = ?`).get(sightingId)), alert };
}

const ALERT_SELECT = `SELECT a.id, a.object_id, a.sighting_id, a.camera_id, a.camera_name,
  a.message, a.created_at, a.last_seen_at, a.repeats, a.ack, a.clip,
  (SELECT ac.archive_date FROM alert_archive_clips ac WHERE ac.alert_id = a.id
   ORDER BY ac.archive_date DESC LIMIT 1) AS archive_date,
  o.name, o.identifier, o.kind, o.owner_id, s.snapshot
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
    lastSeen: row.last_seen_at || row.created_at,
    repeats: row.repeats || 1,
    archiveDate: row.archive_date || null,
    ack: Boolean(row.ack),
    hasClip: Boolean(row.clip),
    clip: row.clip || null,
    snapshot: row.snapshot || null,
  };
}

// With an ownerId, only that account's alert is returned.
export function getAlert(id, ownerId = null) {
  const row = db.prepare(`${ALERT_SELECT} WHERE a.id = ?`).get(id);
  if (row && ownerId !== null && row.owner_id !== ownerId) return null;
  return alertRow(row);
}

export function listAlerts({ ownerId, since = 0, limit = 50 } = {}) {
  return db.prepare(`${ALERT_SELECT}
    WHERE o.owner_id = ? AND a.id > ? AND o.sightings >= ?
    ORDER BY COALESCE(a.last_seen_at, a.created_at) DESC, a.id DESC LIMIT ?`)
    .all(ownerId, Number(since) || 0, MIN_SIGHTINGS, Math.min(Number(limit) || 50, 200))
    .map(alertRow);
}

// Returns the previous clip name so the caller can remove the replaced file.
export function setAlertClip(id, clip) {
  const previous = db.prepare('SELECT clip FROM alerts WHERE id = ?').get(id);
  db.prepare('UPDATE alerts SET clip = ? WHERE id = ?').run(clip, id);
  return previous?.clip || null;
}

// Older databases have one alert row per re-arrival. Fold them into one row per
// object and camera so the dropdown and clip folder shrink immediately on
// upgrade. New sightings use the same rolling row from then on.
export function consolidateAlerts() {
  const groups = db.prepare(`SELECT object_id, camera_id FROM alerts
    GROUP BY object_id, camera_id HAVING COUNT(*) > 1`).all();
  // Archived clips no longer have a loose file, so never make a live alert
  // point back at one while folding older rows together.
  const archived = new Set(db.prepare('SELECT clip_name FROM alert_archive_clips').all()
    .map((row) => row.clip_name));
  const fold = db.prepare(`UPDATE alerts SET created_at = ?, last_seen_at = ?, repeats = ?,
    sighting_id = ?, clip = COALESCE(clip, ?) WHERE id = ?`);
  const remove = db.prepare('DELETE FROM alerts WHERE id = ?');
  let alerts = 0;
  const clips = new Set();
  for (const group of groups) {
    const rows = db.prepare(`SELECT id, sighting_id, clip, created_at,
      COALESCE(last_seen_at, created_at) AS last_at, COALESCE(repeats, 1) AS repeats
      FROM alerts WHERE object_id = ? AND camera_id = ? ORDER BY id`)
      .all(group.object_id, group.camera_id);
    if (rows.length < 2) continue;
    const keep = rows[rows.length - 1];
    // Prefer the newest live clip; an older one is only used if the newest
    // alert never recorded video.
    const chosenClip = rows.reduce((found, row) => (!archived.has(row.clip) && row.clip ? row.clip : found), null);
    const repeats = rows.reduce((sum, row) => sum + row.repeats, 0);
    const lastSeen = rows.reduce((latest, row) => (row.last_at > latest ? row.last_at : latest), rows[0].last_at);
    fold.run(rows[0].created_at, lastSeen, repeats, keep.sighting_id, chosenClip, keep.id);
    for (const row of rows) {
      if (row.id === keep.id) continue;
      remove.run(row.id);
      alerts += 1;
      if (row.clip && row.clip !== chosenClip && !archived.has(row.clip)) clips.add(row.clip);
    }
  }
  return { alerts, clips: [...clips] };
}

// Keep seven days of alert history by default. An alert that is still getting
// repeat sightings stays because its last_seen_at keeps moving forward.
export function pruneOldAlerts(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const clips = db.prepare(`SELECT clip FROM alerts
    WHERE clip IS NOT NULL AND COALESCE(last_seen_at, created_at) < ?`)
    .all(cutoff).map((row) => row.clip);
  const alerts = db.prepare(`DELETE FROM alerts WHERE COALESCE(last_seen_at, created_at) < ?`)
    .run(cutoff).changes;
  return { alerts, clips };
}

// ----- daily alert-clip archives -----

// Clips are archived by the local date of the clip filename, not by when the
// archive job happens to run. This makes catch-up after a downtime exact.
export function getUnarchivedClips() {
  return db.prepare(`SELECT a.id AS alert_id, a.clip, a.created_at, a.last_seen_at,
      a.message, a.camera_name, o.name AS object_name, o.identifier, o.kind, s.snapshot
    FROM alerts a
    JOIN objects o ON o.id = a.object_id
    LEFT JOIN sightings s ON s.id = a.sighting_id
    WHERE a.clip IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM alert_archive_clips ac WHERE ac.clip_name = a.clip)
    ORDER BY a.clip`)
    .all()
    .map((row) => ({
      alertId: row.alert_id,
      clip: row.clip,
      createdAt: row.created_at,
      lastSeen: row.last_seen_at || row.created_at,
      objectName: row.object_name,
      identifier: row.identifier,
      kind: row.kind,
      cameraName: row.camera_name,
      message: row.message,
      snapshot: row.snapshot || null,
    }));
}

export function listArchives() {
  return db.prepare(`SELECT date, zip_name AS zipName, clip_count AS clipCount,
      byte_size AS byteSize, created_at AS createdAt
    FROM alert_archives ORDER BY date DESC`)
    .all()
    .map((row) => ({
      date: row.date,
      zipName: row.zipName,
      clipCount: row.clipCount,
      byteSize: row.byteSize,
      createdAt: row.createdAt,
    }));
}

export function getArchive(date) {
  const row = db.prepare(`SELECT date, zip_name AS zipName, clip_count AS clipCount,
      byte_size AS byteSize, created_at AS createdAt
    FROM alert_archives WHERE date = ?`).get(date);
  if (!row) return null;
  return {
    date: row.date, zipName: row.zipName, clipCount: row.clipCount,
    byteSize: row.byteSize, createdAt: row.createdAt,
  };
}

export function getArchiveClips(date) {
  return db.prepare(`SELECT alert_id AS alertId, clip_name AS clipName,
      object_name AS objectName, identifier, kind, camera_name AS cameraName,
      message, seen_at AS seenAt, snapshot
    FROM alert_archive_clips WHERE archive_date = ?
    ORDER BY seen_at DESC, alert_id DESC`)
    .all(date)
    .map((row) => ({
      alertId: row.alertId,
      clipName: row.clipName,
      objectName: row.objectName,
      identifier: row.identifier,
      kind: row.kind,
      cameraName: row.cameraName,
      message: row.message,
      seenAt: row.seenAt,
      snapshot: row.snapshot || null,
    }));
}

// Store the archive and its clip metadata in one transaction. Only after this
// succeeds does the caller delete the loose MP4 files.
export function saveArchive(date, zipName, byteSize, clips) {
  const insertArchive = db.prepare(`INSERT OR IGNORE INTO alert_archives
    (date, zip_name, clip_count, byte_size, created_at) VALUES (?, ?, 0, ?, ?)`);
  const updateArchive = db.prepare('UPDATE alert_archives SET zip_name = ?, byte_size = ?, clip_count = ? WHERE date = ?');
  const insertClip = db.prepare(`INSERT OR IGNORE INTO alert_archive_clips
    (archive_date, alert_id, clip_name, object_name, identifier, kind, camera_name, message, seen_at, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const clearClip = db.prepare('UPDATE alerts SET clip = NULL WHERE id = ? AND clip = ?');

  db.exec('BEGIN');
  try {
    insertArchive.run(date, zipName, byteSize, new Date().toISOString());
    for (const clip of clips) {
      insertClip.run(date, clip.alertId, clip.clip, clip.objectName, clip.identifier,
        clip.kind, clip.cameraName, clip.message, clip.seenAt, clip.snapshot);
      clearClip.run(clip.alertId, clip.clip);
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM alert_archive_clips WHERE archive_date = ?').get(date).n;
    updateArchive.run(zipName, byteSize, count, date);
    db.exec('COMMIT');
    return count;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function pruneOldArchives(cutoffDate) {
  const zips = db.prepare('SELECT zip_name AS zipName FROM alert_archives WHERE date < ?')
    .all(cutoffDate).map((row) => row.zipName);
  const archives = db.prepare('DELETE FROM alert_archives WHERE date < ?').run(cutoffDate).changes;
  return { archives, zips };
}

const OWNED = 'object_id IN (SELECT id FROM objects WHERE owner_id = ?)';

export function ackAlerts(ownerId, ids, all = false) {
  if (all) return db.prepare(`UPDATE alerts SET ack = 1 WHERE ack = 0 AND ${OWNED}`).run(ownerId).changes;
  const list = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(Number(id))).map(Number) : [];
  if (!list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  return db.prepare(`UPDATE alerts SET ack = 1 WHERE id IN (${placeholders}) AND ${OWNED}`).run(...list, ownerId).changes;
}

export function counts(ownerId) {
  return {
    objects: db.prepare('SELECT COUNT(*) AS n FROM objects WHERE owner_id = ? AND sightings >= ? AND named = 0').get(ownerId, MIN_SIGHTINGS).n,
    tracked: db.prepare('SELECT COUNT(*) AS n FROM objects WHERE owner_id = ?').get(ownerId).n,
    sightings: db.prepare(`SELECT COUNT(*) AS n FROM sightings s JOIN objects o ON o.id = s.object_id WHERE o.owner_id = ? AND o.sightings >= ?`).get(ownerId, MIN_SIGHTINGS).n,
    alerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN objects o ON o.id = a.object_id WHERE o.owner_id = ? AND o.sightings >= ?`).get(ownerId, MIN_SIGHTINGS).n,
    unreadAlerts: db.prepare(`SELECT COUNT(*) AS n FROM alerts a JOIN objects o ON o.id = a.object_id WHERE o.owner_id = ? AND a.ack = 0 AND o.sightings >= ?`).get(ownerId, MIN_SIGHTINGS).n,
  };
}

export function closeDatabase() {
  db.close();
}
