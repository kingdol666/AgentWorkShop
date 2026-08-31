/** Phase E 终版:worker 实例回收重生(读取强化后模板)→ 重绑节点 → 任务 → HITL → 下发断言 */
const BASE = 'http://127.0.0.1:3000'
const CHANNEL = '52979e79-5592-46df-87eb-02658168f7ac'
const TEAM = '5ed0fed8-e13e-4ba2-9b2c-1c259b8fdc0d'
const LINE = 'ln-af002514'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const fails = []
const okIf = (m, c) => { if (c) console.log(`PASS ${m}`); else { console.log(`FAIL ${m}`); fails.push(m) } }

// ── 1. 回收全部旧实例(旧 system prompt 驻留) → 重新部署(读强化后模板) ──
let agents = (await J(`/api/workshop/channels/${CHANNEL}/agents`)).data
for (const a of agents) {
  await J(`/api/workshop/channels/${CHANNEL}/agents/${a.id}`, 'DELETE').catch(() => {})
}
await sleep(1500)
let dep = null
for (let i = 0; i < 3; i++) {
  dep = await J(`/api/workshop/teams/${TEAM}/deploy`, 'POST', { channelId: CHANNEL })
  if (dep.code === 0) break
  console.log('deploy 重试:', String(dep.message ?? '').slice(0, 60))
  await sleep(2000)
}
await sleep(1500)
agents = (await J(`/api/workshop/channels/${CHANNEL}/agents`)).data
const worker = agents.find(a => a.role === 'worker' && a.harness === 'omp')
okIf('① 新 worker 实例部署(harness=omp)', !!worker)
console.log('   新 worker:', worker?.id.slice(0, 8))

// ── 2. 重绑工业节点(2 数采 auto + 1 数控 manual) ──
const dcwData = (await J('/api/workshop/dcw')).data
const dwTemp = dcwData.nodes.find(n => n.name === '温度设定器(示例)')
const daqData = (await J('/api/workshop/daq')).data
const dqP = daqData.nodes.find(n => n.name === '压力变送器 01' && n.lineId === LINE)
const dqT = daqData.nodes.find(n => n.name === '温度传感器 01' && n.lineId === LINE)
for (const [nodeId, kind] of [[dqP.id, 'daq'], [dqT.id, 'daq'], [dwTemp.id, 'dcw']]) {
  const mode = kind === 'dcw' ? 'manual' : 'auto'
  await J('/api/workshop/agent-tools/bindings', 'POST', { agentId: worker.id, nodeId, kind, mode })
}
const bl = (await J(`/api/workshop/agent-tools/bindings?agentId=${worker.id}`)).data.bindings
okIf(`② 节点重绑完成: ${bl.length} 条(2 daq auto + 1 dcw manual)`, bl.length === 3)

// ── 3. 提交确定性任务 + HITL 并发批准 ──
const valueBefore = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id).value
const task = (await J(`/api/workshop/channels/${CHANNEL}/tasks`, 'POST', {
  title: '烘箱温度反馈控制(E-Final)',
  parts: [{ text: '确定性控制指令:将烘箱温度设定精确调整到 185℃ 并通过 dcw_control 下发(工艺窗口 176~188℃;手动确认模式,发起后等待批准)。步骤:1) my_industrial_nodes 确认节点;2) daq_query 读最近工况;3) dcw_control 下发 185;4) 批准后复测设定值并汇报前后对比。' }],
  mode: 'loop',
})).data
const taskId = task?.task?.id ?? task?.id
console.log(`③ 任务派发 ${taskId?.slice(0, 8)}(设定 ${valueBefore} → 185)`)

let subSeen = false, hitlSeen = false, hitlDetail = '', valueSeen = false, subState = ''
for (let i = 0; i < 220; i++) {
  await sleep(2000)
  const tasks = (await J(`/api/workshop/channels/${CHANNEL}/tasks`)).data
  const arr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? []
  const sub = arr.find(t => t.parentId === taskId)
  if (sub && !subSeen) { subSeen = true; console.log(`[t+${i * 2}s] 子任务派发 → ${sub.assigneeId?.slice(0, 8)}`) }
  if (sub) subState = sub.state
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${WORKER}`)).data.approvals
  if (pend.length > 0) {
    if (!hitlSeen) {
      hitlSeen = true
      hitlDetail = pend[0].detail
      console.log(`[t+${i * 2}s] HITL 待审: ${hitlDetail.slice(0, 70)}`)
    }
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '终验:窗口内反馈控制,批准' })
    await sleep(1500)
  }
  const now = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id).value
  if (Math.abs(now - 185) < 0.01) { valueSeen = true; console.log(`[t+${i * 2}s] 设定值生效 = ${now}`) }
  const done = sub && ['COMPLETED', 'FAILED', 'CANCELED'].includes(sub.state)
  if ((valueSeen && done) || i === 219) {
    console.log(`[t+${i * 2}s] 收敛: 子任务=${subState} 设定值=${now}`)
    break
  }
}

// ── 4. 断言 ──
const finalValue = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id).value
okIf('④ Leader 调度派发子任务', subSeen)
okIf(`④ HITL 链路(发起+批准): ${hitlDetail.slice(0, 50)}`, hitlSeen)
okIf(`④ 参数真实下发生效: ${valueBefore} → ${finalValue}(目标 185)`, Math.abs(finalValue - 185) < 0.01)
const tDetail = await J(`/api/workshop/tasks/${taskId}`)
const art = tDetail.data?.artifacts ?? []
const conclusion = art.flatMap(a => a.parts ?? []).map(p => p.text ?? '').join(' ')
console.log('④ worker 结论:', conclusion.slice(0, 200).replace(/\n/g, ' '))
console.log(fails.length ? `PHASE-E-FINAL FAILED(${fails.length})` : 'PHASE-E-FINAL ALL PASS')
process.exit(fails.length ? 1 : 0)
