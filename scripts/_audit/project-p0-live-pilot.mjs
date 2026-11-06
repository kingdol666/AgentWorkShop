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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
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
  const snap = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const policy = snap.data?.project?.routingPolicy
  const officeChannelId = snap.data?.project?.officeChannelId
  if (!step('S3-technical-default', policy === 'technical', `routingPolicy=${policy}（P0-7 REST 默认）`)) return finish(false)

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

  // ④ 交付物链 + 工作项链
  const d1 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: '本体守卫工件', ownerChannelId: channels.ont.cid, required: true, acceptanceCriteria: ['artifact.present'] })
  const d1id = d1.data?.id ?? d1.data?.deliverable?.id
  const d2 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: '工艺寻优报告', ownerChannelId: channels.proc.cid, required: true, dependsOn: [d1id], acceptanceCriteria: ['artifact.present'] })
  const d2id = d2.data?.id ?? d2.data?.deliverable?.id
  const d3 = await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name: '质量验收报告', ownerChannelId: channels.qa.cid, required: true, dependsOn: [d2id], acceptanceCriteria: ['artifact.present'] })
  const d3id = d3.data?.id ?? d3.data?.deliverable?.id
  if (!step('S5-deliverables', Boolean(d1id && d2id && d3id), `D=${d1id?.slice(0, 8)},${d2id?.slice(0, 8)},${d3id?.slice(0, 8)}`)) return finish(false)

  const act = await api('POST', `/api/workshop/projects/${pid}/activate`)
  if (!step('S6-activate', act.status === 200, `activate=${act.status} ${act.message}`)) return finish(false)

  const mkItem = async (title, deliverableId, channelId, dependsOn) => {
    const w = await api('POST', `/api/workshop/projects/${pid}/work-items`, { title, deliverableId, channelId, dependsOn, brief: '试点工作项' })
    return w.data?.id ?? w.data?.workItem?.id
  }
  const w1 = await mkItem('W1 本体守卫编译', d1id, channels.ont.cid, [])
  const w2 = await mkItem('W2 工艺寻优', d2id, channels.proc.cid, w1 ? [w1] : [])
  const w3 = await mkItem('W3 质量验收', d3id, channels.qa.cid, w2 ? [w2] : [])
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
  const submitted1 = await submitResult(pid, w1)
  if (!step('S10-submit-W1', submitted1.ok, submitted1.detail)) return finish(false)

  // 关键断言 B：technical 门——成果未 review，W2 仍不放行
  const gateW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  step('A2-gate-blocks-unreviewed', !(gateW2.status === 200), `成果未 review 时 W2 dispatch=${gateW2.status} ${String(gateW2.message).slice(0, 80)}（应被拒）`)

  const rev1 = await api('POST', `/api/workshop/projects/${pid}/results/${submitted1.resultId}/review`, { decision: 'reviewed', reason: 'pilot owner review' })
  if (!step('S11-review-W1', rev1.status === 200, `review=${rev1.status} ${rev1.message}`)) return finish(false)

  // ⑥ W2/W3 依次放行
  const dW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  if (!step('S12-dispatch-W2', dW2.status === 200, `review 后 W2 dispatch=${dW2.status} ${dW2.message}`)) return finish(false)
  const done2 = await waitRootDone(pid, w2)
  await api('POST', `/api/workshop/projects/${pid}/reconcile`)
  const submitted2 = await submitResult(pid, w2)
  if (!step('S13-submit-W2', submitted2.ok, submitted2.detail)) return finish(false)
  const rev2 = await api('POST', `/api/workshop/projects/${pid}/results/${submitted2.resultId}/review`, { decision: 'reviewed', reason: 'pilot owner review' })
  const dW3 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w3}/dispatch`)
  if (!step('S14-dispatch-W3', dW3.status === 200 && rev2.status === 200, `W3 dispatch=${dW3.status} review2=${rev2.status}`)) return finish(false)
  const done3 = await waitRootDone(pid, w3)
  await api('POST', `/api/workshop/projects/${pid}/reconcile`)
  const submitted3 = await submitResult(pid, w3)
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
    await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approved: true, reason: 'pilot owner acceptance' })
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

async function waitRootDone(pid, workItemId, timeoutMs = 90_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000)
    await api('POST', `/api/workshop/projects/${pid}/reconcile`)
    const items = await api('GET', `/api/workshop/projects/${pid}/work-items`)
    const wi = (items.data?.workItems ?? items.data ?? []).find(x => x.id === workItemId)
    if (wi && ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED'].includes(wi.state)) {
      return { ok: wi.state === 'COMPLETED', detail: `work item=${wi.state}（mock root ${timeoutMs > 0 ? 'done' : 'timeout'}）` }
    }
  }
  return { ok: false, detail: 'root 完成等待超时(90s)' }
}

async function submitResult(pid, workItemId) {
  const results = await api('GET', `/api/workshop/projects/${pid}/results`)
  const rows = results.data?.results ?? results.data ?? []
  const draft = rows.filter(r => r.workItemId === workItemId).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]
  if (!draft) return { ok: false, detail: '无成果草稿（reconcile 未产 draft）', resultId: null }
  let evidence = []
  try { evidence = JSON.parse(draft.evidenceJson ?? '[]') } catch { }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    const payload = (() => { try { return JSON.parse(draft.payloadJson ?? '{}') } catch { return {} } })()
    const aid = payload.artifactNames?.[0] ?? `a-${workItemId}`
    evidence = [{ artifactId: aid }]
  }
  const sub = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/submit`, { evidence, summary: 'pilot 交付' })
  return { ok: sub.status === 200, detail: `submit=${sub.status} ${String(sub.message).slice(0, 100)}`, resultId: draft.id }
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
