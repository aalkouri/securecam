/* global Hls */
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const feedHint = document.getElementById('feed-hint');
const tpl = document.getElementById('tile-template');
const dialog = document.getElementById('cam-dialog');
const camForm = document.getElementById('cam-form');
const camError = document.getElementById('cam-error');
const testResult = document.getElementById('cam-test-result');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function validPlainName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(String(value).trim());
}

function validateCameraInput(payload) {
  if (!validPlainName(payload.name)) {
    throw new Error('Camera name may only use letters, numbers, spaces and hyphens');
  }
  if (payload.newBuilding && !validPlainName(payload.newBuilding)) {
    throw new Error('Building name may only use letters, numbers, spaces and hyphens');
  }
  if (payload.newRoom && !validPlainName(payload.newRoom)) {
    throw new Error('Room name may only use letters, numbers, spaces and hyphens');
  }
  if (payload.type === 'reolink') {
    if (!/^[A-Za-z0-9.-]+$/.test(payload.host.trim())) {
      throw new Error('IP address may only use letters, numbers, dots and hyphens');
    }
    if (!/^[A-Za-z0-9]+$/.test(payload.username.trim())) {
      throw new Error('Username may only use letters and numbers');
    }
  } else if (payload.url && !/^[A-Za-z0-9._~:/?#@&=+$,%-]+$/.test(payload.url.trim())) {
    throw new Error('Stream URL contains unsupported characters');
  }
}

function cameraNameExists(name, exceptId = null) {
  const wanted = name.trim().toLowerCase();
  return cameras.some((cam) => cam.id !== exceptId && cam.name.toLowerCase() === wanted);
}

function suggestedCameraName(roomName) {
  const base = `${roomName} - CAMERA`;
  if (!cameraNameExists(base)) return base;
  let n = 2;
  while (cameraNameExists(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

const tiles = new Map(); // id -> { el, player, camera }
let editingId = null;
let dialogPlacement = null;
let buildings = [];
let cameras = [];
let selectedCameraId = '';
// The feed is remembered per viewed account so an admin switching between
// customers does not inherit someone else's last-viewed camera.
const feedKey = () => `securecam.feed.${accountState?.viewingId ?? 'current'}`;

// Admin account switching.
const accountSwitcher = document.getElementById('account-switcher');
const accountSelect = document.getElementById('account-select');
const adminPicker = document.getElementById('admin-picker');
const adminPickerSelect = document.getElementById('admin-picker-select');
let accountState = null;

// Floor-plan editor state.
const planSelect = document.getElementById('floorplan-building');
const planBoard = document.getElementById('floorplan-board');
const planOutline = document.getElementById('floorplan-outline');
const planOutlineName = document.getElementById('floorplan-outline-name');
const planOutlineResize = document.getElementById('floorplan-building-resize');
const planRoomsEl = document.getElementById('floorplan-rooms');
const planOutsideAdd = document.getElementById('floorplan-add-outside');
const planOutsideLabel = document.getElementById('floorplan-outside-label');
const planOutsideMarkers = document.getElementById('floorplan-outside-markers');
const planEmpty = document.getElementById('floorplan-empty');
const roomTpl = document.getElementById('room-template');
const cameraMarkerTpl = document.getElementById('camera-marker-template');
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
let activeBuildingDrag = null;
let activeBuildingResize = null;
const planCameraEls = new Map(); // camera id -> floor-plan marker
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

function cameraLocation(camera) {
  const room = camera.outside ? 'Outside' : (camera.roomName || 'Unassigned');
  return `${camera.buildingName || 'Unassigned'} / ${room}`;
}

function createTile(camera) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const tile = { el, camera, player: null };
  el.querySelector('.name').textContent = camera.name;
  el.querySelector('.location').textContent = cameraLocation(camera);
  el.querySelector('.video-box').addEventListener('click', () => openFocus(tile.camera));
  el.querySelector('.tools').addEventListener('click', async (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'edit') openDialog(tile.camera);
    if (action === 'open') openFocus(tile.camera);
  });
  grid.appendChild(el);
  tiles.set(camera.id, tile);
  return tile;
}

function removeTile(id) {
  const tile = tiles.get(id);
  if (!tile) return;
  clearTimeout(tile.selectTimer);
  tile.player?.();
  tile.el.remove();
  tiles.delete(id);
}

function updateFeedHint() {
  if (!feedHint) return;
  const camera = cameras.find((c) => c.id === selectedCameraId);
  feedHint.textContent = camera
    ? `Showing ${camera.name}. Click a camera below to change the feed.`
    : 'Click a camera below to show its feed here.';
}

// Only one tile is mounted at a time. Clicking a floor-plan marker replaces the
// feed with that camera and remembers the choice for the next visit.
function selectCamera(id) {
  const camera = cameras.find((c) => c.id === id);
  if (!camera) return;
  selectedCameraId = id;
  localStorage.setItem(feedKey(), id);
  for (const otherId of [...tiles.keys()]) {
    if (otherId !== id) removeTile(otherId);
  }
  const tile = tiles.get(id) || createTile(camera);
  tile.camera = camera;
  tile.el.querySelector('.name').textContent = camera.name;
  tile.el.querySelector('.location').textContent = cameraLocation(camera);
  renderStatus(tile);
  grid.prepend(tile.el);
  tile.el.classList.remove('selected');
  void tile.el.offsetWidth; // restart the flash animation on repeated clicks
  tile.el.classList.add('selected');
  clearTimeout(tile.selectTimer);
  tile.selectTimer = setTimeout(() => tile.el.classList.remove('selected'), 1600);
  updateFeedHint();
  renderFloorplanCameras();
  window.scrollTo(0, 0);
}

// A camera's stream config changed; the tile must reconnect.
function configKey(c) {
  return JSON.stringify([c.type, c.url, c.subUrl, c.host, c.port, c.username]);
}

async function refresh() {
  try {
    cameras = await api('/api/cameras');
  } catch {
    return;
  }
  empty.classList.toggle('hidden', cameras.length > 0);
  feedHint?.classList.toggle('hidden', cameras.length === 0);
  cameraCounts = new Map();
  for (const camera of cameras) {
    if (!camera.buildingId || !camera.roomId) continue;
    cameraCounts.set(camera.roomId, (cameraCounts.get(camera.roomId) || 0) + 1);
  }
  updateFloorplanCounts();
  if (!cameras.some((camera) => camera.id === selectedCameraId)) {
    selectedCameraId = cameras[0]?.id || '';
    if (selectedCameraId) localStorage.setItem(feedKey(), selectedCameraId);
  }
  for (const [id] of tiles) {
    if (id !== selectedCameraId) removeTile(id);
  }
  for (const camera of cameras) {
    if (camera.id !== selectedCameraId) continue;
    const tile = tiles.get(camera.id) || createTile(camera);
    if (configKey(tile.camera) !== configKey(camera)) tile.el.dataset.state = '';
    tile.camera = camera;
    tile.el.querySelector('.name').textContent = camera.name;
    tile.el.querySelector('.location').textContent = cameraLocation(camera);
    renderStatus(tile);
  }
  updateFeedHint();
  renderFloorplanCameras();
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
// Accounts can be created without any building. Until one exists, this guide
// owns the screen: name a building, then a room. Finishing reveals the main
// screen with that building and room already selected on the floor plan.
const onboardingState = { active: false, step: 1, building: null };
const onboardingEl = document.getElementById('onboarding');
const onboardingError = document.getElementById('onboarding-error');
const onboardingNext = document.getElementById('onboarding-next');

function setBehindInert(inert) {
  // Make every screen element outside the guide unreachable by mouse or
  // keyboard. The overlay covers the page, but inert also hides background
  // controls from focus order and assistive technology.
  for (const el of document.body.children) {
    if (el !== onboardingEl && el.tagName !== 'SCRIPT') el.inert = inert;
  }
}

function renderOnboarding() {
  onboardingNext.textContent = onboardingState.step === 1 ? 'Next' : 'Finish';
  onboardingError.textContent = '';
  field('onboarding-step-1').classList.toggle('hidden', onboardingState.step !== 1);
  field('onboarding-step-2').classList.toggle('hidden', onboardingState.step !== 2);
}

function startOnboarding() {
  if (onboardingState.active || buildings.length) return;
  onboardingState.active = true;
  onboardingState.step = 1;
  onboardingState.building = null;
  field('onboarding-building-name').value = '';
  field('onboarding-room-name').value = '';
  renderOnboarding();
  onboardingEl.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  setBehindInert(true);
  field('onboarding-building-name').focus();
}

function finishOnboarding() {
  onboardingState.active = false;
  onboardingState.building = null;
  onboardingEl.classList.add('hidden');
  document.body.classList.remove('no-scroll');
  setBehindInert(false);
}

async function advanceOnboarding() {
  if (!onboardingState.active) return;
  onboardingError.textContent = '';
  onboardingNext.disabled = true;
  try {
    if (onboardingState.step === 1) {
      const name = field('onboarding-building-name').value.trim();
      if (!name) throw new Error('Enter a building name to continue.');
      if (!validPlainName(name)) throw new Error('Use letters, numbers, spaces and hyphens only.');
      const building = await api('/api/buildings', { method: 'POST', body: JSON.stringify({ name }) });
      onboardingState.building = building;
      onboardingState.step = 2;
      field('onboarding-room-name').value = '';
      renderOnboarding();
      field('onboarding-room-name').focus();
    } else {
      const name = field('onboarding-room-name').value.trim();
      if (!name) throw new Error('Enter a room name to continue.');
      if (!validPlainName(name)) throw new Error('Use letters, numbers, spaces and hyphens only.');
      await api(`/api/buildings/${onboardingState.building.id}/rooms`, {
        method: 'POST', body: JSON.stringify({ name }),
      });
      // Select the new building before refreshing so the main screen opens
      // on the building and room that were just created.
      localStorage.setItem('securecam.building', onboardingState.building.id);
      await loadPlacements();
      finishOnboarding();
      return;
    }
  } catch (err) {
    onboardingError.textContent = err.message;
  } finally {
    onboardingNext.disabled = false;
  }
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
  const fixed = Boolean(dialogPlacement?.fixed);
  const creatingBuilding = !fixed && field('cam-building').value === '__new__';
  const creatingRoom = !fixed && (creatingBuilding || field('cam-room').value === '__new__');
  field('cam-placement-fields').classList.toggle('hidden', fixed);
  field('cam-building').disabled = fixed;
  field('cam-building').required = !fixed;
  field('cam-new-building').classList.toggle('hidden', !creatingBuilding);
  field('cam-new-building').required = creatingBuilding;
  field('room-select-field').classList.toggle('placeholder', creatingBuilding);
  field('cam-room').disabled = fixed || creatingBuilding;
  field('cam-room').required = !fixed && !creatingBuilding;
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
const PLAN_TITLE_CUSHION_PX = 16;
let measuredMinRoomPixels = null;
let planResizeTimer = null;

const planPercent = (value, min, max) => {
  const n = Number(value);
  return Number(Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)).toFixed(2));
};

function currentPlanBuilding() {
  return buildings.find((building) => building.id === planSelect.value) || null;
}

// Measure the smallest room that still keeps the + camera button inside it.
function minRoomPixels() {
  if (measuredMinRoomPixels) return measuredMinRoomPixels;
  const sample = roomTpl.content.firstElementChild.cloneNode(true);
  sample.style.cssText = 'position:absolute;left:-10000px;top:0;width:320px;height:auto;visibility:hidden;pointer-events:none;';
  document.body.appendChild(sample);
  const box = sample.getBoundingClientRect();
  const add = sample.querySelector('.plan-add-cam').getBoundingClientRect();
  const close = sample.querySelector('.plan-room-close').getBoundingClientRect();
  measuredMinRoomPixels = {
    w: Math.max(120, Math.ceil(Math.max(add.right, close.right) - box.left + 16)),
    h: Math.max(88, Math.ceil(add.bottom - box.top + 16)),
  };
  sample.remove();
  return measuredMinRoomPixels;
}

// Rooms cannot enter the strip reserved for the building name, and cannot get
// smaller than the measured contents. Everything is stored as percentages.
function planLimits() {
  const bounds = planRoomsEl.getBoundingClientRect();
  const title = planOutlineName.getBoundingClientRect();
  const width = bounds.width || 1000;
  const height = bounds.height || 560;
  const titleBottom = title.height ? title.bottom - bounds.top : 32;
  const min = minRoomPixels();
  const minW = planPercent((min.w / width) * 100, 14, 92);
  const minH = planPercent((min.h / height) * 100, 18, 80);
  const reservedY = Math.max(10, ((titleBottom + PLAN_TITLE_CUSHION_PX) / height) * 100);
  return {
    minY: planPercent(reservedY, 10, 100 - minH),
    minW,
    minH,
  };
}

function constrainLayout(layout = {}, limits = planLimits()) {
  const minW = Math.min(limits.minW, 92);
  const minH = Math.min(limits.minH, 100 - limits.minY);
  const x = planPercent(layout.x, 0, 100 - minW);
  const w = planPercent(layout.w, minW, 100 - x);
  const y = planPercent(layout.y, Math.min(limits.minY, 100 - minH), 100 - minH);
  const h = planPercent(layout.h, minH, 100 - y);
  return { x, y, w, h };
}

function normalizeLayout(layout = {}) {
  return constrainLayout(layout);
}

function setRoomVars(el, layout) {
  const { x, y, w, h } = normalizeLayout(layout);
  el.style.setProperty('--x', x.toFixed(2));
  el.style.setProperty('--y', y.toFixed(2));
  el.style.setProperty('--w', w.toFixed(2));
  el.style.setProperty('--h', h.toFixed(2));
}

function buildingLayoutOf(building) {
  return {
    x: Number(building?.planX ?? 12),
    y: Number(building?.planY ?? 14),
    w: Number(building?.planW ?? 80),
    h: Number(building?.planH ?? 75),
  };
}

function setBuildingVars(layout) {
  planOutline.style.setProperty('--x', Number(layout.x).toFixed(2));
  planOutline.style.setProperty('--y', Number(layout.y).toFixed(2));
  planOutline.style.setProperty('--w', Number(layout.w).toFixed(2));
  planOutline.style.setProperty('--h', Number(layout.h).toFixed(2));
}

function buildingLimits() {
  const bounds = planBoard.getBoundingClientRect();
  const style = getComputedStyle(planOutline);
  const minW = Math.min(85, Math.max(20, ((parseFloat(style.minWidth) || 420) / bounds.width) * 100));
  const minH = Math.min(80, Math.max(25, ((parseFloat(style.minHeight) || 360) / bounds.height) * 100));
  return { minW, minH };
}

function constrainBuildingLayout(layout) {
  const { minW, minH } = buildingLimits();
  const x = planPercent(layout.x, 2, 100 - minW - 2);
  const y = planPercent(layout.y, 8, 100 - minH - 2);
  return {
    x,
    y,
    w: planPercent(layout.w, minW, Math.min(85, 100 - x - 2)),
    h: planPercent(layout.h, minH, Math.min(80, 100 - y - 2)),
  };
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
  const building = currentPlanBuilding();
  planOutlineName.textContent = building?.name || '';
  planOutlineName.title = planOutlineName.textContent ? `Rename ${planOutlineName.textContent}` : 'Rename building';
  setBuildingVars(buildingLayoutOf(building));
  renderFloorplanRooms();
  renderFloorplanCameras();
}

function updateFloorplanCounts() {
  const building = currentPlanBuilding();
  const outside = cameras.filter((c) => c.outside && c.buildingId === building?.id).length;
  planOutsideAdd.title = outside
    ? `${outside} camera${outside === 1 ? '' : 's'} outside the building`
    : 'Add a camera to the area outside the building';
}

// A room must leave every camera marker inside it clear. Returning false
// blocks the drag/resize and the saved layout is left untouched.
function roomFitsCameras(el, layout) {
  const original = el.getAttribute('style');
  setRoomVars(el, layout);
  const ok = [...el.querySelectorAll('.plan-camera')].every((marker) => {
    const room = el.getBoundingClientRect();
    const box = marker.getBoundingClientRect();
    return box.left >= room.left && box.right <= room.right
      && box.top >= room.top && box.bottom <= room.bottom;
  });
  if (!ok && original !== null) el.setAttribute('style', original);
  return ok;
}

// The black outline may grow around its rooms, but it can never shrink across
// a room or inside camera, cover an outside camera, or cover the outside button.
function buildingFitsContents(layout) {
  const original = planOutline.getAttribute('style');
  setBuildingVars(layout);
  const box = planOutline.getBoundingClientRect();
  const contains = (other) => other.left >= box.left && other.right <= box.right
    && other.top >= box.top && other.bottom <= box.bottom;
  let ok = true;
  for (const el of planRoomsEl.querySelectorAll('.plan-room')) {
    if (!contains(el.getBoundingClientRect())) { ok = false; break; }
  }
  if (ok) {
    for (const el of planCameraEls.values()) {
      if (!el.isConnected) continue;
      const other = el.getBoundingClientRect();
      if (el.parentElement === planOutsideMarkers) {
        if (rectsOverlap(box, other, 0)) { ok = false; break; }
      } else if (!contains(other)) {
        ok = false;
        break;
      }
    }
  }
  if (ok && rectsOverlap(box, planOutsideAdd.getBoundingClientRect(), 0)) ok = false;
  if (ok && rectsOverlap(box, planOutsideLabel.getBoundingClientRect(), 0)) ok = false;
  if (!ok && original !== null) planOutline.setAttribute('style', original);
  return ok;
}

async function saveBuildingLayout(building, layout) {
  try {
    const saved = await api(`/api/buildings/${encodeURIComponent(building.id)}/layout`, {
      method: 'PUT', body: JSON.stringify({
        planX: layout.x, planY: layout.y, planW: layout.w, planH: layout.h,
      }),
    });
    building.planX = saved.planX;
    building.planY = saved.planY;
    building.planW = saved.planW;
    building.planH = saved.planH;
    building.planRight = saved.planRight;
    building.planBottom = saved.planBottom;
  } catch {
    await loadPlacements().catch(() => {});
  }
}

function startBuildingDrag(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.target.closest('button, .plan-resize, .plan-room, .plan-camera')) return;
  e.preventDefault();
  const building = currentPlanBuilding();
  if (!building) return;
  const origin = constrainBuildingLayout(buildingLayoutOf(building));
  activeBuildingDrag = {
    id: e.pointerId, bounds: planBoard.getBoundingClientRect(),
    origin, current: origin, moved: false,
  };
  planOutline.classList.add('dragging');
  planOutline.setPointerCapture?.(e.pointerId);

  const onMove = (ev) => {
    const state = activeBuildingDrag;
    if (!state || ev.pointerId !== state.id) return;
    const wanted = constrainBuildingLayout({
      ...state.origin,
      x: state.origin.x + (ev.clientX - e.clientX) / state.bounds.width * 100,
      y: state.origin.y + (ev.clientY - e.clientY) / state.bounds.height * 100,
    });
    if (!buildingFitsContents(wanted)) return;
    state.current = wanted;
    state.moved = true;
  };

  const onEnd = (ev) => {
    const state = activeBuildingDrag;
    if (!state || ev.pointerId !== state.id) return;
    planOutline.removeEventListener('pointermove', onMove);
    planOutline.removeEventListener('pointerup', onEnd);
    planOutline.removeEventListener('pointercancel', onEnd);
    planOutline.releasePointerCapture?.(ev.pointerId);
    planOutline.classList.remove('dragging');
    activeBuildingDrag = null;
    if (state.moved) saveBuildingLayout(building, state.current);
  };

  planOutline.addEventListener('pointermove', onMove);
  planOutline.addEventListener('pointerup', onEnd);
  planOutline.addEventListener('pointercancel', onEnd);
}

function startBuildingResize(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  e.stopPropagation();
  const building = currentPlanBuilding();
  if (!building) return;
  const origin = constrainBuildingLayout(buildingLayoutOf(building));
  activeBuildingResize = {
    id: e.pointerId, bounds: planBoard.getBoundingClientRect(),
    origin, current: origin, moved: false,
  };
  planOutlineResize.setPointerCapture?.(e.pointerId);

  const onMove = (ev) => {
    const state = activeBuildingResize;
    if (!state || ev.pointerId !== state.id) return;
    const wanted = constrainBuildingLayout({
      ...state.origin,
      w: state.origin.w + (ev.clientX - e.clientX) / state.bounds.width * 100,
      h: state.origin.h + (ev.clientY - e.clientY) / state.bounds.height * 100,
    });
    if (!buildingFitsContents(wanted)) return;
    state.current = wanted;
    state.moved = true;
  };

  const onEnd = (ev) => {
    const state = activeBuildingResize;
    if (!state || ev.pointerId !== state.id) return;
    planOutlineResize.removeEventListener('pointermove', onMove);
    planOutlineResize.removeEventListener('pointerup', onEnd);
    planOutlineResize.removeEventListener('pointercancel', onEnd);
    planOutlineResize.releasePointerCapture?.(ev.pointerId);
    activeBuildingResize = null;
    if (state.moved) saveBuildingLayout(building, state.current);
  };

  planOutlineResize.addEventListener('pointermove', onMove);
  planOutlineResize.addEventListener('pointerup', onEnd);
  planOutlineResize.addEventListener('pointercancel', onEnd);
}

planOutline.addEventListener('pointerdown', startBuildingDrag);
planOutline.addEventListener('keydown', (e) => {
  if (e.target !== planOutline) return;
  const step = e.shiftKey ? 5 : 1;
  let dx = 0;
  let dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else return;
  e.preventDefault();
  const building = currentPlanBuilding();
  if (!building) return;
  const origin = constrainBuildingLayout(buildingLayoutOf(building));
  const wanted = constrainBuildingLayout({ ...origin, x: origin.x + dx, y: origin.y + dy });
  if (!buildingFitsContents(wanted)) return;
  saveBuildingLayout(building, wanted);
});
planOutlineResize.addEventListener('pointerdown', startBuildingResize);
planOutlineResize.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 5 : 1;
  let dx = 0;
  let dy = 0;
  if (e.key === 'ArrowLeft') dx = -step;
  else if (e.key === 'ArrowRight') dx = step;
  else if (e.key === 'ArrowUp') dy = -step;
  else if (e.key === 'ArrowDown') dy = step;
  else return;
  e.preventDefault();
  const building = currentPlanBuilding();
  if (!building) return;
  const origin = constrainBuildingLayout(buildingLayoutOf(building));
  const wanted = constrainBuildingLayout({ ...origin, w: origin.w + dx, h: origin.h + dy });
  if (!buildingFitsContents(wanted)) return;
  saveBuildingLayout(building, wanted);
});

// ---------- camera markers ----------
const markerOf = (camera) => camera?.marker || { x: 50, y: 50, rotation: 0 };

function setMarkerVars(el, marker = {}) {
  el.style.setProperty('--cx', Number(marker.x ?? 50).toFixed(2));
  el.style.setProperty('--cy', Number(marker.y ?? 50).toFixed(2));
  el.style.setProperty('--rot', `${Number(marker.rotation ?? 0)}deg`);
}

function rectsOverlap(a, b, padding = 2) {
  return !(a.right + padding <= b.left || b.right + padding <= a.left
    || a.bottom + padding <= b.top || b.bottom + padding <= a.top);
}

// One marker may not sit on another, and a marker may not cover the controls
// reserved for the room or the outside area.
function markerCollision(el) {
  const rect = el.getBoundingClientRect();
  for (const other of planCameraEls.values()) {
    if (other === el || !other.isConnected) continue;
    if (rectsOverlap(rect, other.getBoundingClientRect())) return other;
  }
  if (el.parentElement === planOutsideMarkers) {
    if (rectsOverlap(rect, planOutsideAdd.getBoundingClientRect())) return planOutsideAdd;
    if (rectsOverlap(rect, planOutsideLabel.getBoundingClientRect())) return planOutsideLabel;
  }
  return null;
}

function markerHitsRoomControls(el) {
  const room = el.parentElement;
  if (!room?.classList.contains('plan-room')) return false;
  const box = el.getBoundingClientRect();
  for (const selector of ['.plan-room-name', '.plan-room-close', '.plan-add-cam', '.plan-resize']) {
    const control = room.querySelector(selector);
    if (control && rectsOverlap(box, control.getBoundingClientRect(), 0)) return true;
  }
  return false;
}

// Twelve clockwise positions around a room: three per side, never in a corner.
// Padding comes from the marker's own size so even a small room stays safe.
function cameraEdgeSpots(el) {
  const box = el.parentElement.getBoundingClientRect();
  const padX = Math.min(45, (el.offsetWidth / 2 + 6) / box.width * 100);
  const padY = Math.min(45, (el.offsetHeight / 2 + 6) / box.height * 100);
  const leftX = padX;
  const rightX = 100 - padX;
  const topY = padY;
  const bottomY = 100 - padY;
  const alongX = [0.25, 0.5, 0.75].map((f) => planPercent(f * 100, leftX, rightX));
  const alongY = [0.25, 0.5, 0.75].map((f) => planPercent(f * 100, topY, bottomY));
  return [
    { x: alongX[1], y: topY }, { x: alongX[2], y: topY },
    { x: rightX, y: alongY[0] }, { x: rightX, y: alongY[1] }, { x: rightX, y: alongY[2] },
    { x: alongX[2], y: bottomY }, { x: alongX[1], y: bottomY }, { x: alongX[0], y: bottomY },
    { x: leftX, y: alongY[2] }, { x: leftX, y: alongY[1] }, { x: leftX, y: alongY[0] },
    { x: alongX[0], y: topY },
  ];
}

// Outside cameras use the same twelve-spot pattern around the building walls.
function outsideCameraSpots(el) {
  const board = planBoard.getBoundingClientRect();
  const building = planOutline.getBoundingClientRect();
  const padX = (el.offsetWidth / 2 + 8) / board.width * 100;
  const padY = (el.offsetHeight / 2 + 8) / board.height * 100;
  const left = (building.left - board.left) / board.width * 100;
  const right = (building.right - board.left) / board.width * 100;
  const top = (building.top - board.top) / board.height * 100;
  const bottom = (building.bottom - board.top) / board.height * 100;
  const topY = planPercent(top - padY, padY, 100 - padY);
  const bottomY = planPercent(bottom + padY, padY, 100 - padY);
  const leftX = planPercent(left - padX, padX, 100 - padX);
  const rightX = planPercent(right + padX, padX, 100 - padX);
  const mix = (a, b, f) => a + (b - a) * f;
  const alongX = [0.25, 0.5, 0.75].map((f) => planPercent(mix(left, right, f), padX, 100 - padX));
  const alongY = [0.25, 0.5, 0.75].map((f) => planPercent(mix(top, bottom, f), padY, 100 - padY));
  return [
    { x: alongX[1], y: topY }, { x: alongX[2], y: topY },
    { x: rightX, y: alongY[0] }, { x: rightX, y: alongY[1] }, { x: rightX, y: alongY[2] },
    { x: alongX[2], y: bottomY }, { x: alongX[1], y: bottomY }, { x: alongX[0], y: bottomY },
    { x: leftX, y: alongY[2] }, { x: leftX, y: alongY[1] }, { x: leftX, y: alongY[0] },
    { x: alongX[0], y: topY },
  ];
}

function spotIndex(spots, marker) {
  return spots.findIndex((spot) => Math.abs(spot.x - marker.x) < 0.6
    && Math.abs(spot.y - marker.y) < 0.6);
}

// The button shows where the next clockwise step goes: right along the top,
// down the right side, left along the bottom, up the left side.
const POSITION_ARROWS = ['→', '↓', '←', '↑'];
const POSITION_DIRECTIONS = ['right', 'down', 'left', 'up'];

function updateCameraPositionIcon(el, marker) {
  const button = el.querySelector('.plan-camera-position');
  if (!button) return;
  const spots = el.parentElement === planOutsideMarkers
    ? outsideCameraSpots(el)
    : cameraEdgeSpots(el);
  let index = spotIndex(spots, marker);
  if (index < 0) {
    let best = Infinity;
    spots.forEach((spot, i) => {
      const distance = (spot.x - marker.x) ** 2 + (spot.y - marker.y) ** 2;
      if (distance < best) { best = distance; index = i; }
    });
  }
  const spot = spots[Math.max(0, index)];
  // The last top spot wraps back to the first one, so detect the side from
  // coordinates instead of assuming three positions per side.
  let edge = 3;
  if (Math.abs(spot.y - spots[0].y) < 0.6) edge = 0;
  else if (Math.abs(spot.x - spots[2].x) < 0.6) edge = 1;
  else if (Math.abs(spot.y - spots[5].y) < 0.6) edge = 2;
  button.textContent = POSITION_ARROWS[edge];
  button.title = `Move camera ${POSITION_DIRECTIONS[edge]} to the next position`;
  button.setAttribute('aria-label', button.title);
}

function spotIsFree(el, spot, rotation) {
  setMarkerVars(el, { ...spot, rotation });
  if (markerCollision(el)) return false;
  if (el.parentElement === planOutsideMarkers) {
    return !rectsOverlap(el.getBoundingClientRect(), planOutline.getBoundingClientRect(), 0);
  }
  return !markerHitsRoomControls(el);
}

async function saveCameraMarker(id, marker) {
  try {
    const saved = await api(`/api/cameras/${encodeURIComponent(id)}/marker`, {
      method: 'PUT', body: JSON.stringify(marker),
    });
    const camera = cameras.find((c) => c.id === id);
    if (camera) camera.marker = saved;
    return saved;
  } catch {
    await loadPlacements().catch(() => {});
    return null;
  }
}

async function rotateCameraMarker(id) {
  const camera = cameras.find((c) => c.id === id);
  if (!camera) return;
  const marker = markerOf(camera);
  const saved = await saveCameraMarker(id, { ...marker, rotation: (marker.rotation + 45) % 360 });
  const el = planCameraEls.get(id);
  if (saved && el) {
    setMarkerVars(el, saved);
    updateCameraPositionIcon(el, saved);
  }
}

// The top-left circle steps the marker through its twelve edge positions.
async function cycleCameraPosition(id) {
  const camera = cameras.find((c) => c.id === id);
  const el = planCameraEls.get(id);
  if (!camera || !el) return;
  const marker = markerOf(camera);
  const spots = el.parentElement === planOutsideMarkers
    ? outsideCameraSpots(el)
    : cameraEdgeSpots(el);
  const current = spotIndex(spots, marker);
  let chosen = null;
  for (let step = 1; step <= spots.length; step += 1) {
    const spot = spots[(current + step) % spots.length];
    if (spotIsFree(el, spot, marker.rotation)) {
      chosen = spot;
      break;
    }
  }
  if (!chosen) {
    setMarkerVars(el, marker);
    updateCameraPositionIcon(el, marker);
    return;
  }
  const saved = await saveCameraMarker(id, { ...chosen, rotation: marker.rotation });
  const final = saved || marker;
  setMarkerVars(el, final);
  updateCameraPositionIcon(el, final);
}

function makeCameraMarker(camera) {
  const el = cameraMarkerTpl.content.firstElementChild.cloneNode(true);
  el.dataset.cameraId = camera.id;
  el.querySelector('.plan-camera-name').textContent = camera.name;
  const position = el.querySelector('.plan-camera-position');
  const rotate = el.querySelector('.plan-camera-rotate');
  // Keep the room's drag handler from capturing pointer events on the marker;
  // a plain click on the icon or name must be able to select this camera.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  for (const button of [position, rotate]) {
    button.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
  position.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleCameraPosition(camera.id);
  });
  rotate.addEventListener('click', (e) => {
    e.stopPropagation();
    rotateCameraMarker(camera.id);
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    selectCamera(camera.id);
  });
  el.addEventListener('keydown', (e) => handleCameraKeys(e, camera.id, el));
  return el;
}

function renderFloorplanCameras() {
  if (activeBuildingDrag || activeBuildingResize) return;
  const building = currentPlanBuilding();
  const rooms = [...planRoomsEl.querySelectorAll('.plan-room')];
  const seen = new Set();
  for (const camera of cameras) {
    if (!building || camera.buildingId !== building.id) continue;
    let parent = planOutsideMarkers;
    if (!camera.outside) {
      parent = rooms.find((room) => room.dataset.roomId === camera.roomId);
      if (!parent) continue;
    }
    seen.add(camera.id);
    let el = planCameraEls.get(camera.id);
    if (!el) {
      el = makeCameraMarker(camera);
      planCameraEls.set(camera.id, el);
    }
    if (el.parentElement !== parent) parent.appendChild(el);
    el.querySelector('.plan-camera-name').textContent = camera.name;
    el.classList.toggle('active', camera.id === selectedCameraId);
    const marker = markerOf(camera);
    setMarkerVars(el, marker);
    updateCameraPositionIcon(el, marker);
  }
  for (const [id, el] of planCameraEls) {
    if (!seen.has(id)) {
      el.remove();
      planCameraEls.delete(id);
    }
  }
}

function handleCameraKeys(e, id, el) {
  if (e.target.closest('button')) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    selectCamera(id);
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    e.stopPropagation();
    rotateCameraMarker(id);
    return;
  }
  if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    e.stopPropagation();
    cycleCameraPosition(id);
  }
}

// Re-clamp the layout when the board changes size; a room that was big enough
// on a wide screen must not become too small on a narrow one.
window.addEventListener('resize', () => {
  clearTimeout(planResizeTimer);
  planResizeTimer = setTimeout(() => {
    if (!activeRoomDrag && !activeRoomResize && !activeBuildingDrag && !activeBuildingResize) {
      renderFloorplanRooms();
      renderFloorplanCameras();
    }
  }, 120);
});

function renderFloorplanRooms() {
  planRoomsEl.innerHTML = '';
  const building = currentPlanBuilding();
  const rooms = building?.rooms || [];
  planEmpty.classList.toggle('hidden', rooms.length > 0);
  for (const room of rooms) {
    const el = roomTpl.content.firstElementChild.cloneNode(true);
    el.dataset.roomId = room.id;
    el.setAttribute('aria-label', `${room.name} room. Drag to move, corner icon to resize.`);
    setRoomVars(el, room);
    const nameButton = el.querySelector('.plan-room-name');
    nameButton.textContent = room.name;
    nameButton.title = `Rename ${room.name}`;
    nameButton.addEventListener('pointerdown', (e) => e.stopPropagation());
    nameButton.addEventListener('click', (e) => {
      e.stopPropagation();
      openRename('room', room);
    });
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
  if (e.target.closest('button, .plan-camera')) return;
  e.preventDefault();
  const bounds = planRoomsEl.getBoundingClientRect();
  const limits = planLimits();
  const layout = constrainLayout(room, limits);
  activeRoomDrag = {
    id: e.pointerId, el, room, bounds, limits,
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
    drag.layout.y = planPercent(drag.origin.y + dy, drag.limits.minY, 100 - drag.layout.h);
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) drag.moved = true;
    if (!roomFitsCameras(drag.el, drag.layout)) return;
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
  const limits = planLimits();
  const layout = constrainLayout(room, limits);
  activeRoomResize = {
    id: e.pointerId, el, room, bounds, limits,
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
    resize.layout.w = planPercent(resize.origin.w + dx, resize.limits.minW, 100 - resize.origin.x);
    resize.layout.h = planPercent(resize.origin.h + dy, resize.limits.minH, 100 - resize.origin.y);
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) resize.moved = true;
    if (!roomFitsCameras(resize.el, resize.layout)) return;
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
  const limits = planLimits();
  const layout = constrainLayout(room, limits);
  layout.w = planPercent(layout.w + dx, limits.minW, 100 - layout.x);
  layout.h = planPercent(layout.h + dy, limits.minH, 100 - layout.y);
  if (!roomFitsCameras(el, layout)) return;
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
  const limits = planLimits();
  const layout = constrainLayout(room, limits);
  layout.x = planPercent(layout.x + dx, 0, 100 - layout.w);
  layout.y = planPercent(layout.y + dy, limits.minY, 100 - layout.h);
  if (!roomFitsCameras(el, layout)) return;
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
  const building = currentPlanBuilding();
  planOutlineName.textContent = building?.name || '';
  planOutlineName.title = planOutlineName.textContent ? `Rename ${planOutlineName.textContent}` : 'Rename building';
  setBuildingVars(buildingLayoutOf(building));
  renderFloorplanRooms();
  renderFloorplanCameras();
});
document.getElementById('floorplan-add-room').addEventListener('click', openRoomDialog);
planOutsideAdd.addEventListener('click', () => {
  const building = currentPlanBuilding();
  if (!building) return;
  openDialog(null, { buildingId: building.id, outside: true });
});
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
  dialogPlacement = null;
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
  const outside = Boolean(camera?.outside || placement.outside);
  // A camera started from a room tile or the outside button has its placement
  // chosen already, so those fields are hidden and its values come from here.
  const fixed = !camera && (Boolean(placement.roomId) || outside);
  const buildingId = preferredBuilding && buildings.some((b) => b.id === preferredBuilding)
    ? preferredBuilding
    : (buildings[0]?.id || '__new__');
  buildingSelect.value = buildingId;
  field('cam-new-building').value = '';
  field('cam-new-room').value = '';
  dialogPlacement = {
    fixed,
    outside,
    buildingId: buildingId === '__new__' ? '' : buildingId,
    roomId: !outside && preferredRoom && preferredRoom !== '__new__' ? preferredRoom : '',
  };
  if (buildingId === '__new__') {
    field('cam-room').innerHTML = '<option value="">Choose a room…</option>';
    updatePlacementFields();
  } else {
    setRoomOptions(buildingId, preferredRoom || '');
  }
  const summary = field('cam-placement-summary');
  if (fixed) {
    const buildingName = buildings.find((b) => b.id === buildingId)?.name || 'Building';
    const roomName = buildings.find((b) => b.id === buildingId)?.rooms
      .find((r) => r.id === preferredRoom)?.name || 'Room';
    summary.innerHTML = outside
      ? `<span>🌳 ${esc(buildingName)} · Outside</span>`
      : `<span>🏢 ${esc(buildingName)}</span><span class="sep">›</span><span>🚪 ${esc(roomName)}</span>`;
    summary.classList.remove('hidden');
  } else {
    summary.textContent = '';
    summary.classList.add('hidden');
  }
  const room = buildings.find((b) => b.id === buildingId)?.rooms.find((r) => r.id === preferredRoom);
  const defaultBase = outside ? 'Outside' : room?.name;
  field('cam-name').value = camera?.name || (defaultBase ? suggestedCameraName(defaultBase) : '');
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
  const fixed = Boolean(dialogPlacement?.fixed);
  return {
    id: editingId || undefined,
    name: field('cam-name').value,
    type: field('cam-type').value,
    outside: fixed ? dialogPlacement.outside : false,
    buildingId: fixed ? dialogPlacement.buildingId : (creatingBuilding ? '' : buildingId),
    roomId: fixed ? dialogPlacement.roomId : (creatingRoom ? '' : roomId),
    newBuilding: !fixed && creatingBuilding ? field('cam-new-building').value.trim() : '',
    newRoom: !fixed && creatingRoom ? field('cam-new-room').value.trim() : '',
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
    const payload = formPayload();
    validateCameraInput(payload);
    const { grid: g, hd } = await api('/api/cameras/test', { method: 'POST', body: JSON.stringify(payload) });
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
    const payload = formPayload();
    validateCameraInput(payload);
    if (cameraNameExists(payload.name, editingId)) {
      throw new Error('A camera with that name already exists');
    }
    if (editingId) {
      await api(`/api/cameras/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const tile = tiles.get(editingId);
      if (tile) tile.el.dataset.state = '';
    } else {
      await api('/api/cameras', { method: 'POST', body: JSON.stringify(payload) });
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
const recentSightings = document.getElementById('recent-sightings');
const archivedObjectsBtn = document.getElementById('archived-objects-btn');
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
// Pop-ups are global, not one per alert. The dropdown and badge still update
// immediately; only the on-screen toast is spaced out.
let lastToastAt = 0;
let toastCooldownMs = 300_000;
// Alert clips are ten seconds long, centered on the moment the alert fired.
const CLIP_CENTER_SECONDS = 5;

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

// Archived objects stay in the sightings feed, so they are still reachable
// here even after they leave the Detections page.
function renderRecentSightings(rows) {
  recentSightings.innerHTML = rows.length
    ? rows.map((s) => `
        <button type="button" class="alert-item sighting-item" data-sighting="${esc(s.objectId)}" data-archived="${s.archived ? '1' : '0'}">
          ${s.snapshot ? `<img src="${snapshotUrl(s.snapshot)}" alt="" class="alert-thumb">` : ''}
          <span class="alert-text">
            <strong>${esc(s.objectName)}${s.archived ? ' · archived' : ''}</strong>
            <span class="hint">${esc(s.cameraName)} · ${when(s.seenAt)}</span>
          </span>
          <span class="alert-play">details</span>
        </button>`).join('')
    : '<p class="hint">No recent sightings.</p>';
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
    || (playable ? '10-second 1080p clip: five seconds before and after the alert.'
      : hasStill ? 'No clip was saved for this alert.' : 'No media was saved for this alert.');
  clipModal.classList.remove('hidden');
  if (playable) {
    clipVideo.addEventListener('loadedmetadata', seekToAlertTime);
    clipVideo.src = alert.clipUrl || `/api/alerts/${alert.id}/clip`;
    clipVideo.play()?.catch(() => {});
  }
}

// Start playback at the alert itself; the player still allows scrubbing back to
// the five seconds that led up to it.
function seekToAlertTime() {
  if (!Number.isFinite(clipVideo.duration)) return;
  clipVideo.currentTime = Math.min(CLIP_CENTER_SECONDS, Math.max(0, clipVideo.duration - 0.1));
}

function closeClip() {
  clipVideo.removeEventListener('loadedmetadata', seekToAlertTime);
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
recentSightings.addEventListener('click', (e) => {
  const button = e.target.closest('[data-sighting]');
  if (!button) return;
  e.stopPropagation();
  setAlertsOpen(false);
  openObjectDetails(button.dataset.sighting);
});
archivedObjectsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setAlertsOpen(false);
  location.href = '/detections.html?view=archived';
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
    note: `Archived 10-second alert clip from ${activeArchiveDate}, centered on the alert.`,
  });
});

async function pollAlerts() {
  try {
    const [alerts, status, sightings] = await Promise.all([
      api('/api/alerts?limit=40'),
      api('/api/detection/status'),
      api('/api/sightings?limit=8'),
    ]);
    latestAlerts = alerts;
    renderAlertList();
    renderRecentSightings(sightings);
    toastCooldownMs = Number(status.alertCooldownMs) || 300_000;
    const unread = status.unreadAlerts || 0;
    alertCount.textContent = unread;
    alertCount.classList.toggle('hidden', !unread);
    const badge = document.getElementById('detection-count');
    badge.textContent = status.objects || 0;
    badge.classList.toggle('hidden', !status.objects);
    const newest = alerts[0]?.id || 0;
    if (lastAlertId === null) lastAlertId = newest;
    else {
      const now = Date.now();
      for (const alert of alerts.filter((a) => a.id > lastAlertId).reverse()) {
        if (now - lastToastAt < toastCooldownMs) break;
        showToast(alert);
        lastToastAt = now;
      }
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
  selectedCameraId = localStorage.getItem(feedKey()) || '';
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
