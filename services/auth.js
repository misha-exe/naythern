// services/auth.js - multi-user login with signed, stateless session cookies.
//
// Who can sign in:
//   * the SUPER ADMIN  - credentials live in env vars (AUTH_EMAIL + AUTH_PASSWORD_HASH). Nobody can edit or
//                        lock them out from the dashboard, and there is nothing to "seed" in the database.
//   * publisher members - owner / editor / viewer records stored in KV (created by the super admin or the owner).
//
// The cookie is HMAC-signed and holds only { user id, issued-at, last-active, optional opened workspace }.
// On EVERY request the user + workspace are re-read from the database, so suspending a user or a workspace,
// changing a role, or removing an account access takes effect immediately.
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = 'bluebee_session';
const SUPER_ID = 'superadmin';
const MAX_FAILS = 5;            // failed sign-ins allowed per IP...
const MAX_FAILS_EMAIL = 8;      // ...and per email address
const LOCKOUT_WINDOW_SEC = 900; // ...within this window (15 minutes)

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function getConfig() {
  return {
    email: (process.env.AUTH_EMAIL || '').trim().toLowerCase(),
    passwordHash: (process.env.AUTH_PASSWORD_HASH || '').trim(),
    passwordPlain: process.env.AUTH_PASSWORD || '',
    secret: process.env.AUTH_SECRET || '',
    idleMs: num(process.env.SESSION_IDLE_MINUTES, 30) * 60000,
    maxMs: num(process.env.SESSION_MAX_HOURS, 12) * 3600000
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.email && (c.passwordHash || c.passwordPlain) && c.secret.length >= 32);
}

/* ---------- passwords ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

async function verifyHash(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

let dummyHash = null; // burns the same CPU time for unknown emails so timing doesn't reveal which emails exist

const superAdminUser = () => ({
  id: SUPER_ID, email: getConfig().email, name: 'Administrator', role: 'super_admin',
  publisherId: null, accountIds: [], status: 'active'
});

/**
 * @returns {Promise<{user?: object, error?: 'invalid'|'suspended'}>}
 */
async function authenticate(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string') return { error: 'invalid' };
  if (email.length > 320 || password.length > 1024) return { error: 'invalid' };
  const e = email.trim().toLowerCase();
  const c = getConfig();

  if (c.email && safeEqual(e, c.email)) {
    let ok = false;
    if (c.passwordHash) ok = await verifyHash(password, c.passwordHash).catch(() => false);
    else if (c.passwordPlain) ok = safeEqual(password, c.passwordPlain);
    return ok ? { user: superAdminUser() } : { error: 'invalid' };
  }

  const user = await db.getUserByEmail(e);
  if (!user) {
    dummyHash = dummyHash || (await hashPassword('not-a-real-password'));
    await verifyHash(password, dummyHash).catch(() => {});
    return { error: 'invalid' };
  }
  const ok = await verifyHash(password, user.passwordHash).catch(() => false);
  if (!ok) return { error: 'invalid' };
  if (user.status !== 'active') return { error: 'suspended' };
  const pub = await db.getPublisher(user.publisherId);
  if (!pub || pub.status !== 'active') return { error: 'suspended' };
  return { user };
}

/* ---------- session tokens ---------- */
const sign = (data) => crypto.createHmac('sha256', getConfig().secret).update(data).digest('base64url');

function issueToken(userId, { iat, la, p } = {}) {
  const now = Date.now();
  const body = { u: userId, iat: iat || now, la: la || now };
  if (p) body.p = p; // super admin only: the publisher workspace they have opened
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `v2.${payload}.${sign(`v2.${payload}`)}`;
}

function parseToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v2') return null;
  const expected = Buffer.from(sign(`v2.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const d = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return d && typeof d.u === 'string' && Number.isFinite(d.iat) && Number.isFinite(d.la) ? d : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

function readSession(req) {
  const token = parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME];
  if (!token) return { ok: false, reason: 'none' };
  if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
  const data = parseToken(token);
  if (!data) return { ok: false, reason: 'invalid' };
  const c = getConfig();
  const now = Date.now();
  if (now - data.iat > c.maxMs || now - data.la > c.idleMs) return { ok: false, reason: 'expired' };
  return { ok: true, data };
}

const isSecure = (req) =>
  String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https' || req.secure === true;

function writeCookie(req, res, value, maxAgeSec) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${isSecure(req) ? '; Secure' : ''}`
  );
}

function setSessionCookie(req, res, token, iat = Date.now()) {
  const c = getConfig();
  writeCookie(req, res, token, Math.min(c.idleMs, c.maxMs - (Date.now() - iat)) / 1000);
}
const clearSessionCookie = (req, res) => writeCookie(req, res, '', 0);

/* ---------- request context ---------- */
// Loads the live user + workspace for a verified session. Returns { ctx } or { reason }.
async function loadContext(data) {
  if (data.u === SUPER_ID) {
    const publisher = data.p ? await db.getPublisher(data.p) : null;
    // A super admin inside a workspace acts as its owner; outside any workspace they only see the platform pages.
    return { ctx: { user: superAdminUser(), isSuper: true, publisher, role: publisher ? 'owner' : 'super_admin' } };
  }
  const user = await db.getUser(data.u);
  if (!user || user.status !== 'active') return { reason: 'invalid' };
  const publisher = await db.getPublisher(user.publisherId);
  if (!publisher) return { reason: 'invalid' };
  if (publisher.status !== 'active') return { reason: 'suspended' };
  return { ctx: { user, isSuper: false, publisher, role: user.role } };
}

async function requireAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!isConfigured()) {
      return res.status(503).json({
        error: 'Login is not set up on the server yet. Add AUTH_EMAIL, AUTH_PASSWORD_HASH and AUTH_SECRET to the environment variables.',
        code: 'unconfigured'
      });
    }
    const s = readSession(req);
    if (!s.ok) {
      if (s.reason === 'expired' || s.reason === 'invalid') clearSessionCookie(req, res);
      const expired = s.reason === 'expired';
      return res.status(401).json({
        error: expired ? 'Your session expired. Please sign in again.' : 'Please sign in to continue.',
        code: expired ? 'expired' : 'unauthenticated'
      });
    }

    const loaded = await loadContext(s.data);
    if (!loaded.ctx) {
      clearSessionCookie(req, res);
      return loaded.reason === 'suspended'
        ? res.status(403).json({ error: 'This workspace or account has been suspended. Contact the administrator.', code: 'suspended' })
        : res.status(401).json({ error: 'Please sign in to continue.', code: 'unauthenticated' });
    }

    const c = getConfig();
    const now = Date.now();
    let la = s.data.la;
    if (now - la > Math.min(30000, c.idleMs / 4)) {
      la = now;
      setSessionCookie(req, res, issueToken(s.data.u, { iat: s.data.iat, la, p: s.data.p }), s.data.iat);
    }
    res.setHeader('X-Session-Remaining-Ms', String(Math.max(0, Math.min(c.idleMs - (now - la), c.maxMs - (now - s.data.iat)))));
    req.ctx = loaded.ctx;
    req.sessionData = s.data;
    return next();
  } catch (err) {
    console.error('[Auth]', err);
    return res.status(500).json({ error: 'Could not verify your session. Please try again.' });
  }
}

/* ---------- permission middleware ---------- */
const requireSuper = (req, res, next) =>
  req.ctx && req.ctx.isSuper ? next() : res.status(403).json({ error: 'Platform administrator access required.' });

const requireWorkspace = (req, res, next) =>
  req.ctx && req.ctx.publisher
    ? next()
    : res.status(409).json({ error: 'Open a publisher workspace first.', code: 'no_workspace' });

// roles: 'owner' | 'editor' | 'viewer'  (a super admin inside a workspace counts as 'owner')
const requireRole = (...roles) => (req, res, next) =>
  req.ctx && roles.includes(req.ctx.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' });

// Blocks cross-site form posts / fetches that try to ride on the session cookie.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers && req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  return next();
}

/* ---------- brute-force protection ---------- */
const clientIp = (req) =>
  String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() ||
  (req.headers && req.headers['x-real-ip']) ||
  (req.socket && req.socket.remoteAddress) ||
  'unknown';

const ipKey = (ip) => `bluebee_login_fail:${ip}`;
const emailKey = (e) => `bluebee_login_fail_email:${crypto.createHash('sha256').update(String(e || '').trim().toLowerCase()).digest('hex').slice(0, 32)}`;

async function isLockedOut(ip, email) {
  try {
    const [a, b] = await Promise.all([db.getCounter(ipKey(ip)), db.getCounter(emailKey(email))]);
    return a >= MAX_FAILS || b >= MAX_FAILS_EMAIL;
  } catch { return false; }
}
async function recordFailure(ip, email) {
  try { await Promise.all([db.bumpCounter(ipKey(ip), LOCKOUT_WINDOW_SEC), db.bumpCounter(emailKey(email), LOCKOUT_WINDOW_SEC)]); } catch { /* never block sign-in on a counter error */ }
}
async function clearFailures(ip, email) {
  try { await Promise.all([db.resetCounter(ipKey(ip)), db.resetCounter(emailKey(email))]); } catch { /* ignore */ }
}

module.exports = {
  COOKIE_NAME, SUPER_ID, MAX_FAILS, LOCKOUT_WINDOW_SEC,
  getConfig, isConfigured,
  hashPassword, verifyHash, authenticate,
  issueToken, parseToken, readSession, setSessionCookie, clearSessionCookie,
  requireAuth, requireSuper, requireWorkspace, requireRole, sameOrigin,
  clientIp, isLockedOut, recordFailure, clearFailures
};
