#!/usr/bin/env node
/**
 * scripts/_audit/recipe-save-e2e.mjs —— 「干净环境 + team 优化 + 按目标保存最佳配方」全链验收。
 *
 * 前提:已关闭所有项目进程(用户要求干净环境)。本脚本自举:
 *   隔离平台 3463(全新 AW_HOME,预置 mcp.enabled)+ 模拟器 4014(cast-film-physics)
 *   → admin 注册 → MCP(stdio)为唯一操作手
 *   → 建线(3 DCW + 2 DAQ,export 取规约)→ 基线配方(带 description)开跑
 *   → 建 team(omp lead+worker)+ 节点绑定
 *   → 目标A(膜厚 50μm)探索收敛 → 停线闭合批次 → 保存配方A(目标描述)+ mark-good
 *   → 目标B(膜厚 52μm)以配方A开跑再探索 → 保存配方B(不同目标不同描述)
 *   → aw_recipe_update 改基线描述 → aw_recipe_list 交叉验证(描述/参数/批次数)
 *
 * 用法:node scripts/_audit/recipe-save-e2e.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3463
const SIM_PORT = 4014
const HOME = mkdtempSync(join(tmpdir(), 'aw-recipe-save-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4014')
// BASE 以锁文件回写的实际端口为准(aw start 被占端口会顺延 +1)
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
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    return await r.json()
  }
  catch { return null }
}

/* ── S0 · 干净环境自举 ── */
console.log(`[S0] 干净环境:平台 期望${AW_PORT}(全新 home,预置 mcp.enabled;实际端口以锁文件为准)+ 模拟器 ${SIM}`)
// 预清残留:端口被上一轮占用会导致 aw start 顺延换端口
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
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'recipe-save-e2e-session-password-0123456' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
// 从锁文件读实际端口(顺延后回写);读不到再退回期望端口探测
let actualPort = AW_PORT
for (let i = 0; i < 20; i++) {
  await sleep(1500)
  try {
    const lock = JSON.parse(readFileSync(join(HOME, '.runtime', 'aw.lock'), 'utf8'))
    if (Number.isInteger(lock?.port)) { actualPort = lock.port; break }
  }
  catch { /* 锁未写好,继续等 */ }
}
BASE = `http://127.0.0.1:${actualPort}`
console.log(`  ↳ 实例实际端口 = ${actualPort}${actualPort !== AW_PORT ? '(发生顺延)' : ''}`)
let platformUp = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { platformUp = true; break }
}
ok('平台健康门通过', platformUp, `BASE=${BASE} 日志 ${join(HOME, 'instance.log')}`)
if (!platformUp) { console.log(`═══ ${pass} PASS / ${fails.length + 1} FAIL ═══`); process.exit(1) }
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  const simInfo = await ensureSimulator({ log: m => console.log(`  [sim] ${m}`) })
  ok('模拟器拉起(影子实例)', Boolean(simInfo?.dir), JSON.stringify(simInfo).slice(0, 100))
  await applyPreset('cast-film-physics')
  const st = await getJson(`${SIM}/api/plant/state`)
  ok('cast-film 物理引擎在跑', st?.data?.running === true)
}

/* ── S1 · admin + MCP(stdio)── */
const reg = await (async () => {
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'recipe-e2e-admin', email: 'recipe-e2e@awshop.local', password: 'recipe-e2e-passw0rd' }) })
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

/* ── S2 · 建线(export 规约)→ 基线配方(带描述)开跑 ── */
console.log('[S2] 建线 + 基线配方(带 description 元字段)开跑')
let lineId, productId, baselineRecipeId
const dcw = {}, daq = {}
{
  const st = await call('aw_status')
  ok('aw_status(发现+鉴权+开关)', !st.isError && st.data?.port === AW_PORT && st.data?.mcpEnabled === true, st.text.slice(0, 120))

  const WANT_ACT = ['zone1-sp', 'linespeed-sp', 'diegap-sp']
  const WANT_SEN = ['melt-temp', 'film-thickness']
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []

  const line = await call('aw_line_create', { name: `配方保存验收线-${Date.now() % 100000}` })
  lineId = line.data?.line?.id
  ok('aw_line_create', !line.isError && lineId)
  const product = await call('aw_product_create', { lineId, name: '配方保存验收产品' })
  productId = product.data?.product?.id
  ok('aw_product_create', !product.isError && productId)

  const stepBy = { 'zone1-sp': 5, 'linespeed-sp': 2, 'diegap-sp': 0.03 }
  for (const dev of simDevices) {
    const exp = await getJson(`${SIM}/api/nodes/${dev.id}/export`)
    const items = exp?.data?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    for (const id of WANT_ACT) {
      const sig = sigOf(id)
      if (!sig || dcw[id]) continue
      const item = items.find(i => i.signal === sig.name)
      if (!item?.driverConfig) continue
      const r = await call('aw_dcw_create', {
        name: `${sig.name} 验收`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig,
        unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0,
        stepLimit: stepBy[id], semantics: `cast-film 执行器 ${sig.name}(${sig.unit}),真实 ${dev.protocol} 链路`,
      })
      dcw[id] = r.data?.node?.id ?? r.data?.id
    }
    for (const id of WANT_SEN) {
      const sig = sigOf(id)
      if (!sig || daq[id]) continue
      const item = items.find(i => i.signal === sig.name)
      if (!item?.driverConfig) continue
      const r = await call('aw_daq_create', {
        name: `${sig.name} 验收`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig,
        unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000,
        semantics: id === 'film-thickness'
          ? '流延膜厚度测量(优化目标 goal,单位 μm;厚度质量输出)'
          : `cast-film 过程量 ${sig.name}(${sig.unit}),真实 ${dev.protocol} 链路`,
      })
      daq[id] = r.data?.node?.id ?? r.data?.id
    }
  }
  ok('aw_dcw_create ×3(zone1/线速/模口)', WANT_ACT.every(id => Boolean(dcw[id])), JSON.stringify(dcw))
  ok('aw_daq_create ×2(熔温/膜厚)', WANT_SEN.every(id => Boolean(daq[id])), JSON.stringify(daq))
  ok('aw_daq_controller start', !(await call('aw_daq_controller', { action: 'start' })).isError)

  const recipe = await call('aw_recipe_create', {
    productId, name: '基线配方(标定工况)',
    description: '基线:出厂标定工况(螺杆150/线速95/模口1.00,膜厚≈55μm);作为多目标优化的共同起点',
    params: [
      { nodeId: dcw['zone1-sp'], value: 195, min: 190, max: 225 },
      { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
      { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
    ],
    daqWindows: [{ nodeId: daq['film-thickness'], min: 30, max: 90 }],
  })
  baselineRecipeId = recipe.data?.recipe?.id ?? recipe.data?.id
  ok('基线配方创建(带 description)', !recipe.isError && baselineRecipeId && Boolean(recipe.data?.recipe?.description ?? recipe.data?.description), recipe.text.slice(0, 140))

  const start = await call('aw_line_start', { lineId, recipeId: baselineRecipeId })
  ok('基线开跑(逐参数下发)', !start.isError, start.text.slice(0, 140))
}

/* ── S3 · 优化频道(模板自带 aml profile)+ team + 绑定 ── */
console.log('[S3] 优化频道(aml_optimization)+ worker 绑定')
let workerId
{
  const inst = await call('aw_channel_template_instantiate', { id: 'chtpl-aml-optimization-default', name: `配方保存优化频道-${Date.now() % 100000}`, toolProfile: 'aml_optimization', optimizationMode: 'exploration', controlPolicy: 'hitl_governed' })
  const channelId = inst.data?.channelId ?? inst.data?.id
  ok('模板实例化优化频道(exploration)', !inst.isError && channelId, inst.text.slice(0, 140))
  const agents = await call('aw_request', { method: 'GET', path: `/api/workshop/channels/${channelId}/agents` })
  workerId = (agents.data ?? []).find(a => a.role === 'worker')?.id
  ok('模板自带 worker 实例', Boolean(workerId), agents.text.slice(0, 140))
  if (workerId) {
    for (const nodeId of Object.values(dcw)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'dcw', mode: 'auto' })
    for (const nodeId of Object.values(daq)) await call('aw_agent_tool_bind', { agentId: workerId, nodeId, kind: 'daq', mode: 'auto' })
    const probe = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'my_industrial_nodes', args: {} }, 60_000)
    ok('worker 工具面绑定生效(my_industrial_nodes 可见节点)', !probe.isError && JSON.stringify(probe.data ?? probe.text).includes('验收'), probe.text.slice(0, 140))
  }
}

/* ── S4 · 探索收敛 + 保存(目标A:50μm)── */
const thicknessMean = async () => {
  const r = await call('aw_daq_samples', { id: daq['film-thickness'], bucketMs: 1000, limit: 20 })
  const pts = (r.data?.points ?? []).map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) })).filter(p => Number.isFinite(p.v)).sort((a, b) => a.at - b.at)
  if (!pts.length) return null
  return pts.reduce((a, b) => a + b.v, 0) / pts.length
}
const exploreOnce = async (key, node, dir, step, h, target) => {
  const gains = { 'linespeed-sp': -0.568, 'diegap-sp': 54, 'zone1-sp': 0 }
  const units = { 'linespeed-sp': 'm/min', 'diegap-sp': 'mm', 'zone1-sp': '℃' }
  return call('aw_agent_tool_invoke', {
    agentId: workerId, tool: 'optimization_explore',
    args: {
      control_node_id: node, target_node_id: daq['film-thickness'],
      direction: dir, step, settle_seconds: 15,
      hypothesis: `贪心探索(${key}): h=${h?.toFixed(2)}μm → 目标 ${target}μm,预计 ${(gains[key] * step).toFixed(2)}μm(增益 ${gains[key]}μm/${units[key]}×限步${step})`,
    },
  }, 120_000)
}
const greedy = async (target, knobs) => {
  const traj = []
  for (let i = 1; i <= 8; i++) {
    const h = await thicknessMean()
    traj.push(h)
    if (h != null && Math.abs(h - target) <= 1.2) { console.log(`  ↳ 第 ${i - 1} 步入带: ${h?.toFixed(2)}μm`); break }
    const err = target - (h ?? target)
    const ranked = knobs
      .map(k => ({ ...k, move: Math.abs(k.gain) * k.limit, dir: Math.sign(err) * Math.sign(k.gain) >= 0 ? 'up' : 'down' }))
      .sort((a, b) => b.move - a.move)
    const pick = ranked[0]
    await sleep(25_000)
    const r = await exploreOnce(pick.key, pick.node, pick.dir, pick.limit, h, target)
    if (r.isError) { console.log(`  ⚠ ${pick.key}#${i} 被拒: ${r.text.split('\n')[0].slice(0, 100)}`); pick.gain *= 0.3; continue }
    console.log(`  ↳ [${pick.key}#${i}] ${pick.dir} ${pick.limit} · h≈${(await thicknessMean())?.toFixed(2) ?? '?'}μm`)
    await sleep(20_000)
  }
  return traj
}

console.log('[S4] 目标A:膜厚 → 50μm(探索式,治理链写入)')
let run1Id, recipeAId
{
  let h0 = null
  for (let i = 0; i < 15 && h0 == null; i++) { h0 = await thicknessMean(); if (h0 == null) await sleep(2000) }
  ok('目标A起点读数可得(等首批采样落库)', h0 != null, `h0=${h0}`)
  const traj = await greedy(50, [
    { key: 'linespeed-sp', node: dcw['linespeed-sp'], limit: 2, gain: -0.568 },
    { key: 'diegap-sp', node: dcw['diegap-sp'], limit: 0.03, gain: 54 },
  ])
  const hEnd = await thicknessMean()
  ok('目标A收敛入带(50±1.2)', hEnd != null && Math.abs(hEnd - 50) <= 1.2, `轨迹=${JSON.stringify(traj.map(x => x?.toFixed(1)))} 终值=${hEnd?.toFixed(2)}`)

  await call('aw_line_stop', { lineId })
  const listNow = await call('aw_recipe_list', { productId })
  const closed = (listNow.data?.runs ?? []).filter(x => x.endedAt && x.recipeId === baselineRecipeId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  run1Id = closed[0]?.id
  ok('A 批次闭合(runId 可考)', Boolean(run1Id), JSON.stringify(closed[0] ?? {}).slice(0, 120))

  const snap = await call('aw_dcw_snapshot')
  const nodeById = new Map((snap.data?.nodes ?? []).map(n => [n.id, n]))
  const paramsA = ['zone1-sp', 'linespeed-sp', 'diegap-sp'].map((k) => {
    const n = nodeById.get(dcw[k])
    return { nodeId: dcw[k], value: Number(n?.value ?? n?.readValue ?? 0), min: n?.min, max: n?.max }
  })
  const descA = `目标A:膜厚 50±1.2μm;探索收敛设定(线速/模口按增益方向步进);螺杆 ${paramsA[0].value}℃、线速 ${paramsA[1].value} m/min、模口 ${paramsA[2].value} mm;2026-09-27 团队探索收敛并标记良好批次`
  const saveA = await call('aw_recipe_create', { productId, name: '最佳配方-目标A(膜厚50μm)', description: descA, params: paramsA, daqWindows: [{ nodeId: daq['film-thickness'], min: 47, max: 53 }] })
  recipeAId = saveA.data?.recipe?.id ?? saveA.data?.id
  ok('A4a 保存配方A(带目标描述)', !saveA.isError && recipeAId && String(saveA.data?.recipe?.description ?? saveA.data?.description ?? '').includes('50'), saveA.text.slice(0, 160))
  if (run1Id && recipeAId) {
    const mg = await call('aw_recipe_mark_good', { id: recipeAId, runId: run1Id })
    ok('A4b mark-good(收敛批=已知良好)', !mg.isError, mg.text.slice(0, 120))
  }
}

/* ── S5 · 目标B:52μm(以配方A开跑)── */
console.log('[S5] 目标B:膜厚 → 52μm(以配方A开跑再探索)')
let recipeBId
{
  const start = await call('aw_line_start', { lineId, recipeId: recipeAId })
  ok('以配方A开跑', !start.isError, start.text.slice(0, 120))
  await sleep(30_000)
  const traj = await greedy(52, [
    { key: 'diegap-sp', node: dcw['diegap-sp'], limit: 0.03, gain: 54 },
    { key: 'linespeed-sp', node: dcw['linespeed-sp'], limit: 2, gain: -0.568 },
  ])
  const hEnd = await thicknessMean()
  ok('目标B收敛入带(52±1.2)', hEnd != null && Math.abs(hEnd - 52) <= 1.2, `轨迹=${JSON.stringify(traj.map(x => x?.toFixed(1)))} 终值=${hEnd?.toFixed(2)}`)

  await call('aw_line_stop', { lineId })
  const listNow = await call('aw_recipe_list', { productId })
  const closed = (listNow.data?.runs ?? []).filter(x => x.endedAt && x.recipeId === recipeAId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  const run2Id = closed[0]?.id
  const snap = await call('aw_dcw_snapshot')
  const nodeById = new Map((snap.data?.nodes ?? []).map(n => [n.id, n]))
  const paramsB = ['zone1-sp', 'linespeed-sp', 'diegap-sp'].map((k) => {
    const n = nodeById.get(dcw[k])
    return { nodeId: dcw[k], value: Number(n?.value ?? n?.readValue ?? 0), min: n?.min, max: n?.max }
  })
  const descB = `目标B:膜厚 52±1.2μm;在目标A配方基础上放宽膜厚换取速度余量;线速 ${paramsB[1].value} m/min、模口 ${paramsB[2].value} mm;2026-09-27 团队探索收敛并标记良好批次`
  const saveB = await call('aw_recipe_create', { productId, name: '最佳配方-目标B(膜厚52μm)', description: descB, params: paramsB, daqWindows: [{ nodeId: daq['film-thickness'], min: 49, max: 55 }] })
  recipeBId = saveB.data?.recipe?.id ?? saveB.data?.id
  ok('S5 保存配方B(不同目标不同描述)', !saveB.isError && recipeBId && String(saveB.data?.recipe?.description ?? saveB.data?.description ?? '').includes('52'), saveB.text.slice(0, 160))
  if (run2Id && recipeBId) {
    const mg = await call('aw_recipe_mark_good', { id: recipeBId, runId: run2Id })
    ok('mark-good(目标B收敛批)', !mg.isError, mg.text.slice(0, 100))
  }
}

/* ── S6 · 交叉验证:多目标多配方 + 描述可编辑 ── */
console.log('[S6] 交叉验证:不同目标不同配方、描述元字段可查可改')
{
  const list = await call('aw_recipe_list', { productId })
  const recipes = list.data?.recipes ?? []
  ok('配方 ≥3(基线+A+B)', recipes.length >= 3, `实际 ${recipes.length}`)
  const byName = new Map(recipes.map(r => [r.name, r]))
  const ra = byName.get('最佳配方-目标A(膜厚50μm)')
  const rb = byName.get('最佳配方-目标B(膜厚52μm)')
  ok('配方A/B 都带目标描述', Boolean(ra?.description?.includes('50') && rb?.description?.includes('52')), JSON.stringify([ra?.description, rb?.description]).slice(0, 200))
  const pA = JSON.stringify((ra?.params ?? []).map(p => p.value))
  const pB = JSON.stringify((rb?.params ?? []).map(p => p.value))
  ok('A/B 参数确实不同(不同目标不同工况)', pA !== pB, `${pA} vs ${pB}`)
  ok('A/B 各有 lastGoodRunId', Boolean(ra?.lastGoodRunId && rb?.lastGoodRunId), JSON.stringify({ a: ra?.lastGoodRunId, b: rb?.lastGoodRunId }))
  const upd = await call('aw_recipe_update', { id: baselineRecipeId, description: '基线(已归档):出厂标定工况;多目标优化的共同起点,已被目标A/B最佳配方取代' })
  ok('aw_recipe_update 改基线描述(PATCH 生效)', !upd.isError, upd.text.slice(0, 120))
  const list2 = await call('aw_recipe_list', { productId })
  const baseline = (list2.data?.recipes ?? []).find(r => r.id === baselineRecipeId)
  ok('更新后的描述可查', baseline?.description?.includes('已归档'), baseline?.description?.slice(0, 80))
}

/* ── 清场 ── */
console.log('[清场] 终止 MCP/平台/模拟器')
mcp.stdin.end(); mcp.kill()
for (const port of [AW_PORT, SIM_PORT]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}
await sleep(1500)
if (!process.argv.includes('--keep')) { try { rmSync(HOME, { recursive: true, force: true }) } catch {} }

console.log('')
console.log(`═══ 配方保存全链验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
