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

Click **+ Add camera** and enter the camera's RTSP URL, for example:

```
rtsp://username:password@192.168.1.50:554/stream1
```

The path after the port differs by brand — check the camera's manual or app.
Use `test://demo` to see a synthetic feed without any hardware.

If a camera connects but the picture stays black, it is probably sending
H.265; tick **Transcode to H.264** (uses more CPU).

## Configuration

| Variable       | Default     | Purpose                                           |
| -------------- | ----------- | ------------------------------------------------- |
| `PORT`         | `8080`      | HTTP port                                         |
| `HOST`         | `127.0.0.1` | Set `0.0.0.0` to allow other devices on your LAN  |
| `SECURECAM_DATA` | `./data`  | Where settings, cameras and live segments live    |
| `FFMPEG_PATH`  | `ffmpeg`    | Path to the ffmpeg binary                         |

`data/` holds your admin password hash and camera credentials. It is gitignored;
keep it out of version control.

## Security notes

- Don't expose this directly to the internet. For remote access use a VPN
  (e.g. Tailscale/WireGuard) or put it behind an HTTPS reverse proxy.
- Put the cameras on their own VLAN/network and block their internet access
  if your router allows it.
