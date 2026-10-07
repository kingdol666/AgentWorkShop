// ============================================================
// run-benchmark.mjs —— AgentWorkShop 全功能基准 PIPELINE(一键执行)
//
// 产出(docs/benchmarks/<runId>/):
//   report.md       人读基准报告(功能矩阵 + 多源异构 + 治理负路径 + 闭环场景全过程时间线)
//   benchmark.json  机器可读全量结果(断言/评分/环境)
//   timeline.jsonl  闭环优化控制过程逐事件流(observation→decision→propose→HITL→dispatch→verify→verdict)
//
// 场景任务(闭环,真实下发,受治理链约束):
//   S4 optimize 闭环寻优:观测→控制律→五要素提案→HITL 自动裁决→整批下发→三方核验→判定
//   S5 tuning 稳定微调:单变量小步→回读→频控拦截验证→窗后回退→复原判读
//   S6 diagnose 数据诊断:daq_export 全窗宽表→分段统计→与镜像观测对照
//
// 用法:node scripts/testing/run-benchmark.mjs [--config <path>] [--out <dir>] [--skip S1,S2]
// 铁律:不触受保护演示线;写动作全部落在配置产线内;每一步落时间线,失败不中断(汇总判定)。
// ============================================================
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const argOf = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : def
}
const CONFIG_PATH = resolve(__dirname, argOf('config', 'benchmark.config.json'))
const OUT_ROOT = resolve(__dirname, '..', '..', argOf('out', 'docs/benchmarks'))
const SKIP = new Set((argOf('skip', '') || '').split(',').filter(Boolean))
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const B = cfg.base
const RUN_ID = 'benchmark-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
const OUT_DIR = join(OUT_ROOT, RUN_ID)
mkdirSync(OUT_DIR, { recursive: true })
const T0 = Date.now()

// ---------- 记录器 ----------
const checks = []
const timeline = []
const stages = []
let timelineFd = null
const check = (stage, name, pass, note = '') => {
  checks.push({ stage, name, pass: !!pass, note: String(note).slice(0, 220) })
  console.log(`  ${pass ? '✅' : '❌'} [${stage}] ${name}${note ? ' —— ' + String(note).slice(0, 150) : ''}`)
}
const event = (stage, type, detail) => {
  const e = { ts: new Date().toISOString(), stage, type, detail }
  timeline.push(e)
  if (!timelineFd) timelineFd = join(OUT_DIR, 'timeline.jsonl')
  writeFileSync(timelineFd, JSON.stringify(e) + '\n', { flag: 'a' })
  console.log(`    · [${stage}] ${type}${detail ? ': ' + String(detail).slice(0, 120) : ''}`)
}
const stageBegin = (name, desc) => {
  stages.push({ id: name, desc, t0: Date.now() })
  console.log(`\n══ ${name} ${desc} ══`)
}
const stageEnd = (name) => {
  const s = stages.find(x => x.id === name)
  if (s) s.ms = Date.now() - s.t0
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- HTTP 面 ----------
let TOKEN = ''
const api = async (method, url, body, raw = false) => {
  const r = await fetch(B + url, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (raw) return r
  try {
    return await r.json()
  }
  catch {
    return { code: 'BAD_JSON', status: r.status }
  }
}
const inv = async (agentId, tool, args) => {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
  return String(r?.data?.result?.text ?? r?.message ?? JSON.stringify(r).slice(0, 200))
}
const meanOf = async (dnid, winMin = 8, bucketMs = 30000) => {
  const now = Date.now()
  const r = await api('GET', `/api/workshop/daq/${dnid}/samples?from=${now - winMin * 60000}&to=${now}&bucketMs=${bucketMs}`)
  const pts = (r?.data?.points ?? []).filter(p => Number.isFinite(p.avg))
  return pts.length ? pts.reduce((s, p) => s + p.avg, 0) / pts.length : null
}
const dcwNode = async (id) => {
  const d = await api('GET', '/api/workshop/dcw')
  return (d?.data?.nodes ?? []).find(n => n.id === id) ?? null
}

// ============================================================
// S0 环境预检
// ============================================================
async function s0() {
  stageBegin('S0', '环境预检')
  const health = await api('GET', '/api/health')
  check('S0', '服务健康', health?.data?.status === 'ok', `version=${health?.data?.version} uptime=${Math.round((health?.data?.uptimeMs ?? 0) / 60000)}min`)
  event('S0', 'env', JSON.stringify({ version: health?.data?.version, channels: health?.data?.activeChannels, memory: health?.data?.memory }))
  let sim
  try {
    sim = (await fetch('http://127.0.0.1:4010/api/plant/state')).status === 200
  }
  catch {
    sim = false
  }
  check('S0', 'PLC 模拟器(:4010)', sim)
  let mes
  try {
    const r = await fetch('http://127.0.0.1:15060/health')
    mes = r.status === 200 || r.status === 401
  }
  catch {
    mes = false
  }
  check('S0', 'MES 模拟器(:15060)', mes, mes ? 'alive' : 'unreachable')
  const daq = await api('GET', '/api/workshop/daq')
  check('S0', 'DAQ 控制器在采', !!daq?.data?.controller?.running, `nodes=${daq?.data?.controller?.nodesOnline ?? '?'}`)
  const line = await api('GET', '/api/workshop/dcw')
  const ln = (line?.data?.lines ?? []).find(l => l.id === cfg.lineId)
  check('S0', '基准产线在册', !!ln, ln?.name ?? '')
  stageEnd('S0')
}

// ============================================================
// S1 API 功能矩阵(复用 scripts/testing/api-full-loop.mjs,44 断言)
// ============================================================
async function s1() {
  stageBegin('S1', 'API 全表面功能矩阵(api-full-loop)')
  const out = await new Promise((resolveP) => {
    const child = spawn(process.execPath, [join(__dirname, 'api-full-loop.mjs')], { cwd: resolve(__dirname, '..', '..'), encoding: 'utf8' })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
    })
    child.stderr.on('data', (d) => {
      buf += d
    })
    child.on('close', code => resolveP({ code, buf }))
  })
  const lines = out.buf.split('\n').filter(l => /^[✅❌]/.test(l.trim()))
  for (const l of lines) {
    const pass = l.startsWith('✅')
    const m = l.slice(1).trim()
    const [name, ...rest] = m.split(' — ')
    checks.push({ stage: 'S1', name: name.trim(), pass, note: rest.join(' — ').slice(0, 200) })
  }
  const tail = out.buf.match(/=== API 全表面循环测试: (\d+) pass \/ (\d+) fail ===/)
  const p = tail ? Number(tail[1]) : lines.filter(l => l.startsWith('✅')).length
  const f = tail ? Number(tail[2]) : lines.filter(l => l.startsWith('❌')).length
  check('S1', `功能矩阵汇总(${p} pass / ${f} fail)`, f === 0, `exit=${out.code}`)
  if (f > 0) console.log(out.buf.split('\n').filter(l => l.startsWith('❌')).join('\n'))
  stageEnd('S1')
}

// ============================================================
// S2 多源异构采集 + MES 双模式
// ============================================================
async function s2() {
  stageBegin('S2', '多源异构采集 + MES 双模式')
  const now = Date.now()
  const scalar = await api('GET', `/api/workshop/daq/${cfg.nodes.daq.weight}/samples?from=${now - 120000}&to=${now}&bucketMs=15000`)
  check('S2', '标量镜像入库(称重克重)', (scalar?.data?.points ?? []).length > 0, `2min 桶=${(scalar?.data?.points ?? []).length}`)
  const vec = await api('GET', `/api/workshop/daq/${cfg.nodes.daq.profile}/frames?from=${now - 300000}&to=${now}&limit=5`)
  const vecRows = vec?.data?.frames ?? []
  check('S2', '向量帧入库(壁厚轮廓)', vecRows.length > 0, `5min 帧=${vecRows.length}`)
  const img = await api('GET', `/api/workshop/daq/${cfg.nodes.daq.ccd}/frames?from=${now - 300000}&to=${now}&limit=10`)
  const imgRows = img?.data?.frames ?? []
  check('S2', '图像帧入库(CCD)', imgRows.length > 0, `5min 帧=${imgRows.length}`)
  const withSha = imgRows.filter(f => f?.meta?.sha256)
  check('S2', '图像 sha256 完整性指纹(P0 回归)', withSha.length > 0, `${withSha.length}/${imgRows.length} 帧带指纹`)
  const mes = await api('GET', `/api/workshop/daq/${cfg.nodes.daq.mesMean}/samples?from=${now - 120000}&to=${now}&bucketMs=15000`)
  check('S2', 'MES 镜像路(http 数采)', (mes?.data?.points ?? []).length > 0, `2min 桶=${(mes?.data?.points ?? []).length}`)
  const to = new Date()
  const from = new Date(to.getTime() - 15 * 60000)
  const direct = await inv(cfg.workerId, 'mes_fetch', { ids: [cfg.nodes.dcw.mesDirect], from: from.toISOString(), to: to.toISOString(), max_rows: 20 })
  check('S2', 'MES 直取路(mes_fetch)', /行|dataset|样本|data|CSV/.test(direct) && !/必填|被拒|不支持/.test(direct), direct.split('\n')[0].slice(0, 90))
  event('S2', 'heterogeneous-snapshot', JSON.stringify({ scalarBuckets: (scalar?.data?.points ?? []).length, vecFrames: vecRows.length, imgFrames: imgRows.length, imgSha256: withSha.length }))
  stageEnd('S2')
}

// ============================================================
// S3 治理负路径(越界 / mock 兜底封堵)
// ============================================================
async function s3() {
  stageBegin('S3', '治理负路径')
  const bad = await api('POST', `/api/workshop/dcw/${cfg.nodes.dcw.holdP}/write`, { value: 999 })
  check('S3', '越界写被拒(工艺安全量程)', bad?.code !== 0 || bad?.data?.outcome?.ok === false, String(bad?.message ?? bad?.data?.outcome?.message ?? '').slice(0, 90))
  const bogusNode = await api('POST', '/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'bm-mock封堵验证', driver: 'bogus-protocol', min: 0, max: 100 })
  check('S3', '未知驱动显式拒绝(mock 封堵,P0 回归)', bogusNode?.code !== 0, String(bogusNode?.message ?? '').slice(0, 90))
  const bogusTest = await api('POST', '/api/workshop/dcw/test-driver', { driver: 'nosuch-proto', driverConfig: {} })
  check('S3', 'testDriver 未知协议拒绝', bogusTest?.code !== 0, String(bogusTest?.message ?? '').slice(0, 90))
  stageEnd('S3')
}

// ============================================================
// S4 闭环优化场景(optimize)—— 全过程时间线
// ============================================================
async function s4() {
  stageBegin('S4', '闭环优化场景(optimize):观测→决策→提案→HITL→下发→三方核验')
  const pre = await dcwNode(cfg.nodes.dcw.holdP)
  const cur = Number(pre?.value ?? pre?.readValue ?? 63)
  const w = await meanOf(cfg.nodes.daq.weight)
  const sink = await meanOf(cfg.nodes.daq.sink)
  event('S4', 'observation', JSON.stringify({ holdP: cur, weight: w == null ? null : Number(w.toFixed(2)), sink: sink == null ? null : Number(sink.toFixed(2)), window: '8min' }))
  check('S4', '镜像观测有效(克重/缩痕)', w != null, `weight=${w == null ? '?' : w.toFixed(2)}g sink=${sink == null ? '?' : sink.toFixed(2)}%`)

  // 控制律:朝 32.5 中心小步;已收敛(≤deadband)时做 1bar 灵敏度激励步(基准需实证下发链路,如实记录)
  const err = cfg.target.center - (w ?? cfg.target.center)
  let to
  if (Math.abs(err) <= cfg.target.deadband) {
    to = Math.min(cfg.limits.holdP.max - 2, cur + 1)
    event('S4', 'decision', JSON.stringify({ mode: 'converged-sensitivity-step', err: Number(err.toFixed(3)), to, rationale: '已收敛,做 +1bar 灵敏度激励步以实证闭环下发链路(激励后由后续轮次回拉)' }))
  }
  else {
    to = Math.round(Math.max(cfg.limits.holdP.min + 2, Math.min(cfg.limits.holdP.max - 2, cur + Math.sign(err) * Math.min(2, Math.max(1, Math.abs(err) / cfg.target.slopePerBar)))))
    event('S4', 'decision', JSON.stringify({ mode: 'corrective', err: Number(err.toFixed(3)), to, rationale: `误差 ${err.toFixed(2)}g / 斜率 ${cfg.target.slopePerBar}g/bar → 单变量小步` }))
  }
  check('S4', '控制律出步(目标 32.5±0.35)', to !== cur, `${cur} → ${to}`)

  // 五要素提案 + 并行 HITL 自动裁决(提案阻塞等待审批,必须后台轮询)
  const pkg = {
    name: `BM-保压${to > cur ? '微升' : '微降'}(${to > cur ? '灵敏度激励' : '纠偏'}步)`,
    rationale: `基准闭环:镜像克重 ${w == null ? '?' : w.toFixed(2)}g(目标 ${cfg.target.center}±0.35),误差 ${err.toFixed(2)}g;保压为补缩第一控制量`,
    params: [{ node_id: cfg.nodes.dcw.holdP, to, basis: `单变量小步 ${cur}→${to}(≤步限 ${cfg.limits.holdP.step}bar)`, exp_ref: `KB:R1/R2+FT 方向性实证;镜像克重 ${w == null ? '?' : w.toFixed(2)}g@${new Date().toISOString().slice(11, 19)}` }],
  }
  event('S4', 'propose', JSON.stringify({ to, package: pkg.name }))

  // 提案→HITL→下发;节拍窗被拦时按提示等待后重提(PIPELINE 可重复执行:连跑时自动等节拍窗)
  let prop = ''
  let okDispatch = false
  let runId = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) event('S4', 'propose', JSON.stringify({ to, package: pkg.name, attempt }))
    const propPromise = inv(cfg.workerId, 'recipe_propose', { recipe_id: cfg.recipeId, packages: [pkg] })
    let card = null
    for (let i = 0; i < 30; i++) {
      await sleep(2000)
      const pend = await api('GET', '/api/workshop/hitl/pending')
      const cards = (pend?.data?.cards ?? pend?.data?.items ?? (Array.isArray(pend?.data) ? pend.data : [])).filter(c => c.kind === 'dcw-approval')
      card = cards.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
      if (card) break
    }
    if (!card) {
      await propPromise.catch(() => {})
      break
    }
    const cardTxt = JSON.stringify(card)
    const hasReasoning = cardTxt.includes('保压') && (cardTxt.includes('basis') || cardTxt.includes('依据') || cardTxt.includes('步限') || cardTxt.includes('镜像'))
    if (attempt === 1) check('S4', 'HITL 卡出现且含推理依据', hasReasoning, `card=${card.id?.slice(0, 12)}`)
    event('S4', 'hitl_card', JSON.stringify({ id: card.id, reasoning: hasReasoning, attempt }))
    const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'benchmark 自动裁决:批准该闭环步' })
    if (attempt === 1) check('S4', 'HITL 裁决通过(附裁决意见)', resp?.code === 0, String(resp?.message ?? '').slice(0, 60))
    event('S4', 'approved', JSON.stringify({ id: card.id, attempt }))
    prop = await propPromise
    // 文本含两个 id:「批次 rr-xxx」(批次号)与「runId:rr-xxxxxxx」(台账键)——必须取后者
    runId = /runId[:：]\s*(rr-[\w-]+)/.exec(prop)?.[1] ?? /rr-[\w-]+/.exec(prop)?.[0]
    okDispatch = /已批准|成功/.test(prop) && !/失败|超时未批/.test(prop)
    if (okDispatch) break
    const waitSec = Number(/请等待 (\d+)s/.exec(prop)?.[1] ?? 0)
    if (waitSec > 0 && attempt < 3) {
      event('S4', 'cadence-wait', `试验节拍窗未放行(治理在岗)—— 等 ${waitSec + 10}s 后重提(attempt ${attempt} → ${attempt + 1})`)
      await sleep((waitSec + 10) * 1000)
      continue
    }
    break
  }
  check('S4', '提案批准并整批下发', okDispatch, (prop.split('\n')[0] ?? '').slice(0, 110))
  event('S4', 'dispatch', JSON.stringify({ runId, ok: okDispatch, summary: prop.split('\n')[0]?.slice(0, 160) }))
  if (!okDispatch) {
    stageEnd('S4')
    return
  }

  // 三方核验:配方 | 设备(同链路回读) | 镜像(SP 采样)
  await sleep(8000)
  const run = runId ? await api('GET', '/api/workshop/dcw/runs?limit=2000').then(d => (d?.data?.runs ?? []).find(x => x.id === runId)) : null
  const runOk = (run?.results ?? []).some(r => r.nodeId === cfg.nodes.dcw.holdP && r.ok)
  check('S4', '批次台账 holdP 落账 ok', !!runOk, `run=${runId}`)
  const after = await dcwNode(cfg.nodes.dcw.holdP)
  const rd = await api('POST', `/api/workshop/dcw/${cfg.nodes.dcw.holdP}/read`, {})
  const devVal = rd?.data?.read?.value ?? rd?.data?.value
  event('S4', 'settle-wait', '等待镜像 SP 采样跟上(15s)')
  await sleep(15000)
  const now = Date.now()
  const mirr = await api('GET', `/api/workshop/daq/${cfg.nodes.daq.spMirror}/samples?from=${now - 60000}&to=${now}&bucketMs=5000`)
  const mirrorVal = (mirr?.data?.points ?? []).at(-1)?.avg
  const setV = Number(after?.value), devN = Number(devVal), mirN = Number(mirrorVal)
  const threeWay = Number.isFinite(setV) && Number.isFinite(devN) && Math.abs(setV - devN) <= 0.05 && Number.isFinite(mirN) && Math.abs(setV - mirN) <= 0.51
  check('S4', '三方核验(配方|设备|镜像)一致', threeWay, `配方=${setV} 设备=${Number.isFinite(devN) ? devN : '?'} 镜像=${Number.isFinite(mirN) ? mirN : '?'}`)
  event('S4', 'verify', JSON.stringify({ set: setV, device: devN, mirror: mirN, threeWay }))
  event('S4', 'verdict', JSON.stringify({ converged: Math.abs(err) <= cfg.target.deadband, dispatchedTo: setV, nextReview: '4min 惯性窗后复测' }))
  stageEnd('S4')
}

// ============================================================
// S5 稳定微调场景(tuning)—— 小步 + 频控 + 回退
// ============================================================
async function s5() {
  stageBegin('S5', '稳定微调场景(tuning):小步→回读→频控→回退')
  const node = await dcwNode(cfg.nodes.dcw.moldT)
  const cur = Number(node?.value ?? node?.readValue ?? 40)
  const step = 0.5
  event('S5', 'observation', JSON.stringify({ moldT: cur, stepLimit: node?.stepLimit }))
  // 可重复执行:节点 60s 写间隔未放行时先等待(连跑场景)
  const lastMs = node?.lastWriteAt ? Date.parse(node.lastWriteAt) : 0
  const remainMs = 60_000 - (Date.now() - lastMs)
  if (Number.isFinite(remainMs) && remainMs > 0) {
    event('S5', 'settle-wait', `上一写在 ${Math.ceil(remainMs / 1000)}s 后过 60s 间隔 —— 先等待`)
    await sleep(remainMs + 2000)
  }
  const up = await api('POST', `/api/workshop/dcw/${cfg.nodes.dcw.moldT}/write`, { value: cur + step })
  const upOk = up?.code === 0 && up?.data?.outcome?.ok !== false
  check('S5', '单变量小步修正(治理链内)', upOk, `${cur} → ${cur + step} ${String(up?.data?.outcome?.message ?? up?.message ?? '').slice(0, 70)}`)
  event('S5', 'micro-step', JSON.stringify({ from: cur, to: cur + step, ok: upOk, readback: up?.data?.outcome?.readback ?? null }))
  const immediate = await api('POST', `/api/workshop/dcw/${cfg.nodes.dcw.moldT}/write`, { value: cur })
  const blocked = immediate?.code !== 0 && /间隔|保持窗|频繁|60/i.test(String(immediate?.message ?? ''))
  check('S5', '立即反向写被频控/保持窗拦截', blocked, String(immediate?.message ?? '').slice(0, 80))
  event('S5', 'rate-limited', JSON.stringify({ blocked, message: String(immediate?.message ?? '').slice(0, 120) }))
  event('S5', 'settle-wait', '等待 66s 治理窗放行')
  await sleep(66_000)
  const back = await api('POST', `/api/workshop/dcw/${cfg.nodes.dcw.moldT}/write`, { value: cur })
  const backOk = back?.code === 0 && back?.data?.outcome?.ok !== false
  check('S5', '窗后回退到原值', backOk, `${cur + step} → ${cur} ${String(back?.data?.outcome?.message ?? back?.message ?? '').slice(0, 60)}`)
  const after = await dcwNode(cfg.nodes.dcw.moldT)
  check('S5', '复原判读(节点值=原值)', Number(after?.value) === cur, `value=${after?.value}`)
  event('S5', 'verdict', JSON.stringify({ restored: Number(after?.value) === cur, value: after?.value }))
  stageEnd('S5')
}

// ============================================================
// S6 数据诊断场景(diagnose)—— 导出 + 分段统计
// ============================================================
async function s6() {
  stageBegin('S6', '数据诊断场景(diagnose):全窗导出→分段统计')
  const from = Date.now() - 30 * 60000
  const exp = await inv(cfg.diagAgentId, 'daq_export', { line_id: cfg.lineId, from_ms: from, merge: true, purpose: 'benchmark 诊断场景:全窗宽表' })
  const expId = /daqexp-[\w-]+/.exec(exp)?.[0]
  const csvPath = expId ? resolve(__dirname, '..', '..', '.AgentWorkShop', 'data', 'daq-exports', expId, 'merged.csv') : ''
  const exists = !!expId && existsSync(csvPath)
  check('S6', 'daq_export 全窗宽表', exists, expId ?? exp.split('\n')[0].slice(0, 80))
  event('S6', 'export', JSON.stringify({ exportId: expId, path: exists ? csvPath : null }))
  if (!exists) {
    stageEnd('S6')
    return
  }
  const rows = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/)
  const header = (rows[0] ?? '').split(',')
  const weightCol = header.findIndex(h => h.includes('克重'))
  const dataRows = rows.slice(1)
  const numeric = r => Number(r.split(',')[weightCol >= 0 ? weightCol : 1])
  const vals = dataRows.map(numeric).filter(Number.isFinite)
  const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1)
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length || 1))
  check('S6', '宽表行数达标(≥50 行)', dataRows.length >= 50, `rows=${dataRows.length} cols=${header.length}`)
  check('S6', '克重列统计有效', vals.length > 0 && Number.isFinite(mean) && Number.isFinite(std), `n=${vals.length} mean=${mean.toFixed(3)} std=${std.toFixed(3)} min=${Math.min(...vals).toFixed(2)} max=${Math.max(...vals).toFixed(2)}`)
  const inSpec = vals.filter(v => Math.abs(v - cfg.target.center) <= 0.35).length
  const rate = vals.length ? inSpec / vals.length : 0
  check('S6', '规格内占比 ≥60%(32.5±0.35)', rate >= 0.6, `${(rate * 100).toFixed(1)}% (${inSpec}/${vals.length})`)
  event('S6', 'stats', JSON.stringify({ rows: dataRows.length, weight: { n: vals.length, mean: Number(mean.toFixed(3)), std: Number(std.toFixed(3)), inSpecRate: Number(rate.toFixed(3)) } }))
  stageEnd('S6')
}

// ============================================================
// S7 报告生成
// ============================================================
function renderReport(env) {
  const byStage = id => checks.filter(c => c.stage === id)
  const passOf = id => byStage(id).filter(c => c.pass).length
  const line = c => `| ${c.pass ? '✅' : '❌'} | ${c.name} | ${c.note.replace(/\|/g, '/')} |`
  const tl = id => timeline.filter(e => e.stage === id).map(e => `| ${e.ts.slice(11, 19)} | ${e.type} | ${String(e.detail ?? '').replace(/\|/g, '/').slice(0, 160)} |`).join('\n')
  const total = checks.length
  const passed = checks.filter(c => c.pass).length
  const durMin = Math.round((Date.now() - T0) / 60000)
  return `# AgentWorkShop 全功能基准报告(${RUN_ID})

- 执行:一键 PIPELINE \`node scripts/testing/run-benchmark.mjs\`(耗时 ${durMin} 分钟)
- 系统:**v${env.version}** · ${env.channels} 活跃频道 · 运行内存水位 ${env.heapRatio ?? '?'}
- 总分:**${passed} / ${total} 断言通过**(${total ? Math.round((passed / total) * 100) : 0} 分)

| 阶段 | 内容 | 通过 | 断言 |
|---|---|---|---|
| S0 | 环境预检 | ${passOf('S0')}/${byStage('S0').length} | 服务/模拟器/数采/基准产线 |
| S1 | API 全表面功能矩阵 | ${passOf('S1')}/${byStage('S1').length} | auth/users/channels/dcw/daq/tools/hitl/ops/memory 负向+正向 |
| S2 | 多源异构 + MES 双模 | ${passOf('S2')}/${byStage('S2').length} | 标量/向量/图像(sha256)/镜像路/直取路 |
| S3 | 治理负路径 | ${passOf('S3')}/${byStage('S3').length} | 越界拒/mock 兜底封堵 |
| S4 | 闭环优化场景(optimize) | ${passOf('S4')}/${byStage('S4').length} | 观测→决策→提案→HITL→下发→三方核验 |
| S5 | 稳定微调场景(tuning) | ${passOf('S5')}/${byStage('S5').length} | 小步→频控→回退→复原 |
| S6 | 数据诊断场景(diagnose) | ${passOf('S6')}/${byStage('S6').length} | 导出→统计→规格占比 |

${total - passed > 0 ? '\n> ❌ 未通过项:请按下方各表定位;系统缺陷需修复后重跑 PIPELINE。\n' : '\n> ✅ 全绿:全功能与闭环控制链路在本基准下全部达标。\n'}

## S0 环境预检
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S0').map(line).join('\n')}

## S1 API 全表面功能矩阵(${passOf('S1')}/${byStage('S1').length})
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S1').map(line).join('\n')}

## S2 多源异构 + MES 双模式(${passOf('S2')}/${byStage('S2').length})
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S2').map(line).join('\n')}

## S3 治理负路径(${passOf('S3')}/${byStage('S3').length})
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S3').map(line).join('\n')}

## S4 闭环优化场景 · 全过程时间线(${passOf('S4')}/${byStage('S4').length})

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S4').map(line).join('\n')}

**过程记录(observation → decision → propose → HITL → dispatch → verify → verdict):**
| 时刻 | 事件 | 明细 |
|---|---|---|
${tl('S4')}

## S5 稳定微调场景 · 全过程时间线(${passOf('S5')}/${byStage('S5').length})

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S5').map(line).join('\n')}

**过程记录:**
| 时刻 | 事件 | 明细 |
|---|---|---|
${tl('S5')}

## S6 数据诊断场景(${passOf('S6')}/${byStage('S6').length})
| 判 | 断言 | 说明 |
|---|---|---|
${byStage('S6').map(line).join('\n')}

---
*机器可读结果见同目录 benchmark.json 与 timeline.jsonl;PIPELINE 源码 scripts/testing/run-benchmark.mjs。*
`
}

async function s7() {
  stageBegin('S7', '报告生成')
  const health = await api('GET', '/api/health')
  const env = {
    version: health?.data?.version,
    channels: health?.data?.activeChannels,
    heapRatio: health?.data?.memory?.heapRatio,
    durationMs: Date.now() - T0,
    runId: RUN_ID,
    config: { lineId: cfg.lineId, recipeId: cfg.recipeId },
  }
  const total = checks.length
  const passed = checks.filter(c => c.pass).length
  const json = { runId: RUN_ID, startedAt: new Date(T0).toISOString(), durationMs: Date.now() - T0, env, score: { passed, total, ratio: total ? Number((passed / total).toFixed(4)) : 0 }, stages: stages.map(s => ({ id: s.id, desc: s.desc, ms: s.ms ?? null })), checks, timeline }
  writeFileSync(join(OUT_DIR, 'benchmark.json'), JSON.stringify(json, null, 2))
  writeFileSync(join(OUT_DIR, 'report.md'), renderReport(env))
  check('S7', 'benchmark 报告落盘', true, `${join(OUT_ROOT, RUN_ID)} (${passed}/${total})`)
  stageEnd('S7')
}

// ---------- 主流程 ----------
console.log(`══ AgentWorkShop 基准 PIPELINE ${RUN_ID} ══`)
const login = await api('POST', '/api/users/login', cfg.account)
TOKEN = login?.data?.token ?? ''
if (!TOKEN) {
  console.error('✖ 登录失败:' + JSON.stringify(login).slice(0, 120))
  process.exit(1)
}
const runners = { S0: s0, S1: s1, S2: s2, S3: s3, S4: s4, S5: s5, S6: s6, S7: s7 }
for (const [id, fn] of Object.entries(runners)) {
  if (SKIP.has(id)) {
    console.log(`(--skip ${id})`)
    continue
  }
  try {
    await fn()
  }
  catch (err) {
    check(id, '阶段异常(不中断)', false, String(err).slice(0, 160))
  }
}
const passed = checks.filter(c => c.pass).length
console.log(`\n══ 基准完成:${passed}/${checks.length} 通过 · 报告 ${join(OUT_ROOT, RUN_ID)} ══`)
process.exit(checks.some(c => !c.pass) ? 1 : 0)
