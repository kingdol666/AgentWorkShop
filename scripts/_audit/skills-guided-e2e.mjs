#!/usr/bin/env node
/**
 * scripts/_audit/skills-guided-e2e.mjs —— 三个项目 skill 的「引导执行」端到端验收。
 *
 * 核心命题:一个只读过 skills/<name>/SKILL.md 的 agent,能否仅凭 skill 的步骤指引、
 * 仅通过 aw 工业 MCP 工具,完成 节点连接 / 优化 Channel 创建 / 插件开发 三条流程。
 * 本脚本 = 该 agent 的模拟器:每一步都对应 SKILL.md 的编号步骤,不允许绕过 MCP 直调平台
 * (唯一的例外是 skill 明文指示的"模拟器 REST 直连"与脚手架 CLI)。
 *
 * 场景:完全隔离 —— 平台 3462(全新 AW_HOME,预置 mcp.enabled=true)+ 模拟器 4013(影子目录)。
 * 用法:node scripts/_audit/skills-guided-e2e.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEEP = process.argv.includes('--keep')
const AW_PORT = 3462
const SIM_PORT = 4013
const HOME = mkdtempSync(join(tmpdir(), 'aw-skills-guided-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4013')
const BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    return await r.json()
  }
  catch { return null }
}

/* ── S0 · 隔离环境:平台(预置 mcp.enabled)+ 模拟器 + 预设 ── */
console.log(`[S0] 隔离环境:平台 ${BASE}(home 预置 mcp.enabled)+ 模拟器 ${SIM}`)
mkdirSync(join(HOME, '.runtime'), { recursive: true })
// 预置系统设置:mcp.enabled=true —— 等价于用户在「系统设置 → MCP 集成」打开开关
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true } }))
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'skills-guided-e2e-session-password-012345' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let platformUp = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { platformUp = true; break }
}
ok('平台健康门通过', platformUp, `平台日志 ${join(HOME, 'instance.log')}`)
if (!platformUp) { console.log(`═══ ${pass} PASS / ${fails.length + 1} FAIL ═══`); process.exit(1) }
{
  // 影子目录(源码拷贝+node_modules junction)与协议端口偏移由 bench/lib/sim.mjs 统一处理
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  const simInfo = await ensureSimulator({ log: m => console.log(`  [sim] ${m}`) })
  ok('模拟器自动拉起(影子实例)', Boolean(simInfo?.dir), JSON.stringify(simInfo).slice(0, 120))
  await applyPreset('cast-film-physics')
  const applied = await getJson(`${SIM}/api/plant/state`)
  ok('cast-film-physics 预设应用(物理引擎在跑)', applied?.data?.running === true, JSON.stringify(applied?.data ?? {}).slice(0, 120))
}

/* ── S1 · 注册 admin,拉起 MCP(stdio)── */
const reg = await (async () => {
  const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'guided-e2e-admin', email: 'guided-e2e@awshop.local', password: 'guided-e2e-passw0rd' }) })
  return r.json()
})()
const TOKEN = reg?.data?.token
ok('admin 注册(首注册即 admin)', Boolean(TOKEN))

const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_HOME: HOME, AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => { try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {} })
const rpc = (method, params, timeoutMs = 60_000) => new Promise((res, rej) => {
  const id = nextId++
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`rpc 超时: ${method}`)) }, timeoutMs)
  pending.set(id, (m) => { clearTimeout(t); res(m) })
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
/** 调 MCP 工具 —— 这是被测 agent 唯一的"手" */
const call = async (name, args = {}, timeoutMs) => {
  const res = await rpc('tools/call', { name, arguments: args }, timeoutMs)
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

/* ════════ Flow A · aw-node-bind:真实场景节点参数绑定 ════════ */
console.log('[Flow A] aw-node-bind —— 按 SKILL.md 步骤 0→8 执行')
let lineId, productId, dcwNodeId, daqNodeId
{
  // 步骤 0:连接检查(含 mcpEnabled)
  const st = await call('aw_status')
  ok('A0 aw_status:发现+鉴权+mcpEnabled=true', !st.isError && st.data?.port === AW_PORT && st.data?.authed === true && st.data?.mcpEnabled === true, st.text.slice(0, 160))

  // 步骤 1:执行点规约(skill 明文:模拟器 REST 直连,取蓝图与 export,禁止手抄)
  const blueprint = await getJson(`${SIM}/api/presets/cast-film-physics`)
  ok('A1a 模拟器蓝图 dry-run 可得', Array.isArray(blueprint?.data?.nodes) && blueprint.data.nodes.length > 0)
  const exp = await getJson(`${SIM}/api/nodes/dev-extruder-mbtcp/export`)
  const expItems = exp?.data?.items ?? []
  const zone1 = expItems.find(i => i.signal === '加热区1SP') ?? expItems[0]
  const meltTemp = expItems.find(i => String(i.signal).includes('熔体温度'))
  ok('A1b 设备 export 提供 driverConfig(不手抄;SP 与 PV 各取对应信号项)', Boolean(zone1?.driverConfig?.port) && Boolean(meltTemp?.driverConfig), JSON.stringify({ zone1: zone1?.signal, melt: meltTemp?.signal }).slice(0, 120))

  // 步骤 2:产线与产品(skill ⚠️:paramLimits 键须引用已存在的参数面——先不带限界,节点建成后再补)
  const line = await call('aw_line_create', { name: `引导验收线-${Date.now() % 100000}` })
  lineId = line.data?.line?.id
  ok('A2a aw_line_create', !line.isError && lineId, line.text.slice(0, 120))
  const product = await call('aw_product_create', { lineId, name: '引导验收产品' })
  productId = product.data?.product?.id
  ok('A2b aw_product_create(不带 paramLimits,参数面未生成)', !product.isError && productId, product.text.slice(0, 140))

  // 步骤 3:DCW 执行节点(templateRef + export 的 driverConfig + 显式量程/精度)
  const dcw = await call('aw_dcw_create', {
    templateRef: 'dcw-temp-sp', name: '引导-加热区1SP', lineId,
    driver: 'modbus-tcp', driverConfig: zone1.driverConfig,
    unit: '℃', min: 150, max: 200, decimals: 1, stepLimit: 5, holdIntervalMs: 180_000,
    semantics: '加热区1温度设定(引导验收)',
  })
  dcwNodeId = dcw.data?.node?.id ?? dcw.data?.id
  ok('A3 aw_dcw_create', !dcw.isError && dcwNodeId, dcw.text.slice(0, 160))

  // 步骤 4:DAQ 观测节点(带语义标注;driverConfig 取 PV 信号自己的 export 项)
  const daq = await call('aw_daq_create', {
    templateRef: 'daq-temp-tc', name: '引导-熔体温度', lineId,
    driver: 'modbus-tcp', driverConfig: meltTemp.driverConfig,
    unit: '℃', min: 0, max: 300, decimals: 1, intervalMs: 1000,
    semantics: '熔体温度测量(引导验收,特征输入)',
  })
  daqNodeId = daq.data?.node?.id ?? daq.data?.id
  ok('A4 aw_daq_create(含 semantics)', !daq.isError && daqNodeId, daq.text.slice(0, 160))

  // 步骤 5:采集总控
  const ctl = await call('aw_daq_controller', { action: 'start' })
  ok('A5 aw_daq_controller start', !ctl.isError, ctl.text.slice(0, 100))

  // 步骤 6:配方(节点级绑定;value 贴近设备现值 ~200,skill 单步限提醒)与开跑
  const recipe = await call('aw_recipe_create', {
    productId, name: '引导验收配方',
    params: [{ nodeId: dcwNodeId, value: 195, min: 160, max: 200 }],
    daqWindows: [{ nodeId: daqNodeId, min: 0, max: 300 }],
  })
  const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
  ok('A6a aw_recipe_create', !recipe.isError && recipeId, recipe.text.slice(0, 140))
  const start = await call('aw_line_start', { lineId, recipeId })
  ok('A6b aw_line_start(逐参数下发回执)', !start.isError, start.text.slice(0, 160))

  // 步骤 7:回环验收(读形状 {read:{value}};治理写入相对现值 ≤stepLimit=5)
  await sleep(4000)
  const paramList = await call('aw_param_list', { lineId })
  const paramId = paramList.data?.params?.find(p => p.nodeId === dcwNodeId)?.id
  const before = await call('aw_dcw_read', { id: dcwNodeId })
  ok('A7a aw_dcw_read(读 PLC 实时值)', !before.isError && Number.isFinite(Number(before.data?.read?.value)), before.text.slice(0, 140))
  // skill ⚠️ 治理间隔:配方下发也算一次写入,紧跟的治理写必须等满 60s —— 先验证 429 限频真的在
  const tooSoon = await call('aw_param_write', { id: paramId, value: 190 })
  ok('A7b-1 紧跟写入被 429 限频拒绝(治理间隔生效)', tooSoon.isError && /429|间隔|60s/i.test(tooSoon.text), tooSoon.text.slice(0, 140))
  await sleep(66_000) // 失败尝试也会刷新冷却窗(防刷语义),从失败点起等满间隔
  const w = await call('aw_param_write', { id: paramId, value: 190 })
  ok('A7b-2 间隔满后 aw_param_write 190(Δ5=stepLimit)接受', !w.isError, w.text.slice(0, 140))
  await sleep(6000)
  const after = await call('aw_param_read', { id: paramId })
  ok('A7c aw_param_read 回读 ≈190', !after.isError && Math.abs(Number(after.data?.read?.value) - 190) <= 1.5, `回读=${JSON.stringify(after.data).slice(0, 120)}`)
  const simNow = await getJson(`${SIM}/api/nodes`)
  const simZone1 = (simNow?.data ?? []).flatMap(n => n.signals ?? []).find(s => s.id === 'zone1-sp')
  ok('A7d 写入真实落到模拟器(sim 侧 zone1-sp≈190)', Math.abs(Number(simZone1?.value) - 190) <= 1.5, `sim 值=${simZone1?.value}`)
  const bad = await call('aw_dcw_write', { id: dcwNodeId, value: 250 })
  ok('A7e 越界写被 400 拒(四层限界)', bad.isError && /400|超|限|range|limit/i.test(bad.text), bad.text.slice(0, 140))
  const samples = await call('aw_daq_samples', { id: daqNodeId, bucketMs: 1000, limit: 10 })
  const pts = samples.data?.points ?? samples.data ?? []
  ok('A7f aw_daq_samples 有数据(产线在跑,采样落库)', !samples.isError && (Array.isArray(pts) ? pts.length > 0 : false), samples.text.slice(0, 120))
}

/* ════════ Flow B · aw-opt-channel:场景优化 Channel 创建 ════════ */
console.log('[Flow B] aw-opt-channel —— 按 SKILL.md 步骤 0→4(探索执行由 LLM 频道完成,不在本验收范围)')
let channelIdB
{
  const st = await call('aw_status')
  ok('B0 aw_status 复核', !st.isError && st.data?.mcpEnabled === true)

  const tpl = await call('aw_channel_template_list')
  const tlist = tpl.data?.templates ?? tpl.data ?? []
  ok('B1a 模板列表含内置 aml-optimization', JSON.stringify(tlist).includes('chtml-marker') || JSON.stringify(tlist).includes('chtpl-aml-optimization-default'), tpl.text.slice(0, 120))

  const inst = await call('aw_channel_template_instantiate', { id: 'chtpl-aml-optimization-default', name: `引导优化频道-${Date.now() % 100000}`, toolProfile: 'aml_optimization', optimizationMode: 'exploration', controlPolicy: 'hitl_governed' })
  channelIdB = inst.data?.channelId ?? inst.data?.id
  ok('B1b 模板实例化(exploration + hitl_governed)', !inst.isError && channelIdB, inst.text.slice(0, 160))

  const prof = await call('aw_twin_profile_get', { channelId: channelIdB })
  const pj = JSON.stringify(prof.data ?? {})
  ok('B2 初始 profile = exploration/未绑模型', !prof.isError && pj.includes('exploration') && !/"boundModelId"\s*:\s*"(?!null)/.test(pj), pj.slice(0, 200))

  // 模板自带 lead(+worker 成员):skill ⚠️ 不可再 team_provision(会 409 已存在 lead),
  // worker 实例 id 从频道成员取
  const agents = await call('aw_request', { method: 'GET', path: `/api/workshop/channels/${channelIdB}/agents` })
  const workers = (agents.data ?? []).filter(a => a.role === 'worker')
  const workerId = workers[0]?.id
  ok('B3 模板频道自带 worker 实例(不经 team_provision)', !agents.isError && Boolean(workerId), agents.text.slice(0, 160))

  // 手工路径(skill 二选一的 B):自建频道 + 自组剧组 —— deploy 不会 409
  const manual = await call('aw_channel_create', { name: `引导手工频道-${Date.now() % 100000}`, scenarioPrompt: '引导验收:一切决策基于实测数字。' })
  const manualChId = manual.data?.channelId ?? manual.data?.id
  ok('B4a aw_channel_create(手工路径)', !manual.isError && manualChId, manual.text.slice(0, 120))
  const team = await call('aw_team_provision', {
    channelId: manualChId,
    lead: { name: '引导优化总工', harness: 'omp', config: { intro: '督办与验收' } },
    worker: { name: '引导工艺工程师', harness: 'omp', config: { intro: '闭环执行者' } },
    teamName: '引导剧组',
  })
  const manualWorkerId = team.data?.workerInstanceId
  ok('B4b aw_team_provision(建 agent→team→成员→deploy→实例id)', !team.isError && Boolean(manualWorkerId), team.text.slice(0, 200))

  if (workerId) {
    const b1 = await call('aw_agent_tool_bind', { agentId: workerId, nodeId: dcwNodeId, kind: 'dcw', mode: 'auto' })
    ok('B5a aw_agent_tool_bind(dcw,模板频道 worker)', !b1.isError, b1.text.slice(0, 120))
    const b2 = await call('aw_agent_tool_bind', { agentId: workerId, nodeId: daqNodeId, kind: 'daq', mode: 'auto' })
    ok('B5b aw_agent_tool_bind(daq)', !b2.isError, b2.text.slice(0, 120))
    const probe = await call('aw_agent_tool_invoke', { agentId: workerId, tool: 'twin_trial_run', args: { snapshotId: 'nonexistent' } }, 90_000)
    ok('B6 探索期负向门控:twin_trial_run 被拒(探索模式提示)', probe.isError && /探索模式|EXPLORATION_MODE_NO_MODEL/.test(probe.text), probe.text.slice(0, 160))
  }
}

/* ════════ Flow C · aw-plugin-dev:插件开发与热重载 ════════ */
console.log('[Flow C] aw-plugin-dev —— 按 SKILL.md 步骤 1→6 执行(AW_HOME 指向隔离 home = user 作用域)')
{
  // 步骤 1:脚手架(skill: aw plugin create <name> --global;AW_HOME 指向隔离 home 保持隔离)
  const plugName = 'guided-plugin'
  const r = spawnSync(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'plugin', 'create', plugName, '--global'], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, AW_HOME: HOME, AW_MODE: 'home' },
  })
  const plugDir = join(HOME, 'plugins', plugName)
  ok('C1 aw plugin create --global(落 AW_HOME/plugins)', r.status === 0 && existsSync(join(plugDir, 'index.mjs')), (r.stdout + r.stderr).slice(0, 160))

  // 步骤 2:实现入口契约(route + hook + kv,零依赖;契约=ctx.route('GET', path, handler),读 docs/plugins.md §九)
  writeFileSync(join(plugDir, 'index.mjs'), `/**
 * ${plugName} — 引导验收插件(路由 + 钩子 + KV)
 */
export default {
  name: '${plugName}',
  version: '0.1.0',
  description: 'skills-guided-e2e 验收插件',
  async setup(ctx) {
    ctx.logger.info('已装载 ✓(引导验收)')
    ctx.kv.set('bootAt', Date.now())
    ctx.hooks.on('daq:sample', () => { ctx.kv.bump('samples') })
    ctx.route('GET', '/health', () => ({ ok: true, plugin: '${plugName}', samples: ctx.kv.get('samples') ?? 0 }))
  },
}
`)
  ok('C2 实现入口契约(route/hook/kv)', existsSync(join(plugDir, 'index.mjs')))

  // 新脚手架目录按 create 提示「触碰 plugins-state.json」触发宿主 ~1s 全量重装载(skill 步骤 5)
  const stateFile = join(HOME, 'plugins-state.json')
  if (existsSync(stateFile)) writeFileSync(stateFile, `${readFileSync(stateFile, 'utf8').trimEnd()}\n`)
  else writeFileSync(stateFile, '{}\n')
  await sleep(2500)

  // 步骤 3-5:启停与热重载验证(经 MCP)
  const enable = await call('aw_plugin_toggle', { name: plugName, enabled: true })
  ok('C3 aw_plugin_toggle enable', !enable.isError, enable.text.slice(0, 140))
  await sleep(2500) // 宿主 ~1s 热重载
  const list = await call('aw_plugin_list')
  const plugins = list.data?.plugins ?? []
  const mine = plugins.find(p => p.name === plugName)
  ok('C4 aw_plugin_list 出现且已启用、无装载失败', Boolean(mine) && mine.enabled !== false && (list.data?.failures ?? []).filter(f => JSON.stringify(f).includes(plugName)).length === 0, JSON.stringify({ mine, failures: list.data?.failures }).slice(0, 200))
  const health = await getJson(`${BASE}/api/plugins/${plugName}/health`)
  ok('C5 插件路由可访问(宿主热装载生效)', health?.ok === true && health?.plugin === plugName, JSON.stringify(health).slice(0, 120))
  const disable = await call('aw_plugin_toggle', { name: plugName, enabled: false })
  ok('C6 aw_plugin_toggle disable', !disable.isError, disable.text.slice(0, 120))
  await sleep(2500)
  const health2 = await getJson(`${BASE}/api/plugins/${plugName}/health`)
  ok('C7 停用后路由摘除(热重载卸载)', health2 == null || health2.ok !== true, JSON.stringify(health2).slice(0, 120))
  const reEnable = await call('aw_plugin_toggle', { name: plugName, enabled: true })
  ok('C8 重新启用(启停回路闭合)', !reEnable.isError, reEnable.text.slice(0, 120))
  const list2 = await call('aw_plugin_list')
  ok('C9 failures 为空(装载无错)', (list2.data?.failures ?? []).length === 0, JSON.stringify(list2.data?.failures).slice(0, 160))
}

/* ── 清场 ── */
console.log('[清场] 终止 MCP/平台/模拟器')
mcp.stdin.end(); mcp.kill()
for (const [port] of [[AW_PORT], [SIM_PORT]]) {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}
await sleep(1500)
if (!KEEP) { try { rmSync(HOME, { recursive: true, force: true }) } catch {} }

console.log('')
console.log(`═══ skills 引导执行验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
