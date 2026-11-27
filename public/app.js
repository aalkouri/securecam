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
let buildings = [];

// Admin account switching.
const accountSwitcher = document.getElementById('account-switcher');
const accountSelect = document.getElementById('account-select');
const adminPicker = document.getElementById('admin-picker');
const adminPickerSelect = document.getElementById('admin-picker-select');
let accountState = null;

// Floor-plan editor state.
const planSelect = document.getElementById('floorplan-building');
const planOutlineName = document.getElementById('floorplan-outline-name');
const planRoomsEl = document.getElementById('floorplan-rooms');
const planEmpty = document.getElementById('floorplan-empty');
const roomTpl = document.getElementById('room-template');
const roomDialog = document.getElementById('room-dialog');
const roomForm = document.getElementById('room-form');
const roomError = document.getElementById('room-error');
const roomNameInput = document.getElementById('room-name');
const renameDialog = document.getElementById('rename-dialog');
const renameForm = document.getElementById('rename-form');
const renameInput = document.getElementById('rename-input');
const renameError = document.getElementById('rename-error');
const noticeDialog = document.getElementById('notice-dialog');
const noticeText = document.getElementById('notice-text');
const noticeCancel = document.getElementById('notice-cancel');
const noticeOk = document.getElementById('notice-ok');
let cameraCounts = new Map();
let activeRoomDrag = null;
let activeRoomResize = null;
let renameTarget = null;
let noticeResolver = null;

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
  el.querySelector('.location').textContent = `${camera.buildingName || 'Unassigned'} / ${camera.roomName || 'Unassigned'}`;
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
  cameraCounts = new Map();
  for (const camera of cameras) {
    if (!camera.buildingId || !camera.roomId) continue;
    cameraCounts.set(camera.roomId, (cameraCounts.get(camera.roomId) || 0) + 1);
  }
  updateFloorplanCounts();
  const seen = new Set();
  for (const camera of cameras) {
    seen.add(camera.id);
    const tile = tiles.get(camera.id) || createTile(camera);
    if (configKey(tile.camera) !== configKey(camera)) tile.el.dataset.state = '';
    tile.camera = camera;
    tile.el.querySelector('.name').textContent = camera.name;
    tile.el.querySelector('.location').textContent = `${camera.buildingName || 'Unassigned'} / ${camera.roomName || 'Unassigned'}`;
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
  if (!archiveModal.classList.contains('hidden')) return closeArchives();
  if (focus.camera && !document.fullscreenElement && !dialog.open) closeFocus();
});

// ---------- add / edit dialog ----------
const field = (id) => document.getElementById(id);

// ---------- first-run setup guide ----------
// Accounts can be created without any building. Until one exists, the guide
// owns the screen: create a building, then a room, then the first camera.
const onboardingState = { active: false, step: 1, building: null, room: null };
const onboardingEl = document.getElementById('onboarding');
const onboardingError = document.getElementById('onboarding-error');
const onboardingNext = document.getElementById('onboarding-next');
const cameraSlot = document.getElementById('onboarding-camera-slot');

const ONBOARDING_STEPS = {
  1: {
    icon: '🏢',
    title: 'Let’s add your first building',
    copy: 'A building is the property or site where your cameras will live. Name it something you’ll recognise later.',
    button: 'Create building',
  },
  2: {
    icon: '🚪',
    title: 'Now add a room',
    copy: 'Rooms keep cameras organised. Tell us which part of your building this first camera will watch.',
    button: 'Create room',
  },
  3: {
    icon: '📷',
    title: 'Add your first camera',
    copy: 'Last step. Your building and room are already filled in — just name the camera and choose its feed.',
    button: 'Add camera',
  },
};

function setBehindInert(inert) {
  // Make every screen element outside the guide unreachable by mouse or
  // keyboard. The overlay covers the page, but inert also hides background
  // controls from focus order and assistive technology.
  for (const el of document.body.children) {
    if (el !== onboardingEl && el.tagName !== 'SCRIPT') el.inert = inert;
  }
}

function placeSummary(building, room) {
  return `<span>🏢 ${esc(building.name)}</span><span class="sep">›</span><span>🚪 ${esc(room.name)}</span>`;
}

function renderOnboarding() {
  const step = onboardingState.step;
  const info = ONBOARDING_STEPS[step];
  field('onboarding-hero-icon').textContent = info.icon;
  field('onboarding-progress-text').textContent = `Step ${step} of 3`;
  field('onboarding-title').textContent = info.title;
  field('onboarding-copy').textContent = info.copy;
  onboardingNext.textContent = info.button;
  onboardingError.textContent = '';

  for (const el of document.querySelectorAll('.onboard-step')) {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  }
  for (let n = 1; n <= 3; n += 1) {
    field(`onboarding-step-${n}`).classList.toggle('hidden', n !== step);
  }
  field('onboarding-actions').classList.toggle('hidden', step === 3);
}

function startOnboarding() {
  if (onboardingState.active || buildings.length) return;
  onboardingState.active = true;
  onboardingState.step = 1;
  onboardingState.building = null;
  onboardingState.room = null;
  field('onboarding-building-name').value = '';
  field('onboarding-room-name').value = '';
  renderOnboarding();
  onboardingEl.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  setBehindInert(true);
  field('onboarding-building-name').focus();
}

// The camera form normally lives inside #cam-dialog. During setup it moves
// into the guide so the whole flow looks and behaves like one screen.
function restoreCameraForm() {
  if (cameraSlot.contains(camForm)) dialog.appendChild(camForm);
  field('cam-placement-summary').classList.add('hidden');
  field('cam-placement-summary').textContent = '';
  field('cam-building').closest('.placement-row').classList.remove('hidden');
  field('cam-cancel').classList.remove('hidden');
  field('cam-delete').classList.remove('hidden');
  field('dialog-title').classList.remove('hidden');
  field('cam-submit').textContent = 'Save';
}

async function prepareCameraStep() {
  await loadPlacements();
  restoreCameraForm();
  cameraSlot.appendChild(camForm);
  editingId = null;
  camError.textContent = '';
  testResult.classList.add('hidden');
  field('cam-placement-summary').innerHTML = placeSummary(onboardingState.building, onboardingState.room);
  field('cam-placement-summary').classList.remove('hidden');
  field('cam-building').closest('.placement-row').classList.add('hidden');
  field('cam-cancel').classList.add('hidden');
  field('cam-delete').classList.add('hidden');
  field('dialog-title').classList.add('hidden');
  field('cam-submit').textContent = 'Add camera';
  field('onboarding-room-summary').innerHTML = placeSummary(onboardingState.building, onboardingState.room);

  field('cam-building').value = onboardingState.building.id;
  setRoomOptions(onboardingState.building.id, onboardingState.room.id);
  field('cam-name').value = '';
  field('cam-type').value = 'reolink';
  field('cam-host').value = '';
  field('cam-port').value = '';
  field('cam-username').value = 'admin';
  field('cam-password').value = '';
  field('cam-password').placeholder = '';
  field('cam-url').value = '';
  field('cam-sample').value = '';
  field('cam-enabled').checked = true;
  showTypeFields();
}

function finishOnboarding() {
  restoreCameraForm();
  onboardingState.active = false;
  onboardingState.building = null;
  onboardingState.room = null;
  onboardingEl.classList.add('hidden');
  document.body.classList.remove('no-scroll');
  setBehindInert(false);
}

async function advanceOnboarding() {
  if (!onboardingState.active || onboardingState.step === 3) return;
  onboardingError.textContent = '';
  onboardingNext.disabled = true;
  try {
    if (onboardingState.step === 1) {
      const name = field('onboarding-building-name').value.trim();
      if (!name) throw new Error('Enter a building name to continue.');
      const building = await api('/api/buildings', { method: 'POST', body: JSON.stringify({ name }) });
      onboardingState.building = building;
      field('onboarding-building-summary').innerHTML = `<span>🏢 ${esc(building.name)}</span>`;
      onboardingState.step = 2;
      field('onboarding-room-name').value = '';
      renderOnboarding();
      field('onboarding-room-name').focus();
    } else {
      const name = field('onboarding-room-name').value.trim();
      if (!name) throw new Error('Enter a room name to continue.');
      const room = await api(`/api/buildings/${onboardingState.building.id}/rooms`, {
        method: 'POST', body: JSON.stringify({ name }),
      });
      onboardingState.room = room;
      onboardingState.step = 3;
      await prepareCameraStep();
      renderOnboarding();
      field('cam-name').focus();
    }
  } catch (err) {
    onboardingError.textContent = err.message;
    onboardingNext.disabled = false;
    return;
  }
  onboardingNext.disabled = false;
}

onboardingNext.addEventListener('click', () => { advanceOnboarding(); });
for (const id of ['onboarding-building-name', 'onboarding-room-name']) {
  field(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    advanceOnboarding();
  });
}
// Escape must never dismiss the guide or let someone slip past it.
document.addEventListener('keydown', (e) => {
  if (onboardingState.active && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

function showTypeFields() {
  const type = field('cam-type').value;
  field('fields-reolink').classList.toggle('hidden', type !== 'reolink');
  field('fields-generic').classList.toggle('hidden', type !== 'generic');
}
field('cam-type').addEventListener('change', showTypeFields);

async function loadPlacements() {
  const data = await api('/api/placements');
  buildings = data.buildings || [];
  const select = field('cam-building');
  const previous = select.value;
  select.innerHTML = [
    ...buildings.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`),
    '<option value="__new__">+ Create new building…</option>',
  ].join('');
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
  else select.value = buildings[0]?.id || '__new__';
  setRoomOptions(select.value === '__new__' ? '' : select.value);
  renderFloorplan();
}

function setRoomOptions(buildingId, selectedId = '') {
  const select = field('cam-room');
  const building = buildings.find((b) => b.id === buildingId);
  const rooms = building?.rooms || [];
  select.innerHTML = [
    '<option value="">Choose a room…</option>',
    ...rooms.map((room) => `<option value="${esc(room.id)}">${esc(room.name)}</option>`),
    ...(building ? ['<option value="__new__">+ Create new room…</option>'] : []),
  ].join('');
  select.value = rooms.some((room) => room.id === selectedId) ? selectedId : '';
  updatePlacementFields();
}

function updatePlacementFields() {
  const creatingBuilding = field('cam-building').value === '__new__';
  const creatingRoom = creatingBuilding || field('cam-room').value === '__new__';
  field('cam-new-building').classList.toggle('hidden', !creatingBuilding);
  field('cam-new-building').required = creatingBuilding;
  field('room-select-field').classList.toggle('placeholder', creatingBuilding);
  field('cam-room').disabled = creatingBuilding;
  field('cam-room').required = !creatingBuilding;
  field('cam-new-room').classList.toggle('hidden', !creatingRoom);
  field('cam-new-room').required = creatingRoom;
}

field('cam-building').addEventListener('change', () => {
  const buildingId = field('cam-building').value;
  if (buildingId === '__new__') {
    field('cam-room').innerHTML = '<option value="">Choose a room…</option>';
    updatePlacementFields();
  } else {
    setRoomOptions(buildingId);
  }
});
field('cam-room').addEventListener('change', updatePlacementFields);

// ---------- interactive building floor plan ----------
const planPercent = (value, min, max) => {
  const n = Number(value);
  return Number(Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)).toFixed(2));
};

function currentPlanBuilding() {
  return buildings.find((building) => building.id === planSelect.value) || null;
}

function normalizeLayout(layout = {}) {
  const w = planPercent(layout.w, 8, 100);
  const h = planPercent(layout.h, 10, 100);
  return {
    w, h,
    x: planPercent(layout.x, 0, 100 - w),
    y: planPercent(layout.y, 0, 100 - h),
  };
}

function setRoomVars(el, layout) {
  const { x, y, w, h } = normalizeLayout(layout);
  el.style.setProperty('--x', x.toFixed(2));
  el.style.setProperty('--y', y.toFixed(2));
  el.style.setProperty('--w', w.toFixed(2));
  el.style.setProperty('--h', h.toFixed(2));
}

function cameraCountText(roomId) {
  const count = cameraCounts.get(roomId) || 0;
  return count ? `${count} camera${count === 1 ? '' : 's'}` : '';
}

function renderFloorplan() {
  const remembered = localStorage.getItem('securecam.building');
  const wanted = planSelect.value || remembered || buildings[0]?.id || '';
  planSelect.innerHTML = buildings.length
    ? buildings.map((building) => `<option value="${esc(building.id)}">${esc(building.name)}</option>`).join('')
    : '<option value="">No buildings</option>';
  const chosen = buildings.some((building) => building.id === wanted) ? wanted : (buildings[0]?.id || '');
  planSelect.value = chosen;
  if (chosen) localStorage.setItem('securecam.building', chosen);
  planOutlineName.textContent = currentPlanBuilding()?.name || '';
  planOutlineName.title = planOutlineName.textContent ? `Rename ${planOutlineName.textContent}` : 'Rename building';
  renderFloorplanRooms();
}

function updateFloorplanCounts() {
  for (const el of planRoomsEl.querySelectorAll('.plan-room')) {
    el.querySelector('.plan-count').textContent = cameraCountText(el.dataset.roomId);
  }
}

function renderFloorplanRooms() {
  planRoomsEl.innerHTML = '';
  const building = currentPlanBuilding();
  const rooms = building?.rooms || [];
  planEmpty.classList.toggle('hidden', rooms.length > 0);
  for (const room of rooms) {
    const el = roomTpl.content.firstElementChild.cloneNode(true);
    el.dataset.roomId = room.id;
    el.setAttribute('aria-label', `${room.name} room. Drag to move, corner to resize.`);
    setRoomVars(el, room);
    const nameButton = el.querySelector('.plan-room-name');
    nameButton.textContent = room.name;
    nameButton.title = `Rename ${room.name}`;
    nameButton.addEventListener('pointerdown', (e) => e.stopPropagation());
    nameButton.addEventListener('click', (e) => {
      e.stopPropagation();
      openRename('room', room);
    });
    el.querySelector('.plan-count').textContent = cameraCountText(room.id);
    const addButton = el.querySelector('.plan-add-cam');
    addButton.addEventListener('pointerdown', (e) => e.stopPropagation());
    addButton.addEventListener('click', (e) => {
      e.stopPropagation();
      openDialog(null, { buildingId: building.id, roomId: room.id });
    });
    const closeButton = el.querySelector('.plan-room-close');
    closeButton.title = `Delete ${room.name}`;
    closeButton.setAttribute('aria-label', `Delete ${room.name}`);
    closeButton.addEventListener('pointerdown', (e) => e.stopPropagation());
    closeButton.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRoomFromPlan(room);
    });
    const resizeHandle = el.querySelector('.plan-resize');
    resizeHandle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      startRoomResize(e, room, el);
    });
    resizeHandle.addEventListener('keydown', (e) => {
      e.stopPropagation();
      handleResizeKeys(e, room, el);
    });
    el.addEventListener('pointerdown', (e) => startRoomDrag(e, room, el));
    el.addEventListener('keydown', (e) => handleRoomKeys(e, room, el));
    planRoomsEl.appendChild(el);
  }
}

async function saveRoomLayout(room, layout) {
  const payload = normalizeLayout(layout);
  try {
    await api(`/api/rooms/${encodeURIComponent(room.id)}/layout`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    Object.assign(room, payload);
  } catch (err) {
    // Put everything back where the server last saved it.
    await loadPlacements().catch(() => renderFloorplanRooms());
  }
}

function startRoomDrag(e, room, el) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.target.closest('button')) return;
  e.preventDefault();
  const bounds = planRoomsEl.getBoundingClientRect();
  const layout = {
    x: Number(room.x) || 6, y: Number(room.y) || 12,
    w: Number(room.w) || 28, h: Number(room.h) || 24,
  };
  activeRoomDrag = {
    id: e.pointerId, el, room, bounds,
    startX: e.clientX, startY: e.clientY,
    origin: { ...layout }, layout, moved: false,
  };
  el.classList.add('dragging');
  el.setPointerCapture?.(e.pointerId);

  const onMove = (ev) => {
    const drag = activeRoomDrag;
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = (ev.clientX - drag.startX) / drag.bounds.width * 100;
    const dy = (ev.clientY - drag.startY) / drag.bounds.height * 100;
    drag.layout.x = planPercent(drag.origin.x + dx, 0, 100 - drag.layout.w);
    drag.layout.y = planPercent(drag.origin.y + dy, 0, 100 - drag.layout.h);
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) drag.moved = true;
    setRoomVars(drag.el, drag.layout);
  };

  const onEnd = (ev) => {
    const drag = activeRoomDrag;
    if (!drag || ev.pointerId !== drag.id) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onEnd);
    el.removeEventListener('pointercancel', onEnd);
    el.releasePointerCapture?.(ev.pointerId);
    el.classList.remove('dragging');
    activeRoomDrag = null;
    if (drag.moved) saveRoomLayout(drag.room, drag.layout);
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onEnd);
  el.addEventListener('pointercancel', onEnd);
}

function startRoomResize(e, room, el) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  const bounds = planRoomsEl.getBoundingClientRect();
  const layout = normalizeLayout(room);
  activeRoomResize = {
    id: e.pointerId, el, room, bounds,
    startX: e.clientX, startY: e.clientY,
    origin: { ...layout }, layout, moved: false,
  };
  el.classList.add('resizing');
  el.setPointerCapture?.(e.pointerId);

  const onMove = (ev) => {
    const resize = activeRoomResize;
    if (!resize || ev.pointerId !== resize.id) return;
    const dx = (ev.clientX - resize.startX) / resize.bounds.width * 100;
    const dy = (ev.clientY - resize.startY) / resize.bounds.height * 100;
    resize.layout.w = planPercent(resize.origin.w + dx, 8, 100 - resize.origin.x);
    resize.layout.h = planPercent(resize.origin.h + dy, 10, 100 - resize.origin.y);
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) resize.moved = true;
    setRoomVars(resize.el, resize.layout);
  };

  const onEnd = (ev) => {
    const resize = activeRoomResize;
    if (!resize || ev.pointerId !== resize.id) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onEnd);
    el.removeEventListener('pointercancel', onEnd);
    el.releasePointerCapture?.(ev.pointerId);
    el.classList.remove('resizing');
    activeRoomResize = null;
    if (resize.moved) saveRoomLayout(resize.room, resize.layout);
  };

  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onEnd);
  el.addEventListener('pointercancel', onEnd);
}

function handleResizeKeys(e, room, el) {
  const step = e.shiftKey ? 5 : 1;
  let dx = 0;
  let dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else return;
  e.preventDefault();
  const layout = normalizeLayout(room);
  layout.w = planPercent(layout.w + dx, 8, 100 - layout.x);
  layout.h = planPercent(layout.h + dy, 10, 100 - layout.y);
  setRoomVars(el, layout);
  saveRoomLayout(room, layout);
}

function handleRoomKeys(e, room, el) {
  if (e.target.closest('button')) return;
  const step = e.shiftKey ? 5 : 1;
  let dx = 0;
  let dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else return;
  e.preventDefault();
  const layout = {
    x: planPercent(Number(room.x) + dx, 0, 100 - Number(room.w || 28)),
    y: planPercent(Number(room.y) + dy, 0, 100 - Number(room.h || 24)),
    w: Number(room.w) || 28,
    h: Number(room.h) || 24,
  };
  setRoomVars(el, layout);
  saveRoomLayout(room, layout);
}

function openRoomDialog() {
  const building = currentPlanBuilding();
  if (!building) return;
  roomError.textContent = '';
  roomNameInput.value = '';
  document.getElementById('room-dialog-building').textContent = `This room will be added to ${building.name}.`;
  roomDialog.showModal();
  roomNameInput.focus();
}

planSelect.addEventListener('change', () => {
  localStorage.setItem('securecam.building', planSelect.value);
  planOutlineName.textContent = currentPlanBuilding()?.name || '';
  planOutlineName.title = planOutlineName.textContent ? `Rename ${planOutlineName.textContent}` : 'Rename building';
  renderFloorplanRooms();
});
document.getElementById('floorplan-add-room').addEventListener('click', openRoomDialog);
document.getElementById('room-cancel').addEventListener('click', () => roomDialog.close());
roomForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const building = currentPlanBuilding();
  if (!building) return;
  const name = roomNameInput.value.trim();
  if (!name) {
    roomError.textContent = 'Enter a room name.';
    return;
  }
  const button = roomForm.querySelector('button[type="submit"]');
  button.disabled = true;
  roomError.textContent = '';
  try {
    await api(`/api/buildings/${encodeURIComponent(building.id)}/rooms`, {
      method: 'POST', body: JSON.stringify({ name }),
    });
    roomDialog.close();
    await loadPlacements();
  } catch (err) {
    roomError.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// A single small dialog handles both "heads up" messages and delete confirms.
function showNotice(text, { confirm = false, okLabel = 'OK' } = {}) {
  noticeText.textContent = text;
  noticeCancel.classList.toggle('hidden', !confirm);
  noticeOk.textContent = okLabel;
  noticeDialog.showModal();
  return new Promise((resolve) => { noticeResolver = resolve; });
}

function finishNotice(value) {
  const resolve = noticeResolver;
  noticeResolver = null;
  noticeDialog.close();
  if (resolve) resolve(value);
}

noticeOk.addEventListener('click', () => finishNotice(true));
noticeCancel.addEventListener('click', () => finishNotice(false));
noticeDialog.addEventListener('close', () => {
  if (noticeResolver) {
    const resolve = noticeResolver;
    noticeResolver = null;
    resolve(false);
  }
});

function openRename(type, item) {
  renameTarget = { type, id: item.id, name: item.name };
  document.getElementById('rename-title').textContent = type === 'building' ? 'Rename building' : 'Rename room';
  document.getElementById('rename-label').textContent = type === 'building' ? 'Building name' : 'Room name';
  renameInput.value = item.name;
  renameError.textContent = '';
  renameDialog.showModal();
  renameInput.focus();
  renameInput.select();
}

planOutlineName.addEventListener('click', () => {
  const building = currentPlanBuilding();
  if (building) openRename('building', building);
});
document.getElementById('rename-cancel').addEventListener('click', () => renameDialog.close());
renameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!renameTarget) return;
  const name = renameInput.value.trim();
  if (!name) {
    renameError.textContent = 'Enter a name.';
    return;
  }
  const target = renameTarget;
  const path = target.type === 'building'
    ? `/api/buildings/${encodeURIComponent(target.id)}`
    : `/api/rooms/${encodeURIComponent(target.id)}`;
  const button = renameForm.querySelector('button[type="submit"]');
  button.disabled = true;
  renameError.textContent = '';
  try {
    await api(path, { method: 'PUT', body: JSON.stringify({ name }) });
    renameDialog.close();
    renameTarget = null;
    await loadPlacements();
  } catch (err) {
    renameError.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

async function deleteRoomFromPlan(room) {
  const count = cameraCounts.get(room.id) || 0;
  if (count) {
    await showNotice(`“${room.name}” still has ${count} camera${count === 1 ? '' : 's'}. Delete ${count === 1 ? 'that camera' : 'all cameras'} in this room first.`);
    return;
  }
  const ok = await showNotice(`Delete room “${room.name}”? This cannot be undone.`, {
    confirm: true, okLabel: 'Delete',
  });
  if (!ok) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
    await loadPlacements();
  } catch (err) {
    await showNotice(err.message);
  }
}

field('cam-host').addEventListener('change', () => {
  const value = field('cam-host').value.trim();
  if (!/^(test|clip):\/\//i.test(value)) return;
  field('cam-type').value = 'generic';
  showTypeFields();
  field('cam-url').value = value;
  const option = [...field('cam-sample').options].find((entry) => entry.value === value);
  field('cam-sample').value = option ? value : '';
  camError.textContent = '';
});

function chooseTestCamera() {
  const option = field('cam-sample').selectedOptions[0];
  if (!option?.value) return;
  field('cam-type').value = 'generic';
  showTypeFields();
  field('cam-url').value = option.value;
  if (!editingId && !field('cam-name').value.trim()) {
    field('cam-name').value = option.dataset.name || option.textContent;
  }
  testResult.classList.add('hidden');
}
field('cam-sample').addEventListener('change', chooseTestCamera);
field('cam-url').addEventListener('input', () => {
  const value = field('cam-url').value.trim();
  const match = [...field('cam-sample').options].find((option) => option.value === value);
  field('cam-sample').value = match ? value : '';
});

async function openDialog(camera, placement = {}) {
  editingId = camera?.id || null;
  camError.textContent = '';
  testResult.classList.add('hidden');
  field('dialog-title').textContent = camera ? 'Edit camera' : 'Add camera';
  field('cam-delete').classList.toggle('hidden', !camera);
  if (!buildings.length) {
    try {
      await loadPlacements();
    } catch (err) {
      camError.textContent = err.message;
    }
  }
  const buildingSelect = field('cam-building');
  if (!buildingSelect.options.length) {
    buildingSelect.innerHTML = '<option value="__new__">+ Create new building…</option>';
  }
  const preferredBuilding = placement.buildingId || camera?.buildingId;
  const preferredRoom = placement.roomId || camera?.roomId;
  const buildingId = preferredBuilding && buildings.some((b) => b.id === preferredBuilding)
    ? preferredBuilding
    : (buildings[0]?.id || '__new__');
  buildingSelect.value = buildingId;
  field('cam-new-building').value = '';
  field('cam-new-room').value = '';
  if (buildingId === '__new__') {
    field('cam-room').innerHTML = '<option value="">Choose a room…</option>';
    updatePlacementFields();
  } else {
    setRoomOptions(buildingId, preferredRoom || '');
  }
  field('cam-name').value = camera?.name || '';
  field('cam-type').value = camera?.type || 'reolink';
  field('cam-host').value = camera?.host || '';
  field('cam-port').value = camera?.port || '';
  field('cam-username').value = camera?.username || 'admin';
  field('cam-password').value = '';
  field('cam-password').placeholder = camera?.type === 'reolink' ? 'Leave blank to keep current' : '';
  field('cam-url').value = camera?.url || '';
  const sampleUrl = camera?.url || '';
  field('cam-sample').value = sampleUrl && [...field('cam-sample').options]
    .some((option) => option.value === sampleUrl) ? sampleUrl : '';
  field('cam-enabled').checked = camera ? camera.enabled : true;
  showTypeFields();
  dialog.showModal();
}

function formPayload() {
  const buildingId = field('cam-building').value;
  const roomId = field('cam-room').value;
  const creatingBuilding = buildingId === '__new__';
  const creatingRoom = creatingBuilding || roomId === '__new__';
  return {
    id: editingId || undefined,
    name: field('cam-name').value,
    type: field('cam-type').value,
    buildingId: creatingBuilding ? '' : buildingId,
    roomId: creatingRoom ? '' : roomId,
    newBuilding: creatingBuilding ? field('cam-new-building').value.trim() : '',
    newRoom: creatingRoom ? field('cam-new-room').value.trim() : '',
    host: field('cam-host').value,
    port: field('cam-port').value,
    username: field('cam-username').value,
    password: field('cam-password').value,
    url: field('cam-url').value,
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
    try { await loadPlacements(); } catch { /* the next dialog will retry */ }
    if (onboardingState.active) finishOnboarding();
    else dialog.close();
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
  const playable = Boolean(alert.clipUrl || alert.hasClip);
  clipVideo.classList.toggle('hidden', !playable);
  clipStill.classList.toggle('hidden', playable || !hasStill);
  clipStill.src = hasStill ? snapshotUrl(alert.snapshot) : '';
  clipNote.textContent = alert.note
    || (playable ? 'Latest 5-second 1080p clip from this alert.'
      : hasStill ? 'No clip was saved for this alert.' : 'No media was saved for this alert.');
  clipModal.classList.remove('hidden');
  if (playable) {
    clipVideo.src = alert.clipUrl || `/api/alerts/${alert.id}/clip`;
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

// ---------- archived alert clips ----------
const archiveBtn = document.getElementById('archive-btn');
const archiveModal = document.getElementById('archive-modal');
const archiveDays = document.getElementById('archive-days');
const archiveClips = document.getElementById('archive-clips');
const archiveClose = document.getElementById('archive-close');
let activeArchiveDate = null;
let activeArchiveClips = [];

function closeArchives() {
  archiveModal.classList.add('hidden');
}

async function openArchives() {
  archiveModal.classList.remove('hidden');
  activeArchiveDate = null;
  activeArchiveClips = [];
  archiveDays.innerHTML = '<p class="hint">Loading…</p>';
  archiveClips.innerHTML = '<p class="hint">Choose a day to browse its alert clips.</p>';
  try {
    const archives = await api('/api/alert-archives');
    archiveDays.innerHTML = archives.length
      ? archives.map((a) => `
          <button type="button" class="archive-day" data-date="${esc(a.date)}">
            <strong>${esc(a.date)}</strong>
            <span class="hint">${a.clipCount} clip${a.clipCount === 1 ? '' : 's'} · ${(a.byteSize / 1048576).toFixed(1)} MB</span>
          </button>`).join('')
      : '<p class="hint">No archived days yet.</p>';
  } catch (err) {
    archiveDays.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

async function selectArchiveDay(date) {
  activeArchiveDate = date;
  for (const button of archiveDays.querySelectorAll('[data-date]')) {
    button.classList.toggle('active', button.dataset.date === date);
  }
  archiveClips.innerHTML = '<p class="hint">Unpacking this day…</p>';
  try {
    const data = await api(`/api/alert-archives/${encodeURIComponent(date)}/extract`, { method: 'POST' });
    activeArchiveClips = data.clips;
    archiveClips.innerHTML = data.clips.length
      ? data.clips.map((clip, index) => `
          <button type="button" class="alert-item" data-clip="${index}">
            ${clip.snapshot ? `<img src="${snapshotUrl(clip.snapshot)}" alt="" class="alert-thumb">` : ''}
            <span class="alert-text">
              <strong>${esc(clip.message || `${clip.objectName || 'Alert'} showed up`)}</strong>
              <span class="hint">${esc(clip.cameraName || 'Camera')} · ${esc(when(clip.seenAt))}</span>
            </span>
            <span class="alert-play">▶ clip</span>
          </button>`).join('')
      : '<p class="hint">No alert clips were archived for this day.</p>';
  } catch (err) {
    activeArchiveClips = [];
    archiveClips.innerHTML = `<p class="hint">${esc(err.message)}</p>`;
  }
}

archiveBtn.addEventListener('click', openArchives);
archiveClose.addEventListener('click', closeArchives);
archiveModal.addEventListener('click', (e) => { if (e.target === archiveModal) closeArchives(); });
archiveDays.addEventListener('click', (e) => {
  const button = e.target.closest('[data-date]');
  if (button) selectArchiveDay(button.dataset.date);
});
archiveClips.addEventListener('click', (e) => {
  const button = e.target.closest('[data-clip]');
  if (!button) return;
  const clip = activeArchiveClips[Number(button.dataset.clip)];
  if (!clip) return;
  openClip({
    message: clip.message || `${clip.objectName || 'Alert'} showed up in camera ${clip.cameraName || 'camera'}`,
    snapshot: clip.snapshot,
    hasClip: true,
    clipUrl: clip.clipUrl,
    note: `Archived alert clip from ${activeArchiveDate}.`,
  });
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

// ---------- admin account switching ----------
function accountOptions(accounts = [], withPrompt = false) {
  const prompt = withPrompt ? ['<option value="">Choose an account…</option>'] : [];
  return prompt.concat(accounts.map((account) => {
    const suffix = account.role === 'admin' ? ' (admin)' : '';
    return `<option value="${account.id}">${esc(account.name)}${suffix}</option>`;
  })).join('');
}

// Returns false while an admin is at the account picker, so no customer data
// is fetched or shown until they choose who to view.
function applyAccountState(me) {
  accountState = me;
  if (!me.isAdmin) {
    accountSwitcher.classList.add('hidden');
    document.body.classList.remove('admin-picking');
    adminPicker.classList.add('hidden');
    return true;
  }
  accountSelect.innerHTML = accountOptions(me.accounts, true);
  adminPickerSelect.innerHTML = accountOptions(me.accounts, true);
  const chosen = me.viewingAsSelf ? '' : String(me.viewingId);
  accountSelect.value = chosen;
  adminPickerSelect.value = chosen;
  accountSwitcher.classList.remove('hidden');
  document.body.classList.toggle('admin-picking', me.viewingAsSelf);
  adminPicker.classList.toggle('hidden', !me.viewingAsSelf);
  return !me.viewingAsSelf;
}

async function viewAccount(userId) {
  if (!accountState?.isAdmin) return;
  try {
    await api('/api/accounts/view', { method: 'PUT', body: JSON.stringify({ userId }) });
  } catch (err) {
    await showNotice(err.message);
    return;
  }
  location.reload();
}

accountSelect.addEventListener('change', () => viewAccount(accountSelect.value));
document.getElementById('admin-picker-open').addEventListener('click', () => {
  if (!adminPickerSelect.value) {
    adminPickerSelect.focus();
    return;
  }
  viewAccount(adminPickerSelect.value);
});

const dashboardActive = () => !document.body.classList.contains('admin-picking');

async function boot() {
  let me;
  try {
    me = await api('/api/me');
  } catch {
    return;
  }
  if (!applyAccountState(me)) return;
  try {
    await loadPlacements();
    startOnboarding();
  } catch { /* openDialog retries when needed */ }
  refresh();
  pollAlerts();
}

setInterval(() => { if (dashboardActive()) pollAlerts(); }, 5000);
setInterval(() => { if (dashboardActive()) refresh(); }, 3000);
boot();
