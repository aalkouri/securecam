import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, getCameras, saveCameras } from './store.js';
import { isSetupComplete, requireAuth, requireAdmin } from './auth.js';
import { registerAccountRoutes } from './accounts.js';
import { adminId, closeUsers } from './users.js';
import { assertCameraAllowed } from './guard.js';
import { streams, STREAM_DIR, probe } from './streams.js';
import { validateCamera, publicCamera, gridUrl, hdUrl, migrateTestCameraUrls } from './cameras.js';
import { detection } from './detection.js';
import { ALERT_CLIP_DIR, removeAlertClip } from './clips.js';
import { startArchiveJob, listArchives, extractArchive, archiveClipPath } from './archives.js';
import {
  SNAPSHOT_DIR, setSetting, listObjects, getObject, renameObject, deleteObject,
  listSightings, listAlerts, getAlert, ackAlerts, cleanupSnapshots,
  consolidateAlerts, pruneOldAlerts, closeDatabase, ownsSnapshot,
  listBuildings, createBuilding, createRoom, resolveCameraPlacement,
  setCameraPlacement, deleteCameraPlacement, getCameraPlacements,
  ensureCameraPlacements,
} from './database.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
// Localhost only by default. Set HOST=0.0.0.0 to view from other devices on your LAN.
const HOST = process.env.HOST || '127.0.0.1';

// Set TRUST_PROXY=1 when an HTTPS reverse proxy on this machine (e.g. Caddy)
// sits in front. The login lockout then sees each visitor's real address
// instead of the proxy's, and the session cookie is marked Secure.
const BEHIND_PROXY = process.env.TRUST_PROXY === '1';

const app = express();
app.disable('x-powered-by');
if (BEHIND_PROXY) app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'",
  });
  next();
});

app.use(session({
  name: 'securecam.sid',
  secret: getSettings().sessionSecret,
  resave: false,
  saveUninitialized: false,
  // "lax" rather than "strict": the session has to survive coming back from
  // Google's sign-in page and arriving from a link in an email.
  cookie: { httpOnly: true, sameSite: 'lax', secure: BEHIND_PROXY, maxAge: 12 * 60 * 60 * 1000 },
}));

// ---------- public routes ----------
const publicDir = path.join(ROOT, 'public');
registerAccountRoutes(app, publicDir);

// Send first-time visitors to setup before anything else.
app.use((req, res, next) => {
  if (!isSetupComplete() && !req.path.startsWith('/api/')) return res.redirect('/setup.html');
  next();
});

// ---------- authenticated routes ----------
app.use(requireAuth);

app.use('/vendor/hls.js', express.static(path.join(ROOT, 'node_modules/hls.js/dist')));
// Each fetch marks the stream as watched so idle HD streams can be stopped.
// Stream folders are named <cameraId>_<variant>; only the camera's owner gets in.
app.use('/streams', (req, res, next) => {
  const key = req.path.split('/')[1] || '';
  if (!findCamera(key.replace(/_[a-z-]+$/, ''), req)) return res.status(404).end();
  streams.touch(key);
  next();
}, express.static(STREAM_DIR, {
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));
app.use(express.static(publicDir));

app.get('/api/me', (req, res) => res.json({ user: req.user.name, role: req.user.role }));

// ----- building / room placement -----
// Buildings and rooms belong to the account that created them.
app.get('/api/placements', (req, res) => res.json({ buildings: listBuildings(req.user.id) }));

app.post('/api/buildings', (req, res) => {
  try {
    res.status(201).json(createBuilding(req.body?.name, req.user.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/buildings/:id/rooms', (req, res) => {
  try {
    res.status(201).json(createRoom(req.params.id, req.body?.name, req.user.id));
  } catch (err) {
    res.status(err.message === 'Building not found' ? 404 : 400).json({ error: err.message });
  }
});

function viewCamera(cam, placements) {
  const map = placements || getCameraPlacements();
  const place = map.get(cam.id) || {};
  return publicCamera(cam, {
    status: streams.status(cam.id, 'grid'),
    buildingId: place.buildingId || null,
    buildingName: place.buildingName || null,
    roomId: place.roomId || null,
    roomName: place.roomName || null,
  });
}

// Every account only ever sees and changes its own cameras.
function ownCameras(req) {
  return getCameras().filter((c) => c.ownerId === req.user.id);
}

function findCamera(id, req) {
  return ownCameras(req).find((c) => c.id === id);
}

app.get('/api/cameras', (req, res) => {
  const placements = getCameraPlacements();
  res.json(ownCameras(req).map((cam) => viewCamera(cam, placements)));
});

// Check a camera's settings before saving: connects and reports what it sends.
app.post('/api/cameras/test', async (req, res) => {
  const body = req.body || {};
  let cam;
  try {
    cam = validateCamera(body, body.id ? findCamera(body.id, req) : undefined);
    await assertCameraAllowed(cam, req.user, 0);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const check = (url) => (url ? probe(url).catch((err) => ({ error: err.message })) : null);
  const [grid, hd] = await Promise.all([check(gridUrl(cam)), check(hdUrl(cam))]);
  res.json({ grid, hd });
});

app.post('/api/cameras', async (req, res) => {
  try {
    const validated = validateCamera(req.body || {});
    await assertCameraAllowed({ ...validated }, req.user, ownCameras(req).length + 1);
    const placement = resolveCameraPlacement(req.body || {}, null, req.user.id);
    const cam = { id: crypto.randomUUID(), ownerId: req.user.id, ...validated, ...placement };
    const cameras = getCameras();
    cameras.push(cam);
    saveCameras(cameras);
    setCameraPlacement(cam.id, placement);
    if (cam.enabled) streams.startCamera(cam);
    res.status(201).json(viewCamera(cam));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/cameras/:id', async (req, res) => {
  if (!findCamera(req.params.id, req)) return res.status(404).json({ error: 'Camera not found' });
  try {
    const before = findCamera(req.params.id, req);
    const validated = validateCamera(req.body || {}, before);
    await assertCameraAllowed({ ...validated }, req.user, 0);
    const placement = resolveCameraPlacement(req.body || {}, getCameraPlacements().get(before.id), req.user.id);
    const cam = { id: before.id, ownerId: before.ownerId, ...validated, ...placement };
    // Re-read after the await: another request may have saved in between.
    const cameras = getCameras();
    const idx = cameras.findIndex((c) => c.id === cam.id);
    if (idx === -1) return res.status(404).json({ error: 'Camera not found' });
    cameras[idx] = cam;
    saveCameras(cameras);
    setCameraPlacement(cam.id, placement);
    if (cam.enabled) streams.startCamera(cam); else streams.stopCamera(cam.id);
    res.json(viewCamera(cam));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/cameras/:id', (req, res) => {
  if (!findCamera(req.params.id, req)) return res.status(404).json({ error: 'Camera not found' });
  const next = getCameras().filter((c) => c.id !== req.params.id);
  streams.stopCamera(req.params.id);
  saveCameras(next);
  deleteCameraPlacement(req.params.id);
  res.json({ ok: true });
});

app.post('/api/cameras/:id/restart', (req, res) => {
  const cam = findCamera(req.params.id, req);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  streams.startCamera(cam);
  res.json(viewCamera(cam));
});

// Start (or join) the full-quality stream for a viewer and wait until it's playable.
app.post('/api/cameras/:id/hd', async (req, res) => {
  const cam = findCamera(req.params.id, req);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  if (!cam.enabled) return res.status(409).json({ error: 'Camera is disabled' });
  const variant = await streams.hdVariantFor(cam, Boolean(req.body?.hevc));
  if (!variant) return res.status(404).json({ error: 'This camera has no separate HD stream' });
  const { key } = streams.ensure(cam, variant);
  if (await streams.waitLive(key, 20_000)) {
    return res.json({ src: `/streams/${key}/index.m3u8`, variant, audio: await streams.hasAudio(cam) });
  }
  const { lastError } = streams.status(cam.id, variant);
  res.status(504).json({ error: lastError || 'HD stream took too long to start' });
});

// ---------- detection / database ----------
app.get('/api/detection/status', (req, res) => res.json(detection.status(req.user.id)));

// Detection settings apply to the whole server, so only the admin changes them.
app.post('/api/detection/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled === 'boolean') detection.enabled = body.enabled;
  if (body.intervalMs !== undefined) {
    const ms = Number(body.intervalMs);
    if (!Number.isFinite(ms) || ms < 1000 || ms > 60_000) {
      return res.status(400).json({ error: 'Interval must be between 1000 and 60000 ms' });
    }
    setSetting('detection.intervalMs', ms);
    detection.restart();
  }
  for (const [key, field, min, max] of [
    ['detection.sightingGapMs', 'sightingGapMs', 1000, 3_600_000],
    ['detection.alertCooldownMs', 'alertCooldownMs', 1000, 3_600_000],
  ]) {
    if (body[field] === undefined) continue;
    const ms = Number(body[field]);
    if (!Number.isFinite(ms) || ms < min || ms > max) {
      return res.status(400).json({ error: `${field} must be between ${min} and ${max} ms` });
    }
    setSetting(key, ms);
  }
  res.json(detection.status(req.user.id));
});

app.get('/api/objects', (req, res) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
  res.json(listObjects(req.user.id, kind, req.query.all === '1'));
});

// Objects, sightings, alerts, snapshots and clips belong to one account.
app.use('/api/objects/:id', (req, res, next) => {
  if (!getObject(req.params.id, req.user.id)) return res.status(404).json({ error: 'Object not found' });
  next();
});

app.patch('/api/objects/:id', (req, res) => {
  try {
    res.json(renameObject(req.params.id, req.body?.name));
  } catch (err) {
    res.status(err.message === 'Object not found' ? 404 : 400).json({ error: err.message });
  }
});

app.delete('/api/objects/:id', (req, res) => {
  try {
    const { snapshots, clips } = deleteObject(req.params.id);
    for (const name of snapshots) {
      if (!/^[\w-]+\.jpg$/i.test(name)) continue;
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR, name)); } catch { /* already gone */ }
    }
    for (const name of clips) {
      if (!/^\d+(-\d+)?\.mp4$/i.test(name)) continue;
      try { fs.unlinkSync(path.join(ALERT_CLIP_DIR, name)); } catch { /* already gone */ }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === 'Object not found' ? 404 : 400).json({ error: err.message });
  }
});

app.get('/api/objects/:id/sightings', (req, res) => {
  res.json(listSightings({ ownerId: req.user.id, objectId: req.params.id, limit: req.query.limit }));
});

app.get('/api/sightings', (req, res) => {
  res.json(listSightings({
    ownerId: req.user.id,
    objectId: typeof req.query.objectId === 'string' ? req.query.objectId : null,
    cameraId: typeof req.query.cameraId === 'string' ? req.query.cameraId : null,
    kind: typeof req.query.kind === 'string' ? req.query.kind : null,
    limit: req.query.limit,
  }));
});

app.get('/api/alerts', (req, res) => {
  res.json(listAlerts({ ownerId: req.user.id, since: req.query.since, limit: req.query.limit }));
});

app.post('/api/alerts/ack', (req, res) => {
  const all = req.body?.all === true;
  res.json({ changed: ackAlerts(req.user.id, req.body?.ids, all) });
});

app.get('/api/alerts/:id/clip', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid alert' });
  const alert = getAlert(req.params.id, req.user.id);
  if (!alert?.clip || !/^\d+(-\d+)?\.mp4$/i.test(alert.clip)) {
    return res.status(404).json({ error: 'Clip not available' });
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(alert.clip, { root: ALERT_CLIP_DIR }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Clip not available' });
  });
});

// Archives bundle every account's alert clips into one file per day, so until
// they are split per account only the admin can browse them. Other accounts
// simply have none.
app.get('/api/alert-archives', (req, res) => {
  res.json(req.user.role === 'admin' ? listArchives() : []);
});

app.post('/api/alert-archives/:date/extract', requireAdmin, (req, res) => {
  try {
    res.json(extractArchive(req.params.date));
  } catch (err) {
    res.status(err.message === 'Archive not found' ? 404 : 400).json({ error: err.message });
  }
});

app.get('/api/alert-archives/:date/clip/:name', requireAdmin, (req, res) => {
  let file;
  try {
    file = archiveClipPath(req.params.date, req.params.name);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!file) return res.status(404).json({ error: 'Archived clip not found' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.basename(file), { root: path.dirname(file) }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Archived clip not found' });
  });
});

app.get('/api/snapshots/:file', (req, res) => {
  const name = req.params.file;
  if (!/^[\w-]+\.jpg$/i.test(name)) return res.status(400).json({ error: 'Invalid snapshot name' });
  if (!ownsSnapshot(req.user.id, name)) return res.status(404).json({ error: 'Snapshot not found' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(name, { root: SNAPSHOT_DIR }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Snapshot not found' });
  });
});

// ---------- boot ----------
function cleanupAlerts() {
  const grouped = consolidateAlerts();
  const expired = pruneOldAlerts();
  const clips = new Set([...grouped.clips, ...expired.clips]);
  for (const name of clips) removeAlertClip(name);
  if (grouped.alerts || expired.alerts || clips.size) {
    console.log(`Alerts: folded ${grouped.alerts} repeats, expired ${expired.alerts}, removed ${clips.size} clips`);
  }
}

const snapshotCleanup = cleanupSnapshots();
if (snapshotCleanup.deduped || snapshotCleanup.orphans) {
  console.log(`Snapshots: removed ${snapshotCleanup.deduped} duplicates and ${snapshotCleanup.orphans} unused files`);
}
// Cameras saved before accounts existed belong to the admin. This has to
// happen before placements are filled in, which are created per owner.
let cameras = getCameras();
const admin = adminId();
if (admin !== null && cameras.some((c) => c.ownerId === undefined)) {
  cameras = cameras.map((c) => (c.ownerId === undefined ? { ...c, ownerId: admin } : c));
  saveCameras(cameras);
}
// Older loop cameras used clip:// filenames. Give them the same short test://
// URLs as the other sample feeds so they can be added again from the dialog.
const urlMigration = migrateTestCameraUrls(cameras);
if (urlMigration.changed) {
  cameras = urlMigration.cameras;
  saveCameras(cameras);
  console.log(`Cameras: changed ${urlMigration.changed} loop URL(s) to test:// aliases`);
}
const placementMigration = ensureCameraPlacements(cameras);
if (placementMigration.fabricated && placementMigration.added) {
  console.log(`Placement: created ${placementMigration.building.name} / Default Room for ${placementMigration.added} existing camera(s)`);
}
cleanupAlerts();
setInterval(cleanupAlerts, 60 * 60 * 1000).unref();
startArchiveJob();
for (const cam of cameras) if (cam.enabled) streams.startCamera(cam);
detection.start();

const server = app.listen(PORT, HOST, () => {
  console.log(`SecureCam running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

// If the port is taken, another copy is already serving. Quit instead of
// lingering as a second set of ffmpeg processes writing into the same folders.
server.on('error', (err) => {
  console.error(`Could not listen on ${HOST}:${PORT}: ${err.code || err.message}`);
  detection.stop();
  streams.stopAll();
  process.exit(1);
});

function shutdown() {
  detection.stop();
  streams.stopAll();
  server.close(() => {
    closeDatabase();
    closeUsers();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
