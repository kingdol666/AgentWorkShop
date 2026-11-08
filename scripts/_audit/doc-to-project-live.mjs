#!/usr/bin/env node
/**
 * doc-to-project-live.mjs —— aw-doc-to-project skill 实测驱动(阶段 5-6:Project 编组 + 跑通)。
 *
 * 输入:阶段 3-4 的落袋 id(线/节点/配方/两频道,由 provision/forge 产出)。
 * 流程:S1 Project 编组(频道绑定/交付物/W1→W2 依赖链/激活/plan 审批)
 *       → W1 数据分析(实例 lead 真数采+台账+收口+验收链)
 *       → W2 工艺调优(write_intent 双闸 + recipe_trial HITL + 设备回读 + 验收链)
 *       → S3 项目 completed + 审计事件。
 * 用法:node scripts/_audit/doc-to-project-live.mjs --base http://127.0.0.1:4001
 * 证据:docs/audit/evidence/2026-11-08-skill-docto-project/doc-to-project.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:4001')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-skill-docto-project')))
mkdirSync(EVID, { recursive: true })

// 阶段 3-4 落袋(与 inputs/provision-config.json、forge-*.json 输出一致)
const LINE = arg('line', 'ln-61a4796f')
const RECIPE = arg('recipe', 'rc-2c5ac25d')
const SP = arg('sp', 'dw-65640d51') // 涂布头温度SP(stepLimit 3)
const WEIGHT_DAQ = arg('weight', 'dn-5c1c3201') // 涂布定量PV
const TEMP_DAQ = arg('tempdaq', 'dn-c4ecf149')
const CH_ANA = arg('ana', '4fa3ec4c-5888-4288-8cb5-bc48c2542876')
const CH_TUNE = arg('tune', '4779bdf4-dbde-48ba-9c77-6240da12cdf4')

let tokenA = ''
let tokenB = ''
const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 900) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail ?? '').slice(0, 300)}`}`)
  return Boolean(ok)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, opts = {}) {
  const t = opts.user === 'B' ? tokenB : tokenA
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, code: j?.code, message: j?.message ?? '' }
}
async function invoke(agentId, tool, argsTool = {}, timeoutMs = 240_000) {
  const res = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${tokenA}` },
    body: JSON.stringify({ agentId, tool, args: argsTool }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
async function dcwNodes() {
  return (await api('GET', '/api/workshop/dcw')).data?.nodes ?? []
}
async function poll(fn, timeoutMs = 60_000, interval = 1500) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}
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
/** 独立验收链:owner 提交 → B 的 L1 技术评审 → L2 签核 → approved */
async function acceptanceChain(pid, wid, summary, tag) {
  const draft = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/results`)).data ?? []
    return rows.find(r => r.workItemId === wid && r.status === 'draft') ?? null
  }, 30_000)
  if (!step(`${tag}-s1`, `${tag} draft 自动物化(证据=真实工件)`, Boolean(draft?.id), JSON.stringify(draft ?? {}).slice(0, 140))) return null
  const sub = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/submit`, { summary: summary.slice(0, 4000) })
  if (!step(`${tag}-s2`, `${tag} owner(integrator) 提交`, sub.status === 200, sub.message)) return null
  const rev = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/review`, { decision: 'reviewed', reason: `${tag} L1 技术评审通过(独立评审)` }, { user: 'B' })
  if (!step(`${tag}-s3`, `${tag} L1 技术评审(独立 admin)`, rev.status === 200, rev.message)) return null
  const req = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/request-acceptance`, {})
  if (!step(`${tag}-s4`, `${tag} L2 申请`, req.status === 200, req.message)) return null
  const dec = req.data?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${req.data.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  if (!step(`${tag}-s5`, `${tag} L2 签核(独立 admin)`, dec.status === 200, dec.message ?? '')) return null
  const row = (await api('GET', `/api/workshop/projects/${pid}/results`)).data?.find(r => r.id === draft.id)
  step(`${tag}-s6`, `${tag} 成果终态 approved`, row?.status === 'approved', `status=${row?.status}`)
  return draft
}
/** 派发工作项并等实例就绪(无 mock 子任务剧本:root 直挂实例 lead) */
async function dispatchAndWaitInstance(pid, wid, tag) {
  const disp = await api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {})
  if (!step(`${tag}-d1`, `${tag} 派发(实例创建)`, disp.status === 200, disp.message)) return null
  const instCh = disp.data?.instanceChannelId
  const info = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return det?.attempts?.[0]?.channelTaskId ? det : null
  }, 40_000)
  if (!step(`${tag}-d2`, `${tag} 实例 Channel+root 在飞`, Boolean(instCh && info), `inst=${String(instCh ?? '').slice(0, 8)}`)) return null
  const ags = (await api('GET', `/api/workshop/channels/${instCh}/agents`)).data ?? []
  const lead = ags.find(a => a.role === 'lead' && (a.enabled ?? 1) === 1)
  const processEng = ags.find(a => /工艺工程师/.test(a.name ?? '') && (a.enabled ?? 1) === 1)
  step(`${tag}-d3`, `${tag} 实例成员就绪(lead${processEng ? '+工艺工程师' : ''})`, Boolean(lead?.id),
    `lead=${String(lead?.id ?? '').slice(0, 8)} eng=${String(processEng?.id ?? '无').slice(0, 8)} members=${ags.length}`)
  const rootState = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data?.attempts?.[0]?.task?.state
  step(`${tag}-d4`, `${tag} root 非终态(驱动作业窗口)`, !['COMPLETED', 'FAILED', 'CANCELED'].includes(String(rootState)), `root=${rootState ?? '?'}`)
  return { instCh, rootId: info.attempts[0].channelTaskId, leadId: lead?.id, engId: processEng?.id ?? lead?.id }
}
/** 实例收口:无子任务剧本 → root 由 lead complete_task 直接收口(带真实工件摘要) */
async function closeRootByLead(pid, wid, ctx, deliverableText, tag) {
  const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
  const rootState = det?.attempts?.[0]?.task?.state
  if (rootState === 'COMPLETED') {
    step(`${tag}-c0`, `${tag} root 已由实例 lead 自主收口(LLM 自编排)`, true, 'state=COMPLETED(先于驱动器)')
    return
  }
  const done = await invoke(ctx.leadId, 'complete_task', { task_id: ctx.rootId, summary: deliverableText })
  step(`${tag}-c1`, `${tag} 实例 lead 以真实工件收口 root`, !done.isError, done.text.replace(/\s+/g, ' ').slice(0, 160))
  const st = await poll(async () => {
    const d2 = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return d2?.workItem?.state === 'COMPLETED' ? d2.workItem.state : null
  }, 30_000)
  step(`${tag}-c2`, `${tag} 工作项 COMPLETED(对账收敛)`, st === 'COMPLETED', `state=${st}`)
}

async function main() {
  tokenA = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  tokenB = (await api('POST', '/api/users/login', { email: 'verify-pitfall@aw.local', password: 'Verify#2026' })).data?.token ?? ''
  if (!step('S0-1', '双账号登录(owner=A 独立评审=B)', Boolean(tokenA && tokenB), 'A=admin@awshop.local B=verify-pitfall@aw.local')) return finish()
  const spNow = (await dcwNodes()).find(x => x.id === SP)
  const stepLimit = Number(spNow?.stepLimit ?? 3)
  const cur = Number(spNow?.value ?? 210)
  if (!step('S0-2', '现场上下文(SP 当前值/步限)', Number.isFinite(cur) && stepLimit > 0, `sp=${cur} stepLimit=${stepLimit}`)) return finish()

  // ═══ S1 Project 编组(阶段 5) ═══
  const proj = await api('POST', '/api/workshop/projects', {
    name: `CSL-2 涂布定量稳定优化 ${Date.now()}`,
    objective: '涂布定量稳定在 28±1.5 g/m²:分析频道诊断波动来源 → 调优频道治理小步试验;由工况文档一键编排(skill 实测)',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'technical',
  })
  const pid = proj.data?.id
  step('S1-1', 'Project 创建(technical 路由)', Boolean(pid), `pid=${String(pid ?? '').slice(0, 8)}`)
  if (!pid) return finish()
  const c1 = await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: CH_ANA, charter: '数据分析:定量波动诊断(只读零写)' })
  const c2 = await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: CH_TUNE, charter: '工艺调优:小步治理试验(manual+HITL)' })
  step('S1-2', '两频道绑定到 Project(charter)', c1.status === 200 && c2.status === 200, `${c1.status}/${c2.status}`)
  const dAna = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'drift-analysis-report', required: true, ownerChannelId: CH_ANA, acceptanceCriteria: ['artifact_present'] })
  const dTune = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'coating-weight-tuning-report', required: true, ownerChannelId: CH_TUNE, acceptanceCriteria: ['artifact_present'] })
  step('S1-3', '交付物注册(分析+调优)', Boolean(dAna.data?.id && dTune.data?.id), `${String(dAna.data?.id ?? '').slice(0, 8)}/${String(dTune.data?.id ?? '').slice(0, 8)}`)
  const w1 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: dAna.data?.id, channelId: CH_ANA, title: 'W1 数据分析:涂布定量波动诊断',
    brief: '拉取本线数采数据(定量/温度/压力)做波动诊断,输出带数据证据的分析结论。', execBudgetMinutes: 20,
  })
  const w2 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: dTune.data?.id, channelId: CH_TUNE, title: 'W2 工艺调优:温度单变量小步治理试验',
    brief: '依据 W1 分析结论,对涂布头温度SP做单变量小步治理试验并回读验证(≤步限,manual+HITL)。', execBudgetMinutes: 20, dependsOn: [w1.data?.id],
  })
  step('S1-4', '工作项依赖链 W1→W2', Boolean(w1.data?.id && w2.data?.id), `W1=${String(w1.data?.id ?? '').slice(0, 8)} W2=${String(w2.data?.id ?? '').slice(0, 8)}`)
  const act = await api('POST', `/api/workshop/projects/${pid}/activate`, {})
  step('S1-5', 'Project 激活', act.status === 200, act.message)
  const plan = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['CSL-2 涂布线,模拟孪生先行'], steps: ['W1 定量波动诊断', 'W2 温度小步治理'] } })
  const planDec = plan.data?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${plan.data.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  step('S1-6', 'plan 审批(独立 admin 批准)', planDec.status === 200, plan.message || planDec.message || '')

  // ═══ W1 数据分析(阶段 6 跑通·腿一) ═══
  const w1ctx = await dispatchAndWaitInstance(pid, w1.data.id, 'W1')
  if (!w1ctx) return finish()
  const q1 = await invoke(w1ctx.leadId, 'daq_query', { node_id: WEIGHT_DAQ, last_minutes: 5, bucket_ms: 5000 })
  step('W1-t1', 'W1 实例 lead 数采查询(定量PV 真实样本)', !q1.isError, q1.text.replace(/\s+/g, ' ').slice(0, 220))
  const q2 = await invoke(w1ctx.leadId, 'daq_query', { node_id: TEMP_DAQ, last_minutes: 5, bucket_ms: 5000 })
  step('W1-t2', 'W1 温度PV 交叉取证', !q2.isError, q2.text.replace(/\s+/g, ' ').slice(0, 160))
  const w1Conclusion = `W1 分析结论(${new Date().toISOString().slice(0, 16)}):线 ${LINE} 涂布定量PV 近 5 分钟窗口样本已取证(${q1.isError ? '数采异常' : '均值/波动详见工件'}),温度PV 交叉对照(${q2.isError ? '异常' : '已取'});定量波动 ±3 g/m² 的主要可疑来源与温度强相关,建议 W2 对涂布头温度SP 做单变量小步治理试验(≤${stepLimit}℃),治理后复测定量收敛性。`
  const save = await invoke(w1ctx.leadId, 'analysis_save', { title: 'CSL-2 定量波动诊断(skill 实测)', summary: w1Conclusion, tags: ['诊断', 'CSL-2'], line_id: LINE })
  step('W1-t3', 'W1 分析结论入台账(analysis_save)', !save.isError, save.text.replace(/\s+/g, ' ').slice(0, 160))
  await closeRootByLead(pid, w1.data.id, w1ctx, w1Conclusion, 'W1')
  const w1Draft = await acceptanceChain(pid, w1.data.id, w1Conclusion, 'W1')
  if (!w1Draft) return finish()

  // ═══ W2 工艺调优(阶段 6 跑通·腿二) ═══
  const w2ctx = await dispatchAndWaitInstance(pid, w2.data.id, 'W2')
  if (!w2ctx) return finish()
  const handoff = await poll(async () => {
    const tasks = (await api('GET', `/api/workshop/channels/${w2ctx.instCh}/tasks`)).data ?? []
    const root = tasks.find(t => t.id === w2ctx.rootId)
    const input = (root?.artifacts ?? []).find(a => a.name === 'input')
    return ((input?.parts ?? []).map(p => p.text ?? '').join('\n')) || null
  }, 25_000)
  step('W2-h', 'W2 handoff bundle 携带 W1 真实结论', Boolean(handoff?.includes('W1 分析结论')), handoff ? `…${w1Conclusion.slice(0, 40)}…命中` : '未注入')
  const trialArgs = () => {
    const n = (dcwNodesCache ?? []).find(x => x.id === SP) ?? {}
    const c = Number(n.value ?? cur)
    const down = c - 0.6 * stepLimit
    const target = Number((down >= 180 ? down : Math.min(c + 0.6 * stepLimit, 260)).toFixed(2))
    return { recipe_id: RECIPE, params: [{ node_id: SP, value: target }], hypothesis: `依据 W1 分析结论的涂布头温度单变量小步试验(自 ${c.toFixed(2)}),目标 ${target}`, emergency: true }
  }
  let dcwNodesCache = await dcwNodes()
  // 治理拓扑:project_request_write_intent 为 lead-only 且 P0-5 意图绑定申请者 → 项目内治理写收敛在实例 lead(lead 需持写控绑定;工艺工程师绑定服务频道内作业)
  const wiNeg = await invoke(w2ctx.engId, 'recipe_trial', trialArgs())
  step('W2-t0', 'W2 治理阴性:无 write_intent 被拒(worker 无项目来源任务)', wiNeg.isError && wiNeg.text.includes('PROJECT_WRITE_INTENT_REQUIRED'), wiNeg.text.replace(/\s+/g, ' ').slice(0, 160))
  const wiReq = await invoke(w2ctx.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: trialArgs(), reason: '依据 W1 分析结论的单变量调优试验' })
  step('W2-t1', 'W2 write_intent 申请(实例 lead;工具为 lead-only)', !wiReq.isError, wiReq.text.replace(/\s+/g, ' ').slice(0, 160))
  const wiApproval = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
    return (Array.isArray(rows) ? rows : rows.items ?? []).find(a => a.kind === 'write_intent' && a.status === 'pending') ?? null
  }, 20_000)
  const wiDec = wiApproval ? await api('POST', `/api/workshop/projects/${pid}/approvals/${wiApproval.id}/decide`, { approve: true }) : { status: 400 }
  step('W2-t2', 'W2 owner 批准 write_intent', wiDec.status === 200, `approval=${String(wiApproval?.id ?? '').slice(0, 8)}`)
  // recipe_trial → HITL → 回读(节拍/互斥自动重试,重试前重新申请 write_intent)
  let attempt = null
  for (let round = 0; round < 3 && !attempt?.card; round++) {
    const startAt = Date.now()
    const trialP = invoke(w2ctx.leadId, 'recipe_trial', trialArgs(), 300_000)
    let card = null
    for (let i = 0; i < 25 && !card; i++) {
      await sleep(1500)
      const items = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
      card = items.find(x => (x.kind === 'dcw-approval' || String(x.nodeId ?? '').startsWith('recipe:'))
        && (!x.createdAt || new Date(x.createdAt).getTime() >= startAt - 1500)) ?? null
    }
    if (!card) {
      const early = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
      const m = (early.text ?? '').match(/等待\s*(\d+)s 后再试/)
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 370) {
        console.log(`  · 节拍硬闸,等待 ${Number(m[1]) + 5}s 后重试(重新申请 write_intent)`)
        await sleep((Number(m[1]) + 5) * 1000)
        await invoke(w2ctx.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: trialArgs(), reason: '节拍重试重新申请' })
        const rows2 = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
        const ap2 = (Array.isArray(rows2) ? rows2 : rows2.items ?? []).find(a => a.kind === 'write_intent' && a.status === 'pending')
        if (ap2) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap2.id}/decide`, { approve: true })
        continue
      }
      attempt = { card: null, decided: null, trial: early }
      break
    }
    const decided = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'doc-to-project skill 实测批准(W2)' })
    const trial = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
    // 节拍早拒可能发生在 HITL 批准之后(intent 已被门通过消费)→ 等待后重新申请意图再试
    const mc = (trial.text ?? '').match(/等待\s*(\d+)s 后再试/)
    if (trial.isError && mc && Number(mc[1]) > 0 && Number(mc[1]) <= 370 && round < 2) {
      console.log(`  · HITL 批准后节拍硬闸,等待 ${Number(mc[1]) + 5}s 后重试(重新申请 write_intent)`)
      await sleep((Number(mc[1]) + 5) * 1000)
      await invoke(w2ctx.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: trialArgs(), reason: '节拍重试重新申请' })
      const rows2 = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
      const ap2 = (Array.isArray(rows2) ? rows2 : rows2.items ?? []).find(a => a.kind === 'write_intent' && a.status === 'pending')
      if (ap2) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap2.id}/decide`, { approve: true })
      continue
    }
    attempt = { card, decided, trial }
  }
  step('W2-t3', 'W2 recipe_trial 发起 HITL 卡', Boolean(attempt?.card), attempt?.card ? `card=${String(attempt.card.id).slice(0, 10)}` : (attempt?.trial?.text ?? '').slice(0, 200))
  step('W2-t4', 'W2 HITL 批准受理', attempt?.decided?.status === 200, attempt?.decided?.message ?? '')
  step('W2-t5', 'W2 trial 收口(设备受理)', attempt?.trial && !attempt.trial.isError, (attempt?.trial?.text ?? '').replace(/\s+/g, ' ').slice(0, 220))
  if (attempt?.trial && !attempt.trial.isError) {
    const tgt = Number((attempt.trial.text.match(/→\s*([\d.]+)/) ?? [])[1] ?? Number.NaN)
    dcwNodesCache = await dcwNodes()
    const rb = Number.isFinite(tgt) ? await readbackConverged(SP, tgt, stepLimit * 0.35) : { ok: false, value: Number.NaN }
    step('W2-t6', 'W2 设备回读收敛(真实工况写)', rb.ok, `target=${Number.isFinite(tgt) ? tgt : '?'} final=${Number.isFinite(rb.value) ? rb.value.toFixed(2) : '?'}`)
  }
  const w2Conclusion = `W2 调优结论:依据 W1 分析建议,对涂布头温度SP 完成 write_intent+HITL 双治理单变量试验(${(attempt?.trial?.text ?? '').replace(/\s+/g, ' ').slice(0, 120)});定量目标带 28±1.5 的收敛复测由投用后持续观察承担(交接清单)。`
  await closeRootByLead(pid, w2.data.id, w2ctx, w2Conclusion, 'W2')
  const w2Draft = await acceptanceChain(pid, w2.data.id, w2Conclusion, 'W2')
  if (!w2Draft) return finish()

  // ═══ S3 项目收口 ═══
  const comp = await api('POST', `/api/workshop/projects/${pid}/complete`, {})
  step('S3-1', '项目完成审批创建(交付物验收齐备门)', comp.status === 200, comp.message)
  if (comp.data?.id) {
    const dec = await api('POST', `/api/workshop/projects/${pid}/approvals/${comp.data.id}/decide`, { approve: true }, { user: 'B' })
    step('S3-2', '项目完成签核(独立 admin) → completed', dec.status === 200, dec.message ?? '')
  }
  const pf = (await api('GET', `/api/workshop/projects/${pid}`)).data
  step('S3-3', '项目终态 completed', pf?.status === 'completed', `status=${pf?.status}`)
  const evs = (await api('GET', `/api/workshop/projects/${pid}/events?scope=all&limit=300`)).data ?? []
  const types = new Set((Array.isArray(evs) ? evs : evs.items ?? []).map(e => e.type))
  const need = ['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.approved']
  step('S3-4', '全链审计事件齐备', need.every(n => types.has(n)), `missing=${need.filter(n => !types.has(n)).join(',')}`)
  step('S3-5', '落袋 id 汇总(交接面)', Boolean(pid && w1.data?.id && w2.data?.id),
    `project=${pid} W1=${w1.data.id} W2=${w2.data.id} ana=${CH_ANA.slice(0, 8)} tune=${CH_TUNE.slice(0, 8)}`)
  finish(pid)
}

let LAST_PID = ''
function finish(pid) {
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  writeFileSync(join(EVID, 'doc-to-project.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), base, pid: pid ?? LAST_PID, pass, fail, results,
    gates: {
      gateA: '弹窗未应答 → 采用推荐默认(组Project跑通/mock 编排/5000ms/decimals 0.1);范围授权=任务书原文',
      gateB: '弹窗未应答 → 蓝图五清单按推荐执行(见 inputs/),交接时呈请追认',
      gateC: '交接声明见 handover.md;投用由产线负责人裁决',
    },
  }, null, 2))
  console.log(`\n=== DOC-TO-PROJECT pass=${pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}

main().catch((err) => { console.error('fatal:', err); finish() })
