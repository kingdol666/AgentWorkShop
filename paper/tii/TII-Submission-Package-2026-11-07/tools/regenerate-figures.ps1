$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
$FigureRoot = Join-Path $PackageRoot 'figure-sources'
$scripts = @(
    (Join-Path $FigureRoot 'fig1/generate_fig1_gptimage26.py'),
    (Join-Path $FigureRoot 'fig4/generate.py'),
    (Join-Path $FigureRoot 'fig5/render_figure5.py'),
    (Join-Path $FigureRoot 'fig5/make_editable_drawio.py')
)

foreach ($script in $scripts) {
    & python $script
    if ($LASTEXITCODE -ne 0) { throw "Figure generation failed: $script" }
}

Write-Output 'Regenerated the composite Figure 1 and vector Figures 4 and 5. Figures 2 and 3 remain supplied-image enhancements.'
