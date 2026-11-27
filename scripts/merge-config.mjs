// Merge JSON read from standard input into data/config.json (the private
// settings file described in server/config.js). Nested objects are merged one
// level deep; values are never printed.
//   echo '{"resend":{"apiKey":"..."}}' | node scripts/merge-config.mjs
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.SECURECAM_DATA || 'data');
const file = path.join(dataDir, 'config.json');
let current = {};
try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
const incoming = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, ''));

for (const [key, value] of Object.entries(incoming)) {
  const both = [value, current[key]].every((v) => v && typeof v === 'object' && !Array.isArray(v));
  current[key] = both ? { ...current[key], ...value } : value;
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(current, null, 2), { mode: 0o600 });
try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
console.log(`Updated ${file}: ${Object.keys(incoming).join(', ')}`);
