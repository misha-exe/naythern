// Loaded in <head> of every protected page. It:
//  - hides the page until the server confirms there is a valid session (no flash of private content)
//  - sends you to /login.html if the session is missing, suspended or has timed out
//  - keeps the session alive while you are actually using the page
//  - wires up the sidebar "Log out" link
//  - exposes window.bluebeeSession: a Promise of the /api/session JSON (who you are, your role, your workspace)
//    that shell.js uses to build the menu for your role.
// The real protection is server-side (every /api route checks the signed cookie and your role).
(function () {
  const root = document.documentElement;
  root.classList.add('auth-pending');   // paired with an inline <style> in each page's <head>

  let resolveSession;
  window.bluebeeSession = new Promise((resolve) => { resolveSession = resolve; });

  const nativeFetch = window.fetch.bind(window);
  let leaving = false;
  let expiryTimer = null;
  let lastPing = Date.now();
  let pingEvery = 4 * 60 * 1000;

  function goLogin(reason) {
    if (leaving) return;
    leaving = true;
    resolveSession(null);
    location.replace('/login.html' + (reason ? `?reason=${reason}` : ''));
  }

  function arm(ms) {
    clearTimeout(expiryTimer);
    if (!Number.isFinite(ms)) return;
    pingEvery = Math.max(1000, Math.min(4 * 60 * 1000, ms / 3));
    expiryTimer = setTimeout(() => goLogin('expired'), Math.max(ms, 0) + 1500);
  }

  function noteResponse(res) {
    const left = Number(res.headers.get('X-Session-Remaining-Ms'));
    if (res.headers.has('X-Session-Remaining-Ms') && Number.isFinite(left)) arm(left);
  }

  async function verify(first) {
    try {
      const res = await nativeFetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401 || res.status === 403) {
        const body = await res.json().catch(() => ({}));
        return goLogin(body.code === 'expired' ? 'expired' : body.code === 'suspended' ? 'suspended' : '');
      }
      noteResponse(res);
      if (res.ok && first) resolveSession(await res.json().catch(() => null));
    } catch (err) {
      // Offline or server hiccup: don't lock the page; the API calls will report their own errors.
      if (first) resolveSession(null);
    }
    root.classList.remove('auth-pending');
  }

  // Any app request that comes back 401 (or "suspended") means the session is gone.
  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== -1) {
      if (res.status === 401) goLogin('expired');
      else if (res.status === 403) {
        res.clone().json().then((b) => { if (b && b.code === 'suspended') goLogin('suspended'); }).catch(() => {});
      } else noteResponse(res);
    }
    return res;
  };

  function onActivity() {
    const now = Date.now();
    if (leaving || now - lastPing < pingEvery) return;
    lastPing = now;
    nativeFetch('/api/session/touch', { method: 'POST', credentials: 'same-origin' })
      .then((res) => (res.status === 401 ? goLogin('expired') : noteResponse(res)))
      .catch(() => {});
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((ev) =>
    window.addEventListener(ev, onActivity, { passive: true, capture: true })
  );

  document.addEventListener('visibilitychange', () => { if (!document.hidden) verify(false); });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      root.classList.add('auth-pending');
      verify(false);
    }
  });

  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('#logoutLink');
    if (!link) return;
    e.preventDefault();
    leaving = true;
    nativeFetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(() => {})
      .finally(() => location.replace('/login.html?reason=loggedout'));
  });

  verify(true);
})();
