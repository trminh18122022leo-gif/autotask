# AutoTask AI Windows first-run bootstrap. No credentials are requested or written by this script.
param([switch]$SkipBrowserInstall,[switch]$SkipTests)
$ErrorActionPreference='Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function RunStep([string]$label,[string]$exe,[string[]]$arguments) {
 Write-Host ("`n[AutoTask AI] "+$label) -ForegroundColor Cyan
 & $exe @arguments
 if($LASTEXITCODE -ne 0){throw ($label+' failed (exit '+$LASTEXITCODE+'). See error above.')}
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {throw 'Install Node.js 20+ first.'}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {throw 'npm not detected.'}
$python='python';$pythonArgs=@()
if (Get-Command py -ErrorAction SilentlyContinue){$python='py';$pythonArgs=@('-3')}
elseif (-not (Get-Command python -ErrorAction SilentlyContinue)){throw 'Install Python 3.11+ first.'}
RunStep 'Install Node packages' 'npm' @('install','--no-audit','--no-fund')
RunStep 'Install Python workers' $python ($pythonArgs+@('-m','pip','install','-r','desktop/requirements.txt'))
if (-not $SkipBrowserInstall){RunStep 'Install Playwright Chromium' 'npx' @('playwright','install','chromium')}
if (-not $SkipTests){
 RunStep 'TypeScript typecheck' 'npm' @('run','typecheck')
 RunStep 'Node unit tests' 'npm' @('test')
 RunStep 'Chromium local DOM tests' 'npm' @('run','smoke:local')
 RunStep 'Python policy tests' $python ($pythonArgs+@('-m','unittest','discover','-s','tests','-p','*test.py'))
}
Write-Host "`nSetup complete. Run npm run doctor, then npm start." -ForegroundColor Green
Write-Host 'Use Model Vault and Account Vault; never paste an API key/password into chat.'
