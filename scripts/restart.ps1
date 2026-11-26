# Restart the SecureCam server: stop whatever is serving the port (including
# its ffmpeg processes), then start it again in the background.
# Run with:  npm run restart
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 8080 }

$conn = Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -First 1
if ($conn) {
  # Walk up to the outermost node process (e.g. "node --watch") so nothing
  # is left behind to respawn the server, then stop that whole process tree.
  $top = $conn.OwningProcess
  while ($true) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$top"
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)"
    if ($parent -and $parent.Name -eq 'node.exe') { $top = $parent.ProcessId } else { break }
  }
  taskkill /PID $top /T /F | Out-Null
  Write-Host "Stopped SecureCam (process $top)."
  Start-Sleep -Seconds 1
} else {
  Write-Host "SecureCam was not running on port $port."
}

New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
$log = Join-Path $root 'data\server.log'
$errLog = Join-Path $root 'data\server-error.log'

# --watch restarts the server by itself whenever the code changes.
Start-Process node -ArgumentList '--watch', 'server/index.js' -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort $port -State Listen) {
    Write-Host "SecureCam is running at http://localhost:$port"
    Write-Host "Logs: $log"
    exit 0
  }
}
Write-Host "SecureCam did not start. Check $errLog"
exit 1
