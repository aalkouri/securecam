// Password hashing (scrypt, no native deps), sign-in throttling and the
// session check. Accounts themselves live in users.js.
import crypto from 'node:crypto';
import { userCount, createUser, findByEmail, normalizeEmail, getUser, setUsernameToEmail } from './users.js';

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

// A hash that matches nothing, so a wrong email costs the same time as a
// wrong password and the two cannot be told apart.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function isSetupComplete() {
  return userCount() > 0;
}

export function createAdmin(email, password) {
  const user = createUser({ passwordHash: hashPassword(password), verified: true });
  setUsernameToEmail(user.id, email);
  return getUser(user.id);
}

// Returns the account, or null when the email or password is wrong.
export function checkLogin(login, password) {
  const email = normalizeEmail(login);
  const user = email ? findByEmail(email) : null;
  const ok = verifyPassword(password, user?.passwordHash || DUMMY_HASH);
  return user && user.passwordHash && ok ? user : null;
}

// Naive in-memory throttle: `max` events per key per 15 minutes. Used for
// failed sign-ins per address, and for sign-up and reset requests.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const buckets = new Map();

function bucket(key) {
  const entry = buckets.get(key);
  if (entry && Date.now() - entry.first <= WINDOW_MS) return entry;
  buckets.delete(key);
  return null;
}

export function isLockedOut(key, max = MAX_FAILURES) {
  return (bucket(key)?.count || 0) >= max;
}

export function recordFailure(key) {
  const entry = bucket(key);
  if (entry) entry.count += 1;
  else buckets.set(key, { first: Date.now(), count: 1 });
}

export function clearFailures(key) {
  buckets.delete(key);
}

setInterval(() => {
  for (const key of [...buckets.keys()]) bucket(key);
}, WINDOW_MS).unref();

// Puts the signed-in account on req.actualUser. An admin may temporarily view
// another account; req.user is then the account whose data the page sees.
export function requireAuth(req, res, next) {
  const user = req.session?.uid ? getUser(req.session.uid) : null;
  if (user) {
    req.actualUser = user;
    req.user = user;
    if (user.role === 'admin' && req.session?.viewAs) {
      const viewed = getUser(req.session.viewAs);
      if (viewed) {
        req.user = viewed;
        req.viewingId = viewed.id;
      } else {
        delete req.session.viewAs;
      }
    } else if (req.session?.viewAs) {
      delete req.session.viewAs;
    }
    return next();
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/streams/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login');
}

// Admin rights always belong to the signed-in account, never to the account
// currently being viewed.
export function requireAdmin(req, res, next) {
  if (req.actualUser?.role === 'admin') return next();
  res.status(403).json({ error: 'Only the admin account can change this' });
}
