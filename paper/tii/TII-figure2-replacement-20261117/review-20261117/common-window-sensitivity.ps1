param(
 [string]$EvidenceZip = 'D:\codes\ABO\AgentWorkShop\paper\tii\TII-SUBMISSION-PACKAGE-20261112\supplementary\Supporting-Evidence-S7-20261112.zip',
 [string]$OutputCsv = (Join-Path $PSScriptRoot 'common-window-results.csv')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[System.IO.Compression.ZipFile]::OpenRead($EvidenceZip)
function Read-ZipText($name) {
 $e=$archive.GetEntry($name); if (-not $e) { throw "Missing entry: $name" }
 $r=[System.IO.StreamReader]::new($e.Open()); try { return $r.ReadToEnd() } finally { $r.Dispose() }
}
function Get-Grid($name, $h) {
 $data=Read-ZipText $name | ConvertFrom-Csv
 $pts=@($data | Where-Object {([double]$_.offset_s -ge -2) -and ([double]$_.offset_s -le ($h+2))} | Sort-Object {[double]$_.offset_s})
 if ($pts.Count -lt 10) { throw "Too few points: $name" }
 $grid=[System.Collections.Generic.List[object]]::new()
 for($i=0;$i -lt $pts.Count-1;$i++) {
  $a=[double]$pts[$i].offset_s; $b=[double]$pts[$i+1].offset_s
  $av=[double]$pts[$i].value; $bv=[double]$pts[$i+1].value
  if($b -le $a -or ($b-$a) -gt 5) { throw "Invalid interval: $name at $a" }
  $grid.Add(@{t=$a;v=$av})
  for($t=[Math]::Ceiling($a)+1;$t -lt $b;$t++) {$grid.Add(@{t=$t;v=($av+($bv-$av)*(($t-$a)/($b-$a)))})}
 }
 $grid.Add(@{t=[double]$pts[-1].offset_s;v=[double]$pts[-1].value})
 return ,@($grid|Where-Object {$_.t -ge 0 -and $_.t -le $h})
}
function Get-Iae($grid,$lo,$hi,$target){
 $acc=0.0
 for($i=1;$i -lt $grid.Count;$i++) {
  $p=$grid[$i-1];$q=$grid[$i];$left=[Math]::Max($lo,$p.t);$right=[Math]::Min($hi,$q.t)
  if($right -gt $left) {
   $lv=$p.v+($q.v-$p.v)*(($left-$p.t)/($q.t-$p.t));$rv=$p.v+($q.v-$p.v)*(($right-$p.t)/($q.t-$p.t))
   $acc+=([Math]::Abs($lv-$target)+[Math]::Abs($rv-$target))/2*($right-$left)
  }
 }
 return $acc
}
try {
 $rows=foreach($block in '02-wwtp-seed43','03-anneal-seed43','04-injection-seed44','05-wwtp-seed44','06-anneal-seed44','07-injection-seed45','09-anneal-seed45','10-injection-seed46','11-wwtp-seed46') {
  $h=if($block -match 'injection'){180}else{240};$target=if($block -match 'injection'){32.5}elseif($block -match 'wwtp'){3.4}else{95}
  $prefix="01-quantitative/e6/selected-post-pilot-batch/block-$block"
  $meta=Read-ZipText "$prefix/block.json" | ConvertFrom-Json
  if (-not $meta.arms.C0.valid -or -not $meta.arms.C1.valid) {throw "Not a valid pair: $block"}
  $g0=Get-Grid "$prefix/C0/samples.csv" $h; $g1=Get-Grid "$prefix/C1/samples.csv" $h
  $orig0=Get-Iae $g0 $g0[0].t $g0[-1].t $target; $orig1=Get-Iae $g1 $g1[0].t $g1[-1].t $target
  if([Math]::Abs($orig0-$meta.arms.C0.iae) -gt 0.001 -or [Math]::Abs($orig1-$meta.arms.C1.iae) -gt 0.001) {throw "Stored IAE mismatch: $block"}
  $lo=[Math]::Max($g0[0].t,$g1[0].t);$hi=[Math]::Min($g0[-1].t,$g1[-1].t)
  if($hi -le $lo){throw "Empty common interval: $block"}
  $v0=Get-Iae $g0 $lo $hi $target;$v1=Get-Iae $g1 $lo $hi $target
  [PSCustomObject]@{block=$block;horizon_s=$h;target=$target;c0_start_s=$g0[0].t;c0_end_s=$g0[-1].t;c1_start_s=$g1[0].t;c1_end_s=$g1[-1].t;common_start_s=$lo;common_end_s=$hi;original_c0_iae=[Math]::Round($orig0,3);original_c1_iae=[Math]::Round($orig1,3);common_c0_iae=[Math]::Round($v0,3);common_c1_iae=[Math]::Round($v1,3);common_delta_iae=[Math]::Round(($v0-$v1),3)}
 }
 $rows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $OutputCsv
 Write-Output "Source SHA-256: $((Get-FileHash -LiteralPath $EvidenceZip -Algorithm SHA256).Hash)"
 Write-Output "Pairs: $($rows.Count); positive common deltas: $( @($rows | Where-Object { $_.common_delta_iae -gt 0 }).Count )"
 Write-Output "Results: $OutputCsv"
} finally { $archive.Dispose() }