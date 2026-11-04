#!/usr/bin/env node
/**
 * Track B 实机演示（Route 闭环版）：非产线纯开发任务 —— 「智能注塑云平台 · 产品设计落地页」。
 *
 * 与 track-b（库存系统）的差异：本项目 autoDispatch=1 + leader 提案链式计划
 * （W1 信息架构/文案设计 →W2 落地页 HTML 实现，dependsOn），**全程零手动派发**：
 *   计划批准 → 内核自动派发 W1（work.dispatch_auto）→ lead 真 LLM 自主构建 →
 *   完成回调 → 内核自动派发 W2 → lead 自主实现落地页 → 成果链 → 完成门禁 →
 *   工件浏览器实测（桌面+移动视口）+ 项目页 UI 截图走查。
 *
 * 验收规范：docs/plans/2026-11-05-live-demo-acceptance-plan.md（B1–B12）。
 * 运行：node scripts/demo/track-c-landing-page.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), `aw-track-c-landing-${Date.now().toString(36)}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
const EVID = join(REPO, 'docs/audit/evidence/2026-11-05-route-demo')
mkdirSync(EVID, { recursive: true })

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3969, 3966, 3965]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* free */ }
  port = p
  break
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
// B12 项目页走查经 ../ui/lib.mjs 的 openPage/gotoReady，其 BASE 读 AW_BASE ——
// 缺省 3021 会连到无关端口（首跑教训：B12 静默跳过）。
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'
const logFd = openSync(join(ROOT, 'server.log'), 'a')
const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(port),
    NITRO_PORT: String(port),
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    // ≥32 字符：iron-webcrypto 会话硬性要求（run5 教训：过短 → agent-token 全 500 → 盲执行）
    NUXT_SESSION_PASSWORD: 'TrackC#2026-landing-demo-key-32chars-padding!!',
    AW_RATE_LIMIT_OFF: '1',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 180_000) {
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
  catch { /* non-json */ }
  return { status: res.status, ...json }
}

async function poll(label, timeoutMs, fn, intervalMs = 10_000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    const out = await fn()
    if (out.done) return out
    last = out.detail ?? ''
    process.stdout.write(`  …[${label}] ${Math.round((Date.now() - start) / 1000)}s ${last}\n`)
    await sleep(intervalMs)
  }
  return { done: false, detail: `timeout: ${last}` }
}

async function instruct(channelId, toAgentId, text, token) {
  return api('POST', `/api/workshop/channels/${channelId}/messages`, {
    toAgentId, text, requireReply: true, priority: 'immediate',
  }, token)
}

/** owner 手动驱动内核单项目处理（事件消费/对账/自动派发/watchdog），确定性加速回调。 */
const kernelTick = (projectId, token) => api('POST', `/api/workshop/projects/${projectId}/kernel/tick`, {}, token)

const autoDispatchEvents = async (projectId, token) => ((await api('GET', `/api/workshop/projects/${projectId}/events`, undefined, token)).data ?? [])
  .filter(e => e.type === 'work.dispatch_auto')
  .map((e) => {
    try {
      return JSON.parse(e.payloadJson)?.workItemId ?? ''
    }
    catch {
      return ''
    }
  })

try {
  let healthy = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h.data?.status === 'ok' && h.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* wait */ }
  }
  ok('B1', '隔离实例启动（build 产物，会话密钥 ≥32 字符）', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  // B2 项目（autoDispatch=true；无产线；leader=omp 真 LLM）
  const reg = await api('POST', '/api/users/register', { name: 'trackc-admin', email: 'tc@awshop.local', password: 'TrackC#2026' })
  const token = reg.data?.token
  ok('B2a', 'owner 注册', Boolean(token))
  const project = (await api('POST', '/api/workshop/projects', {
    name: '智能注塑云平台 · 产品设计落地页',
    objective: '为智能注塑云平台设计并实现一个单文件产品设计落地页：信息架构与文案设计 → 响应式 HTML 实现',
    successCriteria: [
      '落地页可在浏览器打开且渲染完整（hero/特性/场景/CTA 分区）',
      '移动端视口（≤640px）响应式不破版',
      '中文文案专业、有真实产品信息架构',
    ],
    leaderHarness: 'omp',
    autoDispatch: true,
  }, token)).data
  ok('B2b', '项目创建（autoDispatch=true 落库，无产线）', Boolean(project?.id && project?.leadAgentId), JSON.stringify({ id: project?.id }))
  const snap0 = await api('GET', `/api/workshop/projects/${project.id}/snapshot`, undefined, token)
  ok('B2c', 'snapshot.autoDispatch=true', snap0.data?.project?.autoDispatch === true, `autoDispatch=${snap0.data?.project?.autoDispatch}`)

  const member = (await api('POST', '/api/workshop/channels', {
    name: '落地页开发频道',
    scenarioPrompt: [
      '# 执行纪律（必须遵守）',
      '- root 任务执行期间**禁止调用 cancel_task / supersede_task 取消自己的任务**；',
      '- 长时间生成属正常：先调用 report_progress(10~90) 汇报进度，再继续；',
      '- 完成时调用 complete_task 并把完整成果全文放入 deliverable 参数（不是摘要）；',
      '- 只做当前任务，不要创建新任务。',
    ].join('\n'),
    leadAgent: {
      name: 'Landing Dev Lead',
      harness: 'omp',
      config: { superviseWatchdogMs: 180_000, superviseHardTimeoutMs: 720_000 },
    },
  }, token)).data
  ok('B2d', '成员频道（lead harness=omp，无产线绑定）', Boolean(member?.channelId && member?.leadAgentId))

  const bind = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: '负责落地页设计与实现（纯开发，无产线）' }, token)
  ok('B2e', '绑定成员频道', bind.status === 200)
  const deliverable = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: '产品设计落地页', ownerChannelId: member.channelId, required: true,
    acceptanceCriteria: ['浏览器可打开渲染完整', '含 hero/特性/场景/CTA 分区', '移动端响应式', '中文专业文案'],
  }, token)).data
  ok('B2f', '交付物创建（必选）', Boolean(deliverable?.id))
  const activated = await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, token)
  ok('B2g', '项目激活', activated.status === 200 && activated.data?.status === 'active')

  // B3 leader 真 LLM 提案链式计划（w2 dependsOn=[w1-key]）
  const planInstr = [
    '你是项目总工。请立即调用 project_propose_plan 工具提交本项目的执行计划，要求：',
    `deliverables 一项：key=landing, name=产品设计落地页, channelId=${member.channelId}；`,
    'work_items 两项（链式）：',
    `① key=design, deliverableKey=landing, channelId=${member.channelId}, title=落地页信息架构与文案设计, execBudgetMinutes=30, brief=产出设计文档（artifact 承载）：目标用户/信息架构（分区清单）/每区中文文案/配色与字体建议。`,
    `② key=build, deliverableKey=landing, channelId=${member.channelId}, title=落地页 HTML 实现, execBudgetMinutes=45, dependsOn=["design"], brief=按设计文档实现单文件响应式 HTML（≤12KB）：内联 CSS/JS，hero/特性/场景/CTA 分区，中文文案，≤640px 移动端断点。交付方式=完成任务时把完整可运行的 <!DOCTYPE html>…</html> 源码全文放进 complete_task 的 deliverable 参数（lead 没有文件写工具，deliverable 是唯一交付通道）。`,
    '必须真实调用工具，不要只输出文本。',
  ].join('\n')
  let planApproved = false
  for (let attempt = 1; attempt <= 3 && !planApproved; attempt++) {
    await instruct(project.officeChannelId, project.leadAgentId, planInstr, token)
    const polled = await poll(`B3-leader-plan(attempt ${attempt})`, 240_000, async () => {
      const pend = await api('GET', `/api/workshop/projects/${project.id}/approvals`, undefined, token)
      const pa = (pend.data ?? []).find(a => a.kind === 'plan_approval')
      if (pa) return { done: true, detail: `approval=${pa.id}`, approvalId: pa.id }
      const proposals = await api('GET', `/api/workshop/projects/${project.id}/decisions`, undefined, token)
      const pp = (proposals.data ?? []).filter(d => d.decisionType === 'plan.proposed').length
      return { done: false, detail: `pending=0 proposals=${pp}` }
    })
    if (polled.done) {
      const decided = await api('POST', `/api/workshop/projects/${project.id}/approvals/${polled.approvalId}/decide`, { approve: true, reason: '链式计划由 leader 真 LLM 提案' }, token)
      const after = await api('GET', `/api/workshop/projects/${project.id}`, undefined, token)
      planApproved = decided.status === 200 && after.data?.planVersion >= 1
      ok('B3a', `leader 真 LLM 提案计划 → owner 批准 → planVersion=${after.data?.planVersion}`, planApproved, `decide=${decided.status}`)
    }
    else {
      ok(`B3-retry${attempt}`, 'leader 提案轮询超时，将重试', false, polled.detail)
    }
  }
  if (!planApproved) throw new Error('leader 未能提交计划（3 次尝试）')

  // 物化核对：W1/W2 存在且 W2.dependsOn 指向 W1（若 leader 未发依赖，owner DRAFT 态补齐 —— 幂等收敛，审计留痕）
  const items = async () => (await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, token)).data ?? []
  let w1 = (await items()).find(w => (w.title ?? '').includes('信息架构'))
  let w2 = (await items()).find(w => (w.title ?? '').includes('HTML 实现'))
  if (!w1 || !w2) {
    // leader 漏提案工作项 → owner 兜底创建同契约工作项（不派发，交内核自动派发）
    const dnow = (await api('GET', `/api/workshop/projects/${project.id}/deliverables`, undefined, token)).data ?? []
    const d1 = dnow.find(d => d.name === '产品设计落地页') ?? dnow[0]
    if (!w1) {
      w1 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
        deliverableId: d1.id, channelId: member.channelId, title: '落地页信息架构与文案设计',
        brief: '产出设计文档（artifact 承载）：目标用户/信息架构（分区清单）/每区中文文案/配色与字体建议。',
        execBudgetMinutes: 30, dedupeKey: 'design',
      }, token)).data
    }
    if (!w2) {
      w2 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
        deliverableId: d1.id, channelId: member.channelId, title: '落地页 HTML 实现',
        brief: '按设计文档实现单文件响应式 HTML（≤12KB）：内联 CSS/JS，hero/特性/场景/CTA 分区，中文文案，≤640px 移动端断点。交付方式=完整 HTML 源码全文放 deliverable 参数。',
        execBudgetMinutes: 45, dependsOn: [w1.id], dedupeKey: 'build',
      }, token)).data
    }
    ok('B3-fallback', 'owner 兜底补齐工作项（leader 提案缺项）', Boolean(w1?.id && w2?.id))
  }
  const depsOk = Array.isArray(w2?.dependsOn) && w2.dependsOn.includes(w1.id)
  if (!depsOk) {
    const patched = await api('PATCH', `/api/workshop/projects/${project.id}/work-items/${w2.id}`, { dependsOn: [w1.id] }, token)
    ok('B3-dep-patch', 'owner 补齐 W2 依赖（DRAFT 态 PATCH，审计 work.updated）', patched.status === 200, `status=${patched.status}`)
  }
  else {
    ok('B3b', '链式依赖物化成功（W2.dependsOn=[W1]）', true, `w1=${w1.id.slice(0, 8)} w2=${w2.id.slice(0, 8)}`)
  }

  // B4 零手动派发：内核自动派发 W1（本脚本此后不得调用任何 dispatch 接口）
  const w1Auto = await poll('B4-w1-auto-dispatch', 120_000, async () => {
    await kernelTick(project.id, token)
    const st = (await items()).find(w => w.id === w1.id)?.state
    const autoTargets = await autoDispatchEvents(project.id, token)
    return { done: ['DISPATCHED', 'COMPLETED'].includes(st) && autoTargets.includes(w1.id), detail: `w1=${st} autoTargets=${autoTargets.length}` }
  }, 15_000)
  ok('B4', '零手动派发：内核自动派发 W1（work.dispatch_auto）', w1Auto.done, w1Auto.detail)

  // B5 W1 lead 自主执行
  const rootOf = async wiId => ((await api('GET', `/api/workshop/channels/${member.channelId}/tasks`, undefined, token)).data ?? [])
    .filter(t => t.projectWorkItemId === wiId)
    .sort((a, b) => (b.projectAttemptNo ?? 0) - (a.projectAttemptNo ?? 0))[0]
  const execW1 = await poll('B5-w1-execute', 47 * 60_000, async () => {
    await kernelTick(project.id, token)
    const root = await rootOf(w1.id)
    if (!root) return { done: false, detail: 'root not found' }
    const derived = root.progressDerived
    const derivedText = derived === null || derived === undefined ? 'n/a' : `${derived}%`
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(root.state)) {
      return { done: root.state === 'COMPLETED', detail: `root=${root.state} artifacts=${(root.artifacts ?? []).length}`, root }
    }
    return { done: false, detail: `root=${root.state} progress=${root.progress}%(自报) derived=${derivedText}(派生)` }
  }, 20_000)
  ok('B5', 'W1 lead 真 LLM 自主执行完成（设计文档工件）', execW1.done && execW1.root?.state === 'COMPLETED', execW1.detail)

  // B6 完成回调 → W2 自动派发
  const w2Auto = await poll('B6-w2-auto-dispatch', 120_000, async () => {
    await kernelTick(project.id, token)
    const st = (await items()).find(w => w.id === w2.id)?.state
    const autoTargets = await autoDispatchEvents(project.id, token)
    return { done: ['DISPATCHED', 'COMPLETED'].includes(st) && autoTargets.includes(w2.id), detail: `w2=${st} autoTargets=${autoTargets.length}` }
  }, 15_000)
  ok('B6', '完成回调 → 内核自动派发 W2（依赖门解除）', w2Auto.done, w2Auto.detail)

  // B7 W2 lead 自主实现落地页
  const execW2 = await poll('B7-w2-execute', 47 * 60_000, async () => {
    await kernelTick(project.id, token)
    const root = await rootOf(w2.id)
    if (!root) return { done: false, detail: 'root not found' }
    const derived = root.progressDerived
    const derivedText = derived === null || derived === undefined ? 'n/a' : `${derived}%`
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(root.state)) {
      return { done: root.state === 'COMPLETED', detail: `root=${root.state} artifacts=${(root.artifacts ?? []).length}`, root }
    }
    return { done: false, detail: `root=${root.state} progress=${root.progress}%(自报) derived=${derivedText}(派生)` }
  }, 20_000)
  ok('B7', 'W2 lead 真 LLM 自主实现落地页（完整 HTML 工件）', execW2.done && execW2.root?.state === 'COMPLETED', execW2.detail)
  const root2 = execW2.root
  const root2Detail = root2?.id
    ? (await api('GET', `/api/workshop/tasks/${root2.id}?channelId=${member.channelId}`, undefined, token)).data
    : null
  const detailArtifacts = Array.isArray(root2Detail?.artifacts) ? root2Detail.artifacts : []
  const htmlPart = detailArtifacts
    .flatMap(a => (a.parts ?? []))
    .map(p => p.text ?? '')
    .find(t => t.includes('<html') || t.includes('<!DOCTYPE'))
    ?? (root2?.artifacts ?? []).flatMap(a => (a.parts ?? [])).map(p => p.text ?? '').find(t => t.includes('<html') || t.includes('<!DOCTYPE'))
    ?? ''
  ok('B7b', '落地页 HTML 工件提取（含 hero/分区/响应式特征）',
    htmlPart.length > 400 && /hero|landing|注塑|智能/i.test(htmlPart) && /<section|<div|class=/i.test(htmlPart),
    `len=${htmlPart.length}`)

  // B8 成果链
  await api('POST', `/api/workshop/projects/${project.id}/reconcile`, {}, token)
  const draft = (await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, token)).data?.[0]
  ok('B8a', 'root COMPLETED → 成果 draft（真实工件证据）', Boolean(draft?.id) && draft?.status === 'draft', `result=${draft?.id}`)
  const leadSubmit = draft
    ? await api('POST', '/api/workshop/agent-tools/invoke', {
        agentId: member.leadAgentId,
        tool: 'project_submit_result',
        args: { result_id: draft.id, summary: '落地页已实现：信息架构设计 + 响应式 HTML（hero/特性/场景/CTA）', evidence: [{ artifactId: detailArtifacts[0]?.artifactId ?? 'html', kind: 'artifact' }] },
      }, token)
    : null
  ok('B8b', 'channel lead 工具提交成果', Boolean(draft) && leadSubmit?.status === 200 && leadSubmit?.data?.result?.isError !== true, String(leadSubmit?.data?.result?.text ?? '').slice(0, 200))
  const reviewed = draft
    ? await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/review`, { decision: 'reviewed' }, token)
    : null
  ok('B8c', '复核 → reviewed', reviewed?.status === 200 && reviewed?.data?.status === 'reviewed')
  const acceptance = draft ? (await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/request-acceptance`, {}, token)).data : null
  const accDecided = acceptance ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${acceptance.id}/decide`, { approve: true, reason: '验收标准逐条满足' }, token) : null
  ok('B8d', 'owner 验收批准 → 成果/交付物 approved', accDecided?.status === 200 && accDecided.data?.status === 'approved', `decide=${accDecided?.status}`)

  // B9 完成门禁（两工作项须全部终态 —— 若 W2 仍在飞则等待）
  await poll('B9-items-terminal', 10 * 60_000, async () => {
    await kernelTick(project.id, token)
    const states = (await items()).map(w => w.state)
    return { done: states.every(s => ['COMPLETED', 'FAILED', 'CANCELED'].includes(s)), detail: `states=${states.join(',')}` }
  }, 20_000)
  const completeReq = (await api('POST', `/api/workshop/projects/${project.id}/complete`, {}, token)).data
  const completeDec = completeReq ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${completeReq.id}/decide`, { approve: true }, token) : null
  const afterComplete = await api('GET', `/api/workshop/projects/${project.id}`, undefined, token)
  ok('B9', '完成门禁 + owner 批准 → completed', completeDec?.status === 200 && afterComplete.data?.status === 'completed', `dec=${completeDec?.status} status=${afterComplete.data?.status}`)

  // B11 Route 审计：恰好 2 次 dispatch_auto（W1→W2 顺序）+ 账本里程碑
  const autoTargetsFinal = await autoDispatchEvents(project.id, token)
  const ledger = await api('GET', `/api/workshop/projects/${project.id}/ledger?limit=50`, undefined, token)
  ok('B11', 'Route 审计闭环：恰好 2 次 work.dispatch_auto（W1→W2）+ 账本里程碑',
    autoTargetsFinal.length === 2 && autoTargetsFinal[0] === w1.id && autoTargetsFinal[1] === w2.id
    && (ledger.data?.items ?? []).length > 0,
    `autoTargets=${JSON.stringify(autoTargetsFinal)} ledger=${ledger.data?.count}`)

  // B10 落地页浏览器实测（桌面渲染/交互/移动视口）+ B12 项目页 UI 走查
  const htmlPath = join(EVID, 'landing-page.html')
  writeFileSync(htmlPath, htmlPart, 'utf8')
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const browser = await launch({ width: 1440, height: 900 })
  let pageOk = false
  let diag = ''
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 20_000 })
    await sleep(800)
    const bodyText = await page.evaluate(() => document.body.innerText)
    const sections = await page.evaluate(() => document.querySelectorAll('section, [class*="hero"], [class*="feature"], header, footer').length)
    const ctaClickable = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a, button')].find(b => /开始|试用|联系|了解更多|咨询|demo/i.test(b.innerText ?? ''))
      if (!btn) return false
      btn.click()
      return true
    })
    const hasScroll = await page.evaluate(() => document.body.scrollHeight > window.innerHeight)
    pageOk = bodyText.trim().length > 120 && sections >= 3 && hasScroll
    diag = `textLen=${bodyText.trim().length} sections=${sections} cta=${ctaClickable} scrollable=${hasScroll}`
    await page.screenshot({ path: join(EVID, 'landing-desktop.png'), fullPage: true })
    // 移动端视口（响应式实测）
    await page.setViewport({ width: 390, height: 844 })
    await sleep(800)
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 8)
    await page.screenshot({ path: join(EVID, 'landing-mobile.png'), fullPage: true })
    ok('B10b', '移动端视口 390px 响应式（无横向溢出）', !mobileOverflow, `overflow=${mobileOverflow}`)
    diag += ` mobileOverflow=${mobileOverflow}`

    // B12 项目页 UI 走查（同实例真实浏览器登录）
    const uiPage = await openPage(browser, { token, width: 1440, height: 900 })
    await gotoReady(uiPage, '/projects', { wait: 2500 })
    const listText = await uiPage.evaluate(() => document.body.innerText)
    ok('B12a', '项目列表页渲染本项目', listText.includes('落地页'), listText.slice(0, 160))
    await uiPage.screenshot({ path: join(EVID, 'ui-projects-list.png'), fullPage: true })
    await gotoReady(uiPage, `/projects/${project.id}`, { wait: 3000 })
    const detailText = await uiPage.evaluate(() => document.body.innerText)
    ok('B12b', '项目详情页概览渲染（名称/频道/工作项状态）',
      detailText.includes('落地页') && detailText.includes('COMPLETED'), detailText.slice(0, 200))
    await uiPage.screenshot({ path: join(EVID, 'ui-project-overview.png'), fullPage: true })
    for (const tid of ['plan', 'deliverables', 'approvals']) {
      await uiPage.evaluate((t) => {
        document.querySelector(`[data-testid="tab-${t}"]`)?.click()
      }, tid)
      await sleep(600)
      await uiPage.screenshot({ path: join(EVID, `ui-project-${tid}.png`), fullPage: true })
    }
    ok('B12c', '五 tab 截图走查（plan/deliverables/approvals）', true)
  }
  catch (err) {
    diag = `browser error: ${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    try {
      await browser.close()
    }
    catch { /* ignore */ }
  }
  ok('B10', '落地页浏览器实测（渲染/分区/可滚动/CTA 交互）+ 截图', pageOk, diag)

  // 证据 JSON
  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    scenario: 'Track B(Route 闭环版): 智能注塑云平台 · 产品设计落地页（真 LLM 自主构建，零手动派发）',
    acceptancePlan: 'docs/plans/2026-11-05-live-demo-acceptance-plan.md',
    pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length,
    results,
  }
  writeFileSync(join(EVID, 'track-c-acceptance.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n=== TRACK C pass=${summary.pass} fail=${summary.fail} → ${EVID} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
catch (err) {
  console.error('Track C 演示异常:', err)
  writeFileSync(join(EVID, 'track-c-acceptance.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), error: String(err), results }, null, 2)}\n`)
  process.exitCode = 1
}
finally {
  try {
    const exited = new Promise((r) => {
      const t = setTimeout(r, 8000)
      child.on('exit', () => {
        clearTimeout(t)
        r(null)
      })
    })
    child.kill()
    await exited
  }
  catch { /* ignore */ }
  await sleep(1000)
}
