#!/usr/bin/env node
/**
 * 真实激励采样(PLC 模拟器):起线跑 3 个批次,经模拟器 REST 手动改保压设定制造阶跃,
 * 让注塑产线产生真实的 注射压力→克重 动态数据(供 AML 训练切分)。
 * 运行:AW_BASE/AW_TOKEN/SIM_BASE node scripts/e2e-plc-excite.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3111'
const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4050'
const LINE = process.env.LINE_ID ?? 'ln-4acdb2c8'
const RECIPE = process.env.RECIPE_ID ?? 'rc-252ed08e'
process.env.NO_PROXY = '127.0.0.1,localhost'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let token = ''
async function api(method, path, body, base = BASE) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return res.json().catch(() => ({}))
}
async function sim(method, path, body) {
  const res = await fetch(SIM + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return res.json().catch(() => ({}))
}

token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' }))?.data?.token
if (!token) {
  console.error('login fail')
  process.exit(1)
}

const nodes = (await sim('GET', '/api/nodes'))?.data ?? []
const holdDev = nodes.find(n => (n.signals ?? []).some(s => s.id === 'mold-temp-sp'))
if (!holdDev) {
  console.error('模拟器无 hold-pressure-sp 信号')
  process.exit(1)
}

const state = (await api('GET', '/api/workshop/dcw'))?.data?.lineStates?.[LINE]
console.log('lineState=', JSON.stringify(state))
const RUN_MS = Number(process.env.RUN_MS ?? 300_000)
const levels = [45, 62, 54]

for (let i = 0; i < 3; i++) {
  const sp = levels[i]
  // 先停旧采集批次(关 run 不停线;start 的 409 = 采集仍在跑)
  const preStop = await api('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {})
  console.log(`[run ${i + 1}] 预停=${preStop.code ?? 'ok'};模拟器模温预设 ${sp}bar,起线…`)
  await sim('POST', `/api/nodes/${holdDev.id}/signals/mold-temp-sp/manual`, { value: sp })
  await sleep(3000)
  const start = await api('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: RECIPE })
  const runId = start?.data?.run?.id
  console.log(`  start=${start.code ?? start.message} run=${runId}`)
  if (!runId) {
    continue
  }
  // 中途再阶跃一次,丰富 run 内动态
  await sleep(Math.floor(RUN_MS / 2))
  const sp2 = sp + 5
  await sim('POST', `/api/nodes/${holdDev.id}/signals/mold-temp-sp/manual`, { value: sp2 })
  console.log(`  中途阶跃 → ${sp2}bar`)
  await sleep(Math.floor(RUN_MS / 2))
  await sim('POST', `/api/nodes/${holdDev.id}/signals/mold-temp-sp/manual`, { value: sp })
  const stop = await api('POST', `/api/workshop/dcw/lines/${LINE}/stop`, {})
  console.log(`  stop=${stop.code ?? stop.message}`)
}
console.log('excite done')
