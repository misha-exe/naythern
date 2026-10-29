// Shared helpers for the Dashboard and Posts pages.
(function () {
  let toastTimer = null;

  function initShell() {
    const open = () => document.body.classList.add('nav-open');
    const close = () => document.body.classList.remove('nav-open');
    const t = document.getElementById('menuToggle');
    const c = document.getElementById('sidebarClose');
    const o = document.getElementById('sidebarOverlay');
    if (t) t.addEventListener('click', open);
    if (c) c.addEventListener('click', close);
    if (o) o.addEventListener('click', close);
  }

  function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast show ${isError ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 5000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error(`Server status ${res.status}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    return data;
  }

  // e.g. "Oct 23, 2026 10:05 PM" (in the viewer's own timezone)
  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${date} ${time}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;   // textContent only: headlines/errors are never parsed as HTML
    return node;
  }

  // One history entry. detailed=false is the compact dashboard row; detailed=true adds text, URL, error, actions.
  function buildPostItem(post, { detailed = false } = {}) {
    const published = post.status === 'published';
    const li = el('li', 'activity-item');
    li.dataset.id = post.id;

    li.appendChild(el('div', `status-icon ${published ? 'published' : 'failed'}`, published ? '✓' : '!'));

    const body = el('div', 'activity-body');
    body.appendChild(el('div', 'activity-title', post.headline || 'Untitled post'));
    body.appendChild(el('div', 'activity-meta', `${post.accountLabel || 'Account'} · ${formatDate(post.createdAt)}`));

    if (detailed) {
      if (post.postText) body.appendChild(el('p', 'post-text', post.postText));
      if (post.websiteUrl) body.appendChild(el('p', 'post-url', post.websiteUrl));
      if (!published && post.error) body.appendChild(el('p', 'post-error', post.error));
    }

    const foot = el('div', 'post-foot');
    foot.appendChild(el('span', `badge ${published ? 'published' : 'failed'}`, published ? 'Published' : 'Failed'));
    if (detailed) {
      if (published && post.postUrl) {
        const a = el('a', 'post-link', 'View Post');
        a.href = post.postUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        foot.appendChild(a);
      }
      const del = el('button', 'button danger small', 'Delete');
      del.type = 'button';
      del.dataset.delete = post.id;
      del.setAttribute('aria-label', `Delete history entry: ${post.headline || 'Untitled post'}`);
      foot.appendChild(del);
    }
    body.appendChild(foot);
    li.appendChild(body);
    return li;
  }

  // JSON request helper: apiJson('/api/team', 'POST', { ... })
  function apiJson(path, method = 'POST', body) {
    return api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  // Live "type to filter" for tables/lists. rows: elements carrying data-search="lowercase text".
  function liveFilter(input, rows, statusEl, emptyEl) {
    const run = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((r) => {
        const hit = !q || (r.dataset.search || '').includes(q);
        r.hidden = !hit;
        if (hit) shown += 1;
      });
      if (statusEl) statusEl.textContent = `${shown} of ${rows.length} results`;
      if (emptyEl) emptyEl.hidden = shown > 0 || rows.length === 0;
    };
    input.addEventListener('input', run);
    run();
  }

  // Modal built from DOM nodes. content: array of nodes. Resolves nothing; use the returned close().
  function openModal(title, content, actions) {
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.appendChild(el('h3', null, title));
    content.forEach((n) => modal.appendChild(n));
    const bar = el('div', 'modal-actions');
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    actions.forEach((a) => {
      const b = el('button', `button ${a.kind || 'secondary'}`, a.label);
      b.type = 'button';
      b.addEventListener('click', () => a.onClick(close, b));
      bar.appendChild(b);
    });
    modal.appendChild(bar);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    return close;
  }

  // Shows a generated password exactly once, with a copy button.
  function showSecret(title, intro, secret) {
    const box = el('code', 'secret-box', secret);
    const copy = el('button', 'button secondary small', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(secret); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; }
    });
    openModal(title, [el('p', null, intro), box, copy], [{ label: 'Done', kind: 'primary', onClick: (close) => close() }]);
  }

  window.Bluebee = Object.assign(window.Bluebee || {}, { initShell, showToast, api, apiJson, formatDate, el, buildPostItem, liveFilter, openModal, showSecret });
})();
