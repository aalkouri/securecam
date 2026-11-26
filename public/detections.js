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
let allObjects = [];
let currentGroup = '';
let statusTimer = null;

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
    `shown after ${s.minSightings || 3} sightings`,
  ];
  if (s.lastError) line.push(`Error: ${s.lastError}`);
  $('detection-status').textContent = line.join(' · ');
  $('detection-enabled').checked = Boolean(s.enabled);
  $('detection-interval').value = String(s.intervalMs || 4000);
  selectValue('detection-gap', s.sightingGapMs || 60_000);
  selectValue('detection-cooldown', s.alertCooldownMs || 300_000);
  $('objects-note').textContent = `An object appears here only after it has been seen more than ${(s.minSightings || 3) - 1} times. People are saved as face shots and matched by face, not clothing. Type in a Name box to rename it.`;
}

async function loadStatus() {
  renderStatus(await api('/api/detection/status'));
}

function renderAlerts(alerts) {
  $('alerts-list').innerHTML = alerts.length
    ? alerts.map((a) => `
        <div class="alert-item ${a.ack ? 'acked' : ''}">
          ${allObjects.find((o) => o.id === a.objectId)?.latestSnapshot
            ? `<img src="${snapshot(allObjects.find((o) => o.id === a.objectId).latestSnapshot)}" alt="" class="alert-thumb">`
            : ''}
          <div class="alert-text">
            <strong>${esc(a.message)}</strong>
            <span class="hint">${esc(a.identifier)} · ${when(a.createdAt)}</span>
          </div>
          ${a.ack ? '<span class="hint">Acknowledged</span>'
            : `<button class="icon" data-ack="${a.id}" title="Acknowledge">✓</button>`}
        </div>`).join('')
    : '<p class="hint">No alerts yet.</p>';
}

async function loadAlerts() {
  renderAlerts(await api('/api/alerts?limit=40'));
}

function renderObjects(objects) {
  const kinds = GROUPS[currentGroup];
  const query = $('object-search').value.trim().toLowerCase();
  const visible = objects.filter((o) => (!kinds || kinds.includes(o.kind))
    && (!query || `${o.name} ${o.identifier}`.toLowerCase().includes(query)));
  $('objects').innerHTML = visible.length
    ? visible.map((o) => {
      const img = snapshot(o.latestSnapshot);
      return `
        <article class="object-card">
          ${img ? `<img src="${img}" alt="Latest sighting of ${esc(o.name)}">` : '<div class="no-image">No snapshot</div>'}
          <div class="object-body">
            <div class="object-title">
              <input type="text" class="object-name" data-id="${esc(o.id)}" value="${esc(o.name)}" maxlength="64" aria-label="Name">
              <span class="identifier">${esc(o.identifier)}</span>
            </div>
            <div class="hint">${esc(o.kind)} · ${o.sightings} sightings · last seen ${when(o.lastSeen)}</div>
            <button class="icon" data-view="${esc(o.id)}">View sightings</button>
          </div>
        </article>`;
    }).join('')
    : `<p class="hint">No ${GROUP_LABEL[currentGroup] || 'objects'} to name yet. They appear here once they have been seen more than twice.</p>`;
}

async function loadObjects() {
  allObjects = await api('/api/objects');
  renderObjects(allObjects);
  const select = $('sighting-filter');
  const selected = select.value;
  select.innerHTML = '<option value="">All objects</option>'
    + allObjects.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} · ${esc(o.identifier)}</option>`).join('');
  select.value = selected && allObjects.some((o) => o.id === selected) ? selected : '';
}

async function loadSightings() {
  const objectId = $('sighting-filter').value;
  const rows = await api(`/api/sightings?limit=60${objectId ? `&objectId=${encodeURIComponent(objectId)}` : ''}`);
  $('sightings').innerHTML = rows.length
    ? rows.map((s) => `
        <article class="sighting-card">
          <img src="${snapshot(s.snapshot)}" alt="Sighting of ${esc(s.objectName)}">
          <div class="hint">${esc(s.objectName)} · ${esc(s.identifier)}</div>
          <div class="hint">${esc(s.cameraName)} · ${when(s.seenAt)} · ${pct(s.confidence)}</div>
        </article>`).join('')
    : '<p class="hint">No sightings yet.</p>';
}

async function refresh() {
  try {
    await Promise.all([loadStatus(), loadAlerts(), loadObjects(), loadSightings()]);
  } catch {
    // api() handles authentication failures.
  }
}

$('detection-save').addEventListener('click', async () => {
  clearInterval(statusTimer);
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
  } finally {
    statusTimer = setInterval(loadStatus, 5000);
  }
});

$('ack-all').addEventListener('click', async () => {
  await api('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ all: true }) });
  loadAlerts();
});

$('alerts-list').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-ack]')?.dataset.ack;
  if (!id) return;
  await api('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ ids: [Number(id)] }) });
  loadAlerts();
});

$('objects').addEventListener('change', async (e) => {
  const input = e.target.closest('.object-name');
  if (!input) return;
  try {
    await api(`/api/objects/${input.dataset.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: input.value }),
    });
    loadObjects();
    loadAlerts();
  } catch (err) {
    input.value = allObjects.find((o) => o.id === input.dataset.id)?.name || '';
    console.error(err);
  }
});

$('objects').addEventListener('click', (e) => {
  const id = e.target.closest('[data-view]')?.dataset.view;
  if (!id) return;
  $('sighting-filter').value = id;
  loadSightings();
  $('sightings').scrollIntoView({ behavior: 'smooth' });
});

$('object-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-group]');
  if (!tab) return;
  currentGroup = tab.dataset.group;
  for (const button of $('object-tabs').querySelectorAll('[data-group]')) {
    button.classList.toggle('active', button === tab);
  }
  renderObjects(allObjects);
});
$('object-search').addEventListener('input', () => renderObjects(allObjects));
$('sighting-filter').addEventListener('change', loadSightings);
$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});

refresh();
statusTimer = setInterval(loadStatus, 5000);
setInterval(() => { loadAlerts(); loadObjects(); }, 10_000);
