/**
 * 演示报告数字同步器:从最终 demo-evidence.json 回写报告的易变数字
 * (脚本每次重跑数字都会变;手抄必然漂移 —— 审查员第三轮意见)。
 * 运行:node scripts/eda-demo-report-patch.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-eda-demo', 'demo-evidence.json')
const REPORT = join(REPO, 'docs', 'audit', '2026-10-21-eda-demo-report.md')

const ev = JSON.parse(readFileSync(EVID, 'utf8'))
const g = id => ev.results.find(r => r.id === id) ?? {}
const num = (id, re, fallback = '-') => String(g(id).detail?.match(re)?.[1] ?? fallback)

const pts21 = num('D2.1', /pts=([\d,]+)/)
const pts23 = num('D2.3', /pts=(\d+)/)
const band24 = num('D2.4', /band=(\d+)/)
const rows31 = num('D3.1', /rows=(\d+)/)
const spcN = num('D4.4', /n=(\d+)/)
const goldenBins = num('D4.5', /bins=(\d+)/)
const d11 = num('D1.1', /points=(\d+)/)
const samples41 = num('D4.1', /samples=(\d+)/)

let md = readFileSync(REPORT, 'utf8')
// §3 复合查询表:①两序列点数 ③配方过滤点数 ④包络桶数(容许多次替换遗留的双空格/反引号差异)
md = md.replace(/(\| ① [^|]+\|\s*`[^`]+`\s*\| )\s*2 序列 [\d,/]+ 点 ✓ \|/, `$1 2 序列 ${pts21.split(',').join('/')} 点 ✓ |`)
md = md.replace(/(\| ③ \+配方打标\s*\| `\+ recipe_id`\s*\| )\s*\d+ 点 ✓ \|/, `$1 ${pts23} 点 ✓ |`)
md = md.replace(/(\| ④ \+min\/max 包络\s*\| `\+ include_band=1`\s*\| )\s*band \d+ ✓ \|/, `$1 band ${band24} ✓ |`)
// §1 采集活性
md = md.replace(/停\/开线后标量镜像采样活性探针 \d+ 点/, `停/开线后标量镜像采样活性探针 ${d11} 点`)
// §4 导出行数(不含表头);反引号在早前替换中可能已丢失,两种形态都匹配
md = md.replace(/`?ready`?，\d+ 行（不含表头）/, `ready，${rows31} 行（不含表头）`)
// §5 SPC n + 关账批样本数
md = md.replace(/SPC 控制图注册 \+ 重算（n=\d+，/, `SPC 控制图注册 + 重算（n=${spcN}，`)
md = md.replace(/关账批（\d+ 样本）/, `关账批（${samples41} 样本）`)
// §7 断言明细
md = md.replace(/D4\.1 台账回填\(\d+\)/, `D4.1 台账回填(${samples41})`)
md = md.replace(/D4\.4 SPC 重算\(n=\d+\)/, `D4.4 SPC 重算(n=${spcN})`)
md = md.replace(/D4\.5 golden \d+ 桶/, `D4.5 golden ${goldenBins} 桶`)
// §8 边界:SPC 冷启动数字从 spcN 注入(消除手抄遗留)
md = md.replace(/SPC 处于冷启动（n=\d+ < 25，/, `SPC 处于冷启动（n=${spcN} < 25，`)

writeFileSync(REPORT, md)
console.log(`报告已同步最终证据数字: pts=${pts21} recipe=${pts23} band=${band24} rows=${rows31} spcN=${spcN} golden=${goldenBins}`)
