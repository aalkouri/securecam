# Restart the SecureCam server: stop whatever is serving the port (including
# its ffmpeg processes), then start it again in the background.
# Run with:  npm run restart
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 8080 }

# Stop a whole process tree and wait until every process in it has exited.
# ffmpeg holds its stream folder open until it is completely gone, and a
# server started too early cannot clear those folders.
function Stop-Tree($top) {
  $all = Get-CimInstance Win32_Process
  $tree = @($top)
  $frontier = @($top)
  while ($frontier.Count -gt 0) {
    $kids = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId })
    $tree += $kids
    $frontier = $kids
  }
  taskkill /PID $top /T /F 2>&1 | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-Process -Id $tree)) { break }
    Start-Sleep -Milliseconds 250
  }
}

# Stale "node --watch" copies left over from earlier starts keep respawning a
# server that cannot get the port but still runs ffmpeg. Clear them out first.
# (Plain "node server/index.js" test servers on other ports are left alone.)
$listener = (Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -First 1).OwningProcess
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match '--watch\s+server[\\/]index\.js' } |
  ForEach-Object {
    $kidIds = @((Get-CimInstance Win32_Process -Filter "ParentProcessId=$($_.ProcessId)").ProcessId)
    if ($kidIds -notcontains $listener) {
      Stop-Tree $_.ProcessId
      Write-Host "Stopped a stale SecureCam copy (process $($_.ProcessId))."
    }
  }

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
  Stop-Tree $top
  Write-Host "Stopped SecureCam (process $top)."
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
