// 注塑二线 优化任务测试监控:任务树 + HITL 运营者裁决 + 克重/质量趋势 + SP 读回
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3001'
const TOK = readFileSync('tmp-e2e/admin.tok', 'utf8').trim()
const H = { 'content-type': 'application/json', 'authorization': `Bearer ${TOK}` }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, u, b) => {
  for (let i = 0; i < 3; i++) {
    try {
      return await fetch(BASE + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) }).then(r => r.json())
    }
    catch (e) {
      if (i === 2) throw e
      await sleep(3000)
    }
  }
}
const stamp = () => new Date().toISOString().slice(11, 19)
const CH = 'd0d4f20d-9ef1-4f23-bc3b-a4c7161b25f3'
const Q = { weight: 'dn-b40935bc', flash: 'dn-97adc8f0', sink: 'dn-232c064b' }
const DW = { 机筒温度区3SP: 'dw-25f03d77', 机筒温度区4SP: 'dw-910ae666', 锁模力SP: 'dw-feb77567' }

const ROUNDS = Number(process.env.ROUNDS ?? 12)
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n──── 巡视 #${round} @ ${stamp()} ────`)
  try {
    // ① HITL:本频道卡 = 运营者裁决(批准窗内小步;越 hard 限拒绝)
    const p = await api('GET', '/api/workshop/hitl/pending')
    const cards = (p?.data?.items ?? []).filter(c => String(c.detail).includes('二线') || String(c.detail).includes('克重'))
    console.log(`HITL 待办(本频道): ${cards.length}`)
    for (const c of cards) {
      console.log(`  卡 ${c.id} [${c.title}] ${String(c.detail).slice(0, 110)}`)
      const hard = /2[89]\d(\.\d)?\s*℃|2[3-9]00\s*kN/i.test(String(c.detail))
      const r = await api('POST', '/api/workshop/hitl/respond', {
        kind: 'dcw-approval', id: c.id, confirmed: !hard,
        comment: `投用监控运营者裁决(${hard ? '越 hard 限,拒绝' : '窗内小步,批准'})`,
        ...(String(c.nodeId).includes('recipe-propose:') ? { choice: 0 } : {}),
      })
      const verdict = hard ? '拒绝' : '批准'
      console.log(`  → 裁决[${verdict}]: ${r.code}`)
    }
    // ② 克重/质量趋势(5min 窗)
    const now = Date.now()
    const vals = {}
    for (const [k, id] of Object.entries(Q)) {
      const s = await api('GET', `/api/workshop/daq/${id}/samples?from=${now - 300_000}&to=${now}&bucketMs=60000`)
      const pts = (s?.data?.points ?? []).filter(x => x.avg != null)
      vals[k] = { n: pts.length, last: pts.at(-1)?.avg }
    }
    const w = vals.weight.last
    const inWindow = w != null && Math.abs(w - 32.5) <= 0.5
    console.log(`克重=${w?.toFixed?.(2)}g(窗 32.5±0.5 → ${inWindow ? '窗内' : '窗外'}) | 飞边=${vals.flash.last?.toFixed?.(2)}% 缩痕=${vals.sink.last?.toFixed?.(2)}% | 5min 样本=${vals.weight.n}`)
    // ③ SP 读回
    const agg = await api('GET', '/api/workshop/dcw')
    const sps = (agg?.data?.nodes ?? []).filter(n => Object.values(DW).includes(n.id)).map(n => `${n.name}=${n.value}`)
    console.log('SP 读回:', sps.join(' '))
    // ④ 任务树
    const t = await api('GET', `/api/workshop/channels/${CH}/tasks`)
    console.log('任务树:', (t.data ?? []).map(x => `${x.state}:${String(x.title).slice(0, 16)}`).join(' | '))
  }
  catch (e) {
    console.log(`  (本轮探测异常,继续: ${String(e).slice(0, 60)})`)
  }
  if (round < ROUNDS) await sleep(90_000)
}
console.log('\n优化任务监控结束')
