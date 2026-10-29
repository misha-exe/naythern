document.addEventListener('DOMContentLoaded', () => {
  const { api, apiJson, el, initShell, showToast, showSecret, liveFilter, openModal } = window.Bluebee;
  initShell();

  const rowsEl = document.getElementById('editorRows');
  const search = document.getElementById('editorSearch');
  const statusEl = document.getElementById('editorStatus');
  const empty = document.getElementById('editorEmpty');

  function resetPassword(person) {
    const input = el('input');
    input.type = 'password';
    input.placeholder = 'Leave blank to generate one';
    input.autocomplete = 'new-password';
    const label = el('label', null, 'New password (optional)');
    label.appendChild(input);
    openModal(`Reset password for ${person.name}`, [el('p', null, 'Set a new password, or leave it blank to generate a strong one. Their current password stops working immediately.'), label], [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Reset password', kind: 'primary',
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            const d = await apiJson(`/api/admin/editors/${encodeURIComponent(person.id)}/password`, 'POST', { password: input.value });
            close();
            if (d.temporaryPassword) showSecret('New password', `Give this to ${person.email}. It is shown only once.`, d.temporaryPassword);
            else showToast('Password updated');
          } catch (err) { btn.disabled = false; showToast(err.message, true); }
        }
      }
    ]);
  }

  function renderRow(p) {
    const tr = el('tr');
    tr.dataset.search = [p.name, p.email, p.publisherName, p.role, p.status].join(' ').toLowerCase();
    const who = el('td'); who.append(el('strong', null, p.name), el('small', null, p.email));
    const ws = el('td', null, p.publisherName);
    const role = el('td'); role.append(el('span', `pill ${p.role === 'owner' ? 'owner' : ''}`, p.role));
    const st = el('td'); st.append(el('span', `pill ${p.status}`, p.status));

    const actions = el('div', 'row-actions');
    const reset = el('button', 'text-button', 'Change password');
    reset.type = 'button';
    reset.addEventListener('click', () => resetPassword(p));
    const toggle = el('button', `text-button ${p.status === 'active' ? 'danger' : ''}`, p.status === 'active' ? 'Disable' : 'Enable');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await apiJson(`/api/admin/editors/${encodeURIComponent(p.id)}`, 'PATCH', { status: p.status === 'active' ? 'disabled' : 'active' });
        load();
      } catch (err) { toggle.disabled = false; showToast(err.message, true); }
    });
    actions.append(reset, toggle);
    const act = el('td'); act.append(actions);
    tr.append(who, ws, role, st, act);
    return tr;
  }

  async function load() {
    try {
      const { editors } = await api('/api/admin/editors');
      document.getElementById('editorCount').textContent = `${editors.length} editor${editors.length === 1 ? '' : 's'}`;
      const rows = editors.map(renderRow);
      rowsEl.replaceChildren(...rows);
      liveFilter(search, rows, statusEl, empty);
    } catch (err) { showToast(`Could not load editors. ${err.message}`, true); }
  }
  load();
});
