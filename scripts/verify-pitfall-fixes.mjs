#!/usr/bin/env node
/**
 * 2026-11-08 坑修复复现验证（合并后 main 构建，独立 home/端口）：
 *   V1 派发原子化（PR #84）：同工作项并发双派发 → 恰一次成功 / WORK_ITEM_IN_FLIGHT /
 *      唯一 attempt + 唯一 task session（无孤儿实例）
 *   V2 会话关闭生命周卫（PR #86）：close → 会话 closed + clone enabled=0 + 关闭后拒新消息
 *   V3 任务实例读面对称（PR #86）：实例 lead 调 project_read_work_items / project_read_results
 *      能读到自己工作项与 draft 成果（修复前读面恒空）
 *
 * 证据输出：docs/audit/evidence/2026-11-08-pitfall-fixes/verify.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVID = join(REPO, 'docs/audit/evidence/2026-11-08-pitfall-fixes')
mkdirSync(EVID, { recursive: true })
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3996'
// 本实例由 bin/aw start 以仓库默认配置根启动（未吃 AW_HOME），数据在 .AgentWorkShop/data。
const HOME = process.env.VERIFY_HOME ?? 'D:/codes/ABO/aw-mem-runtime/.AgentWorkShop'
const EMAIL = process.env.VERIFY_EMAIL ?? 'verify-pitfall@aw.local'
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'Verify#2026'

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 280)}`}`)
}
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, ...JSON.parse(text) }
  }
  catch {
    return { status: res.status, code: -1, message: text.slice(0, 300), data: null }
  }
}

const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null)
ok('V0-1', '实例健康', health?.data?.status === 'ok', JSON.stringify(health?.data ?? {}))

const setup = await api('GET', '/api/users/setup-status')
let token
if (setup.data?.needsSetup) {
  const reg = await api('POST', '/api/users/register', { name: 'verify-admin', email: EMAIL, password: PASSWORD })
  token = reg.data?.token
}
else {
  const login = await api('POST', '/api/users/login', { email: EMAIL, password: PASSWORD })
  token = login.data?.token
}
ok('V0-2', '管理员鉴权', Boolean(token), `needsSetup=${setup.data?.needsSetup}`)
if (!token) {
  console.error('鉴权失败，终止')
  process.exitCode = 1
}
else {
  // ── V1 派发原子化 ──
  const ch = await api('POST', '/api/workshop/channels', {
    name: `verify-dispatch-${Date.now()}`,
    leadAgent: { name: 'verify lead', harness: 'mock', config: { delayMs: 80 } },
  }, token)
  const chId = ch.data?.channelId
  ok('V1-0', '建执行频道', Boolean(chId), ch.message)
  // 任务实例模板必须含 worker + 复杂标记：mock lead 才会把 root 拆给 worker 执行，
  // 工作项在 DISPATCHED 停留足够久，才能复现“第二次派发撞在飞 attempt”的窗口。
  await api('POST', `/api/workshop/channels/${chId}/agents`, {
    name: 'verify worker', harness: 'mock', role: 'worker', config: { delayMs: 4000 },
  }, token)
  const proj = await api('POST', '/api/workshop/projects', {
    name: `verify-dispatch-project-${Date.now()}`,
    objective: '验证并发派发原子性',
    leaderHarness: 'mock',
    mode: 'supervised',
    routingPolicy: 'legacy',
  }, token)
  const pid = proj.data?.id
  await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: chId, charter: '执行' }, token)
  const d = await api('POST', `/api/workshop/projects/${pid}/deliverables`, {
    name: 'verify-dispatch.html', required: true, ownerChannelId: chId,
    acceptanceCriteria: ['artifact_present'],
  }, token)
  const w = await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: d.data?.id, channelId: chId, title: '并发派发验证工作项',
    brief: '[mock:complex] 验证同工作项并发派发：先分析需求再分别产出，多阶段执行。', execBudgetMinutes: 5,
  }, token)
  await api('POST', `/api/workshop/projects/${pid}/activate`, {}, token)
  const plan = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['verify'] } }, token)
  if (plan.data?.id) await api('POST', `/api/workshop/projects/${pid}/approvals/${plan.data.id}/decide`, { approve: true }, token)
  const wid = w.data?.id
  ok('V1-1', '项目/工作项就绪', Boolean(pid && wid), `${proj.message}/${w.message}`)

  // V3 预置：直接写一条 draft 成果行（attempt_no=999，避免与真实物化撞唯一键），
  // 用于在实例 lead 仍 enabled 的窗口内验证「成果读面不再恒空」。
  const draftId = `verify-draft-${Date.now().toString(36)}`
  try {
    const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'))
    db.prepare(`INSERT INTO project_results
      (id, project_id, deliverable_id, channel_id, work_item_id, attempt_no, result_key, version,
       title, summary, status, source_task_id, author_agent_id, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(draftId, pid, d.data.id, chId, wid, 999, 'main', 1,
        '读面验证成果', '用于验证实例成员成果读面', 'draft', 'verify-task', null, '', new Date().toISOString())
    db.close()
  }
  catch (err) {
    ok('V3-PREP', '预置 draft 成果行', false, err instanceof Error ? err.message : String(err))
  }

  const [r1, r2] = await Promise.all([
    api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {}, token),
    api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {}, token),
  ])
  const statuses = [r1.status, r2.status].sort((a, b) => a - b)
  ok('V1-2', '并发双派发：恰一次成功、一次 409 冲突', statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses.join('/')}`)
  const conflict = [r1, r2].find(r => r.status === 409)
  ok('V1-3', '冲突码 WORK_ITEM_IN_FLIGHT（可重试，不再 BLOCKED）', conflict?.code === 'WORK_ITEM_IN_FLIGHT', JSON.stringify(conflict ?? {}).slice(0, 200))

  // ── V3 任务实例读面对称（紧贴派发，趁实例 lead 仍 enabled） ──
  const win = [r1, r2].find(r => r.status === 200)
  let instCh = win?.data?.instanceChannelId
  if (!instCh) {
    const od = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`, undefined, token)
    instCh = od.data?.workItem?.instanceChannelId ?? null
  }
  const ags = instCh ? await api('GET', `/api/workshop/channels/${instCh}/agents`, undefined, token) : { data: [] }
  const instLead = (ags.data ?? []).find(a => a.role === 'lead')
  ok('V3-0', '实例 lead 可解析且启用', Boolean(instLead?.id) && instLead?.enabled === 1, `channel=${instCh ?? '-'} enabled=${instLead?.enabled ?? '-'}`)
  if (instLead?.id) {
    const readW = await api('POST', '/api/workshop/agent-tools/invoke', {
      agentId: instLead.id, tool: 'project_read_work_items', args: {},
    }, token)
    const readWText = String(readW.data?.result?.text ?? '')
    ok('V3-1', '实例 lead 读工作项非空（修复前恒空集）', readWText.includes('并发派发验证工作项') || readWText.includes(wid), readWText.slice(0, 240))

    const readR = await api('POST', '/api/workshop/agent-tools/invoke', {
      agentId: instLead.id, tool: 'project_read_results', args: {},
    }, token)
    const readRText = String(readR.data?.result?.text ?? '')
    ok('V3-2', '实例 lead 读到本工作项 draft 成果（修复前恒空集）', readRText.includes(draftId), readRText.slice(0, 320))
  }

  const obs = await api('GET', `/api/workshop/projects/${pid}/observability`, undefined, token)
  const wrow = (obs.data?.workItems ?? []).find(x => x.id === wid)
  ok('V1-4', '工作项指向唯一实例频道', Boolean(wrow?.instanceChannelId), `instanceChannelId=${wrow?.instanceChannelId ?? '-'}`)
  const det = await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`, undefined, token)
  const attempts = det.data?.attempts ?? []
  ok('V1-5', '唯一 attempt（无 attemptNo 竞态）', attempts.length === 1, `attempts=${attempts.length}`)
  const catalog = await api('GET', `/api/workshop/projects/${pid}/sessions`, undefined, token)
  const taskSessions = (catalog.data ?? []).filter(s => s.kind === 'task' && s.workItemId === wid)
  ok('V1-6', '唯一 task session（无孤儿实例）', taskSessions.length === 1, `taskSessions=${taskSessions.length}`)

  // ── V2 会话关闭生命周卫 ──
  const ch2 = await api('POST', '/api/workshop/channels', {
    name: `verify-session-${Date.now()}`,
    leadAgent: { name: 'verify session lead', harness: 'mock', config: { delayMs: 50 } },
  }, token)
  const ch2Id = ch2.data?.channelId
  await api('POST', `/api/workshop/channels/${ch2Id}/agents`, { name: 'verify session worker', harness: 'mock', role: 'worker', config: {} }, token)
  const sess = await api('POST', `/api/workshop/channels/${ch2Id}/sessions`, { title: 'close verify' }, token)
  const sid = sess.data?.sessionId
  ok('V2-0', '创建 manual session（克隆成员）', Boolean(sid), sess.message)
  const closed = await api('POST', `/api/workshop/channels/${ch2Id}/sessions/${sid}/close`, { reason: 'verify close' }, token)
  ok('V2-1', '关闭会话 200', closed.status === 200, closed.message)
  const cat2 = await api('GET', `/api/workshop/channels/${ch2Id}/sessions`, undefined, token)
  const srow = (cat2.data ?? []).find(s => s.id === sid)
  ok('V2-2', '会话终态 closed', srow?.status === 'closed', JSON.stringify(srow ?? {}).slice(0, 160))
  const ags2 = await api('GET', `/api/workshop/channels/${ch2Id}/agents`, undefined, token)
  const clones = (ags2.data ?? []).filter(a => String(a.name ?? '').includes('·session·'))
  ok('V2-3', 'clone 成员行已停用（enabled=0，不可再寻址）', clones.length >= 2 && clones.every(a => a.enabled === 0), JSON.stringify(clones.map(a => ({ name: a.name, enabled: a.enabled }))).slice(0, 240))
  const late = await api('POST', `/api/workshop/channels/${ch2Id}/sessions/${sid}/messages`, { text: '关闭后不应受理' }, token)
  ok('V2-4', '关闭会话拒新消息（409 SESSION_CLOSED）', late.status === 409 && late.code === 'SESSION_CLOSED', JSON.stringify(late).slice(0, 200))

  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  mkdirSync(EVID, { recursive: true })
  writeFileSync(join(EVID, 'verify.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), base: BASE, pass, fail, results,
  }, null, 2))
  console.log(`\n=== VERIFY pass=${pass} fail=${fail} ===`)
  process.exitCode = fail > 0 ? 1 : 0
}
