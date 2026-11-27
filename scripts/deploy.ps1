# Deploy the committed code (HEAD) to the droplet. Run with:  npm run deploy
# Uses the "games-server" entry in ~/.ssh/config. Only code is sent; the
# droplet keeps its own data folder (login, cameras, database).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sshHost = if ($env:SECURECAM_DEPLOY_HOST) { $env:SECURECAM_DEPLOY_HOST } else { 'games-server' }
$archive = Join-Path $env:TEMP 'securecam-src.tgz'

Push-Location $root
try {
  if (git status --porcelain) { Write-Host 'Note: uncommitted changes are not deployed.' }
  $sha = (git rev-parse --short HEAD).Trim()
  git archive --format=tar.gz -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
} finally { Pop-Location }

scp -q $archive "${sshHost}:/tmp/securecam-src.tgz"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
Remove-Item $archive

$remote = @'
set -e
export PATH=$HOME/securecam/node/bin:$PATH
cd ~/securecam/app
rm -rf server public scripts
tar xzf /tmp/securecam-src.tgz
rm /tmp/securecam-src.tgz
npm ci --omit=dev --silent
if systemctl cat securecam >/dev/null 2>&1; then
  sudo -n /bin/systemctl restart securecam
  for i in $(seq 1 15); do
    sleep 2
    if curl -fs -o /dev/null http://127.0.0.1:8082/login.html; then echo "SecureCam is up on the droplet."; exit 0; fi
  done
  echo "SecureCam did not come back. Check: journalctl -u securecam -n 50"; exit 1
else
  echo "Code is in place, but the service is not set up yet."
  echo "Run once on the droplet:  sudo bash ~/securecam/app/scripts/droplet-setup.sh"
fi
'@ -replace "`r", ''
ssh -o BatchMode=yes $sshHost $remote
if ($LASTEXITCODE -ne 0) { throw 'Deploy failed' }
Write-Host "Deployed $sha."
