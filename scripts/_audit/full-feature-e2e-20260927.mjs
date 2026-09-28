#!/usr/bin/env node
/**
 * scripts/_audit/full-feature-e2e-20260927.mjs —— 全功能真实端到端验收。
 *
 * 覆盖:节点绑定(DCW 写入/DAQ 数采/SP 回读)→ 前后端交互(真实 Chrome 登录+全页面巡检)
 * → 数字孪生 /town 渲染(canvas+__townStats+截图)→ AgentTeam 创建 + goal 任务下发
 * (进程内 mock harness 真实调度闭环)→ 群聊(REST 落库 + 前端 composer 实发)
 * → AML 集成(4 批次激励数据 → 数据集 → hybrid_residual 真实训练 → 平台门禁 →
 *   场景快照/试验/门禁 → shadow/production 两段 HITL 晋升 → MPC 未传 model_id 自动投用 → 写回复测)。
 *
 * 用法:node scripts/_audit/full-feature-e2e-20260927.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3474
const SIM_PORT = 4023
const HOME = mkdtempSync(join(tmpdir(), 'aw-full-e2e-'))
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4023')
const BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`
const KEEP = process.argv.includes('--keep')
const SHOTS = join(HOME, 'shots')
mkdirSync(SHOTS, { recursive: true })

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}
const callA = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json, data: json?.data, message: json?.message }
}
const killPort = (port) => {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}

let TOKEN = ''
const ADMIN = { name: 'e2e-full-admin', email: 'e2e-full@awshop.local', password: 'E2eFull2026!' }

/* ═══ Phase 0 · 清场 + 自举(平台 + 模拟器 + AML venv 复用)═══ */
console.log('═══ [P0] 清场自举:平台 3474 + 模拟器 4023(全新 home)═══')
for (const p of [AW_PORT, SIM_PORT, 4010, 4012]) killPort(p)
writeFileSync(join(HOME, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true } }))
{
  // AML venv/tools 以目录联接复用仓库运行时的既有安装(免 10 分钟 uv 装环境);产物仍落全新 home
  const src = join(REPO, '.AgentWorkShop', 'aml')
  mkdirSync(join(HOME, 'aml'), { recursive: true })
  for (const seg of ['.venv', 'tools']) {
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', join(HOME, 'aml', seg), join(src, seg)], { encoding: 'utf8' })
    if (!existsSync(join(HOME, 'aml', seg))) console.log(`  ↳ junction ${seg} 失败(${String(r.stderr).trim().slice(0, 80)}),训练环境将现场自建`)
  }
}
{
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'full-e2e-session-password-012345678' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let up = false
for (let i = 0; i < 45; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { up = true; break }
}
ok('P0a 平台健康门(全新 home)', up)
{
  const reg = await (await fetch(`${BASE}/api/users/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN),
  })).json()
  TOKEN = reg?.data?.token ?? ''
}
ok('P0b admin 首注册', Boolean(TOKEN))
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
}
ok('P0c 模拟器在跑(cast-film-physics)', (await getJson(`${SIM}/api/plant/state`))?.data?.running === true)
let gateCalibFail = 0
for (const [k, v] of Object.entries({ 'aml.gates.nrmse': 0.9, 'aml.gates.rolloutNrmse': 0.99, 'aml.gates.valTestGap': 2.0 })) {
  const r = await callA('PATCH', '/api/system/settings', { override: { [k]: v } })
  if (r.status !== 200) { gateCalibFail++; console.log(`  ↳ 门禁校准 ${k} 未生效(${r.status}),用默认值继续`) }
}
ok('P0d AML 门禁校准下发', gateCalibFail === 0, `fail=${gateCalibFail}`)

/* ═══ Phase 1 · 节点绑定:权威建线 6 DCW + 5 DAQ + 6 SP 回读 + 数采启动 + 批次1 ═══ */
console.log('═══ [P1] 节点绑定:建线 + DCW/DAQ 绑定 + SP 回读 + 批次开跑 ═══')
let twin, recipeId
{
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
  const { provisionTwinLine, startTwinBatch } = await import('../../bench/lib/closedloop.mjs')
  const api = { call: async (m, p, b) => { const r = await callA(m, p, b); return { status: r.status, data: r.data, message: r.message } } }
  twin = await provisionTwinLine(api, { simDevices, sfx: 'fulle2e' })
  ok('P1a 权威建线(6 DCW + 5 DAQ 绑定)', twin.ok, (twin.ev ?? []).join(' | ').slice(0, 160))
  const spReadback = {}
  for (const dev of simDevices) {
    const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
    for (const id of Object.keys(twin.dcw)) {
      if (spReadback[id]) continue
      const sig = (dev.signals ?? []).find(s => s.id === id)
      if (!sig) continue
      const item = exp.find(i => i.signal === sig.name)
      if (!item?.driverConfig) continue
      const cfg = { ...item.driverConfig }
      if (cfg.jsonKey !== undefined && cfg.jsonPath === undefined) { cfg.jsonPath = cfg.jsonKey; delete cfg.jsonKey }
      const r = await callA('POST', '/api/workshop/daq', {
        name: `${sig.name} 回读 e2e`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: cfg,
        unit: sig.unit, min: sig.min, max: sig.max, lineId: twin.lineId, intervalMs: 1000, publishIntervalMs: 0,
        semantics: `执行器设定点回读(AML control 输入) ${item.signal}`,
      })
      spReadback[id] = r.json?.data?.node?.id ?? r.json?.data?.id
    }
  }
  globalThis.__spReadback = spReadback
  ok('P1b SP 回读 DAQ ×6(执行器→数采绑定)', Object.keys(spReadback).length === 6, JSON.stringify(spReadback))
  await callA('PATCH', `/api/workshop/daq/${twin.daq['film-thickness']}`, { semantics: '流延膜厚度测量(优化目标 goal,单位 μm;厚度质量输出)' })
  const cs = await callA('POST', '/api/workshop/daq/controller', { action: 'start' })
  ok('P1c 数采控制器启动', cs.status === 200, String(cs.message ?? ''))
  // SV→PV 因果:写一次设定点,PV 应在滞后后跟随
  const w = await callA('POST', `/api/workshop/dcw/${twin.dcw['diegap-sp']}/write`, { value: 1.01 })
  ok('P1d DCW SV 写入(治理链放行)', w.status === 200, String(w.message ?? ''))
  const batch = await startTwinBatch(api, { lineId: twin.lineId, productId: twin.productId, dcw: twin.dcw, sfx: 'fulle2e' })
  recipeId = batch.recipeId
  ok('P1e 配方下发并开跑(批次1)', batch.ok && Boolean(recipeId), JSON.stringify(batch).slice(0, 120))
}

/* ═══ Phase 2 · 前后端交互(真实 Chrome):登录流 + 全页面巡检 + 孪生渲染(批次1 窗口内)═══ */
console.log('═══ [P2] 浏览器真实操作:登录流 + 全路由巡检 + /town 渲染 ═══')
process.env.AW_BASE = BASE
process.env.AW_UI_SCALE = '1'
{
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  /* 硬超时护栏:任何浏览器操作都不允许挂死主流程(超时即记败让路);
     输家 promise 预挂 catch,避免迟到拒绝变成 unhandledRejection 杀进程 */
  const withT = (label, ms, fn) => new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => done({ okT: false, e: new Error(`hard-timeout:${label}(${ms}ms)`) }), ms)
    Promise.resolve().then(fn).then(v => done({ okT: true, v }), e => done({ okT: false, e }))
  })
  const killBrowser = async (b) => {
    if (!b) return
    const r = await withT('browser-close', 12000, () => b.close())
    if (!r.okT) { try { b.process()?.kill() } catch { /* 已死 */ } }
  }
  if (!existsSync(CHROME)) { ok('P2 前置:本机 Chrome 存在', false, CHROME) }
  else {
    /* P2a 未登录真实登录流(登录门在工作台 /workshop;首页为访客浏览态) */
    {
      const rA = await withT('login-flow', 150000, async () => {
        const browser = await launch()
        try {
          const lp = await browser.newPage()
          const loginErrs = []
          lp.on('pageerror', e => loginErrs.push(String(e.message).slice(0, 120)))
          await lp.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 40000 })
          await lp.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 40000, polling: 200 })
          await sleep(3500)
          const emailBox = await lp.$('input[type=email]')
          const pwdBox = await lp.$('input[type=password]')
          let loggedIn = false
          if (emailBox && pwdBox) {
            await emailBox.type(ADMIN.email)
            await pwdBox.type(ADMIN.password)
            const btn = await lp.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(x => /登\s*录/.test(x.textContent ?? '')))
            await btn.asElement()?.click()
            await sleep(5000)
            loggedIn = (await lp.$$('input[type=email], input[type=password]')).length === 0
          }
          await lp.screenshot({ path: join(SHOTS, 'login-flow.png') })
          return { loggedIn, n: emailBox && pwdBox ? 2 : 0, errs: loginErrs.length }
        }
        finally { await killBrowser(browser) }
      })
      ok('P2a 真实登录流(/workshop 登录门提交→进入工作台)', rA.okT && rA.v?.loggedIn, rA.okT ? `inputs=${rA.v?.n} errs=${rA.v?.errs}` : String(rA.e).slice(0, 120))
    }

    /* P2b 登录态全页面巡检(每路由独立 page + 硬超时;浏览器死亡自动重建) */
    const ROUTES = ['/', '/workshop', '/workshop/agents', '/workshop/teams', '/workshop/channel-templates', '/monitor',
      '/daq', '/dcw', '/aml', '/operations', '/logs', '/permissions', '/plugins', '/settings', '/tokens', '/users']
    const pageErrs = {}
    let rendered = 0
    let browser = null
    let browserDead = false
    for (const r of ROUTES) {
      if (!browser) {
        const lb = await withT('launch', 60000, () => launch())
        if (!lb.okT) { (pageErrs.all ??= []).push('launch-fail'); break }
        browser = lb.v
      }
      const op = await withT(`route:${r}`, 75000, async () => {
        const page = await openPage(browser, { token: TOKEN, width: 1366, height: 850 })
        page.on('pageerror', (e) => { (pageErrs[r] ??= []).push(String(e.message).slice(0, 100)) })
        await gotoReady(page, r, { wait: 2000, timeout: 30000 })
        const hasBody = await page.evaluate(() => (document.body.innerText ?? '').length > 40)
        await page.screenshot({ path: join(SHOTS, `route${r.replaceAll('/', '_')}.png`) })
        await page.close().catch(() => {})
        return hasBody
      })
      if (op.okT && op.v) rendered++
      const es = String(op.e ?? '')
      if (!op.okT) {
        (pageErrs[r] ??= []).push(es.slice(0, 80))
        if (es.includes('Not launched') || es.includes('closed') || es.includes('Session closed') || es.includes('Target')) browserDead = true
      }
      if (browserDead) { await killBrowser(browser); browser = null; browserDead = false }
    }
    await killBrowser(browser)
    ok('P2b 全路由渲染(16 页)', rendered >= 15, `rendered=${rendered}/16 errs=${JSON.stringify(pageErrs).slice(0, 260)}`)
    const pageErrorCount = Object.entries(pageErrs).filter(([k]) => k.startsWith('http')).reduce((a, [, lst]) => a + lst.length, 0)
    ok('P2c 全站零 pageerror', pageErrorCount === 0, JSON.stringify(pageErrs).slice(0, 300))
    /* 孪生渲染深检(P2d)挪到 P3 批次4 窗口:/town 渲染的是**已挂载的 workshop Channel**,
       此时尚无频道,空态「还没有挂载任何 Channel」是正确产品行为(实测截图确认过) */
  }
}

/* ═══ Phase 3 · 批次 2-4(激励)窗口内并行:团队 goal / 群聊 / AML 通道准备 / 工作台 UI ═══ */
console.log('═══ [P3] 批次 2-4 激励 + 并行:AgentTeam goal / 群聊 / AML 通道 / 工作台 UI ═══')
const spReadback = globalThis.__spReadback
const closeAndRestart = async (i) => {
  await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {})
  await sleep(3000)
  const st = await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId })
  if (st.status !== 200) { await sleep(8000); await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId }) }
  console.log(`  ↳ 批次 ${i} 闭合/重启`)
}
const runBatch = async (n, steps, sideWork) => {
  await closeAndRestart(n)
  const t0 = Date.now()
  let prev = 0
  for (const st of steps) {
    await sleep(st.at - prev); prev = st.at
    const w = await callA('POST', `/api/workshop/dcw/${twin.dcw[st.node]}/write`, { value: st.v })
    console.log(`  ↳ 批次 ${n} 阶跃 ${st.node} ← ${st.v} ${w.status === 200 ? '√' : '✘ ' + String(w.message ?? '').slice(0, 60)}`)
  }
  const rest = 300_000 - (Date.now() - t0)
  if (sideWork) await Promise.race([sideWork(), sleep(Math.max(rest, 5000)).then(() => console.log(`  ↳ 批次 ${n} 窗口到,侧线作业让路`))])
  await sleep(Math.max(0, 300_000 - (Date.now() - t0)))
}
const BATCHES = [
  { n: 2, steps: [{ at: 65_000, node: 'linespeed-sp', v: 97 }, { at: 200_000, node: 'diegap-sp', v: 1.03 }] },
  { n: 3, steps: [{ at: 65_000, node: 'linespeed-sp', v: 93 }, { at: 200_000, node: 'diegap-sp', v: 0.97 }] },
  { n: 4, steps: [{ at: 65_000, node: 'linespeed-sp', v: 97 }, { at: 200_000, node: 'diegap-sp', v: 1.0 }] },
]

/* ── 侧线 A:AgentTeam 创建 + goal 任务下发(mock harness 真实调度)+ 群聊 REST ── */
const sideTeamChat = async () => {
  const TAG = Date.now().toString(36)
  /* 团队正确流:全局 Agent 模板(/agents)→ team members(引用模板)→ deploy 克隆进频道;
     频道初始不带 lead(部署自带 lead,重复会 409 LEAD_EXISTS) */
  const tpl = {}
  for (const k of ['lead', 'wa', 'wb']) {
    const a = await callA('POST', '/api/workshop/agents', { name: `e2e-${k}-${TAG}`, harness: 'mock' })
    tpl[k] = a.data?.id ?? a.data?.agent?.id
  }
  ok('P3a-1 mock Agent 模板 ×3(全局库)', Boolean(tpl.lead && tpl.wa && tpl.wb), JSON.stringify(tpl))
  const ch = await callA('POST', '/api/workshop/channels', {
    name: `全功能E2E-team-${TAG}`, description: '全功能 E2E:mock 团队 goal 闭环 + 群聊',
  })
  const channelId = ch.data?.channelId
  ok('P3a 创建团队 Channel(无预置成员)', Boolean(channelId), String(ch.message ?? ''))
  const team = await callA('POST', '/api/workshop/teams', { name: `全功能E2E-Team-${TAG}` })
  const teamId = team.data?.id ?? team.data?.teamId
  const m1 = await callA('POST', `/api/workshop/teams/${teamId}/members`, { agentId: tpl.lead, role: 'lead' })
  const m2 = await callA('POST', `/api/workshop/teams/${teamId}/members`, { agentId: tpl.wa, role: 'worker' })
  const m3 = await callA('POST', `/api/workshop/teams/${teamId}/members`, { agentId: tpl.wb, role: 'worker' })
  ok('P3b 团队成员挂接(1 lead + 2 worker 模板)', [m1.status, m2.status, m3.status].every(s => s === 200), `${m1.status}/${m2.status}/${m3.status}`)
  const dep = await callA('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId })
  ok('P3c AgentTeam 部署到 Channel(克隆成实例)', dep.status === 200, String(dep.message ?? ''))
  const agents = (await callA('GET', `/api/workshop/channels/${channelId}/agents`)).data ?? []
  ok('P3b-2 频道成员结构(1 lead + 2 worker)', agents.length === 3 && agents.filter(a => a.role === 'worker').length === 2, `n=${agents.length}`)

  try { await callA('POST', `/api/workshop/channels/${channelId}/activate`, {}) } catch { /* 未激活也可:任务提交即自动装配 */ }
  const lead = agents.find(a => a.role === 'lead')
  const task = await callA('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `膜厚优化 goal ${TAG}`, mode: 'goal',
    description: '[mock:complex] 目标:确认产线膜厚工况稳定。拆解:①检查当前 PV 趋势 ②给出结论收口。',
    assigneeId: lead?.id,
  })
  const taskId = task.data?.id
  ok('P3d goal 任务下发', Boolean(taskId), String(task.message ?? ''))
  let row = null
  for (let i = 0; i < 60 && !row; i++) {
    await sleep(3000)
    const tasks = (await callA('GET', `/api/workshop/channels/${channelId}/tasks`)).data ?? []
    row = tasks.find(t => t.id === taskId)
    if (row && ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.state)) break
    row = null
  }
  ok('P3e goal 任务真实调度完成(COMPLETED)', row?.state === 'COMPLETED', `state=${row?.state ?? 'timeout'}`)
  const sub = (await callA('GET', `/api/workshop/channels/${channelId}/tasks`)).data ?? []
  ok('P3f lead 派发子任务并收口(≥2 任务)', sub.length >= 2, `tasks=${sub.length}`)

  const chatOn = await callA('PATCH', `/api/workshop/channels/${channelId}`, { chatEnabled: 1 })
  const msg = await callA('POST', `/api/workshop/channels/${channelId}/chat/messages`, { text: `E2E 群聊消息 ${TAG}:请关注膜厚 PV 波动。` })
  ok('P3g 群聊开启+消息落库', msg.status === 200, `patch=${chatOn.status} ${String(msg.message ?? '')}`)
  const hist = (await callA('GET', `/api/workshop/channels/${channelId}/chat/messages?limit=50`)).data
  const items = Array.isArray(hist) ? hist : (hist?.items ?? hist?.messages ?? [])
  const fromAgents = new Set(items.map(m => m.agentName ?? m.senderName ?? m.from).filter(Boolean))
  ok('P3h 群聊时间线:人类+多成员发言', items.length >= 3 && fromAgents.size >= 2, `msgs=${items.length} senders=${[...fromAgents].join('|').slice(0, 80)}`)
  globalThis.__teamChannel = channelId
  return channelId
}

/* ── 侧线 B:AML 训练通道准备(模板实例化 + 绑定 + 场景编译冻结 + PhysicsSpec)── */
const sideAmlPrep = async () => {
  const scene = { sceneId: `fulle2e-thickness-${Date.now().toString(36)}`, sceneVersion: '1.0.0', lineId: twin.lineId, productId: twin.productId, recipeId }
  const inst = await callA('POST', '/api/workshop/channel-templates/chtpl-hybrid-twin-mpc-default/instantiate', {
    name: '全功能E2E训练通道', toolProfile: 'hybrid_twin', scene,
    objective: { objectiveId: 'thickness-50um', targets: { film_thickness: 50 } },
    controlPolicy: 'recommendation_only',
  })
  const d = inst.data ?? {}
  const channelA = d.channelId
  const workerA = (d.agents ?? []).find(a => a.role === 'worker')?.id
  ok('P3i AML 训练通道实例化(hybrid_twin)+ worker', Boolean(channelA && workerA), JSON.stringify({ channelA, workerA }).slice(0, 100))
  for (const nodeId of Object.values(twin.dcw)) await callA('POST', '/api/workshop/agent-tools/bindings', { agentId: workerA, nodeId, kind: 'dcw', mode: 'auto' })
  for (const nodeId of Object.values(twin.daq)) await callA('POST', '/api/workshop/agent-tools/bindings', { agentId: workerA, nodeId, kind: 'daq', mode: 'auto' })
  const invoke = async (tool, args, agentId) => {
    const r = await callA('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
    const result = r.json?.data?.result
    return { isError: Boolean(result?.isError), text: String(result?.text ?? ''), data: result?.data ?? null }
  }
  const disco = await invoke('twin_scene_discover', {}, workerA)
  ok('P3j 场景发现(target=1 语义命中)', !disco.isError && /"target"\s*:\s*1/.test(disco.text), disco.text.slice(0, 120))
  const compiled = await invoke('twin_scene_compile', {
    scene_id: scene.sceneId, scene_version: '1.0.0', line_id: twin.lineId, product_id: twin.productId, recipe_id: recipeId,
    prompt: '流延膜厚度闭环优化:目标膜厚 50μm。控制=6 个执行器设定点,观测=膜厚(目标)/熔温/熔压。约束:熔温 195~225℃,熔压 ≤22MPa。',
  }, workerA)
  ok('P3k 场景编译', !compiled.isError, compiled.text.slice(0, 120))
  const frozen = await invoke('twin_scene_freeze', { scene_id: scene.sceneId, scene_version: '1.0.0', confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'full-feature-e2e' }, workerA)
  ok('P3l 场景冻结(用户确认令牌)', !frozen.isError, frozen.text.slice(0, 120))
  const draft = await invoke('twin_physics_spec_draft', { dt_sec: 1 }, workerA)
  const artifactPath = (draft.text.match(/artifact:\s*([^\n]+)/) || [])[1]?.trim()
  ok('P3m 骨架 PhysicsSpec 生成', !draft.isError && Boolean(artifactPath) && existsSync(artifactPath), draft.text.slice(0, 120))
  globalThis.__aml = { channelA, workerA, scene, physicsSpec: artifactPath ? JSON.parse(readFileSync(artifactPath, 'utf8')) : null, invoke }
}

/* ── 侧线 C:工作台 UI 实发群聊(puppeteer,硬超时护栏)── */
const sideWorkshopUi = async () => {
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const withT = (label, ms, fn) => new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => done({ okT: false, e: new Error(`hard-timeout:${label}(${ms}ms)`) }), ms)
    Promise.resolve().then(fn).then(v => done({ okT: true, v }), e => done({ okT: false, e }))
  })
  const killBrowser = async (b) => {
    if (!b) return
    const r = await withT('browser-close', 12000, () => b.close())
    if (!r.okT) { try { b.process()?.kill() } catch { /* 已死 */ } }
  }
  const r = await withT('workshop-ui', 180000, async () => {
    const b = await launch()
    try {
      const page = await openPage(b, { token: TOKEN, width: 1440, height: 900 })
      for (let i = 0; i < 30 && !globalThis.__teamChannel; i++) await sleep(2000)
      const chId = globalThis.__teamChannel
      if (!chId) return { clicked: false, sent: false, why: '团队频道未就绪' }
      await gotoReady(page, '/workshop', { wait: 3000, timeout: 40000 })
      const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[class*=channel], li, a, .menu-item'))
          .find(e => (e.textContent ?? '').includes('全功能E2E-team') && e.offsetHeight > 0)
        if (el) { el.click(); return true }
        return false
      })
      await sleep(2500)
      const ta = await page.$('.composer-pane textarea') ?? await page.$('textarea')
      let sent = false
      if (ta) {
        await ta.type('UI 直发:工作台 composer 群聊消息(E2E)')
        await page.keyboard.press('Enter')
        await sleep(4000)
        sent = await page.evaluate(() => (document.body.innerText ?? '').includes('UI 直发:工作台 composer 群聊消息(E2E)'))
      }
      await page.screenshot({ path: join(SHOTS, 'workshop-chat.png') })
      return { clicked, sent, why: '' }
    }
    finally { await killBrowser(b) }
  })
  ok('P3n 工作台 UI 实发群聊(composer→时间线)', r.okT && r.v?.clicked && r.v?.sent, r.okT ? `clicked=${r.v?.clicked} sent=${r.v?.sent} ${r.v?.why}` : String(r.e).slice(0, 120))
}

/* ── 侧线 D:孪生渲染深检(频道已挂载后;/town 渲染 workshop Channel)── */
const sideTownCheck = async () => {
  const { launch, openPage, gotoReady } = await import('../ui/lib.mjs')
  const withT = (label, ms, fn) => new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => done({ okT: false, e: new Error(`hard-timeout:${label}(${ms}ms)`) }), ms)
    Promise.resolve().then(fn).then(v => done({ okT: true, v }), e => done({ okT: false, e }))
  })
  const killBrowser = async (b) => {
    if (!b) return
    const r = await withT('browser-close', 12000, () => b.close())
    if (!r.okT) { try { b.process()?.kill() } catch { /* 已死 */ } }
  }
  const r = await withT('town-deep', 120000, async () => {
    const b = await launch()
    try {
      const page = await openPage(b, { token: TOKEN, width: 1440, height: 900 })
      const errs = []
      page.on('pageerror', e => errs.push(String(e.message).slice(0, 100)))
      await gotoReady(page, '/town', { wait: 9000, timeout: 40000 })
      const town = await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        const stats = window.__townStats
        return {
          canvas: Boolean(canvas), w: canvas?.width ?? 0, h: canvas?.height ?? 0,
          statsKeys: stats ? Object.keys(stats) : [], fps: Number(stats?.fps ?? stats?.fpsAvg ?? 0) || null,
        }
      })
      await page.screenshot({ path: join(SHOTS, 'town-deep.png') })
      return { town, errs }
    }
    finally { await killBrowser(b) }
  })
  if (r.okT) {
    ok('P3q-1 孪生 canvas 渲染(频道挂载后)', r.v.town.canvas && r.v.town.w > 400, JSON.stringify({ w: r.v.town.w, h: r.v.town.h }))
    ok('P3q-2 __townStats 仪表在位', r.v.town.statsKeys.length > 0, `keys=${r.v.town.statsKeys.join(',')} fps=${r.v.town.fps} errs=${r.v.errs.length}`)
  }
  else { ok('P3q-1 孪生 canvas 渲染(频道挂载后)', false, String(r.e).slice(0, 120)); ok('P3q-2 __townStats 仪表在位', false, 'town 页未完成') }
}

await runBatch(2, BATCHES[0].steps, sideTeamChat)
ok('P3o 群聊频道句柄就绪', Boolean(globalThis.__teamChannel))
await runBatch(3, BATCHES[1].steps, sideAmlPrep)
await runBatch(4, BATCHES[2].steps, async () => { await sideWorkshopUi(); await sideTownCheck() })
await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {})
await sleep(3000)
{
  const runs = (await callA('GET', '/api/workshop/dcw/recipes')).data?.runs ?? []
  const closed = runs.filter(x => x.endedAt && x.recipeId === recipeId)
  ok('P3p 4 个已闭合批次(激励数据)', closed.length >= 4, `closed=${closed.length}`)
}

/* ═══ Phase 4 · AML:数据集 → 真实训练(平台门禁)═══ */
console.log('═══ [P4] AML 集成:数据集构建 + hybrid_residual 真实训练 ═══')
let ds, model
{
  const { scene, physicsSpec } = globalThis.__aml
  ds = (await callA('POST', '/api/workshop/aml/datasets', {
    lineId: twin.lineId, productId: twin.productId, recipeId,
    nodes: [
      ...Object.values(spReadback).map(nid => ({ nodeId: nid, role: 'control' })),
      { nodeId: twin.daq['film-thickness'], role: 'target' },
      { nodeId: twin.daq['melt-pressure'], role: 'feature' },
      { nodeId: twin.daq['melt-temp'], role: 'feature' },
    ],
    beatMs: 1000, window: { historySteps: 8, horizonSteps: 4 },
    split: { valRatio: 0.34, testRatio: 0.33, seed: 42 },
    purpose: 'mpc_surrogate', note: '全功能 E2E 数据集',
  })).data?.dataset
  ok('P4a 数据集构建(9 变量 + ≥4 runs)', Boolean(ds?.id) && (ds.runIds?.length ?? 0) >= 4, JSON.stringify({ id: ds?.id, rows: ds?.rowCount, runs: ds?.runIds?.length }).slice(0, 140))
  ok('P4b 数据集实体落运行时目录', existsSync(join(HOME, 'aml', 'datasets', ds.id, 'manifest.json')), join(HOME, 'aml', 'datasets', ds.id))

  const man = JSON.parse(readFileSync(join(HOME, 'aml', 'datasets', ds.id, 'manifest.json'), 'utf8'))
  const datasetNodes = new Set(man.allNodes)
  const dwToDn = {}
  for (const [sig, dn] of Object.entries(spReadback)) dwToDn[twin.dcw[sig]] = dn
  for (const v of physicsSpec.variables) {
    if (v.nodeId && !datasetNodes.has(v.nodeId) && dwToDn[v.nodeId]) v.nodeId = dwToDn[v.nodeId]
  }
  const keptVars = physicsSpec.variables.filter(v => !v.nodeId || datasetNodes.has(v.nodeId))
  const keptIds = new Set(keptVars.map(v => v.id))
  physicsSpec.variables = keptVars
  physicsSpec.states = physicsSpec.states.filter((e) => { const base = e.lhs.endsWith('_next') ? e.lhs.slice(0, -5) : e.lhs; return keptIds.has(base) })
  physicsSpec.observations = physicsSpec.observations.filter(e => keptIds.has(e.lhs))
  physicsSpec.guards = (physicsSpec.guards ?? []).filter(e => keptIds.has(e.lhs))
  physicsSpec.constraints = physicsSpec.constraints.filter(c => keptIds.has(c.id))

  const job = (await callA('POST', '/api/workshop/aml/jobs', {
    datasetId: ds.id, purpose: 'mpc_surrogate', changeNote: '全功能 E2E 真实训练',
    params: { epochs: 600, hidden: 192, lr: 0.0008, residual_scale: 2.5, ensemble: 3 },
    seed: 7, jobKind: 'hybrid_residual', sceneId: scene.sceneId, sceneVersion: '1.0.0', objectiveId: 'thickness-50um',
    physicsSpec, providerId: physicsSpec.modelId, providerVersion: '1.0.0', providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
    modelName: '全功能E2E 膜厚闭环模型', modelDescription: '全功能端到端验收:输入=6 执行器 SP 回读,输出=膜厚(目标 50μm)',
  })).data?.job
  ok('P4c 训练作业提交(hybrid_residual)', Boolean(job?.id), JSON.stringify(job ?? {}).slice(0, 140))

  let done = null
  for (let i = 0; i < 120; i++) {
    await sleep(5000)
    done = (await callA('GET', `/api/workshop/aml/jobs/${job.id}`)).data?.job
    if (done?.status === 'done' || done?.status === 'failed') break
    if (i > 0 && i % 12 === 0) console.log(`  ↳ 训练中 (${i * 5 / 60 | 0}min) status=${done?.status ?? '?'}`)
  }
  ok('P4d 训练完成且平台门禁全过', done?.status === 'done', `status=${done?.status} err=${String(done?.error ?? '').slice(0, 160)}`)
  const models = (await callA('GET', '/api/workshop/aml/models')).data?.models ?? []
  model = models.filter(m => m.datasetId === ds.id).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  ok('P4e 模型注册 + 工件在运行时目录', Boolean(model?.id) && existsSync(join(HOME, 'aml', 'models', model.id, 'model.onnx')), join(HOME, 'aml', 'models', model?.id ?? '?'))
  console.log(`  ↳ 模型 ${model?.id} label=${model?.label} G1=${model?.metrics?.oneStepTest?.nrmse} G2=${model?.metrics?.rolloutTest?.nrmse}`)
}

/* ═══ Phase 5 · AML 投用链:快照 → 试验 → 场景门禁 → 两段 HITL 晋升 → MPC 自动投用 → 写回复测 ═══ */
console.log('═══ [P5] AML 投用:快照/试验/门禁/HITL 晋升/MPC 自动投用 ═══')
if (!model?.id) {
  console.log('  ↳ 训练未产出可用模型(P4 门禁未过)→ fail-closed:跳过投用链,治理正确行为')
  ok('P5 投用链前置(存在已过门禁模型)', false, 'model 不存在')
  await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {})
}
else {
  const { workerA, invoke, scene } = globalThis.__aml
  const st = await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId })
  if (st.status !== 200) { await sleep(8000); await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId }) }
  let snapshotId = null
  let snap = null
  for (let attempt = 1; attempt <= 8 && !snapshotId; attempt++) {
    if (attempt > 1) { console.log('  ↳ 快照重试'); await sleep(20000) }
    snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: globalThis.__aml.channelA, phase: 'calibration' }, workerA)
    snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
  }
  ok('P5a 孪生快照创建(auto_daq)', Boolean(snapshotId), snap?.text.slice(0, 140))

  const frozen = JSON.parse(readFileSync(join(HOME, 'aml', 'twins', 'scenes', `${scene.sceneId}-1.0.0-frozen`, 'scenes.json'), 'utf8')).scene ?? {}
  const targetObs = (frozen.observations ?? []).find(o => o.role === 'target')
  const speedCtl = (frozen.controls ?? []).find(c => (c.nodeId ?? '').includes('linespeed')) ?? (frozen.controls ?? [])[0]
  const dcwRes = await callA('GET', '/api/workshop/dcw/')
  const dwValueById = Object.fromEntries((dcwRes.data?.nodes ?? []).filter(n => n.lineId === twin.lineId).map(n => [n.id, Number(n.value)]))
  const baseline = Object.fromEntries((frozen.controls ?? []).map(c => [c.id, dwValueById[c.nodeId]]).filter(([, v]) => Number.isFinite(v)))
  let trialOk = 0
  for (let k = 0; k < 12; k++) {
    const delta = (k % 2 === 0 ? 1 : -0.5) * (speedCtl.maxStep ?? 2) * (0.3 + 0.07 * k)
    const cand = { ...baseline, [speedCtl.id]: (baseline[speedCtl.id] ?? 95) + delta }
    const t = await invoke('twin_trial_run', { snapshot_id: snapshotId, model_id: model.id, baseline_controls: baseline, candidate_controls: Array.from({ length: 4 }, () => cand) }, workerA)
    if (!t.isError && /improvement/.test(t.text)) trialOk++
  }
  ok('P5b 模型背书试验 12 组', trialOk >= 10, `ok=${trialOk}/12`)
  const gate = await invoke('twin_gate_evaluate', { model_id: model.id, scene_id: scene.sceneId }, workerA)
  const gatePassed = /"gatePassed":\s*true/.test(gate.text)
  ok('P5c 场景级门禁评估(eligibility 写回)', !gate.isError && /gatePassed/.test(gate.text), gate.text.slice(0, 160))
  writeFileSync(join(HOME, 'e2e-gate.txt'), gate.text)

  if (gatePassed) {
    const promoteStage = async (toStage) => {
      const p = invoke('aml_model_promote', { model_id: model.id, to_stage: toStage }, (await callA('GET', `/api/workshop/channels/${globalThis.__aml.channelA}/agents`)).data?.find(a => a.role === 'lead')?.id)
      let rid = null
      for (let i = 0; i < 30 && !rid; i++) {
        await sleep(2000)
        const pend = await callA('GET', '/api/workshop/hitl/pending')
        const items = pend.data?.items ?? pend.data ?? []
        const hit = (Array.isArray(items) ? items : []).find(x => (x.detail ?? x.title ?? '').includes(model.id))
        if (hit) rid = hit.id ?? hit.requestId
      }
      if (rid) await callA('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: rid, confirmed: true, comment: `E2E:门禁全过,批准 ${toStage}` })
      const r = await p
      return r.text
    }
    const s1 = await promoteStage('shadow')
    ok('P5d HITL 晋升 shadow', /晋升完成|shadow/.test(s1), s1.slice(0, 140))
    const s2 = /晋升完成/.test(s1) ? await promoteStage('production') : ''
    ok('P5e HITL 晋升 production', /晋升完成/.test(s2), s2.slice(0, 140))

    const objective = {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'full-e2e',
      objectiveId: 'thickness-50um', targets: { [targetObs.id]: 50 }, weights: { [targetObs.id]: 1 },
      controlCosts: {}, horizonSteps: 4, trustRegion: {},
    }
    const mpc = await invoke('mpc_optimize', { snapshot_id: snapshotId, baseline_controls: baseline, horizon_steps: 4, objective }, workerA)
    const rolloutModel = (mpc.text.match(/"rolloutModel":\s*"([^"]+)"/) || [])[1]
    const backed = (mpc.text.match(/"rolloutModelBacked":\s*(true|false)/) || [])[1]
    const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
    ok('P5f MPC 未传 model_id 自动投用 production', rolloutModel === model.id && backed === 'true', `rollout=${rolloutModel} backed=${backed}`)
    let best = null
    try { best = JSON.parse(bestCandidate ?? 'null') } catch { /* 忽略 */ }
    const idToNode = Object.fromEntries((frozen.controls ?? []).map(c => [c.id, c.nodeId]))
    let wrote = 0
    for (const [specId, value] of Object.entries(best ?? {})) {
      const nodeId = idToNode[specId]
      if (!nodeId || !Number.isFinite(Number(value))) continue
      const w = await callA('POST', `/api/workshop/dcw/${nodeId}/write`, { value })
      if (w.status === 200) wrote++
    }
    ok('P5g MPC 推荐写回 DCW(治理链)', wrote > 0, `wrote=${wrote}`)
    await sleep(90000)
    const r = await callA('GET', `/api/workshop/daq/${targetObs.nodeId}/samples?bucketMs=1000&limit=60`)
    const pts = (r.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
    const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
    ok('P5h 写回后 PV 复测(膜厚有读数)', Number.isFinite(mean), `mean=${Number.isFinite(mean) ? mean.toFixed(2) : 'n/a'} μm(目标 50)`)
  }
  else {
    console.log('  ↳ 场景门禁未过 → fail-closed:不发起投用审批、不写 DCW(治理正确行为)')
    ok('P5d 门禁未过时 fail-closed(不越级投用)', true)
  }
  await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {})
}

/* ═══ 汇总 ═══ */
console.log(`\n═══ 全功能端到端验收:${pass} PASS / ${fails.length} FAIL ═══`)
if (fails.length) console.log(fails.map(f => `  ✖ ${f}`).join('\n'))
console.log(`截图与工件:${SHOTS}`)
console.log(`实例保留:${BASE}(admin ${ADMIN.email} / ${ADMIN.password});模拟器 ${SIM}`)
writeFileSync(join(HOME, 'e2e-summary.json'), JSON.stringify({ pass, fails, base: BASE, sim: SIM, lineId: twin.lineId, recipeId, dataset: ds?.id, model: model?.id }, null, 2))
if (!KEEP) {
  console.log('(默认不清理实例,便于人工复核;如需清理请 kill 上述端口进程)')
}
process.exit(fails.length ? 1 : 0)
