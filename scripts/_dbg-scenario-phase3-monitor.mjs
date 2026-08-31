/** 端到端 Phase 3 监视器:重新挂载观察 worker 的 HITL/写副作用/任务收敛(omp 回合可能较慢) */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const CHANNEL = process.argv[2] ?? '52979e79-5592-46df-87eb-02658168f7ac'
const WORKER = process.argv[3] ?? '0effc739-d9a0-4ab3-b14f-98596e0a44ca'
const DW_TEMP = 'dw-322b197'
const BEFORE = 182
const TARGET = 184

let hitlSeen = false, valueSeen = false
for (let i = 0; i < 240; i++) {
  await sleep(2000)
  const tasks = (await J(`/api/workshop/channels/${CHANNEL}/tasks`)).data
  const arr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? []
  const sub = arr.find(t => t.id !== arr.find(x => x.parentId)?.id) ?? arr[arr.length - 1]
  const states = arr.map(t => t.state).join(',')
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${WORKER}`)).data.approvals
  if (pend.length > 0 && !hitlSeen) {
    hitlSeen = true
    console.log(`[t+${i * 2}s] HITL 审批请求: ${pend[0].detail.slice(0, 90)}`)
    const r = await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '窗口内小步优化,批准' })
    console.log('[HITL] 批准结果:', r.code === 0 ? 'OK' : JSON.stringify(r).slice(0, 120))
  }
  const dwNow = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === DW_TEMP)
  if (dwNow?.value != null && Math.abs(dwNow.value - TARGET) <= 1.5) valueSeen = true
  if (i % 5 === 0) console.log(`[t+${i * 2}s] tasks[${states}] 设定值=${dwNow?.value} HITL=${hitlSeen ? '已批' : pend.length ? '待批' : '未出现'}`)
  if (valueSeen && i > 10) { console.log(`[t+${i * 2}s] 写副作用确认,设定值=${dwNow.value}`); break }
  if (i > 30 && !hitlSeen && states.split(',').every(s => s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELED')) {
    console.log(`[t+${i * 2}s] 任务树全部终态但未见 HITL`)
    break
  }
}
const fin = (await J('/api/workshop/dcw')).data
const finalNode = fin.nodes.find(n => n.id === DW_TEMP)
const agentWrite = fin.history.filter(h => h.nodeId === DW_TEMP && h.ok).slice(-3)
console.log('==== 结果 ====')
console.log('HITL:', hitlSeen ? 'PASS' : 'FAIL')
console.log(`设定值: ${BEFORE} → ${finalNode.value}(目标 ~${TARGET}):`, valueSeen ? 'PASS 生效' : 'FAIL 未生效')
console.log('最近写历史:', JSON.stringify(agentWrite.map(h => ({ v: h.value, ok: h.ok, run: h.recipeRunId?.slice(0, 8) ?? null }))))
console.log('PHASE3 MONITOR DONE')
