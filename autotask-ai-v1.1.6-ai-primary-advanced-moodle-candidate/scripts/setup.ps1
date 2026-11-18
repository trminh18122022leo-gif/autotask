# AutoTask AI - Windows Deployment & Setup Bootstrap Script
# Compatible with PowerShell 5.1 and PowerShell 7+
[CmdletBinding()]
param(
    [switch]$SkipBrowserInstall,
    [switch]$SkipTests,
    [switch]$Help
)

if ($Help) {
    Write-Host "AutoTask AI Setup Script"
    Write-Host "Usage: .\scripts\setup.ps1 [-SkipBrowserInstall] [-SkipTests]"
    exit 0
}

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

function Write-Step([string]$title) {
    Write-Host "`n[AutoTask AI] === $title ===" -ForegroundColor Cyan
}

function Write-Success([string]$msg) {
    Write-Host "[OK] $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

# 1. Check Node.js
Write-Step "Checking Node.js Runtime"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20+ is required but not found in PATH. Please install from https://nodejs.org/"
}
$nodeVer = node -v
Write-Success "Node.js detected: $nodeVer"

# 2. Check Python
Write-Step "Checking Python Environment"
$python = "python"
$pythonArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
    $python = "py"
    $pythonArgs = @("-3")
} elseif (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python 3.11+ is required but not found in PATH. Please install from https://python.org/"
}
$pyVer = & $python ($pythonArgs + @("-c", "import sys; print(sys.version.split()[0])"))
Write-Success "Python detected: $pyVer"

# 3. Install Node packages
Write-Step "Installing Node.js Dependencies"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
Write-Success "Node packages installed successfully"

# 4. Install Python requirements
Write-Step "Installing Python Workers & Keyring Requirements"
& $python ($pythonArgs + @("-m", "pip", "install", "-r", "desktop/requirements.txt"))
if ($LASTEXITCODE -ne 0) { throw "pip install failed with exit code $LASTEXITCODE" }
Write-Success "Python packages installed successfully"

# 5. Playwright Chromium
if (-not $SkipBrowserInstall) {
    Write-Step "Installing Playwright Chromium Browser"
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install failed with exit code $LASTEXITCODE" }
    Write-Success "Playwright Chromium browser ready"
}

# 6. Verify Windows Keyring
Write-Step "Verifying Windows Credential Manager Access"
$krCheck = & $python ($pythonArgs + @("desktop/vault_bridge.py", "check"))
if ($LASTEXITCODE -eq 0 -and $krCheck -match "KEYRING_OK:(.+)") {
    Write-Success "OS Credential Vault active: $($Matches[1])"
} else {
    Write-Warn "Windows Credential Manager check returned: $krCheck"
}

# 7. Run Test Suite
if (-not $SkipTests) {
    Write-Step "Running Verification Test Suite"
    
    Write-Host "-> TypeScript Typecheck..." -ForegroundColor Gray
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "TypeScript typecheck failed" }
    
    Write-Host "-> Unit Tests..." -ForegroundColor Gray
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Unit tests failed" }

    Write-Host "-> Playwright Browser Smoke Test..." -ForegroundColor Gray
    npm run smoke:local
    if ($LASTEXITCODE -ne 0) { throw "Browser smoke test failed" }

    Write-Host "-> Python Worker Tests..." -ForegroundColor Gray
    & $python ($pythonArgs + @("-m", "unittest", "discover", "-s", "tests", "-p", "*test.py"))
    if ($LASTEXITCODE -ne 0) { throw "Python tests failed" }

    Write-Success "All tests passed successfully (TypeScript, Node, Python, Chromium DOM)"
}

Write-Step "Deployment Complete"
Write-Host "AutoTask AI Workstation is ready to launch!" -ForegroundColor Green
Write-Host "  1. Run System Doctor : npm run doctor" -ForegroundColor Cyan
Write-Host "  2. Open Command Deck : npm start" -ForegroundColor Cyan
Write-Host "  3. Configure Model   : npm run models" -ForegroundColor Cyan
Write-Host "  4. Setup Tasks       : npm run setup" -ForegroundColor Cyan
