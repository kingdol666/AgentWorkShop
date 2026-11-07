#!/usr/bin/env node
/**
 * Session Context UI 验收：Channel sessions 视图（brief + composer + 回执）与 Project sessions 卡。
 * 运行：node scripts/session-context-ui-acceptance.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = mkdtempSync(join(tmpdir(), 'aw-session-ui-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })
const PORT = 3992
const BASE = `http://127.0.0.1:${PORT}`
const EVID = join(REPO, 'docs/audit/evidence/2026-11-07-session-context')
mkdirSync(EVID, { recursive: true })

const child = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NITRO_PORT: String(PORT),
    AW_MODE: 'home',
    AW_HOME: HOME,
    NUXT_SESSION_PASSWORD: 'SessionContext#2026-ui',
    AW_PROMPTS_DIR: join(REPO, '.output/.AgentWorkShop/prompts'),
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let serverLog = ''
child.stdout?.on('data', (d) => {
  serverLog += String(d)
})
child.stderr?.on('data', (d) => {
  serverLog += String(d)
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json().catch(() => ({ status: res.status }))
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    }
    catch { /* retry */ }
    await sleep(1000)
  }
  throw new Error('server 未 ready')
}
async function poll(fn, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(400)
  }
  return null
}

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 300)}`}`)
}

let browser
try {
  await waitReady()
  const email = `session-ui-${Date.now()}@aw.local`
  const reg = await api('POST', '/api/users/register', { name: 'UI Owner', email, password: 'Session#2026' })
  const token = reg.data?.token
  ok('U0', '注册 owner', !!token, reg.message)

  // 基础 Channel + 手工会话 + 一条消息（让 brief 有内容）
  const ch = await api('POST', '/api/workshop/channels', {
    name: `Session UI ${Date.now()}`,
    leadAgent: { name: 'Lead', harness: 'mock', config: {} },
  }, token)
  const channelId = ch.data?.channelId
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: 'Worker', harness: 'mock', role: 'worker', config: {} }, token)
  const sess = await api('POST', `/api/workshop/channels/${channelId}/sessions`, { title: 'UI 验收会话' }, token)
  const sessionId = sess.data?.sessionId
  await api('POST', `/api/workshop/channels/${channelId}/sessions/${sessionId}/messages`, { text: '请报告当前会话上下文' }, token)
  await poll(async () => {
    const msgs = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=50`, undefined, token)
    return (msgs.data ?? []).some(m => m.metadata?.['x-aw-session-id'] === sessionId && m.role === 'ROLE_AGENT')
  }, 25000)

  // Workspace 挂载
  const ws = await api('POST', '/api/workshop/workspaces', { name: 'Session UI Workspace' }, token)
  const wsId = ws.data?.id
  if (wsId) await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`, {}, token)
  ok('U1', '创建工作区并挂载 Channel', !!wsId, ws.message)

  browser = await puppeteer.launch({
    executablePath: process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  await page.setCookie({ name: 'aw-theme', value: 'dark', domain: '127.0.0.1', path: '/' })
  await page.goto(`${BASE}/workshop/w/${wsId}?view=sessions&channel=${channelId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.sm-wrap', { timeout: 60000 })
  await page.waitForSelector('.sm-compose textarea', { timeout: 30000 })
  await sleep(1200)
  ok('U2', 'Channel sessions 视图渲染', await page.$('.sm-compose textarea') != null)

  const briefText = await page.evaluate(() => document.querySelector('.sm-brief')?.textContent ?? '')
  ok('U3', 'session brief 卡渲染', /Session Context/.test(briefText) && /当前任务/.test(briefText), briefText.slice(0, 300))

  const composer = await page.$('.sm-compose textarea')
  await composer?.click()
  await page.keyboard.type('UI 验收：继续补充上下文')
  const sendBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.sm-compose-actions button')].find(b => b.textContent?.includes('发送')))
  await sendBtn.asElement()?.click()
  const replied = await poll(async () => page.evaluate(() => document.querySelector('.sm-msgs')?.textContent?.includes('mock 群聊回复') ?? false), 25000)
  ok('U4', 'UI 发送 → clone 回执', Boolean(replied))
  await page.screenshot({ path: join(EVID, 'channel-session-desktop.png') })

  // 移动端
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.sm-wrap', { timeout: 60000 })
  await sleep(1200)
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  ok('U5', '移动端无横向溢出', !overflowX, `overflow=${overflowX}`)
  await page.screenshot({ path: join(EVID, 'channel-session-mobile.png') })

  // Project sessions 卡
  const proj = await api('POST', '/api/workshop/projects', {
    name: `Session UI 项目 ${Date.now()}`,
    objective: 'UI session card',
    leaderHarness: 'mock',
    routingPolicy: 'legacy',
  }, token)
  const projectId = proj.data?.id
  if (projectId) {
    await api('POST', `/api/workshop/projects/${projectId}/channels`, { channelId, charter: 'UI 执行' }, token)
    const del = await api('POST', `/api/workshop/projects/${projectId}/deliverables`, { name: 'UI 交付物', required: true, ownerChannelId: channelId, acceptanceCriteria: ['artifact_present'] }, token)
    const wi = await api('POST', `/api/workshop/projects/${projectId}/work-items`, { deliverableId: del.data?.id, channelId, title: 'UI 工作项', brief: 'ui', execBudgetMinutes: 5 }, token)
    await api('POST', `/api/workshop/projects/${projectId}/activate`, {}, token)
    const plan = await api('POST', `/api/workshop/projects/${projectId}/plan/request-approval`, { version: 1, plan: { facts: ['ui'] } }, token)
    if (plan.data?.id) await api('POST', `/api/workshop/projects/${projectId}/approvals/${plan.data.id}/decide`, { approve: true }, token)
    await api('POST', `/api/workshop/projects/${projectId}/work-items/${wi.data?.id}/dispatch`, {}, token)
    await poll(async () => {
      const r = await api('GET', `/api/workshop/projects/${projectId}/sessions`, undefined, token)
      return (r.data ?? []).length >= 2
    }, 30000)
    const page2 = await browser.newPage()
    await page2.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
    await page2.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
    await page2.setCookie({ name: 'aw-theme', value: 'dark', domain: '127.0.0.1', path: '/' })
    await page2.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page2.waitForSelector('[data-testid="project-sessions"]', { timeout: 60000 })
    const projectSessionsRendered = await poll(async () => page2.evaluate(() => {
      const card = document.querySelector('[data-testid="project-sessions"]')
      const text = card?.textContent ?? ''
      return Boolean(card && !text.includes('0 个 session') && document.querySelector('[data-testid^="open-project-session-"]'))
    }), 30000)
    await sleep(1200)
    ok('U6', 'Project sessions 卡渲染 project/task', Boolean(projectSessionsRendered), await page2.evaluate(() => document.querySelector('[data-testid="project-sessions"]')?.textContent?.slice(0, 300) ?? ''))
    await page2.screenshot({ path: join(EVID, 'project-sessions-desktop.png') })
    await page2.close()
  }
  else {
    ok('U6', 'Project sessions 卡渲染 project/task', false, proj.message)
  }

  const failed = results.filter(r => !r.pass).length
  writeFileSync(join(EVID, 'ui-acceptance.json'), JSON.stringify({ generatedAt: new Date().toISOString(), pass: results.length - failed, fail: failed, results }, null, 2))
  writeFileSync(join(EVID, 'ui-server.log'), serverLog.slice(-20000))
  console.log(`\n=== SESSION UI ACCEPTANCE pass=${results.length - failed} fail=${failed} ===`)
  process.exitCode = failed > 0 ? 1 : 0
}
catch (err) {
  console.error('UI 验收异常:', err)
  writeFileSync(join(EVID, 'ui-error.log'), `${err?.stack ?? err}\n\n--- server ---\n${serverLog.slice(-20000)}`)
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
  process.exit(process.exitCode ?? 0)
}
