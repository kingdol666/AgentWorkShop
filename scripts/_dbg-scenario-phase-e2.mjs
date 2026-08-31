/** 端到端 Phase E 强化版:AgentTeam 反馈控制(确定性下发策略 + 未发起则重派)
 *  ① 强化 worker 系统提示:指令给出精确目标值时必须 dcw_control 下发
 *  ② 提交任务 → 轮询 HITL(批准)→ 断言写入生效;子任务完成但无 HITL → 重派一次
 */
const BASE = 'http://127.0.0.1:3000'
const CHANNEL = '52979e79-5592-46df-87eb-02658168f7ac'
const WORKER = '0effc739-d9a0-4ab3-b14f-98596e0a44ca'
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

// ── ① 强化 worker 系统提示(模板级,持久化) ──
const strengthened = '你是产线工艺优化工程师。用 my_industrial_nodes 查看授权节点,用 daq_query 获取最新工况。当任务给出精确目标值时,你必须调用 dcw_control 下发该目标值(除非超出安全量程∩工艺窗口),不得以「已在窗口内/偏差可接受」为由跳过下发;下发后必须复测设定值并在结论中引用前后数值。'
const agents = await J('/api/workshop/agents')
const tpl = (agents.data ?? []).find(a => a.id === WORKER) ?? (agents.data ?? []).find(a => a.name?.includes('工艺优化工程师'))
console.log('worker 模板:', tpl?.id, tpl?.name)
const upd = await J(`/api/workshop/agents/${tpl.id}`, 'PATCH', { config: { ...(tpl.config ?? {}), systemPromptPrefix: strengthened } })
okIf('① worker 系统提示已强化(强制精确下发策略)', upd.code === 0)

// ── ② 提交任务 + 观察循环(最多两轮;第一轮无 HITL 则重派) ──
const dwValue = () => J('/api/workshop/dcw').then(r => r.data.nodes.find(n => n.name === '温度设定器(示例)').value)
const valueBefore = await dwValue()
console.log(`当前设定值: ${valueBefore} → 任务目标: 185`)

let hitlSeen = false, hitlDetail = ''
let finalSub = null
for (let attempt = 1; attempt <= 2; attempt++) {
  console.log(`━━━ 派发尝试 #${attempt} ━━━`)
  const task = (await J(`/api/workshop/channels/${CHANNEL}/tasks`, 'POST', {
    title: `烘箱温度反馈控制(E-${attempt})`,
    parts: [{ text: `确定性控制指令:将烘箱温度设定精确调整到 185℃ 并通过 dcw_control 下发(工艺窗口 176~188℃;手动确认模式,发起后等待批准),随后复测设定值并汇报前后对比。` }],
    mode: 'loop',
  })).data
  const taskId = task?.task?.id ?? task?.id
  if (!taskId) { fails.push('派发失败'); continue }
  let sub = null
  for (let i = 0; i < 200; i++) {
    await sleep(2000)
    const tasks = (await J(`/api/workshop/channels/${CHANNEL}/tasks`)).data
    const arr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? []
    sub = arr.find(t => t.parentId === taskId)
    if (sub && !finalSub) { finalSub = sub; console.log(`[t+${i * 2}s] 子任务派发 → ${sub.assigneeId?.slice(0, 8)} (${sub.state})`) }
    const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${WORKER}`)).data.approvals
    if (pend.length > 0) {
      if (!hitlSeen) { hitlSeen = true; console.log(`[t+${i * 2}s] HITL 待审: ${pend[0].detail.slice(0, 70)}`) }
      await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '窗口内反馈控制,批准' })
      console.log('[HITL] 已批准')
    }
    const done = sub && ['COMPLETED', 'FAILED', 'CANCELED'].includes(sub.state)
    const now = await dwValue()
    if (Math.abs(now - 185) < 0.01) { console.log(`[t+${i * 2}s] 设定值已生效 = ${now}`); break }
    if (done) { console.log(`[t+${i * 2}s] 子任务 ${sub.state} 结束,设定值=${now},无 HITL=${!hitlSeen}`); break }
    if (i === 199) console.log('[超时 400s]')
  }
  const now = await dwValue()
  if (Math.abs(now - 185) < 0.01) break
  if (attempt === 1) console.log('第一轮 worker 未下发 → 重派一次')
}

// ── ③ 断言 ──
const finalValue = await dwValue()
okIf(`② HITL 审批链路(发起+批准)`, hitlSeen)
okIf(`③ 参数真实下发生效: 设定值 = ${finalValue}(目标 185)`, Math.abs(finalValue - 185) < 0.01)
const states = (await J('/api/workshop/dcw/lines')).data.states
okIf(`④ 打标持续: taggedSamples=${states.find(s => s.lineId === LINE)?.taggedSamples}`, (states.find(s => s.lineId === LINE)?.taggedSamples ?? 0) > 0)
console.log(fails.length ? `PHASE-E FAILED(${fails.length})` : 'PHASE-E ALL PASS')
process.exit(fails.length ? 1 : 0)
