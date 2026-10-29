document.addEventListener('DOMContentLoaded', () => {
  const { api, apiJson, el, initShell, showToast, showSecret, liveFilter } = window.Bluebee;
  initShell();

  const form = document.getElementById('publisherForm');
  const submit = document.getElementById('publisherSubmit');
  const rowsEl = document.getElementById('publisherRows');
  const search = document.getElementById('publisherSearch');
  const status = document.getElementById('publisherStatus');
  const empty = document.getElementById('publisherEmpty');
  let filterBound = false;

  function renderRow(p) {
    const tr = el('tr');
    tr.dataset.search = [p.name, p.slug, p.owner && p.owner.name, p.owner && p.owner.email, p.status].filter(Boolean).join(' ').toLowerCase();

    const nameTd = el('td');
    nameTd.append(el('strong', null, p.name), el('small', null, p.slug));

    const ownerTd = el('td');
    ownerTd.append(document.createTextNode(p.owner ? p.owner.name : '—'));
    if (p.owner) ownerTd.append(el('small', null, p.owner.email));

    const usageTd = el('td');
    usageTd.append(document.createTextNode(`${p.usage.team} team · ${p.usage.accounts}/${p.limits.xAccounts} accounts`), el('small', null, `${p.usage.posts.toLocaleString('en-US')} posts`));

    const statusTd = el('td');
    statusTd.append(el('span', `pill ${p.status}`, p.status));

    const actions = el('div', 'row-actions');
    const open = el('button', 'text-button', 'Open');
    open.type = 'button';
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const d = await apiJson(`/api/admin/publishers/${encodeURIComponent(p.id)}/open`, 'POST');
        location.href = d.redirect || '/dashboard.html';
      } catch (err) { open.disabled = false; showToast(err.message, true); }
    });
    const edit = el('a', 'text-button', 'Edit');
    edit.href = `/admin-publisher-edit.html?id=${encodeURIComponent(p.id)}`;
    actions.append(open, edit);
    const actTd = el('td');
    actTd.append(actions);

    tr.append(nameTd, ownerTd, usageTd, statusTd, actTd);
    return tr;
  }

  async function load() {
    try {
      const { publishers } = await api('/api/admin/publishers');
      document.getElementById('publisherCount').textContent = `${publishers.length} publisher${publishers.length === 1 ? '' : 's'}`;
      const rows = publishers.map(renderRow);
      rowsEl.replaceChildren(...rows);
      if (!filterBound) { filterBound = true; }
      liveFilter(search, rows, status, empty);
    } catch (err) {
      showToast(`Could not load publishers. ${err.message}`, true);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    submit.disabled = true;
    try {
      const d = await apiJson('/api/admin/publishers', 'POST', {
        name: f.get('name'), ownerName: f.get('ownerName'), ownerEmail: f.get('ownerEmail'), ownerPassword: f.get('ownerPassword')
      });
      form.reset();
      showToast(`Created ${d.publisher.name}`);
      if (d.temporaryPassword) {
        showSecret('Owner password', `Share this password with ${d.publisher.owner.email}. It is shown only once and cannot be recovered (you can reset it later from the Editors page).`, d.temporaryPassword);
      }
      load();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  load();
});
