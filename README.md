# SecureCam

A self-hosted web app for viewing your IP cameras from a browser.

Each camera's RTSP feed is converted to HLS by `ffmpeg` on the server, so the
browser plays it with no plugins. Camera passwords stay on the server and are
never sent to the browser.

## Requirements

- Node.js 20+
- `ffmpeg` on your PATH (or set `FFMPEG_PATH`)

## Run

```powershell
npm install
npm start
```

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

Use `test://demo` (type *Other*) to try the app without any hardware.

To loop a recorded video as a stand-in camera, put the file in `data/clips/`
and add a camera of type *Other* with the URL `clip://your-file.mp4`.

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
