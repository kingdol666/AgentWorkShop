/**
 * scripts/experiments/tsa-phase-i.mjs —— 三端验收 阶段I:IDD 诊断 + RAG 全功能(2026-11-19)。
 *
 *   I1 RAG 文档链:kb_doc_create(工况文档) → kb_doc_search → kb_doc_read → kb_catalog
 *   I2 IDD 诊断:diag_run(quick-screen, 真实产线导出) → 202 task/run → diag_status 轮询 → 终态取报告
 *   I3 diag_deposit:报告沉库 aw-docs + 检索自检
 *   I4 RAG 经验链:kb_agent ingest(走 HITL) → kb_agent query 召回
 * 断点续跑:step 状态存 D:/tmp/aw-tsa-1119/phase-i-state.json。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-three-system-acceptance')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-tsa-1119'
const BASE = 'http://127.0.0.1:3021'
const CH = '8709a0e9-3aca-4dad-b339-6f0b14719eec'
const LINE = 'ln-74799404'
const WC_DOC = join(REPO, 'docs', 'audit', 'evidence', '2026-11-15-doc-to-simulated-plc', 'work-condition-doc.md')

const tokens = JSON.parse(readFileSync(join(PRIVATE, 'aw-tokens.json'), 'utf8'))
const statePath = join(PRIVATE, 'phase-i-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const save = (name, obj) => { writeFileSync(join(EV, name), JSON.stringify(obj, null, 1)); writeFileSync(statePath, JSON.stringify(state, null, 1)) }
const log = (m) => console.log(`[phase-i] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 60_000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

async function leadId() {
  const members = (await api('GET', `/api/workshop/channels/${CH}/agents`, undefined, tokens.admin)).json?.data ?? []
  return (members.find(a => a.role === 'lead'))?.id
}

async function invoke(tool, args, timeoutMs = 600_000) {
  const lid = await leadId()
  const t0 = Date.now()
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: lid, tool, args }, tokens.admin, timeoutMs)
  const text = String(r.json?.data?.result?.text ?? r.json?.data?.text ?? JSON.stringify(r.json))
  const isError = r.json?.data?.result?.isError === true || r.json?.data?.isError === true || r.json?.code !== 0
  return { text, isError, status: r.status, ms: Date.now() - t0, raw: r.json }
}

async function approvePendingDcw(comment) {
  const t0 = Date.now()
  for (;;) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${CH}`, undefined, tokens.admin)
    const card = (p.json?.data?.items ?? []).find(i => i.kind === 'dcw-approval')
    if (card) {
      const d = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, comment }, tokens.admin)
      return { card, decide: d.json }
    }
    if (Date.now() - t0 > 120_000) return null
    await sleep(8000)
  }
}

async function main() {
  // =========== I1 RAG 文档链 ===========
  if (!state.i1) {
    log('I1 kb_doc_create 入库工况文档…')
    const doc = readFileSync(WC_DOC, 'utf8')
    const created = await invoke('kb_doc_create', { name: '注塑克重产线工况文档-WC-INJ-2026-1115', content: doc, tags: ['工况文档', '注塑', '克重闭环'], source: 'WC-INJ-2026-1115' })
    save('phase-i-i1-doc-create.json', { text: created.text.slice(0, 800), isError: created.isError, ms: created.ms })
    if (created.isError) throw new Error(`kb_doc_create 失败: ${created.text.slice(0, 200)}`)
    const search = await invoke('kb_doc_search', { query: '克重 目标 32.5 容差 保压压力', limit: 5 })
    save('phase-i-i1-doc-search.json', { text: search.text.slice(0, 1200), isError: search.isError })
    const read = await invoke('kb_doc_read', { name: '注塑克重产线工况文档-WC-INJ-2026-1115', max_chars: 600 })
    save('phase-i-i1-doc-read.json', { text: read.text.slice(0, 800), isError: read.isError })
    const catalog = await invoke('kb_catalog', {})
    save('phase-i-i1-catalog.json', { text: catalog.text.slice(0, 900), isError: catalog.isError })
    state.i1 = { createOk: !created.isError, searchOk: !search.isError, catalogOk: !catalog.isError }
    log(`I1 完成 create/search/read/catalog`)
  }

  // =========== I2 IDD 诊断(真实产线 quick-screen) ===========
  if (!state.i2) {
    log('I2 diag_run(quick-screen) 提交…')
    const run = await invoke('diag_run', { line: LINE, analysis_intent: 'quick-screen' }, 300_000)
    save('phase-i-i2-diag-run.json', { text: run.text.slice(0, 900), isError: run.isError, ms: run.ms })
    if (run.isError) throw new Error(`diag_run 失败: ${run.text.slice(0, 250)}`)
    const m = run.text.match(/run_id=([a-z0-9-]+)/i) ?? run.text.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i)
    const runId = m?.[1]
    if (!runId) throw new Error(`diag_run 未返回 run_id: ${run.text.slice(0, 200)}`)
    log(`I2 已受理 run_id=${runId},轮询 diag_status…`)
    let statusText = ''
    const t0 = Date.now()
    const samples = []
    for (;;) {
      const st = await invoke('diag_status', { run_id: runId }, 120_000)
      statusText = st.text
      samples.push({ at: new Date().toISOString(), text: statusText.slice(0, 300) })
      if (/completed|完成/.test(statusText)) break
      if (/(failed|stopped|interrupted|expired)/i.test(statusText)) break
      if (Date.now() - t0 > 40 * 60_000) { save('phase-i-i2-status-timeout.json', { runId, samples }); throw new Error(`diag_status 40min 未到终态(如实停): ${statusText.slice(0, 200)}`) }
      await sleep(30_000)
    }
    save('phase-i-i2-status-polls.json', { runId, polls: samples, final: statusText.slice(0, 1200) })
    state.i2 = { runId, terminal: statusText.slice(0, 120) }
    log(`I2 终态: ${statusText.slice(0, 120)}`)
  }

  // =========== I3 diag_deposit 沉库 + 自检 ===========
  if (!state.i3) {
    log('I3 diag_deposit 报告沉库 aw-docs…')
    const dep = await invoke('diag_deposit', { run_id: state.i2.runId }, 300_000)
    save('phase-i-i3-deposit.json', { text: dep.text.slice(0, 900), isError: dep.isError })
    state.i3 = { ok: !dep.isError, text: dep.text.slice(0, 200) }
    log(`I3 完成: ${dep.text.slice(0, 120)}`)
  }

  // =========== I4 RAG 经验链(kb_agent HITL ingest + query) ===========
  if (!state.i4) {
    log('I4 kb_agent ingest 结构化经验(走 HITL)…')
    const ing = await invoke('kb_agent', { action: 'ingest', kb: 'aw-industrial', title: '保压压力小步上调与克重响应', content: '2026-11-19 三端验收:早班巡检克重实测达标;保压压力SP +1MPa 经 HITL 批准下发,回读一致。保压压力→克重正相关,单步≤2MPa。', tags: ['experience', '注塑', '调参'] }, 120_000)
    save('phase-i-i4-kb-ingest.json', { text: ing.text.slice(0, 600), isError: ing.isError })
    if (/审批|approval|hitl/i.test(ing.text)) {
      const ap = await approvePendingDcw('验收作业经验沉淀,批准入库')
      save('phase-i-i4-kb-approval.json', ap)
    }
    const st = await invoke('kb_agent_status', { task_id: (ing.text.match(/task_id[=:\s]+([a-z0-9-]+)/i) ?? [])[1] ?? '' }, 60_000).catch(e => ({ text: String(e) }))
    save('phase-i-i4-kb-status.json', { text: String(st.text).slice(0, 500), isError: st.isError })
    const q = await invoke('kb_agent', { action: 'query', kb: 'aw-industrial', query: '保压压力上调 克重 响应', limit: 5 }, 180_000)
    save('phase-i-i4-kb-query.json', { text: q.text.slice(0, 1200), isError: q.isError })
    state.i4 = { ingestOk: !ing.isError, queryOk: !q.isError }
    log(`I4 完成 ingest/query`)
  }

  console.log('PHASE-I-RESULT ' + JSON.stringify({ ok: true, state }))
}

await main().catch((e) => {
  console.error(`[phase-i] FAILED: ${e.message}`)
  save('phase-i-ABORT.json', { error: e.message, at: new Date().toISOString(), state })
  process.exitCode = 1
})
