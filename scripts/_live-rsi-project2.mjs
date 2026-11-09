/**
 * 项目阶段 2：治理写+HITL → root 终态 → reconcile → 提交 → L1/L2 → kb → 盲验证归属。
 * 用法：node scripts/_live-rsi-project2.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const DB = new DatabaseSync(join(state.home, 'data', 'workshop.sqlite'))
DB.exec('PRAGMA busy_timeout = 5000')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`)
}
const api = async (method, path, body, timeoutMs = 120_000) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const cards = async () => (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
const waitFor = async (fn, { timeout = 600_000, interval = 10_000, label = 'cond' } = {}) => {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    }
    catch { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error(`${label} 超时 ${timeout}ms`)
    await sleep(interval)
  }
}

try {
  const attempt = DB.prepare(
    'SELECT channel_id AS channelId, channel_task_id AS taskId FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no DESC LIMIT 1',
    ).get(state.project.workItemId)
  const rootId = attempt.taskId
  const instLead = DB.prepare(`SELECT id FROM channel_agents WHERE channel_id = ? AND role = 'lead'`).get(attempt.channelId)?.id
  console.log(`root=${rootId} instance=${attempt.channelId} lead=${instLead}`)

  // 实例频道绑线 + 配方管理权（D5 只继承 AML profile，不继承 line 绑定）
  await api('PUT', `/api/workshop/channels/${attempt.channelId}/line`, { lineId: state.line.lineId })
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: instLead, nodeId: state.line.lineId, kind: 'line-recipe' })

  // ── 治理写（write_intent 由治理链要求：项目来源任务直写被闸 → 走 write_intent 面在 REST 里等价于 HITL 卡）──
  const known = new Set((await cards()).map(x => x.id))
  const blowerSp = state.line.dcw['blower-hz-sp']
  const trialP = api('POST', '/api/workshop/agent-tools/invoke', { agentId: instLead, tool: 'recipe_trial', args: {
    recipe_id: state.line.recipeId,
    params: [{ node_id: blowerSp, value: 24 }],
    hypothesis: 'RSI live demo：风机频率 26→24 Hz 达标降耗（治理链下发）',
    emergency: true,
  } })
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    await sleep(2000)
    card = (await cards()).find(x => !known.has(x.id)) ?? null
  }
  if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'RSI live demo 批准' })
  const trialR = await trialP
  ok('Q1', '治理写（HITL 批准）下发真实设备', !invErr(trialR), invText(trialR).slice(0, 220))

  // ── root 终态（真实 LLM 执行链）──
  const rootState = await waitFor(async () => {
    const t = DB.prepare('SELECT state FROM tasks WHERE id = ?').get(rootId)
    return t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state) ? t.state : null
  }, { timeout: 900_000, interval: 15_000, label: 'root terminal' })
  ok('Q2', '真实 LLM 执行链收口', rootState === 'COMPLETED', `state=${rootState}`)

  // ── reconcile → draft → submit → review ──
  await api('POST', `/api/workshop/projects/${state.project.id}/reconcile`)
  const draft = await waitFor(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${state.project.id}/results`)).data ?? []
    return rows.find(x => x.status === 'draft' && x.workItemId === state.project.workItemId) ?? null
  }, { timeout: 120_000, interval: 5000, label: 'draft' })
  ok('Q3', 'Reconciler 生成成果 draft', Boolean(draft?.id), `result=${draft?.id}`)
  const sub = await api('POST', `/api/workshop/projects/${state.project.id}/results/${draft.id}/submit`, {
    summary: '风机频率整定完成：HITL 治理下发，独立回读证实',
    method: 'recipe_trial 治理链 + daq 复测', validityScope: `line:${state.line.lineId}`,
  })
  ok('Q4', '成果提交', sub.status === 200 && sub.data?.status === 'submitted', `status=${sub.status}`)
  const review = await api('POST', `/api/workshop/projects/${state.project.id}/results/${draft.id}/review`, { decision: 'reviewed' })
  ok('Q5', 'L1 复核（blind.readback match 不阻断）', review.status === 200 && review.data?.status === 'reviewed',
    `status=${review.status}`)

  // ── L2 验收 → kb 候选 → 盲验证归属 ──
  const acc = await api('POST', `/api/workshop/projects/${state.project.id}/results/${draft.id}/request-acceptance`)
  const accDec = acc.data?.id ? await api('POST', `/api/workshop/projects/${state.project.id}/approvals/${acc.data.id}/decide`, { approve: true, reason: '证据完整' }) : null
  const final = (await api('GET', `/api/workshop/projects/${state.project.id}/results`)).data?.find(x => x.id === draft.id)
  ok('Q6', 'L2 验收 approved', accDec?.status === 200 && final?.status === 'approved', `status=${final?.status}`)
  const kb = DB.prepare("SELECT id FROM improvement_proposals WHERE kind='kb_ingest' AND source_id = ?").get(draft.id)
  ok('Q7', '评审终态 → kb_ingest 候选（D3）', Boolean(kb?.id), `proposal=${kb?.id}`)
  const blind = DB.prepare('SELECT verdict FROM blind_verifications WHERE task_id = ?').all(rootId)
  ok('Q8', 'C1 独立回读归属项目 root（match）', blind.length >= 1 && blind.every(b => b.verdict === 'match'),
    `${blind.length} 条 ${blind.map(b => b.verdict).join(',')}`)
  const wiFinal = DB.prepare('SELECT state FROM project_work_items WHERE id = ?').get(state.project.workItemId)
  ok('Q9', '工作项收敛 COMPLETED', wiFinal?.state === 'COMPLETED', `state=${wiFinal?.state}`)

  state.project.result = { id: draft.id, rootId, instanceChannelId: attempt.channelId, kb: kb?.id, blind: blind.length }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', '阶段 2 未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== PROJECT PHASE2  pass=${pass}/${results.length} ===`)
  DB.close()
}
