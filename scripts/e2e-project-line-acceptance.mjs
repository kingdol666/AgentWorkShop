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

/** owner 用户路径调用 Agent 工具（/agent-tools/invoke 会校验 agent 所属频道归属）。 */
function invokeAgentTool(agentId, tool, args, token) {
  return api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
}

function toolText(resp) {
  return String(resp?.data?.result?.text ?? '')
}

function parseToolJson(resp) {
  try {
    return JSON.parse(toolText(resp))
  }
  catch {
    return null
  }
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

  // ── PR8：project_leader 工具面（只读 + 提案；执行层拒绝 Channel 工具）──
  const leaderStatus = await invokeAgentTool(project.leadAgentId, 'project_get_status', {}, token)
  const leaderStatusBody = parseToolJson(leaderStatus)
  ok('P4c', 'project_leader get_status 返回本项目',
    leaderStatus.status === 200 && leaderStatus.data?.result?.isError !== true && leaderStatusBody?.project?.id === project.id,
    `status=${leaderStatus.status} text=${toolText(leaderStatus).slice(0, 300)}`)
  const leaderDeny = await invokeAgentTool(project.leadAgentId, 'dispatch_task', { title: 'x', description: 'y' }, token)
  ok('P4d', 'project_leader 执行层拒绝 dispatch_task',
    leaderDeny.status === 200 && leaderDeny.data?.result?.isError === true && /PROJECT_TOOL_DENIED/.test(toolText(leaderDeny)),
    `status=${leaderDeny.status} text=${toolText(leaderDeny).slice(0, 300)}`)

  // 绑定成员 Channel + 交付物 + 工作项
  const bind = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: `对产线 ${line} 做基线/质量` }, H())
  ok('P5', '用户绑定成员 Channel', bind.status === 200 && bind.data?.status === 'active', `status=${bind.status}`)
  const deliverable = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: `产线基线报告-${TAG}`,
    ownerChannelId: member.channelId,
    acceptanceCriteria: ['覆盖产线/产品/配方', '数据窗口明确'],
  }, H())).data
  ok('P5b', '交付物创建', Boolean(deliverable?.id), JSON.stringify(deliverable))
  const leaderChannels = await invokeAgentTool(project.leadAgentId, 'project_list_channels', {}, token)
  const leaderChannelsBody = parseToolJson(leaderChannels)
  ok('P5c', 'project_leader list_channels 返回已绑定成员频道',
    Array.isArray(leaderChannelsBody) && leaderChannelsBody.some(c => c.channelId === member.channelId),
    `text=${toolText(leaderChannels).slice(0, 300)}`)
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

  // PR13 计划门：plan 未批不能派发；owner 批准 v1 后放行
  const earlyDispatch = await api('POST', `/api/workshop/projects/${project.id}/work-items/${workItem.id}/dispatch`, {}, H())
  ok('P7b', '计划门：未批计划派发 → 409 PLAN_NOT_APPROVED',
    earlyDispatch.status === 409 && earlyDispatch.code === 'PLAN_NOT_APPROVED', `status=${earlyDispatch.status} code=${earlyDispatch.code}`)
  const planV1Req = await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, {
    version: 1, plan: { facts: [`产线 ${line} 基线目标`] },
  }, H())
  const planV1Dec = planV1Req.data ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${planV1Req.data.id}/decide`, { approve: true, reason: '初始计划' }, H()) : null
  const afterPlanV1 = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  ok('P7c', 'owner 批准初始计划 → planVersion=1',
    planV1Req.status === 200 && planV1Dec?.status === 200 && afterPlanV1.data?.planVersion === 1,
    `req=${planV1Req.status} dec=${planV1Dec?.status} version=${afterPlanV1.data?.planVersion}`)

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
  const bUserResp0 = await api('POST', '/api/users', { name: `pl-b-${TAG}`, email: bEmail, password: bPassword, role: 'user' }, H())
  const bUserId = bUserResp0.data?.id
  const bToken = (await api('POST', '/api/users/login', { email: bEmail, password: bPassword })).data?.token
  const bGet = await api('GET', `/api/workshop/projects/${project.id}`, undefined, bToken)
  ok('P12', '非 owner 读取 Project → 403', bGet.status === 403, `status=${bGet.status}`)
  // PR10：leader 建频道提案（M5，proposal-only）
  const propChan = await invokeAgentTool(project.leadAgentId, 'project_propose_channel', {
    name: `质检频道-${TAG}`,
    charter: '负责质量抽检与复核',
  }, token)
  const propChanBody = parseToolJson(propChan)
  ok('P21a', 'project_leader 建频道提案（proposal only，不直建）',
    propChan.status === 200 && propChan.data?.result?.isError !== true && propChanBody?.status === 'proposed' && Boolean(propChanBody?.proposalId),
    `status=${propChan.status} text=${toolText(propChan).slice(0, 300)}`)
  const chanApply = propChanBody?.proposalId
    ? await api('POST', `/api/workshop/projects/${project.id}/proposals/${propChanBody.proposalId}/apply`, {}, H())
    : null
  ok('P21b', 'owner 应用建频道提案 → 频道创建并绑定',
    chanApply?.status === 200 && Boolean(chanApply.data?.channelId),
    `status=${chanApply?.status} body=${JSON.stringify(chanApply?.data ?? chanApply?.code).slice(0, 200)}`)
  const chanList2 = await api('GET', `/api/workshop/projects/${project.id}/channels`, undefined, H())
  ok('P21c', '提案频道出现在项目绑定列表',
    (chanList2.data ?? []).some(c => c.channelId === chanApply?.data?.channelId),
    `bound=${(chanList2.data ?? []).length} want=${chanApply?.data?.channelId}`)

  // PR10：项目成员（viewer/approver 团队协作）—— B 用户已在上方创建（bUserId）
  const memAdd = await api('POST', `/api/workshop/projects/${project.id}/members`, { userId: bUserId, role: 'viewer' }, H())
  const bGet2 = await api('GET', `/api/workshop/projects/${project.id}`, undefined, bToken)
  ok('P22a', 'owner 添加 B 为 viewer → B 可读项目（成员面）',
    memAdd.status === 200 && bGet2.status === 200 && bGet2.data?.id === project.id,
    `add=${memAdd.status} get=${bGet2.status} userId=${bUserId}`)
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

  const leadResults = await invokeAgentTool(member.leadAgentId, 'project_read_results', {}, token)
  const leadResultsBody = parseToolJson(leadResults)
  ok('P13c2', 'channel lead read_results 可见本频道 draft',
    Array.isArray(leadResultsBody) && leadResultsBody.some(r => r.id === draft.id && r.status === 'draft'),
    `text=${toolText(leadResults).slice(0, 300)}`)

  // PR10：viewer 成果按 line grant 过滤（B 无产线授权 → 空；owner(admin) 全量）
  const bResultsView = await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, bToken)
  const ownerResultsView = await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, H())
  ok('P22b', 'viewer 成果按 line grant 过滤（无授权=空，owner 可见）',
    bResultsView.status === 200 && (bResultsView.data ?? []).length === 0 && (ownerResultsView.data ?? []).length >= 1,
    `viewerRows=${(bResultsView.data ?? []).length} ownerRows=${(ownerResultsView.data ?? []).length}`)

  const submitted = await invokeAgentTool(member.leadAgentId, 'project_submit_result', {
    result_id: draft.id,
    summary: '基线良率 97.9%，数据窗口完整',
    method: '按产线/产品/配方取数',
  }, token)
  const submittedBody = parseToolJson(submitted)
  ok('P13d', '成果 submit（channel lead 工具）',
    submitted.status === 200 && submitted.data?.result?.isError !== true && submittedBody?.result?.status === 'submitted',
    `status=${submitted.status} text=${toolText(submitted).slice(0, 300)}`)

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

  const leaderPlanName = `Leader计划交付物-${TAG}`
  const proposePlan = await invokeAgentTool(project.leadAgentId, 'project_propose_plan', {
    plan: {
      deliverables: [{ key: 'd-leader', name: leaderPlanName, required: false, channelId: member.channelId }],
      work_items: [],
    },
  }, token)
  const proposedPlan = parseToolJson(proposePlan)
  ok('P14e1', 'project_leader 计划提案（proposal + plan_approval，v2）',
    proposePlan.status === 200 && proposePlan.data?.result?.isError !== true && Boolean(proposedPlan?.approvalId) && proposedPlan?.planVersion === 2,
    `status=${proposePlan.status} text=${toolText(proposePlan).slice(0, 300)}`)

  const planReq = await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, {
    version: 2,
    plan: { facts: [`产线 ${line} 已确认`], deliverables: [deliverable.id], workItems: [workItem.id] },
  }, H())
  ok('P14e2', '同版本计划审批幂等（leader 提案复用同一 approval）',
    planReq.status === 200 && planReq.data?.id === proposedPlan?.approvalId,
    `planReq=${planReq.status} id=${planReq.data?.id} proposed=${proposedPlan?.approvalId}`)
  const planAp = planReq.data
  // PR10：B 升级为 approver 并代 owner 决策计划审批（团队协作决策权）
  const memUp = await api('POST', `/api/workshop/projects/${project.id}/members`, { userId: bUserId, role: 'approver' }, H())
  const planDec = planAp ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${planAp.id}/decide`, { approve: true, reason: 'approver 成员批准' }, bToken) : null
  const afterPlan = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  const afterPlanDeliverables = await api('GET', `/api/workshop/projects/${project.id}/deliverables`, undefined, H())
  ok('P14e3', 'approver 成员批准 plan → planVersion=2 + leader 交付物物化',
    memUp.status === 200 && planDec?.status === 200 && planDec.data?.status === 'approved' && afterPlan.data?.planVersion === 2
    && (afterPlanDeliverables.data ?? []).some(d => d.name === leaderPlanName),
    `memUp=${memUp.status} planDec=${planDec?.status} version=${afterPlan.data?.planVersion} deliverables=${(afterPlanDeliverables.data ?? []).length}`)

  // PR8：write_intent 审批链（项目来源任务默认不可直写）
  const writeIntent = await invokeAgentTool(member.leadAgentId, 'project_request_write_intent', {
    tool: 'recipe_update',
    args: { nodeId: node, value: 121 },
    reason: 'E2E 验证 write_intent',
    task_id: root.id,
  }, token)
  const writeIntentBody = parseToolJson(writeIntent)
  ok('P20a', 'channel lead 申请 write_intent（pending + args digest）',
    writeIntent.status === 200 && writeIntent.data?.result?.isError !== true
    && writeIntentBody?.status === 'pending' && String(writeIntentBody?.digest ?? '').length === 64,
    `status=${writeIntent.status} text=${toolText(writeIntent).slice(0, 300)}`)
  const writeIntentDec = writeIntentBody?.approvalId
    ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${writeIntentBody.approvalId}/decide`, { approve: true, reason: '参数与计划一致' }, H())
    : null
  ok('P20b', 'owner 批准 write_intent', writeIntentDec?.status === 200 && writeIntentDec.data?.status === 'approved', `status=${writeIntentDec?.status}`)

  // ── PR14：plan §7.1 API 补全（update/retry/snapshot/trace/审批历史）──
  const patchProject = await api('PATCH', `/api/workshop/projects/${project.id}`, { description: 'PR14 更新的描述', mode: 'supervised' }, H())
  const decisionsAfterPatch = await api('GET', `/api/workshop/projects/${project.id}/decisions`, undefined, H())
  ok('P23a', 'PATCH 项目生效 + 审计 project.updated',
    patchProject.status === 200 && patchProject.data?.description === 'PR14 更新的描述'
    && (decisionsAfterPatch.data ?? []).some(d => d.decisionType === 'project.updated'),
    `status=${patchProject.status}`)

  const wi2 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: deliverable.id, channelId: member.channelId, title: `PR14 编辑项-${TAG}`, brief: 'x', dedupeKey: `pr14-edit:${TAG}`,
  }, H())).data
  const patchWi = await api('PATCH', `/api/workshop/projects/${project.id}/work-items/${wi2.id}`, { execBudgetMinutes: 45, brief: 'PR14 编辑后的 brief' }, H())
  ok('P23b', 'PATCH DRAFT 工作项生效', patchWi.status === 200 && patchWi.data?.execBudgetMinutes === 45, `status=${patchWi.status}`)

  const retryWi = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: deliverable.id, channelId: member.channelId, title: `PR14 重试项-${TAG}`, brief: 'x', dedupeKey: `pr14-retry:${TAG}`,
  }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/work-items/${retryWi.id}/dispatch`, {}, H())
  const retryTasks = await api('GET', `/api/workshop/channels/${member.channelId}/tasks`, undefined, H())
  const retryRoot = (retryTasks.data ?? []).find(t => t.projectWorkItemId === retryWi.id)
  const retryRotate = await api('POST', `/api/workshop/channels/${member.channelId}/agents/${member.leadAgentId}/rotate-token`, {}, H())
  await api('POST', `/api/workshop/tasks/${retryRoot.id}/complete`, { state: 'FAILED', closeReason: 'pr14 drill' }, retryRotate.data?.token).catch(async () => {
    // complete 接口不接受 state 参数时走 update 语义：忽略，改用 cancel/reconcile 路径
  })
  // 用 cancel+reconcile 保证 FAILED 终态（complete API 语义以 P13b 为准）
  const failedNow = await api('POST', `/api/workshop/projects/${project.id}/work-items/${retryWi.id}/cancel`, { reason: 'pr14 retry drill' }, H())
  const retryResp = await api('POST', `/api/workshop/projects/${project.id}/work-items/${retryWi.id}/retry`, {}, H())
  const retryAttempts = await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, H())
  const retryTarget = (retryAttempts.data ?? []).find(x => x.id === retryWi.id)
  ok('P23c', 'retry 重派工作项（cancel→retry attempt 递增）',
    failedNow.status === 200 && retryResp.status === 200 && retryResp.data?.state === 'DISPATCHED' && Boolean(retryTarget?.currentAttemptId),
    `cancel=${failedNow.status} retry=${retryResp.status} state=${retryResp.data?.state}`)

  const snapshot = await api('GET', `/api/workshop/projects/${project.id}/snapshot`, undefined, H())
  ok('P23d', 'snapshot 聚合（project/workItems/results/approvals+report）',
    snapshot.status === 200 && snapshot.data?.project?.id === project.id
    && Array.isArray(snapshot.data?.workItems) && Array.isArray(snapshot.data?.results)
    && Array.isArray(snapshot.data?.approvals?.pending) && Array.isArray(snapshot.data?.approvals?.history)
    && Boolean(snapshot.data?.report?.generatedAt),
    `status=${snapshot.status} wi=${(snapshot.data?.workItems ?? []).length}`)

  const traceId = root?.traceId
  const trace = traceId ? await api('GET', `/api/workshop/projects/${project.id}/trace/${encodeURIComponent(traceId)}`, undefined, H()) : null
  ok('P23e', 'trace 聚合（tasks/events/decisions by traceId）',
    trace?.status === 200 && trace.data?.traceId === traceId && trace.data?.summary?.tasks >= 1,
    `status=${trace?.status} summary=${JSON.stringify(trace?.data?.summary ?? null)}`)

  const history = await api('GET', `/api/workshop/projects/${project.id}/approvals?scope=all`, undefined, H())
  ok('P23f', '审批历史（scope=all 含已 approved）',
    history.status === 200 && (history.data ?? []).some(a => a.status === 'approved'),
    `rows=${(history.data ?? []).length}`)

  // P23g：清理 P23 道具（edit/cancel 未终态工作项），恢复完成门可达
  for (const wid of [wi2.id, retryWi.id]) {
    const cur = (await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, H())).data?.find(x => x.id === wid)
    if (cur && !['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(cur.state)) {
      await api('POST', `/api/workshop/projects/${project.id}/work-items/${wid}/cancel`, { reason: 'P23 cleanup' }, H())
    }
  }
  const workItemsClean = await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, H())
  ok('P23g', '完成门前工作项全部终态（cancel 豁免入口）',
    (workItemsClean.data ?? []).every(w => ['COMPLETED', 'CANCELED', 'SUPERSEDED'].includes(w.state)),
    `states=${(workItemsClean.data ?? []).map(w => w.state).join(',')}`)

  const completeReq = await api('POST', `/api/workshop/projects/${project.id}/complete`, {}, H())
  const completeAp = completeReq.data
  const completeDec = completeAp ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${completeAp.id}/decide`, { approve: true, reason: '交付物已验收' }, H()) : null
  const afterComplete = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  ok('P14f', '项目完成门禁 + owner 批准 → completed', completeDec?.status === 200 && afterComplete.data?.status === 'completed', `completeReq=${completeReq.status} completeDec=${completeDec?.status} status=${afterComplete.data?.status}`)

  // PR11：周报 API 数字与库同源（completed 项目快照）
  const report = await api('GET', `/api/workshop/projects/${project.id}/report`, undefined, H())
  const repD = report.data ?? {}
  const deliverablesFinal = await api('GET', `/api/workshop/projects/${project.id}/deliverables`, undefined, H())
  const resultsFinal = await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, H())
  ok('P17a', '周报 API 数字与库一致（交付物/成果/工作项/进度）',
    report.status === 200
    && repD.deliverables?.total === (deliverablesFinal.data ?? []).length
    && repD.results?.total === (resultsFinal.data ?? []).length
    && repD.workItems?.total > 0
    && typeof repD.progress?.ratio === 'number'
    && Boolean(repD.generatedAt),
    `status=${report.status} d=${repD.deliverables?.total} r=${repD.results?.total} w=${repD.workItems?.total} ratio=${repD.progress?.ratio}`)

  // ── PR17 M4 调度内核面（S2/S5/S7/S11：HealthBoard + Ledger + 手动 tick + 快照摘要） ──
  const health = await api('GET', `/api/workshop/projects/${project.id}/health`, undefined, H())
  ok('P24a', 'HealthBoard API（组件健康+effects 计数+计划版本+账本概览）',
    health.status === 200 && Array.isArray(health.data?.health) && typeof health.data?.effects === 'object'
    && typeof health.data?.ledger?.count === 'number' && health.data?.project?.planVersion >= 1,
    `status=${health.status} planV=${health.data?.project?.planVersion} ledger=${health.data?.ledger?.count} effects=${JSON.stringify(health.data?.effects ?? {})}`)

  const ledger = await api('GET', `/api/workshop/projects/${project.id}/ledger?limit=50`, undefined, H())
  ok('P24b', 'Progress Ledger API（里程碑条目 + 确定性 assessment）',
    ledger.status === 200 && (ledger.data?.items ?? []).length > 0
    && (ledger.data.items).every(i => typeof i.assessment === 'object'),
    `count=${ledger.data?.count} items=${(ledger.data?.items ?? []).length} first=${ledger.data?.items?.[0]?.summary ?? ''}`)

  const tick = await api('POST', `/api/workshop/projects/${project.id}/kernel/tick`, {}, H())
  ok('P24c', '内核手动 tick（owner 入口：事件消费/reconcile/effects/watchdog）',
    tick.status === 200 && tick.data?.ok === true && typeof tick.data?.ingress === 'object',
    `status=${tick.status} ok=${tick.data?.ok} ingress=${JSON.stringify(tick.data?.ingress ?? null)}`)

  const snap24 = await api('GET', `/api/workshop/projects/${project.id}/snapshot`, undefined, H())
  ok('P24d', 'snapshot.kernel 内核摘要（additive：health/effects/ledger/planApprovedVersion）',
    snap24.status === 200 && typeof snap24.data?.kernel === 'object'
    && Array.isArray(snap24.data.kernel.health) && typeof snap24.data.kernel.effects === 'object'
    && snap24.data.kernel.planApprovedVersion >= 1,
    `planApprovedV=${snap24.data?.kernel?.planApprovedVersion} ledger=${snap24.data?.kernel?.ledger?.count}`)

  // P17b（UI 交互矩阵）与 P18b（Live 全量/回滚）由 scripts/audit/project-g6-evidence.mjs
  // 在最终验收轮统一执行并归档至 gates/G5、gates/G6（本脚本不重复输出 blocked 占位）。

  finish()
}
catch (err) {
  console.error('验收脚本异常:', err)
  ok('P-EXCEPTION', '验收脚本异常', false, err instanceof Error ? err.message : String(err))
  finish()
}
