/**
 * 全局 `aw tui` 完整 E2E(用户真实路径:npm i -g agentworkshop → aw tui):
 *   node scripts/e2e-aw-tui-global.mjs [--base http://127.0.0.1:3000]
 *
 * 前置:全局已安装 agentworkshop@0.7.4(npm root -g 可解析);dev/prod 服务运行。
 * 场景:加载【全局包】的 tui 入口(非仓库源码)→ 建频道(内联 omp lead)→
 *       成员列表 → 任务下发(触发 omp spawn)→ /monitor 独立监控接入 →
 *       /send 注入 ask → /hitl 定位作答 → REST 确认落定 → 终端帧证实答案
 *       回传 agent → /task 正式任务 + /tasks 列表 → /monitor off → 清理。
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
})()
// --repo:加载仓库源码的 tui(开发验证新交互);默认加载全局安装包(用户真实路径)
const USE_REPO = process.argv.includes('--repo')
const WS_BASE = BASE.replace(/^http/, 'ws')
const TAG = Date.now().toString(36)
const ASK_INSTRUCTION = 'Use the ask tool NOW to ask me: Deploy? with options go and abort. After I answer, call complete_task with the deliverable set to my answer.'

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

/** 终端 WS(答案回传验证用) */
function openTerm(agentId, channelId, token) {
  const messages = []
  const ws = new WebSocket(`${WS_BASE}/api/system/monitor/terminal/ws?agentId=${agentId}&channelId=${channelId}&token=${encodeURIComponent(token)}`)
  ws.addEventListener('message', (ev) => {
    try {
      messages.push(JSON.parse(ev.data))
    }
    catch { /* ignore */ }
  })
  return { ws, messages, frames: () => messages.filter(m => m.type === 'term.frames').flatMap(m => m.frames) }
}

/** 解析 TUI 入口:--repo = 仓库源码;默认 = 全局安装包(用户 `aw tui` 的真实加载路径) */
function tuiEntry() {
  if (USE_REPO) {
    const entry = join(process.cwd(), 'tui', 'aw-tui.mjs')
    return { entry, ok: existsSync(entry), repo: true }
  }
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
  const entry = join(root, 'agentworkshop', 'tui', 'aw-tui.mjs')
  return { entry, ok: existsSync(entry), repo: false }
}

async function main() {
  console.log(`\n━━━ 全局 aw tui 完整 E2E @ ${BASE} ━━━`)

  // 0. 入口存在(全局包 = 0.7.4 发布包含 tui/;repo = 源码)
  const g = tuiEntry()
  check(`0.1 TUI 入口存在(${g.repo ? '仓库源码' : '全局包'})`, g.ok, g.entry)
  if (!g.ok) process.exit(1)

  // 登录
  const reg = await api('POST', '/api/users/register', {
    body: { email: `awtui-${TAG}@test.local`, password: 'Passw0rd!123', name: `awtui-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 160)}`)

  // 0.2 预建一个频道(启动频道选择器需要至少一个可选项;全局包模式同样受益)
  const bootCh = (await api('POST', '/api/workshop/channels', {
    body: { name: `awtui-boot-${TAG}`, description: '启动选择器测试频道' },
    token,
  })).data
  check('0.2 预建启动频道', Boolean(bootCh?.channelId), `id=${bootCh?.channelId?.slice(0, 8)}`)

  // 1. 加载 TUI,headless 驱动
  const mod = await import(pathToFileURL(g.entry).href)
  await mod.main(['--headless', '--url', BASE, '--token', token, '--channel', ''])
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
  check('1.1 TUI 启动就绪', await waitTui('TUI 已就绪', 30_000), g.entry.slice(-60))

  // 1.2 [新交互] 启动频道选择器:↑↓ + Enter 选择预建频道;Esc 自动进第一个
  if (USE_REPO) {
    check('1.2 启动弹出频道选择器', await waitTui('选择要进入的频道', 20_000))
    vt.emitInput('\x1b[B') // 下移一次,选中第二个(证明方向键导航)
    await sleep(200)
    vt.emitInput('\r')
    check('1.3 Enter 进入所选频道', await waitTui('已切换到频道「', 30_000))
  }
  else {
    check('1.2 (全局包)自动接入频道', await waitTui('已切换到频道「', 30_000))
  }

  // 2. Channel 操作:列表 + 创建(内联 omp lead)+ 自动切换
  await type('/channels')
  check('2.1 /channels 列出频道', await waitTui('个:', 15_000))
  const channelName = `awtui-e2e-${TAG}`
  await type(`/channel new ${channelName} --lead 领航员 全局tui端到端频道`)
  check('2.2 /channel new 创建成功', await waitTui('✔ 频道已创建', 30_000))
  check('2.3 自动切换到新频道', await waitTui(`已切换到频道「${channelName}」`, 30_000))

  // 2.4 [新交互] /channel use 无参 → 频道选择器 → 方向键导航到目标频道 → Enter
  // (SelectList 的可打印字符过滤不生效,导航用方向键;序号按 REST 顺序计算)
  if (USE_REPO) {
    await type('/channel use')
    check('2.4 /channel use 弹出频道选择器', await waitTui('选择要进入的频道', 20_000))
    const order = (await api('GET', '/api/workshop/channels', { token })).data ?? []
    const downTimes = Math.max(0, order.findIndex(c => c.name === channelName))
    for (let i = 0; i < downTimes; i++) {
      vt.emitInput('\x1b[B')
      await sleep(150)
    }
    await sleep(200)
    vt.emitInput('\r')
    await sleep(800)
    check('2.5 方向键选择后频道正确', await waitTui(`已切换到频道「${channelName}」`, 20_000))
  }

  // 3. Agent 操作:成员列表出现内联建的 omp lead(选择器切换后刷新有竞态,轮询重发)
  {
    const ok = await waitUntil('3.1 /agents 出现 lead 成员', async () => {
      await type('/agents')
      return vt.text().includes('领航员(lead)') ? true : null
    }, 30_000).catch(() => null)
    check('3.1 /agents 出现 lead 成员', ok === true)
  }

  // 4. 任务下发:普通文本 → lead(触发 omp spawn)
  await type('请保持待命,等待操作员通过终端下达进一步指令。')
  console.log('  … 等待 omp spawn(冷启动可达 2-3 分钟)…')
  const ch = (await api('GET', '/api/workshop/channels', { token })).data?.find?.(c => c.name === channelName)
    ?? (await api('GET', '/api/workshop/channels', { token })).data?.at(-1)
  const channelId = ch?.id
  const members = channelId ? (await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })).data ?? [] : []
  const lead = members.find(a => a.role === 'lead')
  check('4.1 频道/lead 实例可查(REST 交叉核对)', Boolean(lead?.id), `lead=${lead?.id?.slice(0, 8)}`)

  const spawnOk = await waitUntil('4.2 omp 进程 spawn', async () => {
    const mon = await api('GET', '/api/system/monitor', { token })
    return (mon.data?.processes ?? []).find(p => p.harness === 'omp' && p.alive && p.agentId === lead?.id) ? true : null
  }, 300_000).catch(() => null)
  check('4.2 omp 进程 spawn(REST 监控)', spawnOk === true)

  // 5. 独立 monitor:/monitor 领航员 → 终端面板接入
  await type('/monitor 领航员')
  check('5.1 /monitor 面板开启', await waitTui('监控已开启:领航员', 20_000))
  const termConnected = await waitTui('已接入 领航员', 120_000)
  check('5.2 监控面板接入 omp 会话(term.init)', termConnected)

  // 6. HITL:等首回合结束 → /send 注入 ask → /hitl 定位作答
  const idleOk = await waitUntil('6.1 lead 首回合结束(idle)', async () => {
    const terms = await api('GET', `/api/workshop/channels/${channelId}/terminals`, { token })
    const mine = (terms.data ?? []).find(t2 => t2.agentId === lead?.id)
    return mine && mine.running === false ? true : null
  }, 300_000).catch(() => null)
  check('6.1 lead 空闲(可注入)', idleOk === true)
  await sleep(1500)
  await type(`/send 领航员 ${ASK_INSTRUCTION}`)
  check('6.2 /send 直发回执', await waitTui('✔ 已直发 领航员', 30_000))

  const item = await waitUntil('6.3 HITL 待办到达(REST Deploy?)', async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
    return (p.data?.items ?? []).find(i => String(i.title).includes('Deploy?')) ?? null
  }, 300_000).catch(() => null)
  check('6.3 omp ask → 全局待办(Deploy?)', Boolean(item), item ? `method=${item.method} options=${JSON.stringify(item.options)}` : 'timeout')

  await type('/hitl')
  check('6.4 /hitl 列表渲染', await waitTui('待人工处理', 20_000))
  const row = await waitUntil('6.5 列表出现 Deploy? 行', () => {
    const m = vt.text().match(/(\d+)\. \[omp-dialog\] Deploy\?/)
    return m ? m[1] : null
  }, 60_000).catch(() => null)
  check('6.5 目标待办行定位', Boolean(row), `序号=${row}`)
  await type(`/hitl ${row}`)
  check('6.6 进入作答卡', await waitTui('HITL 作答', 20_000))
  await type('1')
  check('6.7 应答提交回执(选项 1 = go)', await waitTui('应答已提交', 30_000))
  if (failures > 0) console.log('[diag 6.7 tail]', JSON.stringify(vt.text().slice(-700)))

  const cleared = await waitUntil('6.8 REST 待办不再含 Deploy?', async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
    return ((p.data?.items ?? []).every(i => !String(i.title).includes('Deploy?'))) ? true : null
  }, 60_000).catch(() => null)
  check('6.8 应答写入服务端(待办落定)', cleared === true)

  // 6.9 答案回传 agent 铁证:ask 工具结果含 go(独立终端 WS 帧)
  const term = openTerm(lead.id, channelId, token)
  const askFed = await waitUntil('6.9 ask 工具收到 go(终端帧)', () => {
    const list = term.frames().filter(f => f.frame.type === 'tool_execution_end' && String(f.frame.toolName) === 'ask')
    const lastAsk = list.at(-1)
    return lastAsk ? String(lastAsk.frame.result ?? '').toLowerCase().includes('go') : null
  }, 120_000).catch(() => null)
  check('6.9 闭环:答案回传 agent(ask 结果含 go)', Boolean(askFed))

  // 6.10-6.14 [新交互] Tab 目标选择器 + 通信/任务分流(仓库源码特性)
  if (USE_REPO) {
    vt.emitInput('\t')
    check('6.10 Tab 呼出目标选择器', await waitTui('选择对话目标', 20_000))
    vt.emitInput('\x1b[B')
    await sleep(200)
    vt.emitInput('\r')
    check('6.11 选成员 → 通信模式 + 自动开监控', await waitTui('监控已开启:领航员', 20_000) && await waitTui('@领航员(通信)', 20_000))
    await type('你在吗?看到请回应')
    check('6.12 普通文本按通信直发目标', await waitTui('通信消息已发 → @领航员', 30_000))
    vt.emitInput('\t')
    await waitTui('选择对话目标', 20_000)
    vt.emitInput('\r')
    await sleep(400)
    check('6.13 选频道 → 重置任务模式', await waitTui('频道(任务)', 20_000))
    await type('/msg 心跳检查,请确认收到')
    check('6.14 /msg 通信消息(目标重置后路由 lead)', await waitTui('通信消息已发 → @', 30_000))
  }

  // 7. 正式任务 + 任务列表
  await type('/task 汇报当前待命状态')
  check('7.1 /task 正式任务提交', await waitTui('✔ 任务已发布', 30_000))
  await type('/tasks')
  check('7.2 /tasks 列表出现任务', await waitTui('汇报当前待命状态', 30_000))

  // 8. monitor 关闭 + 清理
  await type('/monitor off')
  check('8.1 /monitor off 关闭', await waitTui('监控面板已关闭', 20_000))
  await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/channels/${bootCh.channelId}?purge=1`, { token }).catch(() => {})

  console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed ━━━`)
  console.log('(经 /quit 退出全局 TUI 进程)')
  if (failures > 0) process.exit(1)
  await type('/quit')
  console.log('[warn] /quit 未按预期退出,兜底退出')
  process.exit(0)
}

main().catch((err) => {
  console.error('FATAL', err.message)
  process.exit(1)
})
