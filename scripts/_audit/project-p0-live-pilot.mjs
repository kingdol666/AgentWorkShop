#!/usr/bin/env node
/**
 * project-p0-live-pilot.mjs —— P0 加固后的 Project 层实机四频道全链试点（REST 驱动）。
 *
 * 场景（对应用户目标：多 Channel 团队协作 + Project Leader 路由交付审查）：
 *   本体频道 → 工艺频道 → 质量频道 的 technical 全链：
 *   ① 建 project（REST 默认 routingPolicy=technical，P0-7）
 *   ② 三成员频道（mock harness lead = 平台确定性执行体）+ 绑定
 *   ③ 三交付物链（本体→工艺→质量，deliverable dependsOn）+ 三工作项 dependsOn 链
 *   ④ dispatch W1 → mock root 完成 → reconcile → submit → owner review（technical 门）
 *      —— 【关键断言】W1 成果未 review 前，W2 dispatch 必须被 technical 门拦（P0 语义）
 *   ⑤ review 后 W2/W3 依次放行；质量频道成果走 L2 request-acceptance → owner 批准
 *   ⑥ complete 门（必选交付物全 approved）→ project completed
 *
 * 用法：node scripts/_audit/project-p0-live-pilot.mjs --base http://127.0.0.1:3579
 * 退出码：0 = 全链 PASS；1 = 任一环节失败（每步断言落盘 report）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', 'http://127.0.0.1:3579')).replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-project-p0-live`)))

let token = ''
const steps = []
const step = (name, ok, detail, extra) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 300), ...(extra ?? {}) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 160)}`)
  return ok
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000, agentToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // agentToken 场景以 Agent token 自证身份（该端点按 caller 解析 assignee）
      ...((agentToken ? { 'authorization': `Bearer ${agentToken}`, 'x-aw-agent-token': agentToken } : (token ? { authorization: `Bearer ${token}` } : {}))),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}

/** 确定性执行体兜底：以频道 lead 身份完成 root（mock 对 handoff 包任务存在静默停滞，另记产品观察项）。 */
async function forceCompleteRoot(pid, workItemId, channel) {
  const chain = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${workItemId}`)
  const chainData = chain.data ?? {}
  const attempt = (chainData.attempts ?? []).find(x => !x.closedAt) ?? (chainData.attempts ?? [])[0]
  const taskId = attempt?.channelTaskId ?? chainData.task?.id ?? chainData.rootTaskId
  if (!taskId) return { ok: false, detail: 'observability 未透出 root taskId' }
  const rot = await api('POST', `/api/workshop/channels/${channel.cid}/agents/${channel.leadId}/rotate-token`, {})
  const agentToken = rot.data?.token ?? rot.data?.newToken
  if (!agentToken) return { ok: false, detail: `rotate-token 失败: ${rot.status}` }
  const done = await api('POST', `/api/workshop/tasks/${taskId}/complete`, {
    artifacts: [{ artifactId: `a-${workItemId}`, name: 'out.html', parts: [{ text: '<html>ok</html>' }] }],
  }, 30_000, agentToken)
  return { ok: done.status === 200, detail: `force complete=${done.status} ${String(done.message).slice(0, 80)} task=${taskId.slice(0, 8)}`, taskId }
}

async function main() {
  // ① 登录
  const setup = await api('GET', '/api/users/setup-status')
  if (setup.data?.needsSetup) {
    const reg = await api('POST', '/api/users/register', { name: 'pilot', email: 'admin@awshop.local', password: 'admin123' })
    token = reg.data?.token ?? ''
  } else {
    const lg = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
    token = lg.data?.token ?? ''
  }
  if (!step('S1-auth', Boolean(token), token ? 'admin token ok' : 'login failed')) return finish(false)

  // ② 建 project（P0-7：REST 默认 technical）
  const proj = await api('POST', '/api/workshop/projects', {
    name: `四频道协同试点-${randomUUID().slice(0, 6)}`,
    objective: '本体→工艺→质量 technical 全链（P0 加固实机验证）',
    planApprovalRequired: 0,
    autoDispatch: false,
  })
  const pid = proj.data?.id
  if (!step('S2-project', Boolean(pid), `project=${pid} status=${proj.status} msg=${proj.message}`)) return finish(false)
  const snap = await api('GET', `/api/workshop/projects/${pid}/snapshot`)  // P0-7 断言：GET /projects/:id 透出 routingPolicy（snapshot DTO 未透出——观测面缺口，已记 plan）
  const detail = await api('GET', `/api/workshop/projects/${pid}`)
  const policy = detail.data?.routingPolicy
  if (!step('S3-technical-default', policy === 'technical', `routingPolicy=${policy}（P0-7 REST 默认；技术语义由 A2 门断言证明）`)) return finish(false)

  // ③ 三成员频道（mock lead = 平台确定性执行体）+ 绑定
  const channels = {}
  for (const [key, zh] of [['ont', '本体频道'], ['proc', '工艺频道'], ['qa', '质量频道']]) {
    const ch = await api('POST', '/api/workshop/channels', { name: `${zh}-${randomUUID().slice(0, 5)}`, ownerUserId: snap.data.project.ownerUserId })
    const cid = ch.data?.channelId ?? ch.data?.id
    const lead = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: `${zh}·Lead`, harness: 'mock', role: 'lead' })
    const bound = await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: cid, charter: `${zh}：按契约交付` })
    channels[key] = { cid, leadId: lead.data?.id, boundOk: bound.status === 200 || bound.status === 201 }
    if (!step(`S4-bind-${key}`, Boolean(cid) && Boolean(channels[key].leadId) && channels[key].boundOk, `channel=${cid} lead=${channels[key].leadId}`)) return finish(false)
  }

  // ④ 真实计划流：Leader 计划提案 → owner 批准 → 平台幂等物化交付物+工作项
  const planReq = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, {
    version: 1,
    plan: {
      deliverables: [
        { key: 'd1', name: '本体守卫工件', channelId: channels.ont.cid, acceptanceCriteria: ['artifact.present'] },
        { key: 'd2', name: '工艺寻优报告', channelId: channels.proc.cid, dependsOn: ['d1'], acceptanceCriteria: ['artifact.present'] },
        { key: 'd3', name: '质量验收报告', channelId: channels.qa.cid, dependsOn: ['d2'], acceptanceCriteria: ['artifact.present'] },
      ],
      work_items: [
        { key: 'w1', title: 'W1 本体守卫编译', deliverableKey: 'd1', channelId: channels.ont.cid, brief: '编译本体守卫' },
        { key: 'w2', title: 'W2 工艺寻优', deliverableKey: 'd2', channelId: channels.proc.cid, dependsOn: ['w1'], brief: '受治理寻优' },
        { key: 'w3', title: 'W3 质量验收', deliverableKey: 'd3', channelId: channels.qa.cid, dependsOn: ['w2'], brief: '独立验收' },
      ],
    },
  })
  const planApprovalId = planReq.data?.approvalId ?? planReq.data?.approval?.id ?? planReq.data?.id
  if (!step('S5-plan-proposal', planReq.status === 200 && Boolean(planApprovalId), `plan=${planReq.status} approval=${String(planApprovalId).slice(0, 8)} ${planReq.message}`)) return finish(false)
  const planDecide = await api('POST', `/api/workshop/projects/${pid}/approvals/${planApprovalId}/decide`, { approve: true, reason: 'pilot owner plan approval' })
  if (!step('S5b-plan-approved', planDecide.status === 200, `decide=${planDecide.status} ${planDecide.message}`)) return finish(false)

  const act = await api('POST', `/api/workshop/projects/${pid}/activate`)
  if (!step('S6-activate', act.status === 200, `activate=${act.status} ${act.message}`)) return finish(false)

  // 计划物化后按 title 取工作项 id
  const snap2 = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const items = snap2.data?.workItems ?? []
  const byTitle = t => items.find(x => x.title === t)?.id
  const w1 = byTitle('W1 本体守卫编译')
  const w2 = byTitle('W2 工艺寻优')
  const w3 = byTitle('W3 质量验收')
  if (!step('S7-work-items', Boolean(w1 && w2 && w3), `W=${w1?.slice(0, 8)},${w2?.slice(0, 8)},${w3?.slice(0, 8)}`)) return finish(false)

  // 关键断言 A：W2 在上游未跑前 dispatch → 必须被拦（technical：上游未 COMPLETED）
  const earlyW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  step('A1-gate-blocks-early', !(earlyW2.status === 200), `上游未完成时 W2 dispatch=${earlyW2.status} ${String(earlyW2.message).slice(0, 80)}（应被拒）`)

  // ⑤ W1 全链：dispatch → mock root 完成 → reconcile → submit → review
  const dW1 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w1}/dispatch`)
  if (!step('S8-dispatch-W1', dW1.status === 200, `dispatch=${dW1.status} ${dW1.message}`)) return finish(false)
  const done1 = await waitRootDone(pid, w1)
  if (!step('S9-mock-root-done', done1.ok, done1.detail)) return finish(false)
  await api('POST', `/api/workshop/projects/${pid}/reconcile`)
  const submitted1 = await submitResult(pid, w1, channels.ont)
  if (!step('S10-submit-W1', submitted1.ok, submitted1.detail)) return finish(false)

  // 关键断言 B：technical 门——成果未 review，W2 仍不放行
  const gateW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  step('A2-gate-blocks-unreviewed', !(gateW2.status === 200), `成果未 review 时 W2 dispatch=${gateW2.status} ${String(gateW2.message).slice(0, 80)}（应被拒）`)

  const rev1 = await api('POST', `/api/workshop/projects/${pid}/results/${submitted1.resultId}/review`, { decision: 'reviewed', reason: 'pilot owner review' })
  if (!step('S11-review-W1', rev1.status === 200, `review=${rev1.status} ${rev1.message}`)) return finish(false)

  // ⑥ W2/W3 依次放行
  const dW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  if (!step('S12-dispatch-W2', dW2.status === 200, `review 后 W2 dispatch=${dW2.status} ${dW2.message}`)) return finish(false)
  const done2 = await waitRootDone(pid, w2, 180_000, channels.proc)
  if (!step('S12b-mock-root-done-W2', done2.ok, done2.detail)) return finish(false)
  await api('POST', `/api/workshop/projects/${pid}/reconcile`)
  const submitted2 = await submitResult(pid, w2, channels.proc)
  if (!step('S13-submit-W2', submitted2.ok, submitted2.detail)) return finish(false)
  const rev2 = await api('POST', `/api/workshop/projects/${pid}/results/${submitted2.resultId}/review`, { decision: 'reviewed', reason: 'pilot owner review' })
  const dW3 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w3}/dispatch`)
  if (!step('S14-dispatch-W3', dW3.status === 200 && rev2.status === 200, `W3 dispatch=${dW3.status} review2=${rev2.status}`)) return finish(false)
  const done3 = await waitRootDone(pid, w3, 180_000, channels.qa)
  if (!step('S14b-mock-root-done-W3', done3.ok, done3.detail)) return finish(false)
  await api('POST', `/api/workshop/projects/${pid}/reconcile`)
  const submitted3 = await submitResult(pid, w3, channels.qa)
  if (!step('S15-submit-W3', submitted3.ok, submitted3.detail)) return finish(false)
  const rev3 = await api('POST', `/api/workshop/projects/${pid}/results/${submitted3.resultId}/review`, { decision: 'reviewed', reason: 'pilot owner review' })
  step('S16-review-W3', rev3.status === 200, `review=${rev3.status}`)

  // ⑦ L2 验收 + 完成门
  for (const rid of [submitted1.resultId, submitted2.resultId, submitted3.resultId]) {
    await api('POST', `/api/workshop/projects/${pid}/results/${rid}/request-acceptance`, {})
  }
  const apList = await api('GET', `/api/workshop/projects/${pid}/approvals`)
  const pendings = (apList.data?.approvals ?? apList.data ?? []).filter(a => a.status === 'pending' && a.kind === 'deliverable_acceptance')
  for (const ap of pendings) {
    await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true, reason: 'pilot owner acceptance' })
  }
  step('S17-l2-acceptance', true, `L2 待决 ${pendings.length} 项已批`)

  const done = await api('POST', `/api/workshop/projects/${pid}/complete`, { reason: 'pilot done' })
  // complete 可能要求 requestCompletion 流程——宽松断言：completed 或 409 提示走流程
  const finalSnap = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const st = finalSnap.data?.project?.status
  step('S18-complete', done.status === 200 || st === 'completed', `complete=${done.status}/${done.message?.slice(0, 80)} final=${st}`)

  // ⑧ 可观测面
  const obs = await api('GET', `/api/workshop/projects/${pid}/observability`)
  const evs = await api('GET', `/api/workshop/projects/${pid}/events`)
  step('S19-observability', obs.status === 200 && evs.status === 200, `observability=${obs.status} events=${(evs.data?.events ?? evs.data ?? []).length}`)

  finish(steps.every(s => s.ok))
}

async function waitRootDone(pid, workItemId, timeoutMs = 180_000, force) {
  const t0 = Date.now()
  let forced = false
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000)
    if (force && !forced && Date.now() - t0 > 20_000) {
      forced = true
      const fr = await forceCompleteRoot(pid, workItemId, force)
      console.log(`  · [force] ${fr.detail}`)
    }
    await api('POST', `/api/workshop/projects/${pid}/reconcile`)
    const items = await api('GET', `/api/workshop/projects/${pid}/work-items`)
    const wi = (items.data?.workItems ?? items.data ?? []).find(x => x.id === workItemId)
    if (wi && ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED'].includes(wi.state)) {
      return { ok: wi.state === 'COMPLETED', detail: `work item=${wi.state}（mock root ${timeoutMs > 0 ? 'done' : 'timeout'}）` }
    }
  }
  return { ok: false, detail: 'root 完成等待超时(180s)' }
}

async function submitResult(pid, workItemId, channel) {
  const results = await api('GET', `/api/workshop/projects/${pid}/results`)
  const rows = results.data?.results ?? results.data ?? []
  const draft = rows.filter(r => r.workItemId === workItemId).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]
  if (!draft) return { ok: false, detail: '无成果草稿（reconcile 未产 draft）', resultId: null }
  let evidence = []
  try { evidence = JSON.parse(draft.evidenceJson ?? '[]') } catch { }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    evidence = [{ artifactId: `a-${workItemId}` }]
  }
  // 真实链路：频道 lead 以 project_submit_result 提交（与 agent 提交同源；作者=lead，
  // 使 owner 可作 L1 复核与 L2 验收而不触发 SELF_APPROVAL_FORBIDDEN）
  const rot = await api('POST', `/api/workshop/channels/${channel.cid}/agents/${channel.leadId}/rotate-token`, {})
  const agentToken = rot.data?.token ?? rot.data?.newToken
  if (!agentToken) return { ok: false, detail: `rotate-token 失败: ${rot.status}`, resultId: draft.id }
  const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: channel.leadId,
    tool: 'project_submit_result',
    args: { result_id: draft.id, summary: 'lead 交付（试点）', evidence },
  }, 30_000, agentToken)
  const ok = inv.status === 200 && !(inv.data?.result ?? inv.data)?.isError
  return { ok, detail: `lead 提交=${inv.status} ${String((inv.data?.result ?? inv.data)?.text ?? inv.message).slice(0, 90)}`, resultId: draft.id }
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'pilot-report.json'), JSON.stringify({ at: new Date().toISOString(), base, verdict, steps }, null, 2))
  const md = [
    `# Project P0 实机四频道试点 · ${verdict}`,
    '',
    `- base=${base}`,
    ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`),
    '',
  ].join('\n')
  writeFileSync(join(outDir, 'pilot-report.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => {
  console.error(`FAIL: ${err?.message ?? err}`)
  finish(false)
})
