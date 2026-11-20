// tsa3 round — smoke closed-loop step only (equivalent of onboard.mjs stage 5, test semantics, auto-HITL).
// Target: 保压压力SP (modbus-tcp, healthy family). Reuses prov/forge entities from the tsa3 onboarding.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = process.env.AW_TOKEN
if (!TOKEN) throw new Error('AW_TOKEN required')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(method, path, body, timeoutMs = 30_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

const cfg = JSON.parse(readFileSync('D:/tmp/aw-liv3-1120/config-tsa3.json', 'utf8'))
const prov = { lineId: 'ln-a80dfb0d', recipeId: 'rc-1bafdcf9', dcw: { 保压压力SP: 'dw-3495bb89' } }
const channelId = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const smokeParam = cfg.smoke?.param ?? '保压压力SP'
const nodeId = prov.dcw[smokeParam]

const bs = await api('GET', '/api/workshop/agent-tools/bindings')
const workerId = (bs.json?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === prov.recipeId)?.agentId ?? ''
if (!workerId) throw new Error(`no recipe-bound agent: ${JSON.stringify(bs.json).slice(0, 200)}`)
console.log(`worker=${workerId.slice(0, 8)} node=${nodeId}`)

const agg = await api('GET', '/api/workshop/dcw')
const node = (agg.json?.data?.nodes ?? []).find(n => n.id === nodeId)
const cur = Math.round(Number(node?.value ?? (node?.min + node?.max) / 2))
const rp = (cfg.recipe?.params ?? []).find(p => p.node === smokeParam)
const lower = rp?.min ?? node?.min
const upper = rp?.max ?? node?.max
let target = cur + Number(cfg.smoke?.delta ?? 1)
if (target > upper) target = cur - Number(cfg.smoke?.delta ?? 1)
target = Math.min(upper, Math.max(lower, target))
console.log(`cur=${cur} target=${target} window=${lower}~${upper}`)

let okDispatch = false
let propTxt = ''
let cardUsed = null
for (let attempt = 1; attempt <= 4 && !okDispatch; attempt++) {
  const marker = `SM5-冒烟步(${attempt})`
  const pkg = { name: marker, params: [{ node_id: nodeId, to: target, basis: `投用冒烟(测试语义,自动裁决):${cur}→${target}(≤步限)`, exp_ref: 'tsa3-smoke 自动 HITL' }] }
  const known = new Set((await api('GET', '/api/workshop/hitl/pending')).json?.data?.items?.map(x => x.id) ?? [])
  const propP = api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool: 'recipe_propose', args: { recipe_id: prov.recipeId, packages: [pkg] } }, 240_000)
    .then(r => r?.json?.data?.result ?? { text: '' })
    .catch(e => ({ text: `冒烟 invoke 失败:${e instanceof Error ? e.message : String(e)}` }))
  let card = null
  for (let i = 0; i < 90 && !card; i++) {
    await sleep(2000)
    const pend = await api('GET', '/api/workshop/hitl/pending')
    const items = pend.json?.data?.items ?? []
    card = items.find(x => !known.has(x.id) && x.kind === 'dcw-approval' && /^recipe-propose:/.test(String(x.nodeId ?? '')) && String(x.detail ?? '').includes(marker)) ?? null
  }
  if (!card) { save('smoke-ABORT.json', { error: 'no smoke approval card', attempt }); throw new Error('冒烟审批卡未出现') }
  cardUsed = card.id
  console.log(`card=${card.id} approve(choice=0)…`)
  const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment: `冒烟自动裁决(测试语义,attempt ${attempt})`, choice: 0 })
  save(`smoke-decide-a${attempt}.json`, { cardId: card.id, status: decide.status })
  const prop = await propP
  propTxt = String(prop?.text ?? '')
  save(`smoke-propose-a${attempt}.json`, { text: propTxt.slice(0, 1200) })
  okDispatch = /已获批准|已批准/.test(propTxt) && /设备证实/.test(propTxt) && !/失败|超时未批|未获批准/.test(propTxt)
  if (!okDispatch) {
    const w = Number(/请等待约?\s*(\d+)s/.exec(propTxt)?.[1] ?? 0)
    if (w > 0 && attempt < 4) { console.log(`治理窗 ${w}s,等 ${w + 10}s 重提…`); await sleep((w + 10) * 1000); continue }
  }
}
const smokeRunId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? null
console.log(`SMOKE-RESULT ${JSON.stringify({ okDispatch, runId: smokeRunId, card: cardUsed, channelId, lineId: prov.lineId })}`)

// independent readback on the smoke target
await sleep(4000)
const rb = await api('POST', `/api/workshop/dcw/${nodeId}/read`, {})
save('smoke-readback.json', { read: rb.json?.data?.read ?? rb.json })
console.log(`readback=${JSON.stringify(rb.json?.data?.read ?? rb.json).slice(0, 160)}`)
