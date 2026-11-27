// Routes that work without being signed in: first-time setup, sign-in,
// sign-up with email confirmation, forgotten passwords and Google sign-in.
import crypto from 'node:crypto';
import path from 'node:path';
import {
  isSetupComplete, createAdmin, checkLogin, hashPassword,
  isLockedOut, recordFailure, clearFailures,
} from './auth.js';
import {
  normalizeEmail, findByEmail, findByGoogleSub, createUser, setPassword,
  markVerified, linkGoogle, createToken, consumeToken, getUser,
} from './users.js';
import { config, googleEnabled, mailEnabled, baseUrl } from './config.js';
import { sendLinkEmail } from './mail.js';
import { createBuilding } from './database.js';

export const MIN_PASSWORD = 7;
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const PAGES = ['/login.html', '/setup.html', '/signup.html', '/forgot.html', '/reset.html', '/style.css', '/auth.css', '/login.js'];

// The public home page and the logo, which signed-out visitors need too.
const PUBLIC_ASSETS = ['/home.css', '/home.js', '/logo-mark.png', '/logo-mark-96.png', '/logo-full.jpg', '/favicon.png'];

function validPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= 200;
}

function signIn(req, user, done) {
  req.session.regenerate(() => {
    req.session.uid = user.id;
    req.session.user = user.name;
    done();
  });
}

// Too many sign-up or reset requests from one address, or for one mailbox.
function throttled(req, email) {
  const keys = [`mail:${req.ip}`, `mail:${email}`];
  if (isLockedOut(keys[0], 10) || isLockedOut(keys[1], 3)) return true;
  keys.forEach(recordFailure);
  return false;
}

function sendVerify(req, user) {
  const token = createToken(user.id, 'verify', VERIFY_TTL);
  return sendLinkEmail({
    to: user.email,
    subject: 'Confirm your SecureCam account',
    intro: 'Thanks for creating a SecureCam account. Confirm your email address to finish.',
    linkText: 'Confirm my email',
    link: `${baseUrl(req)}/verify?token=${token}`,
    outro: 'The link works for 24 hours. If you did not create this account, ignore this email.',
  });
}

export function registerAccountRoutes(app, publicDir) {
  app.get([...PAGES, ...PUBLIC_ASSETS], (req, res) => res.sendFile(path.join(publicDir, req.path)));

  // Short addresses for the pages people type or link to.
  for (const name of ['login', 'signup', 'forgot', 'reset']) {
    app.get(`/${name}`, (req, res) => res.sendFile(path.join(publicDir, `${name}.html`)));
  }

  // The front door: the public home page for visitors, the dashboard (served
  // further down, behind requireAuth) for someone who is signed in.
  app.get('/', (req, res, next) => {
    if (!isSetupComplete()) return res.redirect('/setup.html');
    if (req.session?.uid && getUser(req.session.uid)) return next();
    res.sendFile(path.join(publicDir, 'home.html'));
  });

  // What the sign-in pages should offer.
  app.get('/api/setup', (req, res) => res.json({
    setupComplete: isSetupComplete(),
    signup: config.allowSignup,
    google: googleEnabled,
    mail: mailEnabled,
    minPassword: MIN_PASSWORD,
  }));

  app.post('/api/setup', (req, res) => {
    if (isSetupComplete()) return res.status(409).json({ error: 'Setup already completed' });
    const { username, password } = req.body || {};
    const building = typeof req.body?.building === 'string' ? req.body.building.trim() : '';
    if (!username || typeof username !== 'string' || username.length > 64) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    // Checked before the account exists, so a bad name cannot leave a
    // half-finished setup behind.
    if (!building || building.length > 100) {
      return res.status(400).json({ error: 'Building name is required (100 characters or fewer)' });
    }
    const admin = createAdmin(username.trim(), password);
    const createdBuilding = createBuilding(building, admin.id);
    signIn(req, admin, () => res.json({ ok: true, building: createdBuilding }));
  });

  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    if (isLockedOut(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const { username, password } = req.body || {};
    const user = typeof username === 'string' && typeof password === 'string'
      ? checkLogin(username.trim(), password) : null;
    if (!user) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    // Without email there is no way to confirm an address, so it is not required.
    if (!user.verified && mailEnabled) {
      return res.status(403).json({ error: 'Confirm your email first. Check your inbox for the link, or use "Forgot password" to get a new one.' });
    }
    clearFailures(ip);
    signIn(req, user, () => res.json({ ok: true }));
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ---- create an account ----
  app.post('/api/signup', async (req, res) => {
    if (!isSetupComplete()) return res.status(409).json({ error: 'Finish setup first' });
    if (!config.allowSignup) return res.status(403).json({ error: 'New accounts are turned off on this server' });
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!validPassword(password)) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    if (throttled(req, email)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });

    const existing = findByEmail(email);
    if (!mailEnabled) {
      // No way to confirm an address (home install without email set up). The
      // account stays unconfirmed, so if its real owner later arrives through
      // Google or a reset link, this password is dropped rather than trusted.
      if (existing) return res.status(409).json({ error: 'That email already has an account' });
      const user = createUser({ email, passwordHash: hashPassword(password) });
      return signIn(req, user, () => res.json({ ok: true, signedIn: true }));
    }
    // With email, answer the same way whether or not the address is known, so
    // this form cannot be used to find out who has an account.
    if (!existing) {
      await sendVerify(req, createUser({ email, passwordHash: hashPassword(password) }));
    } else if (!existing.verified) {
      // Never confirmed, so whoever started it has not proven the address.
      setPassword(existing.id, hashPassword(password));
      await sendVerify(req, existing);
    } else {
      await sendLinkEmail({
        to: email,
        subject: 'You already have a SecureCam account',
        intro: 'Someone tried to create a SecureCam account with this email address, but it already has one.',
        linkText: 'Sign in',
        link: `${baseUrl(req)}/login.html`,
        outro: 'If you forgot your password, use "Forgot password" on the sign-in page. If this was not you, ignore this email.',
      });
    }
    res.json({ ok: true, signedIn: false });
  });

  app.get('/verify', (req, res) => {
    const user = consumeToken(req.query.token, 'verify');
    if (!user) return res.redirect('/login.html?notice=badlink');
    markVerified(user.id);
    signIn(req, user, () => res.redirect('/'));
  });

  // ---- forgotten password ----
  app.post('/api/forgot', async (req, res) => {
    if (!mailEnabled) return res.status(503).json({ error: 'This server cannot send email, so passwords cannot be reset here' });
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
    if (throttled(req, email)) return res.status(429).json({ error: 'Too many requests. Try again in 15 minutes.' });
    const user = findByEmail(email);
    if (user) {
      const token = createToken(user.id, 'reset', RESET_TTL);
      await sendLinkEmail({
        to: email,
        subject: 'Reset your SecureCam password',
        intro: 'We received a request to reset the password for your SecureCam account.',
        linkText: 'Choose a new password',
        link: `${baseUrl(req)}/reset.html#${token}`,
        outro: 'The link works for 1 hour and can be used once. If you did not ask for this, ignore this email and your password stays the same.',
      });
    }
    res.json({ ok: true });
  });

  app.post('/api/reset', (req, res) => {
    const { token, password } = req.body || {};
    if (!validPassword(password)) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
    }
    const user = consumeToken(token, 'reset');
    if (!user) return res.status(400).json({ error: 'This link has expired or was already used. Ask for a new one.' });
    // Receiving the link proves the mailbox, so this also confirms the account.
    setPassword(user.id, hashPassword(password), true);
    signIn(req, user, () => res.json({ ok: true }));
  });

  // ---- Google sign-in (OAuth 2.0 authorization code flow) ----
  const redirectUri = (req) => `${baseUrl(req)}/auth/google/callback`;

  app.get('/auth/google', (req, res) => {
    if (!googleEnabled || !isSetupComplete()) return res.redirect('/login.html');
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    req.session.google = { state, nonce };
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      prompt: 'select_account',
    }).toString();
    req.session.save(() => res.redirect(url.toString()));
  });

  app.get('/auth/google/callback', async (req, res) => {
    const pending = req.session.google;
    delete req.session.google;
    const fail = (notice) => res.redirect(`/login.html?notice=${notice}`);
    if (!googleEnabled || !pending || typeof req.query.code !== 'string' || req.query.state !== pending.state) {
      return fail('google');
    }
    let claims;
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: redirectUri(req),
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await tokenRes.json();
      if (!tokenRes.ok || typeof body.id_token !== 'string') throw new Error(body.error || 'no id_token');
      // The token came straight from Google over TLS in exchange for our
      // secret, so its contents can be trusted without checking the signature.
      claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString('utf8'));
    } catch (err) {
      console.warn(`Google sign-in failed: ${err.message}`);
      return fail('google');
    }
    const email = normalizeEmail(claims.email);
    const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!issuerOk || claims.aud !== config.googleClientId || claims.nonce !== pending.nonce
      || typeof claims.sub !== 'string' || !email || claims.email_verified !== true) {
      return fail('google');
    }

    let user = findByGoogleSub(claims.sub);
    if (!user) {
      const byEmail = findByEmail(email);
      if (byEmail) {
        // Google vouches for the address, so this is the same person.
        linkGoogle(byEmail.id, claims.sub, email);
        user = byEmail;
      } else if (config.allowSignup) {
        user = createUser({ email, googleSub: claims.sub, verified: true });
      } else {
        return fail('nosignup');
      }
    }
    signIn(req, user, () => res.redirect('/'));
  });
}
