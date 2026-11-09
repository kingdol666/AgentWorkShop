/**
 * 真实 LLM Project 端到端：omp leader 计划 → 派发 → worker 执行 → 治理写+HITL →
 * 独立回读 → reconcile → 提交 → L1 复核(blind.readback) → L2 验收 → kb_ingest 候选。
 * 用法：node scripts/_live-rsi-project.mjs
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
const A = state.channels.A
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
const invokeAgent = (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
const cards = async () => (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
const waitFor = async (fn, { timeout = 240_000, interval = 4000, label = 'cond' } = {}) => {
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
const tick = () => api('POST', `/api/workshop/projects/${state.project.id}/kernel/tick`, {})

try {
  // ── ① 创建项目（真实 omp leader）──
  const p = (await api('POST', '/api/workshop/projects', {
    name: `WWTP 曝气达标治理 ${state.line.sfx}`,
    objective: `在产线 ${state.line.lineId} 完成一次受治理的风机频率整定：HITL 批准下发、独立回读证实、产出可复核成果`,
    successCriteria: ['artifact.present', '治理写经 HITL 批准', '独立回读证实'],
    leaderHarness: 'omp',
    leaderConfig: { provider: 'deepseek', model: 'deepseek-flash' },
    routingPolicy: 'technical',
    mode: 'supervised',
  })).data
  state.project = { id: p.id, officeChannelId: p.officeChannelId, leadAgentId: p.leadAgentId }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
  ok('P1', 'Project 创建（真实 omp leader + 办公室频道）', Boolean(p?.id), `project=${p?.id} leader=${p?.leadAgentId}`)

  // ── ② 绑定频道 A + 交付物 + 工作项 ──
  const bind = await api('POST', `/api/workshop/projects/${p.id}/channels`, { channelId: A.channelId, charter: 'WWTP 真实整定作业' })
  ok('P2', '绑定成员频道', bind.status === 200, `status=${bind.status}`)
  const del = (await api('POST', `/api/workshop/projects/${p.id}/deliverables`, {
    name: `曝气整定报告 ${state.line.sfx}`, ownerChannelId: A.channelId,
    acceptanceCriteria: ['artifact.present'],
  })).data
  const wi = (await api('POST', `/api/workshop/projects/${p.id}/work-items`, {
    deliverableId: del.id, channelId: A.channelId,
    title: `风机频率受治理整定 ${state.line.sfx}`,
    brief: `对产线 ${state.line.lineId} 执行一次曝气整定：读 daq_query 现值 → 申请 write_intent（recipe_trial）→ HITL 批准后下发 → daq_query 复测 → 产出 artifact 报告`,
    execBudgetMinutes: 60,
  })).data
  ok('P3', '交付物+工作项创建', Boolean(del?.id && wi?.id), `wi=${wi?.id}`)

  await api('POST', `/api/workshop/projects/${p.id}/activate`)

  // ── ③ 真实 leader 规划（内核 tick → leader LLM 回合 → project_propose_plan）──
  let planApproval = null
  for (let i = 0; i < 8 && !planApproval; i++) {
    await tick()
    try {
      planApproval = await waitFor(async () => {
        const items = (await api('GET', `/api/workshop/projects/${p.id}/approvals`)).data ?? []
        return items.find(x => x.kind === 'plan_approval' && x.status === 'pending') ?? null
      }, { timeout: 240_000, interval: 8000, label: 'leader plan proposal' })
    }
    catch (err) {
      console.log(`  tick#${i + 1}: ${String(err.message).slice(0, 80)} → 重试`)
    }
  }
  ok('P4', '真实 leader 提出计划（deepseek-flash LLM 回合）', Boolean(planApproval), `approval=${planApproval?.id}`)
  if (!planApproval) throw new Error('leader 未产出计划')

  const dec = await api('POST', `/api/workshop/projects/${p.id}/approvals/${planApproval.id}/decide`, { approve: true, reason: 'RSI live demo 计划批准' })
  ok('P5', 'owner 批准计划', dec.status === 200 && dec.data?.status === 'approved', `status=${dec.status}`)
  await tick()

  // ── ④ 派发（root 任务 → 真实执行链）──
  const disp = await api('POST', `/api/workshop/projects/${p.id}/work-items/${wi.id}/dispatch`)
  ok('P6', '工作项派发', disp.status === 200, `status=${disp.status} code=${disp.code}`)
  const attempt = await waitFor(() => DB.prepare(
    'SELECT channel_id AS channelId, channel_task_id AS taskId FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no DESC LIMIT 1', wi.id,
  ), { timeout: 60_000, interval: 2000, label: 'task instance' })
  const rootId = attempt.taskId
  console.log(`  instance=${attempt.channelId} root=${rootId}`)

  // 治理写（项目实例 lead 工具面直调；HITL 由人批准）——在 root 终态前完成
  await waitFor(() => {
    const lead = DB.prepare(`SELECT id FROM channel_agents WHERE channel_id = ? AND role = 'lead'`).get(attempt.channelId)
    return lead?.id ?? null
  }, { timeout: 60_000, interval: 2000, label: 'instance lead' })
  const instLead = DB.prepare(`SELECT id FROM channel_agents WHERE channel_id = ? AND role = 'lead'`).get(attempt.channelId).id
  await api('PUT', `/api/workshop/channels/${attempt.channelId}/line`, { lineId: state.line.lineId })
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: instLead, nodeId: state.line.lineId, kind: 'line-recipe' })

  // 等 root 接取（WORKING）后发起治理写
  await waitFor(() => {
    const t = DB.prepare('SELECT state FROM tasks WHERE id = ?').get(rootId)
    return t && ['WORKING', 'WAITING'].includes(t.state) ? t.state : null
  }, { timeout: 420_000, interval: 8000, label: 'root WORKING' })

  const known = new Set((await cards()).map(x => x.id))
  const currentValue = 24
  const trialP = invokeAgent(instLead, 'recipe_trial', {
    recipe_id: state.line.recipeId,
    params: [{ node_id: state.line.dcw['blower-hz-sp'] ?? Object.values(state.line.dcw)[0], value: currentValue }],
    hypothesis: 'RSI live demo：风机频率下调 26→24 Hz 达标降耗（write_intent + HITL 治理链）',
    emergency: true,
  })
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    await sleep(2000)
    card = (await cards()).find(x => !known.has(x.id)) ?? null
  }
  if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'RSI live demo 批准' })
  const trialR = await trialP
  ok('P7', '治理写（write_intent + HITL）下发真实设备', !invErr(trialR), invText(trialR).slice(0, 220))

  // ── ⑤ 等 root 完成（真实 worker 执行 + lead 验收）──
  const rootState = await waitFor(async () => {
    const t = DB.prepare('SELECT state FROM tasks WHERE id = ?').get(rootId)
    if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) return t.state
    return null
  }, { timeout: 900_000, interval: 15_000, label: 'root terminal' })
  ok('P8', '真实 LLM 执行链收口（root 终态）', rootState === 'COMPLETED', `state=${rootState}`)

  // ── ⑥ reconcile → draft → 提交 → L1 复核（blind.readback 进 checks）──
  await api('POST', `/api/workshop/projects/${p.id}/reconcile`)
  const draft = await waitFor(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${p.id}/results`)).data ?? []
    return rows.find(x => x.status === 'draft' && x.workItemId === wi.id) ?? null
  }, { timeout: 120_000, interval: 5000, label: 'draft result' })
  ok('P9', 'Reconciler 生成成果 draft', Boolean(draft?.id), `result=${draft?.id}`)
  const sub = await api('POST', `/api/workshop/projects/${p.id}/results/${draft.id}/submit`, {
    summary: '风机频率整定完成：write_intent+HITL 治理下发，独立回读证实',
    method: 'recipe_trial 治理链 + daq 复测', validityScope: `line:${state.line.lineId}`,
  })
  ok('P10', '成果提交（submitted）', sub.status === 200 && sub.data?.status === 'submitted', `status=${sub.status}`)
  const review = await api('POST', `/api/workshop/projects/${p.id}/results/${draft.id}/review`, { decision: 'reviewed' })
  ok('P11', 'L1 复核通过（blind.readback match 不阻断）', review.status === 200 && review.data?.status === 'reviewed',
    `status=${review.status} checks=${JSON.stringify(review.data?.criteriaCheckJson ?? '').slice(0, 200)}`)

  // ── ⑦ L2 验收 → approved → kb_ingest 候选 ──
  const acc = await api('POST', `/api/workshop/projects/${p.id}/results/${draft.id}/request-acceptance`)
  const accDec = acc.data?.id ? await api('POST', `/api/workshop/projects/${p.id}/approvals/${acc.data.id}/decide`, { approve: true, reason: '证据完整' }) : null
  const final = (await api('GET', `/api/workshop/projects/${p.id}/results`)).data?.find(x => x.id === draft.id)
  ok('P12', 'L2 验收 approved', accDec?.status === 200 && final?.status === 'approved', `status=${final?.status}`)
  const kb = DB.prepare("SELECT id, kind, status FROM improvement_proposals WHERE kind='kb_ingest' AND source_id = ?").get(draft.id)
  ok('P13', '评审终态 → kb_ingest 候选（D3 自动沉淀）', Boolean(kb?.id), `proposal=${kb?.id}`)

  // 盲验证归属证据
  const blind = DB.prepare('SELECT verdict, task_id AS taskId FROM blind_verifications WHERE task_id = ?').all(rootId)
  ok('P14', 'C1 独立回读归属项目 root 任务', blind.length >= 1 && blind.every(b => b.verdict === 'match'),
    `${blind.length} 条 ${blind.map(b => b.verdict).join(',')}`)

  state.project.result = { id: draft.id, rootId, instanceChannelId: attempt.channelId, kb: kb?.id }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', '项目流程未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== PROJECT LIVE  pass=${pass}/${results.length} ===`)
  DB.close()
}
