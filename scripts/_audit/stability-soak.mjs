#!/usr/bin/env node
/**
 * scripts/_audit/stability-soak.mjs —— 长时稳定性压测:持续 PLC 连接 + 周期下发 + Agent 优化。
 *
 * 拓扑:隔离平台 3466(全新 home,mcp.enabled)+ 模拟器 4016(cast-film)
 * 负载:SOAK_ROUNDS(默认 12)轮 × ~70s ≈ 14 分钟
 *   每轮:治理写 zone1(190↔195 交替,Δ5=stepLimit)→ param_read 回读校验 → 膜厚采样增长
 *   每 3 轮:optimization_explore 一次(Agent 优化任务,模口上/下交替)
 *   每轮:MCP rpc ping 保活探测
 * 通过判据:0 次连接类错误、回读全部命中、采样单调增长、MCP 进程全程存活、无未预期异常。
 * 用法:node scripts/_audit/stability-soak.mjs [--rounds N]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3466
const SIM_PORT = 4016
const ROUNDS = Number(process.argv.includes('--rounds') ? process.argv[process.argv.indexOf('--rounds') + 1] : process.env.SOAK_ROUNDS ?? 12)
const HOME = mkdtempSync(join(tmpdir(), 'aw-stability-soak-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4016')
let BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    return await r.json()
  }
  catch { return null }
}

/* ── 自举 ── */
console.log(`[自举] 平台 期望${AW_PORT} + 模拟器 ${SIM} · 负载 ${ROUNDS} 轮 × ~70s`)
for (const port of [AW_PORT, SIM_PORT]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true } }))
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'stability-soak-session-password-012345678' },
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
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
  ok('模拟器在跑', (await getJson(`${SIM}/api/plant/state`))?.data?.running === true)
}

/* ── MCP + 建线 + team ── */
const reg = await (async () => {
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'soak-admin', email: 'soak@awshop.local', password: 'soak-e2e-passw0rd' }) })
  return r.json()
})()
const TOKEN = reg?.data?.token
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
ok('MCP stdio 拉起 + admin', Boolean(TOKEN))

let lineId, productId, workerId
const dcw = {}, daq = {}
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const line = await call('aw_line_create', { name: `稳定性压测线` })
  lineId = line.data?.line?.id
  const product = await call('aw_product_create', { lineId, name: '压测产品' })
  productId = product.data?.product?.id
  const wantAct = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const wantSen = ['film-thickness']
  for (const dev of simDevices) {
    const exp = await getJson(`${SIM}/api/nodes/${dev.id}/export`)
    const items = exp?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of wantAct) {
      const sig = sigOf(id); if (!sig || dcw[id]) continue
      const item = items.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_dcw_create', { name: `压测-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: '压测执行器' })
      dcw[id] = r.data?.node?.id ?? r.data?.id
    }
    for (const id of wantSen) {
      const sig = sigOf(id); if (!sig || daq[id]) continue
      const item = items.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
      const r = await call('aw_daq_create', { name: `压测-${sig.name}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: '流延膜厚度测量(优化目标 goal)' })
      daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  await call('aw_daq_controller', { action: 'start' })
  const recipe = await call('aw_recipe_create', {
    productId, name: '压测基线配方', description: '稳定性压测基线(12+轮持续下发验证)',
    params: [
      { nodeId: dcw['zone1-sp'], value: 190, min: 150, max: 200 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
  })
  const start = await call('aw_line_start', { lineId, recipeId: recipe.data?.recipe?.id ?? recipe.data?.id })
  ok('压测线开跑', !start.isError)

  const inst = await call('aw_channel_template_instantiate', { id: 'chtpl-aml-optimization-default', name: '稳定性压测优化频道', toolProfile: 'aml_optimization', optimizationMode: 'exploration', controlPolicy: 'hitl_governed' })
  const channelId = inst.data?.channelId ?? inst.data?.id
  const agents = await call('aw_request', { method: 'GET', path: `/api/workshop/channels/${channelId}/agents` })
  workerId = (agents.data ?? []).find(a => a.role === 'worker')?.id
  for (const nodeId of Object.values(dcw)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'dcw', mode: 'auto' })
  for (const nodeId of Object.values(daq)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'daq', mode: 'auto' })
  ok('压测频道 + worker 全节点绑定', Boolean(workerId))
  var zoneParamId = (await call('aw_param_list', {})).data?.params?.find(p => p.nodeId === dcw['zone1-sp'])?.id
  ok('zone1 参数映射 id 就绪', Boolean(zoneParamId), String(zoneParamId))
}

/* ── 压测主循环 ── */
const stats = { writesOk: 0, writes429: 0, writes400: 0, readsOk: 0, readMismatch: 0, rpcErrors: 0, exploreOk: 0, exploreRejected: 0, pings: 0, samplesLast: 0, samplesGrew: 0 }
// 最新采样点时间戳(points 新→旧,首点=最新):比"条数增长"更可靠(条数会被 limit 封顶)
const latestSampleAt = async () => {
  const r = await call('aw_daq_samples', { id: daq['film-thickness'], bucketMs: 1000, limit: 5 })
  const pts = r.data?.points ?? []
  return pts.length ? Number(pts[0].at ?? 0) : 0
}
console.log(`\n[压测] 开始 ${ROUNDS} 轮(每轮 ~70s;奇数轮 190 / 偶数轮 195;每 3 轮一次 Agent 优化)\n`)
for (let round = 1; round <= ROUNDS; round++) {
  const target = round % 2 === 1 ? 190 : 195
  try {
    // 保活 + 平台探活
    await rpc('ping', {}, 10_000); stats.pings++
    if ((await getJson(`${BASE}/api/health`)) == null) throw new Error('平台健康探活失败')

    // 治理下发 + 回读
    const w = await call('aw_param_write', { id: zoneParamId, value: target })
    if (w.isError) {
      if (/429|间隔/.test(w.text)) stats.writes429++
      else if (/400|量程|超/.test(w.text)) stats.writes400++
      else throw new Error(`写入异常: ${w.text.slice(0, 120)}`)
    }
    else {
      stats.writesOk++
      await sleep(2500)
      const rd = await call('aw_param_read', { id: zoneParamId })
      const v = Number(rd.data?.read?.value)
      if (!rd.isError && Math.abs(v - target) <= 1.5) stats.readsOk++
      else stats.readMismatch++
    }

    // Agent 优化任务(每 3 轮)
    if (round % 3 === 0 && workerId) {
      const dir = round % 6 === 0 ? 'up' : 'down'
      const e = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'optimization_explore', args: { control_node_id: dcw['diegap-sp'], target_node_id: daq['film-thickness'], direction: dir, step: 0.03, settle_seconds: 12, hypothesis: `压测 R${round}:模口${dir === 'up' ? '上' : '下'}调(稳定性负载)` } }, 120_000)
      if (e.isError) stats.exploreRejected++
      else stats.exploreOk++
    }

    // 采样持续落库:最新点时间戳必须比上一轮前进
    const at = await latestSampleAt()
    if (at > stats.samplesLast) stats.samplesGrew++
    stats.samplesLast = Math.max(stats.samplesLast, at)

    const alive = mcp.exitCode === null && mcp.signalCode === null
    console.log(`  R${String(round).padStart(2, '0')} 目标=${target} 写=${w.isError ? (stats.writes429 > 0 && /429/.test(w.text) ? '429' : 'ERR') : 'OK'} 读命中=${stats.readsOk} 探索=${stats.exploreOk + stats.exploreRejected} 采样时刻=${at ? new Date(at).toISOString().slice(11, 19) : '-'} MCP存活=${alive}`)
    if (!alive) throw new Error('MCP 进程中途退出')
  }
  catch (err) {
    stats.rpcErrors++
    console.log(`  R${String(round).padStart(2, '0')} ✖ ${err.message}`)
  }
  if (round < ROUNDS) await sleep(70_000 - 0)
}

/* ── 判定 ── */
console.log('\n[判定]')
ok('0 次连接/RPC 级错误', stats.rpcErrors === 0, `rpcErrors=${stats.rpcErrors}`)
ok(`治理下发成功 ${stats.writesOk}/${ROUNDS}(429 限频 ${stats.writes429} 次属治理正常)`, stats.writesOk + stats.writes429 === ROUNDS && stats.writes400 === 0, JSON.stringify(stats))
ok(`回读全部命中(${stats.readsOk})且无量化外偏差`, stats.readMismatch === 0 && stats.readsOk === stats.writesOk, `mismatch=${stats.readMismatch}`)
ok('Agent 优化任务全程可执行(无失败)', stats.exploreRejected === 0 && (stats.exploreOk > 0), `ok=${stats.exploreOk} rejected=${stats.exploreRejected}`)
ok('数采采样持续落库(最新点时间戳逐轮前进)', stats.samplesGrew >= ROUNDS * 0.8, `前进轮数=${stats.samplesGrew}/${ROUNDS}`)
ok('MCP 连接全程存活', mcp.exitCode === null, `exitCode=${mcp.exitCode}`)
ok('压测平台健康收尾', (await getJson(`${BASE}/api/health`))?.data?.status === 'ok')

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
console.log(`═══ 稳定性压测:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
