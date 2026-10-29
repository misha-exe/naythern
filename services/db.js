// services/db.js - multi-tenant data layer on top of Upstash / Vercel KV (see kv.js).
//
// Model:  super admin (env credentials)  ->  publishers (workspaces)  ->  users (owner / editor / viewer)
//                                                                     ->  X accounts (Ads account + web session)
// Editors are assigned X accounts; the Composer dropdown only lists the accounts a user is assigned.
// Every entity is its own key (no giant shared JSON blob), so concurrent requests don't overwrite each other.
const crypto = require('crypto');
const kv = require('./kv');

const K = {
  user: (id) => `bb:user:${id}`,
  email: (e) => `bb:email:${e}`,
  usersAll: 'bb:users',
  usersByPub: (p) => `bb:users:pub:${p}`,
  pub: (id) => `bb:pub:${id}`,
  slug: (s) => `bb:slug:${s}`,
  pubs: 'bb:pubs',
  acct: (id) => `bb:acct:${id}`,
  acctsAll: 'bb:accts',
  acctsByPub: (p) => `bb:accts:pub:${p}`,
  media: (a) => `bb:media:${a}`,
  posts: (p) => `bb:posts:${p}`,
  audit: 'bb:audit',
  ann: (id) => `bb:ann:${id}`,
  annList: 'bb:anns',
  annRead: (u) => `bb:ann:read:${u}`,
  cnt: (name) => `bb:cnt:${name}`
};

const genId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const iso = () => new Date().toISOString();
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const normEmail = (e) => String(e || '').trim().toLowerCase();
const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const intEnv = (name, d) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : d; };

async function mgetJson(keys) {
  if (!keys.length) return [];
  const vals = await kv.cmd('MGET', ...keys);
  return vals.map(parse).filter(Boolean);
}

/* ---------- plan limits ---------- */
const defaultLimits = () => ({
  monthlyPosts: intEnv('DEFAULT_MONTHLY_POSTS', 1000),
  xAccounts: intEnv('DEFAULT_X_ACCOUNTS', 2),
  teamMembers: intEnv('DEFAULT_TEAM_MEMBERS', 10)
});
function effectiveLimits(pub) {
  const d = defaultLimits();
  const o = (pub && pub.limits) || {};
  return { monthlyPosts: o.monthlyPosts || d.monthlyPosts, xAccounts: o.xAccounts || d.xAccounts, teamMembers: o.teamMembers || d.teamMembers };
}

/* ---------- date keys (UTC) ---------- */
const dayKey = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

/* ================= users ================= */
async function createUser({ email, name, role, publisherId, passwordHash, accountIds }) {
  const id = genId('u');
  const e = normEmail(email);
  const reserved = await kv.cmd('SET', K.email(e), id, 'NX');
  if (reserved !== 'OK') {
    const err = new Error('That email address is already in use.');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }
  const rec = {
    id, email: e, name: clip(name, 80) || e, role, publisherId: publisherId || null,
    passwordHash, accountIds: accountIds || [], status: 'active', createdAt: iso()
  };
  const cmds = [['SET', K.user(id), JSON.stringify(rec)], ['SADD', K.usersAll, id]];
  if (rec.publisherId) cmds.push(['SADD', K.usersByPub(rec.publisherId), id]);
  await kv.pipeline(cmds);
  return rec;
}
const getUser = async (id) => (id ? parse(await kv.cmd('GET', K.user(id))) : null);
async function getUserByEmail(email) {
  const id = await kv.cmd('GET', K.email(normEmail(email)));
  return id ? getUser(id) : null;
}
async function updateUser(id, patch) {
  const u = await getUser(id);
  if (!u) return null;
  const next = { ...u, ...patch, id: u.id, email: u.email, publisherId: u.publisherId };
  await kv.cmd('SET', K.user(id), JSON.stringify(next));
  return next;
}
async function deleteUser(id) {
  const u = await getUser(id);
  if (!u) return false;
  const cmds = [['DEL', K.user(id)], ['DEL', K.email(u.email)], ['SREM', K.usersAll, id], ['DEL', K.annRead(id)]];
  if (u.publisherId) cmds.push(['SREM', K.usersByPub(u.publisherId), id]);
  await kv.pipeline(cmds);
  return true;
}
async function listUsers({ publisherId } = {}) {
  const ids = await kv.cmd('SMEMBERS', publisherId ? K.usersByPub(publisherId) : K.usersAll);
  return mgetJson(ids.map(K.user));
}

/* ================= publishers ================= */
async function createPublisher({ name }) {
  const id = genId('p');
  const base = slugify(name) || 'publisher';
  let slug = base;
  let reserved = false;
  for (let i = 0; i < 6 && !reserved; i++) {
    reserved = (await kv.cmd('SET', K.slug(slug), id, 'NX')) === 'OK';
    if (!reserved) slug = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  if (!reserved) throw new Error('Could not create a unique workspace name. Try another name.');
  const rec = { id, name: clip(name, 80), slug, status: 'active', limits: { monthlyPosts: null, xAccounts: null, teamMembers: null }, createdAt: iso() };
  await kv.pipeline([['SET', K.pub(id), JSON.stringify(rec)], ['SADD', K.pubs, id]]);
  return rec;
}
const getPublisher = async (id) => (id ? parse(await kv.cmd('GET', K.pub(id))) : null);
async function updatePublisher(id, patch) {
  const p = await getPublisher(id);
  if (!p) return null;
  const next = { ...p, ...patch, id: p.id, slug: p.slug, limits: { ...p.limits, ...(patch.limits || {}) } };
  await kv.cmd('SET', K.pub(id), JSON.stringify(next));
  return next;
}
async function listPublishers() {
  const ids = await kv.cmd('SMEMBERS', K.pubs);
  const list = await mgetJson(ids.map(K.pub));
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
// Publishers plus { team, accounts, posts } counts, fetched in one round trip.
async function listPublishersWithUsage() {
  const list = await listPublishers();
  const cmds = [];
  list.forEach((p) => cmds.push(['SCARD', K.usersByPub(p.id)], ['SCARD', K.acctsByPub(p.id)], ['GET', K.cnt(`pub:${p.id}:total`)]));
  const r = await kv.pipeline(cmds);
  return list.map((p, i) => ({ ...p, usage: { team: Number(r[i * 3]) || 0, accounts: Number(r[i * 3 + 1]) || 0, posts: Number(r[i * 3 + 2]) || 0 } }));
}
async function getPublisherUsage(id) {
  const m = monthKey();
  const [team, accounts, total, month] = await kv.pipeline([
    ['SCARD', K.usersByPub(id)], ['SCARD', K.acctsByPub(id)], ['GET', K.cnt(`pub:${id}:total`)], ['GET', K.cnt(`pub:${id}:m:${m}`)]
  ]);
  return { team: Number(team) || 0, accounts: Number(accounts) || 0, posts: Number(total) || 0, monthPosts: Number(month) || 0 };
}

/* ================= X accounts ================= */
async function createAccount({ publisherId, label, username, adsAccountId, cookieEnc }) {
  const rec = {
    id: genId('a'), publisherId, label: clip(label, 60), username: clip(username, 40).replace(/^@/, ''),
    adsAccountId: clip(adsAccountId, 24), cookieEnc: cookieEnc || null, status: 'active',
    createdAt: iso(), sessionUpdatedAt: cookieEnc ? iso() : null
  };
  await kv.pipeline([['SET', K.acct(rec.id), JSON.stringify(rec)], ['SADD', K.acctsAll, rec.id], ['SADD', K.acctsByPub(publisherId), rec.id]]);
  return rec;
}
const getAccount = async (id) => (id ? parse(await kv.cmd('GET', K.acct(id))) : null);
async function updateAccount(id, patch) {
  const a = await getAccount(id);
  if (!a) return null;
  const next = { ...a, ...patch, id: a.id, publisherId: a.publisherId };
  await kv.cmd('SET', K.acct(id), JSON.stringify(next));
  return next;
}
async function deleteAccount(id) {
  const a = await getAccount(id);
  if (!a) return false;
  await kv.pipeline([['DEL', K.acct(id)], ['DEL', K.media(id)], ['SREM', K.acctsAll, id], ['SREM', K.acctsByPub(a.publisherId), id]]);
  return true;
}
async function listAccounts(publisherId) {
  const ids = await kv.cmd('SMEMBERS', K.acctsByPub(publisherId));
  const list = await mgetJson(ids.map(K.acct));
  return list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/* ================= media library (per X account) ================= */
const MEDIA_MAX = 40;
async function addMedia(accountId, item) {
  await kv.pipeline([['LPUSH', K.media(accountId), JSON.stringify(item)], ['LTRIM', K.media(accountId), 0, MEDIA_MAX - 1]]);
}
async function listMedia(accountId) {
  return (await kv.cmd('LRANGE', K.media(accountId), 0, MEDIA_MAX - 1)).map(parse).filter(Boolean);
}

/* ================= post history (per publisher) ================= */
const POSTS_MAX = 1000;
async function addPost(publisherId, entry) {
  const post = { id: genId('post'), createdAt: iso(), ...entry };
  const published = post.status === 'published';
  const day = dayKey();
  const month = monthKey();
  const cmds = [
    ['LPUSH', K.posts(publisherId), JSON.stringify(post)],
    ['LTRIM', K.posts(publisherId), 0, POSTS_MAX - 1],
    ['INCR', K.cnt(`pub:${publisherId}:total`)],
    ['INCR', K.cnt(`day:${day}:attempts`)], ['EXPIRE', K.cnt(`day:${day}:attempts`), 864000]
  ];
  if (published) {
    cmds.push(['INCR', K.cnt(`pub:${publisherId}:m:${month}`)], ['EXPIRE', K.cnt(`pub:${publisherId}:m:${month}`), 6048000]);
  } else {
    cmds.push(['INCR', K.cnt(`day:${day}:failed`)], ['EXPIRE', K.cnt(`day:${day}:failed`), 864000]);
  }
  await kv.pipeline(cmds);
  return post;
}
// allowedAccountIds = null means "everything in the workspace".
async function getPostHistory(publisherId, allowedAccountIds = null) {
  const all = (await kv.cmd('LRANGE', K.posts(publisherId), 0, -1)).map(parse).filter(Boolean);
  return allowedAccountIds ? all.filter((p) => allowedAccountIds.includes(p.accountId)) : all;
}
async function getPostSummary(publisherId, tzOffsetMinutes = 0, recentLimit = 5, allowedAccountIds = null) {
  const all = await getPostHistory(publisherId, allowedAccountIds);
  const tz = Number.isFinite(+tzOffsetMinutes) ? +tzOffsetMinutes : 0;
  const dayOf = (t) => new Date(new Date(t).getTime() - tz * 60000).toISOString().slice(0, 10);
  const today = dayOf(Date.now());
  const published = all.filter((p) => p.status === 'published');
  return {
    stats: {
      todayPublished: published.filter((p) => dayOf(p.createdAt) === today).length,
      totalPublished: published.length,
      failed: all.filter((p) => p.status !== 'published').length
    },
    recent: all.slice(0, recentLimit)
  };
}
async function deletePost(publisherId, id, allowedAccountIds = null) {
  const raws = await kv.cmd('LRANGE', K.posts(publisherId), 0, -1);
  const hit = raws.find((r) => {
    const p = parse(r);
    return p && p.id === id && (!allowedAccountIds || allowedAccountIds.includes(p.accountId));
  });
  if (!hit) return false;
  await kv.cmd('LREM', K.posts(publisherId), 1, hit);
  return true;
}
async function clearPostHistory(publisherId) {
  const n = Number(await kv.cmd('LLEN', K.posts(publisherId))) || 0;
  await kv.cmd('DEL', K.posts(publisherId));
  return n;
}
// Deliberately NOT reduced when history is deleted, so deleting history can't be used to dodge the monthly limit.
async function getMonthlyPostCount(publisherId) {
  return Number(await kv.cmd('GET', K.cnt(`pub:${publisherId}:m:${monthKey()}`))) || 0;
}

/* ================= platform stats + audit ================= */
async function getPlatformStats() {
  const days = [0, 1, 2, 3, 4, 5, 6].map(dayKey);
  const r = await kv.pipeline([
    ['SCARD', K.pubs], ['SCARD', K.usersAll], ['SCARD', K.acctsAll],
    ['GET', K.cnt(`day:${dayKey()}:attempts`)],
    ['MGET', ...days.map((d) => K.cnt(`day:${d}:failed`))]
  ]);
  return {
    publishers: Number(r[0]) || 0,
    users: Number(r[1]) || 0,
    xAccounts: Number(r[2]) || 0,
    postsToday: Number(r[3]) || 0,
    failures7d: (r[4] || []).reduce((s, v) => s + (Number(v) || 0), 0)
  };
}
async function audit(entry) {
  try {
    await kv.pipeline([['LPUSH', K.audit, JSON.stringify({ at: iso(), ...entry })], ['LTRIM', K.audit, 0, 299]]);
  } catch { /* the audit trail must never break the action being logged */ }
}
async function getAudit(limit = 10) {
  try { return (await kv.cmd('LRANGE', K.audit, 0, limit - 1)).map(parse).filter(Boolean); } catch { return []; }
}

/* ================= announcements ================= */
async function createAnnouncement(a) {
  const rec = {
    id: genId('n'), title: clip(a.title, 160), message: clip(a.message, 5000),
    audience: a.audience === 'selected' ? 'selected' : 'all', userIds: a.audience === 'selected' ? a.userIds || [] : [],
    countdownEndsAt: a.countdownEndsAt || null, createdAt: iso()
  };
  await kv.pipeline([['SET', K.ann(rec.id), JSON.stringify(rec), 'EX', 7776000], ['LPUSH', K.annList, rec.id], ['LTRIM', K.annList, 0, 99]]);
  return rec;
}
async function listAnnouncements() {
  const ids = await kv.cmd('LRANGE', K.annList, 0, 99);
  return mgetJson(ids.map(K.ann));
}
async function deleteAnnouncement(id) {
  await kv.pipeline([['DEL', K.ann(id)], ['LREM', K.annList, 0, id]]);
}
async function announcementsFor(user) {
  const [list, read] = await Promise.all([listAnnouncements(), kv.cmd('SMEMBERS', K.annRead(user.id))]);
  return list
    .filter((a) => !read.includes(a.id) && (a.audience === 'all' || a.userIds.includes(user.id)))
    .slice(0, 5);
}
const dismissAnnouncement = (userId, annId) => kv.cmd('SADD', K.annRead(userId), annId);

/* ================= small counters + upload progress (login lockout, upload bar) ================= */
async function getCounter(key) { return Number(await kv.cmd('GET', key)) || 0; }
async function bumpCounter(key, ttlSec) {
  const n = await kv.cmd('INCR', key);
  if (n === 1) await kv.cmd('EXPIRE', key, ttlSec);
  return n;
}
const resetCounter = (key) => kv.cmd('DEL', key);

const progressKey = (id) => `bb:progress:${id}`;
const setProgress = (id, data) => kv.cmd('SET', progressKey(id), JSON.stringify(data), 'EX', 900);
async function getProgress(id) { return parse(await kv.cmd('GET', progressKey(id))); }

module.exports = {
  genId, normEmail, effectiveLimits, defaultLimits,
  createUser, getUser, getUserByEmail, updateUser, deleteUser, listUsers,
  createPublisher, getPublisher, updatePublisher, listPublishers, listPublishersWithUsage, getPublisherUsage,
  createAccount, getAccount, updateAccount, deleteAccount, listAccounts,
  addMedia, listMedia,
  addPost, getPostHistory, getPostSummary, deletePost, clearPostHistory, getMonthlyPostCount,
  getPlatformStats, audit, getAudit,
  createAnnouncement, listAnnouncements, deleteAnnouncement, announcementsFor, dismissAnnouncement,
  getCounter, bumpCounter, resetCounter, setProgress, getProgress
};
