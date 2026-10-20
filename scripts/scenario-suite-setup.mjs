/**
 * 场景总验收 · 阶段 1：隔离平台 + 专用模拟器 + 注塑线 + 数据分析
 *
 * 产物：<HOME>/scenario-context.json（仅临时 home，含测试 admin token，不入仓库）
 * 之后阶段脚本读取该 context 继续闭环/稳定性/IDD-RAG。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3470
const SIM_PORT = 4050
const BASE = `http://127.0.0.1:${PORT}`
const SIM_BASE = `http://127.0.0.1:${SIM_PORT}`
const HOME = mkdtempSync(join(tmpdir(), 'aw-scenario-suite-'))
const EVID = join(REPO, 'docs', 'audit', '2026-10-20-scenario-suite-evidence')
mkdirSync(EVID, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function ok(id, name, cond, detail = '') {
  // 兼容早期 3 参调用：ok(label, cond, detail)
  if (typeof name === 'boolean') {
    detail = cond ?? ''
    cond = name
    name = id
    id = ''
  }
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ''}`)
}
async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
async function health(base = BASE) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })
    return (await r.json())?.data?.status === 'ok'
  }
  catch { return false }
}
async function waitHealth(timeoutMs = 120_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await health()) return true
    await sleep(1500)
  }
  return false
}

function startPlatform() {
  const sessionPw = randomBytes(24).toString('hex')
  const out = openSync(join(HOME, 'platform.log'), 'a')
  // 复用既有 AML venv（仅链接，训练/模型仍写临时 AML 根）
  const amlRoot = join(HOME, 'aml')
  mkdirSync(amlRoot, { recursive: true })
  const venvSrc = join(REPO, '.AgentWorkShop', 'aml', '.venv')
  if (existsSync(venvSrc) && !existsSync(join(amlRoot, '.venv'))) {
    try {
      symlinkSync(venvSrc, join(amlRoot, '.venv'), 'junction')
    }
    catch { /* 训练阶段会显式失败 */ }
  }
  const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(PORT)], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      AW_AML_DIR: amlRoot,
      AW_MCP_ENABLED: 'true',
      NUXT_SESSION_PASSWORD: sessionPw,
      NO_PROXY: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
    },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  closeSync(out)
  child.unref()
  return child
}

/** 外部服务：IDD + RAG 注册测试身份（密码随机，仅内存/临时 home） */
async function bootstrapExternal() {
  const user = `scenario_${Date.now().toString(36)}`
  const pass = randomBytes(18).toString('base64url')

  // IDD: first/any register; response data.session_token
  const iddReg = await fetch('http://127.0.0.1:3210/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }), signal: AbortSignal.timeout(20_000),
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  const iddToken = String(iddReg?.data?.session_token ?? '')
  const iddOk = Boolean(iddToken)

  // RAG: register then login (login returns token)
  const ragUser = `scenario_${Date.now().toString(36)}`
  const ragReg = await fetch('http://127.0.0.1:8771/api/v1/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ragUser, password: pass }), signal: AbortSignal.timeout(20_000),
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  const ragLogin = await fetch('http://127.0.0.1:8771/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ragUser, password: pass }), signal: AbortSignal.timeout(20_000),
  }).then(r => r.json()).catch(e => ({ error: String(e) }))
  const ragToken = String(ragLogin?.token ?? '')
  return { iddToken, ragToken, iddOk, ragOk: Boolean(ragToken), ragReg, iddReg }
}

async function main() {
  console.log(`━━━ 场景总验收 setup @ ${BASE} / sim ${SIM_BASE} / home ${HOME} ━━━`)
  const ctx = { base: BASE, simBase: SIM_BASE, home: HOME, port: PORT, startedAt: new Date().toISOString() }

  // ── S1 平台 ──
  const up = await health()
  if (!up) startPlatform()
  ok('S1 平台健康', await waitHealth(), BASE)

  // ── S2 admin（首注册即 admin；密码仅内存/临时 home） ──
  const adminPass = randomBytes(18).toString('base64url')
  const adminEmail = `scenario-admin-${Date.now().toString(36)}@awshop.local`
  const reg = await req('POST', '/api/users/register', { name: 'scenario-admin', email: adminEmail, password: adminPass })
  const token = String(reg?.data?.token ?? '')
  ctx.adminToken = token
  ctx.adminEmail = adminEmail
  ok('S2 首个用户注册为 admin', Boolean(token), `HTTP ${reg.status} ${reg.message ?? ''}`)
  if (!token) return finish(ctx, results)
  const me = (await req('GET', '/api/users/me', undefined, token))?.data
  ok('S2 admin 角色确认', me?.role === 'admin', JSON.stringify(me?.role ?? me))

  // ── S3 外部 IDD/RAG 测试身份 + 平台插件配置 ──
  const ext = await bootstrapExternal()
  ok('S3 IDD 注册得 token', ext.iddOk, JSON.stringify(ext.iddReg).slice(0, 120))
  ok('S3 RAG 登录得 token', ext.ragOk, JSON.stringify(ext.ragReg).slice(0, 120))
  if (ext.iddToken && ext.ragToken) {
    const patch = await req('PATCH', '/api/system/settings', {
      override: {
        'plugins.diag-bridge.base_url': 'http://127.0.0.1:3210',
        'plugins.diag-bridge.token': ext.iddToken,
        'plugins.rag-bridge.base_url': 'http://127.0.0.1:8771',
        'plugins.rag-bridge.web_url': 'http://127.0.0.1:6789',
        'plugins.rag-bridge.token': ext.ragToken,
      },
    }, token)
    ctx.externalConfigured = patch?.ok === true || patch?.code === 0 || (patch?.changed?.length ?? 0) > 0
    ok('S3 平台插件 token 配置', ctx.externalConfigured, JSON.stringify(patch).slice(0, 220))
  }

  // ── S4 模拟器 + 注塑预设 ──
  process.env.SIM_BASE = SIM_BASE
  process.env.SIM_PORT = String(SIM_PORT)
  process.env.SIM_SHADOW_DIR = join(REPO, '..', `plc-node-simulator-scenario-${SIM_PORT}`)
  const sim = await import('../bench/lib/sim.mjs')
  const scen = await import('../bench/lib/scenarios.mjs')
  const simUp = await sim.ensureSimulator({ log: m => console.log(`  [sim] ${m}`) })
  ok('S4 专用模拟器在线', await sim.simUp(), JSON.stringify(simUp).slice(0, 160))
  await scen.ensureScenarioLine(scen.SCENARIOS.injection)
  const devices = await sim.simNodes()
  const running = devices.filter(d => d.runtime?.running)
  ok('S4 injection-line 5 设备 running', running.length >= 5, `devices=${devices.length} running=${running.length}`)
  ok('S4 协议矩阵含五族', new Set(devices.map(d => d.protocol)).size >= 5, [...new Set(devices.map(d => d.protocol))].join(','))
  const before = new Map()
  for (const d of devices) for (const s of d.signals ?? []) before.set(`${d.id}/${s.id}`, s.value ?? s.runtime?.value)
  await sleep(10_000)
  const afterDevs = await sim.simNodes()
  let moved = 0
  for (const d of afterDevs) for (const s of d.signals ?? []) {
    const oldV = before.get(`${d.id}/${s.id}`)
    const newV = s.value ?? s.runtime?.value
    if (Number.isFinite(Number(oldV)) && Number.isFinite(Number(newV)) && Math.abs(Number(newV) - Number(oldV)) > 1e-9) moved++
  }
  ok('S4 PV tick 活性(≥3 信号变化)', moved >= 3, `moved=${moved}`)

  // ── S5 平台供给产线 ──
  const api = { call: (m, p, b) => req(m, p, b, token) }
  const rec = await scen.provisionScenarioLine(api, scen.SCENARIOS.injection, { sfx: `s${Date.now().toString(36).slice(-4)}` })
  const lineId = rec?.ids?.lineId ?? rec?.lineId
  const recipeId = rec?.ids?.recipeId ?? rec?.recipeId
  const productId = rec?.ids?.productId ?? rec?.productId
  ctx.lineId = lineId
  ctx.recipeId = recipeId
  ctx.productId = productId
  ctx.dcw = rec?.dcw ?? {}
  ctx.daq = rec?.daq ?? {}
  ctx.simDevices = devices.map(d => ({ id: d.id, protocol: d.protocol, running: Boolean(d.runtime?.running) }))
  ok('S5 产线/节点/配方供给', Boolean(lineId && recipeId), `line=${lineId} recipe=${recipeId} dcw=${Object.keys(rec?.dcw ?? {}).length} daq=${Object.keys(rec?.daq ?? {}).length}`)
  ok('S5 驱动实测无失败', (rec?.driverTests ?? []).every(t => t.ok), JSON.stringify(rec?.driverTests ?? []))
  if (!lineId || !recipeId) return finish(ctx, results)

  // 开跑状态 + 样本
  const dcwSnap = (await req('GET', '/api/workshop/dcw', undefined, token))?.data
  const lineState = (dcwSnap?.lineStates ?? []).find(l => l.lineId === lineId)
  ok('S5 产线处于运行态', Boolean(lineState?.running) || /run|active/i.test(String(lineState?.state ?? '')), JSON.stringify(lineState ?? null).slice(0, 220))
  const weightNode = rec?.daq?.['part-weight'] ?? Object.values(rec?.daq ?? {})[0]
  ctx.weightNode = weightNode
  let sampleCount = 0
  for (let i = 0; i < 30; i++) {
    const s = await req('GET', `/api/workshop/daq/${weightNode}/samples?from=${Date.now() - 300_000}&to=${Date.now()}&bucketMs=1000&limit=500`, undefined, token)
    sampleCount = s?.data?.points?.length ?? 0
    if (sampleCount >= 20) break
    await sleep(2000)
  }
  ok('S5 DAQ 新鲜样本 ≥20', sampleCount >= 20, `node=${weightNode} points=${sampleCount}`)

  // ── S6 Channel + 三个 Agent + 绑定 ──
  const chName = `注塑场景验收-${Date.now().toString(36).slice(-5)}`
  const ch = await req('POST', '/api/workshop/channels', {
    name: chName,
    lineId,
    leadAgent: { name: `场景主管-${Date.now().toString(36).slice(-4)}`, harness: 'mock' },
  }, token)
  const channelId = String(ch?.data?.channelId ?? '')
  ctx.channelId = channelId
  ok('S6 Channel 创建并绑线', Boolean(channelId), `HTTP ${ch.status} ${ch.message ?? ''}`)
  async function addAgent(name, role) {
    const tpl = await req('POST', '/api/workshop/agents', { name, harness: 'mock', config: {} }, token)
    const agentTplId = tpl?.data?.id
    const join = await req('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: agentTplId, role }, token)
    return { templateId: agentTplId, instanceId: join?.data?.id ?? join?.data?.agentId, join }
  }
  const analyst = await addAgent(`数据分析-${Date.now().toString(36).slice(-4)}`, 'worker')
  const optimizer = await addAgent(`工艺优化-${Date.now().toString(36).slice(-4)}`, 'worker')
  const agents = (await req('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token))?.data ?? []
  const aList = Array.isArray(agents) ? agents : (agents.agents ?? [])
  const analystAgent = aList.find(a => a.id === analyst.instanceId || a.name === `数据分析-${Date.now().toString(36).slice(-4)}`)
    ?? aList.find(a => /数据分析/.test(a.name))
  const optimizerAgent = aList.find(a => a.id === optimizer.instanceId) ?? aList.find(a => /工艺优化/.test(a.name))
  const leadAgent = aList.find(a => a.role === 'lead')
  ctx.agents = { lead: leadAgent, analyst: analystAgent, optimizer: optimizerAgent }
  ok('S6 三个成员就绪(含 token)', Boolean(leadAgent?.token && analystAgent?.token && optimizerAgent?.token), `n=${aList.length}`)
  if (!analystAgent?.token || !optimizerAgent?.token) return finish(ctx, results)

  for (const nodeId of Object.values(rec?.daq ?? {})) {
    await req('POST', '/api/workshop/agent-tools/bindings', { agentId: analystAgent.id, nodeId, kind: 'daq', mode: 'auto' }, token)
  }
  const bindRecipe = await req('POST', '/api/workshop/agent-tools/bindings', { agentId: optimizerAgent.id, nodeId: recipeId, kind: 'recipe', mode: 'manual' }, token)
  ok('S6 分析师绑全部 DAQ / 优化师绑配方 manual', bindRecipe?.code === 0, `recipeBind=${bindRecipe?.data?.binding?.id ?? bindRecipe?.message ?? ''}`)

  const plugins = (await req('GET', `/api/workshop/channels/${channelId}/plugins`, undefined, token))?.data?.plugins ?? []
  const pluginPayload = plugins.map(p => ({ name: p.name, enabled: ['idd-closedloop-bridge', 'rag-bridge'].includes(p.name) }))
  if (pluginPayload.length) await req('PUT', `/api/workshop/channels/${channelId}/plugins`, { plugins: pluginPayload }, token)
  ok('S6 频道插件启用 IDD+RAG', pluginPayload.filter(p => p.enabled).length >= 1, pluginPayload.filter(p => p.enabled).map(p => p.name).join(','))

  // ── S7 数据分析作业 ──
  async function invoke(agent, tool, args, timeoutMs = 180_000) {
    const r = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
      body: JSON.stringify({ agentId: agent.id, tool, args }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json().catch(() => null)
    return { status: r.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? ''), json: j }
  }

  const now = Date.now()
  const from = now - 5 * 60_000
  const q = await invoke(analystAgent, 'daq_query', { line_id: lineId, last_minutes: 5, bucket_ms: 1000, limit: 300 })
  const raw = await req('GET', `/api/workshop/daq/${weightNode}/samples?from=${from}&to=${now}&bucketMs=1000&limit=500`, undefined, token)
  const points = raw?.data?.points ?? []
  const vals = points.map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN
  const std = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) : 0
  const min = vals.length ? Math.min(...vals) : NaN
  const max = vals.length ? Math.max(...vals) : NaN
  const inWindow = vals.filter(v => v >= 32.15 && v <= 32.85).length
  ok('S7 daq_query 返回样本与统计', !q.isError && /样本\s+\d+\s+点/.test(q.text) && vals.length >= 20, q.text.slice(0, 220))
  ok('S7 独立复算指标有限', Number.isFinite(mean) && Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(std), `n=${vals.length} mean=${mean.toFixed(3)} std=${std.toFixed(3)} range=${min}~${max}`)
  const textMean = Number((q.text.match(/均值\s+([\d.]+)/) ?? [])[1])
  ok('S7 复算均值与工具均值一致', Number.isFinite(textMean) && Math.abs(textMean - mean) <= Math.max(0.02, std * 0.2), `tool=${textMean} raw=${mean.toFixed(3)}`)

  const title = `注塑线 ${lineId} 克重窗口分析 ${new Date().toISOString().slice(0, 19)}`
  const save = await invoke(analystAgent, 'analysis_save', {
    title,
    summary: `近 5 分钟克重 mean=${mean.toFixed(3)}g、std=${std.toFixed(3)}g、range=${min.toFixed(2)}~${max.toFixed(2)}g、窗内 ${inWindow}/${vals.length}`,
    conclusions: [
      `克重均值 ${mean.toFixed(3)}g,目标 32.15~32.85g`,
      `标准差 ${std.toFixed(3)}g;极差 ${(max - min).toFixed(3)}g`,
      `窗内占比 ${((inWindow / Math.max(vals.length, 1)) * 100).toFixed(1)}%`,
      '本报告仅基于 DAQ 只读窗口,不含任何产线写入。',
    ],
    report: `# 注塑线克重窗口分析\n\n- 产线:${lineId}\n- 节点:${weightNode}\n- 时间窗:${new Date(from).toISOString()} ~ ${new Date(now).toISOString()}\n- 样本:${vals.length}\n- mean=${mean.toFixed(4)}g,std=${std.toFixed(4)}g,min=${min.toFixed(4)}g,max=${max.toFixed(4)}g\n- 目标窗 32.15~32.85g,窗内 ${inWindow}/${vals.length}\n\n## 置信口径\n基于 1s 桶原始样本独立复算;均值与 daq_query 工具统计交叉核对。\n`,
    category: 'quality',
    line_id: lineId,
    recipe_id: recipeId,
    data_sources: `daq_query + /api/workshop/daq/${weightNode}/samples`,
    metrics: { mean, std, min, max, samples: vals.length, in_window: inWindow },
  }, 60_000)
  ok('S7 analysis_save 落痕', !save.isError && /分析报告|ar-|已保存/.test(save.text), save.text.slice(0, 220))
  const reportId = (save.text.match(/ar-[0-9a-f]+/) ?? [])[0] ?? ''
  const query = await invoke(analystAgent, 'analysis_query', reportId ? { report_id: reportId } : { line_id: lineId, q: '克重窗口分析', limit: 5 }, 60_000)
  ok('S7 analysis_query 可检索', !query.isError && (query.text.includes('克重') || query.text.includes('mean=')), query.text.slice(0, 220))

  const evidence = { story: 'US-002', lineId, recipeId, channelId, weightNode, window: { from, to: now }, samples: vals.length, metrics: { mean, std, min, max, inWindow }, reportId, daqQuery: q.text.slice(0, 1200), save: save.text.slice(0, 1200), query: query.text.slice(0, 1200) }
  writeFileSync(join(EVID, 'US-002-data-analysis.json'), JSON.stringify(evidence, null, 2))
  ctx.analysisReportId = reportId

  // 把外部 token 写入临时 context（仅本机临时 home；不写仓库）
  ctx.externalTokens = { idd: ext.iddToken, rag: ext.ragToken }
  writeFileSync(join(HOME, 'scenario-context.json'), JSON.stringify(ctx, null, 2))
  console.log(`CONTEXT=${join(HOME, 'scenario-context.json')}`)
  return finish(ctx, results)
}

function finish(ctx, results) {
  const pass = results.filter(r => r.pass).length
  const summary = { at: new Date().toISOString(), pass, fail: results.length - pass, results, context: { home: ctx.home, base: ctx.base, simBase: ctx.simBase, lineId: ctx.lineId, recipeId: ctx.recipeId, channelId: ctx.channelId } }
  writeFileSync(join(EVID, 'US-001-002-setup-analysis.json'), JSON.stringify(summary, null, 2))
  console.log(`\n═══ setup+analysis: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((err) => {
  console.error(err)
  ok('脚本未抛异常', false, err instanceof Error ? err.message : String(err))
  finish({ home: HOME, base: BASE, simBase: SIM_BASE }, results)
  process.exitCode = 1
})
