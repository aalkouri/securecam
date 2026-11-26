# SecureCam — notes for AI coding assistants

More than one AI assistant works on this repo. Read this file first, and keep it
up to date when you change architecture, conventions, or open decisions.

## What it is

A self-hosted web app for viewing the owner's IP cameras. Node.js + Express
server; plain HTML/CSS/JS frontend (no framework, no build step). `ffmpeg`
converts each camera's RTSP feed into HLS (fMP4 segments) and the browser plays
it with hls.js (served from `node_modules`, no CDN).

Hardware: 2× **Reolink RLC-810A** (4K, wired PoE, no Wi-Fi). Main stream is
**H.265** 3840×2160; sub stream is **H.264** 640×360. RTSP paths are
`/h264Preview_01_main` and `/h264Preview_01_sub` on port 554 (the path says
h264 even when the stream is H.265). RTSP must be enabled in the Reolink app.

## Layout

| File | Role |
| --- | --- |
| `server/index.js` | Express app: security headers, sessions, routes, boot |
| `server/auth.js` | Single admin account, scrypt hashes, login lockout |
| `server/store.js` | JSON-file persistence in `data/` (gitignored) |
| `server/cameras.js` | Camera types (`reolink`, `generic`), validation, stream URLs, browser-safe view |
| `server/streams.js` | ffprobe/ffmpeg process manager |
| `server/database.js` | SQLite (`node:sqlite`) objects, sightings, alerts, detection settings |
| `server/detector.js` | ONNX detection (YOLOv8n) + 512-d vehicle re-ID (YOLO26n-ReID) |
| `server/detection.js` | Periodic frame capture, detection loop, alert creation |
| `public/` | `index.html` + `app.js` (dashboard), `detections.html` + `detections.js`, `login.html`/`setup.html` + `login.js`, `style.css` |

## How streaming works

Each camera has up to three stream variants, each its own ffmpeg process and
folder `data/streams/<cameraId>_<variant>/`:

- `grid` — always on; the low-res sub stream shown in the grid.
- `hd` — on demand when the full view opens; main stream passed through as-is
  (H.264 or H.265).
- `hd-avc` — on demand for browsers that can't decode H.265; main stream
  converted to H.264, capped at 1920 wide.

**Audio:** the `hd` and `hd-avc` variants carry the camera's sound, re-encoded
to AAC (the track is optional, so cameras without a microphone still work). The
`grid` variant is always silent. The full view has a sound on/off button; if
the browser blocks playback with sound, it falls back to muted.

The browser reports H.265 support (`MediaSource.isTypeSupported`) to
`POST /api/cameras/:id/hd`. Every fetch under `/streams/<key>/` marks that
stream as watched, and HD variants idle for 30s are stopped. Codecs are found
with ffprobe and cached per URL. `test://demo` is a synthetic camera (H.264
grid, H.265 HD) for testing without hardware.

`clip://<filename>` plays a recorded video from `data/clips/` on a loop as if
it were a live camera (grid: shrunk to 640 wide; HD: the file passed through).
Only plain filenames are accepted, so a camera URL can never reach other files
on disk. Clips are not committed: `data/` is gitignored, and clips taken from
elsewhere (e.g. YouTube samples) are not ours to redistribute.

## Object detection

Every enabled camera is sampled for one frame at a configurable interval
(default 4s). Frames are decoded locally with ONNX Runtime: YOLOv8n finds
people, bicycles, cars, motorcycles, buses, trucks, cats and dogs; crops of
those objects are embedded by YOLO26n-ReID (or fingerprinted when that model
can't load). Results go into SQLite at `data/securecam.db`:

- `objects` — one row per recognised object, with a stable `identifier` like
  `CAR-0001` and an owner-editable name.
- `sightings` — camera, time, confidence, bounding box and a JPEG snapshot in
  `data/snapshots/`.
- `alerts` — `"<name> showed up in camera <camera>"`, throttled per object and
  camera.

Repeated sightings from the same camera within 30s are collapsed; alerts have
a 60s cooldown. Both intervals are stored in the `settings` DB table.

**Nothing is shown until an object has been seen more than twice.** The owner
asked for this explicitly after seeing a first-sighting popup. `MIN_SIGHTINGS`
in `server/database.js` is 3 and gates the objects/sightings/alerts API queries
*and* alert creation. Records are still written from the first sighting so
re-identification has a history — only the UI and alerts stay quiet. The
dashboard has a **Detection** button (with a badge) linking to `/detections.html`,
where the owner names objects and browses sightings. Embeddings are only stored
server-side — API responses never include them. Model files are downloaded once
from the pinned Ultralytics release into `data/models/` and verified by SHA-256.

## Rules that must hold

- **Never send camera passwords to the browser.** `publicCamera()` is the only
  shape the API returns. A blank Reolink password on edit keeps the stored one,
  and `****` in a generic URL keeps the stored password.
- **CSP is strict:** no inline `<script>`, no inline `style=""` attributes, no
  CDNs. Put styles in `style.css` and scripts in `.js` files.
- **Spawn ffmpeg with an argument array, never a shell string.** URLs come
  from the user.
- Redact credentials from any ffmpeg/ffprobe error before storing or returning
  it (`redact()` in streams.js).
- `data/` holds secrets, snapshots, clips and models. Never commit it.
- The admin password minimum is **7 characters** (the owner's decision). It's
  enforced in `server/index.js` (`POST /api/setup`) and shown in
  `public/setup.html`; keep the two in step.
- Detection writes to SQLite with the built-in `node:sqlite`; don't add a native
  SQLite dependency. Spawn ffmpeg from detection with an argument array too.
- Never expose object embeddings or raw camera URLs through the detection API.

## Gotchas already learned (Windows)

- ffmpeg writes `init.mp4` relative to its **working directory**, not next to
  the playlist, so it's spawned with `cwd` set to the stream folder. A stray
  `init.mp4` in the repo root means an old server process is still running.
- A folder can't be deleted until the ffmpeg process inside it has fully
  exited. `fs.rmSync` there threw EPERM and crashed the server; cleanup is now
  async with retries and never throws (`removeDir`, `exited`). Keep it that way.
- Windows ffmpeg has no fontconfig, so `drawtext` needs an explicit `fontfile`.
- RTSP `-timeout` is in microseconds.

## Running and testing

```powershell
npm start
```

That serves http://localhost:8080 using `./data`. To test **without touching
the owner's real data or a server they're running**, use a scratch data folder
and another port:

```powershell
$env:SECURECAM_DATA = "$env:TEMP\securecam-test"; $env:PORT = "8099"; node server/index.js
```

`npm run restart` (scripts/restart.ps1) stops whatever serves the port, with
its ffmpeg processes, and starts `node --watch server/index.js` in the
background, logging to `data/server.log` and `data/server-error.log`.

Sessions are in memory, so restarting the server signs everyone out. Don't kill
node or ffmpeg processes you didn't start.

## Working alongside another assistant

- Run `git status` and `git diff` before editing; someone else may have
  uncommitted work in the same files.
- Commit small and often with clear messages, so the other assistant can follow
  in `git log`.
- Record decisions and open questions below rather than only in chat.

## Open decisions / known issues

- No recording, scheduled clips, or HTTPS yet. For remote access use a
  VPN (Tailscale/WireGuard) or an HTTPS reverse proxy; don't expose the port
  directly.
- Re-ID uses generic vehicle embeddings, not licence-plate recognition. The
  similarity threshold (0.80 cosine) and 60s alert cooldown may need tuning
  for the owner's driveway. People/animals are detected and stored too, but the
  alert wording was designed around named cars.
- Detection runs on CPU. `onnxruntime-node` install scripts are approved via
  npm's `install-scripts` command; keep that in mind on a fresh machine.
