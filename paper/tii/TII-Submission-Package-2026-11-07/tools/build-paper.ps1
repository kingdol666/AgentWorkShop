$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$ManuscriptDir = Join-Path $PackageRoot 'manuscript'
$SupplementaryDir = Join-Path $PackageRoot 'supplementary'
$BuildRoot = Join-Path $PackageRoot 'build'
$MainBuildDir = Join-Path $BuildRoot 'main'
$S7BuildDir = Join-Path $BuildRoot 's7'

foreach ($directory in @($MainBuildDir, $S7BuildDir)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

Push-Location $ManuscriptDir
try {
    $mainOut = $MainBuildDir.Replace('\', '/')
    & latexmk -pdf -g -interaction=nonstopmode -halt-on-error "-outdir=$mainOut" main.tex
    if ($LASTEXITCODE -ne 0) { throw "Main manuscript build failed with exit code $LASTEXITCODE" }

    $s7Out = $S7BuildDir.Replace('\', '/')
    & latexmk -pdf -g -interaction=nonstopmode -halt-on-error "-outdir=$s7Out" Supplementary-File-S7.tex
    if ($LASTEXITCODE -ne 0) { throw "Supplementary File S7 build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Copy-Item -LiteralPath (Join-Path $MainBuildDir 'main.pdf') -Destination (Join-Path $ManuscriptDir 'main.pdf') -Force
Copy-Item -LiteralPath (Join-Path $S7BuildDir 'Supplementary-File-S7.pdf') -Destination (Join-Path $SupplementaryDir 'Supplementary-File-S7.pdf') -Force
Write-Output 'Built main.pdf and Supplementary-File-S7.pdf. Run tools/update-manifest.py, then tools/verify-manifest.py.'
