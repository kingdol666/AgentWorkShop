// tsa4 round — industrial project: create a dependency-free summary item (the R1s+R2s-based
// summary is blocked by the historic artifact gap: R2s COMPLETED without acceptable result),
// then dispatch. Uses the same channel/deliverable as the blocked item.
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const BASE = 'http://127.0.0.1:3021'
const G4 = '87407519-2508-4f40-82a6-e729fc6ce9c0'
const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b), signal: AbortSignal.timeout(30_000) })
  const j = await r.json().catch(() => ({}))
  return { s: r.status, j }
}
const items = async () => {
  const x = await api('GET', `/api/workshop/projects/${G4}/work-items`)
  const d = x.j?.data
  return Array.isArray(d) ? d : (d?.items ?? [])
}

const g4 = await items()
const blocked = g4.find(w => String(w.title ?? '').includes('基于 R1s+R2s'))
const stamp = Date.now().toString(36)
const created = await api('POST', `/api/workshop/projects/${G4}/work-items`, {
  deliverableId: blocked.deliverableId,
  channelId: blocked.channelId,
  title: '班次中期结论汇总(TSA4 新项,只读):基于 R1s/R2s 已完成轮次与本轮 R1/R2 复检',
  brief: '汇总任务(只读):整合 R1s(基线读数)、R2s(差距量化)与本轮 v0.14.0 复检 R1/R2 的事实,输出班次中期结论:当前克重相对目标带(32.50±0.35g)的位置、已执行调参步的实效、下一步建议。不写任何参数。',
  acceptanceCriteria: ['输出含目标带位置判定', '含已执行调参步实效清单', '只读(无写操作)'],
  resultKey: `midshift-summary-tsa4-${stamp}`,
  dedupeKey: `tsa4-midshift-${stamp}`,
  dependsOn: [],
  execBudgetMinutes: 25,
})
const out = { created: { s: created.s, id: created.j?.data?.id, state: created.j?.data?.state } }
const newId = created.j?.data?.id
if (newId) {
  const d = await api('POST', `/api/workshop/projects/${G4}/work-items/${newId}/dispatch`, {})
  out.dispatch = { s: d.s, state: d.j?.data?.state, instanceChannelId: d.j?.data?.instanceChannelId }
}
writeFileSync('D:/tmp/aw-liv4-1120/dispatch-industrial.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
