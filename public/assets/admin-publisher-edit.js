document.addEventListener('DOMContentLoaded', async () => {
  const { api, apiJson, initShell, showToast } = window.Bluebee;
  initShell();

  const id = new URLSearchParams(location.search).get('id');
  const form = document.getElementById('editForm');
  const saveBtn = document.getElementById('saveBtn');
  if (!id) { location.replace('/admin-publishers.html'); return; }

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  function fill(p, defaults) {
    document.getElementById('pubTitle').textContent = p.name;
    form.elements.name.value = p.name;
    form.elements.status.value = p.status;
    const o = p.overrides || {};
    form.elements.monthlyPosts.value = o.monthlyPosts || '';
    form.elements.xAccounts.value = o.xAccounts || '';
    form.elements.teamMembers.value = o.teamMembers || '';
    form.elements.monthlyPosts.placeholder = `${fmt(defaults.monthlyPosts)} plan default`;
    form.elements.xAccounts.placeholder = `${defaults.xAccounts} plan default`;
    form.elements.teamMembers.placeholder = `${defaults.teamMembers} plan default`;
    if (p.usage) {
      document.getElementById('useTeam').textContent = `${p.usage.team} / ${p.limits.teamMembers}`;
      document.getElementById('useAccounts').textContent = `${p.usage.accounts} / ${p.limits.xAccounts}`;
      document.getElementById('useMonth').textContent = `${fmt(p.usage.monthPosts)} / ${fmt(p.limits.monthlyPosts)}`;
      document.getElementById('useTotal').textContent = fmt(p.usage.posts);
    }
    document.getElementById('ownerLine').textContent = p.owner ? `${p.owner.name} · ${p.owner.email}` : '—';
    document.getElementById('slugLine').textContent = p.slug;
  }

  let defaults = {};
  try {
    const d = await api(`/api/admin/publishers/${encodeURIComponent(id)}`);
    defaults = d.defaults;
    fill(d.publisher, defaults);
  } catch (err) {
    showToast(err.message, true);
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      await apiJson(`/api/admin/publishers/${encodeURIComponent(id)}`, 'PATCH', {
        name: form.elements.name.value,
        status: form.elements.status.value,
        limits: {
          monthlyPosts: form.elements.monthlyPosts.value,
          xAccounts: form.elements.xAccounts.value,
          teamMembers: form.elements.teamMembers.value
        }
      });
      showToast('Publisher saved');
      const d = await api(`/api/admin/publishers/${encodeURIComponent(id)}`);
      fill(d.publisher, d.defaults);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  document.getElementById('openBtn').addEventListener('click', async () => {
    try {
      const d = await apiJson(`/api/admin/publishers/${encodeURIComponent(id)}/open`, 'POST');
      location.href = d.redirect || '/dashboard.html';
    } catch (err) { showToast(err.message, true); }
  });
});
