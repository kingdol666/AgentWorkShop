# 全功能 E2E 矩阵运行器(按 wave 调用;逐脚本记账,输出 JSON + 可读日志)
# 用法: pwsh -File scripts/_run-matrix.ps1 -Wave wave1 -Scripts a.ts,b.ts [-Tsx]
param(
  [Parameter(Mandatory = $true)][string]$Wave,
  [Parameter(Mandatory = $true)][string[]]$Scripts,
  [switch]$Tsx,
  [int]$TimeoutSec = 900,
  [string]$BaseUrl = '',
  [string[]]$ExtraArgs = @()
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:NO_PROXY = '127.0.0.1,localhost'
$env:no_proxy = '127.0.0.1,localhost'
if ($BaseUrl -ne '') {
  # 各脚本历史上各自读不同的 base 变量名,统一注入同一目标实例
  $env:AW_BASE = $BaseUrl
  $env:AW_E2E_BASE = $BaseUrl
  $env:BASE_URL = $BaseUrl
}

$results = @()
$logDir = ".e2e-matrix"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

foreach ($s in $Scripts) {
  $path = "scripts/$s"
  if (-not (Test-Path $path)) {
    $results += [pscustomobject]@{ script = $s; exit = -99; note = 'MISSING' }
    Write-Output "MISSING  $s"
    continue
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $log = Join-Path $logDir "$Wave-$($s -replace '[\\/:]', '_').log"
  if ($Tsx) {
    $out = & npx tsx --tsconfig .nuxt/tsconfig.server.json $path @ExtraArgs 2>&1
  }
  else {
    $out = & node $path @ExtraArgs 2>&1
  }
  $code = $LASTEXITCODE
  $sw.Stop()
  $out | Set-Content -Path $log -Encoding utf8
  $tail = ($out | Select-Object -Last 6) -join ' ¦ '
  $results += [pscustomobject]@{ script = $s; exit = $code; sec = [int]$sw.Elapsed.TotalSeconds; note = $tail.Substring(0, [Math]::Min(300, $tail.Length)) }
  Write-Output ("{0,-6} {1,-46} {2,5}s  {3}" -f $(if ($code -eq 0) { 'PASS' } else { "EXIT$code" }), $s, [int]$sw.Elapsed.TotalSeconds, $(if ($code -eq 0) { '' } else { "log=$log" }))
}

$results | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $logDir "$Wave.json") -Encoding utf8
$failed = ($results | Where-Object { $_.exit -ne 0 }).Count
Write-Output ""
Write-Output "==== $Wave 完成:通过 $(($results | Where-Object { $_.exit -eq 0 }).Count) / 失败 $failed / 共 $($results.Count) ===="
foreach ($r in $results | Where-Object { $_.exit -ne 0 }) { Write-Output ("  FAIL {0} exit={1} :: {2}" -f $r.script, $r.exit, $r.note) }
