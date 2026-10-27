/**
 * 2026-10-28 全功能验收 US-010 证据:真实 Agent harness 优化下发与监控时间线。
 * 汇集:频道任务链(含状态机)、HITL 审批留痕、DCW 写控 journal、DAQ 复测窗口、消息流统计。
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us10-harness-timeline.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3470'
const CH = '28239c1f-2e82-4207-a528-5edfb59b27ca'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us10-harness-timeline.json'
process.env.NO_PROXY = '127.0.0.1,localhost'

const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }) }).then(r => r.json())
const TOK = login.data.token
const H = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOK}` }
const get = async p => fetch(`${BASE}${p}`, { headers: H }).then(r => r.json()).catch(() => null)

const tasks = await get(`/api/workshop/channels/${CH}/tasks`)
const taskList = (tasks?.data ?? []).map(t => ({
  id: t.id, title: (t.title ?? '').slice(0, 60), state: t.state, progress: t.progress, retry: t.retryCount,
  updatedAt: t.updatedAt,
}))
const msgs = await get(`/api/workshop/channels/${CH}/messages?limit=200`)
const mList = Array.isArray(msgs?.data) ? msgs.data : []
const byAgent = {}
for (const m of mList) {
  const k = m.fromAgentId?.slice(0, 8) ?? 'user'
  byAgent[k] = (byAgent[k] ?? 0) + 1
}
// HITL 审批:dcw 审批台账
const appr = await get('/api/workshop/hitl/pending')
// DCW journal(写控留痕;lineId 维度)
const jrn = await get(`/api/workshop/dcw/journal?lineId=${'ln-e27a1867'}&limit=100`)
const jrnList = jrn?.data?.anchors ?? jrn?.data?.items ?? []
const jrnRows = Array.isArray(jrnList)
  ? jrnList.slice(0, 40).map(x => ({
      at: x.at, node: x.nodeId, prev: x.prevValue, value: x.newValue,
      source: x.source, recipeRunId: x.recipeRunId,
    }))
  : []
// DAQ 当前窗口(闭环改善证据:复测值)
const from = Date.now() - 30 * 60_000
const daq = await get(`/api/workshop/daq/query?from=${from}&to=${Date.now()}&node_ids=dn-126004d9,dn-9c7b4a7b&limit=300`)
const series = daq?.data?.series ?? []
const weight = series.find(s => /part-weight/.test(s.name ?? ''))?.points ?? []
const cycle = series.find(s => /cycle-time/.test(s.name ?? ''))?.points ?? []

const timeline = {
  suite: 'US-010 真实 Agent harness 优化下发与监控',
  base: BASE, channel: CH, at: new Date().toISOString(),
  engine: 'omp(真实 LLM;deepseek/ark/ustc 供应商池)',
  taskChain: taskList,
  taskStateSummary: taskList.reduce((a, t) => ({ ...a, [t.state]: (a[t.state] ?? 0) + 1 }), {}),
  messageFlow: { total: mList.length, byAgent },
  dcwJournal: jrnRows,
  daqWindow: {
    weightPoints: weight.length, weightFirst: weight[0]?.v ?? null, weightLast: weight.at(-1)?.v ?? null,
    cyclePoints: cycle.length, cycleLast: cycle.at(-1)?.v ?? null,
  },
  hitlPendingNow: (appr?.data?.items ?? []).length,
}
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(timeline, null, 2))
console.log(`tasks=${JSON.stringify(timeline.taskStateSummary)} msgs=${mList.length} journal=${jrnRows.length} weightPts=${weight.length}`)
console.log(`→ ${OUT}`)
