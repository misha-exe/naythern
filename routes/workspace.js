// routes/workspace.js - everything a publisher workspace needs (mounted AFTER requireAuth).
//   owner  : manages X accounts + team, posts with every account, sees all history
//   editor : posts only with the X accounts assigned to them
//   viewer : read-only (dashboard + history of their assigned accounts)
//   super admin "inside" a workspace acts as its owner.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { TMP_DIR, downloadVideo, makeSquare800, generateThumbnail } = require('../services/videoProcessor');
const TwitterClient = require('../services/twitterClient');
const db = require('../services/db');
const auth = require('../services/auth');
const secure = require('../services/secure');
const { assertPublicUrl } = require('../services/urlGuard');

const router = express.Router();
const { requireWorkspace, requireRole } = auth;
const OWNER = requireRole('owner');
const CAN_POST = requireRole('owner', 'editor');

/* ---------- helpers ---------- */
const publicAccount = (a) => ({
  id: a.id, label: a.label, username: a.username, adsAccountId: a.adsAccountId,
  hasSession: !!a.cookieEnc, status: a.status, createdAt: a.createdAt, sessionUpdatedAt: a.sessionUpdatedAt
});
const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, accountIds: u.accountIds || [], createdAt: u.createdAt
});
const tmpName = (prefix, ext) => path.join(TMP_DIR, `${prefix}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
const unlinkAll = (list) => list.forEach((p) => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error('[Route]', req.method, req.path, err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// Accounts this user may use. Owner (and super admin inside a workspace) = every account in the workspace.
async function accessibleAccounts(ctx) {
  const all = await db.listAccounts(ctx.publisher.id);
  return ctx.role === 'owner' ? all : all.filter((a) => (ctx.user.accountIds || []).includes(a.id));
}
const historyScope = (ctx) => (ctx.role === 'owner' ? null : ctx.user.accountIds || []);

// Resolves + authorises the account named in the request. Sends the error response itself and returns null on failure.
async function resolveAccount(req, res, id) {
  const accounts = await accessibleAccounts(req.ctx);
  if (!id) { res.status(400).json({ error: 'Choose an X account first.' }); return null; }
  const account = accounts.find((a) => a.id === String(id));
  if (!account) { res.status(403).json({ error: 'You do not have access to that X account.' }); return null; }
  if (account.status !== 'active') { res.status(403).json({ error: 'That X account is disabled.' }); return null; }
  return account;
}

function clientFor(account) {
  if (!account.cookieEnc) {
    throw new Error('This X account has no posting session saved yet. Add its auth_token and ct0 cookies on the X Accounts page.');
  }
  let c = null;
  try { c = secure.parseXCookie(secure.decrypt(account.cookieEnc)); } catch { c = null; }
  if (!c) throw new Error('The saved X session could not be read. Save the cookies again on the X Accounts page.');
  return new TwitterClient(c.authToken, c.ct0, account.adsAccountId, c.extra);
}

/* ================= session ================= */
router.get('/session', wrap(async (req, res) => {
  const { user, isSuper, publisher, role } = req.ctx;
  const home = isSuper && !publisher ? '/admin-dashboard.html' : role === 'viewer' ? '/dashboard.html' : '/';
  res.json({
    authenticated: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    isSuper,
    role,                                   // effective role inside the workspace (owner/editor/viewer) or super_admin
    publisher: publisher ? { id: publisher.id, name: publisher.name, slug: publisher.slug } : null,
    home,
    remainingMs: Number(res.getHeader('X-Session-Remaining-Ms'))
  });
}));
router.post('/session/touch', (req, res) => res.json({ success: true }));

/* ================= announcements ================= */
router.get('/announcements', wrap(async (req, res) => {
  if (req.ctx.isSuper) return res.json({ announcements: [] });
  res.json({ announcements: await db.announcementsFor(req.ctx.user) });
}));
router.post('/announcements/:id/dismiss', wrap(async (req, res) => {
  if (!req.ctx.isSuper) await db.dismissAnnouncement(req.ctx.user.id, String(req.params.id).slice(0, 40));
  res.json({ success: true });
}));

// Everything below needs an active workspace (a real member, or a super admin who has opened one).
router.use(requireWorkspace);

/* ================= the account dropdown in the Composer ================= */
router.get('/me/accounts', wrap(async (req, res) => {
  const accounts = (await accessibleAccounts(req.ctx)).filter((a) => a.status === 'active');
  res.json({ accounts: accounts.map(publicAccount), canPost: ['owner', 'editor'].includes(req.ctx.role) });
}));

/* ================= X accounts (owner) ================= */
router.get('/accounts', OWNER, wrap(async (req, res) => {
  const accounts = await db.listAccounts(req.ctx.publisher.id);
  res.json({ accounts: accounts.map(publicAccount), limit: db.effectiveLimits(req.ctx.publisher).xAccounts });
}));

function readAccountFields(body, { requireAll }) {
  const out = {};
  const label = String(body.label || '').trim();
  const username = String(body.username || '').trim().replace(/^@/, '');
  const adsAccountId = String(body.adsAccountId || '').trim();
  if (requireAll || body.label !== undefined) { if (!label) return { error: 'Give the account a label.' }; out.label = label; }
  if (body.username !== undefined || requireAll) { if (username && !/^[A-Za-z0-9_]{1,15}$/.test(username)) return { error: 'That X username is not valid.' }; out.username = username; }
  if (requireAll || body.adsAccountId !== undefined) { if (!secure.isAdsAccountId(adsAccountId)) return { error: 'Enter the Ads account ID (letters and numbers, e.g. 18ce55xmjw6).' }; out.adsAccountId = adsAccountId; }
  if (body.cookie) {
    const parsed = secure.parseXCookie(body.cookie);
    if (!parsed) return { error: 'Paste the cookies as: auth_token=…; ct0=…' };
    out.cookieEnc = secure.encrypt(`auth_token=${parsed.authToken}; ct0=${parsed.ct0}${parsed.extra ? '; ' + parsed.extra : ''}`);
    out.sessionUpdatedAt = new Date().toISOString();
  }
  return { out };
}

router.post('/accounts', OWNER, wrap(async (req, res) => {
  const pub = req.ctx.publisher;
  const existing = await db.listAccounts(pub.id);
  const max = db.effectiveLimits(pub).xAccounts;
  if (existing.length >= max) return res.status(403).json({ error: `This workspace is limited to ${max} X account${max === 1 ? '' : 's'}.` });
  const { out, error } = readAccountFields(req.body || {}, { requireAll: true });
  if (error) return res.status(400).json({ error });
  const account = await db.createAccount({ publisherId: pub.id, ...out });
  await db.audit({ type: 'account.added', publisherId: pub.id, publisherName: pub.name, actor: req.ctx.user.name, detail: account.label });
  res.json({ success: true, account: publicAccount(account) });
}));

router.patch('/accounts/:id', OWNER, wrap(async (req, res) => {
  const account = await db.getAccount(req.params.id);
  if (!account || account.publisherId !== req.ctx.publisher.id) return res.status(404).json({ error: 'Account not found.' });
  const body = req.body || {};
  const { out, error } = readAccountFields(body, { requireAll: false });
  if (error) return res.status(400).json({ error });
  if (body.status === 'active' || body.status === 'disabled') out.status = body.status;
  const next = await db.updateAccount(account.id, out);
  res.json({ success: true, account: publicAccount(next) });
}));

router.delete('/accounts/:id', OWNER, wrap(async (req, res) => {
  const pub = req.ctx.publisher;
  const account = await db.getAccount(req.params.id);
  if (!account || account.publisherId !== pub.id) return res.status(404).json({ error: 'Account not found.' });
  await db.deleteAccount(account.id);
  // Pull the account out of every member's access list. Existing post history is kept.
  const members = await db.listUsers({ publisherId: pub.id });
  await Promise.all(members.filter((m) => (m.accountIds || []).includes(account.id))
    .map((m) => db.updateUser(m.id, { accountIds: m.accountIds.filter((x) => x !== account.id) })));
  await db.audit({ type: 'account.removed', publisherId: pub.id, publisherName: pub.name, actor: req.ctx.user.name, detail: account.label });
  res.json({ success: true });
}));

/* ================= team (owner) ================= */
router.get('/team', OWNER, wrap(async (req, res) => {
  const pub = req.ctx.publisher;
  const [members, accounts] = await Promise.all([db.listUsers({ publisherId: pub.id }), db.listAccounts(pub.id)]);
  members.sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))));
  res.json({
    members: members.map(publicUser),
    accounts: accounts.map(publicAccount),
    limit: db.effectiveLimits(pub).teamMembers
  });
}));

// Only account ids that really belong to this workspace are kept.
async function cleanAccountIds(pubId, ids) {
  const valid = new Set((await db.listAccounts(pubId)).map((a) => a.id));
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((id) => valid.has(id));
}

router.post('/team', OWNER, wrap(async (req, res) => {
  const pub = req.ctx.publisher;
  const { name, email, role, password, accountIds } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Enter the member\'s name.' });
  if (!secure.isEmail(String(email || '').trim())) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Choose a role: editor or viewer.' });
  const pwProblem = secure.passwordProblem(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (db.normEmail(email) === auth.getConfig().email) return res.status(409).json({ error: 'That email address is already in use.' });

  const members = await db.listUsers({ publisherId: pub.id });
  const max = db.effectiveLimits(pub).teamMembers;
  if (members.length >= max) return res.status(403).json({ error: `This workspace is limited to ${max} team members.` });

  try {
    const user = await db.createUser({
      email, name, role, publisherId: pub.id, passwordHash: await auth.hashPassword(password),
      accountIds: role === 'editor' ? await cleanAccountIds(pub.id, accountIds) : []
    });
    await db.audit({ type: 'user.created', publisherId: pub.id, publisherName: pub.name, actor: req.ctx.user.name, detail: `${user.name} (${role})` });
    res.json({ success: true, member: publicUser(user) });
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return res.status(409).json({ error: err.message });
    throw err;
  }
}));

async function getMember(req, res) {
  const m = await db.getUser(req.params.id);
  if (!m || m.publisherId !== req.ctx.publisher.id) { res.status(404).json({ error: 'Member not found.' }); return null; }
  if (m.role === 'owner') { res.status(403).json({ error: 'The workspace owner cannot be changed here.' }); return null; }
  return m;
}

router.patch('/team/:id', OWNER, wrap(async (req, res) => {
  const m = await getMember(req, res);
  if (!m) return;
  const { role, accountIds, status, password } = req.body || {};
  const patch = {};
  if (role !== undefined) {
    if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Choose a role: editor or viewer.' });
    patch.role = role;
  }
  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    patch.status = status;
  }
  if (accountIds !== undefined) patch.accountIds = await cleanAccountIds(req.ctx.publisher.id, accountIds);
  if ((patch.role || m.role) === 'viewer' && patch.accountIds === undefined && patch.role) patch.accountIds = m.accountIds || [];
  if (password) {
    const problem = secure.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    patch.passwordHash = await auth.hashPassword(password);
  }
  const next = await db.updateUser(m.id, patch);
  res.json({ success: true, member: publicUser(next) });
}));

router.delete('/team/:id', OWNER, wrap(async (req, res) => {
  const m = await getMember(req, res);
  if (!m) return;
  await db.deleteUser(m.id);
  await db.audit({ type: 'user.removed', publisherId: req.ctx.publisher.id, publisherName: req.ctx.publisher.name, actor: req.ctx.user.name, detail: m.name });
  res.json({ success: true });
}));

/* ================= upload progress ================= */
// Progress lives in the shared database, NOT in this process's memory: on Vercel the request doing the upload
// and the request asking "how far along?" usually run on different instances.
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const progressChains = new Map();
const lastProgress = new Map();
const scale = (p, from, to) => from + (Math.max(0, Math.min(100, Number(p) || 0)) / 100) * (to - from);

function sendProgress(id, status, percent = 0) {
  if (!ID_RE.test(String(id || ''))) return Promise.resolve();
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const prev = lastProgress.get(id);
  const now = Date.now();
  if (prev && prev.status === status && pct < 100 && pct - prev.pct < 2 && now - prev.at < 400) {
    return progressChains.get(id) || Promise.resolve();
  }
  lastProgress.set(id, { status, pct, at: now });
  const chain = (progressChains.get(id) || Promise.resolve())
    .then(() => db.setProgress(id, { status, percent: pct }))
    .catch((err) => console.warn('[Progress]', err.message));
  progressChains.set(id, chain);
  return chain;
}
async function endProgress(id) {
  await (progressChains.get(id) || Promise.resolve());
  progressChains.delete(id);
  lastProgress.delete(id);
}

router.get('/upload-progress/:id', wrap(async (req, res) => {
  if (!ID_RE.test(String(req.params.id || ''))) return res.status(400).json({ error: 'Invalid upload id' });
  try { return res.json((await db.getProgress(req.params.id)) || {}); } catch { return res.json({}); }
}));

/* ================= media library (per X account) ================= */
router.get('/media', wrap(async (req, res) => {
  const account = await resolveAccount(req, res, req.query.accountId);
  if (!account) return;
  res.json(await db.listMedia(account.id));
}));

// Shared tail of both upload routes: square it, thumbnail it, push it to X, remember it for THIS account.
async function processVideo({ req, res, account, clientId, rawPath, displayName, temp }) {
  const squarePath = tmpName('square', 'mp4');
  const thumbPath = tmpName('thumb', 'jpg');
  temp.push(squarePath, thumbPath);
  try {
    sendProgress(clientId, 'Preparing an 800x800 website card without cropping', 28);
    await makeSquare800(rawPath, squarePath);
    await generateThumbnail(squarePath, thumbPath);
    sendProgress(clientId, 'Square video is ready. Starting X upload.', 40);

    const client = clientFor(account);
    const mediaId = await client.uploadMediaChunked(squarePath, (p) => {
      const overall = scale(p, 40, 85);
      sendProgress(clientId, `Uploading to X (${Math.round(overall)}%)`, overall);
    });
    sendProgress(clientId, 'X is processing the video', 88);
    sendProgress(clientId, 'Adding video to the Ads Media Library', 95);
    await client.addToAdsMediaLibrary(mediaId, displayName);
    sendProgress(clientId, 'Video added to the Ads Media Library and selected', 100);

    const record = {
      id: db.genId('m'), mediaId, name: displayName,
      thumbnail: `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString('base64')}`,
      meta: 'Square · 800x800', accountId: account.id, by: req.ctx.user.name, createdAt: new Date().toISOString()
    };
    await db.addMedia(account.id, record);
    unlinkAll(temp);
    await endProgress(clientId);
    return res.json({ success: true, media: record });
  } catch (err) {
    unlinkAll(temp);
    await endProgress(clientId);
    return res.status(500).json({ error: err.message });
  }
}

router.post('/upload-url', CAN_POST, wrap(async (req, res) => {
  const { videoUrl, clientId } = req.body || {};
  const account = await resolveAccount(req, res, (req.body || {}).accountId);
  if (!account) return;
  if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });
  let safeUrl;
  try { safeUrl = await assertPublicUrl(videoUrl); } catch (err) { return res.status(400).json({ error: err.message }); }

  const rawPath = tmpName('raw', 'mp4');
  const temp = [rawPath];
  try {
    sendProgress(clientId, 'Downloading video from URL', 2);
    await downloadVideo(safeUrl, rawPath, (pct) => sendProgress(clientId, 'Downloading video from URL', scale(pct, 2, 25)));
  } catch (err) {
    unlinkAll(temp);
    await endProgress(clientId);
    return res.status(500).json({ error: `Could not download that video: ${err.message}` });
  }
  const displayName = path.basename(new URL(safeUrl).pathname) || 'video.mp4';
  return processVideo({ req, res, account, clientId, rawPath, displayName, temp });
}));

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 4.5 * 1024 * 1024 } });
const receiveFile = (req, res, next) => upload.single('video')(req, res, (err) => {
  if (!err) return next();
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 4.5 MB (the Vercel upload limit). Use the URL upload for larger videos.' : err.message;
  return res.status(400).json({ error: msg });
});

router.post('/upload-file', CAN_POST, receiveFile, wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
  const temp = [req.file.path];
  const account = await resolveAccount(req, res, req.body && req.body.accountId);
  if (!account) { unlinkAll(temp); return; }
  const displayName = String(req.file.originalname || 'video.mp4').slice(0, 120);
  return processVideo({ req, res, account, clientId: req.body.clientId, rawPath: req.file.path, displayName, temp });
}));

/* ================= publish ================= */
const URL_RULE_MESSAGE = 'Your URL needs to start with https:// or http://. Check the address and try again';

router.post('/publish', CAN_POST, wrap(async (req, res) => {
  const { postText, websiteUrl, headline, mediaId } = req.body || {};
  const pub = req.ctx.publisher;
  const account = await resolveAccount(req, res, (req.body || {}).accountId);
  if (!account) return;

  if (!websiteUrl || !headline || !mediaId) return res.status(400).json({ error: 'Missing required card fields: websiteUrl, headline, or mediaId.' });
  if (!/^https?:\/\//i.test(String(websiteUrl).trim())) return res.status(400).json({ error: URL_RULE_MESSAGE });
  if (String(headline).length > 70 || String(postText || '').length > 280) return res.status(400).json({ error: 'Headline is limited to 70 characters and post text to 280.' });

  const limit = db.effectiveLimits(pub).monthlyPosts;
  if ((await db.getMonthlyPostCount(pub.id)) >= limit) {
    return res.status(403).json({ error: `This workspace has reached its monthly limit of ${limit.toLocaleString('en-US')} posts.` });
  }

  let client;
  try { client = clientFor(account); } catch (err) { return res.status(400).json({ error: err.message }); }

  const base = {
    headline, postText, websiteUrl: String(websiteUrl).trim(), mediaId,
    accountId: account.id, accountLabel: account.label, by: req.ctx.user.name
  };
  const log = async (entry, type) => {
    try {
      await db.addPost(pub.id, entry);
      await db.audit({ type, publisherId: pub.id, publisherName: pub.name, actor: req.ctx.user.name, detail: account.label });
    } catch (err) { console.warn('[History] Could not record post attempt:', err.message); }
  };

  try {
    const result = await client.postTweet(postText, mediaId, String(websiteUrl).trim(), headline);
    const postId = result.postId && /^\d+$/.test(String(result.postId)) ? String(result.postId) : null;
    const postUrl = postId ? `https://x.com/i/status/${postId}` : null;
    await log({ ...base, status: 'published', postId, postUrl }, 'post.published');
    return res.json({ success: true, postId, postUrl, cardUri: result.cardUri, message: 'X created the Website Card post.' });
  } catch (postErr) {
    console.error('[Publish] failed:', postErr.message);
    await log({ ...base, status: 'failed', error: postErr.message }, 'post.failed');
    return res.status(400).json({ error: postErr.message });
  }
}));

/* ================= post history ================= */
router.get('/posts/summary', wrap(async (req, res) => {
  let tz = parseInt(req.query.tz, 10);
  if (!Number.isFinite(tz) || tz < -840 || tz > 840) tz = 0;
  res.json(await db.getPostSummary(req.ctx.publisher.id, tz, 30, historyScope(req.ctx)));
}));
router.get('/posts', wrap(async (req, res) => {
  res.json({ posts: await db.getPostHistory(req.ctx.publisher.id, historyScope(req.ctx)) });
}));
router.delete('/posts/:id', CAN_POST, wrap(async (req, res) => {
  const removed = await db.deletePost(req.ctx.publisher.id, req.params.id, historyScope(req.ctx));
  if (!removed) return res.status(404).json({ error: 'That history entry no longer exists.' });
  res.json({ success: true });
}));
router.delete('/posts', OWNER, wrap(async (req, res) => {
  res.json({ success: true, deleted: await db.clearPostHistory(req.ctx.publisher.id) });
}));

/* ================= setup check ================= */
router.get('/diagnose', OWNER, wrap(async (req, res) => {
  const account = await resolveAccount(req, res, req.query.accountId);
  if (!account) return;
  let client;
  try { client = clientFor(account); } catch (err) { return res.json({ ok: false, error: err.message }); }
  const report = {
    hasAdsAccountId: !!client.adsAccountId, hasAdsBearer: !!client.adsBearer,
    hasWebSession: !!(client.authToken && client.ct0), adsApiHost: 'ads-api.x.com'
  };
  try {
    report.adsAccount = await client.checkAdsAccess();
    const qid = await client.resolveCreateTweetQueryId();
    report.createTweetQueryId = qid ? { ok: true, source: client._queryIdSource } : { ok: false };
    report.ok = !!qid;
  } catch (err) {
    report.ok = false;
    report.error = err.message;
  }
  res.json(report);
}));

module.exports = router;
