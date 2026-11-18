# Dedicated Windows Terminal profile for AutoTask AI. Supports Windows PowerShell 5.1 and PowerShell 7.
# Never changes the default profile. Always backs up before writing settings.
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'Run on Windows with LOCALAPPDATA.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$schemePath = Join-Path $root 'terminal/windows-terminal-scheme.json'
$appearancePath = Join-Path $root 'terminal/windows-terminal-profile-settings.json'
if (-not (Test-Path $schemePath) -or -not (Test-Path $appearancePath)) { throw 'Run npm run theme to generate a profile first.' }
$scheme = Get-Content -LiteralPath $schemePath -Raw | ConvertFrom-Json
$appearance = Get-Content -LiteralPath $appearancePath -Raw | ConvertFrom-Json
$locations = @(
 (Join-Path $env:LOCALAPPDATA 'Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json'),
 (Join-Path $env:LOCALAPPDATA 'Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json'),
 (Join-Path $env:LOCALAPPDATA 'Microsoft/Windows Terminal/settings.json')
)
$settingsPath = $locations | Where-Object {Test-Path $_} | Select-Object -First 1
if (-not $settingsPath) {throw 'Windows Terminal settings.json not found. Open Windows Terminal once, then retry.'}
Write-Host ('Target: ' + $settingsPath)
Write-Host ('Color scheme: ' + $scheme.name)
if (-not $Apply) {Write-Host 'Preview only; specify -Apply to save a new dedicated profile.'; exit 0}
# Deliberately refuse JSON with comments/trailing commas if ConvertFrom-Json cannot parse safely.
try {$settings=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json}
catch {throw 'Cannot parse settings.json (possibly JSONC). Merge exported snippets manually; source file is unchanged.'}
if (-not $settings.PSObject.Properties['schemes']) {$settings | Add-Member -NotePropertyName schemes -NotePropertyValue @()}
$settings.schemes = @($settings.schemes | Where-Object {$_.name -ne $scheme.name}) + @($scheme)
if (-not $settings.PSObject.Properties['profiles']) {$settings | Add-Member -NotePropertyName profiles -NotePropertyValue ([pscustomobject]@{list=@()})}
if (-not $settings.profiles.PSObject.Properties['list']) {$settings.profiles | Add-Member -NotePropertyName list -NotePropertyValue @()}
$guid='{b3816a18-6d43-4b99-9895-1100ac7a0707}'
$settings.profiles.list = @($settings.profiles.list | Where-Object {$_.guid -ne $guid})
$profile = [pscustomobject]@{
 guid=$guid; name='AutoTask AI'; hidden=$false; commandline='powershell.exe';
 startingDirectory=$root; colorScheme=$scheme.name;
 font=[pscustomobject]@{face=$appearance.font.face;size=$appearance.font.size};
 opacity=$appearance.opacity; useAcrylic=$appearance.useAcrylic; cursorShape=if ($appearance.cursorShape) {$appearance.cursorShape} else {'bar'}
}
$settings.profiles.list = @($settings.profiles.list) + @($profile)
$backup=$settingsPath+'.autotask-backup.'+(Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $settingsPath -Destination $backup -ErrorAction Stop
$temp=$settingsPath+'.autotask.tmp'
try {
 $settings | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $temp -Encoding UTF8 -ErrorAction Stop
 # Ensure produced JSON is valid before replacing original.
 $null = Get-Content -LiteralPath $temp -Raw | ConvertFrom-Json
 Move-Item -LiteralPath $temp -Destination $settingsPath -Force -ErrorAction Stop
 Write-Host ('Dedicated profile saved. Backup: '+$backup)
 Write-Host 'Restart Windows Terminal > AutoTask AI profile, then run npm start.'
} finally {if (Test-Path $temp){Remove-Item -LiteralPath $temp -Force}}
