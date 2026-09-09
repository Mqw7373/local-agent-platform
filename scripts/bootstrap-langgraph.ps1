$ErrorActionPreference = 'Stop'

$platformRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serviceRoot = Join-Path $platformRoot 'services\langgraph-coding-platform'
$virtualEnvironment = Join-Path $serviceRoot '.venv'
$python = Join-Path $virtualEnvironment 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
  & python -m venv $virtualEnvironment
}

& $python -m pip install --disable-pip-version-check -e "$serviceRoot[test]"
