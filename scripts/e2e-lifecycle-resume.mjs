#!/usr/bin/env node
/** 生命周期演示断点恢复:L7-3(agent 提交)→ L8 → L9 → L10,写回同一份 lifecycle-demo.json。 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-system-lifecycle')
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3995'
const EV_PATH = join(EVID, 'lifecycle-demo.json')
let results = existsSync(EV_PATH) ? JSON.parse(readFileSync(EV_PATH, 'utf8')).results ?? [] : []
const ok = (id, name, cond, detail = '') => {
  results = results.filter(r => r.id !== id)
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 280)}`}`)
}
const saveEv = () => writeFileSync(EV_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, code: -1, message: text.slice(0, 300), data: null }
  }
}
const token = (await api('POST', '/api/users/login', { email: 'e2e-landing@aw.local', password: 'E2E#2026' })).data?.token
if (!token) throw new Error('login failed')
const st = JSON.parse(readFileSync(join(REPO, '.e2e-home', 'lifecycle-state.json'), 'utf8'))
const proj = st.L4.projectId

// L7-3..L7-7:agent 提交 67bd18db(最终交付腿)
const draftId = process.env.LC_DRAFT_ID ?? '67bd18db-a3c5-46d4-9cf1-7385a28bf02a'
const cur0 = (await api('GET', `/api/workshop/projects/${proj}/results`, undefined, token)).data?.find(x => x.id === draftId)
console.log('resume draft:', cur0?.id?.slice(0, 8), cur0?.status)
if (cur0?.status === 'draft') {
  const w10wid = cur0.workItemId
  const det = await api('GET', `/api/workshop/projects/${proj}/observability/work-items/${w10wid}`, undefined, token)
  const taskId = (det.data?.attempts ?? [{}])[0]?.channelTaskId
  const obsRow = (await api('GET', `/api/workshop/projects/${proj}/observability`, undefined, token)).data?.workItems.find(w => w.id === w10wid)
  const instCh = obsRow?.instanceChannelId
  const ags = await api('GET', `/api/workshop/channels/${instCh}/agents`, undefined, token)
  const lead = (ags.data ?? []).find(a => a.role === 'lead')
  const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: lead.id, tool: 'project_submit_result',
    args: { result_id: draftId, task_id: taskId, summary: '生命周期演示:agent 提交路径', payload: { demo: 'lifecycle' } },
  }, token)
  const invText = String(inv.data?.result?.text ?? '')
  ok('L7-3', 'agent 提交(project_submit_result 带任务上下文)', invText === '' || /submitted|ok/.test(invText), invText.slice(0, 160))
}
const cur = (await api('GET', `/api/workshop/projects/${proj}/results`, undefined, token)).data?.find(x => x.id === draftId)
ok('L7-4', 'authorAgent 持证 + authorUser 为空(治理前提)', cur?.status === 'submitted' && !!cur?.authorAgentId && !cur?.authorUserId, `status=${cur?.status} authorAgent=${(cur?.authorAgentId ?? '').slice(0, 8)} authorUser=${cur?.authorUserId ?? 'None'}`)
if (cur?.status === 'submitted') {
  const rev = await api('POST', `/api/workshop/projects/${proj}/results/${draftId}/review`, { decision: 'reviewed', reason: 'L1 技术评审通过' }, token)
  ok('L7-5', 'L1 评审通过', rev.status === 200, rev.message)
}
const req = await api('POST', `/api/workshop/projects/${proj}/results/${draftId}/request-acceptance`, {}, token)
ok('L7-6', 'L2 验收申请(证据门重跑)', req.status === 200, req.message)
if (req.data?.id) {
  const appr = await api('POST', `/api/workshop/projects/${proj}/approvals/${req.data.id}/decide`, { approve: true }, token)
  ok('L7-7', 'L2 验收批准(owner 批 agent 交付,无自批冲突)', appr.status === 200, appr.message)
}
saveEv()

// L8:complete → continue(重开) → archive → terminate
const comp = await api('POST', `/api/workshop/projects/${proj}/complete`, {}, token)
ok('L8-1', '项目完成审批创建(交付物已验收门通过)', comp.status === 200, comp.message)
if (comp.data?.id) {
  const dec = await api('POST', `/api/workshop/projects/${proj}/approvals/${comp.data.id}/decide`, { approve: true }, token)
  ok('L8-2', '完成审批通过 → 项目 completed', dec.status === 200, dec.message)
}
const cont2 = await api('POST', `/api/workshop/projects/${proj}/continue`, { message: '生命周期演示:completed 项目补需求,自动重开' }, token)
ok('L8-3', '持续开发:completed 项目补需求自动重开(200)', cont2.status === 200, JSON.stringify({ reopened: cont2.data?.reopened }).slice(0, 120))
const arch = await api('POST', `/api/workshop/projects/${proj}/archive`, {}, token)
ok('L8-4', '归档(active → archived)', arch.status === 200, arch.message)
const chX = await api('POST', '/api/workshop/channels', { name: `终止演示频道 ${Date.now()}`, leadAgent: { name: '终止 Lead', harness: 'mock', config: {} } }, token)
const p2 = await api('POST', '/api/workshop/projects', { name: `终止演示项目2 ${Date.now()}`, objective: 'x', leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'legacy' }, token)
await api('POST', `/api/workshop/projects/${p2.data.id}/channels`, { channelId: chX.data.channelId, charter: 'x' }, token)
const d2 = await api('POST', `/api/workshop/projects/${p2.data.id}/deliverables`, { name: 'x.html', required: true, ownerChannelId: chX.data.channelId, acceptanceCriteria: ['artifact_present'] }, token)
const w2 = await api('POST', `/api/workshop/projects/${p2.data.id}/work-items`, { deliverableId: d2.data.id, channelId: chX.data.channelId, title: 'x', brief: 'x', execBudgetMinutes: 5 }, token)
await api('POST', `/api/workshop/projects/${p2.data.id}/activate`, {}, token)
const plan2 = await api('POST', `/api/workshop/projects/${p2.data.id}/plan/request-approval`, { version: 1, plan: { facts: ['terminate demo'] } }, token)
if (plan2.data?.id) await api('POST', `/api/workshop/projects/${p2.data.id}/approvals/${plan2.data.id}/decide`, { approve: true }, token)
await api('POST', `/api/workshop/projects/${p2.data.id}/work-items/${w2.data.id}/dispatch`, {}, token)
const term = await api('POST', `/api/workshop/projects/${p2.data.id}/terminate`, {}, token)
ok('L8-5', '运行中项目终止(级联终结)', term.status === 200, term.message)
const p2r = await api('GET', `/api/workshop/projects/${p2.data.id}`, undefined, token)
ok('L8-6', '终止后状态 canceled(终态)', p2r.data?.status === 'canceled', `status=${p2r.data?.status}`)
saveEv()

// L9:归档 continue 409
const cont3 = await api('POST', `/api/workshop/projects/${proj}/continue`, { message: '生命周期演示:归档后补充需求探针' }, token)
ok('L9-1', '归档项目 continue 被正确拒绝(409 治理)', cont3.status === 409 && !!cont3.code, JSON.stringify(cont3).slice(0, 180))
saveEv()

// L10:治理探针 + 审计覆盖
const stL4 = st.L4
const badRole = await api('POST', `/api/workshop/channels/${stL4.A.channelId}/agents`, { name: '坏角色', harness: 'mock', role: 'owner', config: {} }, token)
ok('L10-1', '非法角色 400', badRole.status === 400, JSON.stringify(badRole).slice(0, 140))
const anon = await fetch(`${BASE}/api/workshop/channels/${stL4.A.channelId}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
ok('L10-2', '匿名写 401', anon.status === 401, `status=${anon.status}`)
const events = await api('GET', `/api/workshop/projects/${proj}/events?scope=all&limit=200`, undefined, token)
const types = new Set((events.data ?? []).map(e => e.type))
const need = new Set(['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.approved', 'project.followup_requested'])
ok('L10-3', '审计事件覆盖演示项目全生命周期(派发/完成/提交/评审/批准/补需求)', [...need].every(n => types.has(n)), `missing=${[...need].filter(n => !types.has(n)).join(',')}`)
const tev = (await api('GET', `/api/workshop/projects/${p2.data.id}/events?scope=all&limit=100`, undefined, token)).data ?? []
ok('L10-4', '终止项目审计含 project.terminated(级联可审计)', tev.some(e => e.type === 'project.terminated'), `events=${tev.length}`)
saveEv()
const fail = results.filter(r => !r.pass).length
console.log(`\n=== LIFECYCLE DEMO(恢复) pass=${results.length - fail} fail=${fail} ===`)
process.exitCode = fail > 0 ? 1 : 0
