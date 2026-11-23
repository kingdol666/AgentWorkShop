/**
 * scripts/experiments/tsa2-phase-p.mjs —— 集成实测轮(round2) 阶段P:双 Project 实际作业。
 *
 *   P1 产线 Project:绑定产线频道,真实 leader 规划 → 计划批准(autoDispatch 按 dependsOn 派发)
 *      → W1 只读分析 → reconcile/submit → L1 → L2(第二账号,自批 403 负例) → project_complete → completed
 *   P2 落地页 Project(非产线):双 generic 频道(设计组 A + 实现组 B,均 omp/ustc)
 *      → 交付物依赖链 d2(dependsOn d1) → leader 规划 → 派发:W1(设计简报,频道A) → handoff → W2(HTML 落地页,频道B)
 *      → HTML 产物捕获 → 频道内分工取证 → 跨频道直连(send_cross_channel_message)取证 → L1/L2 → completed
 * 断点续跑:state 存 D:/tmp/aw-liv2-1119/phase-p-state.json。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-integrated-live-round')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-liv2-1119'
const BASE = 'http://127.0.0.1:3021'
const USTC = { provider: 'ustc', model: 'deepseek-flash', rpcMode: 'rpc' }

const tokens = JSON.parse(readFileSync(join(PRIVATE, 'aw-tokens.json'), 'utf8'))
const statePath = join(PRIVATE, 'phase-p-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const save = (name, obj) => { writeFileSync(join(EV, name), JSON.stringify(obj, null, 1)); writeFileSync(statePath, JSON.stringify(state, null, 1)) }
const log = (m) => console.log(`[phase-p2] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 60_000) {
  let r
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

async function sendChannelMsg(chId, toAgentId, text, requireReply = true) {
  const bodyPath = join(PRIVATE, 'p-msg.json')
  writeFileSync(bodyPath, JSON.stringify({ toAgentId, text, priority: 'immediate', requireReply }))
  const r = await fetch(BASE + `/api/workshop/channels/${chId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${tokens.admin}` },
    body: readFileSync(bodyPath),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await r.json().catch(() => ({ raw: 'parse-error' }))
  return { status: r.status, json }
}

async function messages(chId, limit = 60) {
  const j = (await api('GET', `/api/workshop/channels/${chId}/messages?limit=${limit}`, undefined, tokens.admin)).json?.data
  return Array.isArray(j) ? j : (j?.items ?? [])
}

async function agentsOf(chId) {
  return (await api('GET', `/api/workshop/channels/${chId}/agents`, undefined, tokens.admin)).json?.data ?? []
}

async function leadOf(chId) {
  return (await agentsOf(chId)).find(a => a.role === 'lead')
}

async function patchAgentsUstc(chId) {
  for (const a of await agentsOf(chId)) {
    await api('PATCH', `/api/workshop/channels/${chId}/agents/${a.id}`, { config: { ...(a.config ?? {}), ...USTC } }, tokens.admin)
  }
  await api('PATCH', `/api/workshop/channels/${chId}`, { llm: { ...USTC, effort: 'max' } }, tokens.admin)
}

async function waitPlanPending(pid, timeoutMs = 18 * 60_000) {
  const t0 = Date.now()
  let woke = false
  for (;;) {
    const obs = (await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, tokens.admin)).json?.data
    const st = obs?.plan?.status ?? obs?.status
    if (st && /pending_approval|awaiting/i.test(String(st))) return { obs, proposed: true }
    if (st && /approved|executing|planned/i.test(String(st))) return { obs, proposed: true }
    if (!woke && Date.now() - t0 > 6 * 60_000) {
      woke = true
      await api('POST', `/api/workshop/projects/${pid}/continue`, { message: '请启动项目规划:审视项目目标、频道分工与交付物,提出计划(plan)供批准。' }, tokens.admin)
      save('phase-p2-plan-wake.json', { pid, at: new Date().toISOString() })
    }
    if (Date.now() - t0 > timeoutMs) return { obs, proposed: false }
    await sleep(20_000)
  }
}

async function decidePlan(pid) {
  return api('POST', `/api/workshop/projects/${pid}/plan/decide`, { approved: true, comment: '目标与分工合理,批准计划' }, tokens.admin)
}

async function waitWorkItems(pid, minCount = 1, timeoutMs = 10 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const j = (await api('GET', `/api/workshop/projects/${pid}/work-items`, undefined, tokens.admin)).json?.data
    const items = j?.items ?? j ?? []
    if (items.length >= minCount) return items
    if (Date.now() - t0 > timeoutMs) return items
    await sleep(15_000)
  }
}

async function waitItemDone(pid, wid, timeoutMs = 45 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const j = (await api('GET', `/api/workshop/projects/${pid}/work-items/${wid}`, undefined, tokens.admin)).json?.data
    const wi = j?.workItem ?? j
    const st = wi?.state ?? wi?.status ?? j?.status
    if (st && /completed|failed|canceled|cancelled/i.test(String(st))) return { ...wi, status: st }
    if (Date.now() - t0 > timeoutMs) return { status: st ?? 'timeout', timeout: true }
    await sleep(30_000)
  }
}

async function acceptanceChain(pid, label) {
  // reconcile → submit(admin) → L1 → L2(第二账号,自批负例先取证) → complete(第二账号裁决)
  const rec = await api('POST', `/api/workshop/projects/${pid}/reconcile`, {}, tokens.admin)
  save(`phase-p2-${label}-reconcile.json`, rec.json)
  const resList = (await api('GET', `/api/workshop/projects/${pid}/results`, undefined, tokens.admin)).json?.data
  const results = resList?.items ?? resList ?? []
  save(`phase-p2-${label}-results.json`, results.map(r => ({ id: r.id, workItemId: r.workItemId, deliverableId: r.deliverableId, status: r.status, summaryHead: String(r.summary ?? r.content ?? '').slice(0, 160) })))
  const rid = results[0]?.id
  if (!rid) throw new Error(`${label}: 无成果可提交`)
  const sub = await api('POST', `/api/workshop/projects/${pid}/results/${rid}/submit`, {}, tokens.admin)
  save(`phase-p2-${label}-submit.json`, { status: sub.status, body: sub.json })
  // L1:admin 先试 API 复核;若 403(自审禁),转由 leader 在 office channel 执行 project_review_result
  let l1 = await api('POST', `/api/workshop/projects/${pid}/results/${rid}/review`, { decision: 'reviewed', reason: '技术复核通过:证据完整,结论可用' }, tokens.admin)
  save(`phase-p2-${label}-l1-api.json`, { status: l1.status, body: l1.json })
  if (l1.status !== 200) {
    const obs = (await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, tokens.admin)).json?.data
    const officeCh = obs?.project?.officeChannelId
    if (officeCh) {
      const lead = await leadOf(officeCh)
      await sendChannelMsg(officeCh, lead?.id, `请对成果 ${rid} 执行 L1 技术评审(project_review_result,decision=reviewed),理由:证据完整、结论可用。`)
      await sleep(60_000)
    }
    l1 = await api('POST', `/api/workshop/projects/${pid}/results/${rid}/review`, { decision: 'reviewed', reason: 'leader 复核:证据完整' }, tokens.admin)
    save(`phase-p2-${label}-l1-fallback.json`, { status: l1.status, body: l1.json })
    if (l1.status !== 200) throw new Error(`${label}: L1 未过(${l1.status})`)
  }
  // 自批负例:owner 对 deliverable_acceptance 卡裁决(预期 403)
  const acc = await api('POST', `/api/workshop/projects/${pid}/results/${rid}/request-acceptance`, {}, tokens.admin)
  save(`phase-p2-${label}-request-acceptance.json`, { status: acc.status, body: acc.json })
  let card = null
  const t0 = Date.now()
  for (;;) {
    const ap = (await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, tokens.admin)).json?.data
    card = (ap?.items ?? ap ?? []).find(x => x.kind === 'deliverable_acceptance' && x.status === 'pending')
    if (card || Date.now() - t0 > 90_000) break
    await sleep(10_000)
  }
  if (card) {
    const selfDecide = await api('POST', `/api/workshop/projects/${pid}/approvals/${card.id}/decide`, { approve: true, reason: 'owner 自批(负例)' }, tokens.admin)
    save(`phase-p2-${label}-self-approval-negative.json`, { status: selfDecide.status, body: selfDecide.json })
    const l2 = await api('POST', `/api/workshop/projects/${pid}/approvals/${card.id}/decide`, { approve: true, reason: '第二账号验收:交付物完整合规' }, tokens.second)
    save(`phase-p2-${label}-l2.json`, { status: l2.status, body: l2.json })
    if (l2.status !== 200) throw new Error(`${label}: L2 未过(${l2.status})`)
  }
  // 完成
  const comp = await api('POST', `/api/workshop/projects/${pid}/complete`, {}, tokens.admin)
  save(`phase-p2-${label}-complete-request.json`, { status: comp.status, body: comp.json })
  const t1 = Date.now()
  let compCard = null
  for (;;) {
    const ap = (await api('GET', `/api/workshop/projects/${pid}/approvals`, undefined, tokens.admin)).json?.data
    compCard = (ap?.items ?? ap ?? []).find(x => x.kind === 'project_complete' && x.status === 'pending')
    if (compCard || Date.now() - t1 > 90_000) break
    await sleep(10_000)
  }
  if (!compCard) throw new Error(`${label}: 无 project_complete 审批卡`)
  const compDecide = await api('POST', `/api/workshop/projects/${pid}/approvals/${compCard.id}/decide`, { approve: true, reason: '目标达成,准予结项' }, tokens.second)
  save(`phase-p2-${label}-complete-decide.json`, { status: compDecide.status, body: compDecide.json })
  const obs = (await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, tokens.admin)).json?.data
  save(`phase-p2-${label}-final-observability.json`, { status: obs?.project?.status ?? obs?.status, plan: obs?.plan?.status ?? null })
  return obs?.project?.status ?? obs?.status
}

// =========== P1 产线 Project ===========
async function p1() {
  const onboard = JSON.parse(readFileSync(join(PRIVATE, 'onboard-result.json'), 'utf8'))
  const lineCh = onboard.channelId
  if (!state.p1) {
    log('P1 创建产线 Project…')
    const proj = await api('POST', '/api/workshop/projects', {
      name: '注塑克重班次达标-20261119-LIV2',
      objective: '制品克重回稳定成 32.50±0.35g 目标带:完成 R1/R2 两步小步实效分析(只读),确认当前工况与目标的差距,产出班次中期结论',
      leaderHarness: 'omp',
      mode: 'supervised',
      routingPolicy: 'technical',
      autoDispatch: true,
    }, tokens.admin)
    const pid = proj.json?.data?.id ?? proj.json?.data?.project?.id
    if (!pid) throw new Error(`P1 Project 创建失败: ${JSON.stringify(proj.json).slice(0, 250)}`)
    await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: lineCh, charter: '产线数据分析与治理执行(配方审批链);本工作项只读,禁止一切工业写' }, tokens.admin)
    const d1 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'shift-mid-analysis', required: true, ownerChannelId: lineCh, acceptanceCriteria: ['artifact_present'] }, tokens.admin)
    state.p1 = { pid }
    save('phase-p2-p1-project.json', { pid, d1: d1.json?.data?.id, activate: (await api('POST', `/api/workshop/projects/${pid}/activate`, {}, tokens.admin)).status })
    log(`P1 Project=${pid} 已激活,等待 leader 规划…`)
    const { obs, proposed } = await waitPlanPending(pid, 15 * 60_000)
    save('phase-p2-p1-plan-observability.json', { proposed, plan: obs?.plan ?? null })
    if (!proposed) throw new Error('P1 leader 15min 未出计划')
    const dec = await decidePlan(pid)
    save('phase-p2-p1-plan-decide.json', { status: dec.status, body: dec.json })
    if (dec.status !== 200) throw new Error(`P1 计划批准失败: ${JSON.stringify(dec.json).slice(0, 200)}`)
  }
  const pid = state.p1.pid
  log('P1 等待工作项物化…')
  const items = await waitWorkItems(pid, 1, 10 * 60_000)
  if (!items.length) throw new Error('P1 10min 无工作项物化')
  save('phase-p2-p1-workitems.json', items.map(w => ({ id: w.id, title: w.title, status: w.status, channelId: w.channelId, dependsOn: w.dependsOn ?? null })))
  const wid = items[0].id
  log(`P1 等待工作项 ${wid} 完成(最长45min)…`)
  const done = await waitItemDone(pid, wid, 45 * 60_000)
  save('phase-p2-p1-item-done.json', { id: wid, status: done?.status ?? done, resultHead: String(done?.result?.summary ?? '').slice(0, 300) })
  state.p1.done = done?.status
  log(`P1 工作项终态=${done?.status};进入验收链…`)
  const finalStatus = await acceptanceChain(pid, 'p1')
  state.p1.final = finalStatus
  log(`P1 项目终态=${finalStatus}`)
}

// =========== P2 落地页 Project(双频道协同) ===========
async function p2() {
  if (!state.p2?.chA) {
    log('P2 创建设计组频道 A…')
    const chA = await api('POST', '/api/workshop/channels', {
      name: '产品落地页-设计组-20261119',
      channelMode: 'generic',
      scenarioPrompt: '你是产品官网落地页项目的设计组。产出:信息结构、逐屏文案(标题/副标题/特性/案例/CTA)、视觉规范(配色/字体/间距)。结论要可直接交给前端实现。',
      leadAgent: { name: '设计组长', harness: 'omp', config: USTC },
    }, tokens.admin)
    const aId = chA.json?.data?.channelId ?? chA.json?.data?.id
    if (!aId) throw new Error(`P2 频道A创建失败: ${JSON.stringify(chA.json).slice(0, 200)}`)
    await api('POST', `/api/workshop/channels/${aId}/agents`, { name: '品牌文案', harness: 'omp', role: 'worker', config: USTC }, tokens.admin)
    await patchAgentsUstc(aId)
    state.p2 = { ...(state.p2 ?? {}), chA: aId }
    log('P2 创建实现组频道 B…')
    const chB = await api('POST', '/api/workshop/channels', {
      name: '产品落地页-实现组-20261119',
      channelMode: 'generic',
      scenarioPrompt: '你是产品官网落地页项目的实现组。交付:单文件 index.html(内嵌 CSS/JS,移动端适配,语义化标签)。以设计组简报为唯一需求来源。',
      leadAgent: { name: '实现组长', harness: 'omp', config: USTC },
    }, tokens.admin)
    const bId = chB.json?.data?.channelId ?? chB.json?.data?.id
    if (!bId) throw new Error(`P2 频道B创建失败: ${JSON.stringify(chB.json).slice(0, 200)}`)
    await api('POST', `/api/workshop/channels/${bId}/agents`, { name: '前端工程', harness: 'omp', role: 'worker', config: USTC }, tokens.admin)
    await patchAgentsUstc(bId)
    state.p2.chB = bId
    save('phase-p2-p2-channels.json', { chA: aId, chB: bId })
  }
  const { chA, chB } = state.p2
  if (!state.p2.pid) {
    log('P2 创建落地页 Project…')
    const proj = await api('POST', '/api/workshop/projects', {
      name: '产品官网落地页开发-20261119',
      objective: '交付可直接部署的产品落地页:单文件 HTML(内嵌 CSS/JS),含首屏 Hero/产品特性/场景案例/定价或行动号召/页脚,移动端适配;设计先行,实现以设计简报为输入',
      leaderHarness: 'omp',
      mode: 'supervised',
      routingPolicy: 'technical',
      autoDispatch: true,
    }, tokens.admin)
    const pid = proj.json?.data?.id ?? proj.json?.data?.project?.id
    if (!pid) throw new Error(`P2 Project 创建失败: ${JSON.stringify(proj.json).slice(0, 250)}`)
    await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: chA, charter: '设计组:产出落地页设计简报(结构/文案/视觉规范)' }, tokens.admin)
    await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: chB, charter: '实现组:依据设计简报产出单文件 HTML 落地页' }, tokens.admin)
    const d1 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'design-brief', required: true, ownerChannelId: chA, acceptanceCriteria: ['artifact_present'] }, tokens.admin)
    const d2 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: 'landing-page', required: true, ownerChannelId: chB, dependsOn: [d1.json?.data?.id].filter(Boolean), acceptanceCriteria: ['artifact_present'] }, tokens.admin)
    const act = await api('POST', `/api/workshop/projects/${pid}/activate`, {}, tokens.admin)
    state.p2.pid = pid
    state.p2.d1 = d1.json?.data?.id
    state.p2.d2 = d2.json?.data?.id
    save('phase-p2-p2-project.json', { pid, d1: state.p2.d1, d2: state.p2.d2, activate: act.status })
    log(`P2 Project=${pid} 已激活,等待 leader 规划…`)
    const { obs, proposed } = await waitPlanPending(pid, 15 * 60_000)
    save('phase-p2-p2-plan-observability.json', { proposed, plan: obs?.plan ?? null })
    if (!proposed) throw new Error('P2 leader 15min 未出计划')
    const dec = await decidePlan(pid)
    save('phase-p2-p2-plan-decide.json', { status: dec.status, body: dec.json })
    if (dec.status !== 200) throw new Error(`P2 计划批准失败: ${JSON.stringify(dec.json).slice(0, 200)}`)
    state.p2.pid = pid
  }
  const pid = state.p2.pid
  log('P2 等待工作项物化(W1 设计/W2 实现)…')
  const allItems = await waitWorkItems(pid, 2, 12 * 60_000)
  const items = allItems.filter(w => String(w.state ?? w.status ?? '').toUpperCase() !== 'CANCELED')
  if (items.length < 2) throw new Error(`P2 工作项物化不足(${items.length}/${allItems.length})`)
  // 依赖守卫:若 W2(landing-page 交付物)未挂 dependsOn,补上(W1 → W2)
  const w1 = items.find(w => w.deliverableId === state.p2.d1) ?? items[0]
  const w2 = items.find(w => w.deliverableId === state.p2.d2 && w.id !== w1.id) ?? items.find(w => w.id !== w1.id)
  if (w2 && !(w2.dependsOn ?? []).includes(w1.id)) {
    const patch = await api('PATCH', `/api/workshop/projects/${pid}/work-items/${w2.id}`, { dependsOn: [w1.id] }, tokens.admin)
    save('phase-p2-p2-dependency-guard.json', { patched: patch.status, w2: w2.id, dependsOn: [w1.id] })
  }
  save('phase-p2-p2-workitems.json', items.map(w => ({ id: w.id, title: w.title, deliverableId: w.deliverableId, channelId: w.channelId, dependsOn: w.dependsOn ?? null, status: w.status })))
  log(`P2 W1(${w1.id}) 等待完成…`)
  const done1 = await waitItemDone(pid, w1.id, 40 * 60_000)
  save('phase-p2-p2-w1-done.json', { id: w1.id, status: done1?.status ?? done1 })
  // 频道内分工取证:频道 A lead→worker 派工消息
  const msgsA = await messages(chA)
  const leadAId = (await leadOf(chA))?.id
  const dispatchMsg = msgsA.find(m => m.toAgentId && (m.parts ?? []).some(p => String(p.text ?? '').length > 20))
  const workerReply = msgsA.find(m => m.fromAgentId && m.fromAgentId !== leadAId && (m.parts ?? []).some(p => String(p.text ?? '').length > 30))
  save('phase-p2-p2-intra-channel.json', {
    channelA: chA,
    dispatch: dispatchMsg ? { to: dispatchMsg.toAgentId, at: dispatchMsg.createdAt, text: (dispatchMsg.parts ?? []).map(p => p.text ?? '').join(' ').slice(0, 300) } : null,
    workerReply: workerReply ? { from: workerReply.fromAgentId, at: workerReply.createdAt, text: (workerReply.parts ?? []).map(p => p.text ?? '').join(' ').slice(0, 300) } : null,
  })
  log(`P2 W2(${w2.id}) 等待完成(最长50min)…`)
  const done2 = await waitItemDone(pid, w2.id, 50 * 60_000)
  save('phase-p2-p2-w2-done.json', { id: w2.id, status: done2?.status ?? done2 })
  if (String(done2?.status ?? done2) !== 'completed') throw new Error(`P2 W2 未完成: ${JSON.stringify(done2).slice(0, 200)}`)

  // HTML 产物捕获(频道 B 消息面 + 成果面)
  const msgsB = await messages(chB, 80)
  let best = { len: 0, html: '', src: '' }
  for (const m of msgsB) {
    for (const p of (m.parts ?? [])) {
      const t = String(p.text ?? '')
      if (/<!DOCTYPE html|<html[\s>]/i.test(t) && t.length > best.len) best = { len: t.length, html: t, src: `channelB-message:${m.id}` }
    }
  }
  const resList = (await api('GET', `/api/workshop/projects/${pid}/results`, undefined, tokens.admin)).json?.data
  for (const r of (resList?.items ?? resList ?? [])) {
    const t = String(r.summary ?? r.content ?? '')
    if (/<!DOCTYPE html|<html[\s>]/i.test(t) && t.length > best.len) best = { len: t.length, html: t, src: `result:${r.id}` }
  }
  if (!best.html) throw new Error('P2 未捕获到 HTML 产物')
  writeFileSync(join(EV, 'phase-p2-p2-landing-page.html'), best.html)
  save('phase-p2-p2-html-capture.json', { src: best.src, bytes: best.len, hasDoctype: /<!DOCTYPE html/i.test(best.html), sections: ['hero', '特性', '案例', 'cta', 'footer'].map(s => ({ s, hit: new RegExp(s, 'i').test(best.html) })) })
  state.p2.htmlBytes = best.len

  // 跨频道直连取证:实现组 → 设计组(send_cross_channel_message)
  log('P2 跨频道直连取证…')
  const leadB = await leadOf(chB)
  const before = (await messages(chA, 80)).length
  const sent = await sendChannelMsg(chB, leadB?.id, '请用 send_cross_channel_message 把「落地页已实现,请设计组复核移动端断点与文案标点」这条上线说明直接发给设计组频道,然后用 poll_messages 确认送达情况,回报发送与确认结果。')
  save('phase-p2-p2-cross-send.json', { status: sent.status })
  const t0 = Date.now()
  let arrived = null
  for (;;) {
    const now = await messages(chA, 80)
    if (now.length > before) {
      arrived = now.slice(before).find(m => (m.parts ?? []).some(p => String(p.text ?? '').includes('落地页') || String(p.text ?? '').length > 10)) ?? now[now.length - 1]
      break
    }
    if (Date.now() - t0 > 10 * 60_000) break
    await sleep(20_000)
  }
  save('phase-p2-p2-cross-arrive.json', arrived ? { at: arrived.createdAt, from: arrived.fromAgentId, crossChannel: arrived.crossChannelId ?? arrived.metadata ?? null, text: (arrived.parts ?? []).map(p => p.text ?? '').join(' ').slice(0, 400) } : { timeout: true })
  state.p2.crossArrived = Boolean(arrived)

  log('P2 进入验收链…')
  const finalStatus = await acceptanceChain(pid, 'p2')
  state.p2.final = finalStatus
  log(`P2 项目终态=${finalStatus}`)
}

async function main() {
  if (!existsSync(join(PRIVATE, 'onboard-result.json'))) throw new Error('缺 onboard-result.json(先完成产线接入)')
  if (!state.p1?.final && !process.env.TSA2_SKIP_P1) await p1()
  if (!state.p2?.final) await p2()
  console.log('PHASE-P-RESULT ' + JSON.stringify({ ok: true, p1: state.p1?.final, p2: state.p2?.final, htmlBytes: state.p2?.htmlBytes, crossArrived: state.p2?.crossArrived }))
}

await main().catch((e) => {
  console.error(`[phase-p2] FAILED: ${e.message}`)
  save('phase-p2-ABORT.json', { error: e.message, at: new Date().toISOString(), state })
  process.exitCode = 1
})
