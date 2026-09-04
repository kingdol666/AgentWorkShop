/**
 * HITL 真实端到端(三阶段;需要:服务运行 + omp CLI + 可用模型):
 *
 *   Phase W  API/WS 层:任务 → lead 空闲 → 注入 ask → AEP hitl.request
 *            → REST pending → POST respond → hitl.resolved → ask 收到答案
 *   Phase U  真实浏览器(Chrome):AppHeader 铃标渲染 → 下拉条目 → 跳转 /monitor
 *            → 应答后徽标消隐(截图 4 张)
 *   Phase T  TUI(无头):状态条 HITL 计数 → /hitl 列表 → 作答卡 → 提交 → 落定
 *
 * 时序对齐 scripts/test-terminal-e2e.mjs 的已验证路径:首个任务仅用于 spawn,
 * ask 指令经终端 WS follow_up 注入(lead 空闲后);目标对话框按 options 匹配
 * (调度循环的空闲询问也是合法 HITL 待办,不作为断言对象)。
 *
 * 运行:node scripts/e2e-hitl-live.mjs [--base http://127.0.0.1:3000]
 * 产物:gui-test-screenshots/hitl-e2e-*.png
 */
import puppeteer from 'puppeteer-core'

const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
})()
const WS_BASE = BASE.replace(/^http/, 'ws')
const SHOT_DIR = 'gui-test-screenshots'
const TAG = Date.now().toString(36)
const ASK_1 = 'Use the ask tool NOW to ask me: Proceed? with options yes and no. After I answer, call complete_task with the deliverable set to my answer.'
const ASK_2 = 'Use the ask tool NOW to ask me: Proceed2? with options confirm and cancel. After I answer, call complete_task with the deliverable set to my answer.'

let failures = 0
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs = 300_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 200)})`)
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

/** AEP WS:sub 一条频道,聚合信封 */
function openAep(channelId, token) {
  const envelopes = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?token=${encodeURIComponent(token)}`)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'sub', channelId, token })))
  ws.addEventListener('message', (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.type && e.type !== 'pong') envelopes.push(e)
    }
    catch { /* ignore */ }
  })
  return { ws, envelopes }
}

/** 终端 WS:聚合 term 消息与帧;send 上行(input=空闲注入) */
function openTerm(agentId, channelId, token) {
  const messages = []
  const ws = new WebSocket(`${WS_BASE}/api/system/monitor/terminal/ws?agentId=${agentId}&channelId=${channelId}&token=${encodeURIComponent(token)}`)
  ws.addEventListener('message', (ev) => {
    try {
      messages.push(JSON.parse(ev.data))
    }
    catch { /* ignore */ }
  })
  return {
    ws,
    messages,
    send: obj => ws.send(JSON.stringify(obj)),
    frames: () => messages.filter(m => m.type === 'term.frames').flatMap(m => m.frames),
  }
}

/** 等待终端 WS 接入(spawn 前 NO_SESSION,4s 后重试;成功同时暂停 park TTL) */
async function openTermWithRetry(agentId, channelId, token, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const t = openTerm(agentId, channelId, token)
    const ok = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 6000)
      const probe = setInterval(() => {
        const gotInit = t.messages.some(m => m.type === 'term.init')
        const gotErr = t.messages.some(m => m.type === 'term.error')
        if (!gotInit && !gotErr) return
        clearInterval(probe)
        clearTimeout(to)
        resolve(gotInit)
      }, 300)
    })
    if (ok) return t
    await sleep(4000)
  }
  return null
}

/** 待办列表中匹配目标对话框(options 同时含两个词) */
const isTargetDialog = (item, a, b) => {
  const opts = JSON.stringify(item.options ?? []).toLowerCase()
  return opts.includes(a) && opts.includes(b)
}

async function main() {
  console.log(`\n━━━ HITL 真实端到端 @ ${BASE} ━━━`)

  const reg = await api('POST', '/api/users/register', {
    body: { email: `hitl-e2e-${TAG}@test.local`, password: 'Passw0rd!123', name: `hitl-e2e-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 200)}`)
  const me = await api('GET', '/api/users/me', { token })
  const channelName = `hitl-e2e-${TAG}`
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: channelName, description: 'hitl live e2e', leadAgent: { name: 'hitl-e2e-lead', harness: 'omp' } },
    token,
  })
  const channelId = ch.data?.channelId
  const leadAgentId = ch.data?.leadAgentId
  check('W1 omp lead channel 创建', Boolean(channelId && leadAgentId), `channel=${channelId?.slice(0, 8)}`)

  const aep = openAep(channelId, token)
  await sleep(500)

  // W2:提交首个任务(仅用于 spawn;调度循环的空闲询问属正常 HITL 待办)
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: `hitl-e2e-wait-${TAG}`, description: 'Wait for further instructions from the human operator via the terminal.' },
    token,
  })
  check('W2 提交驻留任务(触发 omp spawn)', task.code === 0, `task=${task.data?.id?.slice(0, 8)}`)

  console.log('  … 等待 omp spawn(冷启动可达 2-3 分钟)…')
  const term = await openTermWithRetry(leadAgentId, channelId, token)
  check('W2b 终端 WS 接入(agentId 寻址)', Boolean(term))

  // 等 lead 空闲(调度循环的空闲询问 = 首个 hitl.request;不作为断言对象)
  await waitUntil('lead 首回合结束(空闲询问到达)', () =>
    aep.envelopes.some(e => e.type === 'hitl.request') || term.frames().some(f => f.frame.type === 'agent_end'), 300_000)
  await sleep(2000)

  // 注入 ask 指令(follow_up;omp 会撤销空闲询问并弹出新对话框)
  term.send({ type: 'input', text: ASK_1 })
  console.log('  … 等待 agent 弹出 ask 对话框(目标:options 含 yes/no)…')
  const hitlReq = await waitUntil('AEP hitl.request 帧(yes/no)', () =>
    aep.envelopes.find(e => e.type === 'hitl.request' && isTargetDialog(e.payload, 'yes', 'no')) ?? null, 300_000)
  const item = hitlReq.payload
  check('W3 hitl.request 帧到达(AEP)', true, `id=${item.id.slice(0, 8)}`)
  check('W3 payload 语义(kind/channel/agent)', item.kind === 'omp-dialog' && item.channelId === channelId && item.agentId === leadAgentId && Boolean(item.agentName), `kind=${item.kind} agent=${item.agentName}`)
  check('W3 对话框形态(select + yes/no)', item.method === 'select' && (item.options ?? []).some(o => String(o).toLowerCase().startsWith('yes')) && (item.options ?? []).some(o => String(o).toLowerCase().startsWith('no')), `method=${item.method} options=${JSON.stringify(item.options)}`)

  const pending = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
  check('W4 GET /hitl/pending 含目标待办', (pending.data?.items ?? []).some(i => i.id === item.id), `count=${pending.data?.items?.length}`)

  // ── Phase U:真实浏览器渲染 ──
  console.log('  ── Phase U:浏览器渲染 ──')
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  await page.evaluateOnNewDocument((inject) => {
    localStorage.setItem('workshop.user', JSON.stringify({ user: { ...inject.me, token: inject.token } }))
    document.cookie = `token=${inject.token}; path=/; max-age=31536000`
  }, { me: me.data ?? {}, token })
  await page.goto(`${BASE}/monitor`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await sleep(2500)
  const shot = async name => page.screenshot({ path: `${SHOT_DIR}/hitl-e2e-${name}.png` }).catch(() => {})

  // 铃标出现(lead 自主组队会带来额外待办;只断言存在与计数≥1)
  await page.waitForSelector('.hitl-bell', { timeout: 60_000 })
  const badgeBefore = Number.parseInt(await page.$eval('.hitl-count', el => el.textContent.trim()).catch(() => '0'), 10) || 0
  check('U1 AppHeader 铃标出现且计数≥1', badgeBefore >= 1, `badge=${badgeBefore}`)
  await shot('1-badge')

  await page.click('.hitl-bell')
  await page.waitForSelector('.hitl-menu .hitl-item', { timeout: 10_000 })
  // 按目标标题定位条目(列表可能同时含 lead 空闲询问/worker 对话框)
  const hitlItems = await page.$$('.hitl-item')
  let targetItem = null
  let targetText = ''
  for (const el of hitlItems) {
    const txt = await el.evaluate(node => node.textContent)
    if (txt.includes('Proceed?')) {
      targetItem = el
      targetText = txt
      break
    }
  }
  check('U2 下拉渲染目标条目(Proceed? · lead)', Boolean(targetItem) && targetText.includes('hitl-e2e-lead'), `text=${targetText.slice(0, 60)}`)
  await shot('2-dropdown')

  if (targetItem) {
    await targetItem.click()
    await sleep(2500)
  }
  const url = page.url()
  check('U3 点击条目跳转 /monitor 定位', url.includes('/monitor') && url.includes(`agentId=${leadAgentId}`) && url.includes(`channelId=${channelId}`), `url=${url.slice(0, 110)}`)
  await shot('3-jump-monitor')

  // ── Phase W(续):统一应答 → 落定 → agent 收到答案 ──
  const respond = await api('POST', '/api/workshop/hitl/respond', {
    body: { kind: 'omp-dialog', id: item.id, value: 'yes' },
    token,
  })
  check('W5 POST /hitl/respond 成功', respond.code === 0, respond.message ?? '')

  const resolved = await waitUntil('AEP hitl.resolved 帧', () =>
    aep.envelopes.find(e => e.type === 'hitl.resolved' && e.payload?.id === item.id) ?? null, 60_000)
  check('W6 hitl.resolved 帧(answered)', resolved.payload?.outcome === 'answered', `outcome=${resolved.payload?.outcome}`)

  const pendingAfter = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
  check('W7 应答后目标待办清空', !(pendingAfter.data?.items ?? []).some(i => i.id === item.id), `count=${pendingAfter.data?.items?.length}`)

  // 前端徽标随 resolved 下降/消隐(其他来源的待办可能仍在)
  await page.waitForFunction((before) => {
    const el = document.querySelector('.hitl-count')
    return !el || (Number.parseInt(el.textContent.trim(), 10) || 0) < before
  }, { timeout: 30_000 }, badgeBefore).catch(() => {})
  const badgeNowEl = await page.$('.hitl-count')
  const badgeNow = badgeNowEl ? Number.parseInt(await badgeNowEl.evaluate(el => el.textContent.trim()), 10) || 0 : 0
  check('U4 前端徽标计数下降/消隐', !badgeNowEl || badgeNow < badgeBefore, `before=${badgeBefore} after=${badgeNow}`)
  await shot('4-badge-cleared')

  // 关键闭环证据:agent 的 ask 工具收到 'yes'
  console.log('  … 等待 agent 消化答案(ask 工具返回)…')
  const askFed = await waitUntil('ask 工具收到 yes(终端帧)', () => {
    const list = term.frames().filter(f => f.frame.type === 'tool_execution_end' && String(f.frame.toolName) === 'ask')
    const lastAsk = list.at(-1)
    return lastAsk ? String(lastAsk.frame.result ?? '').toLowerCase().includes('yes') : null
  }, 120_000).catch(() => null)
  check('W8 闭环:答案经 ui_response 回传 agent(ask 结果含 yes)', Boolean(askFed))

  // ═══════════════ Phase T:TUI 端到端(第二个 ask) ═══════════════
  console.log('  ── Phase T:TUI(无头)──')
  const { main: tuiMain } = await import('../tui/aw-tui.mjs')
  await tuiMain(['--headless', '--url', BASE, '--token', token, '--channel', channelName])
  const vt = globalThis.__tuiSmokeTerminal
  const type = async (text) => {
    for (const c of text) vt.emitInput(c)
    await sleep(50)
    vt.emitInput('\r')
    await sleep(400)
  }
  const waitTui = async (needle, timeoutMs = 300_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (vt.text().includes(needle)) return true
      await sleep(500)
    }
    return false
  }
  check('T1 TUI 启动并接入频道', Boolean(vt) && await waitTui(`已切换到频道「${channelName}」`, 30_000))

  // 等 ask 回合真正结束(在其 ask 工具帧之后出现 agent_end,且 term.state 已 idle)
  // —— 不能用旧 term.state 判断,否则会在回合仍在运行时过早注入(被当 steer 吞掉)
  const framesAtAsk = term.frames().length
  await waitUntil('ask 回合结束(其后 agent_end + idle)', () => {
    const fr = term.frames()
    const endedAfterAsk = fr.slice(framesAtAsk).some(f => f.frame.type === 'agent_end')
    const st = term.messages.filter(m => m.type === 'term.state').at(-1)
    return endedAfterAsk && st && st.running === false ? true : null
  }, 240_000).catch(() => {})
  await sleep(2500)
  term.send({ type: 'input', text: ASK_2 })

  check('T2 TUI 状态条出现 HITL 待办', await waitTui('HITL 待处理'))
  await type('/hitl')
  check('T3 /hitl 列表渲染', await waitTui('待人工处理'))
  // 按标题定位序号(列表里可能同时存在调度空闲询问)
  const row = await waitUntil('T4 列表出现 Proceed2 行', () => {
    const m = vt.text().match(/(\d+)\. \[omp-dialog\] Proceed2\?/)
    return m ? m[1] : null
  }, 60_000).catch(() => null)
  check('T4 目标待办行渲染(Proceed2?)', Boolean(row), `序号=${row}`)
  await type(`/hitl ${row}`)
  check('T5 进入作答卡', await waitTui('HITL 作答'))
  await type('1')
  check('T6 作答提交回执', await waitTui('应答已提交'), '(select 选项 1 = confirm)')

  const pend2 = await waitUntil('T7 REST 待办不再含 Proceed2', async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
    const items = p.data?.items ?? []
    return items.every(i => !String(i.title).includes('Proceed2')) ? true : null
  }, 60_000).catch(() => null)
  check('T7 TUI 应答写入服务端', pend2 === true)

  check('T8 TUI 渲染落定行(hitl.resolved 帧)', await waitTui('待办已落定', 60_000))
  const askFed2 = await waitUntil('T9 ask 工具收到 confirm(终端帧)', () => {
    const list = term.frames().filter(f => f.frame.type === 'tool_execution_end' && String(f.frame.toolName) === 'ask')
    const lastAsk = list.at(-1)
    return lastAsk ? String(lastAsk.frame.result ?? '').toLowerCase().includes('confirm') : null
  }, 120_000).catch(() => null)
  check('T9 闭环:答案回传 agent(ask 结果含 confirm)', Boolean(askFed2))

  // ── 清理 + 汇总 ──
  await browser.close().catch(() => {})
  await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, { token }).catch(() => {})
  console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err.message)
  process.exit(1)
})
