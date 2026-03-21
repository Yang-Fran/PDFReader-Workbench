param(
  [switch]$SkipBrowser,
  [switch]$SkipPandoc,
  [switch]$SkipTypst,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $repoRoot "src-tauri\resources\tools"
$tempRoot = Join-Path $repoRoot ".tools\downloads"

New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Json {
  param([string]$Url)
  Invoke-RestMethod -Uri $Url -Headers @{ "User-Agent" = "PDFReader-Workbench-ToolsInstaller" }
}

function Download-File {
  param(
    [string]$Url,
    [string]$OutFile
  )

  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -Headers @{ "User-Agent" = "PDFReader-Workbench-ToolsInstaller" }
}

function Reset-Dir {
  param([string]$Path)
  if (Test-Path $Path) {
    Remove-Item -Recurse -Force $Path
  }
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Get-ChromeDownload {
  $manifest = Invoke-Json "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
  $downloads = $manifest.channels.Stable.downloads.chrome
  $target = $downloads | Where-Object { $_.platform -eq "win64" } | Select-Object -First 1
  if (-not $target) {
    throw "Could not find a Windows 64-bit Chrome for Testing download."
  }
  return @{
    Version = $manifest.channels.Stable.version
    Url = $target.url
  }
}

function Get-GitHubAsset {
  param(
    [string]$Repo,
    [string]$Pattern
  )

  $release = Invoke-Json "https://api.github.com/repos/$Repo/releases/latest"
  $asset = $release.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
  if (-not $asset) {
    throw "Could not find release asset for $Repo matching '$Pattern'."
  }
  return @{
    Version = $release.tag_name.TrimStart("v")
    Url = $asset.browser_download_url
    Name = $asset.name
  }
}

function Install-Chrome {
  $chromeRoot = Join-Path $toolsRoot "chromium"
  if ((Test-Path (Join-Path $chromeRoot "chrome-win64\chrome.exe")) -and -not $Force) {
    Write-Host "Chromium-compatible browser already present: $chromeRoot"
    return
  }

  Write-Step "Installing browser runtime into $chromeRoot"
  $download = Get-ChromeDownload
  $zipPath = Join-Path $tempRoot "chrome-win64.zip"
  $extractRoot = Join-Path $tempRoot "chrome-extract"

  Reset-Dir $extractRoot
  Download-File -Url $download.Url -OutFile $zipPath

  if (Test-Path $chromeRoot) {
    Remove-Item -Recurse -Force $chromeRoot
  }
  New-Item -ItemType Directory -Force -Path $chromeRoot | Out-Null

  Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
  Copy-Item -Recurse -Force (Join-Path $extractRoot "chrome-win64") $chromeRoot

  Write-Host "Installed browser version $($download.Version)"
}

function Install-Pandoc {
  $pandocRoot = Join-Path $toolsRoot "pandoc"
  if ((Test-Path (Join-Path $pandocRoot "pandoc.exe")) -and -not $Force) {
    Write-Host "Pandoc already present: $pandocRoot"
    return
  }

  Write-Step "Installing Pandoc into $pandocRoot"
  $download = Get-GitHubAsset -Repo "jgm/pandoc" -Pattern "windows-x86_64\.zip$"
  $zipPath = Join-Path $tempRoot $download.Name
  $extractRoot = Join-Path $tempRoot "pandoc-extract"

  Reset-Dir $extractRoot
  Download-File -Url $download.Url -OutFile $zipPath

  if (Test-Path $pandocRoot) {
    Remove-Item -Recurse -Force $pandocRoot
  }
  New-Item -ItemType Directory -Force -Path $pandocRoot | Out-Null

  Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
  $sourceDir = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
  Copy-Item -Force (Join-Path $sourceDir.FullName "pandoc.exe") $pandocRoot

  Write-Host "Installed Pandoc version $($download.Version)"
}

function Install-Typst {
  $typstRoot = Join-Path $toolsRoot "typst"
  if ((Test-Path (Join-Path $typstRoot "typst.exe")) -and -not $Force) {
    Write-Host "Typst already present: $typstRoot"
    return
  }

  Write-Step "Installing Typst into $typstRoot"
  $download = Get-GitHubAsset -Repo "typst/typst" -Pattern "x86_64-pc-windows-msvc\.zip$"
  $zipPath = Join-Path $tempRoot $download.Name
  $extractRoot = Join-Path $tempRoot "typst-extract"

  Reset-Dir $extractRoot
  Download-File -Url $download.Url -OutFile $zipPath

  if (Test-Path $typstRoot) {
    Remove-Item -Recurse -Force $typstRoot
  }
  New-Item -ItemType Directory -Force -Path $typstRoot | Out-Null

  Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force
  $sourceDir = Get-ChildItem $extractRoot -Directory | Select-Object -First 1
  Copy-Item -Force (Join-Path $sourceDir.FullName "typst.exe") $typstRoot

  Write-Host "Installed Typst version $($download.Version)"
}

if (-not $SkipBrowser) {
  Install-Chrome
}

if (-not $SkipPandoc) {
  Install-Pandoc
}

if (-not $SkipTypst) {
  Install-Typst
}

Write-Step "Export tool bootstrap complete"
Write-Host "Installed tools live under: $toolsRoot"
