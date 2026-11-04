#!/usr/bin/env node
/**
 * Track B 配套 UI 走查（B12）：真实浏览器 + 真实服务端，把「产品设计落地页」项目
 * 以 mock harness 快速推进到 completed（同形状数据：链式工作项 + 成果 + 审批历史），
 * 然后走查项目页五个 tab 的渲染与交互并截图。
 *
 * 为什么独立脚本：track-c 主流程用真 LLM（约 1 小时），实例随脚本退出销毁；
 * 首跑 B12 因 AW_BASE 未设而静默跳过（已修复主脚本）。本脚本专职补齐 B12 证据，
 * 数据形状与主流程一致（不重跑 LLM）。
 *
 * 运行：node scripts/demo/track-c-ui-walkthrough.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), `aw-track-c-ui-${Date.now().toString(36)}`)
mkdirSync(join(ROOT, 'home'), { recursive: true })
const EVID = join(REPO, 'docs/audit/evidence/2026-11-05-route-demo')
mkdirSync(EVID, { recursive: true })

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3959, 3958, 3957]) {
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
    NUXT_SESSION_PASSWORD: 'TrackC#2026-ui-walkthrough-key-32chars-padding',
    AW_RATE_LIMIT_OFF: '1',
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
  catch { /* non-json */ }
  return { status: res.status, ...json }
}

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
  ok('W0', '走查实例启动', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  const reg = await api('POST', '/api/users/register', { name: 'trackc-ui', email: 'tcui@awshop.local', password: 'TrackC#2026' })
  const token = reg.data?.token
  const H = () => token

  // 与主流程同形状的项目（mock lead 快速推进）
  const project = (await api('POST', '/api/workshop/projects', {
    name: '智能注塑云平台 · 产品设计落地页',
    objective: '为智能注塑云平台设计并实现一个单文件产品设计落地页',
    successCriteria: ['浏览器可打开渲染完整', '移动端响应式', '中文专业文案'],
    leaderHarness: 'mock',
    autoDispatch: true,
  }, H())).data
  const member = (await api('POST', '/api/workshop/channels', {
    name: '落地页开发频道',
    leadAgent: { name: 'Landing Dev Lead', harness: 'mock' },
  }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: '落地页设计与实现' }, H())
  const deliverable = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: '产品设计落地页', ownerChannelId: member.channelId, required: true,
    acceptanceCriteria: ['浏览器可打开渲染完整', '含 hero/特性/场景/CTA 分区', '移动端响应式'],
  }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, H())
  const plan = (await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, { version: 1, plan: { facts: ['落地页链式计划'] } }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/approvals/${plan.id}/decide`, { approve: true, reason: 'UI 走查种子' }, H())

  const w1 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: deliverable.id, channelId: member.channelId, title: '落地页信息架构与文案设计',
    brief: '设计文档：信息架构/文案/配色', execBudgetMinutes: 30, dedupeKey: 'ui-seed-design',
  }, H())).data
  const w2 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: deliverable.id, channelId: member.channelId, title: '落地页 HTML 实现',
    brief: '单文件响应式 HTML', execBudgetMinutes: 45, dependsOn: [w1.id], dedupeKey: 'ui-seed-build',
  }, H())).data
  ok('W1', '同形状数据就绪（项目/频道/交付物/链式工作项）', Boolean(project?.id && w1?.id && w2?.id))

  // Route 闭环快进：tick 自动派发 W1 → 完成回调 → tick 自动派发 W2 → 完成
  const tick = () => api('POST', `/api/workshop/projects/${project.id}/kernel/tick`, {}, H())
  const items = async () => (await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, H())).data ?? []
  const rotate = (await api('POST', `/api/workshop/channels/${member.channelId}/agents/${member.leadAgentId}/rotate-token`, {}, H())).data
  const agentToken = rotate?.token
  const rootOf = async wiId => ((await api('GET', `/api/workshop/channels/${member.channelId}/tasks`, undefined, H())).data ?? [])
    .filter(t => t.projectWorkItemId === wiId).sort((a, b) => (b.projectAttemptNo ?? 0) - (a.projectAttemptNo ?? 0))[0]
  const complete = async (wiId, name) => api('POST', `/api/workshop/tasks/${(await rootOf(wiId)).id}/complete`, {
    artifacts: [{ artifactId: `ui-${name}`, name, parts: [{ text: `${name} 交付内容` }] }],
  }, agentToken)

  await tick()
  ok('W2a', '内核自动派发 W1（零手动）', (await items()).find(w => w.id === w1.id)?.state === 'DISPATCHED')
  await complete(w1.id, 'design-doc.md')
  await tick()
  const w2State = (await items()).find(w => w.id === w2.id)?.state
  ok('W2b', '完成回调 → W2 自动派发', ['DISPATCHED', 'COMPLETED'].includes(w2State), `w2=${w2State}`)
  await complete(w2.id, 'landing-page.html').catch(() => {})
  await tick()
  const finalStates = (await items()).map(w => w.state)
  ok('W2c', '链式全闭环（两工作项 COMPLETED）', finalStates.every(s => s === 'COMPLETED'), `states=${finalStates.join(',')}`)

  // 成果链 + 完成门禁（审批历史给审批 tab 提供真实数据）
  await api('POST', `/api/workshop/projects/${project.id}/reconcile`, {}, H())
  const draft = (await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, H())).data?.[0]
  await api('POST', '/api/workshop/agent-tools/invoke', {
    agentId: member.leadAgentId, tool: 'project_submit_result',
    args: { result_id: draft.id, summary: '落地页实现：hero/特性/场景/CTA，响应式' },
  }, H())
  await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/review`, { decision: 'reviewed' }, H())
  const acceptance = (await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/request-acceptance`, {}, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/approvals/${acceptance.id}/decide`, { approve: true, reason: 'UI 走查种子' }, H())
  const completeReq = (await api('POST', `/api/workshop/projects/${project.id}/complete`, {}, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/approvals/${completeReq.id}/decide`, { approve: true }, H())
  const after = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  ok('W3', '成果链 + 完成门禁 → completed（含审批历史）', after.data?.status === 'completed', `status=${after.data?.status}`)

  // ── B12 项目页五 tab 真实浏览器走查 ──
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const browser = await launch({ width: 1440, height: 900 })
  let uiOk = false
  let uiDiag = ''
  try {
    const page = await openPage(browser, { token, width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)))

    await gotoReady(page, '/projects', { wait: 2500 })
    const listText = await page.evaluate(() => document.body.innerText)
    ok('W4a', '项目列表页渲染本项目', listText.includes('落地页'), listText.slice(0, 160))
    await page.screenshot({ path: join(EVID, 'ui-projects-list.png'), fullPage: true })

    await gotoReady(page, `/projects/${project.id}`, { wait: 3000 })
    const overview = await page.evaluate(() => document.body.innerText)
    ok('W4b', '详情页概览：项目名/状态/频道/周报',
      overview.includes('落地页') && overview.includes('completed') && overview.includes('频道') && overview.includes('周报'),
      overview.slice(0, 220))
    await page.screenshot({ path: join(EVID, 'ui-project-overview.png'), fullPage: true })

    const tabTexts = {}
    for (const tid of ['plan', 'deliverables', 'approvals', 'events']) {
      await page.evaluate((t) => {
        document.querySelector(`[data-testid="tab-${t}"]`)?.click()
      }, tid)
      await sleep(700)
      tabTexts[tid] = await page.evaluate(() => document.body.innerText)
      await page.screenshot({ path: join(EVID, `ui-project-${tid}.png`), fullPage: true })
    }
    ok('W4c', '计划与工作 tab：链式工作项 + 依赖展示',
      tabTexts.plan?.includes('信息架构') && tabTexts.plan?.includes('HTML 实现'), (tabTexts.plan ?? '').slice(0, 160))
    ok('W4d', '交付物 tab：交付物与成果分组', tabTexts.deliverables?.includes('产品设计落地页'), (tabTexts.deliverables ?? '').slice(0, 160))
    ok('W4e', '审批 tab：审批历史（计划/验收/完成）', (tabTexts.approvals ?? '').includes('approved'), (tabTexts.approvals ?? '').slice(0, 160))
    ok('W4f', '决策与事件 tab：派发/完成审计事件', (tabTexts.events ?? '').includes('dispatch'), (tabTexts.events ?? '').slice(0, 160))
    ok('W4g', '页面无未捕获异常', errors.length === 0, errors.join(';').slice(0, 200))
    uiOk = true
    uiDiag = `tabs=${Object.keys(tabTexts).join(',')} errors=${errors.length}`
  }
  catch (err) {
    uiDiag = `browser error: ${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    try {
      await browser.close()
    }
    catch { /* ignore */ }
  }
  ok('W4', 'B12 项目页五 tab 渲染与交互走查 + 截图', uiOk, uiDiag)

  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    scenario: 'Track B 配套 UI 走查（B12）：产品设计落地页项目页五 tab 渲染/交互',
    pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length,
    results,
  }
  writeFileSync(join(EVID, 'track-c-ui-walkthrough.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n=== TRACK C UI WALKTHROUGH pass=${summary.pass} fail=${summary.fail} → ${EVID} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
catch (err) {
  console.error('UI 走查异常:', err)
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
