// shell.js - builds the sidebar for WHO is signed in and keeps people on pages they may use.
//
//   super admin        -> Platform: Overview, Publishers, Editors, Announcements
//                         (+ Workspace section while they have a publisher's workspace open)
//   owner              -> Dashboard, Composer, Posts, X Accounts, Team
//   editor             -> Dashboard, Composer, Posts
//   viewer             -> Dashboard, Posts
//
// Also shows: the "viewing workspace" bar for the super admin, and announcements for everyone else.
// Hiding links is only convenience; every API route enforces the same rules on the server.
(function () {
  window.Bluebee = window.Bluebee || {};

  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  };
  const norm = (p) => (p === '/index.html' ? '/' : p);

  function requirementFor(path) {
    if (path.startsWith('/admin-')) return 'super';
    if (path === '/') return 'post';
    if (path === '/accounts.html' || path === '/team.html') return 'manage';
    if (path === '/dashboard.html' || path === '/posts.html') return 'workspace';
    return null;
  }

  function allowed(s, need) {
    const inWs = !!s.publisher;
    if (need === 'super') return s.isSuper;
    if (need === 'workspace') return inWs;
    if (need === 'post') return inWs && ['owner', 'editor'].includes(s.role);
    if (need === 'manage') return inWs && s.role === 'owner';
    return true;
  }

  function navSection(title, items) {
    const wrap = el('div', 'nav-section');
    wrap.appendChild(el('span', null, title));
    const here = norm(location.pathname);
    items.forEach(([label, href, icon]) => {
      const a = el('a');
      a.href = href;
      if (norm(href) === here) { a.className = 'active'; a.setAttribute('aria-current', 'page'); }
      a.appendChild(el('b', 'nav-icon', icon));
      a.appendChild(document.createTextNode(label));
      wrap.appendChild(a);
    });
    return wrap;
  }

  function renderSidebar(s) {
    const nav = document.querySelector('.sidebar-nav');
    if (nav) {
      nav.replaceChildren();
      if (s.isSuper) {
        nav.appendChild(navSection('Platform', [
          ['Overview', '/admin-dashboard.html', '⌂'],
          ['Publishers', '/admin-publishers.html', '▦'],
          ['Editors', '/admin-editors.html', '♙'],
          ['Announcements', '/admin-announcements.html', '◉']
        ]));
      }
      if (s.publisher) {
        const items = [['Dashboard', '/dashboard.html', '⌂']];
        if (['owner', 'editor'].includes(s.role)) items.push(['Composer', '/', '＋']);
        items.push(['Posts', '/posts.html', '≡']);
        if (s.role === 'owner') items.push(['X Accounts', '/accounts.html', '𝕏'], ['Team', '/team.html', '♙']);
        nav.appendChild(navSection(s.isSuper ? 'Workspace' : s.publisher.name, items));
      }
    }

    const box = document.querySelector('.sidebar-user');
    if (box) {
      box.replaceChildren();
      box.appendChild(el('div', 'user-avatar', (s.user.name || '?').trim().charAt(0).toUpperCase()));
      const who = el('div');
      who.appendChild(el('strong', null, s.user.name));
      const roleText = s.isSuper ? 'Platform administrator' : ({ owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }[s.role] || s.role);
      who.appendChild(el('small', null, roleText));
      box.appendChild(who);
      const out = el('a', null, '↗');
      out.href = '#';
      out.id = 'logoutLink';
      out.title = 'Log out';
      out.setAttribute('aria-label', 'Log out');
      box.appendChild(out);
    }
  }

  function topOfMain() {
    return document.querySelector('main.content-shell');
  }

  // Super admin inside a workspace: a clear bar with a way back.
  function renderWorkspaceBar(s) {
    const main = topOfMain();
    if (!main || !s.isSuper || !s.publisher) return;
    const bar = el('div', 'workspace-bar');
    const text = el('span');
    text.appendChild(document.createTextNode('Viewing workspace '));
    text.appendChild(el('strong', null, s.publisher.name));
    text.appendChild(document.createTextNode(' as administrator'));
    const exit = el('button', 'button secondary small', 'Exit workspace');
    exit.type = 'button';
    exit.addEventListener('click', async () => {
      exit.disabled = true;
      try {
        const res = await fetch('/api/admin/exit-workspace', { method: 'POST' });
        const d = await res.json();
        location.href = d.redirect || '/admin-dashboard.html';
      } catch { exit.disabled = false; }
    });
    bar.append(text, exit);
    main.insertBefore(bar, main.firstChild);
  }

  function countdownText(endsAt) {
    const ms = new Date(endsAt).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'Countdown ended';
    const t = Math.floor(ms / 1000);
    const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${d ? d + 'd ' : ''}${h}h ${m}m ${sec}s left`;
  }

  async function renderAnnouncements(s) {
    const main = topOfMain();
    if (!main || s.isSuper || !s.publisher) return;
    let list = [];
    try {
      const res = await fetch('/api/announcements', { cache: 'no-store' });
      if (res.ok) list = (await res.json()).announcements || [];
    } catch { return; }
    if (!list.length) return;

    const wrap = el('div', 'announce-list');
    list.forEach((a) => {
      const card = el('article', 'announce-card');
      const body = el('div');
      body.appendChild(el('strong', null, a.title));
      body.appendChild(el('p', null, a.message));
      if (a.countdownEndsAt) {
        const t = el('small', 'announce-timer', countdownText(a.countdownEndsAt));
        body.appendChild(t);
        const id = setInterval(() => { t.textContent = countdownText(a.countdownEndsAt); }, 1000);
        card.addEventListener('remove', () => clearInterval(id));
      }
      const x = el('button', 'announce-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Dismiss announcement');
      x.addEventListener('click', () => {
        card.remove();
        fetch(`/api/announcements/${encodeURIComponent(a.id)}/dismiss`, { method: 'POST' }).catch(() => {});
      });
      card.append(body, x);
      wrap.appendChild(card);
    });
    const anchor = main.querySelector('.workspace-bar');
    main.insertBefore(wrap, anchor ? anchor.nextSibling : main.firstChild);
  }

  async function start() {
    if (!window.bluebeeSession) return;
    const s = await window.bluebeeSession;
    if (!s) return;
    window.Bluebee.session = s;

    if (!allowed(s, requirementFor(norm(location.pathname)))) {
      document.documentElement.classList.add('auth-pending');
      location.replace(s.home || '/');
      return;
    }
    renderSidebar(s);
    renderWorkspaceBar(s);
    renderAnnouncements(s);
    document.dispatchEvent(new CustomEvent('bluebee:session', { detail: s }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
