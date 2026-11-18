# AutoTask AI v1.1.7-rc.2 - Clean & Portable Release Packaging Script
# Uses strict allowlist, POSIX forward-slash paths for cross-platform extraction,
# and excludes all private credentials, reports, caches, build artifacts, and node_modules.

param(
    [string]$OutFile = "release/autotask-ai-v1.1.7-rc.2.zip"
)

$ErrorActionPreference = "Stop"

$workspaceRoot = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location $workspaceRoot

Write-Host "AutoTask AI Clean & Portable Release Packager (v1.1.7-rc.2)" -ForegroundColor Cyan
Write-Host "Workspace: $workspaceRoot"

# Define destination and staging path
$outCandidate = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $workspaceRoot $OutFile }
$outResolved = [System.IO.Path]::GetFullPath($outCandidate)
$outDir = [System.IO.Path]::GetDirectoryName($outResolved)
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$stagingDir = Join-Path $env:TEMP ("autotask-staging-" + [System.Guid]::NewGuid().ToString("N"))
$tempZip = Join-Path $env:TEMP ("autotask-archive-" + [System.Guid]::NewGuid().ToString("N") + ".zip")
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

try {
    # 1. Root Allowlist Files
    $rootFiles = @("package.json", "package-lock.json", "tsconfig.json", "README.md", "LICENSE", "Start_AutoTask_AI.cmd", "RELEASE_NOTES_v1.1.7-rc.md")
    foreach ($f in $rootFiles) {
        $srcPath = Join-Path $workspaceRoot $f
        if (Test-Path $srcPath) {
            Copy-Item -Path $srcPath -Destination (Join-Path $stagingDir $f) -Force
        }
    }

    # 2. Allowlisted Subdirectories (Exclude reports/ from distribution package)
    $allowedDirs = @("src", "desktop", "scripts", "tests", "templates", "themes", "docs", "examples", "resources")
    foreach ($d in $allowedDirs) {
        $srcDir = Join-Path $workspaceRoot $d
        if (Test-Path $srcDir) {
            $destDir = Join-Path $stagingDir $d
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null

            Get-ChildItem -Path $srcDir -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($srcDir.Length).TrimStart("\", "/")
                
                # Check forbidden filters
                $isForbidden = (
                    $rel -match "(?:^|[\\/])__pycache__(?:[\\/]|$)" -or
                    $rel -match "\.pyc$" -or
                    $rel -match "\.log$" -or
                    $rel -match "(?:^|[\\/])\.private(?:[\\/]|$)" -or
                    $rel -match "(?:^|[\\/])\.env" -or
                    $rel -match "\.zip$"
                )

                if (-not $isForbidden) {
                    $targetFile = Join-Path $destDir $rel
                    $targetParent = [System.IO.Path]::GetDirectoryName($targetFile)
                    if (-not (Test-Path $targetParent)) {
                        New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
                    }
                    Copy-Item -Path $_.FullName -Destination $targetFile -Force
                }
            }
        }
    }

    # 3. Create Clean Archive in isolated temp path first (prevents concurrent reader race on Windows)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipStream = [System.IO.File]::Open($tempZip, [System.IO.FileMode]::Create)
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)

    Get-ChildItem -Path $stagingDir -Recurse -File | ForEach-Object {
        $relPath = $_.FullName.Substring($stagingDir.Length).TrimStart("\", "/").Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $_.FullName,
            $relPath,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }

    $archive.Dispose()
    $zipStream.Dispose()

    # 4. Strict Archive Validation
    $verifyArchive = [System.IO.Compression.ZipFile]::OpenRead($tempZip)
    $entryCount = $verifyArchive.Entries.Count
    $forbiddenViolations = @()
    $nonPosixPaths = @()

    foreach ($entry in $verifyArchive.Entries) {
        $p = $entry.FullName
        if ($p.Contains("\")) {
            $nonPosixPaths += $p
        }
        if ($p -match "(?:^|[\\/])\.private(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])node_modules(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])dist(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])\.git(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])artifacts(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])\.gemini(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])reports(?:[\\/]|$)" -or
            $p -match "(?:^|[\\/])__pycache__(?:[\\/]|$)" -or
            $p -match "\.pyc$" -or
            $p -match "\.env") {
            $forbiddenViolations += $p
        }
    }
    $verifyArchive.Dispose()

    if ($nonPosixPaths.Count -gt 0) {
        Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
        throw "Packaging FAILED! Found $($nonPosixPaths.Count) non-POSIX Windows backslash paths in archive: $($nonPosixPaths[0])"
    }

    if ($forbiddenViolations.Count -gt 0) {
        Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
        throw "Release verification FAILED! Found $($forbiddenViolations.Count) forbidden files in package: $($forbiddenViolations -join ', ')"
    }

    $placed = $false
    $lastMoveErr = $null
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        try {
            Copy-Item -Path $tempZip -Destination $outResolved -Force
            $placed = $true
            break
        }
        catch {
            $lastMoveErr = $_
            Start-Sleep -Milliseconds (200 * $attempt)
        }
    }
    if (-not $placed) {
        throw "Failed to write verified archive to ${outResolved}: $lastMoveErr"
    }

    $fileInfo = Get-Item $outResolved
    $sizeMB = [Math]::Round($fileInfo.Length / 1MB, 2)

    Write-Host "SUCCESS: Clean & portable release package created." -ForegroundColor Green
    Write-Host "Archive: $outResolved"
    Write-Host "Size: $sizeMB MB ($($fileInfo.Length) bytes)"
    Write-Host "Files bundled: $entryCount"
    Write-Host "All paths verified POSIX compliant (100% '/' forward slashes, 0 '\')." -ForegroundColor Green
    Write-Host "All forbidden directories (.private, node_modules, dist, __pycache__, reports) cleanly excluded." -ForegroundColor Green
}
finally {
    if (Test-Path $tempZip) {
        Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $stagingDir) {
        Remove-Item -Path $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
