document.addEventListener('DOMContentLoaded', async () => {
  const { api, el, initShell, formatDate, showToast } = window.Bluebee;
  initShell();

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const LABELS = {
    'post.published': 'Post published', 'post.failed': 'Post failed', 'publisher.created': 'Publisher created',
    'publisher.updated': 'Publisher updated', 'user.created': 'Member added', 'user.removed': 'Member removed',
    'user.password_reset': 'Password reset', 'account.added': 'X account added', 'account.removed': 'X account removed',
    'announcement.sent': 'Announcement sent'
  };

  const cell = (...nodes) => { const td = el('td'); nodes.forEach((n) => td.append(n)); return td; };

  try {
    const { metrics, recentPublishers, activity } = await api('/api/admin/overview');

    const cards = [
      ['Publishers', metrics.publishers, 'Workspaces'],
      ['Users', metrics.users, 'Members across workspaces'],
      ['X accounts', metrics.xAccounts, 'Connected accounts'],
      ['Posts today', metrics.postsToday, 'Publishing attempts (UTC day)'],
      ['7-day failures', metrics.failures7d, 'Needs review']
    ];
    document.getElementById('metrics').replaceChildren(...cards.map(([label, value, note]) => {
      const c = el('article', 'metric-card');
      c.append(el('span', null, label), el('strong', null, fmt(value)), el('small', null, note));
      return c;
    }));

    const rows = document.getElementById('recentRows');
    rows.replaceChildren(...recentPublishers.map((p) => {
      const tr = el('tr');
      const name = cell(el('strong', null, p.name), el('small', null, p.slug));
      tr.append(name, cell(document.createTextNode(fmt(p.usage.team))), cell(document.createTextNode(fmt(p.usage.accounts))),
        cell(document.createTextNode(fmt(p.usage.posts))), cell(el('span', `pill ${p.status}`, p.status)));
      return tr;
    }));
    document.getElementById('recentEmpty').hidden = recentPublishers.length > 0;

    const list = document.getElementById('auditList');
    list.replaceChildren(...activity.map((a) => {
      const row = el('article', a.type === 'post.failed' ? 'bad' : '');
      const body = el('div');
      body.append(el('strong', null, LABELS[a.type] || a.type), el('small', null, [a.publisherName, a.detail].filter(Boolean).join(' · ')));
      row.append(el('span'), body, el('time', null, formatDate(a.at)));
      return row;
    }));
    document.getElementById('auditEmpty').hidden = activity.length > 0;
  } catch (err) {
    showToast(`Could not load the overview. ${err.message}`, true);
  }
});
