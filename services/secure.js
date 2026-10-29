// services/secure.js - encrypts secrets (X session cookies) before they are stored, and small validators.
const crypto = require('crypto');

function key() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) return crypto.createHash('sha256').update(raw).digest();
  const secret = process.env.AUTH_SECRET || '';
  if (secret.length < 32) throw new Error('Set DATA_ENCRYPTION_KEY (or AUTH_SECRET) so stored X sessions can be encrypted.');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'bluebee', 'x-session-encryption', 32));
}

// AES-256-GCM. Format: enc1:<iv>:<tag>:<ciphertext> (base64url)
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['enc1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

function decrypt(stored) {
  const p = String(stored || '').split(':');
  if (p.length !== 4 || p[0] !== 'enc1') throw new Error('Stored session is unreadable.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(p[1], 'base64url'));
  d.setAuthTag(Buffer.from(p[2], 'base64url'));
  return Buffer.concat([d.update(Buffer.from(p[3], 'base64url')), d.final()]).toString('utf8');
}

// "auth_token=abc; ct0=def; twid=...; kdt=..." (any order) -> { authToken, ct0, extra } or null.
// `extra` keeps the account's OTHER cookies (twid, kdt, att, ...). Accounts with 2FA / login verification often
// need them, because X ties the session to more than just auth_token + ct0.
function parseXCookie(text) {
  const out = {};
  const order = [];
  String(text || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) {
      const name = pair.slice(0, i).trim();
      out[name.toLowerCase()] = pair.slice(i + 1).trim();
      order.push(name);
    }
  });
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9._%-]{16,400}$/.test(v);
  if (!ok(out.auth_token) || !ok(out.ct0)) return null;
  const extra = order
    .filter((n) => !['auth_token', 'ct0'].includes(n.toLowerCase()) && /^[A-Za-z0-9_.-]{1,40}$/.test(n) && /^[^\s;,"\\]{1,1500}$/.test(out[n.toLowerCase()]))
    .map((n) => `${n}=${out[n.toLowerCase()]}`)
    .join('; ')
    .slice(0, 4000);
  return { authToken: out.auth_token, ct0: out.ct0, extra };
}

const isAdsAccountId = (v) => /^[a-z0-9]{6,24}$/i.test(String(v || ''));
const isEmail = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

function generatePassword(len = 16) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

// Returns an error message, or '' when OK.
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return '';
}

module.exports = { encrypt, decrypt, parseXCookie, isAdsAccountId, isEmail, generatePassword, passwordProblem };
