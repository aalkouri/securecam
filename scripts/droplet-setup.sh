#!/usr/bin/env bash
# One-time root setup for SecureCam on the games-server droplet.
# The app itself lives in /home/deploy/securecam (app, data, its own Node) and
# is put there by scripts/droplet-pull.sh. This script adds the parts only root can:
# ffmpeg, the systemd service, permission for `deploy` to restart it, and the
# Caddy site. Safe to run again.
#   sudo bash /home/deploy/securecam/app/scripts/droplet-setup.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this with sudo."; exit 1; }
DOMAIN=securecam.alkouri.com
PORT=8082
HOME_DIR=/home/deploy/securecam
[ -x "$HOME_DIR/node/bin/node" ] && [ -f "$HOME_DIR/app/server/index.js" ] || { echo "Deploy the app first (bash ~/securecam-pull.sh --force)."; exit 1; }

echo "== ffmpeg"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg fonts-dejavu-core >/dev/null
ffmpeg -version | head -1

echo "== service"
cat > /etc/systemd/system/securecam.service <<EOF
[Unit]
Description=SecureCam
After=network.target
[Service]
User=deploy
WorkingDirectory=$HOME_DIR/app
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=1
Environment=SECURECAM_DATA=$HOME_DIR/data
ExecStart=$HOME_DIR/node/bin/node server/index.js
Restart=always
RestartSec=3
# The games on this droplet come first: SecureCam yields CPU and is capped on memory.
Nice=5
CPUWeight=50
MemoryMax=1G
[Install]
WantedBy=multi-user.target
EOF
echo 'deploy ALL=(root) NOPASSWD: /bin/systemctl restart securecam' > /etc/sudoers.d/securecam
chmod 440 /etc/sudoers.d/securecam
visudo -cf /etc/sudoers.d/securecam >/dev/null
systemctl daemon-reload
systemctl enable -q securecam
systemctl restart securecam

echo "== caddy"
CADDYFILE=/etc/caddy/Caddyfile
if ! grep -q "^$DOMAIN" "$CADDYFILE"; then
  BACKUP="$CADDYFILE.bak-$(date +%F-%H%M%S)"
  cp "$CADDYFILE" "$BACKUP"
  cat >> "$CADDYFILE" <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    cp "$BACKUP" "$CADDYFILE"
    echo "Caddy rejected the new site; the old config was restored."; exit 1
  fi
fi
systemctl reload caddy

sleep 4
systemctl is-active securecam
curl -fs -o /dev/null -w "SecureCam answers locally: %{http_code}\n" "http://127.0.0.1:$PORT/login.html"
echo "Done. Once DNS for $DOMAIN points here, Caddy fetches the HTTPS certificate by itself."
