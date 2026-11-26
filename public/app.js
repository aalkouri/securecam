/* global Hls */
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const tpl = document.getElementById('tile-template');
const dialog = document.getElementById('cam-dialog');
const camForm = document.getElementById('cam-form');
const camError = document.getElementById('cam-error');

const tiles = new Map(); // id -> { el, hls, camera }
let editingId = null;

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
function attachPlayer(tile) {
  const video = tile.el.querySelector('video');
  const src = `/streams/${tile.camera.id}/index.m3u8`;
  tile.hls?.destroy();
  tile.hls = null;

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 2, manifestLoadingMaxRetry: Infinity, manifestLoadingRetryDelay: 2000 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else if (data.fatal) setTimeout(() => attachPlayer(tile), 3000);
    });
    tile.hls = hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src; // Safari / iOS play HLS natively
  }
}

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
    if (!wasLive) attachPlayer(tile);
  } else {
    tile.hls?.destroy();
    tile.hls = null;
    overlay.classList.remove('hidden');
    overlay.textContent = state === 'error'
      ? `Can't reach camera — retrying.\n${camera.status.lastError || ''}`
      : state === 'disabled' ? 'Camera disabled' : 'Connecting…';
  }
}

function createTile(camera) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const tile = { el, camera, hls: null };
  el.querySelector('.name').textContent = camera.name;
  el.querySelector('.tools').addEventListener('click', async (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'edit') openDialog(tile.camera);
    if (action === 'fullscreen') el.querySelector('.video-box').requestFullscreen?.();
    if (action === 'restart') {
      el.dataset.state = '';
      tile.camera = await api(`/api/cameras/${camera.id}/restart`, { method: 'POST' });
      renderStatus(tile);
    }
  });
  grid.appendChild(el);
  tiles.set(camera.id, tile);
  return tile;
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
    const urlChanged = tile.camera.url !== camera.url;
    tile.camera = camera;
    tile.el.querySelector('.name').textContent = camera.name;
    if (urlChanged) tile.el.dataset.state = '';
    renderStatus(tile);
  }
  for (const [id, tile] of tiles) {
    if (!seen.has(id)) {
      tile.hls?.destroy();
      tile.el.remove();
      tiles.delete(id);
    }
  }
}

// ---------- add / edit dialog ----------
function openDialog(camera) {
  editingId = camera?.id || null;
  camError.textContent = '';
  document.getElementById('dialog-title').textContent = camera ? 'Edit camera' : 'Add camera';
  document.getElementById('cam-delete').classList.toggle('hidden', !camera);
  camForm['cam-name'].value = camera?.name || '';
  camForm['cam-url'].value = camera?.url || '';
  camForm['cam-enabled'].checked = camera ? camera.enabled : true;
  camForm['cam-transcode'].checked = camera?.transcode || false;
  dialog.showModal();
}

camForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: camForm['cam-name'].value,
    url: camForm['cam-url'].value,
    enabled: camForm['cam-enabled'].checked,
    transcode: camForm['cam-transcode'].checked,
  };
  try {
    if (editingId) {
      await api(`/api/cameras/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const tile = tiles.get(editingId);
      if (tile) tile.el.dataset.state = '';
    } else {
      await api('/api/cameras', { method: 'POST', body: JSON.stringify(payload) });
    }
    dialog.close();
    refresh();
  } catch (err) {
    camError.textContent = err.message;
  }
});

document.getElementById('cam-delete').addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this camera?')) return;
  await api(`/api/cameras/${editingId}`, { method: 'DELETE' });
  dialog.close();
  refresh();
});

document.getElementById('cam-cancel').addEventListener('click', () => dialog.close());
document.getElementById('add-btn').addEventListener('click', () => openDialog());
document.getElementById('empty-add-btn').addEventListener('click', () => openDialog());
document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

refresh();
setInterval(refresh, 3000);
