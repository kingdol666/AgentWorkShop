/** 最终验收 T6 终版:并发 HITL —— invoke 不等待先发,另路轮询批准 → 写 ACK + 值生效 */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const worker = '0effc739-d9a0-4ab3-b14f-98596e0a44ca'
const d = (await J('/api/workshop/dcw')).data
const dw = d.nodes.find(n => n.name === '温度设定器(示例)')
console.log('invoke 前 value =', dw.value)

// 并发:发出 invoke(不 await),主循环轮询 approvals 并即刻批准
const invokePromise = J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'dcw_control', args: { node_id: dw.id, value: 184 } })
  .then(r => String(r.data?.result?.text ?? JSON.stringify(r).slice(0, 150)))
let approved = false
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker}`)).data.approvals
  if (pend.length > 0) {
    console.log(`[t+${(i * 0.5).toFixed(1)}s] HITL 待审: ${pend[0].detail.slice(0, 70)}`)
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '最终验收:窗口内优化,批准' })
    approved = true
    break
  }
}
const resultText = await invokePromise
console.log('invoke 结果:', resultText.slice(0, 130))
await sleep(1500)
const now = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
console.log('')
console.log(approved ? 'PASS 并发 HITL 审批链路' : 'FAIL 未见审批')
console.log(now?.value === 184 ? `PASS 参数下发生效: 设定值 → ${now.value}℃(Agent 经 dcw_control 写 PLC)` : `FAIL 设定值: ${now?.value}`)
process.exit(approved && now?.value === 184 ? 0 : 1)
