param(
  [string]$PagesUrl = "",
  [string]$AppUrl = "http://localhost:4317",
  [string]$RagflowApiUrl = "http://localhost:9380",
  [string]$LocalApiKey = "local-dev-key"
)

$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $PSScriptRoot
$RootDir = Split-Path -Parent $AppDir
$RagflowDir = Join-Path $RootDir "ragflow\docker"
$LogDir = Join-Path $AppDir "data\logs"
$AppLog = Join-Path $LogDir "rag-kb-app.log"
if (!$PagesUrl) {
  $cacheVersion = Get-Date -Format "yyyyMMddHHmmss"
  $encodedKey = [uri]::EscapeDataString($LocalApiKey)
  $PagesUrl = "https://pilipiliwang.github.io/ragflow-kb-app/login.html?api=http%3A%2F%2Flocalhost%3A4317&key=$encodedKey&v=$cacheVersion"
}

function Write-Step {
  param([string]$Message)
  Write-Host "[rag-kb] $Message"
}

function Wait-Http {
  param(
    [string]$Url,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      $statusCode = $null
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
      }
      if ($statusCode -ge 200 -and $statusCode -lt 500) {
        return $true
      }
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)

  return $false
}

function Wait-DockerHealth {
  param(
    [string]$ContainerName,
    [int]$TimeoutSeconds = 120
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $status = docker inspect -f "{{.State.Health.Status}}" $ContainerName 2>$null
    if ($status -eq "healthy") {
      return $true
    }
    if ($status -eq "") {
      $running = docker inspect -f "{{.State.Running}}" $ContainerName 2>$null
      if ($running -eq "true") {
        return $true
      }
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)

  return $false
}

function Test-DockerReady {
  try {
    docker info *> $null
    return $true
  } catch {
    return $false
  }
}

function Test-AppApiKey {
  try {
    $headers = @{ "X-API-Key" = $LocalApiKey }
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$AppUrl/api/health" -Headers $headers -TimeoutSec 8
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Stop-AppListener {
  $connections = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue
  if (!$connections) {
    return
  }

  $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      Write-Step "Stopping existing App backend process: $($process.Id)"
      Stop-Process -Id $process.Id -Force
    }
  }
}

function Start-DockerDesktop {
  $dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path -LiteralPath $dockerDesktop) {
    Write-Step "Docker is not ready. Starting Docker Desktop..."
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
  }
}

function Wait-DockerReady {
  if (Test-DockerReady) {
    return
  }

  Start-DockerDesktop
  $deadline = (Get-Date).AddSeconds(120)
  do {
    if (Test-DockerReady) {
      return
    }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)

  throw "Docker did not become ready. Open Docker Desktop, wait until it is running, then retry."
}

function Start-Ragflow {
  if (!(Test-Path -LiteralPath $RagflowDir)) {
    throw "RAGFlow directory not found: $RagflowDir"
  }

  Write-Step "Starting RAGFlow Docker services..."
  Push-Location $RagflowDir
  try {
    docker compose up -d es01
    if (!(Wait-DockerHealth -ContainerName "docker-es01-1" -TimeoutSeconds 120)) {
      throw "Elasticsearch container did not become healthy."
    }
    docker compose --profile cpu up -d
  } finally {
    Pop-Location
  }

  if (!(Wait-Http -Url $RagflowApiUrl -TimeoutSeconds 90)) {
    Write-Step "RAGFlow API is not responding yet. Restarting ragflow-cpu once..."
    Push-Location $RagflowDir
    try {
      docker compose --profile cpu restart ragflow-cpu
    } finally {
      Pop-Location
    }
  }

  if (!(Wait-Http -Url $RagflowApiUrl -TimeoutSeconds 120)) {
    Write-Step "RAGFlow API is not responding yet, but Docker services are running."
  } else {
    Write-Step "RAGFlow API is responding: $RagflowApiUrl"
  }
}

function Start-App {
  if (!(Test-Path -LiteralPath (Join-Path $AppDir "package.json"))) {
    throw "App directory not found: $AppDir"
  }

  if (Wait-Http -Url $AppUrl -TimeoutSeconds 3) {
    if (Test-AppApiKey) {
      Write-Step "App backend is already running: $AppUrl"
      return
    }
    Write-Step "App backend is running without the expected local API key. Restarting it..."
    Stop-AppListener
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Write-Step "Starting App backend. Log: $AppLog"
  $escapedAppDir = $AppDir.Replace("'", "''")
  $escapedLog = $AppLog.Replace("'", "''")
  $escapedKey = $LocalApiKey.Replace("'", "''")
  $command = "Set-Location -LiteralPath '$escapedAppDir'; `$env:EXTERNAL_API_KEYS='$escapedKey'; npm start *> '$escapedLog'"
  Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) -WindowStyle Hidden

  if (!(Wait-Http -Url $AppUrl -TimeoutSeconds 60)) {
    throw "App backend did not respond within 60 seconds. Check log: $AppLog"
  }
  if (!(Test-AppApiKey)) {
    throw "App backend started, but local API key is not accepted. Check log: $AppLog"
  }

  Write-Step "App backend is responding: $AppUrl"
}

Wait-DockerReady
Start-Ragflow
Start-App

Write-Host ""
Write-Host "RAG knowledge service is ready."
Write-Host "Local App: $AppUrl"
Write-Host "RAGFlow API: $RagflowApiUrl"
Write-Host "Local API Key: $LocalApiKey"
Write-Host "GitHub Pages: $PagesUrl"
