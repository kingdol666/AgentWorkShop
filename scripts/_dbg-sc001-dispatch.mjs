/** 终验:工艺变更单模式的一次性确定性下发(184 → 178)+ 完成后取消 loop 链 */
const BASE = 'http://127.0.0.1:3000'
const CHANNEL = '52979e79-5592-46df-87eb-02658168f7ac'
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

const dwValue = async () => (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '温度设定器(示例)').value
const worker = ((await J(`/api/workshop/channels/${CHANNEL}/agents`)).data).find(a => a.role === 'worker')
const valueBefore = await dwValue()
console.log(`worker=${worker?.id.slice(0, 8)} | 变更前设定值=${valueBefore}(目标 178)`)

const task = (await J(`/api/workshop/channels/${CHANNEL}/tasks`, 'POST', {
  title: '工艺变更单 SC-001:烘箱温度设定 184→178',
  parts: [{ text: '工艺变更单 SC-001(客户工程变更,必须执行):本批次烘箱温度设定由 184℃ 调整为 178℃(在工艺窗口 176~188℃ 内)。请立即用 dcw_control 将烘箱温度设定下发为 178(该节点为手动确认模式,发起后等待用户批准),批准执行后复测设定值并汇报执行结果。旧值 184 不再符合新工艺要求,不得维持。' }],
})).data
const taskId = task?.task?.id ?? task?.id
if (!taskId) { console.error('派发失败'); process.exit(1) }
console.log('工艺变更任务已派发:', taskId.slice(0, 8))

let hitlSeen = false, hitlDetail = ''
for (let i = 0; i < 150; i++) {
  await sleep(2000)
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker.id}`)).data.approvals
  if (pend.length > 0) {
    if (!hitlSeen) {
      hitlSeen = true
      hitlDetail = pend[0].detail
      console.log(`[t+${i * 2}s] HITL 待审: ${hitlDetail.slice(0, 70)}`)
    }
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '工艺变更单已核对,批准' })
    await sleep(1200)
  }
  const now = await dwValue()
  if (Math.abs(now - 178) < 0.01) { console.log(`[t+${i * 2}s] 设定值生效 = 178`); break }
  if (i === 149) console.log('[超时 300s]')
}
const finalValue = await dwValue()
okIf(`① HITL 链路: ${hitlDetail.slice(0, 60)}`, hitlSeen)
okIf(`② 参数真实下发: ${valueBefore} → ${finalValue}(目标 178)`, Math.abs(finalValue - 178) < 0.01)

// ── 取消 loop 任务链(防 token 空转):所有非终态 loop 任务 ──
const tasks = (await J(`/api/workshop/channels/${CHANNEL}/tasks`)).data
const arr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? []
let cancelled = 0
for (const t of arr) {
  if (!['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) {
    await fetch(`${BASE}/api/workshop/channels/${CHANNEL}/tasks/${t.id}/cancel`, { method: 'POST', headers: H, body: '{}' }).catch(() => {})
    cancelled++
  }
}
console.log(`③ loop 任务链已取消: ${cancelled} 个(演示现场静止)`)

console.log(fails.length ? `SC-001 FAILED(${fails.length})` : 'SC-001 ALL PASS')
process.exit(fails.length ? 1 : 0)
