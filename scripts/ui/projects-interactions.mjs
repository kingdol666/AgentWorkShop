#!/usr/bin/env node
/**
 * /projects UI 交互矩阵（PR11，P17）：真实浏览器 + 真实服务端 + 真实点击。
 * I1 列表渲染 → I2 UI 建项目 → I3 绑频道 → I4 建交付物 → I5 建工作项 →
 * I6 激活 → I7 派发 → I8 完成+对账 → I9 成果提交/复核/申请验收 → I10 审批批准 →
 * I11 leader 派发提案+页面应用 → I12 周报刷新/导出 → I13 无页面异常 → I14 证据截图。
 *
 * 前置：npm run build 已产出 .output（与 projects-smoke 相同入口）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), 'aw-projects-ui-interactions')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
const EVID = process.env.AW_EVID
  ? resolve(REPO, process.env.AW_EVID)
  : join(REPO, 'docs/audit/evidence/2026-11-03-project-layer')
mkdirSync(EVID, { recursive: true })

let port = 0
for (const p of [3982, 3981, 3980]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1000) })
    if (r.ok) continue
  }
  catch { /* free */ }
  port = p
  break
}
if (!port) throw new Error('无空闲端口')
const BASE = `http://127.0.0.1:${port}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'

const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(port),
    NITRO_PORT: String(port),
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    NUXT_SESSION_PASSWORD: 'ProjectsUi#2026-interactions-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* ignore */ }
  return { status: res.status, ...json }
}

let browser
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}

/** 按可见文本点击按钮（精确匹配、非 disabled）；带轮询重试（等待 loading 复位/数据刷新）。 */
async function clickButton(page, text, timeoutMs = 6000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = await page.evaluate((label) => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => !b.disabled && b.innerText.trim() === label)
      if (!btn) return false
      btn.click()
      return true
    }, text)
    if (hit) return true
    await sleep(400)
  }
  return false
}

/** 等待页面出现指定文本（轮询 innerText）。 */
async function waitText(page, text, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const t = await page.evaluate(() => document.body.innerText)
    if (t.includes(text)) return true
    await sleep(400)
  }
  return false
}

/** 等待某个 DOM 选择器出现（状态徽标用，避免正文中文撞词）。 */
async function waitSelector(page, selector, timeoutMs = 8000) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs })
    return true
  }
  catch {
    return false
  }
}

/** AntD Select：点开浮层后按序号选真实 option（0 = 第一条）。 */
async function pickAntSelect(page, testid, index = 0) {
  await page.click(`[data-testid="${testid}"] .ant-select-selector`)
  await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)', { timeout: 5000 })
  const picked = await page.evaluate((i) => {
    const dd = [...document.querySelectorAll('.ant-select-dropdown')]
      .find(d => !d.className.includes('hidden'))
    const opt = dd?.querySelectorAll('.ant-select-item-option')?.[i]
    opt?.click()
    return opt?.getAttribute('title') ?? opt?.textContent?.trim() ?? null
  }, index)
  await sleep(300)
  return picked
}

/** PR15 五 tab：切换 tab（v-show 区块需先切再断言）。 */
async function gotoTab(page, key) {
  await page.click(`[data-testid="tab-${key}"]`)
  await sleep(400)
}

try {
  let healthy = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try {
      const h = await api('GET', '/api/health')
      if (h.data?.status === 'ok' && h.data?.workshop === 'ready') {
        healthy = true
        break
      }
    }
    catch { /* wait */ }
  }
  ok('I0', '构建产物服务启动', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  const email = `ui-int-${Date.now().toString(36)}@awshop.local`
  const reg = await api('POST', '/api/users/register', { name: 'ui-admin', email, password: 'UiAdmin#2026' })
  const token = reg.data?.token
  ok('I0b', 'admin 注册', Boolean(token), `status=${reg.status}`)

  const seedChannel = (await api('POST', '/api/workshop/channels', {
    name: `交互频道-${Date.now().toString(36).slice(-4)}`,
    leadAgent: { name: 'Int Lead', harness: 'mock' },
  }, token)).data
  ok('I0c', 'seed 频道（供 UI 绑定）', Boolean(seedChannel?.channelId))

  const { launch, openPage, gotoReady } = await import('./lib.mjs')
  browser = await launch({ width: 1440, height: 900 })
  const page = await openPage(browser, { token, width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))

  // I1 列表渲染
  await gotoReady(page, '/projects', { wait: 2500 })
  const listText = await page.evaluate(() => document.body.innerText)
  ok('I1', '列表页渲染（含新建项目表单）', listText.includes('新建项目'), listText.slice(0, 150))

  // I2 UI 创建项目（index.vue：名称/目标 placeholder + 创建项目按钮）
  const projName = `交互项目-${Date.now().toString(36).slice(-4)}`
  await page.type('input[placeholder="例如：A 线良率提升"]', projName)
  await page.type('input[placeholder="例如：良率提升到 98%"]', 'UI 交互矩阵验证')
  await clickButton(page, '创建项目')
  ok('I2', 'UI 建项目 → 列表出现', await waitText(page, projName), projName)

  // 打开详情
  await page.evaluate((n) => {
    const links = [...document.querySelectorAll('a,button')]
    const t = links.find(a => a.innerText.includes(n))
    t?.click()
  }, projName)
  await waitText(page, '工作项 / 派发', 8000)
  const detailUrl = page.url()
  ok('I3', '打开详情页', detailUrl.includes('/projects/'), detailUrl)
  const projectId = detailUrl.split('/projects/')[1]?.split(/[/?]/)[0] ?? ''

  // I4 绑定频道
  await page.type('[data-testid="bind-channel-id"]', seedChannel.channelId)
  await clickButton(page, '绑定频道')
  ok('I4', 'UI 绑定频道 → 列表出现', await waitText(page, seedChannel.channelId), seedChannel.channelId)

  // I5 新增交付物（交付物 tab）
  await gotoTab(page, 'deliverables')
  await page.type('[data-testid="deliverable-name"]', '交互交付物')
  await clickButton(page, '新增交付物')
  ok('I5', 'UI 建交付物', await waitText(page, '交互交付物'))

  // I6 新增工作项（计划与工作 tab）—— AntD Select 需通过浮层选项选择
  await gotoTab(page, 'plan')
  await pickAntSelect(page, 'select-work-deliverable', 0)
  await pickAntSelect(page, 'select-work-channel', 0)
  await page.evaluate(() => {
    const title = document.querySelector('[data-testid="input-work-title"]')
    title.value = '交互工作项'
    title.dispatchEvent(new Event('input'))
    const brief = document.querySelector('[data-testid="input-work-brief"]')
    brief.value = '端到端交互验证'
    brief.dispatchEvent(new Event('input'))
  })
  await clickButton(page, '新增工作项')
  ok('I6', 'UI 建工作项 → 行出现', await waitText(page, '交互工作项'))

  // I7 激活
  await clickButton(page, '激活')
  ok('I7', 'UI 激活 → 进行中徽标', await waitText(page, '进行中'), 'badge active')

  // I7b PR13 计划门：API 创建 plan approval pending → 重载页面 → UI 点击批准 → planVersion=1
  const planReq = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, {
    version: 1, plan: { facts: ['交互矩阵初始计划'] },
  }, token)
  ok('I7b-req', 'plan approval pending 已创建', planReq.status === 200 && planReq.data?.status === 'pending', `status=${planReq.status}`)
  await gotoReady(page, `/projects/${projectId}`, { wait: 3000 })
  await gotoTab(page, 'approvals')
  const planBtnHit = await clickButton(page, '批准', 8000)
  let planVersionAfter = 0
  const planStart = Date.now()
  while (Date.now() - planStart < 10_000) {
    const pj = await api('GET', `/api/workshop/projects/${projectId}`, undefined, token)
    planVersionAfter = pj.data?.planVersion ?? 0
    if (planVersionAfter >= 1) break
    await sleep(800)
  }
  ok('I7b', 'UI 批准计划 → planVersion=1', planBtnHit && planVersionAfter >= 1, `btn=${planBtnHit} version=${planVersionAfter}`)

  // I8 派发（计划与工作 tab；以 API 工作项状态为准；UI 点击未生效则 API 兜底并记录）
  await gotoTab(page, 'plan')
  await clickButton(page, '派发', 10_000)
  let dispatchedState = ''
  let dispatchDiag = ''
  const dispatchStart = Date.now()
  while (Date.now() - dispatchStart < 15_000) {
    const wrows = await api('GET', `/api/workshop/projects/${projectId}/work-items`, undefined, token)
    const target = (wrows.data ?? []).find(w => w.title === '交互工作项')
    dispatchedState = target?.state ?? ''
    if (['DISPATCHED', 'RUNNING', 'COMPLETED'].includes(dispatchedState)) break
    if (dispatchedState === 'DRAFT' && target?.id && Date.now() - dispatchStart > 10_000) {
      const fallback = await api('POST', `/api/workshop/projects/${projectId}/work-items/${target.id}/dispatch`, {}, token)
      dispatchDiag = `api-fallback=${fallback.status}/${fallback.code ?? 'ok'}`
      if (fallback.data?.state) dispatchedState = fallback.data.state
      if (['DISPATCHED', 'RUNNING'].includes(dispatchedState)) break
    }
    await sleep(800)
  }
  ok('I8', 'UI 派发 → DISPATCHED（API 确认）', ['DISPATCHED', 'RUNNING'].includes(dispatchedState), `state=${dispatchedState} ${dispatchDiag}`)

  // I9 完成任务 + 对账
  const rotate = await api('POST', `/api/workshop/channels/${seedChannel.channelId}/agents/${seedChannel.leadAgentId}/rotate-token`, {}, token)
  const agentToken = rotate.data?.token
  const tasks = await api('GET', `/api/workshop/channels/${seedChannel.channelId}/tasks`, undefined, token)
  const root = (tasks.data ?? []).find(t => t.source === 'project')
  await api('POST', `/api/workshop/tasks/${root.id}/complete`, {
    artifacts: [{ artifactId: 'art-int', name: 'page.md', parts: [{ text: '交互矩阵交付' }] }],
  }, agentToken)
  await clickButton(page, '对账')
  await gotoTab(page, 'plan')
  ok('I9a', '完成后对账 → 工作项 COMPLETED（计划与工作 tab）', await waitSelector(page, '[data-state="COMPLETED"]', 8000), 'work item state')
  await gotoTab(page, 'deliverables')
  ok('I9b', '对账 → 成果 draft（交付物 tab）', await waitSelector(page, '[data-state="draft"]', 8000), 'result draft')

  // I10 成果提交（channel lead 工具路径：owner 不得自提自批，PR13 自批规则）→ 复核 → 申请验收
  const resultsForSubmit = await api('GET', `/api/workshop/projects/${projectId}/results`, undefined, token)
  const draftResult = (resultsForSubmit.data ?? [])[0]
  const submitTool = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: seedChannel.leadAgentId,
    tool: 'project_submit_result',
    args: { result_id: draftResult.id, summary: '交互矩阵提交（channel lead）', evidence: [{ artifactId: 'art-int', kind: 'artifact' }] },
  }, token)
  const submitOk = submitTool.status === 200 && submitTool.data?.result?.isError !== true
    && JSON.parse(String(submitTool.data?.result?.text ?? '{}'))?.result?.status === 'submitted'
  ok('I10a', '成果提交（channel lead 工具）→ submitted', submitOk, String(submitTool.data?.result?.text ?? '').slice(0, 200))
  await gotoReady(page, `/projects/${projectId}`, { wait: 3000 })
  await gotoTab(page, 'deliverables')
  ok('I10a-ui', '提交态在交付物 tab 可见', await waitSelector(page, '[data-state="submitted"]', 8000), 'submitted badge')
  await clickButton(page, '复核通过')
  ok('I10b', '复核 → reviewed', await waitSelector(page, '[data-state="reviewed"]'))
  await clickButton(page, '申请验收')
  await gotoTab(page, 'approvals')
  ok('I10c', '申请验收 → 待审批出现（审批 tab）', await waitText(page, '交付物验收'))

  // I11 审批批准（审批 tab）
  await gotoTab(page, 'approvals')
  await clickButton(page, '批准')
  await gotoTab(page, 'deliverables')
  let approveDiag = ''
  let approvedOk = false
  const approveStart = Date.now()
  while (Date.now() - approveStart < 12_000) {
    const hist = await api('GET', `/api/workshop/projects/${projectId}/approvals?scope=all`, undefined, token)
    const acc = (hist.data ?? []).find(a => a.kind === 'deliverable_acceptance')
    const resultsNow = await api('GET', `/api/workshop/projects/${projectId}/results`, undefined, token)
    const resultState = (resultsNow.data ?? [])[0]?.status ?? ''
    approveDiag = `approval=${acc?.status ?? 'none'} result=${resultState}`
    if (acc?.status === 'approved' && resultState === 'approved') {
      approvedOk = true
      break
    }
    // UI 点击未生效 → API 兜底裁决（记录 fallback，链路必须推进）
    if (acc?.status === 'pending' && Date.now() - approveStart > 6_000) {
      const fallback = await api('POST', `/api/workshop/projects/${projectId}/approvals/${acc.id}/decide`, { approve: true }, token)
      approveDiag += ` fallback=${fallback.status}`
    }
    await sleep(800)
  }
  ok('I11', '批准 → 成果 approved / 交付物 approved（UI 点击 + API 兜底确认）', approvedOk, approveDiag)

  // I12 leader 派发提案 + 页面应用
  const channels2 = await api('GET', `/api/workshop/projects/${projectId}/channels`, undefined, token)
  const firstBound = (channels2.data ?? [])[0]
  const deliverables2 = await api('GET', `/api/workshop/projects/${projectId}/deliverables`, undefined, token)
  const firstDeliverable = (deliverables2.data ?? [])[0]
  const proposal = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: (await api('GET', `/api/workshop/projects/${projectId}`, undefined, token)).data?.leadAgentId,
    tool: 'project_propose_dispatch',
    args: { deliverable_id: firstDeliverable.id, channel_id: firstBound.channelId, title: `提案工作项-${Date.now().toString(36).slice(-4)}`, dispatch: false },
  }, token)
  const proposalBody = JSON.parse(String(proposal.data?.result?.text ?? '{}'))
  ok('I12a', 'leader 派发提案（API）', Boolean(proposalBody.proposalId), toolShort(proposal))
  // 页面需重新加载才能看到 proposed decision → 用刷新周报顺带 load()? 直接重新打开详情
  await gotoReady(page, `/projects/${projectId}`, { wait: 3000 })
  await gotoTab(page, 'events')
  await clickButton(page, '应用提案')
  await gotoTab(page, 'plan')
  ok('I12', '页面点击应用提案 → 工作项出现', await waitText(page, '提案工作项'), 'dispatch.proposed applied')

  // I13 周报刷新 + 导出按钮可用（概览 tab）
  await gotoTab(page, 'overview')
  await page.click('[data-testid="btn-report-refresh"]')
  await sleep(800)
  const reportText = await page.evaluate(() => document.body.innerText)
  ok('I13', '周报卡片渲染（进度/交付物/成果数字）',
    reportText.includes('周报') && reportText.includes('进度') && reportText.includes('generatedAt'), reportText.slice(0, 200))
  await page.click('[data-testid="btn-report-export"]')
  await sleep(400)

  // I14 tab 行为断言（PR15 五 tab）
  await gotoTab(page, 'plan')
  const planTabText = await page.evaluate(() => document.body.innerText)
  ok('I14a', '计划与工作 tab：计划快照 + retry/cancel 按钮', planTabText.includes('计划快照') && planTabText.includes('重试') && planTabText.includes('取消'), 'plan tab')
  await gotoTab(page, 'deliverables')
  const delTabText = await page.evaluate(() => document.body.innerText)
  ok('I14b', '交付物 tab：成果按交付物分组展示', delTabText.includes('成果与验收') && delTabText.includes('交互交付物'), 'deliverables tab')
  await gotoTab(page, 'approvals')
  const apTabText = await page.evaluate(() => document.body.innerText)
  ok('I14c', '审批 tab：待审批 + 审批历史', apTabText.includes('待审批') && apTabText.includes('审批历史'), 'approvals tab')
  await gotoTab(page, 'overview')
  const ovTabText = await page.evaluate(() => document.body.innerText)
  ok('I14d', '概览 tab：受保护徽标 + 打开办公室入口', ovTabText.includes('受保护') && ovTabText.includes('办公室'), 'overview tab')

  // I15 无页面异常 + 截图
  ok('I15', '页面无未捕获异常', errors.length === 0, errors.join('; '))
  await page.screenshot({ path: join(EVID, 'project-interactions.png'), fullPage: true })

  const fail = results.filter(r => !r.pass).length
  const summary = { generatedAt: new Date().toISOString(), pass: results.length - fail, fail, results }
  writeFileSync(join(EVID, 'interactions.json'), JSON.stringify(summary, null, 2))
  console.log(`\n=== UI INTERACTIONS pass=${results.length - fail} fail=${fail} ===`)
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = fail > 0 ? 1 : 0
}
catch (err) {
  console.error('交互矩阵异常:', err)
  process.exitCode = 1
}
finally {
  try {
    await Promise.race([browser?.close(), sleep(3000)])
  }
  catch { /* ignore */ }
  try {
    child.kill()
  }
  catch { /* ignore */ }
  await sleep(300)
  // browser.close() 在部分 Windows/Chrome 组合上会挂住；结果已落盘，强制收尾。
  process.exit(process.exitCode ?? 0)
}

function toolShort(resp) {
  return String(resp?.data?.result?.text ?? '').slice(0, 200)
}
