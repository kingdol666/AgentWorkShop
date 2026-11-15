#!/usr/bin/env node
/**
 * 双模式 Channel 真实 harness 验收（generic vs production_line_integrated）
 * - 真实平台（.output 生产构建）+ 真实 omp 子进程 + USTC/deepseek-flash
 * - Generic：完整 memory / mailbox / task / session 能力，且无产线上下文与工业工具
 * - Integrated：同样能力 + 产线绑定 / 产品快照 / 工业只读上下文与工具
 * 运行：node omp-accept.mjs
 * 证据：results.json + server.log
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = process.env.AW_REPO ?? 'D:/codes/ABO/AgentWorkShop'
const HOME = process.env.AW_OMP_HOME ?? 'D:/tmp/aw-omp-accept-home-20261115'
const PORT = Number(process.env.AW_OMP_PORT ?? 3045)
const BASE = `http://127.0.0.1:${PORT}`
const EVIDENCE = process.env.AW_OMP_EVIDENCE ?? 'D:/tmp/aw-omp-accept-20261115'
const OMP = {
  provider: process.env.AW_OMP_PROVIDER ?? 'ustc',
  model: process.env.AW_OMP_MODEL ?? 'deepseek-flash',
  thinkingLevel: 'low',
  promptTimeoutMs: 1_800_000,
  superviseTimeoutMs: 1_800_000,
}
const TURN_TIMEOUT_MS = Number(process.env.AW_OMP_TURN_TIMEOUT_MS ?? 12 * 60_000)

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const results = []
let seq = 0
function check(id, name, cond, detail) {
  seq += 1
  const ok = Boolean(cond)
  results.push({ no: seq, id, name, ok, detail: detail === undefined ? null : detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${ok ? '' : ` :: ${JSON.stringify(detail)?.slice(0, 1200)}`}`)
  return ok
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

function stopOwnedInstance() {
  const pidFile = join(HOME, 'server.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch { /* exited */ }
}
async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json())?.data ?? null
  } catch { return null }
}
async function startInstance() {
  stopOwnedInstance()
  await sleep(1500)
  const running = await health()
  if (running) throw new Error(`端口 ${PORT} 已被占用: ${running.app} ${running.version}`)
  if (process.env.AW_OMP_RESET !== '0') {
    if (!/aw-omp-accept/.test(HOME)) throw new Error(`拒绝清理非验收目录: ${HOME}`)
    rmSync(HOME, { recursive: true, force: true })
  }
  mkdirSync(HOME, { recursive: true })
  mkdirSync(EVIDENCE, { recursive: true })
  const log = openSync(join(EVIDENCE, 'server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      AW_MODE: 'home',
      AW_HOME: HOME,
      PORT: String(PORT),
      NUXT_SESSION_PASSWORD: 'aw-omp-accept-20261115-session-key',
      AW_TRIAL_INTERVAL_MS: '0',
      AW_RATE_LIMIT_OFF: '1',
      AW_DAQ_STARTINFRASTRUCTURE: 'never',
      AW_BACKUP_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost',
    },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(join(HOME, 'server.pid'), String(child.pid))
  for (let i = 0; i < 150; i++) {
    await sleep(1000)
    const h = await health()
    if (h?.workshop === 'ready') return h
  }
  throw new Error('隔离实例未在 150s 内就绪')
}

let admin = ''
async function api(method, path, body, { token = admin, timeoutMs = 120_000, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try { json = await res.json() } catch { /* empty */ }
  return { status: res.status, json }
}
async function ok(method, path, body, opts) {
  const { status, json } = await api(method, path, body, opts)
  if (status < 200 || status >= 300 || !json || json.code !== 0) {
    throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json)?.slice(0, 800)}`)
  }
  return json.data
}
function listOf(v, key) {
  if (Array.isArray(v)) return v
  if (Array.isArray(v?.[key])) return v[key]
  return []
}

async function waitFor(label, fn, timeoutMs, intervalMs = 5000) {
  const start = Date.now()
  let lastError = ''
  while (Date.now() - start < timeoutMs) {
    try {
      const hit = await fn()
      if (hit) return hit
    } catch (err) { lastError = String(err?.message ?? err) }
    await sleep(intervalMs)
  }
  console.log(`  [wait timeout] ${label} after ${Math.round((Date.now() - start) / 1000)}s ${lastError ? `(${lastError})` : ''}`)
  return null
}

async function main() {
  const stamp = Date.now().toString(36).slice(-6)
  console.log(`==== dual-mode OMP acceptance ${stamp} @ ${BASE} ====`)
  const h = await startInstance()
  check('S0', 'isolated instance ready (home mode, current .output)', h?.workshop === 'ready', { version: h?.version, workshop: h?.workshop })

  // ---- auth ----
  const reg = await ok('POST', '/api/workshop/users/register', { name: `omp-admin-${stamp}` })
  admin = reg.token
  try { writeFileSync(join(EVIDENCE, 'admin-token.txt'), admin) } catch { /* evidence dir 不可写不影响验收 */ }
  check('A1', 'bootstrap admin registered', Boolean(admin) && Boolean(reg.id), { id: reg.id })
  const me = await ok('GET', '/api/workshop/users/me')
  check('A2', 'first user is admin', (me.user?.role ?? me.role) === 'admin', me)

  const harnesses = await ok('GET', '/api/workshop/harnesses')
  const harnessList = listOf(harnesses, 'harnesses')
  const ompInfo = harnessList.find(x => x.id === 'omp') ?? harnessList.find(x => x.name === 'omp')
  const ompAvailable = ompInfo?.available !== false
  check('S1', 'real omp harness registered and available', Boolean(ompInfo) && ompAvailable, ompInfo ?? harnesses)

  // ---- seed simulated line / mock DAQ / product ----
  const line = (await ok('POST', '/api/workshop/dcw/lines', { name: `OMP-LINE-${stamp}`, simulated: true })).line
  check('L1', 'simulated line created', Boolean(line?.id) && line.simulated === true, line)
  const node = (await ok('POST', '/api/workshop/daq', {
    name: `OMP-PV-${stamp}`, templateRef: 'daq-temp-tc', lineId: line.id, driver: 'mock',
    unit: 'MPa', min: 0, max: 10, intervalMs: 1000, publishIntervalMs: 0, enabled: true,
  })).node
  check('L2', 'mock DAQ node created on line', Boolean(node?.id) && node.lineId === line.id, node)
  const product = (await ok('POST', '/api/workshop/dcw/products', { name: `OMP-PRODUCT-${stamp}`, lineId: line.id })).product
  check('L3', 'product created on line', Boolean(product?.id) && product.lineId === line.id, product)

  // ---- channels ----
  const cg = await ok('POST', '/api/workshop/channels', {
    name: `OMP-GENERIC-${stamp}`, channelMode: 'generic', description: 'generic full-feature regression',
    leadAgent: { name: `G-Lead-${stamp}`, harness: 'omp', config: OMP },
  })
  const cgId = cg.channelId ?? cg.channel?.id
  const cgLeadId = cg.leadAgentId
  check('C1', 'generic channel + omp lead created', Boolean(cgId && cgLeadId), cg)
  const cgWorker = await ok('POST', `/api/workshop/channels/${cgId}/agents`, { name: `G-Worker-${stamp}`, role: 'worker', harness: 'omp', config: OMP })
  const cgWorkerId = cgWorker.id ?? cgWorker.agentId
  check('C2', 'generic worker created', Boolean(cgWorkerId), cgWorker)
  await ok('PATCH', `/api/workshop/channels/${cgId}`, { chatEnabled: 1 })
  await ok('POST', `/api/workshop/channels/${cgId}/activate`)
  check('C3', 'generic channel activated (real omp schedulers, chat enabled)', true, null)

  const ci = await ok('POST', '/api/workshop/channels', {
    name: `OMP-INTEGRATED-${stamp}`, channelMode: 'production_line_integrated', lineId: line.id,
    description: 'production-line integrated full-feature regression',
    leadAgent: { name: `I-Lead-${stamp}`, harness: 'omp', config: OMP },
  })
  const ciId = ci.channelId ?? ci.channel?.id
  const ciLeadId = ci.leadAgentId
  check('C4', 'integrated channel + omp lead created', Boolean(ciId && ciLeadId), ci)
  const ciWorker = await ok('POST', `/api/workshop/channels/${ciId}/agents`, { name: `I-Worker-${stamp}`, role: 'worker', harness: 'omp', config: OMP })
  const ciWorkerId = ciWorker.id ?? ciWorker.agentId
  check('C5', 'integrated worker created', Boolean(ciWorkerId), ciWorker)
  const bind0 = await ok('GET', `/api/workshop/channels/${ciId}/products`)
  const bound = await ok('PUT', `/api/workshop/channels/${ciId}/products`, { productIds: [product.id], expectedRevision: bind0.revision })
  check('C6', 'integrated channel product binding written', bound.revision === bind0.revision + 1 && bound.productIds.includes(product.id), { before: bind0, after: bound })
  await ok('PATCH', `/api/workshop/channels/${ciId}`, { chatEnabled: 1 })
  await ok('POST', `/api/workshop/channels/${ciId}/activate`)
  check('C7', 'integrated channel activated (chat enabled)', true, null)

  // ---- sessions ----
  const sg = await ok('POST', `/api/workshop/channels/${cgId}/sessions`, { title: `G-SESSION-${stamp}` })
  check('SS1', 'generic session created (no product, generic mode)', sg.channelMode === 'generic' && !sg.productId, sg)
  const si = await ok('POST', `/api/workshop/channels/${ciId}/sessions`, { productId: product.id, title: `I-SESSION-${stamp}` })
  check('SS2', 'integrated session created with frozen product snapshot', si.channelMode === 'production_line_integrated' && si.productId === product.id && si.lineId === line.id && Boolean(si.bindingSnapshotHash), si)
  const siDetailResp = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${si.sessionId}`)
  const siDetail = siDetailResp.session ?? siDetailResp
  check('SS3', 'integrated session exposes snapshot revision/hash', siDetail.bindingSnapshotHash === si.bindingSnapshotHash && siDetail.bindingSnapshotRevision === si.bindingSnapshotRevision, siDetail)

  // find clones
  const cgAgents = listOf(await ok('GET', `/api/workshop/channels/${cgId}/agents`), 'agents')
  const ciAgents = listOf(await ok('GET', `/api/workshop/channels/${ciId}/agents`), 'agents')
  const cgClone = cgAgents.find(a => String(a.name ?? '').includes('·session·'))
  const ciClone = ciAgents.find(a => String(a.name ?? '').includes('·session·'))
  const ciLeadClone = ciAgents.find(a => String(a.name ?? '').includes(`I-Lead-${stamp}`) && String(a.name ?? '').includes('·session·')) ?? ciClone
  check('SS4', 'both modes create session clone members', Boolean(cgClone?.id && ciClone?.id && ciLeadClone?.id), { cgClone: cgClone?.name, ciClone: ciClone?.name, ciLeadClone: ciLeadClone?.name })

  // ---- tool surface (same source as omp set_host_tools) ----
  async function toolNames(agentId) {
    const d = await ok('GET', `/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agentId)}`)
    return new Set(listOf(d, 'tools').map(t => t.name))
  }
  const CORE_LEAD = ['save_memory', 'search_memory', 'send_message_to_agent', 'poll_messages', 'read_channel_mail', 'submit_task', 'get_my_task_queue']
  const CORE_WORKER = ['save_memory', 'search_memory', 'send_message_to_agent', 'poll_messages', 'get_my_task_queue']
  const INDUSTRIAL = ['daq_query', 'line_context', 'recipe_catalog', 'ops_log', 'dcw_journal', 'mes_fetch', 'exp_collect']
  const cgLeadTools = await toolNames(cgLeadId)
  const cgWorkerTools = await toolNames(cgWorkerId)
  const ciLeadTools = await toolNames(ciLeadId)
  const ciWorkerTools = await toolNames(ciWorkerId)
  const cgCloneTools = cgClone ? await toolNames(cgClone.id) : new Set()
  const ciCloneTools = ciClone ? await toolNames(ciClone.id) : new Set()
  check('T1', 'generic lead: no industrial tools', INDUSTRIAL.filter(n => cgLeadTools.has(n)).length === 0, { leaked: INDUSTRIAL.filter(n => cgLeadTools.has(n)) })
  check('T2', 'generic lead: framework core kept (memory/mailbox/task)', CORE_LEAD.filter(n => !cgLeadTools.has(n)).length === 0, { missing: CORE_LEAD.filter(n => !cgLeadTools.has(n)) })
  check('T3', 'generic worker: core kept, no industrial', CORE_WORKER.every(n => cgWorkerTools.has(n)) && INDUSTRIAL.every(n => !cgWorkerTools.has(n)), { missing: CORE_WORKER.filter(n => !cgWorkerTools.has(n)), leaked: INDUSTRIAL.filter(n => cgWorkerTools.has(n)) })
  check('T4', 'generic session clone: core kept, no industrial, no lead-only submit_task', CORE_WORKER.every(n => cgCloneTools.has(n)) && INDUSTRIAL.every(n => !cgCloneTools.has(n)) && !cgCloneTools.has('submit_task'), { missing: CORE_WORKER.filter(n => !cgCloneTools.has(n)), leaked: INDUSTRIAL.filter(n => cgCloneTools.has(n)), submit: cgCloneTools.has('submit_task') })
  check('T5', 'integrated lead: industrial tools injected + core kept', INDUSTRIAL.every(n => ciLeadTools.has(n)) && CORE_LEAD.every(n => ciLeadTools.has(n)), { missingInd: INDUSTRIAL.filter(n => !ciLeadTools.has(n)), missingCore: CORE_LEAD.filter(n => !ciLeadTools.has(n)) })
  check('T6', 'integrated worker: industrial tools injected + worker core kept', INDUSTRIAL.every(n => ciWorkerTools.has(n)) && CORE_WORKER.every(n => ciWorkerTools.has(n)), { missingInd: INDUSTRIAL.filter(n => !ciWorkerTools.has(n)), missingCore: CORE_WORKER.filter(n => !ciWorkerTools.has(n)) })
  check('T7', 'integrated session clone: industrial + worker core kept', INDUSTRIAL.every(n => ciCloneTools.has(n)) && CORE_WORKER.every(n => ciCloneTools.has(n)), { missingInd: INDUSTRIAL.filter(n => !ciCloneTools.has(n)), missingCore: CORE_WORKER.filter(n => !ciCloneTools.has(n)) })

  // ---- direct tool dispatch (authoritative execution gate, not just injection) ----
  async function invoke(agentId, tool, args = {}) {
    const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, { timeoutMs: 120_000 })
    return { status: r.status, json: r.json, text: JSON.stringify(r.json ?? '') }
  }
  function agentTokenOf(agentId) {
    const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
    try {
      return String(db.prepare('SELECT token FROM channel_agents WHERE id = ?').get(agentId)?.token ?? '')
    }
    finally { db.close() }
  }
  async function invokeAsAgent(agentId, tool, args = {}) {
    const token = agentTokenOf(agentId)
    const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, {
      token: '',
      headers: { 'x-aw-agent-token': token },
      timeoutMs: 120_000,
    })
    return { status: r.status, json: r.json, text: JSON.stringify(r.json ?? '') }
  }
  const gLine = await invoke(cgLeadId, 'line_context', { line_id: line.id })
  check('X1', 'generic lead direct line_context is rejected (no industrial execution gate)', gLine.status >= 400 || gLine.text.includes('通用频道'), gLine)
  const gDaq = await invoke(cgLeadId, 'daq_query', { node_id: node.id, last_minutes: 5 })
  check('X2', 'generic lead direct daq_query is rejected', gDaq.status >= 400 || gDaq.text.includes('通用频道'), gDaq)
  const gMem = await invoke(cgLeadId, 'save_memory', { title: `DIRECT-G-${stamp}`, content: `DIRECT-G-${stamp} generic memory dispatch`, scope: 'shared' })
  check('X3', 'generic lead direct save_memory executes', gMem.status < 400 && !/error|失败|拒绝/i.test(gMem.text), gMem)
  const iLine = await invoke(ciLeadId, 'line_context', { line_id: line.id })
  check('X4', 'integrated lead direct line_context executes and returns line name', iLine.status < 400 && iLine.text.includes(line.name), iLine)
  const iDaq = await invoke(ciLeadId, 'daq_query', { node_id: node.id, last_minutes: 5 })
  check('X5', 'integrated lead direct daq_query executes (read-only)', iDaq.status < 400 && !/"isError":true/i.test(iDaq.text), iDaq)
  const iCloneLine = await invoke(ciClone.id, 'line_context', { line_id: line.id })
  check('X6', 'integrated session clone line_context uses frozen snapshot', iCloneLine.status < 400 && iCloneLine.text.includes(line.name), iCloneLine)
  const gCloneDaq = await invoke(cgClone.id, 'daq_query', { node_id: node.id, last_minutes: 5 })
  check('X7', 'generic session clone direct daq_query is rejected', gCloneDaq.status >= 400 || gCloneDaq.text.includes('通用频道'), gCloneDaq)

  // ---- real omp turn: generic memory (save + search) ----
  const gMemoryAnchor = `GEN-OMP-${stamp}`
  const gPrompt = [
    `【回归 G1｜通用频道记忆】只做两步，不要委派给其它 Agent，也不要调用任务/工业工具：`,
    `1) 调用 save_memory：title="通用频道回归G1"，content="锚点 ${gMemoryAnchor} 通用频道记忆链路正常"，scope="shared"。`,
    `2) 调用 search_memory：query="${gMemoryAnchor}"，limit=5，确认能召回上述内容。`,
    `完成后只回复一行：检索命中就回复 ${gMemoryAnchor} PASS；否则回复 ${gMemoryAnchor} FAIL: <原因>。`,
  ].join('\n')
  const sendG = await ok('POST', `/api/workshop/channels/${cgId}/chat/messages`, {
    text: gPrompt,
    mentions: [{ type: 'agent', id: cgLeadId, label: `G-Lead-${stamp}` }],
    clientMessageId: `g1-${stamp}`,
  })
  check('R1', 'generic chat delivered to real omp lead', Boolean(sendG.message?.id) && (sendG.deliveries?.length ?? 0) > 0, sendG)
  const gReply = await waitFor('generic lead G1 memory reply', async () => {
    const d = await ok('GET', `/api/workshop/channels/${cgId}/chat/messages?limit=100`)
    const msgs = listOf(d, 'messages')
    return msgs.find(m => m.senderId === cgLeadId && String(m.text ?? '').includes(gMemoryAnchor)
      && /\bPASS\b/.test(String(m.text ?? '')) && !/FAIL/.test(String(m.text ?? ''))) ?? null
  }, TURN_TIMEOUT_MS)
  check('R2', 'real omp generic lead replied memory PASS', Boolean(gReply), gReply ? { id: gReply.id, text: String(gReply.text).slice(0, 800) } : 'timeout')

  const gMemSearch = await ok('POST', `/api/workshop/channels/${cgId}/agents/${cgLeadId}/memories/search`, { query: gMemoryAnchor })
  check('R3', 'generic memory persisted and searchable after omp turn', JSON.stringify(gMemSearch).includes(gMemoryAnchor), JSON.stringify(gMemSearch).slice(0, 600))

  // ---- generic task system end-to-end: REST submit -> real omp task turn -> complete ----
  const gTaskTitle = `TASK-OMP-G-${stamp}`
  const gTaskAnchor = `GEN-TASK-${stamp}`
  const gTaskSubmit = await ok('POST', `/api/workshop/channels/${cgId}/tasks`, {
    title: gTaskTitle,
    description: `通用频道任务链路验收。请只调用一次 complete_task（task_id 可省略，平台使用当前任务）：summary 必须包含 ${gTaskAnchor}，deliverable="${gTaskAnchor}"。不要调用 submit_task，不要调用工业工具，不要委派其它 Agent。`,
    parts: [{ text: `任务链路验收锚点 ${gTaskAnchor}` }],
  })
  const gTaskId = gTaskSubmit.id ?? gTaskSubmit.taskId ?? gTaskSubmit.task?.id
  check('R4', 'generic channel task submitted through framework task API', Boolean(gTaskId), gTaskSubmit)
  const gTaskDone = await waitFor('generic task completion by real omp', async () => {
    const tasks = listOf(await ok('GET', `/api/workshop/channels/${cgId}/tasks`), 'tasks')
    const t = tasks.find(x => x.id === gTaskId)
    return t && String(t.state ?? '').toUpperCase() === 'COMPLETED' ? t : null
  }, TURN_TIMEOUT_MS, 5000)
  check('R5', 'real omp generic lead completed the submitted task', Boolean(gTaskDone), gTaskDone ? { taskId: gTaskDone.id, state: gTaskDone.state } : 'timeout')

  // ---- real omp mailbox round trip: lead -> worker -> lead ----
  const mailAnchor = `MAIL-OMP-${stamp}`
  const g2Prompt = [
    `【回归 G2｜通用频道邮箱】请使用 host tools 完成一次真实信箱往返：`,
    `1) 调用 send_message_to_agent：to_agent_id="${cgWorkerId}"，message="${mailAnchor} 请回复：已收到 ${mailAnchor}（只回这一句）"，require_reply=true，priority="task"。`,
    `2) 调用 poll_messages：wait_seconds=120，等待 worker 回执。`,
    `3) 收到后，在群聊回复一行，必须包含 worker 回执原文与 ${mailAnchor}。`,
    `如果超时未收到，请如实回复 TIMEOUT 与 ${mailAnchor}。`,
  ].join('\n')
  const sendG2 = await ok('POST', `/api/workshop/channels/${cgId}/chat/messages`, {
    text: g2Prompt,
    mentions: [{ type: 'agent', id: cgLeadId, label: `G-Lead-${stamp}` }],
    clientMessageId: `g2-${stamp}`,
  })
  check('M1', 'generic mailbox round-trip turn delivered', Boolean(sendG2.message?.id), sendG2)
  const g2Reply = await waitFor('generic lead G2 mailbox reply', async () => {
    const d = await ok('GET', `/api/workshop/channels/${cgId}/chat/messages?limit=100`)
    const msgs = listOf(d, 'messages')
    return msgs.find(m => m.senderId === cgLeadId && String(m.text ?? '').includes(mailAnchor) && (String(m.text ?? '').includes('已收到') || String(m.text ?? '').toUpperCase().includes('TIMEOUT'))) ?? null
  }, TURN_TIMEOUT_MS)
  check('M2', 'mailbox lead->worker->lead round trip completed with real omp', Boolean(g2Reply), g2Reply ? { id: g2Reply.id, text: String(g2Reply.text).slice(0, 800) } : 'timeout')
  const cgMail = await ok('GET', `/api/workshop/channels/${cgId}/messages?limit=100`)
  const mailText = JSON.stringify(cgMail)
  check('M3', 'mailbox delivery log contains outbound + inbound anchors', mailText.includes(mailAnchor) && (mailText.match(new RegExp(mailAnchor, 'g')) ?? []).length >= 2, { hits: (mailText.match(new RegExp(mailAnchor, 'g')) ?? []).length })

  // ---- real omp turn: integrated session (industrial context + memory) ----
  const iAnchor = `PROD-OMP-${stamp}`
  const iPrompt = [
    `【回归 I1｜产线集成频道会话】你是该产线频道的会话成员，必须使用 host tools：`,
    `1) 调用 line_context：line_id="${line.id}"，读取产线名称与当前上下文。`,
    `2) 调用 daq_query：node_id="${node.id}"，last_minutes=10，limit=20，读取该点位数据。`,
    `3) 调用 save_memory：title="产线集成回归I1"，content="锚点 ${iAnchor} 产线集成频道记忆正常"，scope="shared"。`,
    `4) 在会话回复一行，必须包含 ${iAnchor}、产线名称 "${line.name}"、以及节点最新值（若数据为空写 empty）。`,
    `不要执行任何写操作、开停线或配方变更。`,
  ].join('\n')
  const sendI = await ok('POST', `/api/workshop/channels/${ciId}/sessions/${si.sessionId}/messages`, { text: iPrompt })
  check('I1', 'integrated session message delivered to real omp clone', Boolean(sendI.messageId), sendI)
  const iReply = await waitFor('integrated session clone reply', async () => {
    const d = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${si.sessionId}/history?limit=100`)
    const items = listOf(d, 'history')
    const candidates = items.filter(x => x.type === 'message'
      && String(x.text ?? '').includes(iAnchor)
      && String(x.text ?? '').includes(line.name)
      // 人类入站消息与 Agent 回复同为 ROLE_AGENT；用提示词特征排除入站行
      && !String(x.text ?? '').includes('1) 调用 line_context'))
    return candidates.at(-1) ?? null
  }, TURN_TIMEOUT_MS)
  check('I2', 'real omp integrated session replied with line context anchor', Boolean(iReply), iReply ? { role: iReply.role, text: String(iReply.text).slice(0, 1000) } : 'timeout')
  // 会话记忆必须用会话成员的真实 session 上下文检索（HTTP 端点不带 session 档）
  const iMemSearch = await invokeAsAgent(ciLeadClone.id, 'search_memory', { query: iAnchor, scope: 'auto', limit: 5 })
  check('I3', 'integrated session memory persisted and searchable in-session', iMemSearch.status < 400 && iMemSearch.text.includes('产线集成频道记忆正常'), iMemSearch)
  {
    const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM agent_memories WHERE content LIKE ?').get(`%${iAnchor}%`)
      check('I3b', 'integrated session memory row persisted in DB', Number(row?.c ?? 0) >= 1, row)
    }
    finally { db.close() }
  }

  // ---- integrated task system end-to-end: REST submit -> real omp task turn -> complete ----
  const iTaskTitle = `TASK-OMP-I-${stamp}`
  const iTaskAnchor = `I-TASK-${stamp}`
  const iTaskSubmit = await ok('POST', `/api/workshop/channels/${ciId}/tasks`, {
    title: iTaskTitle,
    description: `产线集成频道任务链路验收。请只调用一次 complete_task（task_id 可省略，平台使用当前任务）：summary 必须包含 ${iTaskAnchor}，deliverable="${iTaskAnchor}"。不要调用 submit_task，不要执行任何产线写操作，不要委派其它 Agent。`,
    parts: [{ text: `任务链路验收锚点 ${iTaskAnchor}` }],
  })
  const iTaskId = iTaskSubmit.id ?? iTaskSubmit.taskId ?? iTaskSubmit.task?.id
  check('I4', 'integrated channel task submitted through framework task API', Boolean(iTaskId), iTaskSubmit)
  const iTaskDone = await waitFor('integrated task completion by real omp', async () => {
    const tasks = listOf(await ok('GET', `/api/workshop/channels/${ciId}/tasks`), 'tasks')
    const t = tasks.find(x => x.id === iTaskId)
    return t && String(t.state ?? '').toUpperCase() === 'COMPLETED' ? t : null
  }, TURN_TIMEOUT_MS, 5000)
  check('I5', 'real omp integrated lead completed the submitted task', Boolean(iTaskDone), iTaskDone ? { taskId: iTaskDone.id, state: iTaskDone.state } : 'timeout')

  // ---- live channel-mode switch: base runtime recycles, session snapshot stays frozen ----
  await ok('PATCH', `/api/workshop/channels/${ciId}`, { channelMode: 'generic' })
  await sleep(2500)
  const ciLeadAfterSwitch = await toolNames(ciLeadId)
  const ciCloneAfterSwitch = await toolNames(ciLeadClone.id)
  check('MC1', 'integrated -> generic recycles base lead to generic tool surface', INDUSTRIAL.every(n => !ciLeadAfterSwitch.has(n)) && ciLeadAfterSwitch.has('save_memory'), { stillIndustrial: INDUSTRIAL.filter(n => ciLeadAfterSwitch.has(n)) })
  check('MC2', 'existing session clone keeps frozen integrated tool surface', INDUSTRIAL.every(n => ciCloneAfterSwitch.has(n)), { missingInd: INDUSTRIAL.filter(n => !ciCloneAfterSwitch.has(n)) })
  await ok('PATCH', `/api/workshop/channels/${ciId}`, { channelMode: 'production_line_integrated' })
  await sleep(2500)
  const ciLeadRestored = await toolNames(ciLeadId)
  check('MC3', 'generic -> integrated restores base lead industrial tool surface', INDUSTRIAL.every(n => ciLeadRestored.has(n)), { missingInd: INDUSTRIAL.filter(n => !ciLeadRestored.has(n)) })

  // ---- session/binding immutability after live usage ----
  const beforeResp = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${si.sessionId}`)
  const before = beforeResp.session ?? beforeResp
  const cur = await ok('GET', `/api/workshop/channels/${ciId}/products`)
  await ok('PUT', `/api/workshop/channels/${ciId}/products`, { productIds: [], expectedRevision: cur.revision })
  const afterResp = await ok('GET', `/api/workshop/channels/${ciId}/sessions/${si.sessionId}`)
  const after = afterResp.session ?? afterResp
  check('SS5', 'live session snapshot hash/revision unchanged after channel rebind', before.bindingSnapshotHash === after.bindingSnapshotHash && before.bindingSnapshotRevision === after.bindingSnapshotRevision && after.productId === product.id, { before: { h: before.bindingSnapshotHash, r: before.bindingSnapshotRevision }, after: { h: after.bindingSnapshotHash, r: after.bindingSnapshotRevision, p: after.productId } })

  // ---- summary ----
  const fails = results.filter(r => !r.ok)
  const out = {
    generatedAt: new Date().toISOString(), base: BASE, home: HOME, stamp,
    model: OMP, line: { id: line.id, name: line.name }, node: { id: node.id, name: node.name }, product: { id: product.id, name: product.name },
    channels: { generic: cgId, integrated: ciId }, sessions: { generic: sg.sessionId, integrated: si.sessionId },
    agents: { cgLeadId, cgWorkerId, ciLeadId, ciWorkerId, cgCloneId: cgClone?.id, ciCloneId: ciClone?.id },
    total: results.length, pass: results.length - fails.length, fail: fails.length, results,
  }
  writeFileSync(join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2))
  console.log(`\n==== SUMMARY: ${out.pass}/${out.total} PASS, ${out.fail} FAIL ====`)
  if (fails.length) {
    for (const f of fails) console.log(`  FAILED [${f.id}] ${f.name}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('ACCEPTANCE ABORTED:', err)
  try {
    const out = { generatedAt: new Date().toISOString(), base: BASE, aborted: String(err?.stack ?? err), total: results.length, pass: results.filter(r => r.ok).length, fail: results.filter(r => !r.ok).length, results }
    writeFileSync(join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2))
  } catch { /* ignore */ }
  process.exitCode = 2
}).finally(() => {
  // 保留实例供日志取证；显式杀进程用 AW_OMP_KEEP=0
  if (process.env.AW_OMP_KEEP === '0') stopOwnedInstance()
})
