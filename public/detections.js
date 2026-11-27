const $ = (id) => document.getElementById(id);

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

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
const snapshot = (name) => (name ? `/api/snapshots/${encodeURIComponent(name)}` : '');

const GROUPS = {
  person: ['person'],
  vehicles: ['car', 'truck', 'bus', 'motorcycle', 'bicycle'],
  animals: ['cat', 'dog'],
};
const GROUP_LABEL = { person: 'people', vehicles: 'vehicles', animals: 'animals' };
const DETAIL_FIELDS = [
  ['color', 'Color', 'color-options', ''],
  ['vehicleType', 'Vehicle type', 'vehicle-type-options', ''],
  ['make', 'Make', '', ''],
  ['model', 'Model', '', ''],
  ['licensePlate', 'License plate', '', 'maxlength="16"'],
  ['action', 'Action', 'action-options', ''],
  ['notes', 'Notes', '', 'maxlength="240"'],
];
const params = new URLSearchParams(location.search);
let allObjects = [];
let archivedObjects = [];
let filterObjects = [];
let eventsByObject = new Map();
let currentGroup = params.get('view') === 'archived' ? 'archived' : '';
let pendingArchiveId = null;

function selectValue(id, value) {
  const el = $(id);
  const str = String(value);
  if (![...el.options].some((option) => option.value === str)) {
    const option = document.createElement('option');
    option.value = str;
    option.textContent = `${(value / 60_000).toFixed(1)} minutes (current)`;
    el.appendChild(option);
  }
  el.value = str;
}

function renderStatus(s) {
  const line = [
    s.enabled ? 'Detection on' : 'Detection off',
    s.models?.detect ? 'detection model ready' : 'detection model missing',
    s.models?.reid ? 'ReID model ready' : 'fingerprint fallback',
    s.models?.face && s.models?.faceEmbed ? 'face models ready' : 'face models missing',
    `${s.objects || 0} objects · ${s.sightings || 0} sightings · ${s.unreadAlerts || 0} unread alerts`,
    `${s.archived || 0} archived`,
    `shown after ${s.minSightings || 3} sightings`,
  ];
  if (s.lastError) line.push(`Error: ${s.lastError}`);
  $('detection-status').textContent = line.join(' · ');
  $('detection-enabled').checked = Boolean(s.enabled);
  $('detection-interval').value = String(s.intervalMs || 4000);
  selectValue('detection-gap', s.sightingGapMs || 60_000);
  selectValue('detection-cooldown', s.alertCooldownMs || 300_000);
  $('archived-tab').textContent = `Archived (${s.archived || 0})`;
  $('objects-note').textContent = `An object appears here only after it has been seen more than ${(s.minSightings || 3) - 1} times. Unnamed objects alert only the first time they are found; they stay quiet until you confirm a name. Click a card for all its details. Use the X to stop tracking an object — it moves to the archive and keeps its history. Reload the page to see anything new.`;
}

async function loadStatus() {
  renderStatus(await api('/api/detection/status'));
}

function detailInputs(o) {
  return `<div class="detail-grid">${DETAIL_FIELDS.map(([key, label, list, extra]) => `
    <label class="${key === 'notes' ? 'wide' : ''}">${label}
      <input type="text" data-detail="${key}" value="${esc(o[key] || '')}" ${list ? `list="${list}"` : ''} ${extra} autocomplete="off">
    </label>`).join('')}</div>`;
}

function cardHistory(o) {
  const events = (eventsByObject.get(o.id) || []).slice(0, 3);
  if (!events.length) return '';
  return `<details class="card-history"><summary>Recent history</summary><ul>${events
    .map((e) => `<li><span class="hint">${when(e.seenAt)}</span> ${esc(e.kind)}: ${esc(e.value || '—')}</li>`)
    .join('')}</ul></details>`;
}

function renderObjects() {
  const archivedView = currentGroup === 'archived';
  const source = archivedView ? archivedObjects : allObjects;
  const kinds = GROUPS[currentGroup];
  const query = $('object-search').value.trim().toLowerCase();
  const visible = source.filter((o) => {
    const groupMatch = archivedView || !kinds
      ? (archivedView || !o.named)
      : kinds.includes(o.kind);
    const text = `${o.name} ${o.identifier} ${o.color} ${o.make} ${o.model} ${o.licensePlate} ${o.action}`;
    return groupMatch && (!query || text.toLowerCase().includes(query));
  });
  $('objects').innerHTML = visible.length
    ? visible.map((o) => {
      const img = snapshot(o.latestSnapshot);
      return `
        <article class="object-card ${archivedView ? 'archived' : ''}">
          <div class="object-media" data-open="${esc(o.id)}" title="View all details">
            ${img ? `<img src="${img}" alt="Latest sighting of ${esc(o.name)}">` : '<div class="no-image">No snapshot</div>'}
            ${archivedView ? '' : `<button type="button" class="object-remove" data-archive="${esc(o.id)}" title="Stop tracking and archive ${esc(o.name)}" aria-label="Archive ${esc(o.identifier)}">×</button>`}
          </div>
          <div class="object-body">
            <div class="object-title">
              <input type="text" class="object-name" data-id="${esc(o.id)}" value="${esc(o.name)}" maxlength="64" aria-label="Name">
              <span class="identifier">${esc(o.identifier)}</span>
            </div>
            <div class="card-tags">
              <span class="detail-chip">${esc(o.kind)}</span>
              ${o.named ? '<span class="detail-chip">Named</span>' : '<span class="detail-chip pending">Unnamed</span>'}
              ${archivedView ? '<span class="detail-chip archived">Archived</span>' : ''}
            </div>
            ${o.candidateName ? `<div class="hint">Possible match for ${esc(o.candidateName)} · ${pct(o.candidateScore)}</div>` : ''}
            ${detailInputs(o)}
            <div class="card-actions">
              <button type="button" class="card-btn" data-details="${esc(o.id)}">Save details</button>
              <button type="button" class="card-btn" data-open="${esc(o.id)}">View details</button>
              ${!archivedView && !o.named ? `<button type="button" class="card-btn primary-btn" data-confirm="${esc(o.id)}">Confirm name</button>` : ''}
              ${archivedView ? `<button type="button" class="card-btn primary-btn" data-restore="${esc(o.id)}">Restore to detected objects</button>` : ''}
              <button type="button" class="card-btn" data-view="${esc(o.id)}">View Sightings</button>
            </div>
            ${cardHistory(o)}
          </div>
        </article>`;
    }).join('')
    : `<p class="hint">${archivedView ? 'No archived objects yet.' : `No ${GROUP_LABEL[currentGroup] || 'objects'} to name yet. They appear here once they have been seen more than twice.`}</p>`;
}

function renderSightingFilter() {
  const select = $('sighting-filter');
  const selected = select.value;
  select.innerHTML = '<option value="">All objects</option>'
    + filterObjects.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} · ${esc(o.identifier)}${o.archived ? ' (archived)' : ''}</option>`).join('');
  select.value = selected && filterObjects.some((o) => o.id === selected) ? selected : '';
}

function activateGroup(group) {
  currentGroup = group;
  for (const button of $('object-tabs').querySelectorAll('[data-group]')) {
    button.classList.toggle('active', button.dataset.group === group);
  }
  renderObjects();
}

async function loadObjects() {
  [allObjects, archivedObjects] = await Promise.all([
    api('/api/objects?all=1'),
    api('/api/objects?all=1&archived=1'),
  ]);
  filterObjects = [...allObjects, ...archivedObjects];
  $('sighting-filter').value = params.get('object') || '';
  renderObjects();
  renderSightingFilter();
}

async function loadEvents() {
  try {
    const rows = await api('/api/object-events?limit=400');
    eventsByObject = new Map();
    for (const event of rows) {
      if (!eventsByObject.has(event.objectId)) eventsByObject.set(event.objectId, []);
      eventsByObject.get(event.objectId).push(event);
    }
    renderObjects();
  } catch { /* the detail pop-up loads history directly when it is opened */ }
}

async function loadSightings() {
  const objectId = $('sighting-filter').value;
  const rows = await api(`/api/sightings?limit=60${objectId ? `&objectId=${encodeURIComponent(objectId)}` : ''}`);
  $('sightings').innerHTML = rows.length
    ? rows.map((s) => `
        <article class="sighting-card">
          <div data-open="${esc(s.objectId)}" title="View all details">
            <img src="${snapshot(s.snapshot)}" alt="Sighting of ${esc(s.objectName)}">
          </div>
          <div class="hint" data-open="${esc(s.objectId)}">${esc(s.objectName)} · ${esc(s.identifier)}${s.archived ? ' · archived' : ''}</div>
          <div class="hint">${esc(s.cameraName)} · ${when(s.seenAt)} · ${pct(s.confidence)}</div>
        </article>`).join('')
    : '<p class="hint">No sightings yet.</p>';
}

// Load once. Nothing on this page polls; reload to pick up new detections.
async function refresh() {
  try {
    await Promise.all([loadStatus(), loadObjects(), loadSightings(), loadEvents()]);
    if (params.get('object')) {
      $('sighting-filter').value = params.get('object');
      loadSightings();
      openObjectDetails(params.get('object'));
    }
  } catch {
    // api() handles authentication failures.
  }
}

function updateCachedObject(updated) {
  allObjects = allObjects.filter((o) => o.id !== updated.id);
  archivedObjects = archivedObjects.filter((o) => o.id !== updated.id);
  (updated.archived ? archivedObjects : allObjects).push(updated);
  filterObjects = [...allObjects, ...archivedObjects];
}

$('detection-save').addEventListener('click', async () => {
  try {
    await api('/api/detection/settings', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('detection-enabled').checked,
        intervalMs: Number($('detection-interval').value),
        sightingGapMs: Number($('detection-gap').value),
        alertCooldownMs: Number($('detection-cooldown').value),
      }),
    });
    await loadStatus();
  } catch (err) {
    console.error(err);
  }
});

$('objects').addEventListener('click', async (e) => {
  const openButton = e.target.closest('[data-open]');
  const confirmButton = e.target.closest('[data-confirm]');
  const detailsButton = e.target.closest('[data-details]');
  const viewButton = e.target.closest('[data-view]');
  const archiveButton = e.target.closest('[data-archive]');
  const restoreButton = e.target.closest('[data-restore]');

  if (openButton && !confirmButton && !detailsButton && !viewButton && !archiveButton && !restoreButton) {
    openObjectDetails(openButton.dataset.open);
    return;
  }

  if (confirmButton) {
    const card = confirmButton.closest('.object-card');
    const input = card.querySelector('.object-name');
    const name = input ? input.value : (allObjects.find((o) => o.id === confirmButton.dataset.confirm)?.name || '');
    try {
      const updated = await api(`/api/objects/${confirmButton.dataset.confirm}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      updateCachedObject(updated);
      renderObjects();
      renderSightingFilter();
      loadSightings();
    } catch (err) {
      console.error(err);
    }
    return;
  }

  if (detailsButton) {
    const card = detailsButton.closest('.object-card');
    const body = {};
    for (const [key] of DETAIL_FIELDS) {
      const input = card.querySelector(`[data-detail="${key}"]`);
      if (input) body[key] = input.value;
    }
    try {
      const updated = await api(`/api/objects/${detailsButton.dataset.details}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      updateCachedObject(updated);
      renderObjects();
      renderSightingFilter();
      loadEvents();
    } catch (err) {
      console.error(err);
    }
    return;
  }

  if (viewButton) {
    $('sighting-filter').value = viewButton.dataset.view;
    loadSightings();
    $('sightings').scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (archiveButton) {
    const object = allObjects.find((o) => o.id === archiveButton.dataset.archive);
    pendingArchiveId = archiveButton.dataset.archive;
    $('archive-dialog-text').textContent = object
      ? `${object.name} (${object.identifier}) will be removed from detected objects.`
      : 'This object will be removed from detected objects.';
    $('archive-dialog').showModal();
    return;
  }

  if (restoreButton) {
    try {
      const updated = await api(`/api/objects/${restoreButton.dataset.restore}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: false }),
      });
      updateCachedObject(updated);
      const group = updated.kind === 'person' ? 'person'
        : GROUPS.vehicles.includes(updated.kind) ? 'vehicles'
          : GROUPS.animals.includes(updated.kind) ? 'animals' : '';
      activateGroup(group);
      renderSightingFilter();
      loadSightings();
      loadEvents();
      loadStatus();
    } catch (err) {
      console.error(err);
    }
  }
});

$('sightings').addEventListener('click', (e) => {
  const target = e.target.closest('[data-open]');
  if (target) openObjectDetails(target.dataset.open);
});

$('archive-dialog').addEventListener('close', async () => {
  if ($('archive-dialog').returnValue !== 'archive' || !pendingArchiveId) return;
  const id = pendingArchiveId;
  pendingArchiveId = null;
  try {
    const updated = await api(`/api/objects/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived: true }),
    });
    updateCachedObject(updated);
    renderObjects();
    renderSightingFilter();
    loadSightings();
    loadEvents();
    loadStatus();
  } catch (err) {
    console.error(err);
  }
});

$('object-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-group]');
  if (tab) activateGroup(tab.dataset.group);
});
$('object-search').addEventListener('input', renderObjects);
$('sighting-filter').addEventListener('change', loadSightings);
$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

if (currentGroup) activateGroup(currentGroup);
refresh();
