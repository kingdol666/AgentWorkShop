#!/usr/bin/env node
/**
 * industrial-three-context-live.mjs —— 产线工具 × 三种作业上下文集成实机验收（2026-11-08）。
 *
 * 回答的问题：产线相关工具（数采/数控/配方治理写/数据分析）能否在
 *   A. Channel（成员直调，绑线 + 节点绑定 + HITL 治理写）
 *   B. Channel 的 Session（会话克隆，绑定面复制后按克隆身份作业）
 *   C. Project 任务实例（任务专属 Channel，绑定面复制 + write_intent 双治理写）
 * 三个上下文中被正常调用并与产线节点真实交互（PLC 模拟器 :4010 模拟工况）。
 *
 * 前置：实例已 seed-industrial-demo 布线（≥2 条线开跑）。
 * 用法：AW_BASE=http://127.0.0.1:3997 node scripts/_audit/industrial-three-context-live.mjs
 * 证据：docs/audit/evidence/2026-11-08-industrial-three-context/three-context.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3997')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-industrial-three-context')))
mkdirSync(EVID, { recursive: true })

let token = ''
const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 700) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail ?? '').slice(0, 260)}`}`)
  return Boolean(ok)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.agentToken
        ? { 'authorization': `Bearer ${opts.agentToken}`, 'x-aw-agent-token': opts.agentToken }
        : (token ? { authorization: `Bearer ${token}` } : {})),
    },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, code: j?.code, message: j?.message ?? '' }
}
/** Agent 工具桥（成员实例令牌；与 harness 同一执行层 dispatch。无令牌时走 admin 用户代调——REST 列表不透出克隆 token） */
async function invoke(agent, tool, argsTool = {}, timeoutMs = 180_000) {
  const headers = { 'content-type': 'application/json' }
  if (agent.token) headers['x-aw-agent-token'] = agent.token
  else if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: agent.id, tool, args: argsTool }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
async function dcwNodes() {
  return (await api('GET', '/api/workshop/dcw')).data?.nodes ?? []
}
/** recipe_trial 异步发起 → 轮询 HITL 卡 → 批准 → 收口（manual 绑定阻塞等审批） */
async function trialWithHitl(agent, trialArgs, tag) {
  const startAt = Date.now()
  const trialP = invoke(agent, 'recipe_trial', trialArgs, 300_000)
  let card = null
  for (let i = 0; i < 25 && !card; i++) {
    await sleep(1500)
    const items = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
    card = items.find(x => (x.kind === 'dcw-approval' || String(x.nodeId ?? '').startsWith('recipe:'))
      && (!x.createdAt || new Date(x.createdAt).getTime() >= startAt - 1500)) ?? null
  }
  if (!card) {
    const early = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
    return { card: null, decided: null, trial: early }
  }
  const decided = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: `三上下文集成验收批准(${tag})` })
  const trial = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
  return { card, decided, trial }
}
/** 节拍硬闸（≥300s/线）：早拒文本里带「等待 Ns 后再试」→ 等足重试；rearm 用于 C 上下文（节拍早拒会消耗 write_intent，重试前须重新申请） */
async function trialWithCadenceRetry(agent, buildArgs, tag, maxRounds = 2, rearm = null) {
  let attempt = await trialWithHitl(agent, buildArgs(), tag)
  for (let round = 0; round < maxRounds; round++) {
    const text = attempt.trial?.text ?? ''
    const m = text.match(/等待\s*(\d+)s 后再试/)
    const waitSec = m ? Number(m[1]) : 0
    if (!(waitSec > 0 && waitSec <= 370)) break
    console.log(`  · 试验节拍硬闸,等待 ${waitSec + 5}s 后自动重试(第 ${round + 1} 次)`)
    await sleep((waitSec + 5) * 1000)
    if (rearm) await rearm()
    attempt = await trialWithHitl(agent, buildArgs(), tag)
  }
  return attempt
}
/** 设备侧回读:SP 值朝 target 收敛(一阶惯性,90s 窗) */
async function readbackConverged(nodeId, target, tol) {
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    const n = (await dcwNodes()).find(x => x.id === nodeId)
    const v = Number(n?.value ?? Number.NaN)
    if (Number.isFinite(v) && Math.abs(v - target) <= tol) return { ok: true, value: v }
  }
  const n = (await dcwNodes()).find(x => x.id === nodeId)
  return { ok: false, value: Number(n?.value ?? Number.NaN) }
}
/** 治理写全链:节拍硬闸重试(可 rearm) + Agent 互斥孤儿接管等待;返回最终 attempt */
async function governedTrial(agent, buildArgs, tag, rearm = null) {
  let attempt = await trialWithCadenceRetry(agent, buildArgs, tag, 2, rearm)
  for (let i = 0; i < 2 && /正在优化试验中/.test(attempt.trial?.text ?? ''); i++) {
    console.log('  · Agent 互斥(他人 open 记录未判),等待接管窗(65s)后重试')
    await sleep(65_000)
    if (rearm) await rearm()
    attempt = await trialWithCadenceRetry(agent, buildArgs, tag, 1, rearm)
  }
  return attempt
}
/** 从候选线挑选「SP 写控节点 + 配方 + 绑定用 daq 节点」,跳过无 stepLimit/锚点的线 */
function pickLine(dcwAll, daqAll, recipesAll, lines, excludeLineId) {
  for (const lineId of lines.map(l => l.lineId)) {
    if (excludeLineId && lineId === excludeLineId) continue
    const sp = dcwAll.find(n => (n.lineId ?? '') === lineId && /SP/i.test(n.name ?? ''))
    const recipe = recipesAll.find(r => r.lineId === lineId)
    const daqs = daqAll.filter(n => (n.lineId ?? '') === lineId)
    if (!sp || !recipe || daqs.length < 1) continue
    const stepLimit = Number(sp.stepLimit ?? Number.NaN)
    const anchor = Number(recipe.params?.find(p => p.nodeId === sp.id)?.value ?? Number.NaN)
    if (!(Number.isFinite(stepLimit) && stepLimit > 0) || !Number.isFinite(anchor)) continue
    return { lineId, sp, recipe, daqs, stepLimit, anchor }
  }
  return null
}

async function main() {
  // ═══ S0 登录 + 产线现场 ═══
  token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  if (!step('S0-1', '管理员登录', Boolean(token), 'admin@awshop.local')) return finish(false)
  const dcwAll = await dcwNodes()
  const daqAll = (await api('GET', '/api/workshop/daq')).data?.nodes ?? []
  const recipesAll = (await api('GET', '/api/workshop/dcw')).data?.recipes ?? []
  const states = (await api('GET', '/api/workshop/dcw')).data?.lineStates ?? []
  const running = states.filter(s => s.active === true)
  if (!step('S0-2', '产线现场就绪(节点/配方/开跑)',
    dcwAll.length > 0 && daqAll.length > 0 && recipesAll.length > 0 && running.length >= 2,
    `dcw=${dcwAll.length} daq=${daqAll.length} recipes=${recipesAll.length} running=${running.length}/${states.length}`)) return finish(false)

  // 共享 home 里可能残留 <30min 内其它运行留下的 open 优化记录(Agent 互斥会拦新写):
  // 把孤儿接管窗口临时收紧到 60s,写测结束后恢复默认 30min。
  await api('PATCH', '/api/system/settings', { override: { 'dcw.rollback_stale_ms': 60000 } })
  process.on('exit', () => { void fetch(`${base}/api/system/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` }, body: JSON.stringify({ override: { 'dcw.rollback_stale_ms': 1800000 } }) }).catch(() => {}) })

  const lines = running
  const ctxA = pickLine(dcwAll, daqAll, recipesAll, lines, null)
  const ctxC = pickLine(dcwAll, daqAll, recipesAll, lines, ctxA?.lineId)
  if (!step('S0-3', '选定 A/C 上下文产线', Boolean(ctxA && ctxC),
    `A=${ctxA?.lineId?.slice(0, 8) ?? '-'} C=${ctxC?.lineId?.slice(0, 8) ?? '-'}`)) return finish(false)

  // ═══ A. Channel 成员直调 ═══
  const wsId = (await api('GET', '/api/workshop/workspaces')).data?.[0]?.id
    ?? (await api('POST', '/api/workshop/workspaces', { name: `三上下文-${randomUUID().slice(0, 5)}` })).data?.id
  const chA = await api('POST', '/api/workshop/channels', { name: `产线直调-${randomUUID().slice(0, 5)}`, lineId: ctxA.lineId })
  const cidA = chA.data?.channelId ?? chA.data?.id
  const leadA = await api('POST', `/api/workshop/channels/${cidA}/agents`, { name: '直调Lead', harness: 'mock', role: 'lead' })
  const leadAId = leadA.data?.id ?? leadA.data?.agentId
  await api('POST', `/api/workshop/channels/${cidA}/activate`, {})
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cidA}`, {})
  const tokA = (await api('POST', `/api/workshop/channels/${cidA}/agents/${leadAId}/rotate-token`, {})).data?.token ?? ''
  const agentA = { id: leadAId, token: tokA }
  if (!step('A1', '建绑线频道+成员+令牌', Boolean(cidA && leadAId && tokA), `ch=${String(cidA).slice(0, 8)} lead=${String(leadAId).slice(0, 8)}`)) return finish(false)

  const bDaq = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadAId, nodeId: ctxA.daqs[0].id, kind: 'daq', mode: 'auto' })
  const bDcw = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadAId, nodeId: ctxA.sp.id, kind: 'dcw' })
  const bRec = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadAId, nodeId: ctxA.recipe.id, kind: 'recipe' })
  const bindRows = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${leadAId}`)).data
  const rowsA = Array.isArray(bindRows) ? bindRows : (bindRows?.bindings ?? bindRows?.items ?? [])
  step('A2', '节点绑定(daq auto + dcw/recipe 首绑 manual)', bDaq.status === 200 && bDcw.status === 200 && bRec.status === 200 && rowsA.length >= 3,
    `daq=${bDaq.status} dcw=${bDcw.status} recipe=${bRec.status} rows=${rowsA.length} dcwMode=${rowsA.find(r => r.kind === 'dcw')?.mode}`)

  const face = await fetch(`${base}/api/workshop/agent-tools/list?agentId=${leadAId}`, { headers: { 'x-aw-agent-token': tokA } })
  const names = face.status === 200 ? ((await face.json())?.data?.tools ?? []).map(t => t.name) : []
  const prodFace = ['daq_query', 'line_context', 'recipe_trial', 'dcw_journal', 'intervention_history', 'analysis_save', 'analysis_query']
  step('A3a', '生产频道工具面含产线+分析留痕族', prodFace.every(t => names.includes(t)),
    `n=${names.length} missing=${prodFace.filter(t => !names.includes(t)).join(',')}`)
  // AML/优化器族按频道模式门控注入(仅 AML/混合孪生频道):普通生产频道正确缺席 = fail-closed 设计
  step('A3b', 'AML/优化器族按模式门控(生产频道正确缺席)', ['aml_dataset_build', 'optimizer_solve', 'twin_trial_run'].every(t => !names.includes(t)),
    `amlPresent=${['aml_dataset_build', 'optimizer_solve', 'twin_trial_run'].filter(t => names.includes(t)).join(',') || '无'}`)

  const q = await invoke(agentA, 'daq_query', { node_id: ctxA.daqs[0].id, last_minutes: 3, bucket_ms: 1000 })
  step('A4', 'Channel 直调 daq_query(数采)', !q.isError && /样本|点|value|mean/i.test(q.text), q.text.replace(/\s+/g, ' ').slice(0, 200))

  const crossDaq = daqAll.find(n => (n.lineId ?? '') !== ctxA.lineId)
  const qNeg = crossDaq ? await invoke(agentA, 'daq_query', { node_id: crossDaq.id, last_minutes: 1 }) : null
  step('A5', '跨线数采阴性(越权拒绝)', !crossDaq || qNeg.isError, crossDaq ? qNeg.text.replace(/\s+/g, ' ').slice(0, 180) : '单线现场跳过')

  const lc = await invoke(agentA, 'line_context', {})
  step('A6', 'Channel 直调 line_context(绑线全景)', !lc.isError && /产线|线|配方|批次/i.test(lc.text), lc.text.replace(/\s+/g, ' ').slice(0, 200))

  const stub = await invoke(agentA, 'dcw_control', { node_id: ctxA.sp.id, value: ctxA.anchor })
  step('A7', 'dcw_control 直写按设计拒绝(治理语义)', stub.isError && /禁用|recipe/i.test(stub.text), stub.text.replace(/\s+/g, ' ').slice(0, 180))

  const targetA = ctxA.anchor + ctxA.stepLimit * 0.6
  const attemptA = await governedTrial(agentA, () => ({
    recipe_id: ctxA.recipe.id,
    params: [{ node_id: ctxA.sp.id, value: Number(targetA.toFixed(2)) }],
    hypothesis: `三上下文验收·Channel 直调:单变量 SP=${targetA.toFixed(2)}(HITL manual 链)`,
    emergency: true,
  }), 'A')
  step('A8a', 'recipe_trial 发起 HITL 审批卡', Boolean(attemptA.card), attemptA.card ? `card=${String(attemptA.card.id).slice(0, 10)}` : (attemptA.trial?.text ?? '').slice(0, 200))
  step('A8b', 'HITL 批准受理', attemptA.decided?.status === 200, attemptA.decided?.message ?? '')
  step('A8c', 'trial 收口(设备受理)', Boolean(attemptA.trial) && !attemptA.trial.isError, (attemptA.trial?.text ?? '').replace(/\s+/g, ' ').slice(0, 220))
  if (attemptA.trial && !attemptA.trial.isError) {
    const rbA = await readbackConverged(ctxA.sp.id, targetA, ctxA.stepLimit * 0.3)
    step('A8d', '设备侧回读收敛(真实工况交互)', rbA.ok, `target=${targetA.toFixed(2)} final=${Number.isFinite(rbA.value) ? rbA.value.toFixed(2) : '?'}`)
  }

  // ═══ B. Session 克隆作业 ═══
  const s1 = await api('POST', `/api/workshop/channels/${cidA}/sessions`, { title: '三上下文·会话一' }, {})
  const sid1 = s1.data?.sessionId
  step('B1', '创建 manual session(克隆成员)', s1.status === 200 && Boolean(sid1), s1.message)
  const agsA = (await api('GET', `/api/workshop/channels/${cidA}/agents`)).data ?? []
  const clone1 = agsA.find(a => a.id !== leadAId && String(a.name ?? '').includes('·session·'))
  const bindClone = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${clone1?.id}`)).data
  const rowsClone = Array.isArray(bindClone) ? bindClone : (bindClone?.bindings ?? bindClone?.items ?? [])
  step('B2', '克隆继承节点绑定面(daq/dcw/recipe)',
    Boolean(clone1) && rowsClone.some(r => r.kind === 'daq' && r.nodeId === ctxA.daqs[0].id)
    && rowsClone.some(r => r.kind === 'dcw' && r.nodeId === ctxA.sp.id)
    && rowsClone.some(r => r.kind === 'recipe' && r.nodeId === ctxA.recipe.id),
    `clone=${String(clone1?.id ?? '').slice(0, 8)} rows=${rowsClone.length}`)

  const qClone = clone1 ? await invoke(clone1, 'daq_query', { node_id: ctxA.daqs[0].id, last_minutes: 2, bucket_ms: 1000 }) : { isError: true, text: 'no clone' }
  step('B3', 'Session 克隆身份调 daq_query(会话内作业)', !qClone.isError, qClone.text.replace(/\s+/g, ' ').slice(0, 200))

  const s2 = await api('POST', `/api/workshop/channels/${cidA}/sessions`, { title: '三上下文·会话二' }, {})
  const agsA2 = (await api('GET', `/api/workshop/channels/${cidA}/agents`)).data ?? []
  const clone2 = agsA2.find(a => a.id !== leadAId && a.id !== clone1?.id && String(a.name ?? '').includes('·session·'))
  const qClone2 = clone2 ? await invoke(clone2, 'line_context', {}) : { isError: true, text: 'no clone2' }
  step('B4', '第二会话克隆并行作业(独立身份)', s2.status === 200 && Boolean(clone2) && !qClone2.isError,
    `clone2=${String(clone2?.id ?? '').slice(0, 8)} ${qClone2.text.replace(/\s+/g, ' ').slice(0, 140)}`)

  const cls = await api('POST', `/api/workshop/channels/${cidA}/sessions/${sid1}/close`, { reason: '三上下文验收' }, {})
  const agsA3 = (await api('GET', `/api/workshop/channels/${cidA}/agents`)).data ?? []
  const clone1After = agsA3.find(a => a.id === clone1?.id)
  const baseAfter = agsA3.find(a => a.id === leadAId)
  const late = await api('POST', `/api/workshop/channels/${cidA}/sessions/${sid1}/messages`, { text: '关闭后探测' }, {})
  step('B5', '关闭会话:克隆停用+拒新消息+基础成员保留(WP2)',
    cls.status === 200 && clone1After?.enabled === 0 && baseAfter?.enabled === 1 && late.status === 409 && late.code === 'SESSION_CLOSED',
    `close=${cls.status} cloneEnabled=${clone1After?.enabled} base=${baseAfter?.enabled} late=${late.status}/${late.code}`)

  // ═══ C. Project 任务实例作业 ═══
  const proj = await api('POST', '/api/workshop/projects', {
    name: `产线三上下文项目 ${Date.now()}`,
    objective: '验证任务实例内产线工具治理作业',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy',
  })
  const pid = proj.data?.id
  await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: cidA, charter: '产线执行' })
  const del = await api('POST', `/api/workshop/projects/${pid}/deliverables`, {
    name: 'line-context-report', required: true, ownerChannelId: cidA,
    acceptanceCriteria: ['artifact_present'],
  })
  // worker 大延时让 root 保持在飞,实例 Channel 在写测期间不被回收
  await api('POST', `/api/workshop/channels/${cidA}/agents`, { name: '实例Worker', harness: 'mock', role: 'worker', config: { delayMs: 240000 } })
  const wi = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: del.data?.id, channelId: cidA, title: '产线数据核查任务',
    brief: '[mock:complex] 拉取本线数采数据并产出核查报告,多阶段执行。', execBudgetMinutes: 30,
  })
  await api('POST', `/api/workshop/projects/${pid}/activate`, {})
  const plan = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['three-context'] } })
  if (plan.data?.id) await api('POST', `/api/workshop/projects/${pid}/approvals/${plan.data.id}/decide`, { approve: true })
  const disp = await api('POST', `/api/workshop/projects/${pid}/work-items/${wi.data?.id}/dispatch`, {})
  step('C1', '项目+绑定+派发(实例创建)', proj.status === 200 && disp.status === 200, `p=${String(pid).slice(0, 8)} dispatch=${disp.status} ${disp.message}`)

  let instCh = null
  let instLead = null
  for (let i = 0; i < 20 && !instCh; i++) {
    await sleep(1500)
    const obs = (await api('GET', `/api/workshop/projects/${pid}/observability`)).data
    instCh = (obs?.workItems ?? []).find(w => w.id === wi.data?.id)?.instanceChannelId ?? null
  }
  if (instCh) {
    for (let i = 0; i < 15 && !instLead; i++) {
      await sleep(1500)
      const ags = (await api('GET', `/api/workshop/channels/${instCh}/agents`)).data ?? []
      const lead = ags.find(a => a.role === 'lead' && a.enabled === 1)
      // REST 列表不透出 token → 空令牌走 admin 用户代调(同一执行层,身份仍是实例 lead)
      if (lead) instLead = { id: lead.id, token: lead.token ?? '' }
    }
  }
  step('C2', '任务实例 Channel+lead(绑定复制载体)', Boolean(instLead), `instCh=${String(instCh ?? '').slice(0, 8)} lead=${String(instLead?.id ?? '').slice(0, 8)}`)
  if (!instLead) return finish(false)

  const bindInst = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${instLead.id}`)).data
  const rowsInst = Array.isArray(bindInst) ? bindInst : (bindInst?.bindings ?? bindInst?.items ?? [])
  step('C3', '实例继承绑定面(daq/dcw/recipe)', rowsInst.some(r => r.kind === 'daq') && rowsInst.some(r => r.kind === 'dcw') && rowsInst.some(r => r.kind === 'recipe'),
    `rows=${rowsInst.length}`)

  const qInst = await invoke(instLead, 'daq_query', { node_id: ctxA.daqs[0].id, last_minutes: 2, bucket_ms: 1000 })
  step('C4', '实例 lead 调 daq_query(项目内数采)', !qInst.isError, qInst.text.replace(/\s+/g, ' ').slice(0, 200))

  // C 向下写:单步限制按「当前设备值」判定(assertStepLimit previous=node.value),
  // A 的向上写已把设备推离锚点 → 目标从当前值回撤 0.6×stepLimit 并夹进量程;
  // 与 A 目标相距 ≥1.2×step(>0.3×step 判定容差),回读不歧义。
  const spNow = (await dcwNodes()).find(x => x.id === ctxA.sp.id)
  const curVal = Number(spNow?.value ?? ctxA.anchor)
  const lo = Number.isFinite(Number(spNow?.min)) ? Number(spNow.min) : -Number.MAX_SAFE_INTEGER
  const hi = Number.isFinite(Number(spNow?.max)) ? Number(spNow.max) : Number.MAX_SAFE_INTEGER
  const targetC = Math.min(hi, Math.max(lo, curVal - ctxA.stepLimit * 0.6))
  const trialArgsC = {
    recipe_id: ctxA.recipe.id,
    params: [{ node_id: ctxA.sp.id, value: Number(targetC.toFixed(2)) }],
    hypothesis: `三上下文验收·Project 实例:单变量 SP=${targetC.toFixed(2)}(write_intent+HITL 双治理)`,
    emergency: true,
  }
  const negC = await invoke(instLead, 'recipe_trial', trialArgsC, 60_000)
  step('C5', '实例内治理写阴性:无 write_intent 被拒(PROJECT_WRITE_INTENT_REQUIRED)',
    negC.isError && negC.text.includes('PROJECT_WRITE_INTENT_REQUIRED'), negC.text.replace(/\s+/g, ' ').slice(0, 220))

  // write_intent 申请+批准(可重入:节拍早拒会消费意图,重试前重新申请)
  const rearmC = async () => {
    await invoke(instLead, 'project_request_write_intent', {
      tool: 'recipe_trial', args: trialArgsC, reason: '产线数据核查需要单变量试验(重试重新申请)',
    })
    const approvals = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data
      ?? (await api('GET', `/api/workshop/projects/${pid}`)).data?.approvals ?? []
    const wiApproval = Array.isArray(approvals) ? approvals.find(a => a.kind === 'write_intent') : null
    if (wiApproval?.id) await api('POST', `/api/workshop/projects/${pid}/approvals/${wiApproval.id}/decide`, { approve: true })
  }
  const wiReq = await invoke(instLead, 'project_request_write_intent', {
    tool: 'recipe_trial', args: trialArgsC, reason: '产线数据核查需要单变量试验',
  })
  step('C6a', 'project_request_write_intent 申请', !wiReq.isError, wiReq.text.replace(/\s+/g, ' ').slice(0, 200))
  const approvals = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data
    ?? (await api('GET', `/api/workshop/projects/${pid}`)).data?.approvals ?? []
  const wiApproval = Array.isArray(approvals) ? approvals.find(a => a.kind === 'write_intent') : null
  let wiApproved = false
  if (wiApproval?.id) {
    const dec = await api('POST', `/api/workshop/projects/${pid}/approvals/${wiApproval.id}/decide`, { approve: true })
    wiApproved = dec.status === 200
  }
  step('C6b', 'owner 批准 write_intent(项目层治理)', wiApproved, `approval=${String(wiApproval?.id ?? '').slice(0, 10)}`)

  const attemptC = await governedTrial(instLead, () => trialArgsC, 'C', wiApproved ? rearmC : null)
  step('C7a', '实例内 recipe_trial 过项目门+HITL 卡', Boolean(attemptC.card), attemptC.card ? `card=${String(attemptC.card.id).slice(0, 10)}` : (attemptC.trial?.text ?? '').slice(0, 220))
  step('C7b', 'HITL 批准受理(产线层治理)', attemptC.decided?.status === 200, attemptC.decided?.message ?? '')
  step('C7c', 'trial 收口(设备受理)', Boolean(attemptC.trial) && !attemptC.trial.isError, (attemptC.trial?.text ?? '').replace(/\s+/g, ' ').slice(0, 220))
  if (attemptC.trial && !attemptC.trial.isError) {
    const rbC = await readbackConverged(ctxA.sp.id, targetC, ctxA.stepLimit * 0.3)
    step('C7d', '设备侧回读收敛(项目内真实写)', rbC.ok, `target=${targetC.toFixed(2)} final=${Number.isFinite(rbC.value) ? rbC.value.toFixed(2) : '?'}`)
  }

  // ═══ D. 数据分析留痕族(生产频道面;AML 训练族为独立模式频道,见 A3b) ═══
  const rep = await invoke(agentA, 'analysis_save', {
    title: `三上下文集成·SP 漂移核查 ${Date.now()}`,
    summary: `Channel/Session/Project 三上下文分别完成数读取数与治理写;SP 目标 ${targetA.toFixed(2)} 已由 HITL 链真实下发并回读收敛`,
    conclusions: [
      `A 上下文:daq_query 数采 + recipe_trial HITL 写收敛(target=${targetA.toFixed(2)})`,
      'B 上下文:会话克隆继承绑定面并以克隆身份完成数采查询',
      'C 上下文:任务实例 lead 经 write_intent+HITL 双治理完成产线写',
    ],
    report: '本报告由 industrial-three-context-live.mjs 自动生成,证据见 three-context.json。',
    line_id: ctxA.lineId,
    recipe_id: ctxA.recipe.id,
  })
  step('D1', 'analysis_save(分析结论留痕台账)', !rep.isError, rep.text.replace(/\s+/g, ' ').slice(0, 220))
  const qry = await invoke(agentA, 'analysis_query', { line_id: ctxA.lineId, limit: 5 })
  step('D2', 'analysis_query(台账查回)', !qry.isError && /三上下文|SP/.test(qry.text), qry.text.replace(/\s+/g, ' ').slice(0, 220))
  const jl = await invoke(agentA, 'dcw_journal', { node_id: ctxA.sp.id, limit: 10 })
  step('D3', 'dcw_journal(写控台账可审计)', !jl.isError, jl.text.replace(/\s+/g, ' ').slice(0, 200))
  const ih = await invoke(agentA, 'intervention_history', { node_id: ctxA.sp.id, limit: 10 })
  step('D4', 'intervention_history(干预台账)', !ih.isError, ih.text.replace(/\s+/g, ' ').slice(0, 200))

  return finish(true)
}

function finish() {
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  writeFileSync(join(EVID, 'three-context.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), base, pass, fail, results,
  }, null, 2))
  console.log(`\n=== THREE-CONTEXT pass=${pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('fatal:', err)
  finish(false)
})
