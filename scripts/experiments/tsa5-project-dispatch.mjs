// tsa5 round — project dispatch leg (simple, low-token per user instruction):
// 1) industrial: one small read-only quick-check item on the fresh batch;
// 2) landing (G5 continuation): small iteration on the delivered landing page — append an
//    FAQ section to the existing single-file HTML and return the updated artifact.
// Both use the same channel/deliverable pattern as TSA4's completed items.
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const BASE = 'http://127.0.0.1:3021'
const G4 = '87407519-2508-4f40-82a6-e729fc6ce9c0'
const G5 = '26389929-f571-4670-b235-d04445764e60'
const stamp = Date.now().toString(36)
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

const out = { stamp }

// ---- industrial: reuse the TSA4 summary item's deliverable/channel (both COMPLETED there) ----
const g4 = await items(G4)
const prior = g4.find(w => String(w.id).startsWith('1ec7f418'))
if (prior?.deliverableId && prior?.channelId) {
  const created = await api('POST', `/api/workshop/projects/${G4}/work-items`, {
    deliverableId: prior.deliverableId,
    channelId: prior.channelId,
    title: '批次快检(TSA5,只读):当前批次前段克重读数与目标带对照一句话结论',
    brief: '只读快检:读取当前活动批次最近10分钟「制品克重PV」采样,给均值/样本数,并对照目标带 32.50±0.35g 给一句话判定(达标/偏高/偏低/不可判)。不写任何参数。',
    acceptanceCriteria: ['含均值与样本数', '含目标带对照判定', '只读(无写操作)'],
    resultKey: `batch-quickcheck-tsa5-${stamp}`,
    dedupeKey: `tsa5-quickcheck-${stamp}`,
    dependsOn: [],
    execBudgetMinutes: 15,
  })
  out.industrial = { s: created.s, id: created.j?.data?.id }
  if (created.j?.data?.id) {
    const d = await api('POST', `/api/workshop/projects/${G4}/work-items/${created.j.data.id}/dispatch`, {})
    out.industrial.dispatch = { s: d.s, state: d.j?.data?.state, instanceChannelId: d.j?.data?.instanceChannelId }
  }
} else out.industrial = { note: 'prior item not found', g4Count: g4.length }

// ---- landing: FAQ iteration on the delivered landing page (G5 continuation) ----
const g5 = await items(G5)
const priorLanding = g5.find(w => String(w.id).startsWith('f7ddce9a'))
if (priorLanding?.deliverableId && priorLanding?.channelId) {
  const created = await api('POST', `/api/workshop/projects/${G5}/work-items`, {
    deliverableId: priorLanding.deliverableId,
    channelId: priorLanding.channelId,
    title: '落地页迭代(TSA5):为已交付 landing-page.html 追加 FAQ 区块并回传完整更新文件',
    brief: '在已交付的单文件 landing-page.html 基础上追加一个 FAQ 区块(至少 4 问 4 答,内容与产品一致),保持单文件自包含(离线可开),其余区块不变;完成后以 complete_task 回传更新后的完整 HTML。',
    acceptanceCriteria: ['FAQ 区块 ≥4 问 4 答', '仍为单文件自包含 HTML', '原区块保留不缺失'],
    resultKey: `landing-faq-tsa5-${stamp}`,
    dedupeKey: `tsa5-landing-faq-${stamp}`,
    dependsOn: [],
    execBudgetMinutes: 25,
  })
  out.landing = { s: created.s, id: created.j?.data?.id }
  if (created.j?.data?.id) {
    const d = await api('POST', `/api/workshop/projects/${G5}/work-items/${created.j.data.id}/dispatch`, {})
    out.landing.dispatch = { s: d.s, state: d.j?.data?.state, instanceChannelId: d.j?.data?.instanceChannelId }
  }
} else out.landing = { note: 'prior landing item not found', g5Count: g5.length }

writeFileSync('D:/tmp/aw-liv5-1121/dispatch-result.json', JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
