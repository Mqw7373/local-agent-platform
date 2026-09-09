$ErrorActionPreference = 'Stop'

$platformRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataRoot = if ($env:LOCAL_AGENT_PLATFORM_HOME) {
  [System.IO.Path]::GetFullPath($env:LOCAL_AGENT_PLATFORM_HOME)
} else {
  Join-Path $env:USERPROFILE '.local-agent-platform'
}
$logRoot = Join-Path $dataRoot 'logs'
$stateRoot = Join-Path $dataRoot 'state'
New-Item -ItemType Directory -Path $logRoot, $stateRoot, (Join-Path $dataRoot 'runtime') -Force | Out-Null

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($HostName, $Port)
    return $task.Wait(300) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$components = @(
  @{ Name = 'mastra-coding-platform'; HostName = '127.0.0.1'; Port = 4113; Directory = 'services\mastra-coding-platform'; Executable = 'npm.cmd'; Arguments = @('run', 'dev'); Dependency = 'node_modules'; UsePortEnvironment = $true },
  @{ Name = 'langgraph-coding-platform'; HostName = '127.0.0.1'; Port = 4130; Directory = 'services\langgraph-coding-platform'; Executable = '.venv\Scripts\python.exe'; Arguments = @('-m', 'langgraph_coding_platform'); Dependency = '.venv\Scripts\python.exe'; UsePortEnvironment = $true },
  @{ Name = 'multica-mastra-bridge'; HostName = '127.0.0.1'; Port = 4120; Directory = 'services\multica-mastra-bridge'; Executable = 'npm.cmd'; Arguments = @('start'); Dependency = $null; UsePortEnvironment = $false },
  @{ Name = 'unified-hub'; HostName = '::1'; Port = 3000; Directory = 'apps\unified-hub'; Executable = 'npm.cmd'; Arguments = @('run', 'dev', '--', '--port', '3000'); Dependency = 'node_modules'; UsePortEnvironment = $false }
)

foreach ($component in $components) {
  if (Test-TcpPort $component.HostName $component.Port) {
    throw "Port $($component.Port) is already occupied. Stop the existing service before starting $($component.Name)."
  }
  $directory = [System.IO.Path]::GetFullPath((Join-Path $platformRoot $component.Directory))
  if (-not $directory.StartsWith($platformRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Component path escaped platform root: $directory"
  }
  if ($component.Dependency -and -not (Test-Path -LiteralPath (Join-Path $directory $component.Dependency))) {
    throw "Dependencies are missing for $($component.Name). Run npm run bootstrap first."
  }
}

$records = @()
foreach ($component in $components) {
  $directory = [System.IO.Path]::GetFullPath((Join-Path $platformRoot $component.Directory))
  $stdout = Join-Path $logRoot "$($component.Name).out.log"
  $stderr = Join-Path $logRoot "$($component.Name).err.log"
  $previousPort = $env:PORT
  try {
    if ($component.UsePortEnvironment) {
      $env:PORT = [string]$component.Port
    }
    $executable = if ([System.IO.Path]::IsPathRooted($component.Executable)) {
      $component.Executable
    } elseif ($component.Executable -eq 'npm.cmd') {
      'npm.cmd'
    } else {
      Join-Path $directory $component.Executable
    }
    $process = Start-Process -FilePath $executable -ArgumentList $component.Arguments `
      -WorkingDirectory $directory -WindowStyle Hidden -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr -PassThru
  } finally {
    if ($null -eq $previousPort) {
      Remove-Item Env:PORT -ErrorAction SilentlyContinue
    } else {
      $env:PORT = $previousPort
    }
  }
  $records += [pscustomobject]@{
    name = $component.Name
    port = $component.Port
    pid = $process.Id
    startedAt = $process.StartTime.ToUniversalTime().ToString('o')
    directory = $directory
  }
}

$processFile = Join-Path $stateRoot 'platform-processes.json'
$records | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $processFile -Encoding UTF8
Write-Output "Local Agent Platform started. Process record: $processFile"
Write-Output 'Run npm run status to verify service readiness.'
