import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, getCameras, saveCameras } from './store.js';
import {
  isSetupComplete, createAdmin, checkLogin, requireAuth,
  isLockedOut, recordFailure, clearFailures,
} from './auth.js';
import { streams, STREAM_DIR, probe } from './streams.js';
import { validateCamera, publicCamera, gridUrl, hdUrl } from './cameras.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
// Localhost only by default. Set HOST=0.0.0.0 to view from other devices on your LAN.
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
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
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000 },
}));

// ---------- public routes ----------
const publicDir = path.join(ROOT, 'public');
app.get(['/login.html', '/setup.html', '/style.css', '/login.js'], (req, res) =>
  res.sendFile(path.join(publicDir, req.path)));

app.get('/api/setup', (req, res) => res.json({ setupComplete: isSetupComplete() }));

app.post('/api/setup', (req, res) => {
  if (isSetupComplete()) return res.status(409).json({ error: 'Setup already completed' });
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string' || username.length > 64) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 7) {
    return res.status(400).json({ error: 'Password must be at least 7 characters' });
  }
  createAdmin(username.trim(), password);
  req.session.regenerate(() => {
    req.session.user = username.trim();
    res.json({ ok: true });
  });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (isLockedOut(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !checkLogin(username, password)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  clearFailures(ip);
  req.session.regenerate(() => {
    req.session.user = username;
    res.json({ ok: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Send first-time visitors to setup before anything else.
app.use((req, res, next) => {
  if (!isSetupComplete() && !req.path.startsWith('/api/')) return res.redirect('/setup.html');
  next();
});

// ---------- authenticated routes ----------
app.use(requireAuth);

app.use('/vendor/hls.js', express.static(path.join(ROOT, 'node_modules/hls.js/dist')));
// Each fetch marks the stream as watched so idle HD streams can be stopped.
app.use('/streams', (req, res, next) => {
  streams.touch(req.path.split('/')[1]);
  next();
}, express.static(STREAM_DIR, {
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));
app.use(express.static(publicDir));

app.get('/api/me', (req, res) => res.json({ user: req.session.user }));

function viewCamera(cam) {
  return publicCamera(cam, { status: streams.status(cam.id, 'grid') });
}

function findCamera(id) {
  return getCameras().find((c) => c.id === id);
}

app.get('/api/cameras', (req, res) => res.json(getCameras().map(viewCamera)));

// Check a camera's settings before saving: connects and reports what it sends.
app.post('/api/cameras/test', async (req, res) => {
  const body = req.body || {};
  let cam;
  try {
    cam = validateCamera(body, body.id ? findCamera(body.id) : undefined);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const check = (url) => (url ? probe(url).catch((err) => ({ error: err.message })) : null);
  const [grid, hd] = await Promise.all([check(gridUrl(cam)), check(hdUrl(cam))]);
  res.json({ grid, hd });
});

app.post('/api/cameras', (req, res) => {
  try {
    const cam = { id: crypto.randomUUID(), ...validateCamera(req.body || {}) };
    const cameras = getCameras();
    cameras.push(cam);
    saveCameras(cameras);
    if (cam.enabled) streams.startCamera(cam);
    res.status(201).json(viewCamera(cam));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/cameras/:id', (req, res) => {
  const cameras = getCameras();
  const idx = cameras.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Camera not found' });
  try {
    const cam = { id: cameras[idx].id, ...validateCamera(req.body || {}, cameras[idx]) };
    cameras[idx] = cam;
    saveCameras(cameras);
    if (cam.enabled) streams.startCamera(cam); else streams.stopCamera(cam.id);
    res.json(viewCamera(cam));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/cameras/:id', (req, res) => {
  const cameras = getCameras();
  const next = cameras.filter((c) => c.id !== req.params.id);
  if (next.length === cameras.length) return res.status(404).json({ error: 'Camera not found' });
  streams.stopCamera(req.params.id);
  saveCameras(next);
  res.json({ ok: true });
});

app.post('/api/cameras/:id/restart', (req, res) => {
  const cam = findCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  streams.startCamera(cam);
  res.json(viewCamera(cam));
});

// Start (or join) the full-quality stream for a viewer and wait until it's playable.
app.post('/api/cameras/:id/hd', async (req, res) => {
  const cam = findCamera(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  if (!cam.enabled) return res.status(409).json({ error: 'Camera is disabled' });
  const variant = await streams.hdVariantFor(cam, Boolean(req.body?.hevc));
  if (!variant) return res.status(404).json({ error: 'This camera has no separate HD stream' });
  const { key } = streams.ensure(cam, variant);
  if (await streams.waitLive(key, 20_000)) {
    return res.json({ src: `/streams/${key}/index.m3u8`, variant });
  }
  const { lastError } = streams.status(cam.id, variant);
  res.status(504).json({ error: lastError || 'HD stream took too long to start' });
});

// ---------- boot ----------
for (const cam of getCameras()) if (cam.enabled) streams.startCamera(cam);

const server = app.listen(PORT, HOST, () => {
  console.log(`SecureCam running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

function shutdown() {
  streams.stopAll();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
