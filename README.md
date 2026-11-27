# SecureCam

A self-hosted web app for viewing your IP cameras from a browser.

Each camera's RTSP feed is converted to HLS by `ffmpeg` on the server, so the
browser plays it with no plugins. Camera passwords stay on the server and are
never sent to the browser.

## Requirements

- Node.js 20.9+ (uses the built-in `node:sqlite`)
- `ffmpeg` on your PATH (or set `FFMPEG_PATH`)

## Run

```powershell
npm install
npm install-scripts approve onnxruntime-node
npm rebuild onnxruntime-node
npm start
```

(The `install-scripts` steps are only needed once on a fresh machine; newer npm
versions hold native packages' install scripts back by default.)

To restart a running server (or start it in the background), run
`npm run restart`. It logs to `data/server.log`.

Open http://localhost:8080. The first visit asks for the admin's **email
address**, a password and the first **building**. Email delivery must be
configured (`RESEND_API_KEY` and `MAIL_FROM`, or `MAIL_LOG=1` while testing):
the account is created only after the emailed confirmation link is opened, so
nobody can register an address they do not own. Email addresses are the only
usernames; the old username field has been renamed everywhere.

On first sign-in, an account without a building sees a two-step guide: a house
photo with **Building name**, then a moving carousel of room photos with **Room
name**. The button says **Next**, then **Finish**. The guide cannot be dismissed;
finishing drops straight into the dashboard with the new building and room
selected on the floor plan. Existing installations are migrated automatically
to a fabricated `Main Building / Default Room` so every camera has a valid
placement.

Only the admin account is kept. Any non-admin accounts and their cameras,
buildings, rooms, objects, sightings, alerts and media files are removed at
startup.

The admin account starts at an **account picker**: a drop-down of every account
on the server. No cameras, alerts or floor plan are shown until an account is
selected. After choosing one, the dashboard is the same one that account's owner
sees. The drop-down at the top of the page switches accounts at any time;
choosing **Choose an account…** returns to the picker.

A single, centered camera feed is shown **above** the floor plan. Click a
camera marker below the feed to switch to that camera; the choice is remembered
per account, so the last feed viewed is shown on the next visit. A short hint
above the feed explains this. The stream tools no longer include a restart
button.

Below the streams is an interactive floor plan on a grass-textured board. Use
the **Building** drop-down to switch buildings. The black building outline has
its own corner handle: dragging it resizes only the outline, never the grass or
the reserved outside area, and it will not pass over a room, a camera marker or
the outside controls. Drag rooms to rearrange them, or drag the corner icon to
resize them; arrow keys also nudge a focused room or handle. Camera markers are
no longer dragged. The top-left circle on a marker steps the camera clockwise
through twelve evenly spaced edge positions (three per side, never a corner),
and the top-right circle rotates it 45°. Clicking anywhere else on the marker
or its name selects that camera and shows its feed above. Click the building
or room title (both use the same boxed label) to rename it, use
**+ Room** to add another room, or use the **✕** on a room to delete it. A room
with cameras cannot be deleted until those cameras are removed. Rooms cannot
move into the space reserved for the building name, cannot shrink below the
size needed for their **+ camera** button, and cannot be moved or resized over
a camera marker. Positions and sizes are saved per room in SQLite.

Creating a camera adds a marker with its name underneath. Its top-left circle
steps it clockwise through twelve edge positions (three per side, starting at
the top middle); outside cameras use the same pattern just outside the building
walls. Clicking anywhere else on the marker or its name replaces the feed above
with that camera and scrolls it into view. The active marker is outlined. The
round button at a marker's top right rotates it clockwise 45° per click — eight
clicks make a full 360°. Markers may not overlap each other, the fixed
**Outside** label in the top-left or the **+ Outside Camera** button in the
bottom-left. The label cannot be edited. Use **+ Outside Camera** to add a
camera that belongs to the building but sits outside its walls; its tile
location reads `Outside`.

## Adding cameras

Click **+ Add camera**. Choose the **building**, then the **room** in that
building; both are required. If you do not have a building or room yet, select
*+ Create new building…* or *+ Create new room…* and type the name inline. The
building and room are stored in SQLite, and the room belongs to its building.
Each camera tile shows its building and room (or `Outside`).

Clicking **+ camera** inside a room on the floor plan hides the building and
room fields and fixes the new camera to that room. The **+ Outside Camera**
button at the bottom-left of the floor plan does the same for an outside camera;
there is no outside checkbox. Both open with a name like `Lobby - CAMERA` or
`Outside - CAMERA`. If that name is taken, it suggests `... - CAMERA 2`, then
`CAMERA 3`, and so on. Camera names must be unique per account.

Account logins always use an email address. Camera names allow only letters,
numbers, spaces and hyphens; the camera IP address allows letters, numbers,
dots and hyphens (or a `test://`, `clip://` or RTSP URL). Reolink camera login
usernames are whatever the camera vendor uses (usually `admin`) and are not
email addresses. Camera passwords are not restricted.

- **Reolink:** choose *Reolink* and enter the camera's IP address, username
  (usually `admin`) and password. Turn on RTSP first in the Reolink app:
  Settings → Network → Advanced → Port Settings. SecureCam automatically uses
  the camera's low-res stream for the grid.
- **Other brands:** choose *Other* and paste the RTSP URL, e.g.
  `rtsp://user:pass@192.168.1.50:554/stream1`. The grid uses this stream when
  no lower-bandwidth variant is available.

Use **Test connection** to check the settings before saving.

The grid shows the lowest-bandwidth stream available for each camera. Click a
camera to open the full view, which loads the full-quality stream (4K on
Reolink) and stops it again
30 seconds after you leave. H.265 streams play directly where the browser
supports it; otherwise the server converts them to H.264, which uses more CPU.
The full view also plays the camera's sound, with a button to turn it on or off;
the grid is always silent.

## Test cameras

Choose *Other*, then pick **Built-in test camera** to add a sample feed without
any hardware. The available short URLs are:

| Feed | Stream URL |
| --- | --- |
| Demo pattern | `test://demo` |
| Reolink sample | `test://reolink-sample` |
| Reolink night/day | `test://reolink-night-day` |
| Drive-thru | `test://drive-thru` |
| City street | `test://city-street` |
| Night crossing | `test://night-crossing` |

You can paste any of these addresses into the **IP address** field as well;
SecureCam saves them as test cameras and no username or password is needed.

The five video feeds loop files from `data/clips/`. Existing installations that
used `clip://…` URLs are migrated to these `test://` aliases automatically.

You can still loop another recorded video by putting it in `data/clips/` and
adding a camera of type *Other* with the URL `clip://your-file.mp4`.

## Object detection

Every enabled camera is sampled for a frame every few seconds. Detection runs
locally with ONNX Runtime — nothing is sent to a cloud service. It recognises
cars, trucks, buses, motorcycles, bicycles, people, cats and dogs. Known
objects are given a permanent ID such as `CAR-0001`; click **Detection** in the
header to rename one and browse its sightings. Alerts live on the camera
dashboard under the **Alerts** button, with messages like
*"Blue truck showed up in camera Driveway"*. Clicking an alert plays the saved
five-second clip from that camera.

To keep single glimpses from becoming noise, an object is only shown and only
raises an alert once it has been seen **more than twice** (3 sightings). It is
still tracked from the first sighting — the badge on the **Detection** button
counts objects that have crossed that threshold.

People are saved as **face shots only**: a person is skipped unless a face is
clearly visible, and identity comes from a 512-dimensional face embedding, not
clothing. Vehicles keep their body snapshot. Identical frames are stored once,
named by their SHA-256, so looping test footage cannot fill the folder with
duplicate JPEGs; unused files are cleaned up on startup. The Detections page has
separate **Objects to name**, **People**, **Vehicles** and **Animals** buttons so you can
work through one group at a time. The page loads once when opened — it never
refreshes itself while you are typing. Type a name and press **Confirm** to save
it; **View Sightings** jumps to that object's history, and the **×** on the photo
removes the object (click it twice to confirm). Once an object is named it leaves
this list: confident matches are handled automatically, while new face images
that are 40% or less sure of the same person come back as a possible match to
review. Reload to see anything new.

Repeats are collapsed: an object is recorded just three times so it can be
named, then no more rows are added while it stays in view. Leaving and returning
is a new sighting, and alerts are throttled to at most one every **5 minutes**.
A 1-minute flicker guard stops brief detection dropouts from counting as
re-arrivals. Both delays, the scan interval, and the on/off switch can be
changed from the Detections page.

Alerts are grouped too: a returning object updates one rolling alert with a
sighting count and a fresh clip instead of adding a row every time. Existing
duplicate alerts are folded together on startup, and alerts and clips older
than **7 days** are removed hourly. The Alerts dropdown shows when an object was
last seen and how many sightings the group contains.

Shortly after local midnight, the previous day's alert clips are zipped into
`data/alert-archives/YYYY-MM-DD.zip` and indexed in SQLite. The loose MP4 files
are deleted once the archive is safely written. Click **Archives** in the header
to browse a previous day — SecureCam unpacks that ZIP on demand and plays the
clips without exposing a download. Archive days older than **30 days** are
removed automatically.

Each enabled camera is always recording a rolling **10-minute grid buffer**.
When an alert happens, SecureCam saves a **five-second 1080p clip from that
camera's full-quality stream** and links it to the alert. The buffer uses
roughly 0.5–1 Mbps per camera; with 2–4 cameras the ten-minute window stays well
under 1 GB. A 1080p alert clip is typically **1–2 MB** instead of 12 MB at 4K;
the newest clip replaces the old one when an alert group grows.

On first run the app downloads four small models (~36 MB total) into
`data/models/` and verifies their checksums. Snapshots and the SQLite database
(`securecam.db`) live in `data/` and are never committed.

Re-identification uses generic vehicle embeddings and ArcFace face embeddings,
not licence-plate reading. The same car seen again from a similar angle will
normally be matched to its existing record; lighting changes or a different
camera can create a new one.

## Configuration

| Variable       | Default     | Purpose                                           |
| -------------- | ----------- | ------------------------------------------------- |
| `PORT`         | `8080`      | HTTP port                                         |
| `HOST`         | `127.0.0.1` | Set `0.0.0.0` to allow other devices on your LAN  |
| `SECURECAM_DATA` | `./data`  | Where settings, cameras and live segments live    |
| `FFPROBE_PATH` | next to ffmpeg | Path to the ffprobe binary                   |
| `FFMPEG_PATH`  | `ffmpeg`    | Path to the ffmpeg binary                         |
| `PUBLIC_URL`   | request URL | Public address used in emailed confirmation links |
| `RESEND_API_KEY` | none      | Resend key for verification/reset emails           |
| `MAIL_FROM`    | none        | Verified sender address, e.g. `SecureCam <noreply@example.com>` |
| `MAIL_LOG`     | `0`         | `1` prints emailed links to the server log (testing only) |
| `ALLOW_SIGNUP` | `1`         | Allow the email-verified signup page               |

Email verification is mandatory: without `RESEND_API_KEY` + `MAIL_FROM` (or
`MAIL_LOG=1` for local testing), setup and signup cannot complete. The signup
page also has **Resend confirmation** for a lost verification link.

`data/` holds your admin password hash and camera credentials. It is gitignored;
keep it out of version control.

## Security notes

- Don't expose this directly to the internet. For remote access use a VPN
  (e.g. Tailscale/WireGuard) or put it behind an HTTPS reverse proxy.
- Put the cameras on their own VLAN/network and block their internet access
  if your router allows it.
