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

Open http://localhost:8080. The first visit asks you to create the admin account.

## Adding cameras

Click **+ Add camera**.

- **Reolink:** choose *Reolink* and enter the camera's IP address, username
  (usually `admin`) and password. Turn on RTSP first in the Reolink app:
  Settings → Network → Advanced → Port Settings.
- **Other brands:** choose *Other* and paste the RTSP URL, e.g.
  `rtsp://user:pass@192.168.1.50:554/stream1`. If the camera has a low-res
  stream, add it too and the grid will use it.

Use **Test connection** to check the settings before saving.

The grid shows each camera's low-res stream. Click a camera to open the full
view, which loads the full-quality stream (4K on Reolink) and stops it again
30 seconds after you leave. H.265 streams play directly where the browser
supports it; otherwise the server converts them to H.264, which uses more CPU.
The full view also plays the camera's sound, with a button to turn it on or off;
the grid is always silent.

Use `test://demo` (type *Other*) to try the app without any hardware.

To loop a recorded video as a stand-in camera, put the file in `data/clips/`
and add a camera of type *Other* with the URL `clip://your-file.mp4`.

## Object detection

Every enabled camera is sampled for a frame every few seconds. Detection runs
locally with ONNX Runtime — nothing is sent to a cloud service. It recognises
cars, trucks, buses, motorcycles, bicycles, people, cats and dogs. Known
objects are given a permanent ID such as `CAR-0001`; click **Detection** in the
header to rename one, browse its sightings, and see alerts like
*"Blue truck showed up in camera Driveway"*. New alerts also pop up on the
camera dashboard.

To keep single glimpses from becoming noise, an object is only shown and only
raises an alert once it has been seen **more than twice** (3 sightings). It is
still tracked from the first sighting — the badge on the **Detection** button
counts objects that have crossed that threshold.

People are saved as **face shots only**: a person is skipped unless a face is
clearly visible, and identity comes from a 512-dimensional face embedding, not
clothing. Vehicles keep their body snapshot. The Detections page has separate
**Objects to name**, **People**, **Vehicles** and **Animals** buttons so you can
work through one group at a time. The page loads once when opened — it never
refreshes itself while you are typing. Type a name and press **Confirm** to save
it; **View Sightings** jumps to that object's history, and the **×** on the photo
removes the object (click it twice to confirm). Reload to see anything new.

Repeats are collapsed: an object is recorded just three times so it can be
named, then no more rows are added while it stays in view. Leaving and returning
is a new sighting, and alerts are throttled to at most one every **5 minutes**.
A 1-minute flicker guard stops brief detection dropouts from counting as
re-arrivals. Both delays, the scan interval, and the on/off switch can be
changed from the Detections page.

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

`data/` holds your admin password hash and camera credentials. It is gitignored;
keep it out of version control.

## Security notes

- Don't expose this directly to the internet. For remote access use a VPN
  (e.g. Tailscale/WireGuard) or put it behind an HTTPS reverse proxy.
- Put the cameras on their own VLAN/network and block their internet access
  if your router allows it.
