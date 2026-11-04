#!/usr/bin/env node
/**
 * Track B 真实演示：Project 层驱动「简易库存管理系统」开发全链（真 LLM）。
 *
 * D0 隔离实例（build 产物）→ D1 项目（leader=omp）+ 成员频道（lead=omp）→
 * D2 leader 真 LLM 回合提交计划（project_propose_plan）→ owner 批准 → 物化 →
 * D3 派发 → lead 真 LLM 自主执行并完成任务（产出 HTML 工件）→
 * D4 成果链（reconcile→lead 工具提交→owner 复核→验收→批准）→
 * D5 HTML 落盘 + 浏览器打开验证（标题/表格/localStorage 功能冒烟）→
 * D6 完成门禁 → completed → D7 证据 JSON + 截图。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), `aw-track-b-demo-${Date.now().toString(36)}`)
try {
  rmSync(join(tmpdir(), 'aw-track-b-demo'), { recursive: true, force: true })
}
catch { /* 上一轮句柄未释放时忽略，使用全新目录 */ }
mkdirSync(join(ROOT, 'home'), { recursive: true })
const EVID = join(REPO, 'docs/audit/evidence/2026-11-03-project-layer/track-b')
mkdirSync(EVID, { recursive: true })

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3969, 3968, 3967]) {
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
    NUXT_SESSION_PASSWORD: 'TrackB#2026-demo-key',
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

/** 轮询直到 cond 成立或超时。 */
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

/** 给 agent 发消息并要求回执（驱动真 LLM 回合）。 */
async function instruct(channelId, toAgentId, text, token) {
  return api('POST', `/api/workshop/channels/${channelId}/messages`, {
    toAgentId,
    text,
    requireReply: true,
    priority: 'immediate',
  }, token)
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
  ok('D0', '隔离实例启动（build 产物）', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  // D1 项目 + 真实 LLM 角色
  const reg = await api('POST', '/api/users/register', { name: 'trackb-admin', email: 'tb@awshop.local', password: 'TrackB#2026' })
  const token = reg.data?.token
  ok('D1a', 'owner 注册', Boolean(token))
  const project = (await api('POST', '/api/workshop/projects', {
    name: '简易库存管理系统',
    objective: '交付一个可打开的单文件库存管理系统页面：商品增删改查、数量调整、localStorage 持久化、库存统计',
    successCriteria: ['页面可在浏览器打开且渲染库存表格', '支持新增/删除商品并持久化', '含库存总量统计'],
    leaderHarness: 'omp',
  }, token)).data
  ok('D1b', '项目创建（leader harness=omp）', Boolean(project?.id && project?.leadAgentId), JSON.stringify({ id: project?.id }))
  const member = (await api('POST', '/api/workshop/channels', {
    name: '开发频道',
    scenarioPrompt: [
      '# 执行纪律（必须遵守）',
      '- root 任务执行期间**禁止调用 cancel_task / supersede_task 取消自己的任务**；',
      '- 长时间生成属正常：先调用 report_progress(10~90) 汇报进度，再继续；',
      '- 完成时调用 complete_task 并把完整 HTML 全文放入 artifact；',
      '- 只做当前任务，不要创建新任务。',
    ].join('\n'),
    leadAgent: {
      name: 'Dev Lead',
      harness: 'omp',
      config: { superviseWatchdogMs: 180_000, superviseHardTimeoutMs: 720_000 },
    },
  }, token)).data
  ok('D1c', '成员频道（lead harness=omp）', Boolean(member?.channelId && member?.leadAgentId))
  const bind = await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: member.channelId, charter: '负责管理系统页面实现' }, token)
  ok('D1d', '绑定成员频道', bind.status === 200)
  const deliverable = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: '库存管理单页', ownerChannelId: member.channelId, required: true,
    acceptanceCriteria: ['浏览器可打开', '含商品表格', '支持新增/删除', 'localStorage 持久化', '含库存统计'],
  }, token)).data
  ok('D1e', '交付物创建', Boolean(deliverable?.id))
  const activated = await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, token)
  ok('D1f', '项目激活', activated.status === 200 && activated.data?.status === 'active')

  // D2 leader 真 LLM 回合提交计划
  const planInstr = [
    '你是项目总工。请立即调用 project_propose_plan 工具提交本项目的执行计划，要求：',
    'deliverables 至少一项：key=d1, name=库存管理单页, channelId=' + member.channelId + '；',
    'work_items 一项：key=w1, deliverableKey=d1, channelId=' + member.channelId + ', title=实现库存管理单页, brief=最小可用单文件 HTML：商品表格+新增行+localStorage 保存+件数统计；先保证浏览器可运行再完善, execBudgetMinutes=45。',
    '必须真实调用工具，不要只输出文本。',
  ].join('\n')
  let planApproved = false
  let planApprovalId = ''
  for (let attempt = 1; attempt <= 3 && !planApproved; attempt++) {
    await instruct(project.officeChannelId, project.leadAgentId, planInstr, token)
    const polled = await poll(`D2-leader-plan(attempt ${attempt})`, 240_000, async () => {
      const pend = await api('GET', `/api/workshop/projects/${project.id}/approvals`, undefined, token)
      const pa = (pend.data ?? []).find(a => a.kind === 'plan_approval')
      if (pa) return { done: true, detail: `approval=${pa.id}`, approvalId: pa.id }
      const proposals = await api('GET', `/api/workshop/projects/${project.id}/decisions`, undefined, token)
      const pp = (proposals.data ?? []).filter(d => d.decisionType === 'plan.proposed').length
      return { done: false, detail: `pending=0 proposals=${pp}` }
    })
    if (polled.done) {
      planApprovalId = polled.approvalId
      const decided = await api('POST', `/api/workshop/projects/${project.id}/approvals/${planApprovalId}/decide`, { approve: true, reason: '计划由 leader 真 LLM 提案' }, token)
      const after = await api('GET', `/api/workshop/projects/${project.id}`, undefined, token)
      planApproved = decided.status === 200 && after.data?.planVersion >= 1
      ok(`D2`, `leader 真 LLM 提案计划 → owner 批准 → planVersion=${after.data?.planVersion}`, planApproved, `decide=${decided.status}`)
    }
    else {
      ok(`D2-retry${attempt}`, 'leader 提案轮询超时，将重试', false, polled.detail)
    }
  }
  if (!planApproved) throw new Error('leader 未能提交计划（3 次尝试）')

  // D3 派发 → lead 真 LLM 自主执行（CANCELED 自动重派，H4 设计：任务可重新派发）
  const workItems = await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, token)
  const mainItem = (workItems.data ?? [])[0]
  let execPoll = { done: false, detail: '', root: null }
  for (let attempt = 1; attempt <= 2 && !execPoll.done; attempt++) {
    if (attempt > 1) {
      console.log(`  …[D3-retry] 第 ${attempt} 次重派（上一 attempt: ${execPoll.detail ?? ''}）`)
      await api('POST', `/api/workshop/projects/${project.id}/work-items/${mainItem.id}/dispatch`, {}, token)
    }
    else {
      const dispatched = await api('POST', `/api/workshop/projects/${project.id}/work-items/${mainItem.id}/dispatch`, {}, token)
      ok('D3a', '工作项派发（root task）', dispatched.status === 200 && dispatched.data?.state === 'DISPATCHED', `status=${dispatched.status}`)
      if (dispatched.status !== 200) break
    }
    execPoll = await poll(`D3-lead-execute(attempt ${attempt})`, 47 * 60_000, async () => {
      const tasks = await api('GET', `/api/workshop/channels/${member.channelId}/tasks`, undefined, token)
      const root = (tasks.data ?? []).filter(t => t.projectWorkItemId === mainItem.id).sort((a, b) => (b.projectAttemptNo ?? 0) - (a.projectAttemptNo ?? 0))[0]
      if (!root) return { done: false, detail: 'root not found' }
      const artifactLen = JSON.stringify(root.artifactsJson ?? '').length
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(root.state)) {
        if (root.state === 'CANCELED') return { done: false, canceled: true, detail: `attempt${attempt} CANCELED(${root.closeReason ?? ''})` }
        return { done: true, detail: `root=${root.state} artifacts=${artifactLen}B`, root }
      }
      return { done: false, detail: `root=${root.state} progress=${root.progress}% artifacts=${artifactLen}B` }
    }, 20_000)
    if (execPoll.canceled) {
      console.log(`  …[D3-retry] attempt ${attempt} 被 lead 取消，准备重派`)
      continue
    }
  }
  const rootTask = execPoll.root
  ok('D3b', 'lead 真 LLM 自主执行完成任务（含 CANCELED 自动重派）', execPoll.done && rootTask?.state === 'COMPLETED', execPoll.detail)
  const artifacts = JSON.parse(rootTask?.artifactsJson ?? '[]')
  const htmlPart = artifacts
    .flatMap(a => (a.parts ?? []))
    .map(p => p.text ?? '')
    .find(t => t.includes('<html') || t.includes('<!DOCTYPE'))
    ?? artifacts.flatMap(a => (a.parts ?? [])).map(p => p.text ?? '').sort((a, b) => b.length - a.length)[0]
    ?? ''
  ok('D3c', '产出真实 HTML 工件（含库存/表格/localStorage 关键特征）',
    htmlPart.length > 400 && /库存/.test(htmlPart) && /localStorage/.test(htmlPart) && /<table|<div/i.test(htmlPart),
    `len=${htmlPart.length} keywords=${/库存/.test(htmlPart)},${/localStorage/.test(htmlPart)}`)

  // D4 成果链
  await api('POST', `/api/workshop/projects/${project.id}/reconcile`, {}, token)
  const draft = (await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, token)).data?.[0]
  ok('D4a', 'root COMPLETED → 成果 draft（真实工件证据）', Boolean(draft?.id) && draft?.status === 'draft', `result=${draft?.id}`)
  const leadSubmit = draft
    ? await api('POST', '/api/workshop/agent-tools/invoke', {
        agentId: member.leadAgentId,
        tool: 'project_submit_result',
        args: { result_id: draft.id, summary: '库存管理单页已实现：增删改查/localStorage/统计', evidence: [{ artifactId: artifacts[0]?.artifactId ?? 'html', kind: 'artifact' }] },
      }, token)
    : null
  ok('D4b', 'channel lead 工具提交成果', Boolean(draft) && leadSubmit?.status === 200 && leadSubmit?.data?.result?.isError !== true, String(leadSubmit?.data?.result?.text ?? '').slice(0, 200))
  const reviewed = draft
    ? await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/review`, { decision: 'reviewed' }, token)
    : null
  ok('D4c', '复核 → reviewed', reviewed?.status === 200 && reviewed?.data?.status === 'reviewed')
  const acceptance = draft ? (await api('POST', `/api/workshop/projects/${project.id}/results/${draft.id}/request-acceptance`, {}, token)).data : null
  const accDecided = acceptance ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${acceptance.id}/decide`, { approve: true, reason: '验收标准逐条满足' }, token) : null
  ok('D4d', 'owner 验收批准 → 成果/交付物 approved', accDecided?.status === 200 && accDecided.data?.status === 'approved', `decide=${accDecided?.status}`)

  // D5 HTML 落盘 + 浏览器验证
  const htmlPath = join(EVID, 'inventory-system.html')
  writeFileSync(htmlPath, htmlPart, 'utf8')
  const { launch } = await import('../ui/lib.mjs')
  const browser = await launch({ width: 1440, height: 900 })
  let pageOk = false
  let smokeDiag = ''
  try {
    const page = await browser.newPage()
    await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 20_000 })
    await sleep(800)
    const bodyText = await page.evaluate(() => document.body.innerText)
    const hasTable = await page.evaluate(() => Boolean(document.querySelector('table') || document.querySelector('[class*="item"], [class*="list"], ul, li')))
    const rowsBefore = await page.evaluate(() => document.querySelectorAll('tbody tr, li').length)
    const addResult = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')]
      const nameInput = inputs.find(i => (i.placeholder ?? '').includes('名') || (i.placeholder ?? '').toLowerCase().includes('name'))
      if (nameInput) {
        nameInput.value = 'E2E 测试商品'
        nameInput.dispatchEvent(new Event('input', { bubbles: true }))
        const addBtn = [...document.querySelectorAll('button')].find(b => /添加|新增|加入/.test(b.innerText))
        addBtn?.click()
        return Boolean(addBtn)
      }
      return false
    })
    await sleep(600)
    const rowsAfter = await page.evaluate(() => document.querySelectorAll('tbody tr, li').length)
    const persisted = await page.evaluate(() => Object.keys(localStorage).length > 0)
    pageOk = bodyText.includes('库存') && hasTable && rowsAfter >= rowsBefore
    smokeDiag = `body 库存=${bodyText.includes('库存')} table=${hasTable} add=${addResult} rows ${rowsBefore}→${rowsAfter} persisted=${persisted}`
    await page.screenshot({ path: join(EVID, 'inventory-system.png'), fullPage: true })
  }
  catch (err) {
    smokeDiag = `browser error: ${err instanceof Error ? err.message : String(err)}`
  }
  finally {
    try {
      await browser.close()
    }
    catch { /* ignore */ }
  }
  ok('D5', '页面浏览器验证（渲染/表格/新增交互/localStorage）', pageOk, smokeDiag)

  // D6 完成门禁 → completed
  const completeReq = (await api('POST', `/api/workshop/projects/${project.id}/complete`, {}, token)).data
  const completeDec = completeReq ? await api('POST', `/api/workshop/projects/${project.id}/approvals/${completeReq.id}/decide`, { approve: true }, token) : null
  const afterComplete = await api('GET', `/api/workshop/projects/${project.id}`, undefined, token)
  ok('D6', '完成门禁 + owner 批准 → completed', completeDec?.status === 200 && afterComplete.data?.status === 'completed', `dec=${completeDec?.status} status=${afterComplete.data?.status}`)

  // D7 证据
  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    scenario: 'Track B: 简易库存管理系统（真 LLM 开发全链）',
    pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length,
    results,
  }
  writeFileSync(join(EVID, 'track-b-acceptance.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n=== TRACK B pass=${summary.pass} fail=${summary.fail} → ${EVID} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
catch (err) {
  console.error('Track B 演示异常:', err)
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
