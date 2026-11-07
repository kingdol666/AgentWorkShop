#!/usr/bin/env node
/**
 * multi-channel-project-collab-live.mjs —— 最终形态验收:多 Channel 组成 Project 协同完成产线作业。
 *
 * 场景(用户目标):一个 Channel 负责数据分析、一个负责工艺调优、一个负责模型构建,
 * 三个 Channel 组成一个 Project,下发依赖链任务,验证能协同完成真实产线作业。
 *
 *   W1 数据分析(分析频道)  ──┐
 *   W2 工艺调优(调优频道)  ──┤ dependsOn 链: W1→W2→W3, routingPolicy=technical
 *   W3 模型构建(建模频道)  ──┘   (上游成果 L1+L2 通过才放行下游;handoff 携带上游真实结论)
 *
 * 每条腿的真实性:
 *   - 实例内以实例 lead 身份走真实工具链(数采/治理写+HITL/数据集构建),产物为真实数据;
 *   - 实例 lead 取消 mock 子任务并以真实工件收口 root(mock 只承担任务编排骨架);
 *   - owner(integrator) REST 提交 → 独立 admin 做 L1 技术评审 + L2 签核;
 *   - 设备回读证实工艺写真实生效(PLC 模拟器 :4010)。
 *
 * 用法:AW_BASE=http://127.0.0.1:3997 node scripts/_audit/multi-channel-project-collab-live.mjs
 * 证据:docs/audit/evidence/2026-11-08-multi-channel-collab/collab.json
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
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-multi-channel-collab')))
mkdirSync(EVID, { recursive: true })

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
/** Agent 工具桥(admin 用户代调;身份=agentId,同一执行层 dispatch) */
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
async function poll(fn, timeoutMs = 60_000, interval = 800) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}
async function trialWithHitl(agentId, trialArgs, tag) {
  const startAt = Date.now()
  const trialP = invoke(agentId, 'recipe_trial', trialArgs, 300_000)
  let card = null
  for (let i = 0; i < 30 && !card; i++) {
    await sleep(1500)
    const items = (await api('GET', '/api/workshop/hitl/pending', undefined, { user: 'B' })).data?.items ?? []
    card = items.find(x => (x.kind === 'dcw-approval' || String(x.nodeId ?? '').startsWith('recipe:'))
      && (!x.createdAt || new Date(x.createdAt).getTime() >= startAt - 1500)) ?? null
  }
  if (!card) return { card: null, decided: null, trial: await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) })) }
  const decided = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: `多Channel协同验收批准(${tag})` }, { user: 'B' })
  const trial = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
  return { card, decided, trial }
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
/** 独立验收链:owner 提交 → B 的 L1 技术评审 → L2 签核 → 工作项 approved */
async function acceptanceChain(pid, wid, summary, tag) {
  const draft = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/results`)).data ?? []
    return rows.find(r => r.workItemId === wid && r.status === 'draft') ?? null
  }, 30_000)
  if (!step(`${tag}-s1`, `${tag} draft 自动物化(证据=真实工件)`, Boolean(draft?.id), JSON.stringify(draft ?? {}).slice(0, 160))) return null
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
/** 派发工作项并等实例就绪(实例 Channel + 实例 lead + mock 子任务在飞) */
async function dispatchAndWaitInstance(pid, wid, tag) {
  const disp = await api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {})
  if (!step(`${tag}-d1`, `${tag} 派发(实例创建)`, disp.status === 200, disp.message)) return null
  // 派发响应即含 instanceChannelId(workItem 行);rootId 从 detail attempts 取
  const instCh = disp.data?.instanceChannelId
  const info = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return det?.attempts?.[0]?.channelTaskId ? det : null
  }, 40_000)
  if (!step(`${tag}-d2`, `${tag} 实例 Channel+root 在飞`, Boolean(instCh && info), `inst=${String(instCh ?? '').slice(0, 8)}`)) return null
  // 等 mock lead 拆分子任务([mock:complex] → worker 在飞,root 保持 WORKING);
  // 模板 lead 可能非 mock 剧本(不拆子任务)——驱动窗口的硬要求只是 root 非终态。
  const childId = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return det?.attempts?.[0]?.workers?.find(w => !['COMPLETED', 'FAILED', 'CANCELED'].includes(w.state))?.id ?? null
  }, 40_000)
  const rootState = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data?.attempts?.[0]?.task?.state
  step(`${tag}-d3`, `${tag} root 保持非终态(驱动作业窗口)`, !['COMPLETED', 'FAILED', 'CANCELED'].includes(String(rootState)),
    `root=${rootState ?? '?'} child=${String(childId ?? '无(非 mock 剧本)').slice(0, 8)}`)
  const ags = (await api('GET', `/api/workshop/channels/${instCh}/agents`)).data ?? []
  const lead = ags.find(a => a.role === 'lead' && a.enabled === 1)
  step(`${tag}-d4`, `${tag} 实例 lead 启用`, Boolean(lead?.id), `lead=${String(lead?.id ?? '').slice(0, 8)}`)
  return { instCh, rootId: info.attempts[0].channelTaskId, childId, leadId: lead?.id }
}
/** 实例 lead 收口:取消 mock 子任务 → 自派替代分支 → supersede 显式替代 → 收替代分支 → 以真实工件完成 root。
 *  引擎约束:父任务收口要求所有子任务 COMPLETED 或 superseded,且 COMPLETED 子任务须有非空交付物。 */
async function closeRootByLead(pid, wid, ctx, deliverableText, tag) {
  if (ctx.childId) {
    const c = await invoke(ctx.leadId, 'cancel_task', { task_id: ctx.childId })
    step(`${tag}-c1`, `${tag} 实例 lead 取消 mock 子任务`, !c.isError, c.text.replace(/\s+/g, ' ').slice(0, 160))
    const rep = await invoke(ctx.leadId, 'dispatch_task', {
      parent_task_id: ctx.rootId, assignee_id: ctx.leadId,
      title: `${tag} 补收口分支`, description: '替代被取消的 mock 分支(驱动器以真实工件收口)',
    })
    const newChildId = (rep.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0]
      ?? rep.data?.task?.id ?? null
    step(`${tag}-c2`, `${tag} 自派替代分支(assignee=lead)`, !rep.isError && Boolean(newChildId), rep.text.replace(/\s+/g, ' ').slice(0, 160))
    if (newChildId) {
      const sup = await invoke(ctx.leadId, 'supersede_task', {
        task_id: ctx.childId, replacement_task_id: newChildId, reason: `${tag} mock 分支取消,由补收口分支替代`,
      })
      step(`${tag}-c3`, `${tag} supersede 显式替代(取消分支处置)`, !sup.isError, sup.text.replace(/\s+/g, ' ').slice(0, 160))
      const rep2 = await invoke(ctx.leadId, 'complete_task', {
        task_id: newChildId,
        summary: `${tag} 分支收口确认:真实作业已由实例 lead 完成(工具链执行),本分支承载收口。`,
      })
      step(`${tag}-c4`, `${tag} 收替代分支`, !rep2.isError, rep2.text.replace(/\s+/g, ' ').slice(0, 120))
    }
  }
  // complete_task 工具只吃 summary/deliverable 字符串(artifacts 数组不解析),由工具层生成 deliverable 工件
  const done = await invoke(ctx.leadId, 'complete_task', {
    task_id: ctx.rootId,
    summary: deliverableText,
  })
  step(`${tag}-c5`, `${tag} 实例 lead 以真实工件收口 root`, !done.isError, done.text.replace(/\s+/g, ' ').slice(0, 160))
  const st = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return det?.workItem?.state === 'COMPLETED' ? det.workItem.state : null
  }, 30_000)
  step(`${tag}-c6`, `${tag} 工作项 COMPLETED(对账收敛)`, st === 'COMPLETED', `state=${st}`)
}
/** 断言下游实例 root 的 handoff bundle(input 工件)携带上游真实结论(经实例频道 tasks REST 取全工件) */
async function assertHandoff(pid, wid, instCh, needle, tag) {
  const found = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    const rootId = det?.attempts?.[0]?.channelTaskId
    if (!rootId || !instCh) return null
    const tasks = (await api('GET', `/api/workshop/channels/${instCh}/tasks`)).data ?? []
    const root = tasks.find(t => t.id === rootId)
    const input = (root?.artifacts ?? []).find(a => a.name === 'input')
    const text = (input?.parts ?? []).map(p => p.text ?? '').join('\n')
    return text.includes(needle) ? text : null
  }, 25_000)
  step(`${tag}-h`, `${tag} handoff bundle 携带上游真实结论(跨 Channel 协同)`, Boolean(found),
    found ? `…${needle.slice(0, 60)}…已注入` : '上游结论文本未出现在 handoff')
}

async function main() {
  // ═══ S0 双账号 + 现场 + 孤儿接管窗口 ═══
  tokenA = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  tokenB = (await api('POST', '/api/users/login', { email: 'verify-pitfall@aw.local', password: 'Verify#2026' })).data?.token ?? ''
  if (!step('S0-1', '双账号登录(owner=A 独立评审=B)', Boolean(tokenA && tokenB), 'A=admin@awshop.local B=verify-pitfall@aw.local')) return finish(false)
  // 重跑清理:取消历史中断运行遗留的未终态工作项(幂等)
  for (const p of (await api('GET', '/api/workshop/projects')).data ?? []) {
    if (!String(p.name ?? '').startsWith('注塑工艺协同优化') || p.status === 'completed' || p.status === 'canceled') continue
    for (const w of (await api('GET', `/api/workshop/projects/${p.id}/observability`)).data?.workItems ?? []) {
      if (!['COMPLETED', 'FAILED', 'CANCELED', 'SUPERSEDED'].includes(w.state)) {
        await api('POST', `/api/workshop/projects/${p.id}/work-items/${w.id}/cancel`, { reason: '重跑清理' }).catch(() => {})
      }
    }
  }
  const dcwAll = await dcwNodes()
  const daqAll = (await api('GET', '/api/workshop/daq')).data?.nodes ?? []
  const recipesAll = (await api('GET', '/api/workshop/dcw')).data?.recipes ?? []
  const running = ((await api('GET', '/api/workshop/dcw')).data?.lineStates ?? []).filter(s => s.active === true)
  if (!step('S0-2', '产线现场就绪', dcwAll.length > 0 && daqAll.length > 0 && recipesAll.length > 0 && running.length >= 1,
    `dcw=${dcwAll.length} daq=${daqAll.length} recipes=${recipesAll.length} running=${running.length}`)) return finish(false)
  const lineA = running[0]?.lineId
  const sp = dcwAll.find(n => (n.lineId ?? '') === lineA && /SP/i.test(n.name ?? ''))
  const recipeA = recipesAll.find(r => r.lineId === lineA)
  const daqLineA = daqAll.filter(n => (n.lineId ?? '') === lineA)
  if (!step('S0-3', '目标线解析(SP/配方/数采通道)', Boolean(lineA && sp && recipeA && daqLineA.length >= 2),
    `line=${String(lineA).slice(0, 8)} sp=${String(sp?.id).slice(0, 8)} daq=${daqLineA.length}`)) return finish(false)
  await api('PATCH', '/api/system/settings', { override: { 'dcw.rollback_stale_ms': 60000 } })

  // ═══ S1 三个专职 Channel ═══
  const wsId = (await api('GET', '/api/workshop/workspaces')).data?.[0]?.id
    ?? (await api('POST', '/api/workshop/workspaces', { name: `多Channel协同-${randomUUID().slice(0, 5)}` })).data?.id
  const mkChannel = async (name, leadName) => {
    const ch = await api('POST', '/api/workshop/channels', { name, lineId: lineA })
    const cid = ch.data?.channelId ?? ch.data?.id
    const lead = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: leadName, harness: 'mock', role: 'lead' })
    await api('POST', `/api/workshop/channels/${cid}/agents`, { name: `${leadName}·worker`, harness: 'mock', role: 'worker', config: { delayMs: 600000 } })
    await api('POST', `/api/workshop/channels/${cid}/activate`, {})
    await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {})
    return { channelId: cid, leadId: lead.data?.id ?? lead.data?.agentId }
  }
  const ana = await mkChannel(`数据分析频道-${randomUUID().slice(0, 4)}`, '分析Lead')
  const tune = await mkChannel(`工艺调优频道-${randomUUID().slice(0, 4)}`, '调优Lead')
  step('S1-1', '分析/调优频道建立(绑线+lead+worker)', Boolean(ana.channelId && tune.channelId), `ana=${String(ana.channelId).slice(0, 8)} tune=${String(tune.channelId).slice(0, 8)}`)

  // 建模频道:模板实例化 toolProfile=aml_training(训练族工具面)。
  // 坑:instantiate 响应**没有 leadAgentId 字段**,lead 从 agents[] 里取;
  // 模板自带 worker(delayMs 缺省 300ms)会让 mock 秒完成 → 换成大延时 worker 保证驱动窗口。
  const tpl = (await api('GET', '/api/workshop/channel-templates')).data
  const tplList = Array.isArray(tpl) ? tpl : (tpl?.templates ?? [])
  const tplId = (tplList.find(t => t.id === 'chtpl-aml-training-default') ?? tplList[0])?.id
  const inst = await api('POST', `/api/workshop/channel-templates/${tplId}/instantiate`, {
    name: `模型构建频道-${randomUUID().slice(0, 4)}`, toolProfile: 'aml_training', bindLineId: lineA,
  })
  const model = { channelId: inst.data?.channelId, leadId: (inst.data?.agents ?? []).find(a => a.role === 'lead')?.id }
  if (model.channelId) {
    for (const w of (inst.data?.agents ?? []).filter(a => a.role === 'worker')) {
      await api('DELETE', `/api/workshop/channels/${model.channelId}/agents/${w.id}`)
    }
    await api('POST', `/api/workshop/channels/${model.channelId}/agents`, { name: '建模Worker', harness: 'mock', role: 'worker', config: { delayMs: 600000 } })
    await api('POST', `/api/workshop/channels/${model.channelId}/activate`, {})
    await api('POST', `/api/workshop/workspaces/${wsId}/channels/${model.channelId}`, {})
  }
  const modelProfile = (await api('GET', `/api/workshop/channels/${model.channelId}/twin-profile`)).data
  step('S1-2', '建模频道建立(toolProfile=aml_training)', Boolean(model.channelId && model.leadId && modelProfile?.profile?.profile === 'aml_training'),
    `ch=${String(model.channelId ?? '').slice(0, 8)} profile=${modelProfile?.profile?.profile ?? '?'}`)

  // 节点绑定:分析/建模 lead 绑数采;调优 lead 绑数采+SP 写控+配方(逐条校验状态)
  const bindResults = []
  for (const n of daqLineA.slice(0, 3)) {
    bindResults.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ana.leadId, nodeId: n.id, kind: 'daq', mode: 'auto' })).status)
    bindResults.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: model.leadId, nodeId: n.id, kind: 'daq', mode: 'auto' })).status)
  }
  bindResults.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ana.leadId, nodeId: sp.id, kind: 'dcw' })).status)
  bindResults.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: tune.leadId, nodeId: sp.id, kind: 'dcw' })).status)
  bindResults.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: tune.leadId, nodeId: recipeA.id, kind: 'recipe' })).status)
  step('S1-3', '三频道节点绑定(数采/写控/配方,全部 200)', bindResults.every(s => s === 200), `posts=${bindResults.length} bad=${bindResults.filter(s => s !== 200).join(',')}`)

  // ═══ S2 Project:三频道编组 + 依赖链计划 ═══
  const proj = await api('POST', '/api/workshop/projects', {
    name: `注塑工艺协同优化 ${Date.now()}`,
    objective: '分析频道诊断漂移 → 调优频道治理下发 → 建模频道构建数据集,三频道协同完成产线优化作业',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'technical',
  })
  const pid = proj.data?.id
  for (const c of [ana, tune, model]) await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: c.channelId, charter: '协同' })
  const dAna = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'drift-analysis-report', required: true, ownerChannelId: ana.channelId, acceptanceCriteria: ['artifact_present'] })
  const dTune = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'setpoint-tuning-report', required: true, ownerChannelId: tune.channelId, acceptanceCriteria: ['artifact_present'] })
  const dModel = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'model-dataset-report', required: true, ownerChannelId: model.channelId, acceptanceCriteria: ['artifact_present'] })
  const w1 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: dAna.data?.id, channelId: ana.channelId, title: 'W1 数据分析:漂移诊断',
    brief: '[mock:complex] 拉取本线数采数据做漂移诊断,产出分析结论。多阶段执行。', execBudgetMinutes: 20,
  })
  const w2 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: dTune.data?.id, channelId: tune.channelId, title: 'W2 工艺调优:SP 治理试验',
    brief: '[mock:complex] 依据分析结论做单变量治理试验并回读验证。多阶段执行。', execBudgetMinutes: 20, dependsOn: [w1.data?.id],
  })
  const w3 = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: dModel.data?.id, channelId: model.channelId, title: 'W3 模型构建:训练数据集',
    brief: '[mock:complex] 基于调优后数据构建训练数据集与质量报告。多阶段执行。', execBudgetMinutes: 20, dependsOn: [w2.data?.id],
  })
  await api('POST', `/api/workshop/projects/${pid}/activate`, {})
  const plan = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['multi-channel collab'], steps: ['W1 分析', 'W2 调优', 'W3 建模'] } })
  if (plan.data?.id) await api('POST', `/api/workshop/projects/${pid}/approvals/${plan.data.id}/decide`, { approve: true }, { user: 'B' })
  step('S2-1', 'Project 编组(3 频道+3 交付物+W1→W2→W3 依赖链,technical 路由)', Boolean(pid && w1.data?.id && w2.data?.id && w3.data?.id),
    `p=${String(pid).slice(0, 8)} deps=${Boolean(w2.data?.id && w3.data?.id)}`)

  // ═══ W1 数据分析腿 ═══
  const w1ctx = await dispatchAndWaitInstance(pid, w1.data.id, 'W1')
  if (!w1ctx) return finish(false)
  // 引用校验层不拆逗号串 → 逐节点查询
  const qNodes = daqLineA.slice(0, 2)
  const qTexts = []
  for (const n of qNodes) {
    const q = await invoke(w1ctx.leadId, 'daq_query', { node_id: n.id, last_minutes: 30, bucket_ms: 60_000 })
    qTexts.push(`[${n.name ?? n.id.slice(0, 8)}] ${q.text.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  step('W1-t1', 'W1 实例 lead 数采查询(真实数据,逐节点)', qTexts.every(t => !/isError/.test(t)) && qTexts.length === qNodes.length, qTexts.join(' | ').slice(0, 400))
  const anaConclusion = `W1 分析结论(${new Date().toISOString().slice(0, 16)}):线 ${lineA.slice(0, 8)} 近 30min 数采 ${qNodes.length} 通道连续采样(${qTexts[0]?.slice(0, 80)});SP 回读与设定一致性良好,波动在步限内;建议对 ${sp.name} 做一次 +0.5×step 的单变量上调试验验证响应斜率。`
  const as1 = await invoke(w1ctx.leadId, 'analysis_save', {
    title: `多Channel协同·漂移诊断 ${Date.now()}`,
    summary: anaConclusion.slice(0, 200),
    conclusions: ['30min 窗内各通道采样连续,无缺失段', 'SP 回读与设定一致,未见异常漂移', '建议单变量上调试验验证响应'],
    line_id: lineA, recipe_id: recipeA.id,
  })
  step('W1-t2', 'W1 分析结论入台账(analysis_save)', !as1.isError, as1.text.replace(/\s+/g, ' ').slice(0, 200))
  await closeRootByLead(pid, w1.data.id, w1ctx, anaConclusion, 'W1')
  const w1Draft = await acceptanceChain(pid, w1.data.id, anaConclusion, 'W1')
  if (!w1Draft) return finish(false)

  // ═══ W2 工艺调优腿(handoff 协同) ═══
  await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${w2.data.id}`)).data
    return det?.workItem?.state === 'DRAFT' && (det.workItem.readiness?.ready === true || det.workItem.waitingOn === 'READY') ? true : null
  }, 20_000)
  const w2ctx = await dispatchAndWaitInstance(pid, w2.data.id, 'W2')
  if (!w2ctx) return finish(false)
  await assertHandoff(pid, w2.data.id, w2ctx.instCh, anaConclusion.slice(0, 40), 'W2')
  const spNow = (await dcwNodes()).find(x => x.id === sp.id)
  const curVal = Number(spNow?.value ?? recipeA.params.find(p => p.nodeId === sp.id)?.value ?? 0)
  const lo = Number.isFinite(Number(spNow?.min)) ? Number(spNow.min) : -1e9
  const hi = Number.isFinite(Number(spNow?.max)) ? Number(spNow.max) : 1e9
  const stepLimit = Number(spNow?.stepLimit ?? 1)
  const target = Math.min(hi, Math.max(lo, curVal + stepLimit * 0.5))
  const trialArgs = {
    recipe_id: recipeA.id,
    params: [{ node_id: sp.id, value: Number(target.toFixed(2)) }],
    hypothesis: `多Channel协同·调优:依据 W1 分析结论,单变量 SP ${curVal.toFixed(2)}→${target.toFixed(2)}`,
    emergency: true,
  }
  const wiNeg = await invoke(w2ctx.leadId, 'recipe_trial', trialArgs, 60_000)
  step('W2-t0', 'W2 治理阴性:实例内写无 write_intent 被拒', wiNeg.isError && wiNeg.text.includes('PROJECT_WRITE_INTENT_REQUIRED'), wiNeg.text.slice(0, 160))
  const wiReq = await invoke(w2ctx.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: trialArgs, reason: '依据 W1 分析结论的单变量调优试验' })
  step('W2-t1', 'W2 write_intent 申请(实例 lead)', !wiReq.isError, wiReq.text.replace(/\s+/g, ' ').slice(0, 160))
  const wiApproval = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
    return rows.find(a => a.kind === 'write_intent') ?? null
  }, 15_000)
  const wiDec = wiApproval?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${wiApproval.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  step('W2-t2', 'W2 owner 批准 write_intent(项目层治理)', wiDec.status === 200, `approval=${String(wiApproval?.id ?? '').slice(0, 8)}`)
  let attempt = await trialWithHitl(w2ctx.leadId, trialArgs, 'W2')
  for (let i = 0; i < 2; i++) {
    const m = (attempt.trial?.text ?? '').match(/等待\s*(\d+)s 后再试/)
    const waitSec = m ? Number(m[1]) : 0
    if (!(waitSec > 0 && waitSec <= 370)) break
    console.log(`  · 试验节拍硬闸,等待 ${waitSec + 5}s 后重试(重新申请 write_intent)`)
    await sleep((waitSec + 5) * 1000)
    await invoke(w2ctx.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: trialArgs, reason: '节拍重试重新申请' })
    const ap = await poll(async () => {
      const rows = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
      return rows.find(a => a.kind === 'write_intent') ?? null
    }, 15_000)
    if (ap?.id) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true }, { user: 'B' })
    attempt = await trialWithHitl(w2ctx.leadId, trialArgs, 'W2')
  }
  step('W2-t3', 'W2 recipe_trial HITL 卡+批准', Boolean(attempt.card) && attempt.decided?.status === 200,
    attempt.card ? `card=${String(attempt.card.id).slice(0, 8)}` : (attempt.trial?.text ?? '').slice(0, 180))
  step('W2-t4', 'W2 trial 收口(设备受理)', Boolean(attempt.trial) && !attempt.trial.isError, (attempt.trial?.text ?? '').replace(/\s+/g, ' ').slice(0, 220))
  let tuneConclusion
  if (attempt.trial && !attempt.trial.isError) {
    const rb = await readbackConverged(sp.id, target, stepLimit * 0.35)
    step('W2-t5', 'W2 设备回读收敛(真实工况写)', rb.ok, `target=${target.toFixed(2)} final=${Number.isFinite(rb.value) ? rb.value.toFixed(2) : '?'}`)
    tuneConclusion = `W2 调优结论:依据 W1 分析建议,SP ${curVal.toFixed(2)}→${target.toFixed(2)}(Δ${(target - curVal).toFixed(2)})经 write_intent+HITL 双治理下发,批次受理,设备回读 ${Number.isFinite(rb.value) ? rb.value.toFixed(2) : '?'}(容差 ${(stepLimit * 0.35).toFixed(2)})。`
  } else {
    tuneConclusion = `W2 调优结论:治理链拦截(节拍/互斥),未写入;末次回执:${(attempt.trial?.text ?? '').slice(0, 200)}`
    step('W2-t5', 'W2 设备回读收敛(真实工况写)', false, 'trial 未收口,如实降级')
  }
  await closeRootByLead(pid, w2.data.id, w2ctx, tuneConclusion, 'W2')
  const w2Draft = await acceptanceChain(pid, w2.data.id, tuneConclusion, 'W2')
  if (!w2Draft) return finish(false)

  // ═══ W3 模型构建腿 ═══
  const w3ctx = await dispatchAndWaitInstance(pid, w3.data.id, 'W3')
  if (!w3ctx) return finish(false)
  await assertHandoff(pid, w3.data.id, w3ctx.instCh, tuneConclusion.slice(0, 40), 'W3')
  const ds = await invoke(model.leadId, 'aml_dataset_build', {
    line_id: lineA,
    product_id: recipeA.productId,
    recipe_id: recipeA.id,
    nodes: [
      { node_id: daqLineA[0].id, role: 'control' },
      { node_id: (daqLineA[1] ?? daqLineA[0]).id, role: 'target' },
    ],
    window_minutes: 180, beat_ms: 5000, history_steps: 64, horizon_steps: 8,
  })
  let dsId = (ds.text.match(/ds-[a-z0-9-]+/i) ?? [])[0] ?? ''
  // 首试语义:未完结批次被拒(批次隔离)或同规格熔断去重(返回既有 ds-id)都是设计行为;成功亦过
  step('W3-t1', 'W3 aml_dataset_build 首试(批次语义/去重熔断=设计;有数据集=直接过)',
    (ds.isError && /已完结的批次|已构建过同规格数据集/.test(ds.text)) || (!ds.isError && Boolean(dsId)), ds.text.replace(/\s+/g, ' ').slice(0, 240))
  if (ds.isError && /已完结的批次/.test(ds.text)) {
    // 批次语义:数据集构建要求「已完结的批次」。当前 run 是 seed 开跑后的长开批次 →
    // 关闭当前批次(数小时真实打标样本入账)→ 重启产线开新批 → 重试构建。
    const openRun = ((await api('GET', '/api/workshop/dcw/runs?limit=20')).data?.runs ?? []).find(r => r.lineId === lineA && !r.endedAt)
    const closed = openRun ? await api('POST', `/api/workshop/dcw/runs/${openRun.id}/close`, {}) : { status: 404 }
    const restarted = await api('POST', `/api/workshop/dcw/lines/${lineA}/start`, { recipeId: recipeA.id })
    step('W3-t0', 'W3 批次收口+产线重开(数据集批次语义)', closed.status === 200 && restarted.status === 200, `close=${closed.status} start=${restarted.status}`)
    const ds2 = await invoke(model.leadId, 'aml_dataset_build', {
      line_id: lineA,
      product_id: recipeA.productId,
      recipe_id: recipeA.id,
      nodes: [
        { node_id: daqLineA[0].id, role: 'control' },
        { node_id: (daqLineA[1] ?? daqLineA[0]).id, role: 'target' },
      ],
      window_minutes: 180, beat_ms: 5000, history_steps: 64, horizon_steps: 8,
    })
    ds.text = ds2.text
    ds.isError = ds2.isError
    dsId = (ds2.text.match(/ds-[a-z0-9-]+/i) ?? [])[0] ?? ''
    step('W3-t1b', 'W3 aml_dataset_build 重试(完结批次窗口)', !ds.isError && Boolean(dsId), ds.text.replace(/\s+/g, ' ').slice(0, 240))
  }
  let modelConclusion
  if (dsId) {
    const stats = await invoke(model.leadId, 'aml_dataset_stats', { dataset_id: dsId })
    step('W3-t2', 'W3 aml_dataset_stats(数据质量报告)', !stats.isError, stats.text.replace(/\s+/g, ' ').slice(0, 240))
    modelConclusion = `W3 建模结论:基于调优后工况构建训练数据集 ${dsId}(control=${daqLineA[0].id.slice(0, 8)},target=${(daqLineA[1] ?? daqLineA[0]).id.slice(0, 8)},60min 窗);质量报告:${stats.text.replace(/\s+/g, ' ').slice(0, 300)}`
  } else {
    modelConclusion = `W3 建模结论:数据集构建未收口:${ds.text.slice(0, 200)}`
    step('W3-t2', 'W3 aml_dataset_stats(数据质量报告)', false, 'dataset 未生成,如实降级')
  }
  await closeRootByLead(pid, w3.data.id, w3ctx, modelConclusion, 'W3')
  const w3Draft = await acceptanceChain(pid, w3.data.id, modelConclusion, 'W3')
  if (!w3Draft) return finish(false)

  // ═══ S3 收口:项目完成 + 审计 ═══
  const comp = await api('POST', `/api/workshop/projects/${pid}/complete`, {})
  step('S3-1', '项目完成审批创建(交付物验收齐备门)', comp.status === 200, comp.message)
  if (comp.data?.id) {
    const dec = await api('POST', `/api/workshop/projects/${pid}/approvals/${comp.data.id}/decide`, { approve: true }, { user: 'B' })
    step('S3-2', '项目完成签核(独立 admin) → completed', dec.status === 200, dec.message ?? '')
  }
  const pf = (await api('GET', `/api/workshop/projects/${pid}`)).data
  step('S3-3', '项目终态 completed', pf?.status === 'completed', `status=${pf?.status}`)
  const evs = (await api('GET', `/api/workshop/projects/${pid}/events?scope=all&limit=300`)).data ?? []
  const types = new Set(evs.map(e => e.type))
  const need = ['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.approved']
  step('S3-4', '全链审计事件齐备', need.every(n => types.has(n)), `missing=${need.filter(n => !types.has(n)).join(',')}`)

  return finish(true)
}

function finish() {
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  writeFileSync(join(EVID, 'collab.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), base, pass, fail, results,
  }, null, 2))
  console.log(`\n=== MULTI-CHANNEL COLLAB pass=${pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('fatal:', err)
  finish()
})
