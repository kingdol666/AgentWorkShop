/** 最终验收续跑:T4 恢复增长确认 + T5 真实 Modbus 下发 + T6 Agent 权限 */
const BASE = 'http://127.0.0.1:3000'
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
const metaWithRetry = async () => {
  for (let i = 0; i < 5; i++) {
    const d = (await J('/api/workshop/daq')).data
    if (d?.meta) return d.meta
    await sleep(1500)
  }
  return null
}

// ── T4 恢复增长确认(线已在 T4 末尾复跑) ──
{
  const m1 = await metaWithRetry()
  await sleep(6000)
  const m2 = await metaWithRetry()
  okIf(`T4 复跑恢复: produced ${m1?.produced} → ${m2?.produced}(增长)`, m2?.produced > m1?.produced)
  const consumedOk = (m2?.consumed ?? 0) > 0 && (m2?.samplesStored ?? 0) > 0
  okIf(`T4 消费链路: consumed=${m2?.consumed} samplesStored=${m2?.samplesStored}(队列消费+入库在走)`, consumedOk)
}

// ── T5 真实 Modbus PLC 下发 ──
{
  let mk = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '真机-温度设定')
  const w = await fetch(`${BASE}/api/workshop/dcw/${mk.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 175 }) }).then(r => r.json())
  const oc = w.data?.outcome
  okIf(`T5 真实 PLC 写: 175 → raw ${oc?.raw}(回读一致) msg=${String(oc?.message ?? '').slice(0, 45)}`, w.code === 0 && oc?.ok === true && oc?.raw === 1000)
  const w2 = await fetch(`${BASE}/api/workshop/dcw/${mk.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 180 }) }).then(r => r.json())
  okIf(`T5 真实 PLC 写: 180 → raw ${w2.data?.outcome?.raw}(1200)`, w2.code === 0 && w2.data?.outcome?.ok === true && w2.data?.outcome?.raw === 1200)
  await sleep(4500)
  const daqLive = (await J('/api/workshop/daq')).data.nodes.find(n => n.name === '真机-温度采集')
  okIf(`T5 真机数采: ${daqLive?.name} = ${daqLive?.value} ${daqLive?.unit} (${daqLive?.state}, 真实 Modbus 读 40003)`, daqLive?.value != null && daqLive?.value > 100 && daqLive?.state === 'ok')
}

// ── T6 Agent 权限注入 ──
{
  const worker = '0effc739-d9a0-4ab3-b14f-98596e0a44ca'
  const unboundDcw = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '真机-温度设定')
  const denied = await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'dcw_control', args: { nodeId: unboundDcw.id, value: 185 } }).then(r => r.data?.result)
  const deniedText = String(denied?.text ?? denied ?? '')
  okIf(`T6 无绑定节点 dcw_control 被拒(${deniedText.slice(0, 60)})`, /未授权|无权|绑定|denied|权限|失败|拒绝|error/i.test(deniedText))

  const dwTemp = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '温度设定器(示例)')
  await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'dcw_control', args: { nodeId: dwTemp.id, value: 184 } })
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker}`)).data.approvals
  okIf(`T6 已绑定节点发起下发 → HITL 待审(${pend.length} 条)`, pend.length > 0)
  if (pend.length > 0) {
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: false, comment: '最终验收:保持 183,拒绝本次变更' })
    await sleep(1200)
    const now = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id)
    const pendAfter = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker}`)).data.approvals
    okIf(`T6 HITL 拒绝路径: pending 收敛(${pendAfter.length})且值保持(${now.value})`, pendAfter.length === 0 && Math.abs(now.value - 183) < 0.01)
  }
  const q = await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'daq_query', args: { last_minutes: 5 } }).then(r => r.data?.result)
  const qText = String(q?.text ?? '')
  okIf('T6 daq_query 仅列有权节点(有压力/温度,无真机-温度采集)', qText.includes('压力变送器 01') && !qText.includes('真机-温度采集'))
}

console.log('')
console.log(fails.length ? `=== 续跑 FAILED(${fails.length}) ===` : '=== 续跑 ALL PASS ===')
fails.forEach(f => console.log(' -', f))
process.exit(fails.length ? 1 : 0)
