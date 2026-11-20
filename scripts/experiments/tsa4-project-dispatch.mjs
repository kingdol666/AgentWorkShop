// tsa4 round — project dispatch leg:
// 1) industrial: dispatch the R1s+R2s-based summary item (deps COMPLETED);
// 2) landing: the resubmission item 26537cc8 is blocked (UPSTREAM_CANCELED max attempts — the
//    TSA3 resubmission defect area). Per the recorded correct path ("retry-exhausted → new item"),
//    create a fresh work item on the same deliverable/channel and dispatch it.
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const BASE = 'http://127.0.0.1:3021'
const G4 = '87407519-2508-4f40-82a6-e729fc6ce9c0'
const G5 = '26389929-f571-4670-b235-d04445764e60'
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b), signal: AbortSignal.timeout(30_000) })
  const j = await r.json().catch(() => ({}))
  return { s: r.status, j }
}
const items = async (pid) => {
  const x = await api('GET', `/api/workshop/projects/${pid}/work-items`)
  const d = x.j?.data
  return Array.isArray(d) ? d : (d?.items ?? [])
}
const out = {}

// ---- industrial: summary based on R1s+R2s (both COMPLETED) ----
const g4 = await items(G4)
const i4 = g4.find(w => String(w.title ?? '').includes('基于 R1s+R2s') && ['DRAFT', 'PENDING'].includes(w.state))
if (i4) {
  const d = await api('POST', `/api/workshop/projects/${G4}/work-items/${i4.id}/dispatch`, {})
  out.industrial = { id: i4.id, state: i4.state, dispatch: d.s, body: d.j?.data ?? d.j }
}
else out.industrial = { note: 'no dispatchable summary item', states: g4.map(w => [String(w.title).slice(0, 24), w.state]) }

// ---- landing: new item on same deliverable/channel as the blocked 26537cc8 ----
const g5 = await items(G5)
const blocked = g5.find(w => String(w.id).startsWith('26537cc8'))
out.blocked = { id: blocked?.id, state: blocked?.state, channelId: blocked?.channelId, deliverableId: blocked?.deliverableId, resultKey: blocked?.resultKey }
if (blocked?.channelId && blocked?.deliverableId) {
  const stamp = Date.now().toString(36)
  const created = await api('POST', `/api/workshop/projects/${G5}/work-items`, {
    deliverableId: blocked.deliverableId,
    channelId: blocked.channelId,
    title: '落地页实现续跑(TSA4):按已批准设计简报完成单文件 landing-page.html 并回传产物',
    brief: '上游实现轮被平台外故障打断(历史)。本项为正解新项:基于已交付的 design-brief 与文案 deck,产出单文件 landing-page.html(自包含 HTML/CSS,可浏览器直接打开),完成后以 complete_task 交付文件并在结果中给出文件路径。',
    acceptanceCriteria: [
      '单文件 landing-page.html 存在于工作区且 >10KB',
      '结构覆盖设计简报全部区块(hero/特性/规格/FAQ/CTA)',
      '无外部网络依赖(离线可开)',
    ],
    resultKey: `landing-page-tsa4-${stamp}`,
    dedupeKey: `tsa4-landing-${stamp}`,
    execBudgetMinutes: 30,
  })
  out.landingCreated = { s: created.s, body: created.j?.data ?? created.j }
  const newId = created.j?.data?.id
  if (newId) {
    const d = await api('POST', `/api/workshop/projects/${G5}/work-items/${newId}/dispatch`, {})
    out.landingDispatch = { s: d.s, id: newId, body: d.j?.data ?? d.j }
  }
}
writeFileSync('D:/tmp/aw-liv4-1120/dispatch-result.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
