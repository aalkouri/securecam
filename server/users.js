// User accounts, kept in their own SQLite file (data/accounts.db).
// The first account is the admin: it owns every camera and object that existed
// before accounts were added, and is the only one that can change app-wide
// settings. Every other account only sees what it created itself.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { DATA_DIR, getSettings, saveSettings, readJson } from './store.js';

const db = new DatabaseSync(path.join(DATA_DIR, 'accounts.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE COLLATE NOCASE,
    username      TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    google_sub    TEXT UNIQUE,
    role          TEXT NOT NULL DEFAULT 'user',
    verified      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  -- One-time links sent by email. Only a hash of the token is stored.
  CREATE TABLE IF NOT EXISTS tokens (
    hash       TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Installs from before accounts kept one admin in settings.json. Carry it over.
{
  const settings = getSettings();
  if (settings.admin && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare(`INSERT INTO users(username, password_hash, role, verified, created_at)
                VALUES (?, ?, 'admin', 1, ?)`)
      .run(settings.admin.username, settings.admin.passwordHash, new Date().toISOString());
    delete settings.admin;
    saveSettings(settings);
  }
}

// An admin carried over from settings.json has a username but no email, so it
// could not reset its password or use Google. "adminEmail" in data/config.json
// fills that in once.
{
  const wanted = String(readJson('config.json', {}).adminEmail || '').trim().toLowerCase();
  if (wanted && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(wanted)) {
    db.prepare("UPDATE users SET email = ? WHERE role = 'admin' AND email IS NULL").run(wanted);
  }
}

function userRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.password_hash,
    googleSub: row.google_sub,
    role: row.role,
    verified: Boolean(row.verified),
    name: row.email || row.username,
  };
}

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function adminId() {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id ?? null;
}

// Safe account list for the admin's "view as" picker — no hashes or tokens.
export function listUsers() {
  return db.prepare(`SELECT id, email, username, role FROM users ORDER BY
    CASE role WHEN 'admin' THEN 0 ELSE 1 END, id`).all()
    .map((row) => ({ id: row.id, name: row.email || row.username, role: row.role }));
}

export function getUser(id) {
  return userRow(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function findByEmail(email) {
  return userRow(db.prepare('SELECT * FROM users WHERE email = ?').get(email));
}

export function findByGoogleSub(sub) {
  return userRow(db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub));
}

// Sign-in accepts an email address, or the username of an older admin account.
export function findByLogin(login) {
  return userRow(db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(login, login));
}

// The very first account becomes the admin.
export function createUser({ email = null, username = null, passwordHash = null, googleSub = null, verified = false }) {
  const role = userCount() === 0 ? 'admin' : 'user';
  const result = db.prepare(`INSERT INTO users(email, username, password_hash, google_sub, role, verified, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(email, username, passwordHash, googleSub, role, verified ? 1 : 0, new Date().toISOString());
  return getUser(Number(result.lastInsertRowid));
}

// `confirm` is for when the caller has just proven the mailbox (a reset link).
export function setPassword(id, passwordHash, confirm = false) {
  db.prepare('UPDATE users SET password_hash = ?, verified = MAX(verified, ?) WHERE id = ?')
    .run(passwordHash, confirm ? 1 : 0, id);
}

export function markVerified(id) {
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(id);
}

// An account whose address was never confirmed may have been started by
// someone else, so its password is dropped when the real owner arrives.
export function linkGoogle(id, sub, email) {
  db.prepare(`UPDATE users SET google_sub = ?, email = COALESCE(email, ?),
              password_hash = CASE WHEN verified = 1 THEN password_hash ELSE NULL END,
              verified = 1 WHERE id = ?`)
    .run(sub, email, id);
}

export function setEmail(id, email) {
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id);
}

// ---- one-time email links ----
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createToken(userId, purpose, ttlMs) {
  db.prepare('DELETE FROM tokens WHERE expires_at < ? OR (user_id = ? AND purpose = ?)')
    .run(Date.now(), userId, purpose);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO tokens(hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, purpose, Date.now() + ttlMs);
  return token;
}

// Returns the user the link belongs to and uses the link up, or null.
export function consumeToken(token, purpose) {
  if (typeof token !== 'string' || token.length > 100) return null;
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM tokens WHERE hash = ? AND purpose = ?').get(hash, purpose);
  if (!row) return null;
  db.prepare('DELETE FROM tokens WHERE hash = ?').run(hash);
  if (row.expires_at < Date.now()) return null;
  return getUser(row.user_id);
}

export function closeUsers() {
  db.close();
}
