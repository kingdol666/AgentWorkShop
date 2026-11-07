$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $PSScriptRoot
$ToolsRoot = Join-Path $PackageRoot 'reproducibility-tools'

Push-Location $ToolsRoot
try {
    & node --test `
        bench/tools/collect-paper-evidence.test.mjs `
        bench/paper-study/study.test.mjs `
        bench/paper-runner/paired.test.mjs `
        bench/experiment/paper-agent-comparison.test.mjs
    if ($LASTEXITCODE -ne 0) { throw "Offline evidence-tool tests failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
