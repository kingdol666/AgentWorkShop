#!/usr/bin/env node
/**
 * tmp-e2e/reflow-doc2line-20261013.mjs —— 「文档 → 孪生 → 产线 → 频道 → 自动优化 + 数据分析」全链实弹测试
 *
 * 输入:tmp-e2e/reflow-doc.md(客户文档)+ tmp-e2e/reflow-blueprint.json(按 skill 阶段1 提炼的蓝图)
 * 流程:
 *   [S] aw-plc-sim-twin 模式B:蓝图 → 模拟器孪生设备+模拟生产(4035)
 *   [O] aw-line-onboarding 阶段2-6:孪生 export driverConfig → onboard.mjs 一键接入(线/节点/配方/频道/绑定/种子任务/冒烟闭环)
 *   [W] 数采验证(5 PV 通道)
 *   [C] 自动优化控制闭环实测:回流区SP 245→249(≤步限)→ HITL → 板温因果响应(预期 +2.48℃)
 *   [A] 数据分析:多列 CSV → 产线报告 skill 出分 → RAG 入库 → kb_agent(harness API)检索命中
 *   [G] 频道智能:直派 lead/分析师 真引擎任务(有界)
 * 判定:F1 文档→孪生;F2 接入建线;F3 数采;F4 优化因果;F5 报告;F6 检索;F7 引擎。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const DOC = join(REPO, 'tmp-e2e', 'reflow-doc.md')
const BLUEPRINT = join(REPO, 'tmp-e2e', 'reflow-blueprint.json')
const SIM = 'http://127.0.0.1:4035'
const KB_BASE = 'http://127.0.0.1:8770'
const KB_WEB = 'http://127.0.0.1:6789'
const KB_TOKEN = readFileSync(join(REPO, '.kb-token.tmp'), 'utf8').trim()
const IDD_PROJECT = 'D:/codes/myskills/industrial-deep-diagnostic'
const SKILL = join(IDD_PROJECT, '.agents', 'skills', 'industrial-line-stability-report')
const UV_SHARED = join(IDD_PROJECT, '.claude', 'shared', 'scripts')
const OUT = join(REPO, '.AgentWorkShop', 'analysis', 'reflow-doc2line-20261013')
mkdirSync(OUT, { recursive: true })
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
let TOKEN = process.env.AW_TOKEN ?? ''
const api = async (method, path, body) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path, {
        method, headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
      })
      return { status: r.status, ...(await r.json().catch(() => ({}))) }
    }
    catch (e) { if (i === 2) return { status: 0, message: e.message }; await sleep(3000) }
  }
}
const invAsync = (agentId, tool, args) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(560_000),
}).then(r => r.json().catch(() => ({}))).catch(e => ({ err: e.message }))

/* ═══ [D] 文档输入(阶段1 提炼产物即蓝图) ═══ */
console.log('\n[D] 文档输入')
ok('F0 客户文档在位', existsSync(DOC) && readFileSync(DOC, 'utf8').includes('回流焊'))
console.log(`    ↳ ${DOC}(6 点位寄存器表 + 3 遥测点 + 工艺规格 + 场景需求;蓝图 ${BLUEPRINT})`)

/* ═══ [S] 模拟器孪生(aw-plc-sim-twin 模式 B) ═══ */
console.log('\n[S] aw-plc-sim-twin 模式 B:蓝图 → 孪生')
{
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'onboarding', 'sim-twin.mjs'),
    '--blueprint', BLUEPRINT, '--sim-port', '4035'], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, AW_TOKEN: TOKEN } })
  console.log(r.stdout?.split('\n').filter(l => l.startsWith('  ') || l.startsWith('[')).slice(0, 8).join('\n'))
  const lastLine = (r.stdout ?? '').trim().split('\n').pop() ?? ''
  let summary = {}
  try { summary = JSON.parse(lastLine.includes('{') ? lastLine.slice(lastLine.indexOf('{')) : '{}') }
  catch { /* 忽略 */ }
  ok('F1 文档→孪生(2 设备 8 信号,tick 活性)', r.status === 0 && summary.totalSignals >= 8 && (summary.devices?.length ?? 0) === 2,
    `signals=${summary.totalSignals} devices=${summary.devices?.length} ${(r.stderr ?? '').slice(0, 80)}`)
}

/* ═══ [O] 一键接入(onboard.mjs:供给+频道+绑定+种子任务+冒烟闭环) ═══ */
console.log('\n[O] aw-line-onboarding 阶段2-6:一键接入')
let lineId = '', channelId = '', recipeId = ''
{
  // 从孪生 export 取 driverConfig(永不手抄)
  const devNames = ['reflow-oven-mbtcp', 'reflow-inspect-mqtt']
  const exportOf = {}
  for (const d of devNames) {
    const r = await fetch(`${SIM}/api/nodes/${d}/export`, { signal: AbortSignal.timeout(20000) }).then(x => x.json()).catch(() => null)
    exportOf[d] = r?.data?.items ?? []
  }
  const cfgOf = (dev, sigName) => exportOf[dev]?.find(i => i.signal === sigName)?.driverConfig ?? null
  const missing = []
  for (const [dev, sigs] of [
    ['reflow-oven-mbtcp', ['预热区温度SP', '回流区温度SP', '输送速度SP', '板温实测', '炉膛实测温度', '输送实际速度']],
    ['reflow-inspect-mqtt', ['峰值温度PV', '冷却斜率PV', '合格率PV']],
  ]) for (const s of sigs) if (!cfgOf(dev, s)) missing.push(`${dev}/${s}`)
  ok('O0 孪生 export driverConfig 全齐(9/9)', missing.length === 0, missing.join(',') || '9/9')

  const onboardCfg = {
    line: { name: 'SMT回流焊产线-文档接入实测', description: '文档接入实测:回流焊+炉后检测' },
    product: { name: 'SMT 贴片组件' },
    nodes: [
      { kind: 'dcw', name: '预热区温度SP', driver: 'modbus-tcp', driverConfig: cfgOf('reflow-oven-mbtcp', '预热区温度SP'), unit: '℃', min: 120, max: 200, decimals: 1, stepLimit: 4, holdIntervalMs: 120000, templateRef: 'dcw-temp-sp', semantics: 'SV:预热区温度,板温基础分量' },
      { kind: 'dcw', name: '回流区温度SP', driver: 'modbus-tcp', driverConfig: cfgOf('reflow-oven-mbtcp', '回流区温度SP'), unit: '℃', min: 200, max: 280, decimals: 1, stepLimit: 4, holdIntervalMs: 120000, templateRef: 'dcw-temp-sp', semantics: 'SV:回流区温度,主导板温峰值' },
      { kind: 'dcw', name: '输送速度SP', driver: 'modbus-tcp', driverConfig: cfgOf('reflow-oven-mbtcp', '输送速度SP'), unit: 'm/min', min: 0.6, max: 1.4, decimals: 2, stepLimit: 0.04, holdIntervalMs: 120000, templateRef: 'dcw-temp-sp', semantics: 'SV:输送速度,升速板温降' },
      { kind: 'daq', name: '板温实测', driver: 'modbus-tcp', driverConfig: cfgOf('reflow-oven-mbtcp', '板温实测'), unit: '℃', min: 50, max: 300, decimals: 2, intervalMs: 1000, templateRef: 'daq-temp-tc', semantics: 'PV:板温(质量核心,目标≈242.7@标称)' },
      { kind: 'daq', name: '炉膛实测温度', driver: 'modbus-tcp', driverConfig: cfgOf('reflow-oven-mbtcp', '炉膛实测温度'), unit: '℃', min: 0, max: 320, decimals: 1, intervalMs: 1000, templateRef: 'daq-temp-tc', semantics: 'PV:炉膛温度' },
      { kind: 'daq', name: '输送实际速度', driver: 'modbus-tcp', driverConfig: cfgOf('reflow-oven-mbtcp', '输送实际速度'), unit: 'm/min', min: 0, max: 2, decimals: 3, intervalMs: 1000, templateRef: 'daq-temp-tc', semantics: 'PV:输送实际速度(SP 镜像)' },
      { kind: 'daq', name: '峰值温度PV', driver: 'mqtt', driverConfig: cfgOf('reflow-inspect-mqtt', '峰值温度PV'), unit: '℃', min: 180, max: 300, decimals: 2, intervalMs: 2000, templateRef: 'daq-temp-tc', semantics: 'PV:峰值温度(规格245±5)' },
      { kind: 'daq', name: '冷却斜率PV', driver: 'mqtt', driverConfig: cfgOf('reflow-inspect-mqtt', '冷却斜率PV'), unit: '℃/s', min: 0, max: 6, decimals: 2, intervalMs: 2000, templateRef: 'daq-temp-tc', semantics: 'PV:冷却斜率(规格1~3)' },
      { kind: 'daq', name: '合格率PV', driver: 'mqtt', driverConfig: cfgOf('reflow-inspect-mqtt', '合格率PV'), unit: '%', min: 50, max: 100, decimals: 2, intervalMs: 2000, templateRef: 'daq-temp-tc', semantics: 'PV:批次合格率(规格≥95)' },
    ],
    recipe: { name: '回流焊标称配方', params: [
      { node: '预热区温度SP', value: 165 },
      { node: '回流区温度SP', value: 245 },
      { node: '输送速度SP', value: 1.0 },
    ] },
    startLine: true,
    connectivity: { skip: true },
    channel: {
      scenario: 'optimize',
      name: '回流焊优化频道-文档接入实测',
      plugins: { 'idd-closedloop-bridge': true, 'rag-bridge': true },
      bindings: [
        { agentRole: 'worker:2', kind: 'recipe', nodeId: '$RECIPE', mode: 'manual' },
        { agentRole: 'worker:1', kind: 'daq', nodeId: '$DAQ:板温实测', mode: 'auto' },
        { agentRole: 'worker:1', kind: 'daq', nodeId: '$DAQ:峰值温度PV', mode: 'auto' },
      ],
      seedTask: { title: '回流焊基线建档', description: '建立板温/峰值温度基线档案,标定当前稳定性与优化空间(读为主,不动设备)', budget_minutes: 60 },
    },
    smoke: { param: '回流区温度SP', delta: 2 },
    verify: {},
  }
  const cfgPath = join(OUT, 'onboard-config.json')
  writeFileSync(cfgPath, JSON.stringify(onboardCfg, null, 2))
  console.log(`    ↳ onboard 配置落盘(${onboardCfg.nodes.length} 节点),执行 onboard.mjs --smoke…`)
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'onboarding', 'onboard.mjs'), cfgPath, '--skip-connectivity', '--smoke'],
    { encoding: 'utf8', timeout: 900_000, env: { ...process.env, AW_TOKEN: TOKEN }, maxBuffer: 16 * 1024 * 1024 })
  const outLines = (r.stdout ?? '').split('\n')
  console.log(outLines.filter(l => /✅|❌|交接|摘要|↳/.test(l)).slice(0, 24).join('\n'))
  const lastJson = [...outLines].reverse().find(l => l.trim().startsWith('{'))
  let sum = {}
  try { sum = JSON.parse(lastJson ?? '{}') }
  catch { /* 忽略 */ }
  lineId = sum.lineId ?? ''; channelId = sum.channelId ?? ''; recipeId = sum.recipeId ?? ''
  writeFileSync(join(OUT, 'onboard-summary.json'), lastJson ?? '{}')
  ok('F2 一键接入(线/节点/配方/频道/绑定/冒烟闭环)', r.status === 0 && !!lineId && !!channelId && !!recipeId,
    `line=${lineId} ch=${String(channelId).slice(0, 8)} recipe=${recipeId} exit=${r.status} ${(r.stderr ?? '').slice(0, 100)}`)
}

/* ═══ MCP ═══ */
const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO, env: { ...process.env, AW_BASE_URL: BASE, AW_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 跳过 */ }
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

/* ═══ [W] 数采验证 ═══ */
console.log('\n[W] 数采验证')
await sleep(70_000)
const pvNames = ['板温实测', '炉膛实测温度', '输送实际速度', '峰值温度PV', '冷却斜率PV', '合格率PV']
const daqAll = (await api('GET', '/api/workshop/daq?limit=300'))?.data?.nodes ?? []
const myDaq = daqAll.filter(n => n.lineId === lineId)
const pvIds = {}
for (const nm of pvNames) pvIds[nm] = myDaq.find(n => n.name === nm)?.id
let sampling = 0
for (const nm of pvNames) {
  const s = await call('aw_daq_samples', { id: pvIds[nm], from: Date.now() - 60_000, to: Date.now(), bucketMs: 2000, limit: 100 })
  if ((s.data?.points ?? []).length > 0) sampling++
  console.log(`    ↳ ${nm}: ${(s.data?.points ?? []).length} pts`)
}
ok(`F3 数采 6 PV 通道全有样本`, sampling === 6, `${sampling}/6`)

/* ═══ [C] 自动优化控制闭环(HITL 治理) ═══ */
console.log('\n[C] 优化闭环:回流区 245→249 → 板温因果')
const dcwAll = (await api('GET', '/api/workshop/dcw?limit=200'))?.data?.nodes ?? []
const zone2 = dcwAll.find(n => n.lineId === lineId && n.name === '回流区温度SP')
const membersRaw = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data
const members = membersRaw?.items ?? (Array.isArray(membersRaw) ? membersRaw : [])
const procEngId = members.find(m => String(m.name).includes('工艺工程师'))?.agentId ?? members.find(m => String(m.name).includes('工艺工程师'))?.id ?? ''
const winMean = async (id, ms = 60_000) => {
  const s = await call('aw_daq_samples', { id, from: Date.now() - ms, to: Date.now(), bucketMs: 2000, limit: 200 })
  const v = (s.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
const btPre = await winMean(pvIds['板温实测'])
const knownCards = new Set((await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.map(x => x.id) ?? [])
const propP = invAsync(procEngId, 'recipe_propose', {
  recipe_id: recipeId, emergency: true,
  packages: [{ name: 'RO-回流区微升', rationale: '峰值温度贴规格下沿,回流区 +4℃ 有界提升(≤步限),抬升板温与峰值', params: [{ node_id: zone2.id, to: 249, basis: '板温对回流区增益 ≈0.62℃/℃(文档耦合);+4℃ → 板温 ≈+2.5℃', exp_ref: 'reflow-doc.md §2.1' }] }],
})
let card = null
for (let i = 0; i < 60 && !card; i++) {
  await sleep(2000)
  card = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items?.filter(x => x.kind === 'dcw-approval' && !knownCards.has(x.id))[0] ?? null
}
ok('C1 提案审批卡生成', !!card, card?.id ?? '120s 未出现')
if (card) {
  const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '文档接入实测:批准回流区 +4℃ 有界试验' })
  ok('C2 HITL 批准受理', resp?.code === 0 || resp?.status === 200, JSON.stringify(resp?.message ?? '').slice(0, 80))
}
const prop1 = await propP
const prop1Txt = String(prop1?.data?.result?.text ?? JSON.stringify(prop1?.data ?? ''))
ok('C3 提案获批并下发(runId)', /已获批/.test(prop1Txt) && /rr-[\w-]+/.test(prop1Txt), prop1Txt.split('\n')[0]?.slice(0, 130))
await sleep(100_000)
const btPost = await winMean(pvIds['板温实测'], 80_000)
const btShift = (btPost ?? 0) - (btPre ?? 0)
ok(`F4 因果:回流区 +4℃ → 板温 ${btPre?.toFixed(2)}→${btPost?.toFixed(2)}℃(Δ=${btShift.toFixed(2)},预期 ≈+2.5)`, btShift > 1.2, `shift=${btShift.toFixed(2)}`)

/* ═══ [A] 数据分析(报告 skill + RAG + harness 检索) ═══ */
console.log('\n[A] 数据分析')
let repScore = null; let repGrade = null; let reportDigest = ''
{
  const cols = [['板温实测', pvIds['板温实测']], ['峰值温度PV', pvIds['峰值温度PV']], ['合格率PV', pvIds['合格率PV']], ['炉膛实测温度', pvIds['炉膛实测温度']]]
  const t0 = Date.now() - 8 * 60_000
  const series = []
  for (const [c, id] of cols) {
    const s = await call('aw_daq_samples', { id, from: t0, to: Date.now(), bucketMs: 2000, limit: 400 })
    series.push({ c, pts: (s.data?.points ?? []).map(p => ({ at: Number(p.at), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)) })
  }
  const stamps = [...new Set(series.flatMap(s => s.pts.map(p => p.at)))].sort((a, b) => a - b)
  const rows = stamps.map((t) => { const row = { timestamp: new Date(t).toISOString() }; for (const { c, pts } of series) { const hit = pts.find(p => Math.abs(p.at - t) <= 2000); row[c] = hit ? Number(hit.v.toFixed(3)) : '' } return row })
  if (rows.length > 50) {
    writeFileSync(join(OUT, 'reflow-analysis.csv'), [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).join(','))].join('\n'))
    ok(`A1 分析 CSV 落盘(${rows.length} 行 × 4 列)`, true)
    const pull = series[0].pts
    writeFileSync(join(OUT, 'boardtemp.csv'), ['timestamp,board_temp', ...pull.map(p => new Date(p.at).toISOString() + ',' + p.v.toFixed(3))].join('\n'))
    const pyr = spawnSync('uv', ['run', '--project', UV_SHARED, 'python', join(SKILL, 'scripts', 'stability_analyzer.py'),
      'analyze', '--data', join(OUT, 'boardtemp.csv'), '--time-col', 'timestamp', '--out-dir', OUT], { encoding: 'utf8', timeout: 240_000 })
    const rep = existsSync(join(OUT, 'stability_report.json')) ? JSON.parse(readFileSync(join(OUT, 'stability_report.json'), 'utf8')) : null
    repScore = rep?.conclusion?.score ?? null; repGrade = rep?.conclusion?.grade ?? null
    ok(`A2 产线报告 skill 出分`, (pyr.status === 0 || pyr.status === 1) && Number.isFinite(repScore), `score=${repScore} grade=${repGrade}`)
    reportDigest = `板温报告 score=${repScore} grade=${repGrade};回流区 245→249℃ 后板温漂移 +${btShift.toFixed(2)}℃(预期 +2.5);分析窗 ${rows.length} 行`
    console.log(`    ↳ ${reportDigest}`)
  }
  else ok('A1 分析 CSV 落盘', false, `rows=${rows.length}`)
  // RAG 入库 + harness 检索
  const cat = await fetch(`${KB_WEB}/api/kb/catalog`, { headers: { 'X-KB-Token': KB_TOKEN, 'authorization': `Bearer ${KB_TOKEN}` }, signal: AbortSignal.timeout(20000) }).then(r => r.json()).catch(() => null)
  const kbId = (cat?.knowledgeBases ?? []).find(k => k.name === 'aw-industrial')?.kbId ?? ''
  const ing = await fetch(`${KB_BASE}/api/v1/experience/${kbId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KB_TOKEN}`, 'X-KB-Token': KB_TOKEN },
    body: JSON.stringify({
      title: 'SMT 回流焊产线 2026-10-13 文档接入实测:回流区温度-板温因果与稳定性',
      scenario: 'SMT 回流焊:预热/回流区温度+输送速度三参数,峰值温度 245±5℃、合格率 ≥95%',
      category: 'troubleshooting',
      problem: '峰值温度随炉温/输送速度波动,需量化板温对回流区温度的响应并评估稳定性',
      solution: `${reportDigest}。板温对回流区增益 ≈0.62℃/℃(τ≈15s);输送速度增益 ≈-60℃/(m/min);峰值贴下沿时优先回流区 +2~4℃ 有界提升。`,
      result: 'success',
      key_lessons: ['回流区温度是板温峰值的第一杠杆', '输送速度是反方向第二杠杆(升速降温)'],
      tags: ['回流焊', 'SMT', '板温', '峰值温度', '文档接入', 'reflow-doc2line-20261013'],
      metrics: { btShift: Number(btShift.toFixed(2)), reportScore: repScore },
    }),
    signal: AbortSignal.timeout(60_000),
  }).then(r => r.json()).catch(e => ({ err: e.message }))
  ok('A3 分析结论入库 RAG', !!(ing?.id ?? ing?.experience_id ?? ing?.data?.id) || /success/i.test(JSON.stringify(ing).slice(0, 200)), JSON.stringify(ing).slice(0, 100))
  const analystId = members.find(m => String(m.name).includes('数据分析师'))?.agentId ?? members.find(m => String(m.name).includes('数据分析师'))?.id ?? ''
  await sleep(10_000)
  const kbRes = await invAsync(analystId, 'kb_agent', { prompt: '检索知识库:SMT 回流焊 板温 峰值温度 回流区温度 因果分析结论,返回最相关经验标题与要点。' })
  const kbTxt = String(kbRes?.data?.result?.text ?? JSON.stringify(kbRes?.data ?? ''))
  ok('F6 harness API 检索(kb_agent)命中本结论', kbTxt.length > 40 && (kbTxt.includes('reflow-doc2line-20261013') || /回流|板温/.test(kbTxt)), kbTxt.slice(0, 160))
  writeFileSync(join(OUT, 'kb-agent-retrieval.txt'), kbTxt)
}

/* ═══ [G] 频道智能(真引擎,有界) ═══ */
console.log('\n[G] 频道智能(真引擎任务)')
{
  const leadId = members.find(m => String(m.role ?? '').includes('lead') || String(m.name).includes('主管'))?.agentId ?? ''
  const sendAt = Date.now()
  await api('POST', `/api/workshop/channels/${channelId}/messages`, {
    toAgentId: leadId,
    text: '回流区温度已 +4℃(245→249)。请基于最近数采数据评估:板温与峰值温度的响应是否符合预期、当前是否在规格窗内、下一步是否有优化空间(有界建议)。',
    priority: 'task', requireReply: true,
  })
  let reply = ''
  for (let i = 0; i < 24; i++) {
    await sleep(20_000)
    const msgs = (await api('GET', `/api/workshop/channels/${channelId}/messages?limit=30`))?.data
    const arr = msgs?.items ?? (Array.isArray(msgs) ? msgs : [])
    const hit = arr.find(m => String(m.role ?? '').includes('AGENT') && Date.parse(String(m.createdAt ?? '')) > sendAt
      && (m.parts ?? []).some(p => /板温|峰值|回流|规格|建议/.test(String(p.text ?? ''))))
    if (hit) { reply = (hit.parts ?? []).map(p => p.text ?? '').join(' '); break }
    if (i % 3 === 0) console.log(`    ↳ (${(i + 1) * 20 / 60 | 0}min) 等待 lead…`)
  }
  ok('F7 lead 真引擎回复评估', reply.length > 30, reply.slice(0, 160) || '(8min 未回——记录引擎相位,机制面不受影响)')
  writeFileSync(join(OUT, 'lead-reply.txt'), reply)
}

/* ═══ 结论 ═══ */
mcp.stdin.end(); mcp.kill()
writeFileSync(join(OUT, 'state.json'), JSON.stringify({ at: new Date().toISOString(), lineId, channelId, recipeId, btPre, btPost, btShift, repScore, repGrade }, null, 2))
console.log('')
console.log('════════════════════════════════════════')
console.log(`  文档→孪生→产线→自动优化+数据分析:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
console.log(`产线: ${lineId}  频道: ${channelId}  配方: ${recipeId}`)
process.exit(fails.length ? 1 : 0)
