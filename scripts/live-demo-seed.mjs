#!/usr/bin/env node
/**
 * 实机演示种子脚本(2026-10-28):为浏览器实机操作演示准备一套最小可作业场景。
 *
 * 前置:隔离实例已运行(AW_DEMO_BASE,生产构建 .output);本脚本只做供给,不起停实例。
 * 动作:admin 注册 → 建线(模拟)/DAQ/DCW/参数映射/产品/配方 → 开跑 → 数采网关启动
 *      → 建 AgentChannel(omp lead)+ worker(omp)→ worker 绑 DAQ(auto)/DCW(manual)
 * 输出:.omc/live-demo-state.json(演示后续步骤的 id/token 台账;不入库,.omc 已 ignore)
 */
import { writeFileSync } from 'node:fs'

const BASE = process.env.AW_DEMO_BASE ?? 'http://127.0.0.1:3415'
const STATE = process.env.AW_DEMO_STATE ?? '.omc/live-demo-state.json'

const sleep = ms => new Promise(r => setTimeout(r, ms))

let admin = ''
async function api(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? (await r.json())?.data ?? null : null
  }
  catch {
    return null
  }
}

const h = await health()
if (!h?.workshop || h.workshop !== 'ready') {
  console.error(`实例未就绪:${BASE} → ${JSON.stringify(h)}`)
  process.exit(1)
}
console.log(`实例就绪 version=${h.version}`)

const email = `live-demo-${Date.now()}@awshop.local`
const password = 'Demo#2026'
const reg = await api('POST', '/api/users/register', { name: '实机演示管理员', email, password })
admin = reg?.data?.token
if (!admin) {
  console.error(`admin 注册失败:${JSON.stringify(reg).slice(0, 300)}`)
  process.exit(1)
}
console.log('admin 注册/登录成功')

// ── 产线 + 设备 + 配方 ──
const line = (await api('POST', '/api/workshop/dcw/lines', {
  name: '实机演示-产线', simulated: true, controlMode: 'auto',
  description: '浏览器实机操作演示线:腔体温度监测 + 温度设定点位(模拟设备)',
})).data.line

const daqTemp = (await api('POST', '/api/workshop/daq', {
  name: '腔体温度', templateRef: 'temp-tc', driver: 'mock', lineId: line.id,
  unit: 'C', decimals: 2, min: 0, max: 100, intervalMs: 1000, publishIntervalMs: 0, enabled: true,
  semantics: '腔体温度测点;正常工艺窗口 50~70C',
})).data.node

const dcwSp = (await api('POST', '/api/workshop/dcw', {
  name: '温度设定', templateRef: 'temp-sp', driver: 'mock', lineId: line.id,
  unit: 'C', decimals: 2, min: 0, max: 100, enabled: true,
  holdIntervalMs: 0, readIntervalMs: 0, writeLockSeconds: 0, stepLimit: 5,
  driverConfig: { key: 'live-demo-temp-sp' },
  semantics: '腔体温度设定点;单步 <=4C,窗口 50~70C',
})).data.node

const params = (await api('GET', `/api/workshop/dcw/params?lineId=${line.id}`)).data.params ?? []
const pm = params.find(p => p.nodeId === dcwSp.id)
if (!pm) throw new Error(`参数映射不存在: node=${dcwSp.id}`)
await api('PATCH', `/api/workshop/dcw/params/${pm.id}`, { key: 'temp_sp', desc: '腔体温度设定值(C)', min: 0, max: 100 })

const product = (await api('POST', '/api/workshop/dcw/products', {
  name: '实机演示产品', lineId: line.id, description: '温度窗口 50~70C',
  paramLimits: { temp_sp: { min: 50, max: 70 } },
})).data.product

const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
  name: '实机演示配方', productId: product.id, description: '温度设定 50~70C,单步 4C',
  opIntervalMs: 0,
  params: [{ nodeId: dcwSp.id, value: 60, min: 50, max: 70, stepLimit: 4 }],
  daqWindows: [{ nodeId: daqTemp.id, min: 50, max: 70 }],
})).data.recipe

const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id })
if (start.status !== 200) throw new Error(`开线失败: ${JSON.stringify(start).slice(0, 300)}`)
const daqStart = await api('POST', '/api/workshop/daq/controller', { action: 'start' })
if (daqStart.status !== 200) throw new Error(`数采网关启动失败: ${daqStart.status}`)
console.log(`产线已开跑 line=${line.id} recipe=${recipe.id};数采网关已启动`)

// ── AgentChannel:lead + worker(真实 omp) ──
const MODEL = { provider: 'lm-studio', model: 'qwen3.5-9b-32k' }
const ch = (await api('POST', '/api/workshop/channels', {
  name: '实机演示-频道',
  lineId: line.id,
  scenarioPrompt: '实机演示频道:worker 绑定节点后按任务执行;手动模式所有下发需人工批准(在数控节点页批准)。',
  leadAgent: { name: '实机演示-线长', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools'] } },
})).data
const channelId = ch?.channelId
if (!channelId) throw new Error(`频道创建失败: ${JSON.stringify(ch).slice(0, 300)}`)
await api('PATCH', `/api/workshop/channels/${channelId}`, { llm: MODEL })
await api('PATCH', `/api/workshop/channels/${channelId}/execution-mode`, { mode: 'manual' })
await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
  mode: 'selected',
  tools: ['my_industrial_nodes', 'daq_query', 'recipe_trial', 'recipe_rollback', 'complete_task', 'report_progress']
    .map(n => ({ name: n, enabled: true })),
})

const workerRes = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
  name: '实机演示-作业员', harness: 'omp', role: 'worker',
  config: { rpcMode: 'rpc', args: ['--no-tools'] },
})
const worker = workerRes?.data?.agent ?? workerRes?.data
if (!worker?.id) throw new Error(`worker 创建失败: ${JSON.stringify(workerRes).slice(0, 300)}`)

async function bind(agentId, nodeId, kind, mode) {
  const created = await api('POST', '/api/workshop/agent-tools/bindings', { agentId, nodeId, kind, mode })
  const b = created?.data?.binding
  if (!b) throw new Error(`绑定失败(${kind}): ${JSON.stringify(created).slice(0, 300)}`)
  if (mode === 'auto' && b.mode !== 'auto') {
    const patched = await api('PATCH', `/api/workshop/agent-tools/bindings/${b.id}`, { mode: 'auto', confirm: true })
    return patched?.data?.binding ?? b
  }
  return b
}
const bDaq = await bind(worker.id, daqTemp.id, 'daq', 'auto')
const bDcw = await bind(worker.id, dcwSp.id, 'dcw', 'manual')
console.log(`worker=${worker.id} 绑定完成 daq=${bDaq.mode} dcw=${bDcw.mode}`)

// 等首批样本落库(演示页面打开即有实时值)
await sleep(12_000)

writeFileSync(STATE, `${JSON.stringify({
  at: new Date().toISOString(),
  base: BASE, version: h.version,
  admin: { email, password, token: admin },
  line: line.id, daq: daqTemp.id, dcw: dcwSp.id, recipe: recipe.id, product: product.id,
  channel: channelId, worker: worker.id,
  bindings: { daq: bDaq.id, dcw: bDcw.id },
}, null, 2)}\n`)
console.log(`种子完成 → ${STATE}`)
