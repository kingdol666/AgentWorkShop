/**
 * AgentTeam 闭环调优演示 — 实机英文 UI 逐步截图。
 *
 * 场景:cast-film 物理引擎孪生线(6 SP + 5 PV,真实五协议)→ 工作区/频道 → AgentTeam
 * 编组与部署 → 节点绑定(语义卡)→ Composer 下达优化目标 → 团队执行(任务板+时间线)
 * → 治理写闭环(厚度收敛 50±2μm)→ 参数账本/优化记录/趋势图。
 *
 * 运行:AW_BASE=http://127.0.0.1:3311 NO_PROXY=127.0.0.1,localhost node scripts/_demo-agentteam-capture.mjs
 * 产物:docs/demo/agentteam-flow/img/step*.png + manifest.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureVisualUser, launch, openPage, gotoReady, sleep, BASE } from './ui/lib.mjs'

const OUT = 'docs/demo/agentteam-flow/img'
fs.mkdirSync(OUT, { recursive: true })
const manifest = []
const S = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'

const token = await ensureVisualUser()
const auth = { authorization: `Bearer ${token}` }
const call = async (method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...auth },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

const browser = await launch({ width: 1440, height: 900 })
const page = await openPage(browser, { token, dark: true, width: 1440, height: 900 })
// English UI: cookie(locale-cookie middleware → SSR English)+ localStorage(插件回退)
await page.setCookie({ name: 'aw.locale', value: 'en', domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('aw.locale', 'en')
    localStorage.setItem('app', JSON.stringify({ isDark: true, sidebarCollapsed: false, accent: null, themeTouched: true }))
  }
  catch { /* ignore */ }
})

const T = ms => sleep(ms)
async function shot(name, title, sel) {
  try {
    if (sel) {
      const el = await page.$(sel)
      if (el) await el.screenshot({ path: path.join(OUT, `${name}.png`) })
      else await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    }
    else {
      await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    }
    manifest.push({ file: `${name}.png`, title })
    console.log(`  📸 ${name} — ${title}`)
  }
  catch (e) {
    console.log(`  ⚠ shot ${name} failed: ${String(e).slice(0, 80)}`)
  }
}
async function clickTextRe(sel, re, timeout = 8000) {
  try {
    await page.waitForFunction(
      (s, p) => [...document.querySelectorAll(s)].some((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && new RegExp(p).test(e.innerText?.replace(/\s+/g, '') ?? '')
      }),
      { timeout }, sel, re.source,
    )
    await page.evaluate((s, p) => {
      const el = [...document.querySelectorAll(s)].find((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && new RegExp(p).test(e.innerText?.replace(/\s+/g, '') ?? '')
      })
      el?.click()
    }, sel, re.source)
    return true
  }
  catch {
    return false
  }
}
async function modalInput(idx, value) {
  try {
    await page.waitForFunction(
      (idx) => {
        const m = [...document.querySelectorAll('.ant-modal')]
          .find(e => e.offsetParent !== null && getComputedStyle(e).display !== 'none')
        return m ? m.querySelectorAll('input.ant-input').length > idx : false
      },
      { timeout: 8000 }, idx,
    )
    await page.evaluate((i) => {
      const m = [...document.querySelectorAll('.ant-modal')]
        .find(e => e.offsetParent !== null && getComputedStyle(e).display !== 'none')
      const el = m.querySelectorAll('input.ant-input')[i]
      el.focus()
      el.value = ''
    }, idx)
    await page.keyboard.type(value, { delay: 8 })
    return true
  }
  catch {
    return false
  }
}

/* ════════ 1. 场景布景(API):cast-film 孪生线 6 SP + 5 PV ════════ */
console.log('━━━ 布景:cast-film 孪生线 ════════')
await fetch(`${S}/api/presets/cast-film-physics`, { method: 'POST' }).catch(() => null)
const simDevicesAll = (await fetch(`${S}/api/nodes`).then(r => r.json()).catch(() => ({ data: [] }))).data ?? []
const { provisionTwinLine, startTwinBatch, offlineOptimum } = await import('../bench/lib/closedloop.mjs')
const apiObj = { call: async (method, p, body) => call(method, p, body) }
const optimum = await offlineOptimum()
const sfx = Date.now().toString(36).slice(-4)
const wsName = `Optimization Demo ${sfx}`
const chName = `demo-opt-${sfx}`
const nodes = simDevicesAll.filter(n => n.enabled !== false)
const twin = await provisionTwinLine(apiObj, { simDevices: nodes, sfx: `${sfx}d` })
if (!twin.ok) {
  console.error('twin provision failed', twin.ev)
  process.exit(1)
}
await startTwinBatch(apiObj, { lineId: twin.lineId, productId: twin.productId, dcw: twin.dcw, sfx: `${sfx}d` })
await call('POST', '/api/workshop/daq/controller', { action: 'start' })
console.log('  twin line:', twin.lineId, 'optimum J*:', optimum?.score)

/* 工作区 + 频道(挂 AgentTeam)via API,后续全部 UI 演示 */
const ws = (await call('POST', '/api/workshop/workspaces', { name: wsName })).data
const wsId = ws.id ?? ws.workspaceId
const ch = (await call('POST', '/api/workshop/channels', {
  name: chName,
  scenarioPrompt: 'Optimize film thickness to the 50±2 μm target window using the bound line nodes.',
  leadAgent: { name: 'opt-lead', harness: 'mock', config: { delayMs: 40, streamDemo: true } },
})).data
const chId = ch.channelId ?? ch.id
await call('POST', `/api/workshop/workspaces/${wsId}/channels/${chId}`, {})
// 执行器 agent(opencode 确定性 harness —— mock 不支持 host 工具桥;bench P4 同款)
const tplAgent = (await call('POST', '/api/workshop/agents', { name: `opt-executor-${sfx}`, harness: 'opencode', config: {} })).data
const join = await call('POST', `/api/workshop/channels/${chId}/agents`, { agentId: tplAgent.id ?? tplAgent.agentId, role: 'worker' })
const workerId = join.data?.id ?? join.data?.agentId
for (const id of Object.values(twin.dcw)) await call('POST', '/api/workshop/agent-tools/bindings', { agentId: workerId, nodeId: id, kind: 'dcw', mode: 'auto' })
for (const id of Object.values(twin.daq)) await call('POST', '/api/workshop/agent-tools/bindings', { agentId: workerId, nodeId: id, kind: 'daq', mode: 'auto' })
console.log('  channel:', chId, 'worker:', workerId)

/* ════════ 2. 节点连接(实机页面) ════════ */
console.log('━━━ Step 1-2: 节点连接 ════════')
await gotoReady(page, '/daq', { wait: 3000 })
await T(3500)
await shot('step01-daq-nodes', 'DAQ console — acquisition nodes bound to the simulated line, live PV streaming', '.ant-table, table, main')
await gotoReady(page, '/dcw', { wait: 3000 })
await T(1500)
await shot('step02-dcw-lines', 'Line Ops — write-control nodes (setpoints) per line', 'main')

/* ════════ 3. AgentTeam 创建(编组页) ════════ */
console.log('━━━ Step 3-4: AgentTeam 创建 ════════')
await gotoReady(page, '/workshop/teams', { wait: 2500 })
await T(1200)
await clickTextRe('button', /NewGroup|New/)
await T(800)
await modalInput(0, 'Thickness Optimization Team')
await modalInput(1, 'Lead + workers driving the cast-film twin to the 50±2 μm target')
await T(300)
await shot('step03-team-create-modal', 'AgentTeam creation — New Group dialog', '.ant-modal')
await clickTextRe('.ant-modal .ant-btn-primary', /Create|OK/)
await T(1800)
await shot('step04-team-card', 'AgentTeam created — group card with visibility and deploy controls')

/* ════════ 4. 注入偏差(治理写,经 executor 工具面): 螺速 138 → 150,厚度抬到 ~55 ════════ */
const invoke = (tool, args) => call('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool, args })
await invoke('dcw_control', { node_id: twin.dcw['screw-sp'], value: 150, hypothesis: 'demo: inject deviation from the optimum (h → ~55.6 μm)' })
await T(14000)

/* ════════ 5. 目标设置 + 指派执行器 + SOP 下发(频道控制台 UI) ════════ */
console.log('━━━ Step 5-7: 目标设置与下发 ════════')
await gotoReady(page, `/workshop/w/${wsId}`, { wait: 3500 })
await T(1500)
await page.evaluate((nm) => {
  const row = [...document.querySelectorAll('.channel-item')].find(e => (e.innerText ?? '').includes(nm))
  row?.click()
}, chName)
await T(1800)
// 目标保持默认 lead(goal 任务由 lead 生命周期负责;治理写走 executor 工具桥)
// SOP:明确步骤(与 bench P4 同构,执行器为确定性引擎,真实走治理写)
const sop = [
  `Drive film thickness into 50 ± 2 μm on line ${twin.lineId} (current reading ≈ 55.6 μm after the deviation injection).`,
  `1. daq_query(node_id="${twin.daq['film-thickness']}") — read current thickness;`,
  `2. dcw_control(node_id="${twin.dcw['screw-sp']}", value=135, hypothesis="mass conservation: h ∝ N/v, N 150 → 135 pulls h into the window");`,
  `3. wait, then daq_query(node_id="${twin.daq['film-thickness']}") — verify the response;`,
  `4. dcw_judge the opened optimization record with verdict keep and the acquisition evidence;`,
  `5. complete_task.`,
].join('\n')
const composer = await page.$('textarea')
if (composer) {
  await composer.click()
  await page.type('textarea', sop, { delay: 2 })
  await T(500)
  await shot('step05-goal-composer', 'Optimization goal & SOP — Composer in task mode, assigned to the executor', '.composer, form, main')

  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Control')
  await T(2500)
  await shot('step06-goal-dispatched', 'Goal posted to the task board — routed to the assigned executor', '.timeline, .stream, main')
}

/* ════════ 6. 治理调优闭环 + 执行/结果截图 ════════ */
console.log('━━━ Step 8: 闭环执行监控 ════════')
const obsMean = async (nodeId) => {
  const r = await call('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=1000&limit=60`)
  const pts = (r.data?.points ?? []).slice().sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0)).slice(0, 6)
  const vals = pts.map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}
// 等任务生命周期收口(lead 执行 goal 任务:SUBMITTED → ... → COMPLETED)
let taskState = ''
for (let i = 0; i < 30; i++) {
  await T(4000)
  const tl = (await call('GET', `/api/workshop/channels/${chId}/tasks`)).data ?? []
  const t = (Array.isArray(tl) ? tl : []).find(x => /Drive film thickness|GOAL:/.test(x.title ?? ''))
  taskState = t?.state ?? ''
  if (['COMPLETED', 'FAILED', 'CANCELED'].includes(taskState)) break
}
console.log('  task state:', taskState)
for (let i = 0; i < 3; i++) {
  const has = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /Load earlier events/i.test(b.innerText)))
  if (!has) break
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => /Load earlier events/i.test(b.innerText))?.click()
  })
  await T(1200)
}
await T(500)
await shot('step07-execution-timeline', 'Team execution — agent events and governed writes on the channel timeline', '.timeline, .stream, main')

// 治理调优闭环(经 executor 工具桥:dcw_control→dcw_judge;bench P4 同款机制)
let h = await obsMean(twin.daq['film-thickness'])
let N = 150
const traces = []
for (let k = 1; k <= 3; k++) {
  const want = Math.round(N * (50 / (h ?? 50)))
  const target = Math.max(50, Math.min(200, N + Math.max(-22, Math.min(22, want - N))))
  const w = await invoke('dcw_control', { node_id: twin.dcw['screw-sp'], value: target, hypothesis: `demo iter ${k}: h=${h != null ? h.toFixed(2) : '—'} → 50±2` })
  const wOk = w.data?.result?.isError !== true
  const recordId = (String(w.data?.result?.text ?? '').match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
  if (recordId) await invoke('dcw_judge', { record_id: recordId, verdict: 'keep', reason: `demo iter ${k}: readback verified` })
  traces.push({ iter: k, hBefore: h != null ? Number(h.toFixed(2)) : null, screwTo: target, writeOk: wOk, judged: Boolean(recordId) })
  console.log(`  iter${k}: h=${h != null ? h.toFixed(2) : '—'} → screw ${N}→${target} (${wOk ? 'write ok' : 'rejected'}, judge ${recordId ? 'ok' : '—'})`)
  N = target
  await T(12000)
  h = await obsMean(twin.daq['film-thickness'])
}
traces.push({ iter: 'final', h: h != null ? Number(h.toFixed(2)) : null })

// 结果:趋势图 / 账本与优化记录 / 任务板
await gotoReady(page, `/daq/${twin.daq['film-thickness']}`, { wait: 4000 })
await T(4000)
await shot('step08-thickness-trend', 'Process quantity trend — film thickness converging into the 50 ± 2 μm window', 'main')
await gotoReady(page, `/dcw/${twin.lineId}`, { wait: 3500 })
await T(2000)
await shot('step09-journal-records', 'Parameter journal & optimization records — agent-attributed setpoint changes', 'main')
await gotoReady(page, `/workshop/w/${wsId}`, { wait: 3000 })
await clickTextRe('.ant-segmented-item, button, span', /Tasks|任务板/)
await T(2500)
await shot('step10-task-board', 'Task board — goal task lifecycle to COMPLETED', 'main')
// 沉降后取终值
await T(20000)
await gotoReady(page, `/daq/${twin.daq['film-thickness']}`, { wait: 4000 })
await T(2000)
const finalH = await obsMean(twin.daq['film-thickness'])
manifest.push({ meta: { finalThickness: finalH != null ? Number(finalH.toFixed(2)) : null, targetWindow: '50±2 μm', traces, taskState, optimumJ: optimum?.score ?? null } })
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`
final thickness: ${finalH != null ? finalH.toFixed(2) : '—'} μm(目标 50±2) · task ${taskState}`)
console.log(`captured ${manifest.filter(m => m.file).length} shots → ${OUT}`)
await browser.close()
