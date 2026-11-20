// tsa5 round — plan-card watcher: polls /approvals for pending plan_approval cards on the
// two active projects (industrial 87407519, landing 26389929), auto-approves per prior
// owner-approved acceptance semantics (test round), records decisions.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const EV = join(process.cwd(), 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = process.env.AW_TOKEN
const PROJECTS = ['87407519-2508-4f40-82a6-e729fc6ce9c0', '26389929-f571-4670-b235-d04445764e60']
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(method, path, body, timeoutMs = 30_000) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await r.text()
  let json; try { json = JSON.parse(text) }
  catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

const decided = []
const t0 = Date.now()
while (Date.now() - t0 < 30 * 60_000) {
  const pend = await api('GET', '/api/workshop/approvals?status=pending')
  const items = pend.json?.data?.items ?? []
  for (const card of items) {
    const pid = card.projectId ?? ''
    if (!PROJECTS.includes(pid)) continue
    if (card.kind === 'plan_approval') {
      console.log(`plan card ${card.id} on ${pid.slice(0, 8)} — approve`)
      const dec = await api('POST', `/api/workshop/approvals/${card.id}/decide`, { approved: true, comment: '20261120 TSA5 验收轮:按既定目标批准计划(测试语义,沿用前轮授权口径)' })
      save(`plan-decide-${card.id.slice(0, 8)}.json`, { cardId: card.id, projectId: pid, status: dec.status, body: dec.json })
      decided.push({ card: card.id, pid, status: dec.status })
    }
  }
  const bothPlanned = decided.filter(d => d.status === 200).length
  if (bothPlanned >= 2) break
  await sleep(20_000)
}
console.log('PLANWATCH-RESULT ' + JSON.stringify({ decided }))
