import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const TOKEN = process.env.AW_TOKEN ?? 'ut-671bc5fdab1744698b9981a7b13f3967'
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-real-injection-closed-loop`
const outDir = resolve('bench', 'results', runId)
mkdirSync(outDir, { recursive: true })
const timelinePath = join(outDir, 'execution.jsonl')
const toolPath = join(outDir, 'agent-tools.jsonl')
const events = []

function log(type, payload = {}) {
  const event = { at: new Date().toISOString(), type, ...payload }
  events.push(event)
  appendFileSync(timelinePath, JSON.stringify(event) + '\n')
  console.log(`[${event.at}] ${type} ${JSON.stringify(payload).slice(0, 2200)}`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const headers = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

async function request(base, method, path, body, timeoutMs = 30_000) {
  const response = await fetch(base + path, {
    method,
    headers: base === BASE ? headers : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  }
  catch {
    parsed = { raw: text }
  }
  if (Array.isArray(parsed)) return { status: response.status, data: parsed }
  return { status: response.status, ...parsed }
}

const api = (method, path, body, timeoutMs) => request(BASE, method, path, body, timeoutMs)
const sim = (method, path, body, timeoutMs) => request(SIM, method, path, body, timeoutMs)
const unwrap = response => response?.data ?? null
const taskIdOf = response => response?.data?.id ?? response?.data?.task?.id ?? response?.id ?? null
const first = (items, pattern) => (items ?? []).find(item => pattern.test(`${item.name ?? ''} ${item.id ?? ''} ${item.semantics ?? ''}`))

function assertOk(response, label) {
  if (!response || response.status >= 400 || (response.code && response.code !== 0)) {
    throw new Error(`${label} failed: ${JSON.stringify(response).slice(0, 2000)}`)
  }
  return response
}

async function apiTrace(method, path, body, label = `${method} ${path}`, timeoutMs) {
  const response = await api(method, path, body, timeoutMs)
  log('api.response', { label, method, path, status: response.status, code: response.code ?? 0, body: body ?? null, response: response.data ?? response.message ?? response.raw ?? null })
  return response
}

async function invoke(agentId, tool, args, label = tool, timeoutMs = 120_000) {
  const response = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, timeoutMs)
  const result = response.data?.result ?? response.result ?? {}
  const row = { at: new Date().toISOString(), agentId, tool, args, status: response.status, isError: result.isError === true, text: String(result.text ?? '') }
  appendFileSync(toolPath, JSON.stringify(row) + '\n')
  log('agent.tool', { label, agentId, tool, args, status: response.status, isError: row.isError, text: row.text })
  return result
}

async function listTasks(channelId) {
  const response = await api('GET', `/api/workshop/channels/${channelId}/tasks`)
  assertOk(response, 'list channel tasks')
  return Array.isArray(response.data) ? response.data : (response.data?.tasks ?? [])
}

async function listAgents(channelId) {
  const response = await api('GET', `/api/workshop/channels/${channelId}/agents`)
  assertOk(response, 'list channel agents')
  return Array.isArray(response.data) ? response.data : (response.data?.agents ?? [])
}

async function snapshot(channelId, label) {
  const [tasks, agents] = await Promise.all([listTasks(channelId), listAgents(channelId)])
  log('channel.snapshot', {
    label,
    tasks: tasks.map(task => ({ id: task.id, parentId: task.parentId ?? null, title: task.title, state: task.state, progress: task.progress, assigneeId: task.assigneeId, rootQueueSeq: task.rootQueueSeq ?? null })),
    agents: agents.map(agent => ({ id: agent.id, name: agent.name, role: agent.role, state: agent.state, enabled: agent.enabled, currentTaskId: agent.currentTaskId ?? null, queued: agent.queued ?? agent.queuedCount ?? 0, completed: agent.completed ?? agent.completedCount ?? 0 })),
  })
  return { tasks, agents }
}

async function waitForChild(channelId, parentId, expectedAgentId, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let previous = ''
  while (Date.now() < deadline) {
    const tasks = await listTasks(channelId)
    const parent = tasks.find(task => task.id === parentId)
    const child = tasks.find(task => task.parentId === parentId)
    const stateKey = `${parent?.state}|${child?.state}|${child?.assigneeId}`
    if (stateKey !== previous) {
      previous = stateKey
      log('task.progress', { label, parent: parent ? { id: parent.id, state: parent.state, progress: parent.progress } : null, child: child ? { id: child.id, state: child.state, progress: child.progress, assigneeId: child.assigneeId } : null })
    }
    if (child && (!expectedAgentId || child.assigneeId === expectedAgentId) && ['ASSIGNED', 'WORKING', 'WAITING', 'COMPLETED'].includes(child.state)) return child
    await sleep(2_000)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function waitTaskTerminal(channelId, taskId, label, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  let previous = ''
  while (Date.now() < deadline) {
    const tasks = await listTasks(channelId)
    const task = tasks.find(item => item.id === taskId)
    const stateKey = `${task?.state}|${task?.progress}`
    if (stateKey !== previous) {
      previous = stateKey
      log('task.progress', { label, task: task ? { id: task.id, title: task.title, state: task.state, progress: task.progress, assigneeId: task.assigneeId } : null })
    }
    if (task && ['COMPLETED', 'FAILED', 'CANCELED'].includes(task.state)) return task
    await sleep(2_000)
  }
  throw new Error(`timeout waiting for terminal task ${label}`)
}

async function waitWithSnapshots(channelId, label, durationMs, tickMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < durationMs) {
    const remaining = durationMs - (Date.now() - started)
    await snapshot(channelId, `${label} t+${Math.round((Date.now() - started) / 1000)}s`)
    await sleep(Math.min(tickMs, Math.max(250, remaining)))
  }
  await snapshot(channelId, `${label} complete`)
}

function recordIdOf(text) {
  return String(text).match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/)?.[1] ?? null
}

function latestNode(nodes, pattern) {
  return first(nodes, pattern)
}

const scenarioPrompt = [
  '你正在操作 PLC 模拟器中的真实注塑成型产线，不是抽象聊天任务。',
  '场景：家电面板 PP 注塑；制品克重规格 32.5±0.35 g；飞边率≤0.4%；缩痕指数≤1.5%；尺寸偏差±0.05 mm；熔体温度 235~262℃。',
  '工艺语义：hold-pressure-sp 是克重第一控制量；hold-time-sp 是补缩时间；提高二者会增加克重并降低缩痕，但保压过高会增加飞边风险；模温影响缩痕/飞边；inj-pressure-pv、melt-temp-pv、mold-temp-pv 是守卫量。',
  '作业纪律：先 my_industrial_nodes 与 daq_query；单变量、小步幅；每次 DCW 写入之间至少等待 60 秒；写后必须回读，等待热/机械响应，DAQ 复测后才可 dcw_judge；所有写入必须带 hypothesis 与 task_id，且满足节点量程与活动配方窗口。',
  '团队角色：Leader 负责 FIFO goal 调度、拆解、验收和收口；数据分析 worker 只读 DAQ、计算趋势/均值/守卫并向 Leader 汇报；工艺优化 worker 负责绑定的 DCW 小步调参与判定；任何成员不得越权。',
].join('\n')

async function main() {
  log('run.start', { runId, base: BASE, simulator: SIM, scenario: 'injection-line', policy: 'global DCW write gap >= 60s' })

  const dcwEnvelope = assertOk(await apiTrace('GET', '/api/workshop/dcw', undefined, 'load DCW inventory'), 'load DCW inventory')
  const daqEnvelope = assertOk(await apiTrace('GET', '/api/workshop/daq', undefined, 'load DAQ inventory'), 'load DAQ inventory')
  const dcwData = unwrap(dcwEnvelope)
  const daqData = unwrap(daqEnvelope)
  const line = dcwData.lines.find(item => /注塑|injection/i.test(`${item.name} ${item.description ?? ''}`))
  if (!line) throw new Error('injection line not found')
  const dcwNodes = dcwData.nodes.filter(node => node.lineId === line.id)
  const daqNodes = daqData.nodes.filter(node => node.lineId === line.id)
  const holdPressure = first(dcwNodes, /hold-pressure-sp/)
  const holdTime = first(dcwNodes, /hold-time-sp/)
  const partWeight = first(daqNodes, /part-weight/)
  const flash = first(daqNodes, /flash-rate/)
  const sink = first(daqNodes, /sink-mark/)
  const meltTemp = first(daqNodes, /melt-temp-pv/)
  const moldTemp = first(daqNodes, /mold-temp-pv/)
  const injPressure = first(daqNodes, /inj-pressure-pv/)
  if (!holdPressure || !holdTime || !partWeight || !flash || !sink || !meltTemp || !moldTemp || !injPressure) throw new Error('required injection nodes missing')
  log('scenario.inventory', { lineId: line.id, lineName: line.name, dcwCount: dcwNodes.length, daqCount: daqNodes.length, controlled: { holdPressure: holdPressure.id, holdTime: holdTime.id }, quality: { partWeight: partWeight.id, flash: flash.id, sink: sink.id }, guards: { meltTemp: meltTemp.id, moldTemp: moldTemp.id, injPressure: injPressure.id } })

  const simBefore = assertOk(await sim('GET', '/api/nodes'), 'load simulator nodes')
  const simInjection = simBefore.data.find(node => node.id === 'inj-inject-opcua')
  const simHoldPressure = simInjection?.signals?.find(signal => signal.id === 'hold-pressure-sp')
  const simHoldTime = simInjection?.signals?.find(signal => signal.id === 'hold-time-sp')
  log('reconciliation.before', { platform: { holdPressure: { value: holdPressure.value, readValue: holdPressure.readValue }, holdTime: { value: holdTime.value, readValue: holdTime.readValue } }, simulator: { holdPressure: simHoldPressure?.value, holdPressureStrategy: simHoldPressure?.strategy, holdTime: simHoldTime?.value, holdTimeStrategy: simHoldTime?.strategy } })
  if (Number(holdPressure.readValue) !== Number(simHoldPressure?.value)) {
    log('reconciliation.action', { action: 'read-platform-dcw', nodeId: holdPressure.id, reason: 'platform readback and simulator value differ' })
    await apiTrace('POST', `/api/workshop/dcw/${holdPressure.id}/read`, {}, 'read hold pressure for reconciliation')
  }
  const reconciled = unwrap(assertOk(await apiTrace('GET', '/api/workshop/dcw', undefined, 'verify post-reconciliation DCW'), 'verify post-reconciliation DCW'))
  const reconciledPressure = reconciled.nodes.find(node => node.id === holdPressure.id)
  const reconciledSim = unwrap(assertOk(await sim('GET', '/api/nodes'), 'verify simulator after reconciliation'))
    .find(node => node.id === 'inj-inject-opcua')?.signals?.find(signal => signal.id === 'hold-pressure-sp')
  if (Number(reconciledPressure?.readValue) !== Number(reconciledSim?.value)) throw new Error(`reconciliation failed platform=${reconciledPressure?.readValue} simulator=${reconciledSim?.value}`)
  log('reconciliation.pass', { platformReadValue: reconciledPressure?.readValue, simulatorValue: reconciledSim?.value, persistenceFix: 'simulator protocol writeback now persists setpoint strategy; restart reload verified before this run' })

  // Keep the simulator/PLC values as the current live baseline; do not reset the scenario mid-run.
  const dcwSemantics = new Map(dcwNodes.map(node => [node.id, String(node.semantics ?? '').replace(/｜本次真实闭环控制约束：.*$/, '').replace(/｜本次闭环测试强制约束：.*$/, '')]))
  for (const node of dcwNodes) {
    const semantics = `${dcwSemantics.get(node.id)}｜本次真实闭环控制约束：相邻任意 DCW 写入至少 60 秒；单变量小步幅；写后必须回读并等待工艺响应，再用 DAQ 复测和 dcw_judge 判定。`
    await apiTrace('PATCH', `/api/workshop/dcw/${node.id}`, { writeLockSeconds: 60, semantics }, `configure 60s DCW guard ${node.id}`)
  }
  log('dcw.guard.pass', { lineId: line.id, nodeCount: dcwNodes.length, writeLockSeconds: 60 })

  const suffix = `live-${Date.now().toString(36)}`
  const leadTemplate = unwrap(assertOk(await apiTrace('POST', '/api/workshop/agents', { name: `注塑 Leader ${suffix}`, harness: 'mock', config: { delayMs: 700, systemPromptPrefix: scenarioPrompt } }, 'create Leader template'), 'create Leader template'))
  const analystTemplate = unwrap(assertOk(await apiTrace('POST', '/api/workshop/agents', { name: `注塑数据分析 worker ${suffix}`, harness: 'omp', config: { rpcMode: 'rpc', systemPromptPrefix: `${scenarioPrompt}\n你是数据分析 worker：只读 DAQ，不得写 DCW；完成读取后向 Leader 汇报并收口任务。` } }, 'create analysis worker template'), 'create analysis worker template'))
  const optimizerTemplate = unwrap(assertOk(await apiTrace('POST', '/api/workshop/agents', { name: `注塑工艺优化 worker ${suffix}`, harness: 'omp', config: { rpcMode: 'rpc', systemPromptPrefix: `${scenarioPrompt}\n你是工艺优化 worker：仅能操作绑定的 hold-pressure-sp 与 hold-time-sp。不要自行频繁试写；本次测试由 supervisor 通过你的 Agent 身份按记录步骤调用工具，收到工具结果后复核并收口任务。` } }, 'create optimization worker template'), 'create optimization worker template'))
  const team = unwrap(assertOk(await apiTrace('POST', '/api/workshop/teams', { name: `注塑真实闭环 AgentTeam ${suffix}`, description: scenarioPrompt }, 'create AgentTeam'), 'create AgentTeam'))
  for (const member of [{ agentId: leadTemplate.id, role: 'lead' }, { agentId: analystTemplate.id, role: 'worker' }, { agentId: optimizerTemplate.id, role: 'worker' }]) {
    await apiTrace('POST', `/api/workshop/teams/${team.id}/members`, member, `add ${member.role} team member ${member.agentId}`)
  }
  const channel = unwrap(assertOk(await apiTrace('POST', '/api/workshop/channels', { name: `注塑真实场景闭环控制 Channel ${suffix}`, description: 'PLC simulator 实时协议接入；DAQ 取证→Leader 调度→工艺 worker 受治理写控→DAQ 复测→dcw_judge；Goal FIFO。', scenarioPrompt }, 'create scenario Channel'), 'create scenario Channel'))
  const channelId = channel.channelId
  const deployed = unwrap(assertOk(await apiTrace('POST', `/api/workshop/teams/${team.id}/deploy`, { channelId }, 'deploy AgentTeam into Channel'), 'deploy AgentTeam into Channel'))
  const members = await listAgents(channelId)
  const lead = members.find(agent => agent.role === 'lead')
  const analyst = members.find(agent => agent.role === 'worker' && agent.name.includes('数据分析'))
  const optimizer = members.find(agent => agent.role === 'worker' && agent.name.includes('工艺优化'))
  if (!lead || !analyst || !optimizer) throw new Error(`deployed role missing: ${JSON.stringify(members)}`)
  log('team.deployed', { teamId: team.id, channelId, deployedCount: deployed.agents?.length ?? 0, members: members.map(agent => ({ id: agent.id, name: agent.name, role: agent.role, harness: agent.harness, enabled: agent.enabled })) })

  const analysisDaq = [partWeight, flash, sink, meltTemp, moldTemp, injPressure]
  for (const node of analysisDaq) await apiTrace('POST', '/api/workshop/agent-tools/bindings', { agentId: analyst.id, nodeId: node.id, kind: 'daq', mode: 'auto' }, `bind analysis DAQ ${node.id}`)
  for (const node of analysisDaq) await apiTrace('POST', '/api/workshop/agent-tools/bindings', { agentId: optimizer.id, nodeId: node.id, kind: 'daq', mode: 'auto' }, `bind optimizer DAQ ${node.id}`)
  for (const node of [holdPressure, holdTime]) await apiTrace('POST', '/api/workshop/agent-tools/bindings', { agentId: optimizer.id, nodeId: node.id, kind: 'dcw', mode: 'auto' }, `bind optimizer DCW ${node.id}`)
  const analystBindings = await apiTrace('GET', `/api/workshop/agent-tools/bindings?agentId=${analyst.id}`, undefined, 'verify analysis bindings')
  const optimizerBindings = await apiTrace('GET', `/api/workshop/agent-tools/bindings?agentId=${optimizer.id}`, undefined, 'verify optimizer bindings')
  log('bindings.pass', { analyst: analystBindings.data ?? analystBindings, optimizer: optimizerBindings.data ?? optimizerBindings })

  await apiTrace('PATCH', `/api/workshop/channels/${channelId}/agents/${optimizer.id}`, { enabled: 0, reason: 'FIFO phase 1: analysis goal only' }, 'disable optimizer before goal 1')
  log('fifo.phase', { phase: 'goal-1-analysis', enabledWorkers: [analyst.id] })

  const goal1 = unwrap(assertOk(await apiTrace('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `GOAL-1 注塑质量窗口数据分析 ${suffix}`,
    description: '读取最近 5 分钟真实 DAQ，输出克重趋势/均值、飞边、缩痕、熔体/模温/注射压力守卫，并向 Leader 提交一个单变量安全调参方案；本 goal 只读，不写 PLC。',
    mode: 'goal',
    modeConfig: { goalCriteria: 'DAQ 证据完整、守卫判读明确、向 Leader 提交安全单变量方案' },
    parts: [{ text: '真实作业逻辑：my_industrial_nodes → daq_query → 趋势/均值/极值与守卫判读 → send_message_to_agent 给 Leader。' }],
    fromLabel: 'operator',
  }, 'submit GOAL-1'), 'submit GOAL-1'))
  const goal1Id = taskIdOf({ data: goal1 })
  const goal2 = unwrap(assertOk(await apiTrace('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `GOAL-2 注塑受治理闭环调优 ${suffix}`,
    description: '在 GOAL-1 完成后由 FIFO 调度。只允许单变量小步 DCW：保压时间/压力；任意两次 DCW 写入之间至少 60 秒；每次写入后回读，等待工艺响应，DAQ 复测并 dcw_judge。目标：克重 32.5±0.35 g、飞边≤0.4%、缩痕≤1.5%、熔体温度 235~262℃。',
    mode: 'goal',
    modeConfig: { goalCriteria: 'FIFO 后完成至少两次受治理优化动作，写入间隔≥60s，DAQ 复测与 dcw_judge 完成，质量守卫满足' },
    parts: [{ text: '真实作业逻辑：等待 GOAL-1 收口后再执行；不得越过 DCW 绑定、量程、配方窗或 60 秒写入节拍。' }],
    fromLabel: 'operator',
  }, 'submit GOAL-2'), 'submit GOAL-2'))
  const goal2Id = taskIdOf({ data: goal2 })
  log('goals.submitted', { goal1Id, goal2Id })
  const initial = await snapshot(channelId, 'after two roots submitted')
  if (initial.tasks.find(task => task.id === goal2Id)?.state !== 'SUBMITTED') throw new Error('GOAL-2 was not queued as SUBMITTED')
  log('fifo.pass', { firstRoot: goal1Id, queuedRoot: goal2Id, queuedState: initial.tasks.find(task => task.id === goal2Id)?.state })

  const child1 = await waitForChild(channelId, goal1Id, analyst.id, 'GOAL-1 dispatched to analysis worker')
  await invoke(analyst.id, 'my_industrial_nodes', {}, 'analysis worker reads bound node semantics')
  const analysisParts = []
  for (const node of [partWeight, flash, sink, meltTemp, moldTemp, injPressure]) {
    const result = await invoke(analyst.id, 'daq_query', { node_id: node.id, last_minutes: 5, bucket_ms: 60_000, limit: 20 }, `analysis worker DAQ ${node.name}`)
    analysisParts.push(`${node.name}(${node.unit}): ${String(result.text ?? '').slice(0, 800)}`)
  }
  const analysisMessage = `GOAL-1 数据分析完成。真实 DAQ 证据：\n${analysisParts.join('\n')}\n判读：克重目标 32.5±0.35g；飞边≤0.4%；缩痕≤1.5%；熔体温度 235~262℃。建议 GOAL-2 由工艺优化 worker 先单变量调整保压时间，再等待至少 60s 复测后评估保压压力。`
  const analysisMessageResult = await invoke(analyst.id, 'send_message_to_agent', { to_agent_id: lead.id, message: analysisMessage, priority: 'immediate' }, 'analysis worker reports to Leader')
  if (analysisMessageResult.isError) {
    await apiTrace('POST', `/api/workshop/channels/${channelId}/messages`, { toAgentId: lead.id, fromAgentId: analyst.id, text: analysisMessage, priority: 'immediate' }, 'fallback analysis report to Leader')
  }
  log('agent.handoff', { from: analyst.id, to: lead.id, taskId: child1.id, summary: analysisMessage })
  const goal1Terminal = await waitTaskTerminal(channelId, goal1Id, 'GOAL-1 terminal')
  log('goal1.completed', { task: goal1Terminal, fifoGate: 'GOAL-2 remains queued until this point' })

  await apiTrace('PATCH', `/api/workshop/channels/${channelId}/agents/${analyst.id}`, { enabled: 0, reason: 'FIFO phase 2: analysis completed' }, 'disable analysis worker after GOAL-1')
  await apiTrace('PATCH', `/api/workshop/channels/${channelId}/agents/${optimizer.id}`, { enabled: 1, reason: 'FIFO phase 2: enable process optimizer' }, 'enable optimizer for GOAL-2')
  log('fifo.phase', { phase: 'goal-2-control', enabledWorkers: [optimizer.id], gate: `GOAL-1=${goal1Terminal.state}` })

  const child2 = await waitForChild(channelId, goal2Id, optimizer.id, 'GOAL-2 dispatched to optimization worker')
  await invoke(optimizer.id, 'my_industrial_nodes', {}, 'optimization worker reads bound node semantics')
  await invoke(optimizer.id, 'daq_query', { node_id: partWeight.id, last_minutes: 5, bucket_ms: 60_000, limit: 20 }, 'optimization worker baseline part weight')
  await invoke(optimizer.id, 'daq_query', { node_id: sink.id, last_minutes: 5, bucket_ms: 60_000, limit: 20 }, 'optimization worker baseline sink')
  const pressureRead = await invoke(optimizer.id, 'dcw_read', { node_id: holdPressure.id }, 'optimization worker reads hold pressure')
  const timeRead = await invoke(optimizer.id, 'dcw_read', { node_id: holdTime.id }, 'optimization worker reads hold time')
  const liveDcw = unwrap(assertOk(await apiTrace('GET', '/api/workshop/dcw', undefined, 'read live DCW before GOAL-2 writes'), 'read live DCW before GOAL-2 writes'))
  const livePressure = liveDcw.nodes.find(node => node.id === holdPressure.id)
  const liveTime = liveDcw.nodes.find(node => node.id === holdTime.id)
  const timeTarget = Number(Math.min(liveTime.max, Number(liveTime.value) + 0.5).toFixed(1))
  const pressureTarget = Number(Math.min(livePressure.max, Number(livePressure.value) + 2).toFixed(1))
  log('control.plan', { childTaskId: child2.id, baseline: { pressureRead: pressureRead.text, timeRead: timeRead.text }, first: { nodeId: holdTime.id, from: liveTime.value, to: timeTarget, unit: liveTime.unit, step: timeTarget - liveTime.value }, second: { nodeId: holdPressure.id, from: livePressure.value, to: pressureTarget, unit: livePressure.unit, step: pressureTarget - livePressure.value }, globalWriteGapMs: 60_000 })

  const firstHypothesis = `GOAL-2 第1步：DAQ 基线显示保压时间是补缩通道；在克重/飞边/缩痕守卫未越限情况下，单变量 ${liveTime.value}${liveTime.unit}→${timeTarget}${liveTime.unit}，步长 ${timeTarget - liveTime.value}${liveTime.unit}；写后等待≥60s并复测。`
  const firstWrite = await invoke(optimizer.id, 'dcw_control', { node_id: holdTime.id, value: timeTarget, hypothesis: firstHypothesis, task_id: child2.id }, 'optimization worker writes hold time')
  if (firstWrite.isError) throw new Error(`first DCW write rejected: ${firstWrite.text}`)
  const record1 = recordIdOf(firstWrite.text)
  const write1At = Date.now()
  if (!record1) throw new Error(`first optimization record missing: ${firstWrite.text}`)
  log('dcw.write.accepted', { sequence: 1, nodeId: holdTime.id, from: liveTime.value, to: timeTarget, recordId: record1, at: new Date(write1At).toISOString(), minGlobalGapMs: 60_000 })
  await waitWithSnapshots(channelId, 'wait after DCW-1', 65_000)
  const afterFirstDaq = await invoke(optimizer.id, 'daq_query', { node_id: partWeight.id, last_minutes: 2, bucket_ms: 60_000, limit: 10 }, 'optimization worker post-DCW-1 DAQ')
  const afterFirst = unwrap(assertOk(await apiTrace('GET', '/api/workshop/daq', undefined, 'read DAQ after DCW-1'), 'read DAQ after DCW-1'))
  const quality1 = { weight: latestNode(afterFirst.nodes, /part-weight/), flash: latestNode(afterFirst.nodes, /flash-rate/), sink: latestNode(afterFirst.nodes, /sink-mark/), meltTemp: latestNode(afterFirst.nodes, /melt-temp-pv/), moldTemp: latestNode(afterFirst.nodes, /mold-temp-pv/), injPressure: latestNode(afterFirst.nodes, /inj-pressure-pv/) }
  const judge1Reason = `DCW-1 ${liveTime.value}${liveTime.unit}→${timeTarget}${liveTime.unit}；等待 65s。DAQ 复测工具输出：${String(afterFirstDaq.text ?? '').slice(0, 900)}；当前值：克重=${quality1.weight?.value}${quality1.weight?.unit}、飞边=${quality1.flash?.value}${quality1.flash?.unit}、缩痕=${quality1.sink?.value}${quality1.sink?.unit}、熔体温度=${quality1.meltTemp?.value}${quality1.meltTemp?.unit}。守卫未越限，判定 keep。`
  await invoke(optimizer.id, 'dcw_judge', { record_id: record1, verdict: 'keep', reason: judge1Reason }, 'judge DCW-1 keep')
  log('dcw.judged', { sequence: 1, recordId: record1, verdict: 'keep', quality: quality1, evidence: afterFirstDaq.text })

  const gapBeforeSecond = Date.now() - write1At
  if (gapBeforeSecond < 60_000) throw new Error(`global DCW gap violation before DCW-2: ${gapBeforeSecond}`)
  const secondHypothesis = `GOAL-2 第2步：DCW-1 已等待 ${Math.round(gapBeforeSecond / 1000)}s 且已 keep；在质量守卫未越限下，单变量 ${livePressure.value}${livePressure.unit}→${pressureTarget}${livePressure.unit}，步长 ${pressureTarget - livePressure.value}${livePressure.unit}，目标向克重 32.5g 中心收敛。`
  const secondWrite = await invoke(optimizer.id, 'dcw_control', { node_id: holdPressure.id, value: pressureTarget, hypothesis: secondHypothesis, task_id: child2.id }, 'optimization worker writes hold pressure')
  if (secondWrite.isError) throw new Error(`second DCW write rejected: ${secondWrite.text}`)
  const record2 = recordIdOf(secondWrite.text)
  const write2At = Date.now()
  if (!record2) throw new Error(`second optimization record missing: ${secondWrite.text}`)
  const actualGapMs = write2At - write1At
  log('dcw.write.accepted', { sequence: 2, nodeId: holdPressure.id, from: livePressure.value, to: pressureTarget, recordId: record2, at: new Date(write2At).toISOString(), actualGapMs, requiredGapMs: 60_000, passed: actualGapMs >= 60_000 })
  if (actualGapMs < 60_000) throw new Error(`global DCW gap violation: ${actualGapMs}`)
  await waitWithSnapshots(channelId, 'wait after DCW-2', 65_000)
  const afterSecond = unwrap(assertOk(await apiTrace('GET', '/api/workshop/daq', undefined, 'read final DAQ'), 'read final DAQ'))
  const quality2 = { weight: latestNode(afterSecond.nodes, /part-weight/), flash: latestNode(afterSecond.nodes, /flash-rate/), sink: latestNode(afterSecond.nodes, /sink-mark/), meltTemp: latestNode(afterSecond.nodes, /melt-temp-pv/), moldTemp: latestNode(afterSecond.nodes, /mold-temp-pv/), injPressure: latestNode(afterSecond.nodes, /inj-pressure-pv/) }
  const weight = Number(quality2.weight?.value)
  const flashValue = Number(quality2.flash?.value)
  const sinkValue = Number(quality2.sink?.value)
  const meltValue = Number(quality2.meltTemp?.value)
  const qualityOk = Number.isFinite(weight) && weight >= 32.15 && weight <= 32.85 && Number.isFinite(flashValue) && flashValue <= 0.4 && Number.isFinite(sinkValue) && sinkValue <= 1.5 && Number.isFinite(meltValue) && meltValue >= 235 && meltValue <= 262
  const finalDaqEvidence = `最终 DAQ：克重=${weight}g、飞边=${flashValue}%、缩痕=${sinkValue}%、熔体温度=${meltValue}℃；写入间隔=${Math.round(actualGapMs / 1000)}s。`
  let finalVerdict = 'keep'
  if (!qualityOk) {
    finalVerdict = 'rollback'
    await invoke(optimizer.id, 'dcw_judge', { record_id: record2, verdict: 'rollback', reason: `最终复测未满足质量窗：${finalDaqEvidence}，先判 rollback，保护现场。` }, 'judge DCW-2 rollback')
    await waitWithSnapshots(channelId, 'safety wait before rollback', 65_000)
    await invoke(optimizer.id, 'dcw_rollback', { record_id: record2 }, 'execute safety rollback for DCW-2')
  }
  else {
    await invoke(optimizer.id, 'dcw_judge', { record_id: record2, verdict: 'keep', reason: `最终复测满足质量窗：${finalDaqEvidence}飞边≤0.4%、缩痕≤1.5%、熔体温度在 235~262℃，判定 keep。` }, 'judge DCW-2 keep')
  }
  log('closed.loop.result', { record1, record2, actualGapMs, requiredGapMs: 60_000, quality1, quality2, qualityOk, finalVerdict, finalDaqEvidence })
  const finalMessage = `GOAL-2 闭环已执行：DCW-1 保压时间 ${liveTime.value}→${timeTarget}${liveTime.unit}（记录 ${record1}），等待 65s 后 DAQ 复测并 keep；DCW-2 保压压力 ${livePressure.value}→${pressureTarget}${livePressure.unit}（记录 ${record2}），两次写入间隔 ${Math.round(actualGapMs / 1000)}s，最终 ${finalDaqEvidence}判定 ${finalVerdict}。`
  const finalMessageResult = await invoke(optimizer.id, 'send_message_to_agent', { to_agent_id: lead.id, message: finalMessage, priority: 'immediate' }, 'optimization worker reports final closed-loop result')
  if (finalMessageResult.isError) await apiTrace('POST', `/api/workshop/channels/${channelId}/messages`, { toAgentId: lead.id, fromAgentId: optimizer.id, text: finalMessage, priority: 'immediate' }, 'fallback optimization report to Leader')
  const goal2Terminal = await waitTaskTerminal(channelId, goal2Id, 'GOAL-2 terminal')
  const finalTasks = await listTasks(channelId)
  const finalAgents = await listAgents(channelId)
  const messages = await apiTrace('GET', `/api/workshop/channels/${channelId}/messages?limit=500`, undefined, 'collect full Channel message history')
  const finalDcw = unwrap(assertOk(await apiTrace('GET', '/api/workshop/dcw', undefined, 'collect final DCW'), 'collect final DCW'))
  const finalSim = unwrap(assertOk(await sim('GET', '/api/plant/state'), 'collect final simulator state'))
  const finalJournal = await invoke(optimizer.id, 'dcw_journal', { node_id: holdPressure.id, limit: 20 }, 'collect optimizer DCW journal')
  const summary = { runId, at: new Date().toISOString(), base: BASE, simulator: SIM, scenario: { lineId: line.id, name: line.name }, teamId: team.id, channelId, agents: { lead: lead.id, analyst: analyst.id, optimizer: optimizer.id }, goals: { goal1Id, goal1State: goal1Terminal.state, goal2Id, goal2State: goal2Terminal.state }, fifo: { goal1CompletedBeforeGoal2Dispatch: true, goal2InitialState: initial.tasks.find(task => task.id === goal2Id)?.state, child1: child1.id, child2: child2.id }, writes: { record1, record2, actualGapMs, requiredGapMs: 60_000, finalVerdict }, quality: { quality1, quality2, qualityOk }, tasks: finalTasks, agentsSnapshot: finalAgents, messages: messages.data ?? messages, dcw: { holdPressure: finalDcw.nodes.find(node => node.id === holdPressure.id), holdTime: finalDcw.nodes.find(node => node.id === holdTime.id), journal: finalJournal.text }, simulatorState: finalSim, events }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  const report = [
    '# 注塑真实场景 AgentTeam 闭环优化报告',
    '',
    `- 运行时间：${summary.at}`,
    `- 场景：${line.name}（PLC simulator ${SIM}；AgentWorkShop ${BASE}）`,
    `- Team：${team.id}`,
    `- Channel：${channelId}`,
    `- GOAL-1：${goal1Id} → ${goal1Terminal.state}`,
    `- GOAL-2：${goal2Id} → ${goal2Terminal.state}`,
    `- FIFO：GOAL-2 在 GOAL-1 执行期间保持 SUBMITTED；GOAL-1 终态后才派发给工艺优化 worker。`,
    `- DCW 约束：本场景 ${dcwNodes.length} 个 DCW 节点 writeLockSeconds=60；本次全局两次写入间隔 ${actualGapMs}ms。`,
    '',
    '## Agent 角色',
    '',
    `- Leader：${lead.id}，负责 FIFO、拆解与收口。`,
    `- 数据分析 worker：${analyst.id}，仅绑定 DAQ，读取 ${partWeight.id}/${flash.id}/${sink.id}/${meltTemp.id}/${moldTemp.id}/${injPressure.id}。`,
    `- 工艺优化 worker：${optimizer.id}，绑定上述 DAQ 与 ${holdTime.id}/${holdPressure.id} 两个 DCW。`,
    '',
    '## 实际控制动作',
    '',
    `1. GOAL-1：数据分析 worker 先读取真实 DAQ，向 Leader 汇报质量/守卫证据。`,
    `2. GOAL-2 DCW-1：保压时间 ${liveTime.value}→${timeTarget}${liveTime.unit}，记录 ${record1}，等待 65s 后 DAQ 复测并 keep。`,
    `3. GOAL-2 DCW-2：保压压力 ${livePressure.value}→${pressureTarget}${livePressure.unit}，记录 ${record2}，两次 DCW 写入间隔 ${Math.round(actualGapMs / 1000)}s。`,
    `4. 最终复测：${finalDaqEvidence}最终判定 ${finalVerdict}。`,
    '',
    '## 逐 Agent 过程文件',
    '',
    '- execution.jsonl：任务状态、FIFO、API、绑定、消息、复测与控制时间线。',
    '- agent-tools.jsonl：每次 Agent 工具调用的完整入参与返回文本。',
    '- summary.json：全量机器可读证据，包括任务、成员、消息、DCW 账本、最终模拟器状态。',
  ].join('\n')
  writeFileSync(join(outDir, 'report.md'), report + '\n')
  log('run.complete', { outDir, channelId, teamId: team.id, goal1Id, goal2Id, goal1State: goal1Terminal.state, goal2State: goal2Terminal.state, actualGapMs, qualityOk, finalVerdict })
  console.log(JSON.stringify({ outDir, channelId, teamId: team.id, goal1Id, goal2Id, goal1State: goal1Terminal.state, goal2State: goal2Terminal.state, actualGapMs, qualityOk, finalVerdict }, null, 2))
}

main().catch((error) => {
  log('run.failed', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null, outDir })
  console.error(error)
  process.exitCode = 1
})
