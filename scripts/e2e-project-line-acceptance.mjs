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

  // 未实现能力：必须 BLOCKED，不得算通过
  blocked('P13', '成果自动 draft / submit / review / approve', 'PR5 未实现')
  blocked('P14', 'project_approvals（plan/acceptance/complete/write_intent）', 'PR5 未实现')
  blocked('P15', 'ProjectReconciler（root 终态同步/逾期/阻塞）', 'PR5 未实现')
  blocked('P16', '审计 fail-closed（decisions/events 同事务）', 'PR5 未实现')
  blocked('P17', '项目页 UI / 周报 / 审批历史', 'PR6 未实现')
  blocked('P18', 'MAST L1–L14 / Live 全量 / G0–G6 证据', 'PR7 未执行')

  finish()
}
catch (err) {
  console.error('验收脚本异常:', err)
  ok('P-EXCEPTION', '验收脚本异常', false, err instanceof Error ? err.message : String(err))
  finish()
}
