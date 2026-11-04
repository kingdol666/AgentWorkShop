#!/usr/bin/env node
/**
 * Project 层生产业务验收（PR3/PR4 范围）。
 *
 * 真实链路：
 *   DCW 产线/模板/节点/产品/配方 → 绑线 Channel（mock lead）→ Project（办公室 + project_leader）
 *   → 交付物 → 工作项 → 激活 → 派发 root task → 验证项目上下文/预算/权限/保护。
 *
 * 不覆盖（当前未实现，必须标 BLOCKED，不得算通过）：
 *   成果 draft/submit/review/approve、审批、Reconciler、项目 UI、MAST/Live 全量。
 *
 * 运行：node scripts/e2e-project-line-acceptance.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-project-line-acceptance')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const TAG = `pl${Date.now().toString(36).slice(-4)}`
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 400)}`}`)
}
const blocked = (id, name, reason) => {
  results.push({ id, name, pass: false, blocked: true, detail: reason })
  console.log(`⏸ [${id}] BLOCKED — ${name}: ${reason}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3989, 3988, 3987, 3986]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    AW_RATE_LIMIT_OFF: '1',
    NUXT_SESSION_PASSWORD: 'ProjectLine#2026-e2e-session-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}

function finish() {
  try {
    child.kill()
  }
  catch { /* ignore */ }
  const pass = results.filter(r => r.pass).length
  const fail = results.filter(r => !r.pass && !r.blocked).length
  const blockedCount = results.filter(r => r.blocked).length
  console.log(`\n=== SUMMARY pass=${pass} fail=${fail} blocked=${blockedCount} total=${results.length} ===`)
  const summary = { generatedAt: new Date().toISOString(), pass, fail, blocked: blockedCount, total: results.length, results }
  console.log(JSON.stringify(summary, null, 2))
  const out = process.env.AW_PROJECT_ACCEPTANCE_OUT
  if (out) {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
  process.exit(fail > 0 ? 1 : 0)
}

try {
  let healthy = false
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  ok('P0', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')

  const email = `pl-${TAG}@awshop.local`
  const reg = await api('POST', '/api/users/register', { name: `pl-admin-${TAG}`, email, password: 'PlAdmin#2026' })
  const token = reg.data?.token
  ok('P1', 'admin 注册/登录', Boolean(token), `status=${reg.status}`)
  const H = () => token

  // ── 真实产线业务对象 ──
  const line = (await api('POST', '/api/workshop/dcw/lines', { name: `项目线-${TAG}` }, H())).data?.line?.id
  const tpl = (await api('POST', '/api/workshop/dcw/templates', { name: `项目温度-${TAG}`, ch: '温度', unit: '℃', min: 0, max: 250, decimals: 1 }, H())).data?.template?.key
  const node = (await api('POST', '/api/workshop/dcw', { templateRef: tpl, name: `项目数控-${TAG}`, driver: 'mock', lineId: line, stepLimit: 20, driverConfig: { key: `pl-${TAG}` } }, H())).data?.node?.id
  const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `项目产品-${TAG}` }, H())).data?.product?.id
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', { productId: product, name: `项目配方-${TAG}`, params: [{ nodeId: node, value: 120, min: 0, max: 250 }] }, H())).data?.recipe?.id
  ok('P2', '真实产线/节点/产品/配方创建', Boolean(line && tpl && node && product && recipe), JSON.stringify({ line, node, product, recipe }))
  const dcw = await api('GET', '/api/workshop/dcw', undefined, H())
  const dcwData = dcw.data ?? {}
  ok('P2b', '产线业务面可见新线/节点/产品/配方',
    Array.isArray(dcwData.lines) && dcwData.lines.some(x => x.id === line)
    && Array.isArray(dcwData.nodes) && dcwData.nodes.some(x => x.id === node)
    && Array.isArray(dcwData.products) && dcwData.products.some(x => x.id === product)
    && Array.isArray(dcwData.recipes) && dcwData.recipes.some(x => x.id === recipe))

  // ── 绑线 Channel（真实 lead=mock）──
  const member = (await api('POST', '/api/workshop/channels', {
    name: `项目执行频道-${TAG}`,
    lineId: line,
    leadAgent: { name: `执行Lead-${TAG}`, harness: 'mock' },
  }, H())).data
  ok('P3', '绑线 Channel 创建', Boolean(member?.channelId && member?.leadAgentId), JSON.stringify(member))
  const memberView = await api('GET', `/api/workshop/channels/${member.channelId}`, undefined, H())
  ok('P3b', 'Channel 产线绑定落库', memberView.data?.lineId === line, `lineId=${memberView.data?.lineId}`)

  // ── Project（办公室 + project_leader）──
  const project = (await api('POST', '/api/workshop/projects', {
    name: `良率项目-${TAG}`,
    objective: `将产线 ${line} 的良率提升到 98%`,
    successCriteria: ['良率 >= 98%', '基线可复现'],
    leaderHarness: 'mock',
  }, H())).data
  ok('P4', 'Project 创建（办公室 + leader 指针）', Boolean(project?.id && project?.officeChannelId && project?.leadAgentId), JSON.stringify(project))
  const office = (await api('GET', `/api/workshop/channels/${project.officeChannelId}`, undefined, H())).data
  const officeLeader = (office?.agents ?? []).find(a => a.id === project.leadAgentId)
  ok('P4b', '办公室频道存在且 leader agent_kind=project_leader', officeLeader?.agentKind === 'project_leader' && office?.chatEnabled === 1, JSON.stringify({ agentKind: officeLeader?.agentKind, chatEnabled: office?.chatEnabled }))

  // 绑定成员 Channel + 交付物 + 工作项
  const bind = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: `对产线 ${line} 做基线/质量` }, H())
  ok('P5', '用户绑定成员 Channel', bind.status === 200 && bind.data?.status === 'active', `status=${bind.status}`)
  const deliverable = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: `产线基线报告-${TAG}`,
    ownerChannelId: member.channelId,
    acceptanceCriteria: ['覆盖产线/产品/配方', '数据窗口明确'],
  }, H())).data
  ok('P5b', '交付物创建', Boolean(deliverable?.id), JSON.stringify(deliverable))
  const workItem = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: deliverable.id,
    channelId: member.channelId,
    title: `建立产线基线-${TAG}`,
    brief: `读取产线 ${line} 的节点/配方/历史，输出基线报告`,
    execBudgetMinutes: 60,
    dedupeKey: `baseline:${TAG}`,
  }, H())).data
  ok('P6', '项目工作项创建（交付物必填）', Boolean(workItem?.id && workItem?.deliverableId), JSON.stringify(workItem))
  const missingDeliverable = await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: 'does-not-exist', channelId: member.channelId, title: '非法工作项',
  }, H())
  ok('P6b', '不存在的交付物 → 工作项拒绝', missingDeliverable.status === 404, `status=${missingDeliverable.status}`)

  const activate = await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, H())
  ok('P7', 'Project 激活（Channel + 必选交付物）', activate.status === 200 && activate.data?.status === 'active', `status=${activate.status} body=${JSON.stringify(activate).slice(0, 200)}`)

  // 派发
  const dispatched = await api('POST', `/api/workshop/projects/${project.id}/work-items/${workItem.id}/dispatch`, {}, H())
  ok('P8', '工作项派发（root task）', dispatched.status === 200 && dispatched.data?.state === 'DISPATCHED', `status=${dispatched.status} state=${dispatched.data?.state}`)
  const tasks = await api('GET', `/api/workshop/channels/${member.channelId}/tasks`, undefined, H())
  const root = (tasks.data ?? []).find(t => t.projectWorkItemId === workItem.id)
  ok('P8b', 'root task 带项目上下文',
    root?.source === 'project' && root?.projectId === project.id && root?.projectWorkItemId === workItem.id && root?.projectAttemptNo === 1 && Boolean(root?.traceId),
    JSON.stringify(root).slice(0, 600))
  const budgetMs = root?.deadlineAt ? new Date(root.deadlineAt).getTime() - Date.now() : 0
  ok('P8c', '项目预算（60min）未被 900s 覆盖', budgetMs > 30 * 60_000, `remainingMs=${budgetMs}`)

  const again = await api('POST', `/api/workshop/projects/${project.id}/work-items/${workItem.id}/dispatch`, {}, H())
  ok('P9', '重复派发 → WORK_ITEM_IN_FLIGHT', again.status === 409 && again.code === 'WORK_ITEM_IN_FLIGHT', `status=${again.status} code=${again.code}`)

  // 保护规则
  const delOffice = await api('DELETE', `/api/workshop/channels/${project.officeChannelId}`, undefined, H())
  ok('P10', 'active 项目办公室删除 → 409', delOffice.status === 409 && delOffice.code === 'PROJECT_OFFICE_PROTECTED', `status=${delOffice.status} code=${delOffice.code}`)
  const disableOffice = await api('PATCH', `/api/workshop/channels/${project.officeChannelId}`, { enabled: 0 }, H())
  ok('P10b', 'active 项目办公室禁用 → 409', disableOffice.status === 409 && disableOffice.code === 'PROJECT_OFFICE_PROTECTED', `status=${disableOffice.status} code=${disableOffice.code}`)

  // 第二个 project 抢同一 Channel
  const project2 = (await api('POST', '/api/workshop/projects', { name: `第二个项目-${TAG}`, objective: '验证唯一绑定', leaderHarness: 'mock' }, H())).data
  const rebind = await api('POST', `/api/workshop/projects/${project2.id}/channels`, { channelId: member.channelId }, H())
  ok('P11', '同一 Channel 不能属于两个 active Project', rebind.status === 409 && rebind.code === 'CHANNEL_ALREADY_BOUND', `status=${rebind.status} code=${rebind.code}`)

  // 非 owner 隔离（首个 admin 已就位 → 自助注册关闭；由 admin 建用户后登录取 token）
  const bEmail = `pl-b-${TAG}@awshop.local`
  const bPassword = 'PlB#2026'
  await api('POST', '/api/users', { name: `pl-b-${TAG}`, email: bEmail, password: bPassword, role: 'user' }, H())
  const bToken = (await api('POST', '/api/users/login', { email: bEmail, password: bPassword })).data?.token
  const bGet = await api('GET', `/api/workshop/projects/${project.id}`, undefined, bToken)
  ok('P12', '非 owner 读取 Project → 403', bGet.status === 403, `status=${bGet.status}`)
  const bBind = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId }, bToken)
  ok('P12b', '非 owner 绑定 Channel → 403', bBind.status === 403, `status=${bBind.status}`)
  const bLine = await api('POST', '/api/workshop/channels', { name: `B越权线频道-${TAG}`, lineId: line, leadAgent: { name: 'B Lead', harness: 'mock' } }, bToken)
  ok('P12c', '无产线 grant 的用户不能创建绑线 Channel', bLine.status === 403, `status=${bLine.status} code=${bLine.code}`)

  // ── PR5：成果/审批/审计/Reconciler（真实 HTTP）──
  const rotate = await api('POST', `/api/workshop/channels/${member.channelId}/agents/${member.leadAgentId}/rotate-token`, {}, H())
  const agentToken = rotate.data?.token
  ok('P13a', '成员 lead token 轮换（完成任务用）', Boolean(agentToken), `status=${rotate.status}`)

  const complete = await api('POST', `/api/workshop/tasks/${root.id}/complete`, {
    artifacts: [{
      artifactId: `art-${TAG}`,
      name: 'baseline.md',
      parts: [{ text: `产线 ${line} 基线良率 97.9%，窗口 10-30 08:00-12:00` }],
    }],
  }, agentToken)
  ok('P13b', '成员 lead 完成任务', complete.status === 200 && complete.data?.state === 'COMPLETED', `status=${complete.status} state=${complete.data?.state}`)

  const rec = await api('POST', `/api/workshop/projects/${project.id}/reconcile`, {}, H())
  const recItem = (rec.data?.workItems ?? []).find(x => x.id === workItem.id)
  ok('P15', 'Reconciler：root 终态同步工作项 COMPLETED', rec.status === 200 && recItem?.state === 'COMPLETED', `status=${rec.status} state=${recItem?.state}`)

  const results1 = await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, H())
  const draft = (results1.data ?? [])[0]
  let draftEvidence = []
  try {
    draftEvidence = JSON.parse(draft?.evidenceJson ?? '[]')
  }
  catch { /* ignore */ }
  ok('P13c', 'root COMPLETED 自动生成成果 draft（带真实 artifact 证据）',
    results1.status === 200 && draft?.status === 'draft' && Array.isArray(draftEvidence) && draftEvidence.length > 0,
    `status=${results1.status} result=${draft?.status} evidence=${String(draft?.evidenceJson).slice(0, 300)}`)

  const submitted = await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/submit`, {
    summary: '基线良率 97.9%，数据窗口完整',
    method: '按产线/产品/配方取数',
    evidence: [{ artifactId: `art-${TAG}`, name: 'baseline.md' }],
  }, H())
  ok('P13d', '成果 submit（owner）', submitted.status === 200 && submitted.data?.status === 'submitted', `status=${submitted.status}`)

  const reviewed = await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/review`, { decision: 'reviewed' }, H())
  ok('P13e', '成果 review（owner/leader）', reviewed.status === 200 && reviewed.data?.status === 'reviewed', `status=${reviewed.status}`)

  const acceptanceReq = await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/request-acceptance`, {}, H())
  const approval = acceptanceReq.data
  ok('P14', '成果验收审批已创建 pending', acceptanceReq.status === 200 && approval?.status === 'pending', `status=${acceptanceReq.status}`)

  const decided = await api('POST', `/api/workshop/projects/${project.id}/approvals/${approval.id}/decide`, { approve: true, reason: '证据完整' }, H())
  ok('P14b', 'owner 批准成果验收', decided.status === 200 && decided.data?.status === 'approved', `status=${decided.status}`)

  const results2 = await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, H())
  const approvedResult = (results2.data ?? []).find(x => x.id === draft.id)
  ok('P13f', '成果 approved', approvedResult?.status === 'approved', `state=${approvedResult?.status}`)

  const deliverables2 = await api('GET', `/api/workshop/projects/${project.id}/deliverables`, undefined, H())
  const approvedDeliverable = (deliverables2.data ?? []).find(x => x.id === deliverable.id)
  ok('P14c', '交付物 approved', approvedDeliverable?.status === 'approved', `state=${approvedDeliverable?.status}`)

  const decisions = await api('GET', `/api/workshop/projects/${project.id}/decisions`, undefined, H())
  const events = await api('GET', `/api/workshop/projects/${project.id}/events`, undefined, H())
  const decisionsData = decisions.data ?? []
  const eventsData = events.data ?? []
  ok('P16', '审计 decisions/events 落库且带 trace',
    decisions.status === 200 && events.status === 200 && decisionsData.length > 0 && eventsData.length > 0
    && decisionsData.every(d => d.argsSha256?.length === 64) && eventsData.every(e => Boolean(e.eventKey)),
    `decisions=${decisionsData.length} events=${eventsData.length}`)

  const repeatDecide = await api('POST', `/api/workshop/projects/${project.id}/approvals/${approval.id}/decide`, { approve: true }, H())
  ok('P14d', '审批重复决策 → 409', repeatDecide.status === 409, `status=${repeatDecide.status} code=${repeatDecide.code}`)

  const planReq = await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, {
    version: 1,
    plan: { facts: [`产线 ${line} 已确认`], deliverables: [deliverable.id], workItems: [workItem.id] },
  }, H())
  const planAp = planReq.data
  const planDec = planAp ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${planAp.id}/decide`, { approve: true, reason: '计划可执行' }, H()) : null
  const afterPlan = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  ok('P14e', 'plan_approval 批准 → planVersion=1', planDec?.status === 200 && afterPlan.data?.planVersion === 1, `planReq=${planReq.status} planDec=${planDec?.status} version=${afterPlan.data?.planVersion}`)

  const completeReq = await api('POST', `/api/workshop/projects/${project.id}/complete`, {}, H())
  const completeAp = completeReq.data
  const completeDec = completeAp ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${completeAp.id}/decide`, { approve: true, reason: '交付物已验收' }, H()) : null
  const afterComplete = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  ok('P14f', '项目完成门禁 + owner 批准 → completed', completeDec?.status === 200 && afterComplete.data?.status === 'completed', `completeReq=${completeReq.status} completeDec=${completeDec?.status} status=${afterComplete.data?.status}`)

  // 未实现能力：必须 BLOCKED，不得算通过
  blocked('P17', '项目页完整 Playwright 交互矩阵 / 周报导出', 'UI smoke 已过；完整交互矩阵待补')
  blocked('P18b', 'Live 全量 / G0–G6 / 回滚演练', 'PR7 收尾未执行')

  finish()
}
catch (err) {
  console.error('验收脚本异常:', err)
  ok('P-EXCEPTION', '验收脚本异常', false, err instanceof Error ? err.message : String(err))
  finish()
}
