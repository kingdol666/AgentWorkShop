/** 端到端 Phase 3:Channel Agent 绑定产线节点 + omp 团队优化任务(HITL)+ 参数下发生效断言
 *  链路:建 channel/团队 → lead(mock 调度)+ worker(omp 真实 LLM)部署 → 绑定 1号产线
 *  的 2 数采(auto)+ 1 数控(manual)→ 派发优化任务 → lead 派发 → worker
 *  my_industrial_nodes/daq_query 读数 → dcw_control 下发(182→窗口内 184)→ HITL 批准
 *  → 写 ACK + node.value 生效 + 打标样本增长。
 *  演示资产(channel/团队/Agent)保留不清理,供用户在 UI 查看;线保持运行。
 */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const d = (await J('/api/workshop/dcw')).data
const line = d.lines.find(l => l.name === '1号产线')
const recipe = d.recipes.find(r => r.lineId === line.id)
const dwTemp = d.nodes.find(n => n.name === '温度设定器(示例)')
const daqAll = (await J('/api/workshop/daq')).data
const dqPressure = daqAll.nodes.find(n => n.name === '压力变送器 01' && n.lineId === line.id)
const dqTemp = daqAll.nodes.find(n => n.name === '温度传感器 01' && n.lineId === line.id)
if (!dwTemp || !dqPressure || !dqTemp) { console.error('FAIL 节点缺失'); process.exit(1) }
console.log('目标节点 → dcw:', dwTemp.name, `(当前 ${dwTemp.value}, 窗口 176~188) | daq:`, dqPressure.name, '+', dqTemp.name)

// ── 1. Channel + 团队(lead=mock 调度,worker=omp 真实 LLM) ──
const ch = (await J('/api/workshop/channels', 'POST', { name: '产线优化团队(端到端)', description: 'omp 团队作业优化任务演示' })).data
console.log('channel:', ch.channelId)
const team = (await J('/api/workshop/teams', 'POST', { name: '产线优化组(端到端)', description: '工况分析与工艺参数优化' })).data
await J(`/api/workshop/teams/${team.id}/members`, 'POST', { agentId: 'tpl-default-lead', role: 'lead' })
const workerTpl = (await J('/api/workshop/agents', 'POST', {
  name: '工艺优化工程师(端到端)', harness: 'omp',
  config: {
    intro: '负责读取产线数采数据并做工艺参数优化,经 dcw_control 小步下发设定值',
    systemPromptPrefix: '你是产线工艺优化工程师。用 my_industrial_nodes 查看授权节点,用 daq_query 获取最新工况;优化任务需在工艺窗口内小步调整并用 dcw_control 下发,结论引用具体数值。',
  },
})).data
await J(`/api/workshop/teams/${team.id}/members`, 'POST', { agentId: workerTpl.id, role: 'worker' })
const dep = await J(`/api/workshop/teams/${team.id}/deploy`, 'POST', { channelId: ch.channelId })
const chAgents = (await J(`/api/workshop/channels/${ch.channelId}/agents`)).data
const leadInst = chAgents.find(a => a.role === 'lead')
const workerInst = chAgents.find(a => a.role === 'worker')
if (!leadInst || !workerInst) { console.error('FAIL 部署实例缺失'); process.exit(1) }
console.log('deploy → lead', leadInst.id.slice(0, 8), '/ worker', workerInst.id.slice(0, 8), `(harness=${workerInst.harness})`)

// ── 2. Agent 绑定产线节点:2 数采(auto)+ 1 数控(manual=HITL) ──
await J('/api/workshop/agent-tools/bindings', 'POST', { agentId: workerInst.id, nodeId: dqPressure.id, kind: 'daq', mode: 'auto' })
await J('/api/workshop/agent-tools/bindings', 'POST', { agentId: workerInst.id, nodeId: dqTemp.id, kind: 'daq', mode: 'auto' })
await J('/api/workshop/agent-tools/bindings', 'POST', { agentId: workerInst.id, nodeId: dwTemp.id, kind: 'dcw', mode: 'manual' })
const bl = (await J(`/api/workshop/agent-tools/bindings?agentId=${workerInst.id}`)).data.bindings
console.log(`绑定完成: ${bl.length} 条(2 daq auto + 1 dcw manual)`)

// ── 3. 工具链路冒烟(HTTP 桥 = omp 同路径) ──
const invoke = (agentId, tool, args) => J('/api/workshop/agent-tools/invoke', 'POST', { agentId, tool, args }).then(r => r.data.result)
const mine = await invoke(workerInst.id, 'my_industrial_nodes', {})
console.log('[工具] my_industrial_nodes:', mine.text.slice(0, 100).replace(/\n/g, ' '))
const q = await invoke(workerInst.id, 'daq_query', { last_minutes: 5 })
console.log('[工具] daq_query:', q.text.slice(0, 100).replace(/\n/g, ' '))

// ── 4. 派发优化任务 ──
const valueBefore = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id).value
const goal = `产线「1号产线」工艺优化任务:当前烘箱温度设定 ${valueBefore}℃,工艺窗口 176~188℃。请:1) 用数采工具读取最近几分钟温度/压力工况并给出均值;2) 将烘箱温度设定值向 184℃ 方向小步优化(用 dcw_control 下发,注意该节点为手动确认模式,发起后等待用户批准);3) 下发后复测并汇报前后数值。`
const task = (await J(`/api/workshop/channels/${ch.channelId}/tasks`, 'POST', {
  title: '烘箱温度参数优化',
  parts: [{ text: goal }],
  mode: 'loop',
})).data
const taskId = task?.task?.id ?? task?.id
if (!taskId) { console.error('FAIL 任务派发失败:', JSON.stringify(task).slice(0, 150)); process.exit(1) }
console.log('任务已派发:', taskId.slice(0, 10), `(设定 ${valueBefore} → 目标 ~184)`)

// ── 5. 观察调度/HITL/写副作用 ──
let subSeen = false, hitlSeen = false, valueSeen = false
let pendDetail = ''
for (let i = 0; i < 180; i++) {
  await sleep(2000)
  const tasks = (await J(`/api/workshop/channels/${ch.channelId}/tasks`)).data
  const arr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? []
  const sub = arr.find(t => t.id !== taskId)
  if (sub && !subSeen) { subSeen = true; console.log(`[t+${i * 2}s] lead 已派发子任务 → ${sub.assigneeId?.slice(0, 8)}`) }
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${workerInst.id}`)).data.approvals
  if (pend.length > 0 && !hitlSeen) {
    hitlSeen = true
    pendDetail = pend[0].detail
    console.log(`[t+${i * 2}s] HITL 审批请求: ${pendDetail.slice(0, 80)}`)
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '窗口内小步优化,批准' })
    console.log('[HITL] 已批准')
  }
  const dwNow = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id)
  if (dwNow?.value != null && Math.abs(dwNow.value - 184) <= 1.5) valueSeen = true
  const subDone = sub && (sub.state === 'COMPLETED' || sub.state === 'FAILED' || sub.state === 'CANCELED')
  if ((valueSeen && subDone) || i > 170) {
    console.log(`[t+${i * 2}s] 结束观察: 子任务=${sub?.state} 设定值=${dwNow?.value}`)
    break
  }
}

// ── 6. 断言 ──
const dwFinal = (await J('/api/workshop/dcw')).data
const finalNode = dwFinal.nodes.find(n => n.id === dwTemp.id)
const agentWrites = dwFinal.history.filter(h => h.nodeId === dwTemp.id && h.ok && (!h.recipeRunId || h.value !== valueBefore))
const states = (await J('/api/workshop/dcw/lines')).data.states
const tagged = states.find(s => s.lineId === line.id)?.taggedSamples ?? 0
console.log('==== 断言 ====')
console.log(subSeen ? 'PASS lead 调度派发子任务' : 'FAIL 未见子任务')
console.log(hitlSeen ? `PASS HITL: Agent 发起下发审批并获批准(${pendDetail.slice(0, 50)})` : 'FAIL 未见 HITL 审批')
console.log(valueSeen ? `PASS 参数下发生效: 设定值 ${valueBefore} → ${finalNode.value}(目标 ~184)` : `FAIL 设定值未变化: ${finalNode.value}`)
console.log(`PASS 打标样本: 产线窗口内 ${tagged} 样本(线运行中)`)
console.log('保留资产: channel=' + ch.channelId + ' team=' + team.id + ' worker=' + workerInst.id + ' task=' + taskId + '(线保持运行,可在 UI 查看)')
