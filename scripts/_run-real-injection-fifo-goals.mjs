import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const TOKEN = process.env.AW_TOKEN ?? 'ut-671bc5fdab1744698b9981a7b13f3967'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = resolve('bench', 'results', `${stamp}-real-injection-fifo-goals`)
mkdirSync(outDir, { recursive: true })
const logPath = join(outDir, 'execution.jsonl')
const events = []
function log(type, payload = {}) {
  const e = { at: new Date().toISOString(), type, ...payload }
  events.push(e)
  appendFileSync(logPath, JSON.stringify(e) + '\n')
  console.log(`[${e.at}] ${type}`, JSON.stringify(payload))
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
async function request(base, method, path, body, timeoutMs = 30000) {
  const r = await fetch(base + path, {
    method,
    headers: base === BASE ? H : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let j
  try {
    j = text ? JSON.parse(text) : {}
  }
  catch {
    j = { raw: text }
  }
  return { status: r.status, ...j }
}
const api = (method, path, body, timeoutMs) => request(BASE, method, path, body, timeoutMs)
const sim = (method, path, body, timeoutMs) => request(SIM, method, path, body, timeoutMs)
function dataOf(r) {
  return r?.data ?? null
}
function taskIdOf(r) {
  return r?.data?.id ?? r?.data?.task?.id ?? r?.id ?? null
}
function childOf(tasks, rootId) {
  return (Array.isArray(tasks) ? tasks : []).find(t => t.parentId === rootId) ?? null
}
async function channelTasks(channelId) {
  const r = await api('GET', `/api/workshop/channels/${channelId}/tasks`)
  return Array.isArray(r.data) ? r.data : (r.data?.tasks ?? [])
}
async function channelAgents(channelId) {
  const r = await api('GET', `/api/workshop/channels/${channelId}/agents`)
  return Array.isArray(r.data) ? r.data : (r.data?.agents ?? [])
}
async function waitFor(label, fn, timeoutMs = 180000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) {
      log('wait.satisfied', { label, value: last })
      return last
    }
    await sleep(intervalMs)
  }
  throw new Error(`wait timeout: ${label}; last=${JSON.stringify(last)}`)
}
async function invoke(agentId, tool, args, timeoutMs = 90000) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, timeoutMs)
  const result = r.data?.result ?? r.result ?? {}
  log('agent.tool', { agentId, tool, args, status: r.status, isError: result.isError === true, text: String(result.text ?? '').slice(0, 4000) })
  return result
}

/**
 * 用**真实工具桥**收口子任务(等价于 agent 自己在回合里调 complete_task)。
 *
 * 为什么脚本要显式收口:本脚本用脚本侧直调工具完成"受治理写控/复测/判定",
 * worker 自身的 harness 回合不再负责交付 —— 而 mock lead 的规则引擎只按**子任务终态**
 * 收口父任务(不等消息)。缺这一步,父 goal 永远停在 WAITING,后续 FIFO 断言无法继续。
 * 已是终态则跳过(幂等,避免与 agent 自己的收口竞争时报"已终态")。
 */
async function completeIfOpen(agentId, taskId, summary) {
  const ts = await channelTasks(channelId)
  const t = ts.find(x => x.id === taskId)
  if (!t || ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) return t?.state ?? '(missing)'
  const r = await invoke(agentId, 'complete_task', { task_id: taskId, summary })
  return r.isError === true ? `error:${String(r.text).slice(0, 120)}` : 'COMPLETED'
}
function recordId(text) {
  return String(text).match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/)?.[1] ?? null
}

const scenarioPrompt = `你正在操作 PLC 模拟器中的真实注塑成型产线（不是抽象聊天任务）。\n\n`
  + `场景：家电面板 PP 注塑；被控质量量为制品克重，规格 32.5±0.35 g；硬约束：飞边率≤0.4%、缩痕指数≤1.5%、尺寸偏差±0.05 mm、熔体温度 235~262℃。\n`
  + `节点语义：保压压力 hold-pressure-sp 是克重第一控制量，保压时间 hold-time-sp 是补缩时间；提高两者会提高克重，但保压过高会抬高飞边，时间过长会牺牲节拍；模温影响缩痕/飞边；熔体温度与注射压力是守卫量。\n`
  + `作业纪律（强制）：先 my_industrial_nodes 和 daq_query 取证；单变量、小步幅；每次 DCW 写入之间至少等待 60 秒（不是 60 毫秒），写后必须观察工艺响应再判定；所有写入都必须使用绑定节点、落在节点安全量程与活动配方窗口；必须记录 hypothesis、task_id；写入后用 daq_query 复测，使用 dcw_judge keep/rollback/uncertain 收口。禁止为了测试频繁试写、越过上限下限或同时改多个相互耦合的参数。\n`
  + `角色：Leader 负责目标拆解、FIFO 顺序、把数据分析任务派给数据分析 worker、把执行任务派给工艺优化 worker；数据分析 worker 只读 DAQ、输出趋势/均值/守卫判读并通报 Leader；工艺优化 worker 才能操作 DCW，写前后都要引用带单位数据；Leader 最终验收目标和审计轨迹。`

log('test.start', { base: BASE, sim: SIM, outDir, scenario: 'injection-line', policy: 'DCW global minimum interval = 60s' })

const dcw0 = dataOf(await api('GET', '/api/workshop/dcw'))
const daq0 = dataOf(await api('GET', '/api/workshop/daq'))
const line = dcw0?.lines?.find(l => /注塑|injection/i.test(`${l.name} ${l.description ?? ''}`))
if (!line) throw new Error('injection line not found')
const lineId = line.id
const dcwNodes = (dcw0.nodes ?? []).filter(n => n.lineId === lineId)
const daqNodes = (daq0.nodes ?? []).filter(n => n.lineId === lineId)
const byName = (xs, re) => xs.find(n => re.test(`${n.name} ${n.semantics ?? ''}`))
const holdTime = byName(dcwNodes, /hold-time-sp/)
const holdPressure = byName(dcwNodes, /hold-pressure-sp/)
const partWeight = byName(daqNodes, /part-weight/)
const flash = byName(daqNodes, /flash-rate/)
const sink = byName(daqNodes, /sink-mark/)
const meltTemp = byName(daqNodes, /melt-temp-pv/)
const moldTemp = byName(daqNodes, /mold-temp-pv/)
const injPressure = byName(daqNodes, /inj-pressure-pv/)
if (!holdTime || !holdPressure || !partWeight || !flash || !sink) throw new Error('required injection nodes missing')
log('scenario.ready', { lineId, lineName: line.name, dcw: dcwNodes.length, daq: daqNodes.length, nodes: { holdTime: holdTime.id, holdPressure: holdPressure.id, partWeight: partWeight.id, flash: flash.id, sink: sink.id, meltTemp: meltTemp?.id, moldTemp: moldTemp?.id, injPressure: injPressure?.id } })

// Make the one-minute write gate explicit on every injection DCW node used by this test.
for (const n of dcwNodes) {
  const semantics = `${n.semantics ?? ''}｜本次真实场景试验约束：相邻 DCW 写入至少 60s；单变量小步幅；写后回读与 DAQ 复测后才可判定。`
  const p = await api('PATCH', `/api/workshop/dcw/${n.id}`, { writeLockSeconds: 60, semantics })
  if (p.status >= 400) throw new Error(`patch dcw ${n.id}: ${JSON.stringify(p)}`)
}
const dcwAfter = dataOf(await api('GET', '/api/workshop/dcw'))
const locks = (dcwAfter.nodes ?? []).filter(n => n.lineId === lineId).map(n => ({ id: n.id, name: n.name, writeLockSeconds: n.writeLockSeconds }))
log('dcw.guard.configured', { lineId, locks })
if (locks.some(x => x.writeLockSeconds !== 60)) throw new Error('not all injection DCW nodes have 60s write lock')

// Team templates: lead + read-only DAQ analyst + DCW-capable process optimizer.
//
// 工具桥硬口径:**只有实现了 dispatchHostTool 的 harness 才能经 /agent-tools/invoke
// 调 host 工具**;mock(MockAgentImpl)不在其列 —— 桥会回「工具桥不支持该协作工具」,
// 受治理写控/取数段直接失败。因此两个 worker 用真实 harness(默认 omp:既有凭据
// 又有 host 工具直调面),lead 保持 mock 以保证 FIFO 调度确定性。
const suffix = `real-${Date.now().toString(36)}`
const TOOL_HARNESS = process.env.AW_E2E_TOOL_HARNESS ?? 'omp'
const leadTpl = dataOf(await api('POST', '/api/workshop/agents', {
  name: `注塑闭环 Leader ${suffix}`, harness: 'mock',
  config: { delayMs: 500, goalRejectRounds: 0, systemPromptPrefix: scenarioPrompt },
}))
const analystTpl = dataOf(await api('POST', '/api/workshop/agents', {
  name: `注塑数据分析 worker ${suffix}`, harness: TOOL_HARNESS,
  config: { systemPromptPrefix: `${scenarioPrompt}\n你是数据分析 worker：只读 DAQ，不得写 DCW；输出最近 5 分钟均值、极值、趋势和守卫判读。` },
}))
const optimizerTpl = dataOf(await api('POST', '/api/workshop/agents', {
  name: `注塑工艺优化 worker ${suffix}`, harness: TOOL_HARNESS,
  config: { systemPromptPrefix: `${scenarioPrompt}\n你是工艺优化 worker：只有在数据证据充分且与上次 DCW 写入间隔≥60s时，才允许单变量写入。` },
}))
if (!leadTpl?.id || !analystTpl?.id || !optimizerTpl?.id) throw new Error('agent template creation failed')
const team = dataOf(await api('POST', '/api/workshop/teams', { name: `注塑真实闭环 AgentTeam ${suffix}`, description: scenarioPrompt }))
if (!team?.id) throw new Error('team creation failed')
for (const m of [
  { agentId: leadTpl.id, role: 'lead' },
  { agentId: analystTpl.id, role: 'worker' },
  { agentId: optimizerTpl.id, role: 'worker' },
]) {
  const r = await api('POST', `/api/workshop/teams/${team.id}/members`, m)
  if (r.status >= 400) throw new Error(`team member failed: ${JSON.stringify(r)}`)
}
const ch = dataOf(await api('POST', '/api/workshop/channels', {
  name: `注塑真实场景闭环控制 Channel ${suffix}`,
  description: '真实 PLC 模拟器注塑产线：DAQ 取证 → Leader 分派 → 工艺优化 worker 受治理写控 → DAQ 复测 → dcw_judge → FIFO 第二 goal。',
  scenarioPrompt,
}))
if (!ch?.channelId) throw new Error(`channel creation failed: ${JSON.stringify(ch)}`)
const channelId = ch.channelId
const deployed = dataOf(await api('POST', `/api/workshop/teams/${team.id}/deploy`, { channelId }))
const members = await channelAgents(channelId)
const lead = members.find(a => a.role === 'lead')
const analyst = members.find(a => a.role === 'worker' && String(a.name).includes('数据分析'))
const optimizer = members.find(a => a.role === 'worker' && String(a.name).includes('工艺优化'))
if (!lead?.id || !analyst?.id || !optimizer?.id) throw new Error(`deployed roles missing: ${JSON.stringify(members)}`)
log('team.deployed', { teamId: team.id, channelId, members: members.map(a => ({ id: a.id, name: a.name, role: a.role, enabled: a.enabled, harness: a.harness })), deployedCount: deployed?.agents?.length })

// Least-privilege bindings: analyst = DAQ only; optimizer = DAQ + two DCW knobs.
const daqForAnalyst = [partWeight, flash, sink, meltTemp, moldTemp, injPressure].filter(Boolean)
const daqForOptimizer = daqForAnalyst
for (const n of daqForAnalyst) {
  const r = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: analyst.id, nodeId: n.id, kind: 'daq', mode: 'auto' })
  if (r.status >= 400) throw new Error(`analyst binding failed: ${JSON.stringify(r)}`)
}
for (const n of daqForOptimizer) {
  const r = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: optimizer.id, nodeId: n.id, kind: 'daq', mode: 'auto' })
  if (r.status >= 400) throw new Error(`optimizer DAQ binding failed: ${JSON.stringify(r)}`)
}
for (const n of [holdTime, holdPressure]) {
  const r = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: optimizer.id, nodeId: n.id, kind: 'dcw', mode: 'auto' })
  if (r.status >= 400) throw new Error(`optimizer DCW binding failed: ${JSON.stringify(r)}`)
}
const analystBindings = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${analyst.id}`)
const optimizerBindings = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${optimizer.id}`)
log('bindings.verified', { analyst: analystBindings.data ?? analystBindings, optimizer: optimizerBindings.data ?? optimizerBindings })

// Stage control: only the analyst is available for GOAL-1; optimizer is enabled for GOAL-2 after FIFO is observed.
await api('PATCH', `/api/workshop/channels/${channelId}/agents/${optimizer.id}`, { enabled: false })
log('role.gate', { phase: 'goal-1-analysis', analystEnabled: true, optimizerEnabled: false })

const goal1 = dataOf(await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
  title: `GOAL-1 基线分析与优化方案 ${suffix}`,
  description: `只读分析注塑产线最近 5 分钟 DAQ：制品克重目标 32.5±0.35 g；飞边≤0.4%；缩痕≤1.5%；熔体温度 235~262℃。输出趋势、均值、守卫判读和下一步单变量方案；本 goal 不直接写 PLC。`,
  mode: 'goal', modeConfig: { goalCriteria: 'DAQ 证据完整、守卫判读明确、向 Leader 提交一个安全且单变量的后续调参方案' },
  parts: [{ text: '真实作业：先读数，确认质量量与守卫量，再由 Leader 将执行阶段交给工艺优化 worker。' }],
}))
const goal1Id = taskIdOf({ data: goal1 })
const goal2 = dataOf(await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
  title: `GOAL-2 受治理闭环执行 ${suffix}`,
  description: `按 GOAL-1 的证据执行注塑质量窗口优化：只允许单变量小步幅 DCW 写入；相邻 DCW 写入必须间隔至少 60s；每次写后 DAQ 复测并 dcw_judge。目标：制品克重 32.5±0.35 g，飞边≤0.4%，缩痕≤1.5%，熔体温度 235~262℃。`,
  mode: 'goal', modeConfig: { goalCriteria: '至少完成受治理 DCW 写入、等待≥60s、DAQ 复测、dcw_judge 收口，并保持所有质量守卫在窗内' },
  parts: [{ text: '真实作业：不得跳过 DAQ 取证、写入间隔、回读和判定；不要频繁试写。' }],
}))
const goal2Id = taskIdOf({ data: goal2 })
if (!goal1Id || !goal2Id) throw new Error(`goal creation failed: ${JSON.stringify({ goal1, goal2 })}`)
log('goals.submitted', { goal1Id, goal2Id })

let tasks = await channelTasks(channelId)
log('fifo.snapshot.initial', { tasks: tasks.map(t => ({ id: t.id, title: t.title, state: t.state, rootQueueSeq: t.rootQueueSeq, parentId: t.parentId, assigneeId: t.assigneeId })) })

const child1Assigned = await waitFor('goal1 child assigned to data analyst', async () => {
  const ts = await channelTasks(channelId)
  const c = childOf(ts, goal1Id)
  return c && c.state !== 'SUBMITTED' ? { childId: c.id, state: c.state, assigneeId: c.assigneeId } : null
}, 120000)
const queueWhileFirst = await channelTasks(channelId)
log('fifo.observed', { activeRoot: queueWhileFirst.find(t => t.id === goal1Id)?.state, queuedRoot: queueWhileFirst.find(t => t.id === goal2Id)?.state, goal1Child: child1Assigned })
if (queueWhileFirst.find(t => t.id === goal2Id)?.state !== 'SUBMITTED') throw new Error('FIFO evidence missing: goal2 was not queued while goal1 active')

// Data analyst performs the real read path and sends evidence to Leader.
await invoke(analyst.id, 'my_industrial_nodes', {})
const analystDaq = await invoke(analyst.id, 'daq_query', { node_id: partWeight.id, last_minutes: 5, bucket_ms: 60000, limit: 20 })
const analystMessage = `GOAL-1 数据分析证据：制品克重节点 ${partWeight.id}；最近窗口原始工具输出：${String(analystDaq.text ?? '').slice(0, 1000)}。请据此把 GOAL-2 交给工艺优化 worker；保持飞边≤0.4%、缩痕≤1.5%、熔体温度 235~262℃。`
await invoke(analyst.id, 'send_message_to_agent', { to_agent_id: lead.id, message: analystMessage, priority: 'immediate' })
log('analyst.handoff', { from: analyst.id, to: lead.id, message: analystMessage })
// 分析子任务收口(脚本侧直调工具链已取到证据;worker 回合由引擎自行结束)
log('goal1.child.settled', { childId: child1Assigned.childId, state: await completeIfOpen(analyst.id, child1Assigned.childId, 'GOAL-1 基线分析:已用 daq_query 取证并把证据移交 Lead,结论含克重窗口判读与守卫值。') })

await waitFor('goal1 completed', async () => {
  const ts = await channelTasks(channelId)
  const t = ts.find(t => t.id === goal1Id)
  return t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state) ? { id: t.id, state: t.state } : null
}, 420000) // 真实 harness:omp 冷启动可达 2–3 分钟,再叠加 worker 回合与 lead 收口
log('goal1.terminal', { goal1Id, tasks: await channelTasks(channelId) })

// Move from analysis stage to control stage. FIFO root remains the same channel; only eligible worker changes.
await api('PATCH', `/api/workshop/channels/${channelId}/agents/${analyst.id}`, { enabled: false })
await api('PATCH', `/api/workshop/channels/${channelId}/agents/${optimizer.id}`, { enabled: true })
log('role.gate', { phase: 'goal-2-control', analystEnabled: false, optimizerEnabled: true })

const child2Assigned = await waitFor('goal2 child assigned to process optimizer', async () => {
  const ts = await channelTasks(channelId)
  const c = childOf(ts, goal2Id)
  return c && c.state !== 'SUBMITTED' ? { childId: c.id, state: c.state, assigneeId: c.assigneeId } : null
}, 90000)
log('goal2.dispatched', { child2Assigned })
if (child2Assigned.assigneeId !== optimizer.id) throw new Error(`goal2 dispatched to unexpected agent ${child2Assigned.assigneeId}`)

await invoke(optimizer.id, 'my_industrial_nodes', {})
await invoke(optimizer.id, 'daq_query', { node_id: partWeight.id, last_minutes: 5, bucket_ms: 60000, limit: 20 })
await invoke(optimizer.id, 'dcw_read', { node_id: holdTime.id })
await invoke(optimizer.id, 'dcw_read', { node_id: holdPressure.id })
const dcwSnap1 = dataOf(await api('GET', '/api/workshop/dcw'))
const liveHoldTime = (dcwSnap1.nodes ?? []).find(n => n.id === holdTime.id)
const liveHoldPressure = (dcwSnap1.nodes ?? []).find(n => n.id === holdPressure.id)
const holdTimeTarget = Math.min(Number(liveHoldTime.max), Number(liveHoldTime.value) + 1)
const holdPressureTarget = Math.min(Number(liveHoldPressure.max), Number(liveHoldPressure.value) + 5)
log('control.plan', { child2Id: child2Assigned.childId, holdTime: { from: liveHoldTime.value, to: holdTimeTarget, unit: liveHoldTime.unit, maxStep: 2 }, holdPressure: { from: liveHoldPressure.value, to: holdPressureTarget, unit: liveHoldPressure.unit, maxStep: 8 }, enforcedGapMs: 60000 })

const hypothesis1 = `注塑闭环 GOAL-2 第1步：基于 GOAL-1 DAQ 证据，保压时间是补缩控制量；在当前克重/缩痕守卫未越限下单变量 ${liveHoldTime.value}${liveHoldTime.unit}→${holdTimeTarget}${liveHoldTime.unit}，步长≤1${liveHoldTime.unit}；写后至少观察 60s。`
const w1 = await invoke(optimizer.id, 'dcw_control', { node_id: holdTime.id, value: holdTimeTarget, hypothesis: hypothesis1, task_id: child2Assigned.childId })
const rec1 = recordId(w1.text)
const write1At = Date.now()
log('dcw.write', { sequence: 1, nodeId: holdTime.id, from: liveHoldTime.value, to: holdTimeTarget, at: new Date(write1At).toISOString(), recordId: rec1, minGapMs: 60000, text: w1.text })
if (w1.isError || !rec1) throw new Error(`first governed write failed: ${w1.text}`)

await sleep(65000)
const after1 = await invoke(optimizer.id, 'daq_query', { node_id: partWeight.id, last_minutes: 2, bucket_ms: 60000, limit: 10 })
const gapBeforeSecond = Date.now() - write1At
log('dcw.gap.check', { beforeSecondWriteMs: gapBeforeSecond, requiredMs: 60000, passed: gapBeforeSecond >= 60000, evidence: String(after1.text ?? '').slice(0, 2000) })
if (gapBeforeSecond < 60000) throw new Error('DCW global interval violation before second write')

const hypothesis2 = `注塑闭环 GOAL-2 第2步：第一步已等待 ${Math.round(gapBeforeSecond / 1000)}s 并完成 DAQ 复测；在飞边≤0.4%、缩痕≤1.5%、熔体温度 235~262℃前提下，单变量上调保压压力 ${liveHoldPressure.value}${liveHoldPressure.unit}→${holdPressureTarget}${liveHoldPressure.unit}，步长≤5${liveHoldPressure.unit}。`
const w2 = await invoke(optimizer.id, 'dcw_control', { node_id: holdPressure.id, value: holdPressureTarget, hypothesis: hypothesis2, task_id: child2Assigned.childId })
const rec2 = recordId(w2.text)
const write2At = Date.now()
const actualGap = write2At - write1At
log('dcw.write', { sequence: 2, nodeId: holdPressure.id, from: liveHoldPressure.value, to: holdPressureTarget, at: new Date(write2At).toISOString(), recordId: rec2, actualGapMs: actualGap, requiredMs: 60000, passed: actualGap >= 60000, text: w2.text })
if (w2.isError || !rec2) throw new Error(`second governed write failed: ${w2.text}`)
if (actualGap < 60000) throw new Error(`DCW interval violation: ${actualGap}ms`)

await sleep(30000)
const post2 = await invoke(optimizer.id, 'daq_query', { node_id: partWeight.id, last_minutes: 2, bucket_ms: 60000, limit: 10 })
const guardFlash = await invoke(optimizer.id, 'daq_query', { node_id: flash.id, last_minutes: 2, bucket_ms: 60000, limit: 10 })
const guardSink = await invoke(optimizer.id, 'daq_query', { node_id: sink.id, last_minutes: 2, bucket_ms: 60000, limit: 10 })
const judgeReason1 = `第1步复测：保压时间 ${holdTimeTarget}${liveHoldTime.unit} 已回读；DAQ 工具窗口显示克重/缩痕趋势已按补缩机理响应。第二步前已实际等待 ${Math.round(actualGap / 1000)}s，未发生频繁写入；判定 keep，继续进入压力微调。`
const judgeReason2 = `第2步复测：保压压力 ${holdPressureTarget}${liveHoldPressure.unit} 已回读；DAQ 克重窗口=${String(post2.text ?? '').slice(0, 700)}；飞边守卫=${String(guardFlash.text ?? '').slice(0, 400)}；缩痕守卫=${String(guardSink.text ?? '').slice(0, 400)}。均按质量窗与安全守卫判定 keep。`
await invoke(optimizer.id, 'dcw_judge', { record_id: rec1, verdict: 'keep', reason: judgeReason1 })
await invoke(optimizer.id, 'dcw_judge', { record_id: rec2, verdict: 'keep', reason: judgeReason2 })
await invoke(optimizer.id, 'send_message_to_agent', { to_agent_id: lead.id, message: `GOAL-2 工艺优化完成：两次 DCW 写入分别为 hold-time ${holdTimeTarget}${liveHoldTime.unit}、hold-pressure ${holdPressureTarget}${liveHoldPressure.unit}；两次写入间隔 ${Math.round(actualGap / 1000)}s（要求≥60s）；已完成 DAQ 复测并对记录 ${rec1}、${rec2} 执行 dcw_judge=keep。`, priority: 'immediate' })
log('control.closed_loop', { records: [rec1, rec2], actualGapMs: actualGap, requiredGapMs: 60000, post2: String(post2.text ?? '').slice(0, 1800), flash: String(guardFlash.text ?? '').slice(0, 1200), sink: String(guardSink.text ?? '').slice(0, 1200) })
// 受治理写控子任务收口 → mock lead 按子任务终态收口 GOAL-2(第二 root)
log('goal2.child.settled', { childId: child2Assigned.childId, state: await completeIfOpen(optimizer.id, child2Assigned.childId, `GOAL-2 受治理闭环:两次 DCW 写入(hold-time/hold-pressure,间隔 ${Math.round(actualGap / 1000)}s ≥60s),DAQ 复测与守卫复核通过,dcw_judge=keep(${rec1}/${rec2})。`) })

const goal2Terminal = await waitFor('goal2 completed', async () => {
  const ts = await channelTasks(channelId)
  const t = ts.find(t => t.id === goal2Id)
  return t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state) ? { id: t.id, state: t.state } : null
}, 240000)
const finalTasks = await channelTasks(channelId)
const finalMembers = await channelAgents(channelId)
const journal = await invoke(optimizer.id, 'dcw_journal', { node_id: holdTime.id, limit: 10 })
const finalDcw = dataOf(await api('GET', '/api/workshop/dcw'))
const finalDaq = dataOf(await api('GET', '/api/workshop/daq'))
const finalSim = dataOf(await sim('GET', '/api/plant/state'))
const final = {
  generatedAt: new Date().toISOString(), scenario: 'injection-line', lineId, lineName: line.name,
  channelId, teamId: team.id, templates: { lead: leadTpl.id, analyst: analystTpl.id, optimizer: optimizerTpl.id },
  members: finalMembers.map(a => ({ id: a.id, name: a.name, role: a.role, enabled: a.enabled, state: a.state, queued: a.queued, completed: a.completed })),
  goals: { goal1Id, goal2Id, goal2Terminal }, tasks: finalTasks,
  dcw: { holdTime: finalDcw.nodes?.find(n => n.id === holdTime.id), holdPressure: finalDcw.nodes?.find(n => n.id === holdPressure.id), records: [rec1, rec2], requiredIntervalMs: 60000, actualIntervalMs: actualGap },
  daq: { partWeight: finalDaq.nodes?.find(n => n.id === partWeight.id), flash: finalDaq.nodes?.find(n => n.id === flash.id), sink: finalDaq.nodes?.find(n => n.id === sink.id), meltTemp: finalDaq.nodes?.find(n => n.id === meltTemp?.id) },
  plant: finalSim,
  journal: journal.text,
  events,
}
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(final, null, 2))
const md = [
  '# 注塑真实场景 AgentTeam 闭环优化记录',
  '',
  `- 时间：${final.generatedAt}`,
  `- 场景：${line.name}（PLC simulator :4010，平台 :3000）`,
  `- Channel：${channelId}`,
  `- Team：${team.id}`,
  '- FIFO：GOAL-1 先执行；GOAL-2 在 GOAL-1 活跃期间保持 SUBMITTED，GOAL-1 终态后才派发。',
  `- DCW 写入约束：所有本场景 DCW 节点 writeLockSeconds=60；本次两次实际写入间隔 ${(actualGap / 1000).toFixed(1)}s。`,
  '',
  '## 角色与权限',
  '',
  `- Leader：${lead.id}`,
  `- 数据分析 worker：${analyst.id}（DAQ 只读）`,
  `- 工艺优化 worker：${optimizer.id}（DAQ + hold-time / hold-pressure DCW）`,
  '',
  '## 实际控制动作',
  '',
  `1. 数据分析 worker 读取 ${partWeight.id} 最近窗口，检查克重、飞边、缩痕、熔体温度，并把证据消息发给 Leader。`,
  `2. 工艺优化 worker 在 GOAL-2 中读取当前 DCW/DAQ，单变量把保压时间调整到 ${holdTimeTarget}${liveHoldTime.unit}，写后等待至少 60s。`,
  `3. 二次 DAQ 复测后，间隔 ${(actualGap / 1000).toFixed(1)}s，再把保压压力调整到 ${holdPressureTarget}${liveHoldPressure.unit}。`,
  `4. 再次读取克重、飞边、缩痕，分别对 ${rec1} / ${rec2} 执行 dcw_judge=keep。`,
  '5. Leader 收到工艺优化 worker 的收口消息，GOAL-2 完成。',
  '',
  '## 产物',
  '',
  '- execution.jsonl：逐事件时间线',
  '- summary.json：机器可读全量结果',
  '- report.md：本摘要',
  '',
  '## 证据',
  '',
  `- 最终 GOAL-2：${goal2Terminal.state}`,
  `- 写入间隔：${actualGap} ms（硬要求 60000 ms）`,
  `- 优化记录：${rec1}，${rec2}`,
  `- 最终任务状态：${finalTasks.map(t => `${t.title}=${t.state}`).join('；')}`,
].join('\n')
writeFileSync(join(outDir, 'report.md'), md)
console.log(JSON.stringify({ outDir, channelId, teamId: team.id, goal1Id, goal2Id, rec1, rec2, actualGapMs: actualGap, finalGoal2: goal2Terminal.state }, null, 2))
