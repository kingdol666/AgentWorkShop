// tsa5 round — R2 direct probe: hold-time SP +0.5s via package approval (same path as R1).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const NODE = 'dw-852f4e0f'

const bs = await fetch(`${BASE}/api/workshop/agent-tools/bindings`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) })
const bsj = await bs.json().catch(() => ({}))
const workerId = (bsj?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === 'rc-1bafdcf9')?.agentId ?? ''
if (!workerId) throw new Error('no recipe-bound worker')

const agg = await fetch(`${BASE}/api/workshop/dcw`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) })
const aggj = await agg.json().catch(() => ({}))
const node = (aggj?.data?.nodes ?? []).find(n => n.id === NODE)
const cur = Number(node?.value ?? 7)
const target = Math.min(8, cur + 0.5)

const marker = `SM5-R2(${Date.now().toString(36)})`
const inv = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({
    agentId: workerId,
    tool: 'recipe_propose',
    args: {
      recipe_id: 'rc-1bafdcf9',
      packages: [{ name: marker, params: [{ node_id: NODE, to: target, basis: `TSA5 R2 验收(测试语义,人工知情 override):设备实读 ${cur}→${target}(≤步限0.5)`, exp_ref: 'tsa5-r2-direct' }] }],
    },
  }),
  signal: AbortSignal.timeout(240_000),
})
const invj = await inv.json().catch(() => ({}))
const text = String(invj?.data?.result?.text ?? '')
writeFileSync(join(EV, 'r2-direct-invoke.json'), JSON.stringify({ status: inv.status, textHead: text.slice(0, 600) }))
console.log('invoke:', inv.status, text.slice(0, 160).replace(/\n/g, ' '))

// wait for the package card (global queue; up to 4 min)
let card = null
const t0 = Date.now()
while (Date.now() - t0 < 240_000 && !card) {
  await new Promise(r => setTimeout(r, 8000))
  const p = await fetch(`${BASE}/api/workshop/hitl/pending`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15_000) })
  const items = (await p.json().catch(() => ({})))?.data?.items ?? []
  card = items.find(i => i.kind === 'dcw-approval') ?? null
}
if (!card) { console.log('NO-CARD'); process.exit(1) }
writeFileSync(join(EV, 'r2-card.json'), JSON.stringify(card))
const dec = await fetch(`${BASE}/api/workshop/hitl/respond`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({ kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, choice: 0, comment: 'TSA5 R2 验收:人工知情 override(测试语义),批准执行' }),
  signal: AbortSignal.timeout(30_000),
})
console.log('decide:', dec.status)
await new Promise(r => setTimeout(r, 5000))
const rb = await fetch(`${BASE}/api/workshop/dcw/${NODE}/read`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: '{}', signal: AbortSignal.timeout(30_000) })
const rj = await rb.json().catch(() => ({}))
writeFileSync(join(EV, 'r2-readback.json'), JSON.stringify(rj?.data ?? rj))
console.log('R2 readback:', JSON.stringify(rj?.data?.read))
console.log('TSA5-R2-RESULT ' + JSON.stringify({ card: card.id, decide: dec.status, readback: rj?.data?.read?.value }))
