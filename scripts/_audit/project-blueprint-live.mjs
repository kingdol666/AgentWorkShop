#!/usr/bin/env node
/**
 * project-blueprint-live.mjs —— P1-1 蓝图模板实机验收（REST 驱动）。
 *
 * 链路：
 *   ① 命名保存蓝图（三频道 本体→工艺→质量 + technical + 计划免批）
 *   ② GET 清单可见
 *   ③ POST /projects/instantiate {template} → 一键新开会话（active + 工作项物化）
 *   ④ 全链：W1 dispatch → mock root → reconcile → lead 提交 → owner review
 *      → W2/W3 依次放行（technical 门：未 review 派发必须 409）
 *   ⑤ L2 验收 → complete
 *
 * 用法：node scripts/_audit/project-blueprint-live.mjs --base http://127.0.0.1:3579
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3579').replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-blueprint-live`)))

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 300) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 160)}`)
  return ok
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000, agentToken) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...((agentToken ? { authorization: `Bearer ${agentToken}`, 'x-aw-agent-token': agentToken } : (token ? { authorization: `Bearer ${token}` } : {}))),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? '' }
}

async function leadTokenFor(cid, leadId) {
  const rot = await api('POST', `/api/workshop/channels/${cid}/agents/${leadId}/rotate-token`, {})
  return rot.data?.token ?? rot.data?.newToken ?? ''
}

async function main() {
  const setup = await api('GET', '/api/users/setup-status')
  if (setup.data?.needsSetup) {
    const reg = await api('POST', '/api/users/register', { name: 'pilot', email: 'admin@awshop.local', password: 'admin123' })
    token = reg.data?.token ?? ''
  } else {
    const lg = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
    token = lg.data?.token ?? ''
  }
  if (!step('S1-auth', Boolean(token), 'admin token ok')) return finish(false)

  // ① 命名保存蓝图
  const tplName = `四频道协同模板-${randomUUID().slice(0, 5)}`
  const save = await api('POST', '/api/workshop/project-blueprints', {
    name: tplName,
    blueprint: {
      name: '四频道协同会话',
      objective: '本体→工艺→质量 technical 协作（蓝图实机验收）',
      routingPolicy: 'technical',
      planApprovalRequired: false,
      channels: [
        { key: 'ont', name: '本体频道', charter: '编译守卫', leadHarness: 'mock' },
        { key: 'proc', name: '工艺频道', charter: '寻优执行', leadHarness: 'mock' },
        { key: 'qa', name: '质量频道', charter: '独立验收', leadHarness: 'mock' },
      ],
      plan: {
        deliverables: [
          { key: 'd1', name: '守卫工件', channelKey: 'ont', acceptanceCriteria: ['artifact.present'] },
          { key: 'd2', name: '寻优报告', channelKey: 'proc', dependsOn: ['d1'] },
          { key: 'd3', name: '验收报告', channelKey: 'qa', dependsOn: ['d2'] },
        ],
        work_items: [
          { key: 'w1', title: 'W1 守卫编译', deliverableKey: 'd1', channelKey: 'ont' },
          { key: 'w2', title: 'W2 工艺寻优', deliverableKey: 'd2', channelKey: 'proc', dependsOn: ['w1'] },
          { key: 'w3', title: 'W3 质量验收', deliverableKey: 'd3', channelKey: 'qa', dependsOn: ['w2'] },
        ],
      },
    },
  })
  if (!step('S2-blueprint-save', save.status === 200, `save=${save.status} name=${tplName} ${save.message}`)) return finish(false)
  const list = await api('GET', '/api/workshop/project-blueprints')
  step('S3-blueprint-listed', (list.data ?? []).some(t => t.name === tplName), `清单含 ${tplName}`)

  // ③ 一键新开会话
  const inst = await api('POST', '/api/workshop/projects/instantiate', { template: tplName, nameOverride: '蓝图实机会话' })
  const pid = inst.data?.projectId
  const okInst = inst.status === 200 && inst.data?.status === 'active' && (inst.data?.workItemIds ?? []).length === 3
  if (!step('S4-instantiate', okInst, `project=${pid} status=${inst.data?.status} workItems=${(inst.data?.workItemIds ?? []).length} ${inst.message}`)) return finish(false)
  const detail = await api('GET', `/api/workshop/projects/${pid}`)
  step('S5-technical-policy', detail.data?.routingPolicy === 'technical', `routingPolicy=${detail.data?.routingPolicy}`)

  const snap = await api('GET', `/api/workshop/projects/${pid}/snapshot`)
  const items = snap.data?.workItems ?? []
  const byTitle = t => items.find(x => x.title === t)?.id
  const w1 = byTitle('W1 守卫编译')
  const w2 = byTitle('W2 工艺寻优')
  const w3 = byTitle('W3 质量验收')
  const cidByKey = inst.data?.channelIdByKey ?? {}
  const leads = {}
  for (const [key, cid] of Object.entries(cidByKey)) {
    const agents = await api('GET', `/api/workshop/channels/${cid}/agents`)
    const lead = (agents.data ?? []).find(a => a.role === 'lead')
    leads[key] = { cid, leadId: lead?.id }
  }

  // ④ W1 全链
  const dW1 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w1}/dispatch`)
  if (!step('S6-dispatch-W1', dW1.status === 200, `dispatch=${dW1.status} ${dW1.message}`)) return finish(false)
  const done1 = await waitRootDone(pid, w1)
  if (!step('S7-root-done-W1', done1.ok, done1.detail)) return finish(false)
  const sub1 = await submitAsLead(pid, w1, leads.ont)
  if (!step('S8-submit-W1', sub1.ok, sub1.detail)) return finish(false)
  const gateW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  step('A1-gate-unreviewed', !(gateW2.status === 200), `未 review 时 W2 dispatch=${gateW2.status} ${String(gateW2.message).slice(0, 90)}（应被拒）`)
  const rev1 = await api('POST', `/api/workshop/projects/${pid}/results/${sub1.resultId}/review`, { decision: 'reviewed', reason: 'pilot' })
  const dW2 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w2}/dispatch`)
  if (!step('S9-W2-chain', rev1.status === 200 && dW2.status === 200, `review=${rev1.status} dispatch W2=${dW2.status}`)) return finish(false)
  const done2 = await waitRootDone(pid, w2, leads.proc)
  if (!step('S10-root-done-W2', done2.ok, done2.detail)) return finish(false)
  const sub2 = await submitAsLead(pid, w2, leads.proc)
  if (!step('S11-submit-W2', sub2.ok, sub2.detail)) return finish(false)
  const rev2 = await api('POST', `/api/workshop/projects/${pid}/results/${sub2.resultId}/review`, { decision: 'reviewed', reason: 'pilot' })
  const dW3 = await api('POST', `/api/workshop/projects/${pid}/work-items/${w3}/dispatch`)
  if (!step('S12-W3-chain', rev2.status === 200 && dW3.status === 200, `review=${rev2.status} dispatch W3=${dW3.status}`)) return finish(false)
  const done3 = await waitRootDone(pid, w3, leads.qa)
  if (!step('S13-root-done-W3', done3.ok, done3.detail)) return finish(false)
  const sub3 = await submitAsLead(pid, w3, leads.qa)
  if (!step('S14-submit-W3', sub3.ok, sub3.detail)) return finish(false)
  const rev3 = await api('POST', `/api/workshop/projects/${pid}/results/${sub3.resultId}/review`, { decision: 'reviewed', reason: 'pilot' })
  step('S15-review-W3', rev3.status === 200, `review=${rev3.status}`)

  // ⑤ L2 验收 + 完成
  for (const rid of [sub1.resultId, sub2.resultId, sub3.resultId]) {
    await api('POST', `/api/workshop/projects/${pid}/results/${rid}/request-acceptance`, {})
  }
  const apList = await api('GET', `/api/workshop/projects/${pid}/approvals`)
  const rows = apList.data?.approvals ?? apList.data ?? []
  const pendings = rows.filter(a => a.status === 'pending' && a.kind === 'deliverable_acceptance')
  for (const ap of pendings) {
    await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true, reason: 'pilot acceptance' })
  }
  const done = await api('POST', `/api/workshop/projects/${pid}/complete`, { reason: 'blueprint pilot done' })
  const finalSnap = await api('GET', `/api/workshop/projects/${pid}`)
  step('S16-l2-complete', pendings.length >= 1 && (done.status === 200 || finalSnap.data?.status === 'completed'), `L2 批 ${pendings.length} complete=${done.status} final=${finalSnap.data?.status}`)

  finish(steps.every(s => s.ok))
}

async function waitRootDone(pid, workItemId, force, timeoutMs = 180_000) {
  const t0 = Date.now()
  let forced = false
  while (Date.now() - t0 < timeoutMs) {
    await sleep(3000)
    await api('POST', `/api/workshop/projects/${pid}/reconcile`)
    const items = await api('GET', `/api/workshop/projects/${pid}/work-items`)
    const wi = (items.data?.workItems ?? items.data ?? []).find(x => x.id === workItemId)
    if (wi && ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED'].includes(wi.state)) {
      return { ok: wi.state === 'COMPLETED', detail: `work item=${wi.state}` }
    }
    if (force && !forced && Date.now() - t0 > 20_000) {
      forced = true
      const chain = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${workItemId}`)
      const cd = chain.data ?? {}
      const attempt = (cd.attempts ?? []).find(x => !x.closedAt) ?? (cd.attempts ?? [])[0]
      const taskId = attempt?.channelTaskId ?? cd.task?.id
      if (!taskId) continue
      const agentToken = await leadTokenFor(force.cid, force.leadId)
      const done = await api('POST', `/api/workshop/tasks/${taskId}/complete`, {
        artifacts: [{ artifactId: `a-${workItemId}`, name: 'out.html', parts: [{ text: '<html>ok</html>' }] }],
      }, 30_000, agentToken)
      console.log(`  · [force] complete=${done.status} task=${String(taskId).slice(0, 8)}`)
    }
  }
  return { ok: false, detail: 'root 完成等待超时(180s)' }
}

async function submitAsLead(pid, workItemId, channel) {
  const results = await api('GET', `/api/workshop/projects/${pid}/results`)
  const rows = results.data?.results ?? results.data ?? []
  const draft = rows.filter(r => r.workItemId === workItemId).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]
  if (!draft) return { ok: false, detail: '无成果草稿', resultId: null }
  let evidence = []
  try { evidence = JSON.parse(draft.evidenceJson ?? '[]') } catch { }
  if (!Array.isArray(evidence) || evidence.length === 0) evidence = [{ artifactId: `a-${workItemId}` }]
  const agentToken = await leadTokenFor(channel.cid, channel.leadId)
  if (!agentToken) return { ok: false, detail: 'lead token 获取失败', resultId: draft.id }
  const inv = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: channel.leadId,
    tool: 'project_submit_result',
    args: { result_id: draft.id, summary: 'lead 交付（蓝图试点）', evidence },
  }, 30_000, agentToken)
  const ok = inv.status === 200 && !(inv.data?.result ?? inv.data)?.isError
  return { ok, detail: `lead 提交=${inv.status} ${String((inv.data?.result ?? inv.data)?.text ?? inv.message).slice(0, 90)}`, resultId: draft.id }
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'blueprint-live.json'), JSON.stringify({ at: new Date().toISOString(), base, verdict, steps }, null, 2))
  const md = [`# 蓝图一键实例化实机验收 · ${verdict}`, '', `- base=${base}`, ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), ''].join('\n')
  writeFileSync(join(outDir, 'blueprint-live.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => {
  console.error(`FAIL: ${err?.message ?? err}`)
  finish(false)
})
