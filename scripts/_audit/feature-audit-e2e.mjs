#!/usr/bin/env node
/**
 * scripts/_audit/feature-audit-e2e.mjs —— 产线功能面完整审计(设计逻辑正确性验证)。
 *
 * 覆盖:运维日志(ops-logs/手动记录) / 参数账本(journal) / 参数台账(param-ledger 三值对照)
 *   / 优化记录生命周期(open→judged-keep→lastGood;open→judged→rolled-back 回退执行)
 *   / 回退链(journal 锚点回退) / 配方管理(PATCH 版本化→versions→revert→mark-good→rollback-good→apply)
 *   / HITL(manual 绑定 → pending → 批准 → 执行) / AgentTeam(频道/任务结构/工具面)
 *
 * 自举:隔离平台 3465(全新 home,mcp.enabled 预置)+ 模拟器 4015(cast-film)。
 * 端口以锁文件实际值为准(aw start 顺延)。
 * 用法:node scripts/_audit/feature-audit-e2e.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3465
const SIM_PORT = 4015
const HOME = mkdtempSync(join(tmpdir(), 'aw-feature-audit-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4015')
let BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}

/* ── S0 · 自举 ── */
console.log(`[S0] 自举:平台 期望${AW_PORT} + 模拟器 ${SIM}`)
for (const port of [AW_PORT, SIM_PORT]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true, 'security.hitl_timeout_ms': 20000 } }))
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'feature-audit-e2e-session-password-01234' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let actualPort = AW_PORT
for (let i = 0; i < 20; i++) {
  await sleep(1500)
  try {
    const lock = JSON.parse(readFileSync(join(HOME, '.runtime', 'aw.lock'), 'utf8'))
    if (Number.isInteger(lock?.port)) { actualPort = lock.port; break }
  }
  catch { /* 等锁 */ }
}
BASE = `http://127.0.0.1:${actualPort}`
let up = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { up = true; break }
}
ok('平台健康门', up, `BASE=${BASE}`)
if (!up) { console.log(`═══ ${pass} PASS / ${fails.length + 1} FAIL ═══`); process.exit(1) }
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
  ok('模拟器+cast-film 在跑', (await getJson(`${SIM}/api/plant/state`))?.data?.running === true)
}

/* ── S1 · admin + MCP + 建线(最小闭环:zone1/线速/模口 + 膜厚)── */
const reg = await (async () => {
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'audit-admin', email: 'audit@awshop.local', password: 'audit-e2e-passw0rd' }) })
  return r.json()
})()
const TOKEN = reg?.data?.token
ok('admin 注册', Boolean(TOKEN))

const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_HOME: HOME, AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => { try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} })
const rpc = (method, params, timeoutMs = 90_000) => new Promise((res, rej) => {
  const id = nextId++
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`rpc 超时: ${method}`)) }, timeoutMs)
  pending.set(id, (m) => { clearTimeout(t); res(m) })
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const call = async (name, args = {}, timeoutMs) => {
  const res = await rpc('tools/call', { name, arguments: args }, timeoutMs)
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
}
/** 用户态 REST(区分于 MCP/Agent 路径) */
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}

console.log('[S1] 建线 + 优化频道 + worker 绑定')
let lineId, productId, workerId
const dcw = {}, daq = {}
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = await call('aw_line_create', { name: `功能审计线-${Date.now() % 100000}` })
  lineId = line.data?.line?.id
  const product = await call('aw_product_create', { lineId, name: '审计产品' })
  productId = product.data?.product?.id
  const wantAct = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const wantSen = ['melt-temp', 'film-thickness']
  const stepBy = { 'zone1-sp': 5, 'linespeed-sp': 2, 'diegap-sp': 0.03 }
  for (const dev of simDevices) {
    const exp = await getJson(`${SIM}/api/nodes/${dev.id}/export`)
    const items = exp?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of wantAct) {
      const sig = sigOf(id); if (!sig || dcw[id]) continue
      const item = items.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_dcw_create', { name: `${sig.name} 审计`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: stepBy[id], semantics: `审计执行器 ${sig.name}` })
      dcw[id] = r.data?.node?.id ?? r.data?.id
    }
    for (const id of wantSen) {
      const sig = sigOf(id); if (!sig || daq[id]) continue
      const item = items.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_daq_create', { name: `${sig.name} 审计`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: id === 'film-thickness' ? '流延膜厚度测量(优化目标 goal)' : '过程量' })
      daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  ok('建节点 3 DCW + 2 DAQ', wantAct.every(id => dcw[id]) && wantSen.every(id => daq[id]), JSON.stringify({ dcw, daq }))
  await call('aw_daq_controller', { action: 'start' })

  const inst = await call('aw_channel_template_instantiate', { id: 'chtpl-aml-optimization-default', name: `功能审计频道-${Date.now() % 100000}`, toolProfile: 'aml_optimization', optimizationMode: 'exploration', controlPolicy: 'hitl_governed' })
  const channelId = inst.data?.channelId ?? inst.data?.id
  const agents = await call('aw_request', { method: 'GET', path: `/api/workshop/channels/${channelId}/agents` })
  workerId = (agents.data ?? []).find(a => a.role === 'worker')?.id
  ok('优化频道 + worker 实例', Boolean(workerId))
  for (const nodeId of Object.values(dcw)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'dcw', mode: 'auto' })
  for (const nodeId of Object.values(daq)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'daq', mode: 'auto' })

  const recipe = await call('aw_recipe_create', {
    productId, name: '审计基线配方', description: '功能审计基线',
    params: [
      { nodeId: dcw['zone1-sp'], value: 195, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
    daqWindows: [{ nodeId: daq['film-thickness'], min: 30, max: 90 }],
  })
  const baselineRecipeId = recipe.data?.recipe?.id ?? recipe.data?.id
  const start = await call('aw_line_start', { lineId, recipeId: baselineRecipeId })
  ok('基线开跑', !start.isError && Boolean(baselineRecipeId), start.text.slice(0, 120))
  await sleep(66_000) // 配方下发锚定 60s 写入冷却,等满再探索(与 skill 指引一致)
}

/* ── S2 · Agent 探索写 → 优化记录生命周期 ── */
console.log('[S2] 优化记录生命周期:open → judged-keep(+lastGood) → 再写 → judge+rollback → 回退执行')
let openRecordId
{
  await sleep(20_000)
  const r1 = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'optimization_explore', args: { control_node_id: dcw['diegap-sp'], target_node_id: daq['film-thickness'], direction: 'down', step: 0.03, settle_seconds: 15, hypothesis: '审计:模口下调收敛膜厚' } }, 120_000)
  ok('A-探索步1(治理链写)执行', !r1.isError, r1.text.slice(0, 140))
  const opts = await api('GET', `/api/workshop/dcw/optimizations?lineId=${lineId}&limit=10`)
  const items = Array.isArray(opts.json?.data) ? opts.json.data : (opts.json?.data?.records ?? [])
  const open = (Array.isArray(items) ? items : []).filter(x => x.status === 'open')
  ok('优化记录 open 落库', open.length >= 1, JSON.stringify(items).slice(0, 150))
  openRecordId = open[0]?.id

  const j = await api('POST', `/api/workshop/dcw/optimizations/${openRecordId}/judge`, { verdict: 'keep', reason: '审计:响应符合预期,保留为基准' })
  ok('judge keep → judged-keep', j.status === 200 && /judged-keep|keep/.test(JSON.stringify(j.json)), JSON.stringify(j.json).slice(0, 120))

  await sleep(50_000) // 同节点 60s 写入间隔(步1 锚定)
  const r2 = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'optimization_explore', args: { control_node_id: dcw['diegap-sp'], target_node_id: daq['film-thickness'], direction: 'up', step: 0.03, settle_seconds: 15, hypothesis: '审计:模口回调(制造回退对象)' } }, 120_000)
  ok('A-探索步2(回退对象)', !r2.isError, r2.text.slice(0, 120))
  const opts2 = await api('GET', `/api/workshop/dcw/optimizations?lineId=${lineId}&limit=10`)
  const items2 = Array.isArray(opts2.json?.data) ? opts2.json.data : (opts2.json?.data?.records ?? [])
  let open2 = (Array.isArray(items2) ? items2 : []).find(x => x.status === 'open')
  for (let i = 0; i < 10 && !open2; i++) { await sleep(3000); const o = await api('GET', `/api/workshop/dcw/optimizations?lineId=${lineId}&limit=10`); const arr = Array.isArray(o.json?.data) ? o.json.data : (o.json?.data?.records ?? []); open2 = arr.find(x => x.status === 'open') }
  ok('第二个 open 记录(前一 open 被取代)', Boolean(open2?.id) && open2.id !== openRecordId, JSON.stringify((Array.isArray(items2) ? items2 : []).slice(0, 2)).slice(0, 150))
  if (!open2) throw new Error('未产生第二个 open 记录')

  const j2 = await api('POST', `/api/workshop/dcw/optimizations/${open2.id}/judge`, { verdict: 'rollback', reason: '审计:膜厚过冲,判定回退' })
  ok('judge rollback(判定与执行分离)', j2.status === 200)
  const rb = await api('POST', `/api/workshop/dcw/optimizations/${open2.id}/rollback`, {})
  ok('rollback 执行(202/200)', [200, 202].includes(rb.status), JSON.stringify(rb.json).slice(0, 120))
  await sleep(10_000)
  const opts3 = await api('GET', `/api/workshop/dcw/optimizations?lineId=${lineId}&limit=10`)
  const items3 = Array.isArray(opts3.json?.data) ? opts3.json.data : (opts3.json?.data?.records ?? [])
  const rolledBack = (Array.isArray(items3) ? items3 : []).find(x => x.id === open2.id)
  ok('记录置 rolled-back', rolledBack?.status === 'rolled-back', JSON.stringify(items3?.slice(0, 2)).slice(0, 150))
}

/* ── S3 · journal / param-ledger / ops-logs ── */
console.log('[S3] 账本与日志:journal 锚 / param-ledger 三值对照 / ops-logs 全类目')
{
  const jr = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=100`)
  const anchors = jr.json?.data?.anchors ?? []
  const sources = new Set(anchors.map(a => a.source))
  ok('journal 锚点含 agent+rollback 来源', anchors.length >= 3 && sources.has('agent') && sources.has('rollback'), `sources=${[...sources].join(',')} n=${anchors.length}`)

  const led = await api('GET', `/api/workshop/dcw/${dcw['diegap-sp']}/param-ledger`)
  const ledger = led.json?.data?.ledger ?? {}
  ok('param-ledger 三值对照(current/recipeTarget/lastGood+journal)', Boolean(ledger.current != null && Array.isArray(ledger.journal) && 'lastGood' in ledger), JSON.stringify({ current: ledger.current, journalLen: ledger.journal?.length }).slice(0, 120))

  const manual = await api('POST', '/api/workshop/ops-logs', { summary: '审计:人工巡检记录(功能审计 e2e)', lineId })
  ok('ops-logs 手动记录(manual)', manual.status === 200)
  const logs = await api('GET', `/api/workshop/ops-logs?lineId=${lineId}&limit=300`)
  const logsArr = logs.json?.data?.logs ?? []
  const actions = new Set(logsArr.map(l => l.action))
  ok('ops-logs 覆盖 dcw.write/optimization/recipe 动作', logsArr.length >= 5 && [...actions].some(a => String(a).startsWith('dcw.write')) && [...actions].some(a => String(a).startsWith('optimization.')), `n=${logsArr.length} actions=${[...actions].slice(0, 8).join(',')}`)
  ok('ops-logs 含 manual 人工记录', logsArr.some(l => l.kind === 'manual'))
}

/* ── S4 · 配方管理:版本化 / revert / mark-good / rollback-good / apply ── */
console.log('[S4] 配方管理:版本化 → revert → 基准恢复 → 一键下发')
{
  const mk = await call('aw_recipe_create', {
    productId, name: '审计配方(版本链)', description: '功能审计:版本链验证',
    params: [
      { nodeId: dcw['zone1-sp'], value: 195, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 96, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 0.97, min: 0.85, max: 1.15 },
    ],
  })
  const rid = mk.data?.recipe?.id ?? mk.data?.id
  ok('审计配方创建', !mk.isError && rid)

  await call('aw_recipe_update', { id: rid, description: '功能审计:v2 调整线速与模口', params: [
    { nodeId: dcw['zone1-sp'], value: 195, min: 190, max: 225 },
    { nodeId: dcw['linespeed-sp'], value: 98, min: 85, max: 110 },
    { nodeId: dcw['diegap-sp'], value: 0.94, min: 0.85, max: 1.15 },
  ] })
  const versions = await api('GET', `/api/workshop/dcw/recipes/${rid}/versions`)
  const vlist = versions.json?.data?.versions ?? versions.json?.data ?? []
  ok('params 变更版本化(versions ≥2)', Array.isArray(vlist) && vlist.length >= 2, `n=${Array.isArray(vlist) ? vlist.length : '?'}`)

  const revert = await api('POST', `/api/workshop/dcw/recipes/${rid}/revert`, { version: 1, reason: '审计:回退到 v1 定义' })
  ok('revert 到 v1(非破坏,生成新版本)', revert.status === 200)
  const list2 = await api('GET', '/api/workshop/dcw/recipes')
  const r2 = (list2.json?.data?.recipes ?? []).find(x => x.id === rid)
  const dg2 = (r2?.params ?? []).find(p => p.nodeId === dcw['diegap-sp'])?.value
  ok('revert 后参数回到 v1(模口 0.97)', Number(dg2) === 0.97, `模口=${dg2}`)

  await call('aw_line_stop', { lineId }) // 闭合基线批次(范式:闭合批才可 mark-good)
  await sleep(3000)
  const runs = (await call('aw_recipe_list', { productId })).data?.runs ?? []
  const closed = runs.filter(x => x.endedAt).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  if (closed[0]?.id) {
    const mg = await api('POST', `/api/workshop/dcw/recipes/${rid}/mark-good`, { runId: closed[0].id })
    ok('mark-good 已知良好批次', mg.status === 200)
    const rg = await api('POST', `/api/workshop/dcw/recipes/${rid}/rollback-good`, {})
    const outcomes = rg.json?.data?.outcomes ?? []
    ok('rollback-good 基准恢复(逐参数下发 lastGood 快照)', rg.status === 200 && outcomes.length >= 3 && outcomes.every(o => o.ok), JSON.stringify(outcomes).slice(0, 150))
  }
  else ok('mark-good/rollback-good(无已闭合批次,跳过)', false, '无闭合批次')

  const apply = await api('POST', `/api/workshop/dcw/recipes/${rid}/apply`, {})
  ok('apply 一键下发(建批次+写 PLC)', apply.status === 200 && Boolean(apply.json?.data?.run ?? apply.json?.data?.recipeRun ?? apply.json?.data), JSON.stringify(apply.json?.data ?? apply.json).slice(0, 120))
}

/* ── S5 · HITL:manual 绑定 → pending → 批准 → 执行 ── */
console.log('[S5] HITL:manual 绑定的 dcw_control 走审批(超时 20s 已预置)')
{
  await sleep(63_000) // S4 的 rollback-good/apply 刚写过 zone1:HITL 批准不豁免 60s 联锁,须等衰减
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: workerId, nodeId: dcw['zone1-sp'], kind: 'dcw', mode: 'manual' })
  ok('manual 模式绑定', bind.status === 200)
  await sleep(1000)
  const invokePromise = call('aw_agent_tool_invoke', { agentId: workerId, tool: 'dcw_control', args: { node_id: dcw['zone1-sp'], value: 198, hypothesis: 'HITL 审批:审计写入' } }, 60_000)
  let approved = false
  for (let i = 0; i < 10 && !approved; i++) {
    await sleep(1500)
    const pend = await api('GET', '/api/workshop/agent-tools/approvals')
    const list = pend.json?.data?.approvals ?? pend.json?.data ?? []
    const mine = (Array.isArray(list) ? list : []).find(a => a.status === 'pending')
    if (mine?.id) {
      const dec = await api('POST', `/api/workshop/agent-tools/approvals/${mine.id}/decide`, { approved: true })
      approved = dec.status === 200
    }
  }
  const invokeRes = await invokePromise
  ok('审批通过后写入执行(HITL 回路闭合)', approved && !invokeRes.isError, JSON.stringify({ approved, text: invokeRes.text.slice(0, 120) }))
  const readAfter = await call('aw_dcw_read', { id: dcw['zone1-sp'] })
  ok('HITL 写入真实落 PLC(≈198)', Math.abs(Number(readAfter.data?.read?.value) - 198) <= 1.5, `值=${readAfter.data?.read?.value}`)
}

/* ── S6 · AgentTeam 任务结构(不下发 LLM 执行)── */
console.log('[S6] AgentTeam:频道任务结构(无 lead 调度,验证落库)')
{
  const ch = await call('aw_channel_create', { name: `审计无lead频道-${Date.now() % 100000}` })
  const channelId = ch.data?.channelId ?? ch.data?.id
  const t = await api('POST', `/api/workshop/channels/${channelId}/tasks`, { title: '审计任务(守卫验证)', parts: [{ text: '无 lead 频道应被 400 拒(设计守卫)' }] })
  ok('无 lead 频道建任务被 400 拒(NO_LEAD_AGENT 设计守卫)', t.status === 400 && /NO_LEAD_AGENT|lead/i.test(JSON.stringify(t.json)), `HTTP ${t.status} ${JSON.stringify(t.json).slice(0, 100)}`)
  const q = await api('GET', `/api/workshop/channels/${channelId}/queue`)
  ok('无 lead 频道队列总览同样 400(口径一致)', q.status === 400)
}

/* ── 清场 ── */
console.log('[清场]')
mcp.stdin.end(); mcp.kill()
for (const port of [actualPort, SIM_PORT]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}
await sleep(1200)
if (!process.argv.includes('--keep')) { try { rmSync(HOME, { recursive: true, force: true }) } catch {} }

console.log('')
console.log(`═══ 功能审计验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
