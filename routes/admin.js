// routes/admin.js - the SUPER ADMIN ("platform administrator") API. Mounted at /api/admin behind requireSuper.
//
//   Publishers  = isolated customer workspaces (name, status, plan overrides)
//   Owners      = the first user of each publisher, created together with it
//   Editors     = every member across the platform (reset passwords, disable)
//   Open        = the super admin steps INTO a publisher's workspace (acts as its owner) and can leave again
const express = require('express');
const db = require('../services/db');
const auth = require('../services/auth');
const secure = require('../services/secure');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error('[Admin]', req.method, req.path, err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const publicPublisher = (p, owner) => ({
  id: p.id, name: p.name, slug: p.slug, status: p.status, createdAt: p.createdAt,
  overrides: p.limits || {}, limits: db.effectiveLimits(p), usage: p.usage || null,
  owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null
});

/* ---------- overview ---------- */
router.get('/overview', wrap(async (req, res) => {
  const [metrics, pubs, activity] = await Promise.all([db.getPlatformStats(), db.listPublishersWithUsage(), db.getAudit(10)]);
  res.json({ metrics, recentPublishers: pubs.slice(0, 8).map((p) => publicPublisher(p)), activity });
}));

/* ---------- publishers ---------- */
router.get('/publishers', wrap(async (req, res) => {
  const [pubs, users] = await Promise.all([db.listPublishersWithUsage(), db.listUsers()]);
  const owners = new Map(users.filter((u) => u.role === 'owner').map((u) => [u.publisherId, u]));
  res.json({ publishers: pubs.map((p) => publicPublisher(p, owners.get(p.id))), defaults: db.defaultLimits() });
}));

router.post('/publishers', wrap(async (req, res) => {
  const { name, ownerName, ownerEmail, ownerPassword } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Enter the publisher name.' });
  if (!String(ownerName || '').trim()) return res.status(400).json({ error: 'Enter the owner\'s name.' });
  if (!secure.isEmail(String(ownerEmail || '').trim())) return res.status(400).json({ error: 'Enter a valid owner email.' });
  if (db.normEmail(ownerEmail) === auth.getConfig().email) return res.status(409).json({ error: 'That email address is already in use.' });

  let password = String(ownerPassword || '');
  const generated = !password;
  if (generated) password = secure.generatePassword();
  else { const problem = secure.passwordProblem(password); if (problem) return res.status(400).json({ error: problem }); }

  // Check the email first so a taken email doesn't leave an empty publisher behind.
  if (await db.getUserByEmail(ownerEmail)) return res.status(409).json({ error: 'That email address is already in use.' });

  const publisher = await db.createPublisher({ name: String(name).trim() });
  let owner;
  try {
    owner = await db.createUser({
      email: ownerEmail, name: ownerName, role: 'owner', publisherId: publisher.id,
      passwordHash: await auth.hashPassword(password), accountIds: []
    });
  } catch (err) {
    await db.updatePublisher(publisher.id, { status: 'suspended' });
    if (err.code === 'EMAIL_TAKEN') return res.status(409).json({ error: err.message });
    throw err;
  }
  await db.audit({ type: 'publisher.created', publisherId: publisher.id, publisherName: publisher.name, actor: 'Administrator', detail: owner.email });
  res.json({
    success: true,
    publisher: publicPublisher(publisher, owner),
    // Shown ONCE so you can hand it to the customer; it is stored only as a hash.
    temporaryPassword: generated ? password : null
  });
}));

router.get('/publishers/:id', wrap(async (req, res) => {
  const p = await db.getPublisher(req.params.id);
  if (!p) return res.status(404).json({ error: 'Publisher not found.' });
  const [usage, users] = await Promise.all([db.getPublisherUsage(p.id), db.listUsers({ publisherId: p.id })]);
  p.usage = usage;
  res.json({ publisher: publicPublisher(p, users.find((u) => u.role === 'owner')), defaults: db.defaultLimits() });
}));

// A blank limit means "use the plan default"; otherwise it must be a whole number >= 1.
const limitValue = (v) => {
  if (v === '' || v === null || v === undefined) return { ok: true, value: null };
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1000000 ? { ok: true, value: n } : { ok: false };
};

router.patch('/publishers/:id', wrap(async (req, res) => {
  const p = await db.getPublisher(req.params.id);
  if (!p) return res.status(404).json({ error: 'Publisher not found.' });
  const { name, status, limits } = req.body || {};
  const patch = {};
  if (name !== undefined) { if (!String(name).trim()) return res.status(400).json({ error: 'Enter the publisher name.' }); patch.name = String(name).trim().slice(0, 80); }
  if (status !== undefined) { if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status.' }); patch.status = status; }
  if (limits) {
    patch.limits = {};
    for (const k of ['monthlyPosts', 'xAccounts', 'teamMembers']) {
      if (limits[k] === undefined) continue;
      const r = limitValue(limits[k]);
      if (!r.ok) return res.status(400).json({ error: 'Limits must be whole numbers of 1 or more (or blank for the plan default).' });
      patch.limits[k] = r.value;
    }
  }
  const next = await db.updatePublisher(p.id, patch);
  await db.audit({ type: 'publisher.updated', publisherId: p.id, publisherName: next.name, actor: 'Administrator', detail: patch.status || 'settings changed' });
  res.json({ success: true, publisher: publicPublisher(next) });
}));

// Step into a workspace. The session cookie is re-issued with the publisher id; every later request re-checks it.
router.post('/publishers/:id/open', wrap(async (req, res) => {
  const p = await db.getPublisher(req.params.id);
  if (!p) return res.status(404).json({ error: 'Publisher not found.' });
  const s = req.sessionData;
  auth.setSessionCookie(req, res, auth.issueToken(auth.SUPER_ID, { iat: s.iat, la: Date.now(), p: p.id }), s.iat);
  res.json({ success: true, redirect: '/dashboard.html' });
}));

router.post('/exit-workspace', wrap(async (req, res) => {
  const s = req.sessionData;
  auth.setSessionCookie(req, res, auth.issueToken(auth.SUPER_ID, { iat: s.iat, la: Date.now() }), s.iat);
  res.json({ success: true, redirect: '/admin-dashboard.html' });
}));

/* ---------- editors (all members, platform-wide) ---------- */
router.get('/editors', wrap(async (req, res) => {
  const [users, pubs] = await Promise.all([db.listUsers(), db.listPublishers()]);
  const names = new Map(pubs.map((p) => [p.id, p.name]));
  const editors = users
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, publisherId: u.publisherId, publisherName: names.get(u.publisherId) || '—' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ editors });
}));

router.post('/editors/:id/password', wrap(async (req, res) => {
  const u = await db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  let password = String((req.body || {}).password || '');
  const generated = !password;
  if (generated) password = secure.generatePassword();
  else { const problem = secure.passwordProblem(password); if (problem) return res.status(400).json({ error: problem }); }
  await db.updateUser(u.id, { passwordHash: await auth.hashPassword(password) });
  await db.audit({ type: 'user.password_reset', publisherId: u.publisherId, actor: 'Administrator', detail: u.email });
  res.json({ success: true, temporaryPassword: generated ? password : null });
}));

router.patch('/editors/:id', wrap(async (req, res) => {
  const u = await db.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const { status } = req.body || {};
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  await db.updateUser(u.id, { status });
  res.json({ success: true });
}));

/* ---------- announcements ---------- */
router.get('/announcements', wrap(async (req, res) => {
  const [announcements, users, pubs] = await Promise.all([db.listAnnouncements(), db.listUsers(), db.listPublishers()]);
  const names = new Map(pubs.map((p) => [p.id, p.name]));
  res.json({
    announcements,
    recipients: users.filter((u) => u.status === 'active').map((u) => ({ id: u.id, name: u.name, email: u.email, publisherName: names.get(u.publisherId) || '—' }))
  });
}));

router.post('/announcements', wrap(async (req, res) => {
  const { title, message, audience, userIds, countdownEndsAt } = req.body || {};
  if (!String(title || '').trim() || !String(message || '').trim()) return res.status(400).json({ error: 'Add a title and a message.' });
  let ends = null;
  if (countdownEndsAt) {
    const d = new Date(countdownEndsAt);
    if (isNaN(d)) return res.status(400).json({ error: 'The countdown time is not valid.' });
    ends = d.toISOString();
  }
  if (audience === 'selected' && !(Array.isArray(userIds) && userIds.length)) return res.status(400).json({ error: 'Choose at least one recipient.' });
  const a = await db.createAnnouncement({ title, message, audience, userIds: (userIds || []).map(String), countdownEndsAt: ends });
  await db.audit({ type: 'announcement.sent', actor: 'Administrator', detail: a.title });
  res.json({ success: true, announcement: a });
}));

router.delete('/announcements/:id', wrap(async (req, res) => {
  await db.deleteAnnouncement(String(req.params.id).slice(0, 40));
  res.json({ success: true });
}));

module.exports = router;
