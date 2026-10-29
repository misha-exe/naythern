document.addEventListener('DOMContentLoaded', () => {
  const { api, apiJson, el, initShell, showToast, openModal, formatDate } = window.Bluebee;
  initShell();

  const form = document.getElementById('memberForm');
  const submit = document.getElementById('memberSubmit');
  const roleSelect = document.getElementById('memberRole');
  const accessBox = document.getElementById('memberAccessBox');
  const accountBox = document.getElementById('memberAccounts');
  const rowsEl = document.getElementById('memberRows');
  let accounts = [];
  let limit = 0;

  // A checkbox list of the workspace's X accounts. `selected` = ids pre-ticked.
  function accountChecks(selected = []) {
    if (!accounts.length) return [el('p', null, 'Add an X account first (X Accounts page), then give editors access to it.')];
    return accounts.map((a) => {
      const label = el('label');
      const box = el('input');
      box.type = 'checkbox';
      box.value = a.id;
      box.checked = selected.includes(a.id);
      const span = el('span');
      span.append(el('strong', null, a.label), el('small', null, a.username ? `@${a.username}` : `Ads ${a.adsAccountId}`));
      label.append(box, span);
      return label;
    });
  }
  const ticked = (container) => [...container.querySelectorAll('input[type=checkbox]:checked')].map((b) => b.value);

  roleSelect.addEventListener('change', () => { accessBox.hidden = roleSelect.value !== 'editor'; });

  function accountNames(ids) {
    return ids.map((id) => (accounts.find((a) => a.id === id) || {}).label).filter(Boolean).join(', ');
  }

  function editMember(m) {
    const role = el('select');
    [['editor', 'Editor'], ['viewer', 'Viewer']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; role.appendChild(o); });
    role.value = m.role;
    const roleLabel = el('label', null, 'Role'); roleLabel.appendChild(role);

    const status = el('select');
    [['active', 'Active'], ['disabled', 'Disabled']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; status.appendChild(o); });
    status.value = m.status;
    const statusLabel = el('label', null, 'Status'); statusLabel.appendChild(status);

    const checks = el('div', 'check-list');
    checks.append(...accountChecks(m.accountIds));
    const box = el('fieldset', 'account-access');
    box.append(el('legend', null, 'X account access'), checks);
    const syncBox = () => { box.hidden = role.value !== 'editor'; };
    role.addEventListener('change', syncBox);
    syncBox();

    const pw = el('input'); pw.type = 'password'; pw.autocomplete = 'new-password'; pw.placeholder = 'Leave blank to keep the current password';
    const pwLabel = el('label', null, 'New password (optional)'); pwLabel.appendChild(pw);

    openModal(`Edit ${m.name}`, [roleLabel, box, statusLabel, pwLabel], [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Save', kind: 'primary',
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            const body = { role: role.value, status: status.value, accountIds: role.value === 'editor' ? ticked(checks) : [] };
            if (pw.value) body.password = pw.value;
            await apiJson(`/api/team/${encodeURIComponent(m.id)}`, 'PATCH', body);
            close(); showToast('Member saved'); load();
          } catch (err) { btn.disabled = false; showToast(err.message, true); }
        }
      }
    ]);
  }

  function removeMember(m) {
    openModal('Remove this member?', [el('p', null, `${m.name} will no longer be able to sign in. Posts they made stay in the history.`)], [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Remove', kind: 'danger',
        onClick: async (close, btn) => {
          btn.disabled = true;
          try { await apiJson(`/api/team/${encodeURIComponent(m.id)}`, 'DELETE'); close(); showToast('Member removed'); load(); }
          catch (err) { btn.disabled = false; showToast(err.message, true); }
        }
      }
    ]);
  }

  function renderRow(m) {
    const tr = el('tr');
    const who = el('td'); who.append(el('strong', null, m.name), el('small', null, m.email));
    const access = el('td');
    access.append(document.createTextNode(m.role === 'owner' ? 'Owner' : m.role === 'editor' ? 'Editor' : 'Viewer'));
    if (m.role === 'editor') access.append(el('small', null, accountNames(m.accountIds) || 'No accounts assigned'));
    const st = el('td'); st.append(el('span', `pill ${m.status}`, m.status));
    const act = el('td');
    if (m.role !== 'owner') {
      const actions = el('div', 'row-actions');
      const edit = el('button', 'text-button', 'Edit'); edit.type = 'button'; edit.addEventListener('click', () => editMember(m));
      const rm = el('button', 'text-button muted', 'Remove'); rm.type = 'button'; rm.addEventListener('click', () => removeMember(m));
      actions.append(edit, rm);
      act.append(actions);
    }
    tr.append(who, access, st, act);
    return tr;
  }

  async function load() {
    try {
      const data = await api('/api/team');
      accounts = data.accounts;
      limit = data.limit;
      document.getElementById('teamSubtitle').textContent = `${data.members.length} of ${limit} team members used. Choose which X accounts each editor can post from.`;
      accountBox.replaceChildren(...accountChecks([]));
      rowsEl.replaceChildren(...data.members.map(renderRow));
    } catch (err) { showToast(`Could not load the team. ${err.message}`, true); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    if (f.get('password') !== f.get('confirm')) return showToast('The passwords do not match.', true);
    submit.disabled = true;
    try {
      await apiJson('/api/team', 'POST', {
        name: f.get('name'), email: f.get('email'), role: f.get('role'), password: f.get('password'),
        accountIds: f.get('role') === 'editor' ? ticked(accountBox) : []
      });
      form.reset();
      accessBox.hidden = false;
      showToast('Member created');
      load();
    } catch (err) { showToast(err.message, true); }
    finally { submit.disabled = false; }
  });

  load();
});
