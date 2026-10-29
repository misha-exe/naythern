document.addEventListener('DOMContentLoaded', () => {
  const { api, apiJson, el, initShell, showToast, openModal } = window.Bluebee;
  initShell();

  const form = document.getElementById('accountForm');
  const submit = document.getElementById('accountSubmit');
  const list = document.getElementById('accountList');
  const empty = document.getElementById('accountEmpty');
  const usage = document.getElementById('usageLine');

  function updateSession(a) {
    const input = el('input');
    input.type = 'password';
    input.placeholder = 'auth_token=…; ct0=…; twid=…; kdt=…';
    input.autocomplete = 'new-password';
    const label = el('label', null, 'X cookies');
    label.appendChild(input);
    openModal(`Update session for ${a.label}`, [el('p', null, 'Paste the auth_token and ct0 cookies from x.com while signed in as this account. They replace the saved session.'), label], [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Save session', kind: 'primary',
        onClick: async (close, btn) => {
          btn.disabled = true;
          try { await apiJson(`/api/accounts/${encodeURIComponent(a.id)}`, 'PATCH', { cookie: input.value }); close(); showToast('Session saved'); load(); }
          catch (err) { btn.disabled = false; showToast(err.message, true); }
        }
      }
    ]);
  }

  function confirmDelete(a) {
    openModal('Delete this X account?', [el('p', null, `“${a.label}” and its saved session will be removed, and team members lose access to it. Existing post history is kept.`)], [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Delete', kind: 'danger',
        onClick: async (close, btn) => {
          btn.disabled = true;
          try { await apiJson(`/api/accounts/${encodeURIComponent(a.id)}`, 'DELETE'); close(); showToast('Account deleted'); load(); }
          catch (err) { btn.disabled = false; showToast(err.message, true); }
        }
      }
    ]);
  }

  function renderAccount(a) {
    const row = el('article');
    row.append(el('div', 'avatar', (a.label || '?').charAt(0).toUpperCase()));
    const info = el('div');
    info.append(
      el('strong', null, a.label),
      el('small', null, [a.username ? `@${a.username}` : '', `Ads ${a.adsAccountId}`, a.hasSession ? 'Posting session saved' : 'No posting session', a.status === 'disabled' ? 'Disabled' : ''].filter(Boolean).join(' · '))
    );
    const actions = el('div', 'row-actions');
    const sess = el('button', 'text-button', a.hasSession ? 'Update session' : 'Add session');
    sess.type = 'button';
    sess.addEventListener('click', () => updateSession(a));
    const toggle = el('button', 'text-button muted', a.status === 'active' ? 'Disable' : 'Enable');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      try { await apiJson(`/api/accounts/${encodeURIComponent(a.id)}`, 'PATCH', { status: a.status === 'active' ? 'disabled' : 'active' }); load(); }
      catch (err) { showToast(err.message, true); }
    });
    const del = el('button', 'text-button danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => confirmDelete(a));
    actions.append(sess, toggle, del);
    row.append(info, actions);
    return row;
  }

  async function load() {
    try {
      const { accounts, limit } = await api('/api/accounts');
      usage.textContent = `${accounts.length} of ${limit} X account${limit === 1 ? '' : 's'} used.`;
      list.replaceChildren(...accounts.map(renderAccount));
      empty.hidden = accounts.length > 0;
      submit.disabled = accounts.length >= limit;
    } catch (err) { showToast(`Could not load accounts. ${err.message}`, true); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    submit.disabled = true;
    try {
      await apiJson('/api/accounts', 'POST', {
        label: f.get('label'), username: f.get('username'), adsAccountId: f.get('adsAccountId'), cookie: f.get('cookie')
      });
      form.reset();
      showToast('X account saved');
    } catch (err) { showToast(err.message, true); }
    load();
  });

  load();
});
