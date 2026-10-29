document.addEventListener('DOMContentLoaded', () => {
  const { api, apiJson, el, initShell, showToast, formatDate } = window.Bluebee;
  initShell();

  const form = document.getElementById('announceForm');
  const submit = document.getElementById('announceSubmit');
  const hasCountdown = document.getElementById('hasCountdown');
  const countdownFields = document.getElementById('countdownFields');
  const recipientList = document.getElementById('recipientList');
  const list = document.getElementById('announceList');
  const empty = document.getElementById('announceEmpty');

  hasCountdown.addEventListener('change', () => { countdownFields.hidden = !hasCountdown.checked; });
  form.querySelectorAll('input[name="audience"]').forEach((r) =>
    r.addEventListener('change', () => { recipientList.hidden = form.elements.audience.value !== 'selected'; })
  );

  async function load() {
    try {
      const { announcements, recipients } = await api('/api/admin/announcements');
      document.getElementById('allCount').textContent = `All ${recipients.length} active member${recipients.length === 1 ? '' : 's'}.`;

      recipientList.replaceChildren(...recipients.map((r) => {
        const label = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.name = 'recipient';
        box.value = r.id;
        const span = el('span');
        span.append(el('strong', null, r.name), el('small', null, `${r.email} · ${r.publisherName}`));
        label.append(box, span);
        return label;
      }));

      list.replaceChildren(...announcements.map((a) => {
        const row = el('article');
        const body = el('div');
        body.append(el('strong', null, a.title), el('small', null, `${a.audience === 'all' ? 'Everyone' : `${a.userIds.length} selected`}${a.countdownEndsAt ? ' · countdown' : ''}`));
        const del = el('button', 'text-button danger', 'Delete');
        del.type = 'button';
        del.addEventListener('click', async () => {
          del.disabled = true;
          try { await apiJson(`/api/admin/announcements/${encodeURIComponent(a.id)}`, 'DELETE'); load(); }
          catch (err) { del.disabled = false; showToast(err.message, true); }
        });
        row.append(el('span'), body, el('time', null, formatDate(a.createdAt)), del);
        return row;
      }));
      empty.hidden = announcements.length > 0;
    } catch (err) { showToast(`Could not load announcements. ${err.message}`, true); }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const audience = form.elements.audience.value;
    const userIds = [...recipientList.querySelectorAll('input:checked')].map((b) => b.value);
    if (audience === 'selected' && !userIds.length) return showToast('Choose at least one recipient.', true);

    let countdownEndsAt = null;
    if (hasCountdown.checked) {
      const raw = document.getElementById('countdownEndsAt').value;
      if (!raw) return showToast('Pick when the countdown ends.', true);
      const d = new Date(raw);
      if (d.getTime() <= Date.now()) return showToast('The countdown must end in the future.', true);
      countdownEndsAt = d.toISOString();
    }

    submit.disabled = true;
    try {
      await apiJson('/api/admin/announcements', 'POST', {
        title: form.elements.title.value, message: form.elements.message.value, audience, userIds, countdownEndsAt
      });
      form.reset();
      countdownFields.hidden = true;
      recipientList.hidden = true;
      showToast('Announcement sent');
      load();
    } catch (err) { showToast(err.message, true); }
    finally { submit.disabled = false; }
  });

  load();
});
