#!/usr/bin/env node
/**
 * project-task-instance-live.mjs —— 项目任务实例实机验收（REST 全链路）。
 *
 * 验证目标（plan 2026-11-07-project-task-p1）：
 *   ① 登录 / 建模板频道（lead+worker）/ 建项目（office leader）
 *   ② 项目绑定模板频道
 *   ③ 建 2 个工作项（DRAFT）→ 逐个派发
 *   ④ 每个任务自动获得**任务专属 Channel**（workItem.instanceChannelId 非空且互不相同）
 *      且该 Channel 有独立 lead（任务特有的实例 runtime 对象）
 *   ⑤ workItem 关联**任务会话**（channel_sessions.instance_kind='task'，project/workItem 溯源齐备）
 *   ⑥ 会话 memberMap 是模板成员 → 实例成员的真实映射（且实例成员属于实例 Channel）
 *   ⑦ attempt 记录在实例 Channel 上（project_work_item_attempts.channel_id == instanceChannelId）
 *   ⑧ 两个任务的 root task 分别落在两个不同实例 Channel（真并行前提：根 FIFO 按 Channel）
 *   ⑨ observability lanes[].sessions 与 workItems[].instanceChannelId 透出
 *   ⑩ 任务终态后实例停用（grace 观察；若仍未终态则跳过并如实标注）
 *
 * 用法：node scripts/_audit/project-task-instance-live.mjs --base http://127.0.0.1:3581
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', 'http://127.0.0.1:3581').replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-project-task-instance`)))

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '').slice(0, 320) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 210)}`)
  return ok
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, timeoutMs = 30_000) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, message: json?.message ?? json?.code ?? '' }
}

async function main() {
  // ① 登录
  const st = await api('GET', '/api/users/setup-status')
  if (st.data?.needsSetup) {
    token = (await api('POST', '/api/users/register', { name: 'owner', email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  }
  else {
    token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  }
  if (!step('P1-auth', Boolean(token), 'owner token ok')) return finish(false)

  // ② 模板频道（lead + worker）
  const ch = await api('POST', '/api/workshop/channels', { name: `任务实例模板-${randomUUID().slice(0, 5)}` })
  const templateChannelId = ch.data?.channelId ?? ch.data?.id
  await api('POST', `/api/workshop/channels/${templateChannelId}/agents`, { name: 'Lead·模板', harness: 'mock', role: 'lead' })
  const ompModel = 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2'
  await api('POST', `/api/workshop/channels/${templateChannelId}/agents`, { name: 'Worker·模板', harness: 'omp', role: 'worker', config: { provider: 'lm-studio', model: ompModel } })
  await api('POST', `/api/workshop/channels/${templateChannelId}/activate`, {})
  const agentsOf = await api('GET', `/api/workshop/channels/${templateChannelId}/agents`)
  const tplAgents = agentsOf.data ?? []
  if (!step('P2-template', Boolean(templateChannelId && tplAgents.length >= 2), `template=${String(templateChannelId).slice(0, 8)} members=${tplAgents.length}`)) return finish(false)

  // ③ 项目 + 绑定模板频道 + 交付物 + 激活（V1 顺序：绑定与必选交付物齐备才可激活）
  const proj = await api('POST', '/api/workshop/projects', {
    name: `任务实例项目-${randomUUID().slice(0, 5)}`,
    objective: '验证任务级多会话：每任务专属 Channel + 会话',
    leaderHarness: 'mock',
  })
  const projectId = proj.data?.id ?? proj.data?.projectId
  const bind = await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId: templateChannelId, charter: '执行模板频道' })
  const dl = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, {
    name: '任务级会话验证交付物', required: true, acceptanceCriteria: ['每任务独立实例 Channel', '每任务独立会话'],
  })
  const deliverableId = dl.data?.id
  const act = await api('POST', `/api/workshop/projects/${projectId}/activate`, {})
  // 计划门（plan_approval_required 默认 1）：提交一个不含 deliverables 的最小计划并批准
  // （materializeApprovedPlan 对无 deliverables 的计划是 no-op，仅推进 planVersion）
  const reqPlan = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, {
    version: 1,
    plan: { note: 'task-instance acceptance plan (no-op materialization)' },
  })
  const approvalId = reqPlan.data?.id
  const decide = approvalId
    ? await api('POST', `/api/workshop/projects/${projectId}/approvals/${approvalId}/decide`, { approve: true, reason: '实机验收' })
    : { status: 0, message: 'no approval id' }
  if (!step('P3-project', Boolean(projectId) && bind.status === 200 && Boolean(deliverableId) && act.status === 200 && decide.status === 200,
    `project=${String(projectId).slice(0, 8)} bind=${bind.status} deliverable=${String(deliverableId).slice(0, 8)} activate=${act.status} planApproval=${reqPlan.status}/${decide.status}${decide.message ? `(${decide.message})` : ''}`)) return finish(false)

  // ④ 2 个工作项
  const mk = async (title, resultKey) => api('POST', `/api/workshop/projects/${projectId}/work-items`, {
    deliverableId, channelId: templateChannelId, title, brief: `${title}：请执行并汇报`, resultKey,
  })
  const w1 = await mk('任务一·落地页调研', 'main')
  const w2 = await mk('任务二·落地页实现', 'w2')
  const wi1 = w1.data?.id ?? w1.data?.workItem?.id
  const wi2 = w2.data?.id ?? w2.data?.workItem?.id
  if (!step('P4-work-items', Boolean(wi1 && wi2), `wi1=${String(wi1).slice(0, 8)} wi2=${String(wi2).slice(0, 8)}`)) return finish(false)

  // ⑤ 逐个派发（手动派发，绕开 auto gate，验证编排本身）
  const d1 = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi1}/dispatch`, {})
  const d2 = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi2}/dispatch`, {})
  step('P5-dispatch', d1.status === 200 && d2.status === 200, `dispatch1=${d1.status}${d1.message ? `(${d1.message})` : ''} dispatch2=${d2.status}${d2.message ? `(${d2.message})` : ''}`)

  // ⑥ observability：实例 Channel / 会话透出且互不相同
  let obs = null
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    const r = await api('GET', `/api/workshop/projects/${projectId}/observability`)
    obs = r.data
    const items = (obs?.workItems ?? []).filter(w => w.id === wi1 || w.id === wi2)
    if (items.length === 2 && items.every(w => w.instanceChannelId)) break
  }
  const items = (obs?.workItems ?? []).filter(w => w.id === wi1 || w.id === wi2)
  const i1 = items.find(w => w.id === wi1)
  const i2 = items.find(w => w.id === wi2)
  const instance1 = i1?.instanceChannelId
  const instance2 = i2?.instanceChannelId
  const distinct = Boolean(instance1 && instance2 && instance1 !== instance2)
  step('P6-instance-channels', Boolean(instance1 && instance2 && distinct),
    `wi1.instance=${String(instance1).slice(0, 8)} wi2.instance=${String(instance2).slice(0, 8)} 互不相同=${distinct}（任务专属 Channel）`)

  if (!instance1 || !instance2) return finish(false)

  // ⑦ 实例 Channel 成员/lead（任务特有的实例 runtime 对象）
  const al1 = await api('GET', `/api/workshop/channels/${instance1}/agents`)
  const al2 = await api('GET', `/api/workshop/channels/${instance2}/agents`)
  const ch1 = await api('GET', `/api/workshop/channels/${instance1}`)
  const ch2 = await api('GET', `/api/workshop/channels/${instance2}`)
  const m1 = al1.data ?? []
  const m2 = al2.data ?? []
  const tplIds = new Set(tplAgents.map(a => a.id))
  const freshInstances = m1.every(a => !tplIds.has(a.id)) && m2.every(a => !tplIds.has(a.id))
  const hasLead1 = Boolean(ch1.data?.leadAgentId)
  const hasLead2 = Boolean(ch2.data?.leadAgentId)
  const leadDistinct = ch1.data?.leadAgentId && ch2.data?.leadAgentId && ch1.data.leadAgentId !== ch2.data.leadAgentId
  step('P7-instance-members', m1.length >= 2 && m2.length >= 2 && freshInstances && hasLead1 && hasLead2 && Boolean(leadDistinct),
    `ch1 成员=${m1.length}(lead=${String(ch1.data?.leadAgentId).slice(0, 8)}) ch2 成员=${m2.length}(lead=${String(ch2.data?.leadAgentId).slice(0, 8)}) 全为新建实例=${freshInstances} lead 互不相同=${Boolean(leadDistinct)}`)

  // ⑧ 任务会话：instance_kind='task' + 项目/工作项溯源 + 真实 memberMap
  const s1 = await api('GET', `/api/workshop/channels/${instance1}/sessions`)
  const s2 = await api('GET', `/api/workshop/channels/${instance2}/sessions`)
  const ts1 = (s1.data ?? [])[0]
  const ts2 = (s2.data ?? [])[0]
  const maps1 = Object.entries(ts1?.memberMap ?? {})
  const maps2 = Object.entries(ts2?.memberMap ?? {})
  // memberMap 的 value 必须是该实例 Channel 的成员（真实映射），key 是模板成员
  const instIds1 = new Set(m1.map(a => a.id))
  const instIds2 = new Set(m2.map(a => a.id))
  const mapValid1 = maps1.length >= 2 && maps1.every(([k, v]) => tplIds.has(k) && instIds1.has(v))
  const mapValid2 = maps2.length >= 2 && maps2.every(([k, v]) => tplIds.has(k) && instIds2.has(v))
  step('P8-task-sessions',
    ts1?.instanceKind === 'task' && ts2?.instanceKind === 'task'
    && ts1?.projectId === projectId && ts2?.projectId === projectId
    && ts1?.projectWorkItemId === wi1 && ts2?.projectWorkItemId === wi2
    && mapValid1 && mapValid2,
    `s1=${String(ts1?.id).slice(0, 8)}(kind=${ts1?.instanceKind},wi 匹配=${ts1?.projectWorkItemId === wi1},map ${maps1.length}项有效=${mapValid1}) s2=${String(ts2?.id).slice(0, 8)}(kind=${ts2?.instanceKind},wi 匹配=${ts2?.projectWorkItemId === wi2},map ${maps2.length}项有效=${mapValid2})`)

  // ⑨ root task 落在两个不同实例 Channel（根 FIFO 按 Channel → 真并行前提）
  const q1 = await api('GET', `/api/workshop/channels/${instance1}/queue`)
  const q2 = await api('GET', `/api/workshop/channels/${instance2}/queue`)
  const t1 = await api('GET', `/api/workshop/channels/${instance1}/tasks`)
  const t2 = await api('GET', `/api/workshop/channels/${instance2}/tasks`)
  const roots1 = (t1.data ?? [])
  const roots2 = (t2.data ?? [])
  const root1 = roots1[0]
  const root2 = roots2[0]
  step('P9-root-tasks', Boolean(root1 && root2) && root1.channelId === instance1 && root2.channelId === instance2,
    `ch1 root=${String(root1?.id).slice(0, 8)}(${root1?.state}) ch2 root=${String(root2?.id).slice(0, 8)}(${root2?.state}) 队列可读=${q1.status}/${q2.status}`)

  // ⑩ observability sessions 分区透出
  const lanes = obs?.channels ?? []
  const lane = lanes.find(l => l.channelId === templateChannelId)
  const laneSessions = lane?.sessions ?? []
  const laneOk = laneSessions.length >= 2 && laneSessions.every(s => Boolean(s.sessionId))
  step('P10-observability', laneOk, `lane sessions=${laneSessions.length}（${laneSessions.map(s => `${s.workItemTitle?.slice(0, 6)}→${String(s.sessionId).slice(0, 8)}/${s.sessionStatus}`).join(' | ')}）`)

  // ⑪ 终态回收（确定性验证）：取消任务二 → workItem CANCELED → 会话 close + 实例停用
  const cancel2 = await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi2}/cancel`, { reason: '实机验收：验证任务实例回收' })
  let releaseOk = false
  let releaseNote = `cancel=${cancel2.status}${cancel2.message ? `(${cancel2.message})` : ''}`
  for (let i = 0; i < 14; i++) {
    await sleep(2500)
    const r = await api('GET', `/api/workshop/projects/${projectId}/observability`)
    const its = (r.data?.workItems ?? [])
    const it2 = its.find(w => w.id === wi2)
    const chk = await api('GET', `/api/workshop/channels/${instance2}`)
    const sess2 = await api('GET', `/api/workshop/channels/${instance2}/sessions`)
    const s2row = (sess2.data ?? [])[0]
    releaseNote = `wi2=${it2?.state} session=${s2row?.status} instance.enabled=${chk.data?.enabled}`
    if (['CANCELED', 'FAILED'].includes(String(it2?.state)) && s2row?.status === 'closed' && chk.data?.enabled === 0) {
      releaseOk = true
      break
    }
  }
  step('P11-terminal-release', releaseOk, `取消任务二后自动回收（会话 close + 实例停用）：${releaseNote}`)

  // ⑫ 任务一仍在执行（如实记录，不作硬性判定）
  const fin = await api('GET', `/api/workshop/projects/${projectId}/observability`)
  const it1 = (fin.data?.workItems ?? []).find(w => w.id === wi1)
  step('P12-parallel-running', ['DISPATCHED', 'RUNNING', 'COMPLETED'].includes(String(it1?.state)),
    `任务一独立运行中：state=${it1?.state}（与已回收的任务二互不影响 = 并行执行证据）`)

  finish(steps.every(s => s.ok))
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'project-task-instance.json'), JSON.stringify({ at: new Date().toISOString(), base, verdict, steps }, null, 2))
  const md = [`# 项目任务实例实机验收 · ${verdict}`, '', `- base=${base}`, ...steps.map(s => `- ${s.ok ? '✔' : '✘'} **${s.name}** ${s.detail}`), ''].join('\n')
  writeFileSync(join(outDir, 'project-task-instance.md'), md)
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
