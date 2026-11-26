// Camera definitions: validation, stream URL derivation, and the
// browser-safe view of a camera (never includes passwords).

export const CAMERA_TYPES = ['reolink', 'generic'];
const URL_SCHEMES = /^(rtsp|rtsps|http|https|test):\/\//i;
const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/;

// Main (full quality) and sub (low-res) stream URLs for a camera.
// `sub` is null when the camera has only one stream.
export function streamUrls(cam) {
  if (cam.type === 'reolink') {
    const auth = `${encodeURIComponent(cam.username)}:${encodeURIComponent(cam.password || '')}@`;
    const base = `rtsp://${auth}${cam.host}:${cam.port || 554}`;
    // Reolink uses these paths even when the stream is actually H.265.
    return { main: `${base}/h264Preview_01_main`, sub: `${base}/h264Preview_01_sub` };
  }
  if (cam.url?.startsWith('test://')) {
    // Synthetic camera: behaves like a two-stream camera so the HD path can be tried.
    return { main: cam.url, sub: cam.url };
  }
  return { main: cam.url, sub: cam.subUrl || null };
}

// The grid uses the sub stream when there is one; full-screen uses main.
export function gridUrl(cam) {
  const { main, sub } = streamUrls(cam);
  return sub || main;
}

export function hdUrl(cam) {
  const { main, sub } = streamUrls(cam);
  return sub ? main : null;
}

function maskUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url;
  }
}

// Keep the stored password when the user left the masked placeholder in place.
function unmask(nextUrl, oldUrl) {
  if (!nextUrl || !oldUrl || !nextUrl.includes(':****@')) return nextUrl;
  try {
    const next = new URL(nextUrl);
    const old = new URL(oldUrl);
    if (next.password === '****') next.password = old.password;
    return next.toString();
  } catch {
    return nextUrl;
  }
}

function str(v, max = 512) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Validate a create/update payload. `existing` is the stored camera on edit.
export function validateCamera(body, existing) {
  const name = str(body.name, 100);
  if (!name || name.length > 64) throw new Error('Name is required (max 64 characters)');
  const type = CAMERA_TYPES.includes(body.type) ? body.type : 'generic';
  const enabled = body.enabled !== false;

  if (type === 'reolink') {
    const host = str(body.host, 300);
    if (!HOST_RE.test(host)) throw new Error('Enter the camera\'s IP address, e.g. 192.168.1.50');
    const port = body.port === undefined || body.port === '' ? 554 : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
    const username = str(body.username, 64);
    if (!username) throw new Error('Username is required (Reolink default is "admin")');
    let password = typeof body.password === 'string' ? body.password : '';
    if (!password && existing?.type === 'reolink') password = existing.password;
    if (!password) throw new Error('Password is required');
    return { name, type, enabled, host, port, username, password };
  }

  const url = unmask(str(body.url), existing?.url);
  if (!URL_SCHEMES.test(url)) throw new Error('Stream URL must start with rtsp://, rtsps://, http(s):// or test://');
  const subUrl = unmask(str(body.subUrl), existing?.subUrl) || null;
  if (subUrl && !URL_SCHEMES.test(subUrl)) throw new Error('Low-res URL must start with rtsp://, rtsps://, http(s)://');
  return { name, type, enabled, url, subUrl };
}

export function publicCamera(cam, extra = {}) {
  const base = {
    id: cam.id,
    name: cam.name,
    type: cam.type || 'generic',
    enabled: cam.enabled,
    hasHd: Boolean(hdUrl(cam)),
    ...extra,
  };
  if (base.type === 'reolink') {
    return { ...base, host: cam.host, port: cam.port || 554, username: cam.username };
  }
  return { ...base, url: maskUrl(cam.url), subUrl: maskUrl(cam.subUrl) };
}
