const BASE = 'http://127.0.0.1:3000'
const LINE = 'ln-af002514'
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const agents = (await J(`/api/workshop/channels/52979e79-5592-46df-87eb-02658168f7ac/agents`)).data
const worker = agents.find(a => a.role === 'worker')
console.log('monitor worker:', worker.id.slice(0, 8))
let hitl = false
for (let i = 0; i < 220; i++) {
  await sleep(2000)
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker.id}`)).data.approvals
  if (pend.length > 0) {
    if (!hitl) { hitl = true; console.log(`[t+${i * 2}s] HITL 待审: ${pend[0].detail.slice(0, 70)}`) }
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '终验:批准' })
    console.log('[HITL] 已批准')
  }
  const dw = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '温度设定器(示例)')
  if (Math.abs((dw.value ?? 0) - 185) < 0.01) { console.log(`[t+${i * 2}s] 设定值生效 = 185 ✓`); break }
  if (i % 10 === 0) console.log(`[t+${i * 2}s] 设定值=${dw.value} pending=${pend.length}`)
}
const fin = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '温度设定器(示例)')
console.log(hitl ? 'HITL PASS' : 'HITL FAIL')
console.log(Math.abs((fin.value ?? 0) - 185) < 0.01 ? 'WRITE PASS(=185)' : `WRITE CHECK(${fin.value})`)
