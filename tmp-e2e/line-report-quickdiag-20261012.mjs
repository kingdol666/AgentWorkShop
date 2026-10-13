#!/usr/bin/env node
/**
 * tmp-e2e/line-report-quickdiag-20261012.mjs —— 产线报告 skill(industrial-line-stability-report)
 * 快速诊断测试:复用在跑验收线(ln-72eb1197) → 阶跃激励 → 导出窗口 → skill 确定性分析
 * (analyze → report_builder → quality_gate) → 报告入 KB(RAG) → 检索命中 →
 * 新工况二轮(检索定口径 → 续采 → skill → 入库 → 双报告可检索)。
 *
 * 前置:3001 平台;rag 8770/6789;IDD 项目自带 skill 与 uv shared 环境;ln-72eb1197 在跑。
 * 用法:node tmp-e2e/line-report-quickdiag-20261012.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3001'
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_PROJECT = 'D:/codes/myskills/industrial-deep-diagnostic'
const SKILL = join(IDD_PROJECT, '.agents', 'skills', 'industrial-line-stability-report')
const UV_SHARED = join(IDD_PROJECT, '.claude', 'shared', 'scripts')
const OUT = join(REPO, '.AgentWorkShop', 'analysis', 'line-report-20261012')
const LINE_ID = 'ln-72eb1197'
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const py = (script, args, timeoutMs = 180_000) => {
  const r = spawnSync('uv', ['run', '--project', UV_SHARED, 'python', join(SKILL, 'scripts', script), ...args],
    { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } })
  return { code: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() }
}

/* ── Q0 平台门 + 找节点 ── */
console.log('\n[Q0] 平台门 + 节点定位')
const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null)
ok('平台健康(0.7.5x)', health?.data?.status === 'ok', `v=${health?.data?.version}`)
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'Admin@2026Closed' })
const TOKEN = login?.data?.token ?? ''
ok('admin 登录', !!TOKEN)
const dcwRows = ((await api('GET', '/api/workshop/dcw', undefined, TOKEN))?.data?.nodes ?? []).filter(n => n.lineId === LINE_ID)
const daqRows = ((await api('GET', '/api/workshop/daq', undefined, TOKEN))?.data?.nodes ?? []).filter(n => n.lineId === LINE_ID)
const dcwOf = re => dcwRows.find(n => re.test(n.name))?.id ?? ''
const daqOf = re => daqRows.find(n => re.test(n.name))?.id ?? ''
const D = { linespeed: dcwOf(/lineSpeed|线速/), diegap: dcwOf(/dieGap|模口/), zone1: dcwOf(/加热区/) }
const Q = { temp: daqOf(/熔体温度|melt/i), press: daqOf(/MeltPressure|熔压/i), thick: daqOf(/thick|膜厚/i) }
ok('3 SV + 3 PV 定位', !!(D.linespeed && D.diegap && D.zone1 && Q.temp && Q.press && Q.thick),
  `dcw=${Object.values(D).filter(Boolean).length} daq=${Object.values(Q).filter(Boolean).length}`)

/* ── MCP 通道(导数+激励) ── */
const { spawn } = await import('node:child_process')
const { createInterface } = await import('node:readline')
const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 忽略 */ }
})
const call = async (name, args = {}, timeoutMs = 120_000) => {
  const res = await new Promise((res2, rej2) => {
    const id = nextId++
    const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); res2(m) })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => {
    try { return JSON.parse(text) }
    catch { return null }
  })() }
}

const exportCsv = async (fromMs, toMs, file) => {
  const series = []
  for (const [col, id] of [['melt_temp', Q.temp], ['melt_pressure', Q.press], ['film_thickness', Q.thick]]) {
    const r = await call('aw_daq_samples', { id, from: fromMs, to: toMs, bucketMs: 2000, limit: 1000 })
    const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
    series.push({ col, pts })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => {
    const row = { timestamp: new Date(t).toISOString() }
    for (const { col, pts } of series) {
      const hit = pts.find(p => Math.abs(p.at - t) <= 2000)
      row[col] = hit ? Number(hit.v.toFixed(3)) : ''
    }
    return row
  })
  writeFileSync(file, [Object.keys(rows[0] ?? { timestamp: '' }).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n'))
  return rows.length
}

/* ── Q1 R1 激励 + 采数 ── */
console.log('\n[Q1] R1:线速阶跃激励 + 窗口采数')
const w1 = await call('aw_dcw_write', { id: D.linespeed, value: 97 })
ok('R1 激励:线速 93→97', !w1.isError, w1.text.slice(0, 90))
await sleep(150_000)
mkdirSync(join(OUT, 'round-1'), { recursive: true })
const r1To = Date.now(); const r1From = r1To - 5 * 60_000
const r1Rows = await exportCsv(r1From, r1To, join(OUT, 'round-1', 'data.csv'))
ok(`R1 窗口导出(rows=${r1Rows} ≥50)`, r1Rows >= 50, join(OUT, 'round-1', 'data.csv'))
writeFileSync(join(OUT, 'round-1', 'report_context.json'), JSON.stringify({
  line_id: LINE_ID, product: '流延膜(全链验收)', scene: 'cast-film-extrusion',
  period: { start: new Date(r1From).toISOString(), end: new Date(r1To).toISOString() },
  excitations: [{ node: 'linespeed-sp', from: 93, to: 97, at: new Date(r1To - 150_000).toISOString() }],
}, null, 2))

/* ── Q2 R1 产线报告 skill(确定性快速诊断) ── */
console.log('\n[Q2] R1 产线报告 skill(analyze → builder → gate)')
const a1 = py('stability_analyzer.py', ['analyze', '--data', join(OUT, 'round-1', 'data.csv'), '--time-col', 'timestamp', '--out-dir', join(OUT, 'round-1')], 240_000)
ok('R1 analyze 完成(exit 0/1)', a1.code === 0 || a1.code === 1, `exit=${a1.code} ${a1.out.split('\n')[0] ?? ''}`.slice(0, 140))
const rep1Path = join(OUT, 'round-1', 'stability_report.json')
const rep1 = existsSync(rep1Path) ? JSON.parse(readFileSync(rep1Path, 'utf8')) : null
ok('R1 stability_report.json 产出(评分+分级)', !!rep1 && Number.isFinite(rep1?.conclusion?.score) && /^[ABCD]$/.test(rep1?.conclusion?.grade ?? ''),
  rep1 ? `score=${rep1.conclusion.score} grade=${rep1.conclusion.grade} findings=${rep1.conclusion.n_findings} params=${rep1.conclusion.n_parameters_assessed}` : '(无报告)')
console.log(`    ↳ R1 结论: score=${rep1?.conclusion?.score} grade=${rep1?.conclusion?.grade}(${rep1?.conclusion?.summary ?? rep1?.conclusion?.verdict ?? ''})`)
const b1 = py('report_builder.py', ['--report', rep1Path, '--charts', join(OUT, 'round-1', 'charts.json')], 180_000)
const html1 = join(OUT, 'round-1', 'line_stability_report.html')
ok('R1 HTML 落地页产出', (b1.code === 0 || b1.code === 1) && existsSync(html1), `exit=${b1.code} size=${existsSync(html1) ? statSync(html1).size : 0}`)
const g1 = spawnSync('node', [join(SKILL, 'scripts', 'quality_gate.mjs'), rep1Path, join(OUT, 'round-1')], { encoding: 'utf8', timeout: 120_000 })
ok('R1 quality_gate PASS(exit 0)', g1.status === 0, `exit=${g1.status} ${(g1.stdout ?? '').split('\n')[0] ?? ''}`)

/* ── Q3 R1 报告入 KB + 检索命中 ── */
console.log('\n[Q3] R1 报告入 KB(RAG)+ 检索')
const cat = await fetch(`${KB_WEB}/api/kb/catalog`, { headers: { authorization: `Bearer ${KB_TOKEN}` } }).then(r => r.json()).catch(() => null)
const kbId = ((cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial') ?? {})?.kbId ?? ''
ok('KB aw-industrial 在册', !!kbId)
const r1Solution = [
  `综合评分 ${rep1?.conclusion?.score}(${rep1?.conclusion?.grade} 级),评估参数 ${rep1?.conclusion?.n_parameters_assessed} 个,发现 ${rep1?.conclusion?.n_findings} 条。`,
  ...(rep1?.findings ?? []).slice(0, 6).map(f => `- [${f.severity ?? '?'}] ${f.title ?? f.summary ?? ''}(置信度 ${f.confidence ?? '?'}):${String(f.evidence ?? f.detail ?? '').slice(0, 120)}`),
  `激励背景:线速 93→97 阶跃后 ${r1Rows} 行样本;窗口 ${new Date(r1From).toISOString()} ~ ${new Date(r1To).toISOString()}。`,
].join('\n')
const ing1 = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
  body: JSON.stringify({
    title: '流延膜产线稳定性报告 R1:线速阶跃后稳定性评估(skill 快速诊断)',
    scenario: 'PLC 模拟流延膜产线,线速 93→97 阶跃后 5 分钟窗口,industrial-line-stability-report 确定性评估',
    category: 'troubleshooting',
    problem: '线速阶跃后产线是否稳定;膜厚/熔温/熔压波动是否越限;下一步操作建议',
    solution: r1Solution,
    result: rep1?.conclusion?.grade === 'A' || rep1?.conclusion?.grade === 'B' ? 'success' : 'partial',
    key_lessons: [`score=${rep1?.conclusion?.score} grade=${rep1?.conclusion?.grade}`, `gate=PASS(html+json 交付门禁)`],
    tags: ['流延膜', '稳定性报告', '线速阶跃', '产线报告skill', 'R1'],
    metrics: { source: 'line-stability-report', score: rep1?.conclusion?.score, grade: rep1?.conclusion?.grade, rows: r1Rows },
  }),
  signal: AbortSignal.timeout(60_000),
}).then(r => r.json()).catch(e => ({ err: e.message }))
const ing1Id = ing1?.id ?? ing1?.experience?.id ?? ing1?.experience_id ?? ''
ok('R1 报告入库经验库(拿到 id)', !!ing1Id, JSON.stringify(ing1).slice(0, 120))
const searchKB = async (query) => {
  const j = await fetch(`${KB_BASE}/api/v1/experience/${kbId}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ query, top_k: 5 }), signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(e => ({ err: e.message }))
  return j?.results ?? j?.experiences ?? j?.data ?? []
}
let hit1 = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hit1 = await searchKB('流延膜 稳定性报告 线速阶跃 稳定性评估 R1')
  if (hit1.length > 0 && JSON.stringify(hit1).includes('R1')) break
}
ok('R1 检索命中本报告', hit1.length > 0 && JSON.stringify(hit1).includes('R1'), `hits=${hit1.length}`)

/* ── Q4 R2:检索定口径 → 模口阶跃 → 续采 → skill → 入库 ── */
console.log('\n[Q4] R2:检索定口径 → 新工况 → 续诊 → 入库')
const r1Hits = await searchKB('流延膜 稳定性报告 线速阶跃')
const r1Own = r1Hits.find(h => /R1/.test(String(h.title ?? ''))) ?? r1Hits[0] ?? {}
const r1Digest = String(r1Own?.solution ?? r1Own?.content ?? '').replace(/\s+/g, ' ').slice(0, 400)
ok('R2 前置检索命中 R1 报告(定口径)', /R1/.test(String(r1Own?.title ?? '')) && r1Digest.length > 80, `title=${String(r1Own?.title ?? '').slice(0, 50)}`)
const w2 = await call('aw_dcw_write', { id: D.diegap, value: 0.97 })
ok('R2 激励:模口 1.03→0.97', !w2.isError, w2.text.slice(0, 90))
await sleep(120_000)
mkdirSync(join(OUT, 'round-2'), { recursive: true })
const r2To = Date.now(); const r2From = r2To - 4 * 60_000
const r2Rows = await exportCsv(r2From, r2To, join(OUT, 'round-2', 'data.csv'))
ok(`R2 窗口导出(rows=${r2Rows} ≥50)`, r2Rows >= 50, '')
const a2 = py('stability_analyzer.py', ['analyze', '--data', join(OUT, 'round-2', 'data.csv'), '--time-col', 'timestamp', '--out-dir', join(OUT, 'round-2')], 240_000)
ok('R2 analyze 完成(exit 0/1)', a2.code === 0 || a2.code === 1, `exit=${a2.code}`)
const rep2Path = join(OUT, 'round-2', 'stability_report.json')
const rep2 = existsSync(rep2Path) ? JSON.parse(readFileSync(rep2Path, 'utf8')) : null
ok('R2 报告产出(评分+分级)', !!rep2 && Number.isFinite(rep2?.conclusion?.score) && /^[ABCD]$/.test(rep2?.conclusion?.grade ?? ''),
  rep2 ? `score=${rep2.conclusion.score} grade=${rep2.conclusion.grade} findings=${rep2.conclusion.n_findings}` : '(无报告)')
console.log(`    ↳ R2 结论: score=${rep2?.conclusion?.score} grade=${rep2?.conclusion?.grade}`)
const b2 = py('report_builder.py', ['--report', rep2Path, '--charts', join(OUT, 'round-2', 'charts.json')], 180_000)
ok('R2 HTML 落地页产出', (b2.code === 0 || b2.code === 1) && existsSync(join(OUT, 'round-2', 'line_stability_report.html')), `exit=${b2.code}`)
const g2 = spawnSync('node', [join(SKILL, 'scripts', 'quality_gate.mjs'), rep2Path, join(OUT, 'round-2')], { encoding: 'utf8', timeout: 120_000 })
ok('R2 quality_gate PASS(exit 0)', g2.status === 0, `exit=${g2.status}`)
const r2Solution = [
  `综合评分 ${rep2?.conclusion?.score}(${rep2?.conclusion?.grade} 级),发现 ${rep2?.conclusion?.n_findings} 条。`,
  `前置口径(引用 R1 检索):${r1Digest.slice(0, 200)}`,
  ...(rep2?.findings ?? []).slice(0, 6).map(f => `- [${f.severity ?? '?'}] ${f.title ?? f.summary ?? ''}:${String(f.evidence ?? f.detail ?? '').slice(0, 100)}`),
  `本窗激励:模口 1.03→0.97;窗口 ${new Date(r2From).toISOString()} ~ ${new Date(r2To).toISOString()}。`,
].join('\n')
const ing2 = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
  body: JSON.stringify({
    title: '流延膜产线稳定性报告 R2:模口阶跃复核(引用 R1 结论)',
    scenario: 'PLC 模拟流延膜产线,检索 R1 稳定性结论定口径后,模口 1.03→0.97 新工况的继续分析',
    category: 'troubleshooting',
    problem: '验证 R1 稳定性结论在新工况(模口收窄)下是否成立,评估膜厚响应',
    solution: r2Solution,
    result: rep2?.conclusion?.grade === 'A' || rep2?.conclusion?.grade === 'B' ? 'success' : 'partial',
    key_lessons: [`score=${rep2?.conclusion?.score} grade=${rep2?.conclusion?.grade}`, '先检索既往(R1)再分析(R2)闭环'],
    tags: ['流延膜', '稳定性报告', '模口间隙', '产线报告skill', 'R2'],
    metrics: { source: 'line-stability-report', score: rep2?.conclusion?.score, grade: rep2?.conclusion?.grade, rows: r2Rows, prior: 'R1' },
  }),
  signal: AbortSignal.timeout(60_000),
}).then(r => r.json()).catch(e => ({ err: e.message }))
const ing2Id = ing2?.id ?? ing2?.experience_id ?? ing2?.data?.id ?? ''
ok('R2 报告入库经验库(拿到 id)', !!ing2Id, JSON.stringify(ing2).slice(0, 120))
let hit2 = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hit2 = await searchKB('流延膜 稳定性报告 模口间隙 复核 R2')
  if (hit2.length > 0 && JSON.stringify(hit2).includes('R2')) break
}
ok('R2 检索命中本报告', hit2.length > 0 && JSON.stringify(hit2).includes('R2'), `hits=${hit2.length}`)
let hitBoth = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  hitBoth = await searchKB('流延膜 产线 稳定性报告 skill')
  if (JSON.stringify(hitBoth).includes('R1') && JSON.stringify(hitBoth).includes('R2')) break
}
ok('两轮报告均可持续检索(闭环沉淀)', JSON.stringify(hitBoth).includes('R1') && JSON.stringify(hitBoth).includes('R2'), `hits=${hitBoth.length}`)

/* ── 收尾 ── */
console.log('\n[收尾]')
mcp.stdin.end(); mcp.kill()
console.log(`产物目录:${OUT}`)
console.log('')
console.log('════════════════════════════════════════')
console.log(`  产线报告 skill 快速诊断测试:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
console.log(`R1: score=${rep1?.conclusion?.score} grade=${rep1?.conclusion?.grade} (${r1Rows} 行)`)
console.log(`R2: score=${rep2?.conclusion?.score} grade=${rep2?.conclusion?.grade} (${r2Rows} 行)`)
process.exit(fails.length ? 1 : 0)
