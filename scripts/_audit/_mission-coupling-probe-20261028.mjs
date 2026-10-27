/**
 * 耦合实验:直接经模拟器 REST 写 hold-pressure-sp → 观测 part-weight 响应。
 * 判定:Δweight/Δpressure 是否接近模型增益 0.052 g/bar(65s 窗)。
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
const SIM = 'http://127.0.0.1:4020'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const nodes = await fetch(`${SIM}/api/nodes`).then(r => r.json())
const ns = nodes.data?.nodes ?? nodes.data ?? nodes
const inj = (Array.isArray(ns) ? ns : []).find(n => /inject/i.test(n.id))
const sig = id => (inj.signals ?? []).find(s => s.id === id)?.value
const setSp = async (id, v) => {
  const r = await fetch(`${SIM}/api/nodes/${inj.id}/signals/${id}/manual`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) })
  return r.status
}
console.log('baseline: press=', sig('hold-pressure-sp'), 'time=', sig('hold-time-sp'), 'weight=', sig('part-weight'))
await setSp('hold-pressure-sp', 85)
console.log('set 85bar →', await setSp('hold-pressure-sp', 85))
for (const t of [20, 40, 65, 90]) {
  await sleep(t === 20 ? 20000 : t === 40 ? 20000 : t === 65 ? 25000 : 25000)
  console.log(`t+${t}s: press=${sig('hold-pressure-sp')} weight=${sig('part-weight')}`)
}
const nd = await fetch(`${SIM}/api/nodes`).then(r => r.json())
const ns2 = nd.data?.nodes ?? nd.data ?? nd
const inj2 = (Array.isArray(ns2) ? ns2 : []).find(n => /inject/i.test(n.id))
const sig2 = id => (inj2.signals ?? []).find(s => s.id === id)?.value
console.log('final: press=', sig2('hold-pressure-sp'), 'weight=', sig2('part-weight'))
