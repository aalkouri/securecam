// Limits on what an ordinary account may point a camera at on a public
// deployment. Camera URLs are fetched by ffmpeg on this machine, so without
// this anyone with an account could make the server read its own private
// network or its own disk.
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { gridUrl, hdUrl } from './cameras.js';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(addr, bits, 'ipv6');
}

function isBlocked(address, family) {
  const mapped = family === 6 && /^::ffff:/i.test(address) ? address.replace(/^::ffff:/i, '') : null;
  if (mapped && net.isIPv4(mapped)) return blocked.check(mapped, 'ipv4');
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

// Throws an Error with a message for the user when the camera is not allowed.
export async function assertCameraAllowed(cam, user, ownedCount) {
  if (user.role === 'admin') return;
  if (config.maxCamerasPerUser > 0 && ownedCount > config.maxCamerasPerUser) {
    throw new Error(`You can have up to ${config.maxCamerasPerUser} cameras`);
  }
  if (!config.restrictCameraHosts) return;
  for (const raw of new Set([gridUrl(cam), hdUrl(cam)].filter(Boolean))) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('Invalid camera address'); }
    if (url.protocol === 'test:') continue;
    if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(url.protocol)) {
      throw new Error('This kind of camera address is not available on this server');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
      addresses = net.isIP(host)
        ? [{ address: host, family: net.isIP(host) }]
        : await dns.lookup(host, { all: true });
    } catch {
      throw new Error(`Could not find the camera address "${host}"`);
    }
    if (!addresses.length || addresses.some((a) => isBlocked(a.address, a.family))) {
      throw new Error('Cameras must be reachable at a public internet address');
    }
  }
}
