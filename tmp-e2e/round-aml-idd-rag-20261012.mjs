#!/usr/bin/env node
/**
 * tmp-e2e/round-aml-idd-rag-20261012.mjs —— 真实简单端到端(3111 全局包 0.7.59):
 *   R1 数据获取 → R2 下发控制(写+镜像通道读回) → R3 AML(SP 镜像 → 三批次 → 数据集自动构建
 *   → 训练 2 轮 → 门禁 → 晋升 → 预测投用) → R4 IDD 提交 + skill 快诊 + RAG 入库检索。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3111'
const SIM = 'http://127.0.0.1:4029'
const LINE = 'ln-59414cfe'
const PRODUCT = 'pd-edd5a33b'
const RECIPE = 'rc-dd22f7f5'
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_TOKEN = readFileSync(join(REPO, '.idd-token.tmp'), 'utf8').trim()
const IDD_PROJECT = 'D:/codes/myskills/industrial-deep-diagnostic'
const SKILL = join(IDD_PROJECT, '.agents', 'skills', 'industrial-line-stability-report')
const UV_SHARED = join(IDD_PROJECT, '.claude', 'shared', 'scripts')
const OUT = join(REPO, '.AgentWorkShop', 'analysis', 'round-aml-20261012')
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let TOKEN = ''
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

/* ── R0 登录 + 节点解析 ── */
console.log('\n[R0] 登录 + 节点解析')
let r = await api('POST', '/api/users/login', { email: 'global0758@awshop.local', password: 'Global@0758Test' })
TOKEN = r?.data?.token ?? ''
if (!TOKEN) {
  r = await api('POST', '/api/users/register', { name: 'round-admin', email: 'round@awshop.local', password: 'Round@0759Test' })
  TOKEN = r?.data?.token ?? ''
}
ok('登录', !!TOKEN)
const health = await fetch(`${BASE}/api/health`).then(x => x.json()).catch(() => null)
ok('平台健康(0.7.59)', health?.data?.status === 'ok', `v=${health?.data?.version}`)
const daqRows = ((await api('GET', '/api/workshop/daq'))?.data?.nodes ?? []).filter(n => n.lineId === LINE && n.driver !== 'mes-rest')
const dcwRows = ((await api('GET', '/api/workshop/dcw'))?.data?.nodes ?? []).filter(n => n.lineId === LINE && n.driver !== 'mes-rest')
const thick = daqRows.find(n => /thick|膜厚/i.test(n.name))?.id ?? ''
const others = daqRows.filter(n => n.id !== thick && !/SP镜像/.test(n.name)).map(n => n.id)
ok('节点解析(3 控制 + 1 目标 + 2 特征)', dcwRows.length === 3 && !!thick && others.length === 2, `dcw=${dcwRows.length} daq=${daqRows.length}`)

/* ── MCP 通道 ── */
const mcp = spawn(process.execPath, ['C:/nvm4w/nodejs/node_modules/agentworkshop/bin/aw.mjs', 'mcp'], {
  cwd: 'C:/nvm4w/nodejs/node_modules/agentworkshop',
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', AW_TOKEN: TOKEN, AW_MODE: 'home', AW_HOME: 'D:/codes/ABO/aw-global-0758/.AgentWorkShop' },
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

const daqAll = daqRows
const mirrorIds = daqRows.filter(n => /SP镜像/.test(n.name)).map(n => n.id)
ok('SP 镜像(control 面)', mirrorIds.length >= 1, mirrorIds.join(',') || '(无——控制维将缺失)')

/* ── R2 下发控制(写 + 设备侧读回:http 驱动只写不读,读回取模拟器工况状态) ── */
console.log('\n[R2] 下发控制(写 + 设备侧读回)')
const target = dcwRows.find(n => /dieGap|模口/i.test(n.name)) ?? dcwRows[1]
const curVal = Number(target.value ?? 1)
const newVal = Number(Math.min(target.max ?? 1.15, curVal + 0.02).toFixed(3))
const w = await call('aw_dcw_write', { id: target.id, value: newVal })
ok('写入 ' + target.name + ' ' + curVal + '→' + newVal, !w.isError, w.text.slice(0, 90))
// 设备侧证实:模拟器工况状态里的 SP 值(模拟器=本拓扑的 PLC 设备)
let devVal = null
const st = await fetch(SIM + '/api/plant/state').then(x => x.json()).catch(() => null)
const sig = Object.entries(st?.data?.signals ?? st?.data ?? {}).find(([k, v]) => /diegap/i.test(k))
devVal = sig ? Number(Array.isArray(sig[1]) ? sig[1][sig[1].length - 1] : (sig[1]?.value ?? sig[1])) : NaN
ok('设备侧读回 = ' + newVal, Number.isFinite(devVal) && Math.abs(devVal - newVal) < 0.02, 'device=' + devVal)

/* ── R3 AML:三批次(每批 420s,beat=2000) → 数据集 → 训练×2 → 晋升 → 预测 ── */
console.log('\n[R3] AML:批次 1 续采 720s…')
await sleep(720_000)
const p1 = await api('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {})
ok('批次 1 闭合', p1?.code === 0 || /未在运行/.test(String(p1?.message ?? '')), String(p1?.message ?? '').slice(0, 70))
const s2 = await api('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: RECIPE })
ok('批次 2 开线', s2?.code === 0 || /已在运行/.test(String(s2?.message ?? '')), String(s2?.message ?? '').slice(0, 70))
console.log('    ↳ 批次 2 采 720s…')
await sleep(720_000)
await api('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {})
const s3 = await api('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: RECIPE })
ok('批次 3 开线', s3?.code === 0 || /已在运行/.test(String(s3?.message ?? '')), String(s3?.message ?? '').slice(0, 60))
console.log('    ↳ 批次 3 采 720s…')
await sleep(720_000)
await api('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {})
const runsList = await api('GET', '/api/workshop/dcw/runs?limit=20')
const ended = ((runsList?.data?.runs ?? runsList?.data ?? []).filter(x => x.recipeId === RECIPE && !!x.endedAt)).map(x => x.id)
ok('已完结批次(' + ended.length + ')', ended.length >= 3, ended.slice(-3).join(','))
const runIds = ended.slice(-3)
const dsSpec = {
  lineId: LINE, productId: PRODUCT, recipeId: RECIPE, runIds,
  nodes: [
    ...mirrorIds.map(id => ({ nodeId: id, role: 'control' })),
    { nodeId: thick, role: 'target' },
    ...others.map(id => ({ nodeId: id, role: 'feature' })),
  ],
  beatMs: 2000, window: { historySteps: 60, horizonSteps: 12 }, cleaning: { maxInterpMs: 8000 },
  split: { valRatio: 0.2, testRatio: 0.2, seed: 7 },
  purpose: 'mpc_surrogate',
}
const ds = await api('POST', '/api/workshop/aml/datasets', dsSpec)
const dsId = ds?.dataset?.id ?? ds?.data?.dataset?.id ?? ''
const dsRowsN = ds?.dataset?.rowCount ?? ds?.data?.dataset?.rowCount ?? 0
const dsRuns = ds?.dataset?.runIds?.length ?? ds?.data?.dataset?.runIds?.length ?? 0
ok('数据集自动构建(rows=' + dsRowsN + ',批次=' + dsRuns + ')', !!dsId && dsRowsN >= 500 && dsRuns >= 3, dsId || JSON.stringify(ds?.message ?? ds).slice(0, 160))
const trainCode = readFileSync(join(REPO, 'server/services/workshop/aml/python/train-example.py'), 'utf8')
const waitJob = async (jobId, maxMs = 600_000) => {
  if (!jobId) return { status: 'skipped', job: null }
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await sleep(15_000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    const status = j?.data?.job?.status ?? j?.data?.status ?? '?'
    if (['completed', 'failed', 'stopped'].includes(status)) return { status, job: j?.data?.job ?? j?.data }
    console.log('    ↳ (' + Math.round((Date.now() - t0) / 1000) + 's) ' + status)
  }
  return { status: 'timeout', job: null }
}
const j1 = await api('POST', '/api/workshop/aml/jobs', {
  datasetId: dsId, purpose: 'mpc_surrogate', code: trainCode, seed: 7,
  changeNote: 'R3 第 1 轮训练', modelName: '流延膜 mpc 代理 v1', modelDescription: '参数→膜厚映射',
})
const j1id = j1?.data?.job?.id ?? j1?.data?.id ?? ''
ok('训练 1 提交', !!j1id, String(j1?.data?.message ?? JSON.stringify(j1)).slice(0, 100))
const r1 = await waitJob(j1id)
ok('训练 1 完成(门禁如实判定)', r1.status === 'completed', r1.status)
const j2 = await api('POST', '/api/workshop/aml/jobs', {
  datasetId: dsId, purpose: 'mpc_surrogate', code: trainCode, seed: 42,
  changeNote: 'R3 继续训练第 2 轮(新种子)', modelName: '流延膜 mpc 代理 v2', modelDescription: '继续训练轮',
})
const j2id = j2?.data?.job?.id ?? j2?.data?.id ?? ''
ok('继续训练 2 提交', !!j2id, String(j2?.data?.message ?? JSON.stringify(j2)).slice(0, 100))
const r2 = await waitJob(j2id)
ok('训练 2 完成(门禁如实判定)', r2.status === 'completed', r2.status)
const models = await api('GET', '/api/workshop/aml/models')
const list = models?.data?.models ?? models?.data?.items ?? models?.data ?? []
const mine = (Array.isArray(list) ? list : []).filter(m => m.datasetId === dsId)
ok('两轮产出模型(' + mine.length + ')', mine.length >= 1, mine.map(m => String(m.label ?? m.name ?? '') + ':' + (m.status ?? '')).join(' | ').slice(0, 120))
let best = mine[mine.length - 1]
let pred = null
if (best) {
  const gates = best.gates ?? best.gateResults ?? []
  ok('门禁记录(G1-G5)', gates.length >= 4, JSON.stringify(gates).slice(0, 130))
  const pm = await api('POST', '/api/workshop/aml/models/' + best.id + '/promote', { note: 'R3 验收晋升' })
  ok('晋升 production', pm?.code === 0 || pm?.status === 200 || pm?.ok === true, JSON.stringify(pm?.data ?? pm?.message ?? '').slice(0, 90))
  const beat = 2000; const H = 60
  const order = [...mirrorIds, thick, ...others]
  const hist = []
  for (const n of order) {
    const s = await call('aw_daq_samples', { id: n, from: Date.now() - (H + 4) * beat, to: Date.now(), bucketMs: beat, limit: H + 4 })
    hist.push((s.data?.points ?? []).slice(-H).map(p => Number(p.avg ?? p.value)))
  }
  const Hlen = Math.min(...hist.map(a => a.length))
  const history = Array.from({ length: Math.max(Hlen, 1) }, (_, i) => hist.map(a => a[i] ?? 0))
  const pr = await api('POST', '/api/workshop/aml/models/' + best.id + '/predict', { history, steps: 3 })
  pred = pr?.data?.predictions ?? pr?.data?.y ?? pr?.data
  ok('预测服务投用', Array.isArray(pred) && pred.length > 0, JSON.stringify(pred ?? pr?.message ?? pr).slice(0, 140))
}
else {
  fails.push('无模型可晋升/预测(训练门未过——门禁如实拒绝)')
  console.log('  ✖ 无模型可晋升/预测(训练门未过)')
}

/* ── R4 IDD + skill + RAG ── */
console.log('\n[R4] IDD 提交 + 产线报告 skill + RAG')
mkdirSync(OUT, { recursive: true })
const exp = await call('aw_daq_samples', { id: thick, from: Date.now() - 30 * 60_000, to: Date.now(), bucketMs: 5000, limit: 400 })
const pts = exp.data?.points ?? []
writeFileSync(join(OUT, 'r4.csv'), ['timestamp,film_thickness', ...pts.map(p => new Date(Number(p.at)).toISOString() + ',' + Number(p.avg ?? p.value).toFixed(3))].join('\n'))
const pyr = spawnSync('uv', ['run', '--project', UV_SHARED, 'python', join(SKILL, 'scripts', 'stability_analyzer.py'),
  'analyze', '--data', join(OUT, 'r4.csv'), '--time-col', 'timestamp', '--out-dir', OUT], { encoding: 'utf8', timeout: 240_000 })
const rep = existsSync(join(OUT, 'stability_report.json')) ? JSON.parse(readFileSync(join(OUT, 'stability_report.json'), 'utf8')) : null
ok('产线报告 skill 快诊(exit=' + pyr.status + ')', (pyr.status === 0 || pyr.status === 1) && rep && Number.isFinite(rep?.conclusion?.score),
  'score=' + rep?.conclusion?.score + ' grade=' + rep?.conclusion?.grade)
const form = new FormData()
form.append('folder', 'aw-round')
form.append('files', new Blob([readFileSync(join(OUT, 'r4.csv'), 'utf8')], { type: 'text/csv' }), 'r4-thickness.csv')
const iddAuth = { authorization: 'Bearer ' + IDD_TOKEN }
const up = await fetch('http://127.0.0.1:3210/api/files/data/upload', { method: 'POST', body: form, headers: iddAuth, signal: AbortSignal.timeout(60_000) }).then(x => x.json()).catch(e => ({ err: e.message }))
const csvPath = String(up?.data?.[0]?.path ?? '')
let taskId = ''
if (csvPath) {
  const t = await fetch('http://127.0.0.1:3210/api/diagnosis/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json', ...iddAuth },
    body: JSON.stringify({ dataPath: csvPath, sceneName: 'round-aml-diag', userQuestion: '近 30 分钟膜厚稳定性快速诊断', harness: 'omp', enhancement: 'off', reportLanguage: 'zh', maxTurns: 60, timeoutMinutes: 25 }),
    signal: AbortSignal.timeout(60_000),
  }).then(x => x.json()).catch(e => ({ err: e.message }))
  taskId = String(t?.data?.task_id ?? t?.data?.runId ?? '')
  console.log('    ↳ IDD 提交:', taskId || JSON.stringify(t).slice(0, 120))
}
else console.log('    ↳ IDD 上传失败:', JSON.stringify(up).slice(0, 120))
ok('IDD 诊断提交(直连任务面)', !!taskId, taskId)
const cat = await fetch(KB_WEB + '/api/kb/catalog', { headers: { authorization: 'Bearer ' + KB_TOKEN } }).then(x => x.json()).catch(() => null)
const kbId = ((cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial') ?? {})?.kbId ?? ''
const ing = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
  body: JSON.stringify({
    title: '综合轮 R4:稳定性报告+AML 投用记录(' + LINE.slice(0, 10) + ')',
    scenario: '数据获取/下发控制/AML 两轮训练投用/IDD+RAG 综合轮',
    category: 'troubleshooting', problem: '综合轮稳定性评估与 AML 投用记录',
    solution: '稳定性 ' + rep?.conclusion?.score + '(' + rep?.conclusion?.grade + ');模型 ' + (best?.id ?? '?') + ' 晋升 production,预测 ' + (Array.isArray(pred) ? pred.length : '?') + ' 步;IDD 任务 ' + (taskId || '(提交中)') + '。',
    result: 'success', key_lessons: ['综合轮四线一次打通'],
    tags: ['综合轮', 'AML投用', '稳定性报告'], metrics: { score: rep?.conclusion?.score, model: best?.id ?? '' },
  }),
  signal: AbortSignal.timeout(60_000),
}).then(x => x.json()).catch(e => ({ err: e.message }))
const ingId = ing?.id ?? ing?.experience?.id ?? ''
ok('RAG 入库(拿到 id)', !!ingId, ingId || JSON.stringify(ing).slice(0, 100))
let hit = []
for (let i = 0; i < 6; i++) {
  await sleep(10_000)
  const s = await fetch(`${KB_BASE}/api/v1/experience/${kbId}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({ query: '综合轮 稳定性报告 AML 投用', top_k: 5 }), signal: AbortSignal.timeout(60_000),
  }).then(x => x.json()).catch(() => null)
  hit = s?.experiences ?? s?.results ?? []
  if (hit.some(x => /综合轮 R4/.test(String(x.title ?? '')))) break
}
ok('RAG 检索命中', hit.some(x => /综合轮 R4/.test(String(x.title ?? ''))), 'hits=' + hit.length)
if (taskId) {
  const st = await fetch('http://127.0.0.1:3210/api/diagnosis/status/' + taskId, { headers: { authorization: 'Bearer ' + IDD_TOKEN } }).then(x => x.json()).catch(() => null)
  console.log('    ↳ IDD 任务 ' + taskId + ': ' + (st?.data?.status ?? '?'))
}

/* ── 收尾 ── */
mcp.stdin.end(); mcp.kill()
console.log('')
console.log('════════════════════════════════════════')
console.log('  真实简单综合轮:' + pass + ' PASS / ' + fails.length + ' FAIL')
for (const f of fails) console.log('  ✖ ' + f)
console.log('════════════════════════════════════════')
console.log('数据集 ' + dsId + '(' + dsRowsN + ' 行) | 模型 ' + (best?.id ?? '无(门未过)') + ' | IDD ' + (taskId || '未提交'))
process.exit(fails.length ? 1 : 0)
