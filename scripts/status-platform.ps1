$ErrorActionPreference = 'Continue'

$services = @(
  @{ Name = 'Unified Hub'; Url = 'http://localhost:3000/' },
  @{ Name = 'Coding Platform'; Url = 'http://127.0.0.1:4113/api/workflows' },
  @{ Name = 'LangGraph Coding Platform'; Url = 'http://127.0.0.1:4130/healthz' },
  @{ Name = 'Multica-Mastra Bridge'; Url = 'http://127.0.0.1:4120/healthz' },
  @{ Name = 'Theme Research API'; Url = 'http://127.0.0.1:4112/api/workflows' },
  @{ Name = 'Multica'; Url = 'http://127.0.0.1:8080/healthz' }
)

$results = foreach ($service in $services) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $service.Url -TimeoutSec 3
    [pscustomobject]@{ Service = $service.Name; Online = $true; Status = [int]$response.StatusCode; Url = $service.Url }
  } catch {
    [pscustomobject]@{ Service = $service.Name; Online = $false; Status = 0; Url = $service.Url }
  }
}

$results | Format-Table -AutoSize
