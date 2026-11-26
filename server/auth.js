// Single-admin authentication using scrypt password hashes (no native deps).
import crypto from 'node:crypto';
import { getSettings, saveSettings } from './store.js';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function isSetupComplete() {
  return Boolean(getSettings().admin);
}

export function createAdmin(username, password) {
  const settings = getSettings();
  settings.admin = { username, passwordHash: hashPassword(password) };
  saveSettings(settings);
}

export function checkLogin(username, password) {
  const { admin } = getSettings();
  if (!admin) return false;
  const userOk = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(username).digest(),
    crypto.createHash('sha256').update(admin.username).digest(),
  );
  const passOk = verifyPassword(password, admin.passwordHash);
  return userOk && passOk;
}

// Naive in-memory brute-force protection: 5 failures per IP per 15 min.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function isLockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    failures.set(ip, { first: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

export function clearFailures(ip) {
  failures.delete(ip);
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/streams/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}
