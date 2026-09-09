$ErrorActionPreference = 'Stop'

$platformRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serviceRoot = Join-Path $platformRoot 'services\langgraph-coding-platform'
$python = Join-Path $serviceRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
  throw 'LangGraph dependencies are missing. Run npm run bootstrap first.'
}

Push-Location $serviceRoot
try {
  & $python -m pytest -q
  if ($LASTEXITCODE -ne 0) { throw "LangGraph tests failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}
