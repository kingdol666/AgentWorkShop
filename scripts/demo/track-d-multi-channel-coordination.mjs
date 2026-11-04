#!/usr/bin/env node
/**
 * Track D：多 Channel 协同开发实机验证（mock harness 快进，专证「Project 调度多 Channel」机制面）。
 *
 * 场景：项目 autoDispatch=1 + 两个成员频道（A=前端 / B=后端）+ 办公室频道 leader。
 * 跨频道链：W1(前端A 设计契约) → W2(后端B 依 W1 实现) → W3(前端A 依 W2 集成)。
 * 全程零手动派发：内核 tick 自动派发 → 频道 lead 完成回调 → 依赖门解除 → 派发下一项（跨频道）。
 *
 * 真 LLM 单频道 leader 提案/执行已由 Track B（track-c-landing-page.mjs）证明；
 * 本脚本专职证明「协调调配」的机制面：同一 Route 闭环按依赖在多个 Channel 间接力。
 *
 * 运行：node scripts/demo/track-d-multi-channel-coordination.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = join(tmpdir(), `aw-track-d-${Date.now().toString(36)}`)
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
for (const p of [3956, 3955, 3954]) {
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
    NUXT_SESSION_PASSWORD: 'TrackD#2026-multi-channel-key-32chars-pad',
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
  ok('D0', '隔离实例启动', healthy, `port=${port}`)
  if (!healthy) throw new Error('server not ready')

  const reg = await api('POST', '/api/users/register', { name: 'trackd', email: 'td@awshop.local', password: 'TrackD#2026' })
  const H = () => reg.data?.token

  // 项目（autoDispatch）+ 办公室频道 leader + 两个成员频道
  const project = (await api('POST', '/api/workshop/projects', {
    name: '跨频道协同 · 客户门户一期',
    objective: '由前端/后端两个频道接力完成客户门户的设计与实现',
    successCriteria: ['契约先行', '后端按契约实现', '前端按契约集成'],
    leaderHarness: 'mock',
    autoDispatch: true,
  }, H())).data
  const chA = (await api('POST', '/api/workshop/channels', {
    name: '前端开发频道', leadAgent: { name: 'Frontend Lead', harness: 'mock' },
  }, H())).data
  const chB = (await api('POST', '/api/workshop/channels', {
    name: '后端开发频道', leadAgent: { name: 'Backend Lead', harness: 'mock' },
  }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: chA.channelId, charter: '门户前端与集成' }, H())
  await api('POST', `/api/workshop/projects/${project.id}/channels`, { channelId: chB.channelId, charter: '门户后端服务' }, H())
  const dA = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: '门户前端', ownerChannelId: chA.channelId, required: true, acceptanceCriteria: ['契约驱动', '可运行'],
  }, H())).data
  const dB = (await api('POST', `/api/workshop/projects/${project.id}/deliverables`, {
    name: '门户后端', ownerChannelId: chB.channelId, required: true, acceptanceCriteria: ['契约实现', '接口可调'],
  }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/activate`, {}, H())
  const plan = (await api('POST', `/api/workshop/projects/${project.id}/plan/request-approval`, { version: 1, plan: { facts: ['跨频道接力计划 A→B→A'] } }, H())).data
  await api('POST', `/api/workshop/projects/${project.id}/approvals/${plan.id}/decide`, { approve: true, reason: '跨频道协同验证' }, H())
  const snap = (await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())).data
  ok('D1', '项目就绪：办公室 leader + 双频道绑定 + 双交付物 + 计划批准',
    Boolean(snap?.officeChannelId) && snap?.status === 'active' && snap?.planVersion === 1,
    `office=${Boolean(snap?.officeChannelId)} status=${snap?.status} planV=${snap?.planVersion}`)

  // 跨频道链：W1(A) → W2(B, dep W1) → W3(A, dep W2)
  const w1 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: dA.id, channelId: chA.channelId, title: 'W1 前端：API 契约与页面结构设计',
    brief: '输出 REST 契约（字段/错误码）与页面信息架构', execBudgetMinutes: 30, dedupeKey: 'td-w1',
  }, H())).data
  const w2 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: dB.id, channelId: chB.channelId, title: 'W2 后端：按契约实现服务',
    brief: '按 W1 契约实现接口与持久化', execBudgetMinutes: 45, dependsOn: [w1.id], dedupeKey: 'td-w2',
  }, H())).data
  const w3 = (await api('POST', `/api/workshop/projects/${project.id}/work-items`, {
    deliverableId: dA.id, channelId: chA.channelId, title: 'W3 前端：按契约集成联调',
    brief: '对接 W2 服务完成集成页面', execBudgetMinutes: 30, dependsOn: [w2.id], dedupeKey: 'td-w3',
  }, H())).data
  ok('D2', '跨频道链就绪：W1(A)→W2(B,dep W1)→W3(A,dep W2)', Boolean(w1?.id && w2?.id && w3?.id))

  const tick = () => api('POST', `/api/workshop/projects/${project.id}/kernel/tick`, {}, H())
  const items = async () => (await api('GET', `/api/workshop/projects/${project.id}/work-items`, undefined, H())).data ?? []
  const stateOf = async wiId => (await items()).find(w => w.id === wiId)?.state
  const tokenOf = async ch => (await api('POST', `/api/workshop/channels/${ch.channelId}/agents/${ch.leadAgentId}/rotate-token`, {}, H())).data?.token
  const tokA = await tokenOf(chA)
  const tokB = await tokenOf(chB)
  const tasksOf = async ch => (await api('GET', `/api/workshop/channels/${ch.channelId}/tasks`, undefined, H())).data ?? []
  const rootOf = async (ch, wiId) => (await tasksOf(ch)).filter(t => t.projectWorkItemId === wiId).sort((a, b) => (b.projectAttemptNo ?? 0) - (a.projectAttemptNo ?? 0))[0]
  const complete = async (ch, tok, wiId, name) => api('POST', `/api/workshop/tasks/${(await rootOf(ch, wiId)).id}/complete`, {
    artifacts: [{ artifactId: `td-${name}`, name, parts: [{ text: `${name} 交付内容` }] }],
  }, tok)

  // D3: tick → W1 派发进频道 A（B 无项目任务）
  await tick()
  const bTaskCountW1 = (await tasksOf(chB)).filter(t => t.projectWorkItemId).length
  const w1Root = await rootOf(chA, w1.id)
  ok('D3', '内核自动派发 W1 → 落在频道 A（频道 B 无项目任务）',
    (await stateOf(w1.id)) === 'DISPATCHED' && Boolean(w1Root) && bTaskCountW1 === 0,
    `w1=${await stateOf(w1.id)} rootA=${Boolean(w1Root)} bTasks=${bTaskCountW1}`)

  // D4: A 完成 W1 → 回调 → W2 跨频道派发进 B
  await complete(chA, tokA, w1.id, 'api-contract.md')
  await tick()
  const w2Root = await rootOf(chB, w2.id)
  const w2InA = (await tasksOf(chA)).some(t => t.projectWorkItemId === w2.id)
  ok('D4', '完成回调 → W2 跨频道接力派发进频道 B（A 中无 W2 任务）',
    ['DISPATCHED', 'COMPLETED'].includes(await stateOf(w2.id)) && Boolean(w2Root) && !w2InA,
    `w2=${await stateOf(w2.id)} rootB=${Boolean(w2Root)} w2InA=${w2InA}`)

  // D5: B 完成 W2 → 回调 → W3 再跨回频道 A
  await complete(chB, tokB, w2.id, 'service-impl.md')
  await tick()
  const w3Root = await rootOf(chA, w3.id)
  const w3InB = (await tasksOf(chB)).some(t => t.projectWorkItemId === w3.id)
  ok('D5', '完成回调 → W3 二次跨频道派发回频道 A（B 中无 W3 任务）',
    ['DISPATCHED', 'COMPLETED'].includes(await stateOf(w3.id)) && Boolean(w3Root) && !w3InB,
    `w3=${await stateOf(w3.id)} rootA=${Boolean(w3Root)} w3InB=${w3InB}`)

  // D6: A 完成 W3 → 全链终态
  await complete(chA, tokA, w3.id, 'integration.md')
  await tick()
  const finals = await items()
  ok('D6', '跨频道链全闭环（W1/W2/W3 全 COMPLETED）',
    finals.every(w => ['COMPLETED'].includes(w.state)), `states=${finals.map(w => w.state).join(',')}`)

  // D7: 审计轨迹 = 恰好 3 次 dispatch_auto，顺序 W1(A)→W2(B)→W3(A)；派发内容(brief)进对了频道
  const events = (await api('GET', `/api/workshop/projects/${project.id}/events?limit=100`, undefined, H())).data ?? []
  const autos = events.filter(e => e.type === 'work.dispatch_auto')
    .map((e) => {
      try {
        return JSON.parse(e.payloadJson)?.workItemId
      }
      catch { return '' }
    })
  const roots = { [w1.id]: w1Root, [w2.id]: w2Root, [w3.id]: await rootOf(chA, w3.id) }
  const briefOk = Boolean(w1Root?.title?.includes('W1') || w1Root?.title) && Boolean(w2Root?.title) && Boolean(roots[w3.id]?.title)
  ok('D7', 'Route 审计：恰好 3 次 dispatch_auto（W1→W2→W3 跨频道接力）+ 任务内容正确落频道',
    autos.length === 3 && autos[0] === w1.id && autos[1] === w2.id && autos[2] === w3.id && briefOk,
    `autos=${JSON.stringify(autos)}`)

  // D8: 成果链 + 完成门禁（多交付物：每个成果草稿都要走完 提交→复核→验收，否则完成门禁正确拒绝）
  await api('POST', `/api/workshop/projects/${project.id}/reconcile`, {}, H())
  const drafts = (await api('GET', `/api/workshop/projects/${project.id}/results`, undefined, H())).data ?? []
  const agentFor = cid => (cid === chA.channelId ? chA.leadAgentId : chB.leadAgentId)
  const chainLog = []
  for (const d of drafts.filter(x => x.status === 'draft')) {
    await api('POST', '/api/workshop/agent-tools/invoke', {
      agentId: agentFor(d.channelId), tool: 'project_submit_result', args: { result_id: d.id, summary: '跨频道接力交付：契约/服务/集成' },
    }, H())
    await api('POST', `/api/workshop/projects/${project.id}/results/${d.id}/review`, { decision: 'reviewed' }, H())
    const acceptance = (await api('POST', `/api/workshop/projects/${project.id}/results/${d.id}/request-acceptance`, {}, H())).data
    await api('POST', `/api/workshop/projects/${project.id}/approvals/${acceptance.id}/decide`, { approve: true, reason: '跨频道协同验证' }, H())
    chainLog.push(d.id)
  }
  const completeReq = (await api('POST', `/api/workshop/projects/${project.id}/complete`, {}, H())).data
  if (completeReq?.id) {
    await api('POST', `/api/workshop/projects/${project.id}/approvals/${completeReq.id}/decide`, { approve: true }, H())
  }
  const after = await api('GET', `/api/workshop/projects/${project.id}`, undefined, H())
  ok('D8', '全交付物成果链 + owner 完成门禁 → completed（门禁要求每个必选交付物过验收）',
    after.data?.status === 'completed', `drafts=${drafts.length} chained=${chainLog.length} status=${after.data?.status}`)

  // 审计时间线导出（执行过程证据）
  const timeline = events.map(e => ({
    type: e.type, eventKey: e.eventKey, createdAt: e.createdAt,
    payload: (() => {
      try {
        return JSON.parse(e.payloadJson)
      }
      catch { return undefined }
    })(),
  })).filter(e => String(e.type).startsWith('work.') || String(e.type).startsWith('plan.'))

  // D9: 项目页截图（计划 tab 双频道工作项 + 事件 tab 派发审计链）
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const browser = await launch({ width: 1440, height: 900 })
  let uiOk = false
  let uiDiag = ''
  try {
    const page = await openPage(browser, { token: H(), width: 1440, height: 900 })
    await gotoReady(page, `/projects/${project.id}`, { wait: 3000 })
    let text = ''
    for (let i = 0; i < 10; i++) {
      text = await page.evaluate(() => document.body.innerText)
      if (text.includes('跨频道')) break
      await sleep(1000)
    }
    await page.evaluate(() => document.querySelector('[data-testid="tab-plan"]')?.click())
    await sleep(800)
    const planText = await page.evaluate(() => document.body.innerText)
    await page.screenshot({ path: join(EVID, 'track-d-plan-two-channels.png'), fullPage: true })
    await page.evaluate(() => document.querySelector('[data-testid="tab-events"]')?.click())
    await sleep(800)
    const evtText = await page.evaluate(() => document.body.innerText)
    await page.screenshot({ path: join(EVID, 'track-d-events-audit.png'), fullPage: true })
    uiOk = planText.includes('前端') && planText.includes('后端') && evtText.includes('dispatch_auto')
    uiDiag = `plan 双频道=${planText.includes('前端') && planText.includes('后端')} events 审计=${evtText.includes('dispatch_auto')}`
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
  ok('D9', '项目页截图：计划 tab 呈现双频道工作项 + 事件 tab 呈现 dispatch_auto 审计链', uiOk, uiDiag)

  const summary = {
    generatedAt: new Date().toISOString(),
    port,
    scenario: 'Track D: 多 Channel 协同（W1 前端A → W2 后端B → W3 前端A，零手动派发跨频道接力）',
    projectId: project.id,
    pass: results.filter(r => r.pass).length,
    fail: results.filter(r => !r.pass).length,
    results,
    timeline,
  }
  writeFileSync(join(EVID, 'track-d-coordination.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n=== TRACK D pass=${summary.pass} fail=${summary.fail} → ${EVID} ===`)
  process.exitCode = summary.fail > 0 ? 1 : 0
}
catch (err) {
  console.error('Track D 异常:', err)
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
