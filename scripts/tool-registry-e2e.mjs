#!/usr/bin/env node
/**
 * scripts/tool-registry-e2e.mjs —— 工具注册表 + Channel 工具治理真实实例验收。
 *
 * 隔离纪律:AW_MODE=home + 临时 AW_HOME + 端口 3463;结束 taskkill //T。
 * 覆盖:
 *  - 本地插件安装(aw plugin install --global)
 *  - tool_registry 内置 86 + fixture 插件工具
 *  - Channel 工具视图 / all 模式停用 / selected 模式 allow-list
 *  - MCP bridge tools/list + tools/call + 执行面拒绝
 *  - MCP tools/list_changed 通知
 *  - 硬规则 409 / 未知工具 400 / 策略持久化 / 删除 Channel 清理
 *  - /tools 页面 + Channel 设置工具区渲染
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3463
const BASE = `http://127.0.0.1:${PORT}`
const HOME = mkdtempSync(join(tmpdir(), 'aw-tool-registry-e2e-'))
const EVIDENCE = join(REPO, 'docs', 'audit', 'evidence', '2026-10-20-tool-registry')
const FIXTURE = join(REPO, 'tests', 'fixtures', 'plugins', 'aw-fixture-tools')
const ADMIN = { name: 'tool-e2e-admin', email: 'tool-e2e@awshop.local', password: 'tool-e2e-passw0rd' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0
const fails = []
const checks = []
function ok(name, cond, detail = '') {
  checks.push({ name, ok: Boolean(cond), detail })
  if (cond) {
    pass++
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    fails.push(name)
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
    return (await r.json())?.data?.status === 'ok'
  }
  catch { return false }
}

let child = null
function startInstance() {
  const out = openSync(join(HOME, 'instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(PORT)], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      AW_MODE: 'home',
      AW_HOME: HOME,
      NUXT_SESSION_PASSWORD: 'aw-tool-registry-e2e-session-password-0123456789',
    },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  closeSync(out)
  child = p
  p.unref()
}
async function waitHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await health()) return true
    await sleep(1500)
  }
  return false
}
function killInstance() {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  }
  catch { /* ignore */ }
  child = null
}

let TOKEN = ''
async function api(method, path, body, token = TOKEN) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, ...json }
}

function spawnMcp(agent) {
  const p = spawn(process.execPath, [join(REPO, 'server', 'harness', 'aw-mcp-bridge.mjs')], {
    cwd: REPO,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      AW_BASE_URL: BASE,
      AW_AGENT_ID: agent.id,
      AW_AGENT_TOKEN: agent.token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const notifications = []
  let nextId = 1
  const rl = createInterface({ input: p.stdout })
  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    }
    catch {
      return
    }
    if (msg?.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
    else if (msg?.method) {
      notifications.push(msg)
    }
  })
  p.stderr.on('data', () => {})
  function rpc(method, params, timeoutMs = 30_000) {
    const id = nextId++
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRpc(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolveRpc(msg)
      })
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  async function call(name, args = {}) {
    return rpc('tools/call', { name, arguments: args })
  }
  return { p, rpc, call, notifications, close: () => {
    try {
      p.kill()
    }
    catch { /* already exited */ }
  } }
}

function dbQuery(sql, ...params) {
  const db = new DatabaseSync(join(HOME, 'data', 'workshop.sqlite'), { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  }
  finally {
    db.close()
  }
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true })
  console.log(`━━━ tool registry E2E @ ${BASE} (home=${HOME}) ━━━`)

  // S0: 本地插件安装(先验证 CLI,再启动实例)
  console.log('[S0] aw plugin install')
  {
    const r = spawnSync(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'plugin', 'install', FIXTURE, '--global'], {
      cwd: REPO,
      env: { ...process.env, AW_MODE: 'home', AW_HOME: HOME, NO_PROXY: '127.0.0.1,localhost' },
      encoding: 'utf8',
    })
    ok('插件安装命令退出码 0', r.status === 0, (r.stdout || r.stderr || '').trim().slice(0, 200))
    ok('插件目录落盘', existsSync(join(HOME, 'plugins', 'aw-fixture-tools', 'index.mjs')))
  }

  // S1: 启动隔离实例
  console.log('[S1] 启动隔离实例')
  startInstance()
  const up = await waitHealth()
  ok('实例健康门通过', up, `日志 ${join(HOME, 'instance.log')}`)
  if (!up) return finish()

  // S2: 注册 admin + 普通用户(权限面)
  console.log('[S2] 注册 admin + 普通用户')
  let USER_TOKEN
  {
    const r = await api('POST', '/api/users/register', ADMIN, '')
    TOKEN = String(r?.data?.token ?? '')
    ok('admin 注册并拿到 token', Boolean(TOKEN), `HTTP ${r.status} ${r.message ?? ''}`)
    const u = await api('POST', '/api/users', { name: 'tool-e2e-user', email: 'tool-e2e-user@awshop.local', password: 'tool-e2e-user-passw0rd', role: 'user' }, TOKEN)
    ok('admin 创建普通用户', u.status === 200 && u.code === 0, `HTTP ${u.status}`)
    const login = await api('POST', '/api/users/login', { email: 'tool-e2e-user@awshop.local', password: 'tool-e2e-user-passw0rd' }, '')
    USER_TOKEN = String(login?.data?.token ?? '')
    ok('普通用户登录', Boolean(USER_TOKEN), `HTTP ${login.status}`)
    if (USER_TOKEN) {
      const denied = await api('GET', '/api/workshop/tools', undefined, USER_TOKEN)
      ok('普通用户访问全局工具目录 → 403', denied.status === 403, `HTTP ${denied.status}`)
    }
  }
  if (!TOKEN) return finish()

  // 等插件/注册表同步
  await sleep(2500)

  // S3: 全局目录
  console.log('[S3] 全局工具目录')
  let global
  {
    const r = await api('GET', '/api/workshop/tools')
    global = r?.data
    ok('GET /tools 成功', r.status === 200 && r.code === 0, `HTTP ${r.status}`)
    ok('内置工具计数与内置目录一致', global?.stats?.builtin === global?.tools?.filter(t => t.source === 'builtin').length, `builtin=${global?.stats?.builtin}`)
    ok('插件工具已入库', (global?.stats?.plugin ?? 0) >= 1, `plugin=${global?.stats?.plugin}`)
    const fixture = global?.tools?.find(t => t.name === 'fixture_echo')
    ok('fixture_echo 来源=plugin', fixture?.source === 'plugin' && fixture?.plugin === 'aw-fixture-tools', JSON.stringify(fixture?.source))
    ok('fixture_echo 可用', fixture?.available === true)
  }

  // S4: 创建 workspace/channel,取 lead token
  console.log('[S4] 创建 workspace/channel')
  let wsId
  let channelId
  let channelName
  let agent
  {
    const ws = await api('POST', '/api/workshop/workspaces', { name: `tool-e2e-ws-${Date.now()}` })
    wsId = String(ws?.data?.id ?? '')
    ok('workspace 创建', Boolean(wsId), `HTTP ${ws.status}`)
    channelName = `tool-e2e-ch-${Date.now()}`
    const ch = await api('POST', '/api/workshop/channels', {
      name: channelName,
      leadAgent: { name: 'tool-e2e-lead', harness: 'mock' },
    })
    channelId = String(ch?.data?.channelId ?? '')
    ok('channel 创建', Boolean(channelId), `HTTP ${ch.status} ${ch.message ?? ''}`)
    if (wsId && channelId) {
      const mount = await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`)
      ok('channel 挂载到 workspace', mount.status === 200 && mount.code === 0, `HTTP ${mount.status}`)
    }
    const detail = await api('GET', `/api/workshop/channels/${channelId}`)
    agent = detail?.data?.agents?.[0]
    ok('lead agent 可取 token', Boolean(agent?.id && agent?.token), `${agent?.id ?? ''}`)
    if (USER_TOKEN) {
      const denied = await api('PUT', `/api/workshop/channels/${channelId}/tools`, { mode: 'all', tools: [] }, USER_TOKEN)
      ok('非属主修改 Channel 工具 → 403', denied.status === 403, `HTTP ${denied.status}`)
    }
  }
  if (!channelId || !agent?.token) return finish()

  // S5: Channel 工具视图
  console.log('[S5] Channel 工具视图')
  {
    const r = await api('GET', `/api/workshop/channels/${channelId}/tools`)
    const v = r?.data
    ok('GET channel tools 成功', r.status === 200 && r.code === 0, `HTTP ${r.status}`)
    ok('默认模式 all/source default', v?.mode === 'all' && v?.source === 'default', `${v?.mode}/${v?.source}`)
    const fixture = v?.tools?.find(t => t.name === 'fixture_echo')
    ok('fixture 在 Channel 目录', Boolean(fixture) && fixture.effective.lead === true && fixture.effective.worker === true)
    ok('视图含内置工具', v?.tools?.some(t => t.name === 'daq_query' && t.source === 'builtin'))
    ok('统计 lead 生效数 > 0', (v?.stats?.effectiveLead ?? 0) > 0, String(v?.stats?.effectiveLead))
  }

  // S6: agent-tools list + MCP bridge
  console.log('[S6] agent-tools list + MCP bridge')
  let mcp
  {
    const r = await fetch(`${BASE}/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agent.id)}`, {
      headers: { 'x-aw-agent-token': agent.token },
      signal: AbortSignal.timeout(20_000),
    })
    const j = await r.json()
    const tools = j?.data?.tools ?? []
    ok('agent-tools list 含内置', tools.some(t => t.name === 'daq_query'))
    ok('agent-tools list 含 fixture', tools.some(t => t.name === 'fixture_echo'))

    mcp = spawnMcp(agent)
    const init = await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tool-e2e', version: '1' } })
    ok('MCP initialize', init?.result?.capabilities?.tools?.listChanged === true, JSON.stringify(init?.result?.capabilities))
    mcp.p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await mcp.rpc('tools/list', {})
    const names = (list?.result?.tools ?? []).map(t => t.name)
    ok('MCP tools/list 含内置', names.includes('daq_query'), `count=${names.length}`)
    ok('MCP tools/list 含 fixture', names.includes('fixture_echo'))
    const echo = await mcp.call('fixture_echo', { text: 'hello' })
    ok('MCP 调用 fixture 成功', echo?.result?.content?.[0]?.text === 'fixture:hello', JSON.stringify(echo?.result?.content?.[0]?.text))
  }

  // S7: all 模式停用
  console.log('[S7] all 模式停用 fixture/daq_query')
  {
    const r = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
      mode: 'all',
      tools: [
        { name: 'fixture_echo', enabled: false },
        { name: 'daq_query', enabled: false },
      ],
    })
    ok('PUT all 停用成功', r.status === 200 && r.code === 0, `HTTP ${r.status} ${r.message ?? ''}`)
    const fixture = r?.data?.tools?.find(t => t.name === 'fixture_echo')
    ok('视图 fixture 已停用', fixture?.channelEnabled === false && fixture?.effective.lead === false)

    const listRes = await fetch(`${BASE}/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agent.id)}`, {
      headers: { 'x-aw-agent-token': agent.token },
      signal: AbortSignal.timeout(20_000),
    })
    const tools = (await listRes.json())?.data?.tools ?? []
    ok('agent-tools list 已剔除 fixture', !tools.some(t => t.name === 'fixture_echo'))
    ok('agent-tools list 已剔除 daq_query', !tools.some(t => t.name === 'daq_query'))

    const inv = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
      body: JSON.stringify({ agentId: agent.id, tool: 'fixture_echo', args: { text: 'blocked' } }),
      signal: AbortSignal.timeout(20_000),
    })
    const invJson = await inv.json()
    ok('直调停用工具被拒', invJson?.data?.result?.isError === true, JSON.stringify(invJson?.data?.result?.text ?? '').slice(0, 120))
    ok('拒绝文案含本 Channel 停用', /本 Channel 已在「设置 → 工具」中停用/.test(String(invJson?.data?.result?.text ?? '')))

    const mcpCall = await mcp.call('fixture_echo', { text: 'blocked' })
    ok('MCP 直调停用工具被拒', mcpCall?.result?.isError === true, JSON.stringify(mcpCall?.result?.content?.[0]?.text ?? '').slice(0, 120))
  }

  // S8: MCP list_changed(10s 轮询)
  if (!mcp) return finish()
  console.log('[S8] MCP list_changed 通知')
  {
    let notified = false
    for (let i = 0; i < 16; i++) {
      await sleep(1000)
      if (mcp.notifications.some(n => n.method === 'notifications/tools/list_changed')) {
        notified = true
        break
      }
    }
    ok('收到 tools/list_changed', notified, `notifications=${mcp.notifications.map(n => n.method).join(',')}`)
    const list = await mcp.rpc('tools/list', {})
    const names = (list?.result?.tools ?? []).map(t => t.name)
    ok('MCP tools/list 已剔除 fixture', !names.includes('fixture_echo'))
  }

  // S9: selected allow-list
  console.log('[S9] selected allow-list')
  {
    const r = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
      mode: 'selected',
      tools: [
        { name: 'report_progress', enabled: true },
        { name: 'complete_task', enabled: true },
        { name: 'fixture_echo', enabled: true },
      ],
    })
    ok('PUT selected 成功', r.status === 200 && r.code === 0, `HTTP ${r.status} ${r.message ?? ''}`)
    const v = r?.data
    ok('selected 模式生效', v?.mode === 'selected' && v?.source === 'explicit')
    ok('fixture 被勾选生效', v?.tools?.find(t => t.name === 'fixture_echo')?.effective.lead === true)
    ok('daq_query 未勾选停用', v?.tools?.find(t => t.name === 'daq_query')?.channelEnabled === false)

    const listRes = await fetch(`${BASE}/api/workshop/agent-tools/list?agentId=${encodeURIComponent(agent.id)}`, {
      headers: { 'x-aw-agent-token': agent.token },
      signal: AbortSignal.timeout(20_000),
    })
    const names = ((await listRes.json())?.data?.tools ?? []).map(t => t.name)
    ok('selected 列表只含勾选工具', names.includes('fixture_echo') && names.includes('report_progress') && !names.includes('daq_query'), `count=${names.length}`)
  }

  // S10: 硬规则 / 未知工具
  console.log('[S10] 硬规则与输入校验')
  {
    const hard = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
      mode: 'selected',
      tools: [{ name: 'twin_trial_run', enabled: true }],
    })
    ok('硬规则排除工具 → 409', hard.status === 409 && hard.code === 'TOOL_NOT_ELIGIBLE', `HTTP ${hard.status} ${hard.code} ${hard.message ?? ''}`)
    const unknown = await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
      mode: 'all',
      tools: [{ name: 'no_such_tool', enabled: false }],
    })
    ok('未知工具 → 400', unknown.status === 400 && unknown.code === 'UNKNOWN_TOOL', `HTTP ${unknown.status} ${unknown.code}`)
  }

  // S11: 持久化 + 重启
  console.log('[S11] 持久化 + 重启')
  {
    await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
      mode: 'all',
      tools: [{ name: 'daq_query', enabled: false }],
    })
    const rows = dbQuery('SELECT mode FROM channel_tool_policies WHERE channel_id = ?', channelId)
    ok('策略已落库', rows.length === 1 && rows[0].mode === 'all', JSON.stringify(rows))
    const disabled = dbQuery('SELECT tool_name FROM channel_tool_settings WHERE channel_id = ?', channelId)
    ok('停用行已落库', disabled.some(r => r.tool_name === 'daq_query'), JSON.stringify(disabled))

    killInstance()
    await sleep(1500)
    startInstance()
    ok('重启后健康', await waitHealth(), `日志 ${join(HOME, 'instance.log')}`)
    const login = await api('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password }, '')
    TOKEN = String(login?.data?.token ?? '')
    const v = await api('GET', `/api/workshop/channels/${channelId}/tools`)
    ok('重启后策略仍生效', v?.data?.tools?.find(t => t.name === 'daq_query')?.channelEnabled === false, `HTTP ${v.status}`)
  }

  // S12: UI /tools + Channel 设置
  console.log('[S12] UI 渲染')
  {
    const puppeteer = (await import('puppeteer-core')).default
    const browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      protocolTimeout: 300_000,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900'],
      defaultViewport: { width: 1440, height: 900 },
    })
    try {
      const me = (await api('GET', '/api/users/me'))?.data ?? {}
      const page = await browser.newPage()
      await page.evaluateOnNewDocument((inject) => {
        localStorage.setItem('workshop.user', JSON.stringify({ user: { ...inject.me, token: inject.token } }))
        document.cookie = `token=${inject.token}; path=/; max-age=31536000`
      }, { me, token: TOKEN })
      await page.goto(`${BASE}/tools`, { waitUntil: 'networkidle2', timeout: 60_000 })
      await page.waitForSelector('.tools-page', { timeout: 60_000 })
      // 105 条工具分页:先搜索 fixture,避免等一个不在当前页的行
      await page.waitForSelector('.tp-filters input', { timeout: 30_000 })
      await page.type('.tp-filters input', 'fixture_echo')
      await page.waitForFunction(() => document.body.innerText.includes('fixture_echo'), { timeout: 30_000 })
      ok('/tools 页面渲染 fixture', true)
      ok('/tools 页面显示内置统计', /内置\s*\d+|builtin/i.test(await page.evaluate(() => document.body.innerText)))
      await page.screenshot({ path: join(EVIDENCE, 'tools-page.png') })

      const chPage = await browser.newPage()
      await chPage.evaluateOnNewDocument((inject) => {
        localStorage.setItem('workshop.user', JSON.stringify({ user: { ...inject.me, token: inject.token } }))
        document.cookie = `token=${inject.token}; path=/; max-age=31536000`
      }, { me, token: TOKEN })
      await chPage.goto(`${BASE}/workshop/w/${wsId}`, { waitUntil: 'networkidle2', timeout: 60_000 })
      await chPage.waitForSelector('.channel-item', { timeout: 60_000 })
      await chPage.evaluate((name) => {
        const item = [...document.querySelectorAll('.channel-item')].find(el => el.textContent?.includes(name))
        if (item) item.click()
      }, channelName)
      await chPage.waitForFunction(() => Boolean(document.querySelector('.channel-item.active')), { timeout: 30_000 })
      await chPage.evaluate(() => {
        const item = document.querySelector('.channel-item.active')
        const btn = item?.querySelector('button.op')
        if (btn) btn.click()
      })
      await chPage.waitForSelector('.ant-modal-content .ch-tools', { timeout: 30_000 })
      await chPage.waitForFunction(() => document.querySelector('.ch-tools')?.textContent?.includes('fixture_echo'), { timeout: 30_000 })
      const settingsText = await chPage.evaluate(() => document.querySelector('.ch-tools')?.textContent ?? '')
      ok('Channel 设置渲染工具区', settingsText.includes('全部可用工具'))
      ok('Channel 设置含 fixture 工具', settingsText.includes('fixture_echo'))
      await chPage.evaluate(() => {
        const modalBody = document.querySelector('.ant-modal-body')
        if (modalBody) modalBody.scrollTop = modalBody.scrollHeight
        document.querySelector('.ch-tools')?.scrollIntoView({ block: 'center' })
      })
      await sleep(500)
      await chPage.screenshot({ path: join(EVIDENCE, 'channel-tool-settings.png') })

      // UI 实际勾选/保存一次：fixture 取消勾选 → 保存 → API 复核
      await chPage.evaluate(() => {
        const row = [...document.querySelectorAll('.ch-tool-row')].find(el => el.textContent?.includes('fixture_echo'))
        const cb = row?.querySelector('input[type="checkbox"]')
        if (cb instanceof HTMLInputElement && !cb.disabled) cb.click()
      })
      await sleep(400)
      await chPage.evaluate(() => {
        const save = [...document.querySelectorAll('.ch-tools-footer button')].find(el => el.textContent?.includes('保存工具选择'))
        if (save instanceof HTMLButtonElement) save.click()
      })
      await sleep(2000)
      const afterUi = await api('GET', `/api/workshop/channels/${channelId}/tools`)
      ok('UI 保存后 fixture 已停用', afterUi?.data?.tools?.find(t => t.name === 'fixture_echo')?.channelEnabled === false, `HTTP ${afterUi.status}`)
      await chPage.screenshot({ path: join(EVIDENCE, 'channel-tool-settings-saved.png') })
    }
    finally {
      await browser.close()
    }
  }

  // S13: 删除 Channel 清理
  console.log('[S13] 删除 Channel 清理')
  {
    await api('PUT', `/api/workshop/channels/${channelId}/tools`, {
      mode: 'all',
      tools: [{ name: 'daq_query', enabled: false }],
    })
    const del = await api('DELETE', `/api/workshop/channels/${channelId}`)
    ok('删除 Channel 成功', del.status === 200 && del.code === 0, `HTTP ${del.status}`)
    const policyRows = dbQuery('SELECT channel_id FROM channel_tool_policies WHERE channel_id = ?', channelId)
    const settingRows = dbQuery('SELECT channel_id FROM channel_tool_settings WHERE channel_id = ?', channelId)
    ok('策略行已清理', policyRows.length === 0)
    ok('选择行已清理', settingRows.length === 0)
  }

  mcp?.close()
  return finish()
}

function finish() {
  killInstance()
  const result = {
    at: new Date().toISOString(),
    base: BASE,
    home: HOME,
    pass,
    fail: fails.length,
    fails,
    checks,
  }
  mkdirSync(EVIDENCE, { recursive: true })
  const out = join(EVIDENCE, 'tool-registry-e2e.json')
  try {
    writeFileSync(out, JSON.stringify(result, null, 2))
  }
  catch { /* ignore */ }
  console.log(JSON.stringify(result, null, 2))
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  ok('脚本未抛异常', false, err instanceof Error ? err.message : String(err))
  finish()
})
