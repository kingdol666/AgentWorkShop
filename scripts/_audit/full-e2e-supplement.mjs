#!/usr/bin/env node
/**
 * scripts/_audit/full-e2e-supplement.mjs —— 全功能 E2E 的补测(主跑 full-feature-e2e-20260927
 * 首轮暴露三处测试脚本问题,修复后对同一存活实例补齐证据):
 *   S1 真实登录流(/workshop AuthGate,input[type=email/password] 精确定位 + 显式点「登录」)
 *   S2 AgentTeam 正确部署流(mock 模板×3 → team members → deploy 克隆 → goal 任务)
 *      + 群聊开关(chatEnabled=1)→ 人类消息落库 → 时间线多成员发言
 *   S3 工作台 UI 实发群聊(点开频道 → composer 发送 → 时间线出现)
 *   S4 孪生渲染深检(频道已挂载后:canvas + __townStats + 截图)
 * 用法:node scripts/_audit/full-e2e-supplement.mjs
 */
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3474'
const ADMIN = { email: 'e2e-full@awshop.local', password: 'E2eFull2026!' }
const HOME = join(tmpdir(), 'aw-full-e2e-fmtJ6b')
const SHOTS = join(HOME, 'shots')
mkdirSync(SHOTS, { recursive: true })

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const callA = async (method, path, body, token) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json, data: json?.data, message: json?.message }
}

process.env.AW_BASE = BASE
process.env.AW_UI_SCALE = '1'
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
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
if (!existsSync(CHROME)) { console.log(`✖ Chrome 不存在:${CHROME}`); process.exit(1) }

const health = await callA('GET', '/api/health')
ok('S0 实例健康(3474 存活)', health?.data?.status === 'ok', String(health?.message ?? ''))

/* ── S1 真实登录流 ── */
let TOKEN = ''
{
  const r = await withT('login-flow', 150000, async () => {
    const b = await launch()
    try {
      const lp = await b.newPage()
      const errs = []
      lp.on('pageerror', e => errs.push(String(e.message).slice(0, 120)))
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
      await lp.screenshot({ path: join(SHOTS, 'supplement-login.png') })
      return { loggedIn, errs: errs.length }
    }
    finally { await killBrowser(b) }
  })
  ok('S1 真实登录流(登录门提交→卸载)', r.okT && r.v?.loggedIn, r.okT ? `errs=${r.v?.errs}` : String(r.e).slice(0, 120))
  const reg = await callA('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })
  TOKEN = reg?.data?.token ?? ''
}
ok('S1b API 登录取 token(后续 UI 用)', Boolean(TOKEN))

/* ── S2 AgentTeam 正确部署流 + 群聊 ── */
const TAG = Date.now().toString(36)
let channelId
{
  const tpl = {}
  for (const k of ['lead', 'wa', 'wb']) {
    const a = await callA('POST', '/api/workshop/agents', { name: `sup-${k}-${TAG}`, harness: 'mock' }, TOKEN)
    tpl[k] = a.data?.id ?? a.data?.agent?.id
  }
  ok('S2a mock Agent 模板 ×3', Boolean(tpl.lead && tpl.wa && tpl.wb), JSON.stringify(tpl))
  const ch = await callA('POST', '/api/workshop/channels', { name: `补测-team-${TAG}`, description: '全功能 E2E 补测:团队 goal + 群聊' }, TOKEN)
  channelId = ch.data?.channelId
  ok('S2b 创建频道', Boolean(channelId), String(ch.message ?? ''))
  const team = await callA('POST', '/api/workshop/teams', { name: `补测-Team-${TAG}` }, TOKEN)
  const teamId = team.data?.id ?? team.data?.teamId
  const ms = []
  ms.push(await callA('POST', `/api/workshop/teams/${teamId}/members`, { agentId: tpl.lead, role: 'lead' }, TOKEN))
  ms.push(await callA('POST', `/api/workshop/teams/${teamId}/members`, { agentId: tpl.wa, role: 'worker' }, TOKEN))
  ms.push(await callA('POST', `/api/workshop/teams/${teamId}/members`, { agentId: tpl.wb, role: 'worker' }, TOKEN))
  ok('S2c 团队成员挂接', ms.every(m => m.status === 200), ms.map(m => m.status).join('/'))
  const dep = await callA('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId }, TOKEN)
  ok('S2d AgentTeam 部署到 Channel', dep.status === 200, String(dep.message ?? ''))
  const agents = (await callA('GET', `/api/workshop/channels/${channelId}/agents`, undefined, TOKEN)).data ?? []
  ok('S2e 频道成员结构(1 lead + 2 worker)', agents.length === 3 && agents.filter(a => a.role === 'worker').length === 2, `n=${agents.length}`)
  try { await callA('POST', `/api/workshop/channels/${channelId}/activate`, {}, TOKEN) } catch { /* 任务提交即自动装配 */ }

  const lead = agents.find(a => a.role === 'lead')
  const task = await callA('POST', `/api/workshop/channels/${channelId}/tasks`, {
    title: `补测 goal ${TAG}`, mode: 'goal',
    description: '目标:确认产线膜厚工况稳定,给出结论。',
    assigneeId: lead?.id,
  }, TOKEN)
  ok('S2f goal 任务下发', Boolean(task.data?.id), String(task.message ?? ''))
  let state = ''
  for (let i = 0; i < 50; i++) {
    await sleep(3000)
    const tasks = (await callA('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, TOKEN)).data ?? []
    const row = tasks.find(t => t.id === task.data?.id)
    if (row && ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.state)) { state = row.state; break }
  }
  ok('S2g goal 任务调度完成(COMPLETED)', state === 'COMPLETED', `state=${state || 'timeout'}`)

  const chatOn = await callA('PATCH', `/api/workshop/channels/${channelId}`, { chatEnabled: 1 }, TOKEN)
  const msg = await callA('POST', `/api/workshop/channels/${channelId}/chat/messages`, { text: `补测群聊 ${TAG}:请关注膜厚 PV 波动。` }, TOKEN)
  ok('S2h 群聊开启+人类消息落库', msg.status === 200, `patch=${chatOn.status} ${String(msg.message ?? '')}`)
  await sleep(3000)
  const hist = (await callA('GET', `/api/workshop/channels/${channelId}/chat/messages?limit=50`, undefined, TOKEN)).data
  const items = Array.isArray(hist) ? hist : (hist?.items ?? hist?.messages ?? [])
  ok('S2i 人类消息可读回', items.some(m => String(m.text ?? m.content ?? '').includes('补测群聊')), `msgs=${items.length}`)
  /* mock 团队的成员发言走 A2A 事件时间线(任务分派/进度/artifact),不写 chat —— 按事件断言 */
  const ev = (await callA('GET', `/api/workshop/channels/${channelId}/events`, undefined, TOKEN)).data
  const evList = Array.isArray(ev) ? ev : (ev?.items ?? ev?.events ?? [])
  const agentEv = evList.filter(e => /agent\./.test(String(e.type ?? '')))
  ok('S2j 事件时间线含成员活动(分派/状态/工件)', evList.length >= 5 && agentEv.length >= 2, `events=${evList.length} agent-events=${agentEv.length} types=${[...new Set(evList.map(e => e.type))].slice(0, 6).join(',')}`)
}

/* ── S3 工作台 UI 实发群聊 + S4 孪生深检(共用一次浏览器)── */
{
  const r = await withT('ui-chat-town', 220000, async () => {
    const b = await launch()
    try {
      const page = await openPage(b, { token: TOKEN, width: 1440, height: 900 })
      await gotoReady(page, '/workshop', { wait: 3000, timeout: 40000 })
      const clicked = await page.evaluate((tag) => {
        const el = Array.from(document.querySelectorAll('[class*=channel], li, a, .menu-item'))
          .find(e => (e.textContent ?? '').includes(`补测-team-${tag}`) && e.offsetHeight > 0)
        if (el) { el.click(); return true }
        return false
      }, TAG)
      await sleep(2500)
      const ta = await page.$('.composer-pane textarea') ?? await page.$('textarea')
      let sent = false
      if (ta) {
        await ta.type('UI 直发:composer 群聊消息(补测)')
        await page.keyboard.press('Enter')
        await sleep(4000)
        sent = await page.evaluate(() => (document.body.innerText ?? '').includes('UI 直发:composer 群聊消息(补测)'))
      }
      await page.screenshot({ path: join(SHOTS, 'supplement-workshop-chat.png') })
      await gotoReady(page, '/town', { wait: 9000, timeout: 40000 })
      const town = await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        const stats = window.__townStats
        return {
          canvas: Boolean(canvas), w: canvas?.width ?? 0, h: canvas?.height ?? 0,
          statsKeys: stats ? Object.keys(stats) : [], fps: Number(stats?.fps ?? stats?.fpsAvg ?? 0) || null,
        }
      })
      await page.screenshot({ path: join(SHOTS, 'supplement-town.png') })
      return { clicked, sent, town }
    }
    finally { await killBrowser(b) }
  })
  ok('S3 工作台 UI 实发群聊(composer→时间线)', r.okT && r.v?.clicked && r.v?.sent, r.okT ? `clicked=${r.v?.clicked} sent=${r.v?.sent}` : String(r.e).slice(0, 120))
  ok('S4-1 孪生 canvas 渲染(频道挂载后)', r.okT && r.v?.town?.canvas && r.v.town.w > 400, r.okT ? JSON.stringify({ w: r.v.town.w, h: r.v.town.h }) : String(r.e).slice(0, 120))
  ok('S4-2 __townStats 仪表在位', r.okT && (r.v?.town?.statsKeys?.length ?? 0) > 0, r.okT ? `keys=${r.v.town.statsKeys.join(',')} fps=${r.v.town.fps}` : 'n/a')
}

console.log(`\n═══ 补测:${pass} PASS / ${fails.length} FAIL ═══`)
if (fails.length) console.log(fails.map(f => `  ✖ ${f}`).join('\n'))
process.exit(fails.length ? 1 : 0)
