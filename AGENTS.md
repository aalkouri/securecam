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
| `server/auth.js` | scrypt hashes, sign-in throttling, `requireAuth` (sets `req.user`), `requireAdmin` |
| `server/users.js` | Accounts and one-time email links, in their own SQLite file `data/accounts.db` |
| `server/accounts.js` | Signed-out routes: setup, sign-in, sign-up, email confirmation, password reset, Google |
| `server/config.js` | Optional settings and secrets from env or `data/config.json` |
| `server/mail.js` | Email through Resend's HTTP API |
| `server/guard.js` | What an ordinary account may point a camera at (no private/local addresses) |
| `server/store.js` | JSON-file persistence in `data/` (gitignored) |
| `server/cameras.js` | Camera types (`reolink`, `generic`), validation, stream URLs, browser-safe view |
| `server/streams.js` | ffprobe/ffmpeg process manager |
| `server/database.js` | SQLite (`node:sqlite`) objects, sightings, alerts, detection settings |
| `server/detector.js` | ONNX detection (YOLOv8n) + 512-d vehicle re-ID (YOLO26n-ReID) |
| `server/detection.js` | Periodic frame capture, detection loop, alert creation |
| `public/` | `index.html` + `app.js` (dashboard), `detections.html` + `detections.js`, `login.html`/`setup.html`/`signup.html`/`forgot.html`/`reset.html` + `login.js` + `auth.css`, `style.css` |

## Public home page

Signed-out visitors to `/` get `public/home.html` (+ `home.css`, `home.js`), a
marketing page with the owner's logo; signed-in visitors get the dashboard at
the same address. `/login`, `/signup`, `/forgot` and `/reset` are short
addresses for the `.html` pages. Files a signed-out visitor needs must be
listed in `PAGES` / `PUBLIC_ASSETS` in `server/accounts.js`; everything else in
`public/` is behind sign-in. The logo files (`logo-mark*.png`, `favicon.png`,
`logo-full.jpg`) are cut from the owner's artwork. **Only claim on the home
page what the app really does** (no invented customer counts or reviews).

## Accounts (multi-user)

Anyone can create an account (the owner's decision), and **every account only
sees what it owns**. This is the rule to keep in mind for every new route and
query:

- The first account is the **admin** (`role: 'admin'`). An install from before
  accounts had one admin in `settings.json`; it is moved into `accounts.db` at
  first boot and keeps its username sign-in. Cameras and objects from before
  belong to it. Only the admin changes server-wide settings (`requireAdmin`).
- `requireAuth` puts the account on `req.user` (`id`, `role`, `name`).
- Cameras carry `ownerId`. In routes use `ownCameras(req)` / `findCamera(id, req)`,
  never `getCameras()` directly. `/streams/<cameraId>_<variant>/` checks the
  owner too.
- `objects.owner_id` scopes detection data; sightings and alerts belong to
  their object's owner. Every database read used by a route takes an owner id
  (`listObjects`, `listSightings`, `listAlerts`, `getObject`, `getAlert`,
  `ackAlerts`, `counts`, `ownsSnapshot`), buildings and rooms have
  `buildings.owner_id` (`listBuildings`, `createBuilding`, `createRoom`,
  `resolveCameraPlacement` all take the owner), and re-identification only matches
  within one owner (`findMatch(ownerId, ...)`). **Any new table or query that a
  route exposes must be scoped the same way**, or one user sees another's home.
- Sign-up by email needs the address confirmed through a mailed link; Google
  accounts are already confirmed. Without email configured (home install),
  sign-up signs in directly and there is no password reset.
- Sign-up, reset and duplicate-address replies never reveal whether an address
  has an account. Only token hashes are stored; reset links carry the token
  after `#`.
- Google sign-in is the plain OAuth code flow in `accounts.js` (no library).
  A Google address that matches an existing account links to it; if that
  account was never confirmed, its password is dropped first.
- The session cookie is `SameSite=Lax` (not Strict) so it survives the return
  from Google and links opened from email.
- **Alert archives are not per-account yet.** The daily archive bundles every
  account's alert clips into one file, so the archive routes are admin-only
  and other accounts get an empty list. Splitting archives by owner is open.
- Secrets (Google client secret, Resend key) live in `data/config.json` or env
  vars. **Never in the repo: it is public.** See the comment in `config.js`
  for the file's shape. `MAIL_LOG=1` prints emails to the log for testing.
- On the droplet `restrictCameraHosts` is on: non-admin accounts cannot use
  `clip://` or addresses on the server's own network (ffmpeg would fetch them
  from inside), and `maxCamerasPerUser` caps how much one account can run.

## How streaming works

Each camera has up to three stream variants, each its own ffmpeg process and
folder `data/streams/<cameraId>_<variant>/`:

- `grid` — always on; the lowest-bandwidth stream shown in the grid (the
  Reolink sub stream where available, otherwise the main stream).
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
- The password minimum is **7 characters** (the owner's decision). It's
  `MIN_PASSWORD` in `server/accounts.js` and is shown in the sign-up, reset and
  setup pages; keep them in step.
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
$env:SECURECAM_DATA = "$env:TEMP\securecam-test"; $env:PORT = "8099"; $env:HOST = "127.0.0.1"; node server/index.js
```

**Always start and restart the real server with `npm run restart`.** Do not
kill only the process listening on the port: its `node --watch` parent survives
and respawns a copy on every code change. Such a copy used to linger without
the port while running its own ffmpeg into `data/streams/`, locking the
folders (EBUSY) and double-writing streams. The server now exits if it cannot
bind its port, and the restart script clears stale `--watch` copies.

`npm run restart` (scripts/restart.ps1) stops whatever serves the port, with
its ffmpeg processes, and starts `node --watch server/index.js` in the
background, logging to `data/server.log` and `data/server-error.log`.

**LAN access:** the server listens on `127.0.0.1` unless `HOST` is set. The
owner chose to open it to the home network: a gitignored `.env` in the project
root holds `HOST=0.0.0.0`, loaded by `npm start`, `npm run dev` and
`npm run restart` through node's `--env-file-if-exists=.env`. Test servers
should set `HOST=127.0.0.1` explicitly (real env vars win over `.env`).

Sessions are in memory, so restarting the server signs everyone out. Don't kill
node or ffmpeg processes you didn't start.

## Production (DigitalOcean droplet)

The owner hosts a copy at **https://securecam.alkouri.com** on the
`games-server` droplet (138.197.207.219, 1 vCPU / 2 GB, shared with two games;
SSH alias `games-server`, user `deploy`). Everything lives in
`/home/deploy/securecam/`: `app/` (code), `data/` (its own login, cameras,
database) and `node/` (Node 24; the system Node 18 belongs to the games and is
too old for `node:sqlite`). Caddy terminates HTTPS and proxies to
`127.0.0.1:8082`; the systemd unit `securecam` sets `TRUST_PROXY=1`.

- **Pushing to `main` deploys to production.** The repo is public at
  github.com/aalkouri/securecam (the owner's choice). A cron job on the droplet
  runs `~/securecam-pull.sh --cron` every minute (copy of record:
  `scripts/droplet-pull.sh`): it downloads the new commit, syntax-checks it,
  runs `npm ci` in a fresh folder, swaps it in, restarts the service and rolls
  back if the login page doesn't answer. Log: `~/securecam-deploy/deploy.log`.
  So: commit locally as often as you like, but only push what should go live,
  and never commit anything private — the repo is public.
- Changing `scripts/droplet-pull.sh` does not update the droplet's copy; copy
  it to `~/securecam-pull.sh` by hand.
- `scripts/droplet-setup.sh` is the one-time root part (ffmpeg, service,
  sudoers entry, Caddy site). `deploy` can only `systemctl restart securecam`.
- The droplet cannot reach cameras on the owner's home network. Until a link
  exists (VPN such as Tailscale/WireGuard), it only runs the `test://demo`
  camera. Don't put heavy sources there: one shared vCPU.
- The service is capped (`MemoryMax=1G`, low CPU weight) so the games win.

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
  vehicle similarity threshold is 0.80 cosine; the face threshold is 0.35.
  A 1-minute flicker guard and a 5-minute alert cooldown are tunable from the
  Detections page. Sightings stop accumulating while an object remains in view
  once it has crossed the threshold. The alert wording was designed around
  named cars.
- People are only recorded when a face detector finds a face; body shots are
  discarded. Identity comes from `w600k_mbf.onnx` (ArcFace), so a person in
  different clothes is still the same record. The face detector is
  `yolov10n-face.onnx`; both are pinned by SHA-256 in `server/detector.js`.
- Detection runs on CPU. `onnxruntime-node` install scripts are approved via
  npm's `install-scripts` command; keep that in mind on a fresh machine.
