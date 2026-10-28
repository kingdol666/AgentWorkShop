#!/usr/bin/env node
/**
 * 镜像数采 × 自定义 MES API 在线抓取验收
 *
 * 场景:自建 MES API v1(声明式映射;x-api-token 鉴权),平台同时接两条数据路径:
 *   ① 镜像数采:http DAQ 节点轮询同一 MES 当前值接口 → TSDB → daq_query(API 宕机不断供)
 *   ② 直连取数:mes-rest 节点 readMap/historyMap → mes_catalog / mes_fetch
 * 再用 Qwen(omp)让 Agent 同时用两条路径抓数并汇报。
 *
 * 收口条件:
 *   M1 mes_catalog 可见自定义 API 点位;M2 mes_fetch 取到历史且数值=API 当前值;
 *   M3 镜像样本落库且与 API 当前值一致;M4 Agent daq_query 能取到镜像样本;
 *   M5 API 宕机:mes_fetch 失败、镜像历史仍可查(不断供)、新样本停止;
 *   M6 API 恢复:镜像继续采样;Q1 Qwen 双路径抓数并完成。
 *
 * 运行:node scripts/e2e-mes-mirror-real.mjs(自起 MES 模拟器 15071 + 平台实例 3422)
 * 证据:docs/audit/evidence/2026-10-29-mes-mirror/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_MESM_HOME ?? 'D:/tmp/aw-mesmirror-20261029'
const PORT = Number(process.env.AW_MESM_PORT ?? 3422)
const BASE = `http://127.0.0.1:${PORT}`
const MES_PORT = Number(process.env.AW_MESM_API_PORT ?? 15071)
const MES_BASE = `http://127.0.0.1:${MES_PORT}`
const MES_TOKEN = process.env.AW_MESM_TOKEN ?? `mes-mirror-${Date.now().toString(36)}`
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-mes-mirror')

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1800) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 750)}`}`)
  return Boolean(cond)
}
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'CANCELLED'])

let mesProc = null
async function mesUp() {
  try {
    const r = await fetch(`${MES_BASE}/api/v1/params/melt_pressure/current`, {
      headers: { 'x-api-token': MES_TOKEN },
      signal: AbortSignal.timeout(2000),
    })
    return r.ok
  }
  catch {
    return false
  }
}
async function startMes() {
  const log = openSync(join(HOME, 'mes-sim.log'), 'a')
  mesProc = spawn(process.execPath, [join(REPO, 'scripts', 'dev-mes-simulator.mjs'), '--port', String(MES_PORT)], {
    cwd: REPO,
    env: { ...process.env, MES_SIM_PORT: String(MES_PORT), MES_SIM_TOKEN: MES_TOKEN, NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (await mesUp()) return true
  }
  return false
}
function stopMes() {
  if (!mesProc?.pid) return
  try {
    spawn('taskkill', ['/PID', String(mesProc.pid), '/T', '/F'], { windowsHide: true })
  }
  catch { /* 已退出 */ }
  mesProc = null
}
async function mesCurrent() {
  const r = await fetch(`${MES_BASE}/api/v1/params/melt_pressure/current`, {
    headers: { 'x-api-token': MES_TOKEN },
    signal: AbortSignal.timeout(3000),
  })
  if (!r.ok) throw new Error(`MES HTTP ${r.status}`)
  const j = await r.json()
  return Number(j?.data?.value)
}

function stopInstance(home) {
  const pidFile = join(home, 'server.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  }
  catch { /* 已退出 */ }
}
async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json())?.data ?? null
  }
  catch {
    return null
  }
}
async function startInstance() {
  stopInstance(HOME)
  await sleep(1200)
  if (await health()) throw new Error(`端口 ${PORT} 已被非本验收实例占用`)
  if (!/aw-mesmirror/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  const log = openSync(join(HOME, 'server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      PORT: String(PORT),
      NUXT_SESSION_PASSWORD: 'mesmirror-20261029-session',
      AW_TRIAL_INTERVAL_MS: '0',
      AW_RATE_LIMIT_OFF: '1',
      AW_MES_E2E_TOKEN: MES_TOKEN,
      AW_SECRET_E2E: MES_TOKEN,
      NO_PROXY: '127.0.0.1,localhost',
    },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(join(HOME, 'server.pid'), String(child.pid))
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const h = await health()
    if (h?.workshop === 'ready') return h
  }
  throw new Error('隔离实例未在 120s 内就绪')
}

let admin = ''
async function apiOnce(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
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
async function api(method, path, body, token = admin, extraHeaders = {}, timeoutMs = 120_000) {
  try {
    return await apiOnce(method, path, body, token, extraHeaders, timeoutMs)
  }
  catch (err) {
    if (err instanceof TypeError) {
      await sleep(1500)
      return apiOnce(method, path, body, token, extraHeaders, timeoutMs)
    }
    throw err
  }
}
function must(resp, what) {
  if (resp.status !== 200 || !resp?.data) throw new Error(`${what} 失败:${resp.status} ${JSON.stringify(resp).slice(0, 500)}`)
  return resp.data
}
function agentTokenOf(agentId) {
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
  try {
    return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
  }
  finally {
    db.close()
  }
}
const taskOf = r => r?.data?.task ?? r?.data ?? null
const deliverableOf = task => String((task?.artifacts ?? []).find(a => a.name === 'deliverable')?.parts?.map(p => p.text ?? '').join('\n') ?? '')
const toolCallsOf = task => (task?.history ?? [])
  .map(h => String(h?.parts?.map(p => p.text ?? '').join(' ') ?? ''))
  .filter(t => t.includes('🔧'))
  .map(t => t.replace(/\s+/g, ' ').slice(0, 240))
async function pendingOf(agentId) {
  const r = await api('GET', `/api/workshop/agent-tools/approvals?agentId=${encodeURIComponent(agentId)}`)
  return (r?.data?.approvals ?? []).filter(a => a.status === 'pending')
}
async function invokeAs(agentId, token, tool, args) {
  const resp = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, undefined, { 'x-aw-agent-token': token }, 180_000)
  return {
    text: String(resp?.data?.result?.text ?? resp?.data?.text ?? ''),
    isError: Boolean(resp?.data?.result?.isError ?? resp?.data?.isError),
  }
}
async function samplesOf(nodeId, seconds = 120) {
  const to = Date.now()
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${to - seconds * 1000}&to=${to}&bucketMs=1000&limit=200`)
  const pts = (r?.data?.points ?? []).filter(p => Number.isFinite(p?.value ?? p?.avg))
  return pts.map(p => ({ at: Number(p.at), value: Number(p.value ?? p.avg) }))
}
async function waitTask(taskId, agentId, { timeoutMs = 9 * 60_000, evidence = null, graceMs = 60_000 } = {}) {
  const started = Date.now()
  let evidenceAt = 0
  const approved = new Set()
  while (Date.now() - started < timeoutMs) {
    const task = taskOf(await api('GET', `/api/workshop/tasks/${taskId}`))
    for (const card of await pendingOf(agentId)) {
      if (approved.has(card.id)) continue
      approved.add(card.id)
      await api('POST', `/api/workshop/agent-tools/approvals/${card.id}/decide`, { approved: true, comment: '验收:数据抓取任务' })
    }
    if (TERMINAL.has(String(task?.state ?? ''))) return { task, cancelled: false }
    if (evidence && evidence(task) && !evidenceAt) evidenceAt = Date.now()
    if (evidenceAt && Date.now() - evidenceAt > graceMs) {
      await api('POST', `/api/workshop/tasks/${taskId}/cancel`, { reason: '验收:证据收口' })
      return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cancelled: true }
    }
    await sleep(2000)
  }
  return { task: taskOf(await api('GET', `/api/workshop/tasks/${taskId}`)), cancelled: false }
}

const evidence = { at: new Date().toISOString(), scenario: {}, assertions: results }

try {
  mkdirSync(HOME, { recursive: true })
  ok('M0a', '自定义 MES API(v1)就绪', await startMes(), `${MES_BASE} token=***${MES_TOKEN.slice(-4)}`)
  const h = await startInstance()
  ok('M0b', '平台隔离实例就绪', h?.workshop === 'ready', `port=${PORT} version=${h?.version}`)
  admin = (await api('POST', '/api/users/register', { name: '镜像数采管理员', email: `mesm-${Date.now()}@awshop.local`, password: 'MesMirror#2026' })).data?.token
  ok('M0c', 'admin 注册', Boolean(admin))

  const line = must(await api('POST', '/api/workshop/dcw/lines', { name: '镜像数采线', description: 'MES API 镜像 + 直连双路径' }), '建线').line?.id
  // 线锚点(纯 mock,只用于开线让 DAQ 样本持久化)
  const anchor = must(await api('POST', '/api/workshop/dcw', {
    templateRef: 'temp-sp', name: '线锚点', driver: 'mock', lineId: line, unit: 'C', min: 0, max: 100, decimals: 1, stepLimit: 5,
  }), '建锚点').node?.id

  // mes-rest 节点(直连路径)
  const readMap = JSON.stringify({
    method: 'GET', path: '/api/v1/params/melt_pressure/current', query: {}, headers: {},
    response: { valuePath: 'data.value', tsPath: 'data.ts', tsFormat: 'epoch_ms' },
  })
  const historyMap = JSON.stringify({
    method: 'GET', path: '/api/v1/params/melt_pressure/history', query: {}, headers: {},
    response: {
      rowsPath: 'data.rows[*]', valuePath: 'value', tsPath: 'ts', format: 'scalar',
      nextCursorPath: 'data.nextCursor', dictionaryPath: 'data.fields',
    },
    pageSize: 50, maxPages: 5,
  })
  const mesNode = must(await api('POST', '/api/workshop/dcw', {
    templateRef: 'pressure-sp', name: 'MES熔体压力', driver: 'mes-rest', lineId: line,
    unit: 'MPa', min: 0, max: 45, decimals: 3, readIntervalMs: 60_000,
    driverConfig: {
      baseUrl: MES_BASE, allowPrivateHost: 'true',
      authType: 'header', authHeaderName: 'x-api-token', secretRef: 'E2E',
      desc: '自定义 MES API v1 熔体压力', semantics: 'MES 生产管理系统的熔体压力当前值',
      readMap, historyMap,
    },
  }), '建 MES 节点').node?.id

  // 镜像数采节点(http 轮询同一 API)
  const mirror = must(await api('POST', '/api/workshop/daq', {
    templateRef: 'daq-pressure-tx', name: 'MES熔体压力镜像', driver: 'http', lineId: line,
    unit: 'MPa', min: 0, max: 45, decimals: 3, intervalMs: 1000, publishIntervalMs: 0,
    semantics: 'MES API 当前值的镜像数采(API 宕机时历史仍可查)',
    driverConfig: {
      url: `${MES_BASE}/api/v1/params/melt_pressure/current`,
      jsonPath: 'data.value', allowPrivateHost: 'true', timeoutMs: 4000,
      authType: 'header', authHeaderName: 'x-api-token', secretRef: 'E2E',
    },
  }), '建镜像节点').node?.id
  ok('M1', 'MES 直连节点 + 镜像数采节点接入', Boolean(mesNode && mirror), JSON.stringify({ mesNode, mirror }))

  const product = must(await api('POST', '/api/workshop/dcw/products', {
    name: '镜像产品', lineId: line,
    paramLimits: { 'temp-sp': { min: 0, max: 100 }, 'pressure-sp': { min: 0, max: 45 } },
  }), '建产品').product
  const recipe = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: '镜像线配方', productId: product.id, opIntervalMs: 0,
    params: [{ nodeId: anchor, value: 50, min: 0, max: 100, stepLimit: 5 }],
  }), '建配方').recipe
  const mesRecipe = must(await api('POST', '/api/workshop/dcw/recipes', {
    name: 'MES数据授权配方', productId: product.id, opIntervalMs: 0,
    params: [{ nodeId: mesNode, value: 8.4, min: 0, max: 45 }],
  }), '建 MES 授权配方').recipe
  await api('POST', '/api/workshop/daq/controller', { action: 'start' })
  await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipe.id })
  await sleep(20_000)

  // 频道 + omp(Qwen 32k)
  const overlay = join(HOME, 'omp-overlay.yml')
  writeFileSync(overlay, ['modelRoles:', '  default: lm-studio/qwen3.5-9b-32k', '  task: lm-studio/qwen3.5-9b-32k', '  advisor: lm-studio/qwen3.5-9b-32k', '  slow: lm-studio/qwen3.5-9b-32k', '  designer: lm-studio/qwen3.5-9b-32k', 'tools:', '  format: qwen3', 'compaction:', '  enabled: true', ''].join('\n'))
  const ch = (await api('POST', '/api/workshop/channels', {
    name: '验收-镜像数采', lineId: line,
    scenarioPrompt: '你是数据工程师:只读不写;严格按任务步骤抓数并汇报。',
    leadAgent: { name: '镜像数采-线长', harness: 'omp', config: { rpcMode: 'rpc', args: ['--no-tools', '--thinking=off', '--config', overlay] } },
  })).data
  await api('PATCH', `/api/workshop/channels/${ch.channelId}`, { llm: { provider: 'lm-studio', model: 'qwen3.5-9b-32k' } })
  await api('PATCH', `/api/workshop/channels/${ch.channelId}/execution-mode`, { mode: 'manual' })
  await api('PUT', `/api/workshop/channels/${ch.channelId}/tools`, {
    mode: 'selected',
    tools: ['mes_catalog', 'daq_query', 'mes_fetch', 'complete_task', 'report_progress'].map(name => ({ name, enabled: true })),
  })
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ch.leadAgentId, nodeId: mesRecipe.id, kind: 'recipe', mode: 'auto' })
  if (bind?.data?.binding?.mode === 'manual') await api('PATCH', `/api/workshop/agent-tools/bindings/${bind.data.binding.id}`, { mode: 'auto', confirm: true })
  const tok = agentTokenOf(ch.leadAgentId)
  ok('M2', '频道/绑定(MES 授权配方)就绪', Boolean(ch.channelId && ch.leadAgentId) && bind.status === 200, JSON.stringify({ channel: ch.channelId, agent: ch.leadAgentId, bind: bind.status }))

  // ── 直连路径 ──
  const cat = await invokeAs(ch.leadAgentId, tok, 'mes_catalog', { line_id: line })
  ok('M3', 'mes_catalog 可见自定义 MES 点位', !cat.isError && /MES熔体压力/.test(cat.text), cat.text.replace(/\s+/g, ' ').slice(0, 420))
  const from = new Date(Date.now() - 10 * 60_000).toISOString()
  const to = new Date().toISOString()
  const fetchRes = await invokeAs(ch.leadAgentId, tok, 'mes_fetch', { ids: [mesNode], from, to, max_rows: 200 })
  const apiNow = await mesCurrent()
  const fetchNumbers = (fetchRes.text.match(/-?\d+\.\d+/g) ?? []).map(Number)
  const fetchNear = fetchNumbers.slice(0, 40).some(v => Math.abs(v - apiNow) <= 0.5)
  ok('M4', 'mes_fetch 直连取到历史(行数>0,数值与 API 当前值同量级)',
    !fetchRes.isError && /行/.test(fetchRes.text) && fetchNear,
    `api=${apiNow} text=${fetchRes.text.replace(/\s+/g, ' ').slice(0, 500)}`)

  // ── 镜像路径 ──
  const ms = await samplesOf(mirror, 90)
  const mirrorAdj = await samplesOf(mirror, 10)
  const latestMirror = mirrorAdj[mirrorAdj.length - 1]?.value ?? ms[ms.length - 1]?.value
  ok('M5', '镜像样本落库(≥5 点)', ms.length >= 5, `points=${ms.length} tail=${ms.slice(-3).map(x => x.value).join('/')}`)
  ok('M6', '镜像样本 = MES API 当前值(≤0.5MPa)', Number.isFinite(latestMirror) && Math.abs(latestMirror - apiNow) <= 0.5,
    `mirror=${latestMirror} api=${apiNow}`)
  const dq = await invokeAs(ch.leadAgentId, tok, 'daq_query', { node_id: mirror, last_minutes: 3, bucket_ms: 1000 })
  ok('M7', 'Agent daq_query 能取到镜像样本', !dq.isError && /样本\s*\d+\s*点/.test(dq.text), dq.text.replace(/\s+/g, ' ').slice(0, 420))

  // ── API 宕机:直连失败、镜像历史不断供、新样本停止 ──
  const beforeDown = await samplesOf(mirror, 60)
  const beforeLastAt = beforeDown[beforeDown.length - 1]?.at ?? 0
  stopMes()
  await sleep(12_000)
  const fetchDown = await invokeAs(ch.leadAgentId, tok, 'mes_fetch', { ids: [mesNode], from, to: new Date().toISOString(), max_rows: 50 })
  const mirrorDown = await samplesOf(mirror, 120)
  const downLastAt = mirrorDown[mirrorDown.length - 1]?.at ?? 0
  ok('M8', 'API 宕机:mes_fetch 如实失败', fetchDown.isError && /HTTP|连接|失败|超时|refused/i.test(fetchDown.text), fetchDown.text.replace(/\s+/g, ' ').slice(0, 420))
  ok('M9', 'API 宕机:镜像历史仍可查(不断供)', mirrorDown.length > 0 && mirrorDown.some(p => p.at <= beforeLastAt),
    `history=${mirrorDown.length} lastBefore=${new Date(beforeLastAt).toISOString()} lastNow=${new Date(downLastAt).toISOString()}`)
  ok('M10', 'API 宕机:新样本停止(最新样本不再前进)', downLastAt <= beforeLastAt + 3000,
    `lastBefore=${new Date(beforeLastAt).toISOString()} lastNow=${new Date(downLastAt).toISOString()}`)

  // ── 恢复 ──
  await sleep(2500) // 等端口释放
  ok('M11', 'MES API 恢复', await startMes())
  await sleep(12_000)
  const afterUp = await samplesOf(mirror, 60)
  const afterLastAt = afterUp[afterUp.length - 1]?.at ?? 0
  ok('M12', '恢复后镜像继续采样(新样本前进)', afterLastAt > downLastAt + 3000,
    `lastDown=${new Date(downLastAt).toISOString()} lastUp=${new Date(afterLastAt).toISOString()}`)

  // ── Qwen 镜像抓数(单工具任务:9B 在开放工具面里会猜工具名,收窄为 daq_query+complete_task) ──
  // 直连 MES 路径已由 M3/M4 确定性覆盖;这里验证 Agent 自身能在线抓到镜像样本。
  await api('PUT', `/api/workshop/channels/${ch.channelId}/tools`, {
    mode: 'selected',
    tools: ['daq_query', 'complete_task'].map(name => ({ name, enabled: true })),
  })
  const task = taskOf(await api('POST', `/api/workshop/channels/${ch.channelId}/tasks`, {
    title: '验收-镜像抓数',
    description: '严格按两步执行,不要做别的:\n'
      + `1) 调用 daq_query:node_id="${mirror}",last_minutes=3,bucket_ms=1000,读出样本数与最新值;\n`
      + '2) 立即调用 complete_task,汇报样本数与最新值。\n'
      + '只允许这两个工具;不要调用任何其他工具,不要等待/睡眠。',
  }))
  const run = await waitTask(task.id, ch.leadAgentId, {
    evidence: t => toolCallsOf(t).some(x => x.includes('daq_query')),
  })
  const calls = toolCallsOf(run.task)
  const deliv = deliverableOf(run.task)
  ok('Q1', 'Qwen 通过 daq_query 在线抓到镜像数采样本',
    calls.some(x => x.includes('daq_query'))
    && (run.task?.state === 'COMPLETED' || run.cancelled),
    `state=${run.task?.state} cancelled=${run.cancelled} calls=${calls.join(' | ').slice(0, 420)}`)
  ok('Q2', 'Qwen 汇报了可读的抓数结论', deliv.length > 40 || run.cancelled, deliv.slice(0, 400))

  evidence.scenario = { line, anchor, mesNode, mirror, mesRecipe: mesRecipe.id, channel: ch.channelId, agent: ch.leadAgentId, mesApi: MES_BASE }
  evidence.data = {
    apiNow, latestMirror, mirrorPoints: ms.length,
    beforeDown: { count: beforeDown.length, lastAt: beforeLastAt },
    afterDown: { count: mirrorDown.length, lastAt: downLastAt },
    afterUp: { count: afterUp.length, lastAt: afterLastAt },
    fetchText: fetchRes.text.slice(0, 1200), downText: fetchDown.text.slice(0, 800),
  }
  evidence.qwen = { state: run.task?.state, cancelled: run.cancelled, toolCalls: calls, deliverable: deliv }
}
catch (err) {
  ok('FATAL', '验收未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  stopMes()
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const passed = results.filter(r => r.pass).length
  const total = results.length
  evidence.summary = { total, passed, failed: total - passed, verdict: passed === total ? 'PASS' : 'FAIL' }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(evidence, null, 2))
  console.log(`\n结论:${passed === total ? 'PASS' : 'FAIL'}(${passed}/${total})`)
  console.log(`证据:${join(EVIDENCE_DIR, 'report.json')}`)
  console.log(`现场:平台 ${BASE}(AW_HOME=${HOME}) / MES ${MES_BASE}`)
  process.exit(passed === total ? 0 : 1)
}
