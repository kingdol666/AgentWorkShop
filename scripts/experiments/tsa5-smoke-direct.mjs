// tsa5 round — direct recipe_propose probe: capture the synchronous tool response text to
// locate where the governed-write proposal path stalls (invoke → card). Test semantics.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin

// recipe-bound worker (from TSA3 binding): find via bindings
const bs = await fetch(`${BASE}/api/workshop/agent-tools/bindings`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) })
const bsj = await bs.json().catch(() => ({}))
const workerId = (bsj?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === 'rc-1bafdcf9')?.agentId ?? ''
writeFileSync(join(EV, 'smoke-bindings.json'), JSON.stringify({ workerId: workerId.slice(0, 12), found: Boolean(workerId) }))
if (!workerId) throw new Error('no recipe-bound worker')

const agg = await fetch(`${BASE}/api/workshop/dcw`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) })
const aggj = await agg.json().catch(() => ({}))
const node = (aggj?.data?.nodes ?? []).find(n => n.id === 'dw-3495bb89')
const cur = Math.round(Number(node?.value ?? 64))
const target = Math.min(85, cur + 1)
writeFileSync(join(EV, 'smoke-plan.json'), JSON.stringify({ cur, target }))

const marker = `SM5-直接探针(${Date.now().toString(36)})`
const t0 = Date.now()
const inv = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
  body: JSON.stringify({
    agentId: workerId,
    tool: 'recipe_propose',
    args: {
      recipe_id: 'rc-1bafdcf9',
      packages: [{ name: marker, params: [{ node_id: 'dw-3495bb89', to: target, basis: `TSA5 验收探针(测试语义,人工知情):${cur}→${target}(≤步限2)`, exp_ref: 'tsa5-smoke-direct' }] }],
    },
  }),
  signal: AbortSignal.timeout(240_000),
})
const invj = await inv.json().catch(() => ({}))
const text = String(invj?.data?.result?.text ?? JSON.stringify(invj).slice(0, 400))
writeFileSync(join(EV, 'smoke-direct-invoke.json'), JSON.stringify({ status: inv.status, elapsedMs: Date.now() - t0, textHead: text.slice(0, 1200) }))
console.log(`DIRECT-INVOKE status=${inv.status} elapsed=${Math.round((Date.now() - t0) / 1000)}s`)
console.log(text.slice(0, 500).replace(/\n/g, ' '))
