// scripts/selftest.js - runs the whole API (roles, isolation, limits, suspension, uploads, publish) in-process.
// It stubs express / multer / ffmpeg / the X client, so it needs no network, no KV and no npm install:
//     node scripts/selftest.js
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

process.env.AUTH_EMAIL = 'admin@example.com';
process.env.AUTH_PASSWORD = 'super-admin-pass-123';
process.env.AUTH_SECRET = 'x'.repeat(48);
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

/* ---------- tiny express stand-in ---------- */
function run(fns, req, res, done) {
  let i = 0;
  const next = (err) => {
    if (err) return done(err);
    const f = fns[i++];
    if (!f) return done();
    try {
      const out = f.handle ? f.handle(req, res, next) : f(req, res, next);
      if (out && out.catch) out.catch(next);
    } catch (e) { next(e); }
  };
  next();
}
function makeRouter() {
  const layers = [];
  const r = (req, res, out) => r.handle(req, res, out);
  r.handle = (req, res, out) => {
    let i = 0;
    const next = (err) => {
      if (err) return out(err);
      const l = layers[i++];
      if (!l) return out();
      if (l.use) {
        const p = l.prefix;
        if (p === '/' || req.path === p || req.path.startsWith(p + '/')) {
          const saved = req.path;
          req.path = p === '/' ? saved : saved.slice(p.length) || '/';
          return run(l.fns, req, res, (e) => { req.path = saved; next(e); });
        }
        return next();
      }
      if (l.method !== req.method) return next();
      const names = [];
      const re = new RegExp('^' + l.path.replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
      const m = req.path.match(re);
      if (!m) return next();
      req.params = {};
      names.forEach((n, idx) => { req.params[n] = decodeURIComponent(m[idx + 1]); });
      return run(l.fns, req, res, next);
    };
    next();
  };
  ['get', 'post', 'patch', 'delete'].forEach((m) => { r[m] = (p, ...fns) => layers.push({ method: m.toUpperCase(), path: p, fns: fns.flat() }); });
  r.use = (a, ...fns) => layers.push(typeof a === 'string' ? { use: true, prefix: a, fns: fns.flat() } : { use: true, prefix: '/', fns: [a, ...fns].flat() });
  r.set = () => {};
  return r;
}
const express = () => makeRouter();
express.Router = makeRouter;
express.json = () => (req, res, next) => next();
express.urlencoded = () => (req, res, next) => next();

class FakeTwitter {
  constructor(authToken, ct0, adsAccountId) { Object.assign(this, { authToken, ct0, adsAccountId }); FakeTwitter.last = this; }
  async uploadMediaChunked(p, cb) { cb && cb(100); return '9000' + Math.floor(Math.random() * 1e6); }
  async addToAdsMediaLibrary() {}
  async postTweet() { return FakeTwitter.noPostId ? { success: true, cardUri: 'card://x' } : { postId: '1234567890', cardUri: 'card://x' }; }
}
const stubs = {
  express,
  multer: () => ({ single: () => (req, res, cb) => cb() }),
  dotenv: { config() {} },
  videoProcessor: {
    TMP_DIR: os.tmpdir(),
    downloadVideo: async (u, out) => fs.writeFileSync(out, 'video'),
    makeSquare800: async (i, out) => fs.writeFileSync(out, 'square'),
    generateThumbnail: async (i, out) => fs.writeFileSync(out, 'thumb')
  },
  twitterClient: FakeTwitter
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (stubs[request]) return stubs[request];
  if (request.endsWith('/videoProcessor')) return stubs.videoProcessor;
  if (request.endsWith('/twitterClient')) return stubs.twitterClient;
  return origLoad.call(this, request, ...rest);
};

const app = require(path.join(__dirname, '..', 'api', 'index.js'));
const db = require(path.join(__dirname, '..', 'services', 'db.js'));

/* ---------- request helper ---------- */
function call(who, method, url, body, query) {
  return new Promise((resolve) => {
    const headers = { host: 'test.local' };
    if (who && who.cookie) headers.cookie = who.cookie;
    const req = { method, path: url, url, headers, body: body || {}, query: query || {}, params: {}, socket: { remoteAddress: '1.2.3.4' } };
    const out = { headers: {}, statusCode: 200 };
    const res = {
      setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
      getHeader: (k) => out.headers[k.toLowerCase()],
      status(c) { out.statusCode = c; return this; },
      json(b) {
        if (who && out.headers['set-cookie']) {
          const c = String(out.headers['set-cookie']).split(';')[0];
          who.cookie = c.endsWith('=') ? '' : c;
        }
        resolve({ status: out.statusCode, body: b });
        return this;
      }
    };
    app(req, res, (err) => resolve({ status: 404, body: { error: err ? err.message : 'not found' } }));
  });
}
const login = async (email, password) => {
  const who = { cookie: '' };
  const r = await call(who, 'POST', '/api/login', { email, password });
  return { who, r };
};

let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log('  ✓', label); };

(async () => {
  console.log('Super admin');
  let r = (await login('admin@example.com', 'wrong')).r;
  ok(r.status === 401, 'wrong password is rejected');
  const { who: admin, r: lr } = await login('admin@example.com', process.env.AUTH_PASSWORD);
  ok(lr.status === 200 && lr.body.redirect === '/admin-dashboard.html', 'super admin signs in and lands on the platform overview');
  r = await call(admin, 'GET', '/api/session');
  ok(r.body.isSuper && !r.body.publisher, 'session shows super admin with no workspace open');
  r = await call(admin, 'GET', '/api/me/accounts');
  ok(r.status === 409, 'workspace routes need an opened workspace');

  console.log('Publishers + owners');
  r = await call(admin, 'POST', '/api/admin/publishers', { name: 'Alpha Media', ownerName: 'Alice', ownerEmail: 'alice@alpha.com' });
  ok(r.status === 200 && r.body.temporaryPassword, 'create publisher returns a one-time generated password');
  const alphaId = r.body.publisher.id;
  const alicePw = r.body.temporaryPassword;
  r = await call(admin, 'POST', '/api/admin/publishers', { name: 'Beta Media', ownerName: 'Bob', ownerEmail: 'bob@beta.com', ownerPassword: 'bob-password-1' });
  const betaId = r.body.publisher.id;
  ok(r.status === 200 && r.body.temporaryPassword === null, 'owner can be created with a chosen password');
  r = await call(admin, 'POST', '/api/admin/publishers', { name: 'Dupe', ownerName: 'A', ownerEmail: 'ALICE@alpha.com' });
  ok(r.status === 409, 'duplicate owner email is rejected (case-insensitive)');
  r = await call(admin, 'POST', '/api/admin/publishers', { name: 'Dupe', ownerName: 'A', ownerEmail: 'admin@example.com' });
  ok(r.status === 409, 'cannot reuse the super admin email');
  r = await call(admin, 'GET', '/api/admin/overview');
  ok(r.body.metrics.publishers === 2 && r.body.metrics.users === 2, 'overview counts publishers and users');

  console.log('Owner');
  const { who: alice, r: al } = await login('alice@alpha.com', alicePw);
  ok(al.status === 200 && al.body.redirect === '/', 'owner signs in with the generated password');
  r = await call(alice, 'GET', '/api/admin/overview');
  ok(r.status === 403, 'owner cannot reach the super admin API');
  r = await call(alice, 'POST', '/api/accounts', { label: 'Main', username: 'alpha_main', adsAccountId: '18ce55aaaaa', cookie: 'nope' });
  ok(r.status === 400, 'bad cookie string is rejected');
  const cookie = (n) => `auth_token=${'a'.repeat(40)}; ct0=${String(n).repeat(32)}`;
  r = await call(alice, 'POST', '/api/accounts', { label: 'Main', username: 'alpha_main', adsAccountId: '18ce55aaaaa', cookie: cookie(1) });
  const acct1 = r.body.account.id;
  ok(r.status === 200 && r.body.account.hasSession && !('cookieEnc' in r.body.account), 'account saved; cookies are never returned');
  const stored = await db.getAccount(acct1);
  ok(stored.cookieEnc.startsWith('enc1:') && !stored.cookieEnc.includes('aaaaaaaa'), 'session cookies are encrypted at rest');
  r = await call(alice, 'POST', '/api/accounts', { label: 'Second', username: 'alpha_two', adsAccountId: '18ce55bbbbb', cookie: cookie(2) });
  const acct2 = r.body.account.id;
  r = await call(alice, 'POST', '/api/accounts', { label: 'Third', adsAccountId: '18ce55ccccc', cookie: cookie(3) });
  ok(r.status === 403, 'plan limit (2 X accounts) is enforced');

  console.log('Team + account switching');
  r = await call(alice, 'POST', '/api/team', { name: 'Ed', email: 'ed@alpha.com', role: 'editor', password: 'short', accountIds: [acct1] });
  ok(r.status === 400, 'short passwords are rejected');
  r = await call(alice, 'POST', '/api/team', { name: 'Ed', email: 'ed@alpha.com', role: 'editor', password: 'editor-pass-12', accountIds: [acct1, 'bogus'] });
  const edId = r.body.member.id;
  ok(r.status === 200 && r.body.member.accountIds.length === 1, 'editor created with only valid account access');
  r = await call(alice, 'POST', '/api/team', { name: 'Vi', email: 'vi@alpha.com', role: 'viewer', password: 'viewer-pass-12' });
  ok(r.status === 200, 'viewer created');
  const { who: ed } = await login('ed@alpha.com', 'editor-pass-12');
  r = await call(ed, 'GET', '/api/me/accounts');
  ok(r.body.accounts.length === 1 && r.body.accounts[0].id === acct1, 'editor dropdown lists only the assigned account');
  r = await call(ed, 'GET', '/api/accounts');
  ok(r.status === 403, 'editor cannot manage accounts');
  r = await call(ed, 'POST', '/api/publish', { accountId: acct2, postText: 'hi', websiteUrl: 'https://e.com', headline: 'H', mediaId: '1' });
  ok(r.status === 403, 'editor cannot post with an account they are not assigned');
  r = await call(ed, 'POST', '/api/publish', { accountId: acct1, postText: 'hi', websiteUrl: 'https://e.com', headline: 'H', mediaId: '1' });
  ok(r.status === 200 && r.body.postUrl, 'editor can post with the assigned account');
  ok(FakeTwitter.last.adsAccountId === '18ce55aaaaa' && FakeTwitter.last.ct0 === '1'.repeat(32), 'the selected account\'s own Ads ID + cookies were used');
  // grant second account -> switching works
  await call(alice, 'PATCH', `/api/team/${edId}`, { accountIds: [acct1, acct2] });
  r = await call(ed, 'POST', '/api/publish', { accountId: acct2, postText: 'hi', websiteUrl: 'https://e.com', headline: 'H2', mediaId: '2' });
  ok(r.status === 200 && FakeTwitter.last.ct0 === '2'.repeat(32), 'after granting access the editor can switch to account 2');
  FakeTwitter.noPostId = true;
  r = await call(ed, 'POST', '/api/publish', { accountId: acct2, postText: 'hi', websiteUrl: 'https://e.com', headline: 'H2b', mediaId: '2' });
  ok(r.status === 400 && !r.body.success, 'a reply without a post ID is reported as a failure, never as success');
  FakeTwitter.noPostId = false;
  const { who: vi } = await login('vi@alpha.com', 'viewer-pass-12');
  r = await call(vi, 'POST', '/api/publish', { accountId: acct1, postText: 'x', websiteUrl: 'https://e.com', headline: 'H', mediaId: '1' });
  ok(r.status === 403, 'viewers cannot publish');
  r = await call(alice, 'GET', '/api/posts');
  ok(r.body.posts.length === 3 && r.body.posts.filter((p) => p.status === 'failed').length === 1, 'owner sees all history, including who posted');

  console.log('Uploads (per account)');
  const up = (accountId) => call(ed, 'POST', '/api/upload-url', { accountId, clientId: 'up_abcdef123', videoUrl: 'https://93.184.216.34/v.mp4' });
  r = await up(acct1);
  ok(r.status === 200 && r.body.media.accountId === acct1, 'URL upload lands in the chosen account\'s library');
  r = await call(ed, 'GET', '/api/media', null, { accountId: acct1 });
  ok(r.body.length === 1, 'library lists it');
  r = await call(ed, 'GET', '/api/media', null, { accountId: acct2 });
  ok(r.body.length === 0, 'the other account\'s library is separate');
  r = await call(ed, 'POST', '/api/upload-url', { accountId: acct1, clientId: 'up_abcdef124', videoUrl: 'http://127.0.0.1/v.mp4' });
  ok(r.status === 400, 'private / loopback URLs are blocked (SSRF guard)');

  console.log('Isolation between publishers');
  const { who: bob } = await login('bob@beta.com', 'bob-password-1');
  r = await call(bob, 'GET', '/api/media', null, { accountId: acct1 });
  ok(r.status === 403, 'another publisher cannot read my account library');
  r = await call(bob, 'PATCH', `/api/team/${edId}`, { role: 'viewer' });
  ok(r.status === 404, 'another publisher cannot edit my members');
  r = await call(bob, 'GET', '/api/posts');
  ok(r.body.posts.length === 0, 'another publisher sees none of my history');

  console.log('Monthly limit + suspension');
  await call(admin, 'PATCH', `/api/admin/publishers/${alphaId}`, { limits: { monthlyPosts: 2 } });
  r = await call(ed, 'POST', '/api/publish', { accountId: acct1, postText: 'x', websiteUrl: 'https://e.com', headline: 'H3', mediaId: '3' });
  ok(r.status === 403 && /monthly limit/.test(r.body.error), 'monthly post limit override is enforced');
  r = await call(admin, 'PATCH', `/api/admin/publishers/${alphaId}`, { status: 'suspended' });
  r = await call(ed, 'GET', '/api/me/accounts');
  ok(r.status === 403 && r.body.code === 'suspended', 'suspending a publisher blocks its members immediately');
  r = (await login('ed@alpha.com', 'editor-pass-12')).r;
  ok(r.status === 403, 'suspended members cannot sign in');

  console.log('Super admin opens a workspace');
  r = await call(admin, 'POST', `/api/admin/publishers/${alphaId}/open`);
  r = await call(admin, 'GET', '/api/session');
  ok(r.body.publisher && r.body.publisher.id === alphaId && r.body.role === 'owner', 'opening a workspace acts as its owner');
  r = await call(admin, 'GET', '/api/accounts');
  ok(r.body.accounts.length === 2, 'super admin sees the workspace accounts');
  r = await call(admin, 'POST', '/api/admin/exit-workspace');
  r = await call(admin, 'GET', '/api/session');
  ok(!r.body.publisher, 'exit returns to the platform view');

  console.log('Editors + announcements');
  r = await call(admin, 'POST', `/api/admin/editors/${edId}/password`, {});
  const newPw = r.body.temporaryPassword;
  ok(!!newPw, 'password reset generates a new one');
  await call(admin, 'PATCH', `/api/admin/publishers/${alphaId}`, { status: 'active' });
  r = (await login('ed@alpha.com', newPw)).r;
  ok(r.status === 200, 'editor signs in with the reset password');
  r = await call(admin, 'POST', '/api/admin/announcements', { title: 'Hello', message: 'Maintenance tonight', audience: 'all' });
  const { who: ed2 } = await login('ed@alpha.com', newPw);
  r = await call(ed2, 'GET', '/api/announcements');
  ok(r.body.announcements.length === 1, 'announcement reaches members');
  await call(ed2, 'POST', `/api/announcements/${r.body.announcements[0].id}/dismiss`);
  r = await call(ed2, 'GET', '/api/announcements');
  ok(r.body.announcements.length === 0, 'dismissed announcements stay dismissed');

  console.log('Account removal');
  r = await call(alice, 'DELETE', `/api/accounts/${acct2}`);
  const edNow = await db.getUser(edId);
  ok(r.status === 200 && !edNow.accountIds.includes(acct2), 'deleting an account removes it from members\' access');

  console.log(`\nAll ${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message); console.error(e.stack); process.exit(1); });
