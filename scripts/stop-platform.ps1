$ErrorActionPreference = 'Stop'

$dataRoot = if ($env:LOCAL_AGENT_PLATFORM_HOME) {
  [System.IO.Path]::GetFullPath($env:LOCAL_AGENT_PLATFORM_HOME)
} else {
  Join-Path $env:USERPROFILE '.local-agent-platform'
}
$processFile = Join-Path $dataRoot 'state\platform-processes.json'
if (-not (Test-Path -LiteralPath $processFile)) {
  Write-Output 'No platform process record exists.'
  exit 0
}

$records = Get-Content -Raw -LiteralPath $processFile | ConvertFrom-Json
foreach ($record in $records) {
  $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
  if (-not $process) {
    Write-Output "$($record.name): already stopped"
    continue
  }
  $actualStart = ([DateTime]$process.StartTime).ToUniversalTime()
  $expectedStart = ([DateTime]::Parse([string]$record.startedAt)).ToUniversalTime()
  if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 1) {
    Write-Warning "$($record.name): PID $($record.pid) was reused; refusing to stop it."
    continue
  }
  & taskkill.exe /PID $record.pid /T /F | Out-Null
  Write-Output "$($record.name): stopped"
}

Remove-Item -LiteralPath $processFile
