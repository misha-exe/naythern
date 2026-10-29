document.addEventListener('DOMContentLoaded', () => {
  let accounts = [];            // X accounts this user may post with (from /api/me/accounts)
  let currentAccountId = '';    // the account chosen in the dropdown: uploads, library and publishing all use it
  let mediaList = [];
  let selectedMediaItem = null;

  const postText = document.getElementById('postText');
  const postCount = document.getElementById('postCount');
  const headline = document.getElementById('headline');
  const headlineCount = document.getElementById('headlineCount');
  const websiteUrl = document.getElementById('websiteUrl');
  const websiteUrlError = document.getElementById('websiteUrlError');
  const selectedMediaContainer = document.getElementById('selectedMedia');
  const selectedCount = document.getElementById('selectedCount');
  const publishBtn = document.getElementById('publishBtn');

  const uploadProgress = document.getElementById('uploadProgress');
  const uploadStatus = document.getElementById('uploadStatus');
  const videoFile = document.getElementById('videoFile');
  const uploadVideoBtn = document.getElementById('uploadVideoBtn');
  const videoUrl = document.getElementById('videoUrl');
  const uploadUrlBtn = document.getElementById('uploadUrlBtn');
  const mediaGrid = document.getElementById('mediaGrid');
  const mediaSearch = document.getElementById('mediaSearch');
  const refreshBtn = document.getElementById('refreshBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const accountSelect = document.getElementById('accountSelect');
  // NOTE: mediaSearch / searchBtn are intentionally never locked.

  let uploading = false;
  let toastTimer = null;

  const toast = document.getElementById('toast');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarClose = document.getElementById('sidebarClose');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  async function parseResponse(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      return data;
    }
    const htmlText = await res.text();
    throw new Error(`Server status ${res.status}: ${htmlText.replace(/<[^>]*>/g, '').trim().substring(0, 100)}`);
  }

  const jsonHeaders = { 'Content-Type': 'application/json' };

  // ---- Upload progress ----
  const defaultStatus = uploadStatus.textContent;
  let shownPercent = 0;
  let hideTimer = null;

  const newUploadId = () => 'up_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  function startProgress() {
    clearTimeout(hideTimer);
    shownPercent = 0;
    uploadProgress.removeAttribute('value');
    uploadProgress.hidden = false;
    uploadStatus.textContent = 'Starting upload…';
  }

  function applyProgress(status, percent) {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < shownPercent) return;
    shownPercent = pct;
    uploadProgress.hidden = false;
    uploadProgress.value = pct;
    if (status) uploadStatus.textContent = status;
  }

  function finishProgress(success) {
    clearTimeout(hideTimer);
    if (success) {
      applyProgress('Video added to the Ads Media Library and selected', 100);
      hideTimer = setTimeout(resetProgress, 1500);
    } else {
      resetProgress();
    }
  }

  function resetProgress() {
    uploadProgress.hidden = true;
    uploadProgress.value = 0;
    uploadStatus.textContent = defaultStatus;
    shownPercent = 0;
  }

  function pollProgress(uploadId) {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/upload-progress/${encodeURIComponent(uploadId)}`, { cache: 'no-store' });
        if (res.ok && !stopped) {
          const d = await res.json();
          if (d && d.status) applyProgress(d.status, d.percent);
        }
      } catch { /* a missed poll is harmless */ }
      if (!stopped) timer = setTimeout(tick, 700);
    };
    timer = setTimeout(tick, 400);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  function showToast(msg, isError = false, link = null) {
    toast.textContent = msg;
    if (link && link.href) {
      toast.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.text || 'View Post';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      toast.appendChild(a);
    }
    toast.className = `toast show ${isError ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, link ? 10000 : 5000);
  }

  function setUploading(flag) {
    uploading = flag;
    [accountSelect, postText, websiteUrl, headline, videoFile, uploadVideoBtn, videoUrl, uploadUrlBtn, refreshBtn, loadMoreBtn]
      .forEach((el) => { if (el) el.disabled = flag; });
    const clearBtn = document.getElementById('clearSelected');
    if (clearBtn) clearBtn.disabled = flag;
    mediaGrid.querySelectorAll('button').forEach((b) => { b.disabled = flag; });
    document.body.classList.toggle('is-uploading', flag);
    validateForm();
  }

  postText.addEventListener('input', () => {
    postCount.textContent = `${postText.value.length}/280`;
    validateForm();
  });

  headline.addEventListener('input', () => {
    headlineCount.textContent = `${headline.value.length}/70`;
    validateForm();
  });

  // ---- Website URL validation ----
  const isPublishableUrl = (v) => /^https?:\/\/[^\s/?#]+/i.test(v);
  function urlNeedsError(v) {
    if (!v || /^https?:\/\//i.test(v)) return false;
    const lower = v.toLowerCase();
    return !['http://', 'https://'].some((p) => p.startsWith(lower));
  }
  function updateUrlError() {
    const show = urlNeedsError(websiteUrl.value.trim());
    websiteUrlError.hidden = !show;
    websiteUrl.classList.toggle('invalid', show);
    websiteUrl.setAttribute('aria-invalid', show ? 'true' : 'false');
  }
  websiteUrl.addEventListener('input', () => { updateUrlError(); validateForm(); });

  function validateForm() {
    const isValid = isPublishableUrl(websiteUrl.value.trim()) && headline.value.trim() && selectedMediaItem && currentAccountId;
    publishBtn.disabled = uploading || !isValid;
  }

  // ---- X account dropdown (this is how you switch between your accounts) ----
  async function loadAccounts() {
    try {
      const data = await parseResponse(await fetch('/api/me/accounts', { cache: 'no-store' }));
      accounts = data.accounts || [];
    } catch (err) {
      showToast(`Could not load your X accounts. ${err.message}`, true);
      accounts = [];
    }

    accountSelect.replaceChildren();
    if (!accounts.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No X account assigned to you yet';
      accountSelect.appendChild(o);
      accountSelect.disabled = true;
      [videoFile, uploadVideoBtn, videoUrl, uploadUrlBtn, refreshBtn].forEach((el) => { if (el) el.disabled = true; });
      uploadStatus.textContent = 'Ask the workspace owner to give you access to an X account.';
      validateForm();
      return;
    }

    accounts.forEach((a) => {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = `${a.label} · ${a.adsAccountId}${a.hasSession ? '' : ' (no posting session)'}`;
      accountSelect.appendChild(o);
    });
    let last = '';
    try { last = localStorage.getItem('bluebee_last_account') || ''; } catch { /* ignore */ }
    currentAccountId = accounts.some((a) => a.id === last) ? last : accounts[0].id;
    accountSelect.value = currentAccountId;
    await loadMedia();
  }

  accountSelect.addEventListener('change', () => {
    if (uploading) { accountSelect.value = currentAccountId; return; }
    currentAccountId = accountSelect.value;
    try { localStorage.setItem('bluebee_last_account', currentAccountId); } catch { /* ignore */ }
    // The library belongs to the account, so switching accounts clears the selection and reloads the library.
    selectedMediaItem = null;
    selectedCount.textContent = 'None selected';
    selectedMediaContainer.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Select one compatible square video.' }));
    mediaList = [];
    renderMediaGrid();
    validateForm();
    loadMedia();
  });

  // ---- Media library (per account) ----
  async function loadMedia() {
    if (!currentAccountId) return;
    const asking = currentAccountId;
    try {
      const res = await fetch(`/api/media?accountId=${encodeURIComponent(asking)}`, { cache: 'no-store' });
      const items = await parseResponse(res);
      if (asking !== currentAccountId) return;   // the user switched accounts while this was loading
      mediaList = items;
      renderMediaGrid();
    } catch (err) {
      console.warn('Could not load the media library:', err.message);
      showToast(`Could not load the media library. ${err.message}`, true);
    }
  }

  function mediaCard(item) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `media-card ${selectedMediaItem && selectedMediaItem.mediaId === item.mediaId ? 'selected' : ''}`;
    btn.disabled = uploading;

    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = item.name;
    const play = Object.assign(document.createElement('span'), { className: 'play', textContent: '▶' });
    const meta = Object.assign(document.createElement('span'), { className: 'media-meta' });
    meta.appendChild(Object.assign(document.createElement('strong'), { textContent: item.name }));
    meta.appendChild(Object.assign(document.createElement('small'), { textContent: item.meta || 'Square · 800x800' }));
    btn.append(img, play, meta);
    btn.addEventListener('click', () => selectMedia(item));
    return btn;
  }

  function renderMediaGrid() {
    const q = mediaSearch ? mediaSearch.value.trim().toLowerCase() : '';
    mediaGrid.replaceChildren(...mediaList.filter((m) => !q || m.name.toLowerCase().includes(q)).map(mediaCard));
  }
  if (mediaSearch) mediaSearch.addEventListener('input', renderMediaGrid);

  function selectMedia(item) {
    selectedMediaItem = item;
    selectedCount.textContent = '1 selected';

    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = item.name;
    const info = document.createElement('div');
    info.appendChild(Object.assign(document.createElement('strong'), { textContent: item.name }));
    info.appendChild(Object.assign(document.createElement('small'), { textContent: item.meta || 'Square · 800x800' }));
    const clear = Object.assign(document.createElement('button'), { type: 'button', id: 'clearSelected', textContent: '×' });
    clear.disabled = uploading;
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedMediaItem = null;
      selectedCount.textContent = 'None selected';
      selectedMediaContainer.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Select one compatible square video.' }));
      renderMediaGrid();
      validateForm();
    });
    selectedMediaContainer.replaceChildren(img, info, clear);

    renderMediaGrid();
    validateForm();
  }

  async function runUpload(uploadId, doRequest) {
    if (uploading) return;
    const uploadAccount = currentAccountId;
    setUploading(true);
    startProgress();
    const poller = pollProgress(uploadId);
    try {
      const data = await doRequest();
      if (uploadAccount === currentAccountId) {
        mediaList.unshift(data.media);
        renderMediaGrid();
        selectMedia(data.media);
      }
      poller.stop();
      finishProgress(true);
      videoUrl.value = '';
      videoFile.value = '';
      setUploading(false);
      showToast('Video added to the Ads Media Library and selected');
    } catch (err) {
      poller.stop();
      finishProgress(false);
      setUploading(false);
      showToast(err.message, true);
    }
  }

  uploadUrlBtn.addEventListener('click', () => {
    const url = videoUrl.value.trim();
    if (!url) return showToast('Enter a valid video URL', true);
    if (!currentAccountId) return showToast('Choose an X account first', true);

    const uploadId = newUploadId();
    runUpload(uploadId, async () => {
      const res = await fetch('/api/upload-url', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ videoUrl: url, clientId: uploadId, accountId: currentAccountId })
      });
      return parseResponse(res);
    });
  });

  uploadVideoBtn.addEventListener('click', () => {
    const file = videoFile.files[0];
    if (!file) return showToast('Select a video file to upload', true);
    if (!currentAccountId) return showToast('Choose an X account first', true);

    const uploadId = newUploadId();
    const formData = new FormData();
    formData.append('clientId', uploadId);
    formData.append('accountId', currentAccountId);
    formData.append('video', file);   // the file goes last so the text fields are read first

    runUpload(uploadId, async () => {
      const res = await fetch('/api/upload-file', { method: 'POST', body: formData });
      return parseResponse(res);
    });
  });

  // ---- Publish (always with the account chosen in the dropdown) ----
  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    publishBtn.textContent = 'Posting...';

    try {
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          accountId: currentAccountId,
          postText: postText.value,
          websiteUrl: websiteUrl.value,
          headline: headline.value,
          mediaId: selectedMediaItem.mediaId
        })
      });

      const data = await parseResponse(res);
      const link = data.postUrl ? { href: data.postUrl, text: 'View Post' } : null;
      showToast(data.message || 'Website Card posted successfully!', false, link);

      // Clear ONLY the post text and the selected media. Headline and website URL stay for the next post.
      postText.value = '';
      postCount.textContent = '0/280';
      selectedMediaItem = null;
      selectedCount.textContent = 'None selected';
      selectedMediaContainer.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Select one compatible square video.' }));
      renderMediaGrid();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      publishBtn.disabled = false;
      publishBtn.textContent = 'Post Website Card';
      validateForm();
    }
  });

  if (menuToggle) menuToggle.addEventListener('click', () => document.body.classList.add('nav-open'));
  if (sidebarClose) sidebarClose.addEventListener('click', () => document.body.classList.remove('nav-open'));
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', () => document.body.classList.remove('nav-open'));
  refreshBtn.addEventListener('click', loadMedia);

  loadAccounts();
});
