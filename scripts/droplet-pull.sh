#!/usr/bin/env bash
# Pull-based deploy for SecureCam. Runs as the `deploy` user on games-server,
# from cron every minute (installed as ~/securecam-pull.sh; this is the copy
# of record). Public repo, no secrets: asks GitHub for main, downloads that
# exact commit, checks it, installs dependencies in a fresh folder, swaps it
# in, restarts the service, and rolls back if the login page does not answer.
#   bash ~/securecam-pull.sh          deploy main if it moved
#   bash ~/securecam-pull.sh --force  redeploy main even if already deployed
#   bash ~/securecam-pull.sh --cron   same as the first, but only log real deploys
set -euo pipefail
REPO=aalkouri/securecam
BASE="$HOME/securecam"
APP="$BASE/app"
STATE="$HOME/securecam-deploy"
PORT=8082
export PATH="$BASE/node/bin:$PATH"
mkdir -p "$STATE"

if [ "${1:-}" = "--cron" ]; then
  out=$(bash "$0" 2>&1) && rc=0 || rc=$?
  case "$out" in "already deployed"*|"another deploy is running"*) exit 0;; esac
  { echo "=== $(date -u) rc=$rc"; echo "$out"; } >> "$STATE/deploy.log"
  tail -n 400 "$STATE/deploy.log" > "$STATE/deploy.log.tmp" && mv "$STATE/deploy.log.tmp" "$STATE/deploy.log"
  exit 0
fi

exec 9>"$STATE/lock"; flock -n 9 || { echo "another deploy is running"; exit 0; }

SHA=$(git ls-remote "https://github.com/$REPO.git" refs/heads/main | cut -f1)
[ "${#SHA}" = 40 ] || { echo "cannot read main of $REPO"; exit 1; }
if [ "${1:-}" != "--force" ] && [ "$SHA" = "$(cat "$STATE/last-sha" 2>/dev/null || true)" ]; then
  echo "already deployed $SHA"; exit 0
fi
echo "deploying $REPO main @ $SHA"

# Build next to the app (same disk) so the swap is a rename.
TMP=$(mktemp -d -p "$STATE"); trap 'rm -rf "$TMP"' EXIT
curl -fsSL --max-time 90 "https://codeload.github.com/$REPO/tar.gz/$SHA" -o "$TMP/src.tgz"
mkdir "$TMP/src"; tar xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1
cd "$TMP/src"
for f in server/*.js public/*.js; do node --check "$f"; done
npm ci --omit=dev --silent
cd "$STATE"

up() {
  for i in $(seq 1 20); do
    sleep 2
    if systemctl is-active --quiet securecam && curl -fs -o /dev/null "http://127.0.0.1:$PORT/login.html"; then return 0; fi
  done
  return 1
}

rm -rf "$STATE/prev"
mv "$APP" "$STATE/prev"
mv "$TMP/src" "$APP"
sudo -n /bin/systemctl restart securecam
if ! up; then
  echo "FAILED: restoring the previous version"
  rm -rf "$APP"; mv "$STATE/prev" "$APP"
  sudo -n /bin/systemctl restart securecam || true
  # Remember the bad commit so cron does not retry it every minute.
  echo "$SHA" > "$STATE/last-sha"
  exit 1
fi

echo "$SHA" > "$STATE/last-sha"
echo "deployed $SHA"
