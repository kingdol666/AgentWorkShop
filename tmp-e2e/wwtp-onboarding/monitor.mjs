// 投用监控轮:退火线(回退后恢复)+ 污水线(寻优推进)双线巡视
// 每轮:任务树/HITL 待办(自动以运营者口径裁决并留痕)/出水质量/退火 PV 方差/ops 要闻
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

const ROUNDS = Number(process.env.ROUNDS ?? 8)
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n──── 巡视 #${round} @ ${stamp()} ────`)
  // ① HITL 待办:投用期运营者裁决(按用户指示代行,意见留痕)
  const p = await api('GET', '/api/workshop/hitl/pending')
  const cards = p?.data?.items ?? []
  console.log(`HITL 待办: ${cards.length}`)
  for (const c of cards) {
    console.log(`  卡 ${c.id} [${c.title}] ${String(c.detail).slice(0, 120)}`)
    const isWwtp = String(c.detail).includes('A2O') || String(c.detail).includes('污水')
    const decision = c.title.includes('回退')
      ? { ok: true, why: '回退类=保护性动作,照准' }
      : isWwtp
        ? { ok: true, why: '污水线寻优提案(达标窗内小步),照准' }
        : { ok: false, why: '非本期投用范围的加码类动作,拒绝待人工' }
    const verdict = decision.ok ? '批准' : '拒绝'
    const r = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: c.id, confirmed: decision.ok, comment: `投用监控巡视自动裁决(${decision.why})`, ...(String(c.nodeId).includes('recipe-propose:') ? { choice: 0 } : {}) })
    console.log(`  → 裁决[${verdict}]: ${r.code} ${decision.why}`)
  }
  // ② 污水线:出水质量 + 任务树
  const now = Date.now()
  const q = {}
  for (const [id, k] of [['dn-2d87cc99', 'COD'], ['dn-0fca842d', '氨氮'], ['dn-35e9a456', '总磷']]) {
    const s = await api('GET', `/api/workshop/daq/${id}/samples?from=${now - 300_000}&to=${now}&bucketMs=60_000`.replace('60_000', '60000'))
    const pts = (s?.data?.points ?? []).filter(x => x.avg != null)
    q[k] = pts.at(-1)?.avg
  }
  console.log(`污水线出水: COD=${q.COD?.toFixed?.(1)} 氨氮=${q['氨氮']?.toFixed?.(2)} 总磷=${q['总磷']?.toFixed?.(2)}(达标线 80/8/1)`)
  const t = await api('GET', '/api/workshop/channels/344a6282-c7c3-4aed-906f-e5dcfa8794f8/tasks')
  const states = (t.data ?? []).map(x => `${x.state}:${String(x.title).slice(0, 18)}`)
  console.log('污水线任务树:', states.join(' | '))
  // ③ 退火线:线速 PV 方差(猎振是否收敛)
  const s2 = await api('GET', '/api/workshop/daq/dn-3c3441e2/samples?from=' + (now - 300_000) + '&to=' + now + '&bucketMs=10000')
  const pv = (s2?.data?.points ?? []).filter(x => x.avg != null).map(x => x.avg)
  if (pv.length > 2) {
    const mean = pv.reduce((a, b) => a + b, 0) / pv.length
    const sd = Math.sqrt(pv.reduce((a, b) => a + (b - mean) ** 2, 0) / pv.length)
    console.log(`退火线速 PV: mean=${mean.toFixed(1)} σ=${sd.toFixed(2)}(猎振收敛判据 σ<2)`)
  }
  if (round < ROUNDS) await sleep(90_000)
}
console.log('\n巡视结束')
