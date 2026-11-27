/* global Hls */
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const tpl = document.getElementById('tile-template');
const dialog = document.getElementById('cam-dialog');
const camForm = document.getElementById('cam-form');
const camError = document.getElementById('cam-error');
const testResult = document.getElementById('cam-test-result');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const tiles = new Map(); // id -> { el, player, camera }
let editingId = null;

// Can this browser decode H.265 (what Reolink 4K main streams use)?
const HEVC_CODEC = 'video/mp4; codecs="hvc1.1.6.L153.B0"';
const PLAYS_HEVC = Boolean(
  (window.MediaSource && MediaSource.isTypeSupported(HEVC_CODEC))
  || document.createElement('video').canPlayType(HEVC_CODEC),
);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const gridSrc = (id) => `/streams/${id}_grid/index.m3u8`;

// ---------- HLS player ----------
// Plays `src` in `video`; returns a function that tears the player down.
function play(video, src) {
  let hls = null;
  let retry = null;
  let destroyed = false;

  const start = () => {
    if (destroyed) return;
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ liveSyncDurationCount: 2, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          hls.destroy();
          retry = setTimeout(start, 3000);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src; // Safari / iOS play HLS natively
    }
  };
  start();

  return () => {
    destroyed = true;
    clearTimeout(retry);
    hls?.destroy();
    video.removeAttribute('src');
    video.load();
  };
}

// ---------- layout ----------
const layoutToggle = document.getElementById('layout-toggle');
function setCols(cols) {
  grid.style.setProperty('--cols', cols);
  localStorage.setItem('securecam.cols', cols);
  for (const b of layoutToggle.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.cols === String(cols));
  }
}
layoutToggle.addEventListener('click', (e) => {
  if (e.target.dataset.cols) setCols(e.target.dataset.cols);
});
setCols(localStorage.getItem('securecam.cols') || 2);

// ---------- tiles ----------
function renderStatus(tile) {
  const { camera } = tile;
  const badge = tile.el.querySelector('.badge');
  const overlay = tile.el.querySelector('.overlay');
  const state = camera.enabled ? camera.status.state : 'disabled';
  badge.className = `badge ${state}`;
  badge.textContent = { live: 'Live', starting: 'Connecting', error: 'Offline', disabled: 'Disabled', stopped: 'Stopped' }[state] || state;

  const wasLive = tile.el.dataset.state === 'live';
  tile.el.dataset.state = state;

  if (state === 'live') {
    overlay.classList.add('hidden');
    if (!wasLive) {
      tile.player?.();
      tile.player = play(tile.el.querySelector('video'), gridSrc(camera.id));
    }
  } else {
    tile.player?.();
    tile.player = null;
    overlay.classList.remove('hidden');
    overlay.textContent = state === 'error'
      ? `Can't reach camera — retrying.\n${camera.status.lastError || ''}`
      : state === 'disabled' ? 'Camera disabled' : 'Connecting…';
  }
}

function createTile(camera) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const tile = { el, camera, player: null };
  el.querySelector('.name').textContent = camera.name;
  el.querySelector('.video-box').addEventListener('click', () => openFocus(tile.camera));
  el.querySelector('.tools').addEventListener('click', async (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'edit') openDialog(tile.camera);
    if (action === 'open') openFocus(tile.camera);
    if (action === 'restart') {
      el.dataset.state = '';
      tile.camera = await api(`/api/cameras/${tile.camera.id}/restart`, { method: 'POST' });
      renderStatus(tile);
    }
  });
  grid.appendChild(el);
  tiles.set(camera.id, tile);
  return tile;
}

// A camera's stream config changed; the tile must reconnect.
function configKey(c) {
  return JSON.stringify([c.type, c.url, c.subUrl, c.host, c.port, c.username]);
}

async function refresh() {
  let cameras;
  try {
    cameras = await api('/api/cameras');
  } catch {
    return;
  }
  empty.classList.toggle('hidden', cameras.length > 0);
  const seen = new Set();
  for (const camera of cameras) {
    seen.add(camera.id);
    const tile = tiles.get(camera.id) || createTile(camera);
    if (configKey(tile.camera) !== configKey(camera)) tile.el.dataset.state = '';
    tile.camera = camera;
    tile.el.querySelector('.name').textContent = camera.name;
    renderStatus(tile);
  }
  for (const [id, tile] of tiles) {
    if (!seen.has(id)) {
      tile.player?.();
      tile.el.remove();
      tiles.delete(id);
    }
  }
}

// ---------- focus (single camera) view ----------
const focus = {
  el: document.getElementById('focus'),
  video: document.querySelector('#focus video'),
  name: document.getElementById('focus-name'),
  quality: document.getElementById('focus-quality'),
  note: document.getElementById('focus-note'),
  hdBtn: document.getElementById('focus-hd'),
  camera: null,
  player: null,
  token: 0, // bumps on every switch so stale HD responses are ignored
  wantHd: localStorage.getItem('securecam.hd') !== '0',
  soundBtn: document.getElementById('focus-sound'),
  hasAudio: false, // does the stream now playing carry sound?
  wantSound: localStorage.getItem('securecam.sound') !== '0',
};

function setNote(text) {
  focus.note.textContent = text || '';
  focus.note.classList.toggle('hidden', !text);
}

function renderSound() {
  focus.soundBtn.classList.toggle('hidden', !focus.hasAudio);
  focus.soundBtn.textContent = focus.video.muted ? '🔇 Sound off' : '🔊 Sound on';
}

function focusPlay(src, label, audio = false) {
  focus.player?.();
  focus.hasAudio = audio;
  focus.video.muted = !(audio && focus.wantSound);
  focus.player = play(focus.video, src);
  focus.quality.textContent = label;
  renderSound();
  // Browsers may refuse to start playback with sound; fall back to muted.
  focus.video.play()?.catch((err) => {
    if (err.name !== 'NotAllowedError' || focus.video.muted) return;
    focus.video.muted = true;
    renderSound();
    focus.video.play()?.catch(() => {});
  });
}

async function loadFocusStream() {
  const { camera } = focus;
  const token = ++focus.token;
  // Start with the low-res stream right away so there's never a blank screen.
  focusPlay(gridSrc(camera.id), 'SD');
  setNote('');
  focus.hdBtn.classList.toggle('hidden', !camera.hasHd);
  focus.hdBtn.textContent = focus.wantHd ? 'Switch to SD' : 'Switch to HD';
  if (!camera.hasHd || !focus.wantHd) return;

  focus.quality.textContent = 'SD · loading HD…';
  try {
    const { src, variant, audio } = await api(`/api/cameras/${camera.id}/hd`, {
      method: 'POST',
      body: JSON.stringify({ hevc: PLAYS_HEVC }),
    });
    if (token !== focus.token) return;
    focusPlay(src, variant === 'hd-avc' ? 'HD (converted)' : 'HD', audio);
  } catch (err) {
    if (token !== focus.token) return;
    focus.quality.textContent = 'SD';
    setNote(`HD unavailable: ${err.message}`);
  }
}

function openFocus(camera) {
  if (!camera.enabled) return;
  focus.camera = camera;
  focus.name.textContent = camera.name;
  focus.el.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  loadFocusStream();
}

function closeFocus() {
  focus.token += 1;
  focus.player?.();
  focus.player = null;
  focus.camera = null;
  focus.el.classList.add('hidden');
  document.body.classList.remove('no-scroll');
  if (document.fullscreenElement) document.exitFullscreen();
}

focus.soundBtn.addEventListener('click', () => {
  focus.video.muted = !focus.video.muted;
  focus.wantSound = !focus.video.muted;
  localStorage.setItem('securecam.sound', focus.wantSound ? '1' : '0');
  renderSound();
});
focus.hdBtn.addEventListener('click', () => {
  focus.wantHd = !focus.wantHd;
  localStorage.setItem('securecam.hd', focus.wantHd ? '1' : '0');
  loadFocusStream();
});
document.getElementById('focus-close').addEventListener('click', closeFocus);
document.getElementById('focus-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else focus.el.requestFullscreen?.();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!clipModal.classList.contains('hidden')) return closeClip();
  if (focus.camera && !document.fullscreenElement && !dialog.open) closeFocus();
});

// ---------- add / edit dialog ----------
const field = (id) => document.getElementById(id);

function showTypeFields() {
  const type = field('cam-type').value;
  field('fields-reolink').classList.toggle('hidden', type !== 'reolink');
  field('fields-generic').classList.toggle('hidden', type !== 'generic');
}
field('cam-type').addEventListener('change', showTypeFields);

function openDialog(camera) {
  editingId = camera?.id || null;
  camError.textContent = '';
  testResult.classList.add('hidden');
  field('dialog-title').textContent = camera ? 'Edit camera' : 'Add camera';
  field('cam-delete').classList.toggle('hidden', !camera);
  field('cam-name').value = camera?.name || '';
  field('cam-type').value = camera?.type || 'reolink';
  field('cam-host').value = camera?.host || '';
  field('cam-port').value = camera?.port || '';
  field('cam-username').value = camera?.username || 'admin';
  field('cam-password').value = '';
  field('cam-password').placeholder = camera?.type === 'reolink' ? 'Leave blank to keep current' : '';
  field('cam-url').value = camera?.url || '';
  field('cam-suburl').value = camera?.subUrl || '';
  field('cam-enabled').checked = camera ? camera.enabled : true;
  showTypeFields();
  dialog.showModal();
}

function formPayload() {
  return {
    id: editingId || undefined,
    name: field('cam-name').value,
    type: field('cam-type').value,
    host: field('cam-host').value,
    port: field('cam-port').value,
    username: field('cam-username').value,
    password: field('cam-password').value,
    url: field('cam-url').value,
    subUrl: field('cam-suburl').value,
    enabled: field('cam-enabled').checked,
  };
}

const CODEC_NAMES = { h264: 'H.264', hevc: 'H.265', test: 'test pattern' };

function describeStream(label, s) {
  if (!s) return null;
  if (s.error) return { ok: false, text: `${label}: ${s.error}` };
  const size = s.width ? ` ${s.width}×${s.height}` : '';
  return { ok: true, text: `${label}: ${CODEC_NAMES[s.codec] || s.codec}${size}`, codec: s.codec };
}

field('cam-test').addEventListener('click', async () => {
  camError.textContent = '';
  testResult.className = 'test-result';
  testResult.textContent = 'Connecting to camera…';
  const btn = field('cam-test');
  btn.disabled = true;
  try {
    const { grid: g, hd } = await api('/api/cameras/test', { method: 'POST', body: JSON.stringify(formPayload()) });
    const lines = [describeStream(hd ? 'Grid (low-res)' : 'Stream', g), describeStream('Full view (HD)', hd)].filter(Boolean);
    const ok = lines.every((l) => l.ok);
    if (ok && lines.some((l) => l.codec === 'hevc') && !PLAYS_HEVC) {
      lines.push({ ok: true, text: 'This browser can\'t play H.265, so the server will convert HD to H.264 (uses more CPU).' });
    }
    testResult.className = `test-result ${ok ? 'ok' : 'bad'}`;
    testResult.textContent = `${ok ? '✓ Connected' : '✗ Problem found'}\n${lines.map((l) => l.text).join('\n')}`;
  } catch (err) {
    testResult.className = 'test-result bad';
    testResult.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

camForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  camError.textContent = '';
  try {
    if (editingId) {
      await api(`/api/cameras/${editingId}`, { method: 'PUT', body: JSON.stringify(formPayload()) });
      const tile = tiles.get(editingId);
      if (tile) tile.el.dataset.state = '';
    } else {
      await api('/api/cameras', { method: 'POST', body: JSON.stringify(formPayload()) });
    }
    dialog.close();
    refresh();
  } catch (err) {
    camError.textContent = err.message;
  }
});

field('cam-delete').addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this camera?')) return;
  await api(`/api/cameras/${editingId}`, { method: 'DELETE' });
  dialog.close();
  refresh();
});

field('cam-cancel').addEventListener('click', () => dialog.close());
field('add-btn').addEventListener('click', () => openDialog());
field('empty-add-btn').addEventListener('click', () => openDialog());
field('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

// ---------- detection alerts ----------
const alertsBox = document.getElementById('alerts');
const alertsWrap = document.getElementById('alerts-wrap');
const alertsBtn = document.getElementById('alerts-btn');
const alertsDropdown = document.getElementById('alerts-dropdown');
const alertsList = document.getElementById('alerts-list');
const alertCount = document.getElementById('alert-count');
const ackAllAlerts = document.getElementById('ack-all-alerts');
const clipModal = document.getElementById('clip-modal');
const clipVideo = document.getElementById('clip-video');
const clipStill = document.getElementById('clip-still');
const clipTitle = document.getElementById('clip-title');
const clipNote = document.getElementById('clip-note');
const clipClose = document.getElementById('clip-close');
let lastAlertId = null;
let latestAlerts = [];
let activeClipAlert = null;

const snapshotUrl = (name) => `/api/snapshots/${encodeURIComponent(name)}`;

function renderAlertList() {
  alertsList.innerHTML = latestAlerts.length
    ? latestAlerts.map((a) => {
      const repeats = Number(a.repeats) > 1 ? ` · ${a.repeats} sightings` : '';
      const last = a.lastSeen && a.lastSeen !== a.createdAt ? ` · last ${when(a.lastSeen)}` : '';
      return `
        <button type="button" class="alert-item ${a.ack ? 'acked' : ''}" data-alert="${a.id}">
          ${a.snapshot ? `<img src="${snapshotUrl(a.snapshot)}" alt="" class="alert-thumb">` : ''}
          <span class="alert-text">
            <strong>${esc(a.message)}</strong>
            <span class="hint">${esc(a.cameraName)} · ${esc(when(a.createdAt))}${esc(repeats)}${esc(last)}</span>
          </span>
          <span class="alert-play">${a.hasClip ? '▶ clip' : 'view'}</span>
        </button>`;
    }).join('')
    : '<p class="hint">No alerts yet.</p>';
}

function setAlertsOpen(open) {
  alertsDropdown.classList.toggle('hidden', !open);
  alertsBtn.setAttribute('aria-expanded', String(open));
  if (open) renderAlertList();
}

function showToast(alert) {
  const item = document.createElement('div');
  item.className = 'toast';
  const text = document.createElement('span');
  text.textContent = alert.message;
  const close = document.createElement('button');
  close.className = 'icon';
  close.textContent = '✕';
  close.title = 'Dismiss';
  close.addEventListener('click', async () => {
    item.remove();
    try {
      await api('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ ids: [alert.id] }) });
      pollAlerts();
    } catch { /* the next poll will retry */ }
  });
  item.append(text, close);
  alertsBox.appendChild(item);
  setTimeout(() => item.remove(), 12_000);
}

function openClip(alert) {
  activeClipAlert = alert;
  clipTitle.textContent = alert.message;
  const hasStill = Boolean(alert.snapshot);
  clipVideo.classList.toggle('hidden', !alert.hasClip);
  clipStill.classList.toggle('hidden', alert.hasClip || !hasStill);
  clipStill.src = hasStill ? snapshotUrl(alert.snapshot) : '';
  clipNote.textContent = alert.hasClip
    ? 'Latest 5-second 1080p clip from this alert.'
    : hasStill ? 'No clip was saved for this alert.' : 'No media was saved for this alert.';
  clipModal.classList.remove('hidden');
  if (alert.hasClip) {
    clipVideo.src = `/api/alerts/${alert.id}/clip`;
    clipVideo.play()?.catch(() => {});
  }
}

function closeClip() {
  clipVideo.pause();
  clipVideo.removeAttribute('src');
  clipVideo.load();
  clipModal.classList.add('hidden');
  activeClipAlert = null;
}

alertsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setAlertsOpen(alertsDropdown.classList.contains('hidden'));
});
document.addEventListener('click', (e) => {
  if (!alertsWrap.contains(e.target)) setAlertsOpen(false);
});
ackAllAlerts.addEventListener('click', async (e) => {
  e.stopPropagation();
  await api('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ all: true }) });
  pollAlerts();
});
alertsList.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-alert]');
  if (!button) return;
  e.stopPropagation();
  const alert = latestAlerts.find((a) => a.id === Number(button.dataset.alert));
  setAlertsOpen(false);
  if (!alert) return;
  try {
    await api('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ ids: [alert.id] }) });
  } catch { /* still let the user view the media */ }
  pollAlerts();
  openClip(alert);
});
clipClose.addEventListener('click', closeClip);
clipModal.addEventListener('click', (e) => { if (e.target === clipModal) closeClip(); });
clipVideo.addEventListener('error', () => {
  if (!activeClipAlert) return;
  clipVideo.classList.add('hidden');
  const hasStill = Boolean(activeClipAlert.snapshot);
  clipStill.classList.toggle('hidden', !hasStill);
  if (hasStill) clipStill.src = snapshotUrl(activeClipAlert.snapshot);
  clipNote.textContent = 'This clip is not available. The alert snapshot is shown instead.';
});

async function pollAlerts() {
  try {
    const [alerts, status] = await Promise.all([
      api('/api/alerts?limit=40'),
      api('/api/detection/status'),
    ]);
    latestAlerts = alerts;
    renderAlertList();
    const unread = status.unreadAlerts || 0;
    alertCount.textContent = unread;
    alertCount.classList.toggle('hidden', !unread);
    const badge = document.getElementById('detection-count');
    badge.textContent = status.objects || 0;
    badge.classList.toggle('hidden', !status.objects);
    const newest = alerts[0]?.id || 0;
    if (lastAlertId === null) lastAlertId = newest;
    else {
      for (const alert of alerts.filter((a) => a.id > lastAlertId).reverse()) showToast(alert);
      lastAlertId = newest;
    }
  } catch { /* api() handles authentication failures */ }
}

pollAlerts();
setInterval(pollAlerts, 5000);

refresh();
setInterval(refresh, 3000);
