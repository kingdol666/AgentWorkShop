#!/usr/bin/env node
/**
 * scripts/_audit/aw-mcp-live-e2e.mjs —— aw 工业 MCP 的真实实例端到端验收。
 *
 * 场景:起一个**完全隔离**的 home 模式实例(全新 AW_HOME,不碰真实库),
 * 不给 AW_BASE_URL/AW_PORT,然后拉起 stdio MCP server 子进程 —— 验证它能:
 *   A. 从锁文件 .runtime/aw.lock **自动发现**实例真实端口
 *   B. JSON-RCP 面:initialize / tools/list / aw_status / 懒登录 / 关键工具调用
 *   C. 全链业务:建产线 → 建产品 → 建 DCW/DAQ 节点(回路驱动)→ 建参数映射查证
 *      → 配方开跑 → 写读回环 → 数采采样 → 建优化频道 → 模板列表 → 插件清单
 *   D. 守卫:aw_request 拒绝非 /api/ 路径
 *
 * 隔离纪律:AW_MODE=home + AW_HOME=临时目录;端口 3461;结束 taskkill //T 清场。
 * 用法:node scripts/_audit/aw-mcp-live-e2e.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = 3461
const KEEP = process.argv.includes('--keep')
const HOME = mkdtempSync(join(tmpdir(), 'aw-mcp-live-'))
const BASE = `http://127.0.0.1:${PORT}`
const MCP_SCRIPT = join(REPO, 'mcp', 'aw-mcp-server.mjs')

// 预置系统设置:mcp.enabled=true(等价于用户在「系统设置 → MCP 集成」打开开关)
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true } }))

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
    return (await r.json())?.data?.status === 'ok'
  }
  catch { return false }
}

// ── S0:起隔离实例(真分离,健康门 60s)─────────────────────
console.log(`[S0] 启动隔离实例(port=${PORT}, home=${HOME})`)
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(PORT)], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      AW_MODE: 'home',
      AW_HOME: HOME,
      NUXT_SESSION_PASSWORD: 'aw-mcp-live-e2e-session-password-0123456789',
    },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  closeSync(out)
  child.unref()
}
let up = false
for (let i = 0; i < 30; i++) {
  await sleep(2000)
  if (await health()) { up = true; break }
}
ok('实例健康门通过', up, `看日志 ${join(HOME, 'instance.log')}`)
if (!up) {
  console.log(FAIL_SUMMARY())
  process.exit(1)
}

// ── S1:注册 admin(隔离实例首注册即 admin)──────────────────
console.log('[S1] 注册管理员')
{
  const r = await fetch(`${BASE}/api/users/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mcp-e2e-admin', email: 'mcp-e2e@awshop.local', password: 'mcp-e2e-passw0rd' }),
  })
  const j = await r.json().catch(() => null)
  ok('admin 注册成功', r.ok && j?.data?.token, `HTTP ${r.status} ${JSON.stringify(j?.message ?? '')}`)
}

// ── S2:拉起 stdio MCP 子进程(零端口提示:不给 AW_BASE_URL/AW_PORT)──
console.log('[S2] 拉起 MCP stdio 子进程(无任何端口提示,靠锁文件自发现)')
const mcp = spawn(process.execPath, [MCP_SCRIPT], {
  cwd: REPO,
  env: {
    ...process.env,
    NO_PROXY: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    AW_MODE: 'home',
    AW_HOME: HOME, // 只给配置根 —— 端口发现完全交给锁文件
    AW_EMAIL: 'mcp-e2e@awshop.local',
    AW_PASSWORD: 'mcp-e2e-passw0rd',
    // 刻意不给:AW_BASE_URL / AW_PORT / AW_TOKEN
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map()
let nextId = 1
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line)
    if (msg?.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  catch { /* 忽略非 JSON 行 */ }
})
mcp.stderr.on('data', () => {})
function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++
  return new Promise((resolveRpc, rejectRpc) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectRpc(new Error(`rpc 超时: ${method}`))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolveRpc(msg)
    })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const call = async (name, args = {}, timeoutMs) => {
  const res = await rpc('tools/call', { name, arguments: args }, timeoutMs)
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

// ── S3:协议面 ────────────────────────────────────────────
console.log('[S3] 协议面')
{
  const init = await rpc('initialize', { protocolVersion: '2025-03-26' })
  ok('initialize 握手', init?.result?.serverInfo?.name === 'aw-industrial-mcp', JSON.stringify(init?.result?.serverInfo ?? init?.error))
  const list = await rpc('tools/list')
  const tools = list?.result?.tools ?? []
  ok('tools/list ≥30 个工具', tools.length >= 30, `实际 ${tools.length}`)
  const names = new Set(tools.map(t => t.name))
  for (const t of ['aw_status', 'aw_login', 'aw_line_create', 'aw_dcw_create', 'aw_param_write', 'aw_recipe_create', 'aw_line_start', 'aw_daq_controller', 'aw_channel_template_instantiate', 'aw_twin_profile_patch', 'aw_team_provision', 'aw_plugin_list', 'aw_request']) {
    ok(`关键工具存在: ${t}`, names.has(t))
  }
}

// ── S4:自动端口发现 + 鉴权 ────────────────────────────────
console.log('[S4] 自动端口发现 + 懒登录')
{
  const st = await call('aw_status')
  ok('aw_status 自动发现端口', !st.isError && st.data?.port === PORT, `text=${st.text.slice(0, 200)}`)
  ok('发现来源为锁文件', /lock/i.test(st.data?.discoveredVia ?? ''), st.data?.discoveredVia)
  ok('needsSetup=false(已有 admin)', st.data?.needsSetup === false)
}

// ── S5:全链业务(真实 REST)────────────────────────────────
console.log('[S5] 全链业务:建线→建节点→参数映射→配方→开跑→回环')
let lineId, productId, dcwNodeId, daqNodeId
{
  const line = await call('aw_line_create', { name: `MCP-E2E线-${Date.now() % 100000}` })
  ok('aw_line_create', !line.isError && line.data?.line?.id, line.text.slice(0, 150))
  lineId = line.data?.line?.id

  const product = await call('aw_product_create', { lineId, name: 'E2E 产品' })
  ok('aw_product_create', !product.isError && product.data?.product?.id, product.text.slice(0, 150))
  productId = product.data?.product?.id

  // 回路驱动节点:driverConfig 指向模拟器没有 —— 用 http 回路不行(要真实回读),
  // 这里用 mock 语义最简单的方式:driver 'modbus-tcp' 指向不存在的设备,
  // 节点可建、参数映射可查;写入会失败,故回环用 read(被动观测,失败也不影响建链验收)。
  // 真实写读回环由 scripts/_dbg-param-map-e2e.ts(自带模拟器)覆盖,本脚本验收 API 集成面。
  const dcw = await call('aw_dcw_create', {
    templateRef: 'dcw-temp-sp',
    name: 'E2E 温度设定',
    lineId,
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 15099, unitId: 1, register: 40001, dataType: 'float32', byteOrder: 'big' },
    unit: '℃', min: 150, max: 200, decimals: 1,
  })
  ok('aw_dcw_create(DCW 节点)', !dcw.isError && dcw.data?.node?.id, dcw.text.slice(0, 200))
  dcwNodeId = dcw.data?.node?.id ?? dcw.data?.id

  const daq = await call('aw_daq_create', {
    templateRef: 'daq-temp-tc',
    name: 'E2E 温度观测',
    lineId,
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 15099, unitId: 1, register: 30001, dataType: 'float32', byteOrder: 'big' },
    unit: '℃', min: 0, max: 300,
    semantics: 'E2E 温度观测(验收用)',
  })
  ok('aw_daq_create(DAQ 节点)', !daq.isError && (daq.data?.node?.id ?? daq.data?.id), daq.text.slice(0, 200))
  daqNodeId = daq.data?.node?.id ?? daq.data?.id

  const params = await call('aw_param_list', { lineId, limits: 1 })
  const plist = params.data?.params ?? params.data ?? []
  const mine = Array.isArray(plist) ? plist.find(p => p.nodeId === dcwNodeId) : null
  ok('参数映射随节点自动生成(ensureForNode)', Boolean(mine), `params=${JSON.stringify(plist).slice(0, 200)}`)

  const recipe = await call('aw_recipe_create', {
    productId,
    name: 'E2E 配方',
    params: [{ nodeId: dcwNodeId, value: 175, min: 160, max: 190 }],
    daqWindows: [{ nodeId: daqNodeId, min: 0, max: 300 }],
  })
  const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
  ok('aw_recipe_create(节点级参数绑定)', !recipe.isError && recipeId, recipe.text.slice(0, 200))

  if (lineId && recipeId) {
    const start = await call('aw_line_start', { lineId, recipeId })
    ok('aw_line_start(逐参数下发回执)', !start.isError, start.text.slice(0, 200))
  }

  const ctl = await call('aw_daq_controller', { action: 'start' })
  ok('aw_daq_controller start', !ctl.isError, ctl.text.slice(0, 150))
}

// ── S6:优化频道面 ────────────────────────────────────────
console.log('[S6] 优化频道:创建/模板实例化/孪生 profile')
{
  const ch = await call('aw_channel_create', { name: `MCP-E2E优化频道-${Date.now() % 100000}`, scenarioPrompt: '验收用:一切决策基于实测数字。' })
  ok('aw_channel_create', !ch.isError && (ch.data?.channelId ?? ch.data?.id), ch.text.slice(0, 150))

  const tpl = await call('aw_channel_template_list')
  const tlist = tpl.data?.templates ?? tpl.data ?? []
  ok('aw_channel_template_list 含内置 aml-optimization 模板', JSON.stringify(tlist).includes('chtpl-aml-optimization-default'), tpl.text.slice(0, 150))

  // 模板实例化路径(优化频道的标准创建方式)→ 孪生 profile 应为 aml_optimization + exploration
  const tplId = (Array.isArray(tlist) ? tlist : tlist.templates ?? []).find(t => t.id === 'chtpl-aml-optimization-default')?.id
    ?? (Array.isArray(tlist) ? tlist : []).find(t => String(t?.id ?? '').includes('aml-optimization'))?.id
    ?? 'chtpl-aml-optimization-default'
  const inst = await call('aw_channel_template_instantiate', { id: tplId, name: `MCP-E2E优化模板实例-${Date.now() % 100000}`, toolProfile: 'aml_optimization', optimizationMode: 'exploration', controlPolicy: 'hitl_governed' })
  const instChId = inst.data?.channelId ?? inst.data?.id
  ok('aw_channel_template_instantiate(aml_optimization)', !inst.isError && instChId, inst.text.slice(0, 200))

  if (instChId) {
    const prof = await call('aw_twin_profile_get', { channelId: instChId })
    const pj = JSON.stringify(prof.data ?? {})
    ok('aw_twin_profile_get(aml_optimization + exploration 初始态)', !prof.isError && pj.includes('aml_optimization') && pj.includes('exploration'), prof.text.slice(0, 250))
  }
}

// ── S7:插件与守卫 ────────────────────────────────────────
console.log('[S7] 插件清单与逃生舱守卫')
{
  const pl = await call('aw_plugin_list')
  ok('aw_plugin_list', !pl.isError && Array.isArray(pl.data?.plugins), pl.text.slice(0, 150))

  const evil = await call('aw_request', { method: 'GET', path: 'http://evil.example/api/x' })
  ok('aw_request 拒绝非 /api/ 路径', evil.isError)
}

// ── S8:清场 ─────────────────────────────────────────────
console.log('[S8] 清场')
mcp.stdin.end()
mcp.kill()
{
  const lockPath = join(HOME, '.runtime', 'aw.lock')
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').match(/"pid":\s*(\d+)/)?.[1])
    if (Number.isInteger(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  else {
    // 退路:按端口找 pid 的维护交给人工;至少打印提示
    console.log('  · 未找到实例锁,跳过自动清场')
  }
}
await sleep(1500)
if (!KEEP) {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* Windows 句柄延迟,允许残留 */ }
}

console.log('')
console.log(`═══ aw-mcp live e2e:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)

function FAIL_SUMMARY() {
  return `═══ aw-mcp live e2e:${pass} PASS / ${fails.length + 1} FAIL ═══`
}
