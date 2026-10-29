require('dotenv').config();
const express = require('express');

const auth = require('../services/auth');
const adminRoutes = require('../routes/admin');
const workspaceRoutes = require('../routes/workspace');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const router = express.Router();
router.use(auth.sameOrigin);

const homeFor = (user) => (user.role === 'super_admin' ? '/admin-dashboard.html' : user.role === 'viewer' ? '/dashboard.html' : '/');

// ---------- Public: sign in / out ----------
router.post('/login', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.isConfigured()) {
    return res.status(503).json({
      error: 'Login is not set up on the server yet. Add AUTH_EMAIL, AUTH_PASSWORD_HASH and AUTH_SECRET to the environment variables.',
      code: 'unconfigured'
    });
  }
  try {
    const { email, password } = req.body || {};
    const ip = auth.clientIp(req);
    if (await auth.isLockedOut(ip, email)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.', code: 'locked' });
    }

    const result = await auth.authenticate(email, password);
    if (!result.user) {
      if (result.error === 'suspended') {
        return res.status(403).json({ error: 'This account or its workspace is suspended. Contact the administrator.', code: 'suspended' });
      }
      await auth.recordFailure(ip, email);
      await new Promise((r) => setTimeout(r, 400)); // slows down guessing
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    await auth.clearFailures(ip, email);
    const now = Date.now();
    auth.setSessionCookie(req, res, auth.issueToken(result.user.id, { iat: now, la: now }), now);
    return res.json({ success: true, redirect: homeFor(result.user) });
  } catch (err) {
    console.error('[Login]', err);
    return res.status(500).json({ error: 'Could not sign in right now. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ success: true });
});

// ---------- Everything below needs a valid session ----------
router.use(auth.requireAuth);
router.use('/admin', auth.requireSuper, adminRoutes);   // super admin only
router.use('/', workspaceRoutes);                       // publisher workspaces (role-checked inside)

app.use('/api', router);
app.use('/', router);

// Bad JSON bodies etc.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  res.status(err.status || 400).json({ error: err.message || 'Bad request' });
});

module.exports = app;
