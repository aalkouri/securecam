// Shared pop-up for detected objects and recent sightings. Loaded by both the
// camera page and the Detections page so an object can be inspected from either.
(function () {
  let dialog = null;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
  const snapshot = (name) => (name ? `/api/snapshots/${encodeURIComponent(name)}` : '');
  const field = (label, value) => `<div class="detail-field"><dt>${esc(label)}</dt><dd>${esc(value || '—')}</dd></div>`;

  async function api(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
      location.replace('/login.html');
      throw new Error('Not authenticated');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'object-details-dialog';
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
      if (e.target.closest('[data-details-close]')) dialog.close();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function render(data) {
    const o = data.object;
    const sightings = data.sightings || [];
    const events = data.events || [];
    const sightingHtml = sightings.length
      ? sightings.map((s) => `
          <article class="detail-sighting">
            ${s.snapshot ? `<img src="${snapshot(s.snapshot)}" alt="Sighting">` : '<div class="no-image">No snapshot</div>'}
            <div class="hint">${esc(s.cameraName)} · ${when(s.seenAt)}</div>
            <div class="hint">${pct(s.confidence)} confidence${s.archived ? ' · archived object' : ''}</div>
          </article>`).join('')
      : '<p class="hint">No sightings recorded yet.</p>';
    const eventHtml = events.length
      ? `<ul>${events.map((e) => `<li><span class="hint">${when(e.seenAt)}</span> ${esc(e.kind)}: ${esc(e.value || '—')}${e.cameraName ? ` <span class="hint">(${esc(e.cameraName)})</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="hint">No detail changes have been recorded for this object.</p>';
    return `
      <div class="details-panel">
        <div class="details-bar">
          <div>
            <strong>${esc(o.name)}</strong>
            <span class="identifier">${esc(o.identifier)}</span>
            <span class="detail-chip">${esc(o.kind)}</span>
            ${o.named ? '<span class="detail-chip">Named</span>' : '<span class="detail-chip pending">Unnamed</span>'}
            ${o.archived ? '<span class="detail-chip archived">Archived</span>' : ''}
          </div>
          <button type="button" class="icon" data-details-close title="Close" aria-label="Close">✕</button>
        </div>
        <div class="details-body">
          <section>
            <h3>Tracked details</h3>
            <dl class="detail-list">
              ${field('Color', o.color)}
              ${field('Vehicle type', o.vehicleType)}
              ${field('Make', o.make)}
              ${field('Model', o.model)}
              ${field('License plate', o.licensePlate)}
              ${field('Action', o.action)}
              ${field('Notes', o.notes)}
              ${field('First seen', when(o.firstSeen))}
              ${field('Last seen', when(o.lastSeen))}
              ${field('Sightings', o.sightings)}
              ${field('Latest camera', o.latestCamera)}
              ${field('Details updated', when(o.detailsUpdatedAt))}
            </dl>
          </section>
          <section>
            <h3>Recent sightings (${sightings.length})</h3>
            <div class="detail-sightings">${sightingHtml}</div>
          </section>
          <section>
            <h3>Detail & archive history (${events.length})</h3>
            ${eventHtml}
          </section>
        </div>
        <div class="details-bar details-footer">
          <a class="card-btn" href="/detections.html?object=${encodeURIComponent(o.id)}">Open on Detections page</a>
          <button type="button" data-details-close>Close</button>
        </div>
      </div>`;
  }

  async function openObjectDetails(objectId) {
    if (!objectId) return;
    const box = ensureDialog();
    box.innerHTML = '<div class="details-panel"><p class="hint">Loading object details…</p></div>';
    if (!box.open) box.showModal();
    try {
      const data = await api(`/api/objects/${encodeURIComponent(objectId)}/details`);
      box.innerHTML = render(data);
    } catch (err) {
      box.innerHTML = `<div class="details-panel"><p class="hint">${esc(err.message)}</p><button type="button" data-details-close>Close</button></div>`;
    }
  }

  window.openObjectDetails = openObjectDetails;
}());
