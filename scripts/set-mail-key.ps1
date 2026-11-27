# Store a Resend API key from the clipboard in the private config, here and on
# the droplet, without showing it. Copy the key in Resend first, then run:
#   powershell -ExecutionPolicy Bypass -File scripts/set-mail-key.ps1 -From "SecureCam <noreply@example.com>"
param(
  [Parameter(Mandatory = $true)][string]$From,
  [string]$SshHost = 'games-server'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$key = (Get-Clipboard -Raw)
if ($key) { $key = $key.Trim() }
if (-not $key -or $key -notmatch '^re_[A-Za-z0-9_]{10,}$') {
  Write-Host 'The clipboard does not hold a Resend API key (it should start with "re_"). Copy the key and run this again.'
  exit 1
}

$json = @{ resend = @{ apiKey = $key; from = $From } } | ConvertTo-Json -Compress

Push-Location $root
try {
  $json | node scripts/merge-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Could not update the local config' }
} finally { Pop-Location }

$remote = 'cd ~/securecam/app && SECURECAM_DATA=$HOME/securecam/data $HOME/securecam/node/bin/node scripts/merge-config.mjs && sudo -n /bin/systemctl restart securecam && echo "Droplet restarted with the new key."'
$json | ssh -o BatchMode=yes $SshHost $remote
if ($LASTEXITCODE -ne 0) { throw 'Could not update the droplet' }

# Do not leave the key on the clipboard.
Set-Clipboard -Value ' '
Write-Host 'Done. The local server picks the key up at its next restart (npm run restart).'
