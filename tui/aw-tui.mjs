// ============================================================
// AgentWorkShop TUI 入口 —— 终端工作台(与 AgentTeam 交互作业)。
//
//   node tui/aw-tui.mjs [--url http://127.0.0.1:3000] [--token ut-*]
//                       [--channel <名>] [--headless]
//   (或 `aw tui …` / `pnpm tui`)
//
// 装配:认证(配置根 tui-auth.json / 交互登录)→ AEP 事件流(频道 sub)+
// 命令系统(/help)+ 监控面板(终端 WS)+ HITL 统一作答(/hitl)。
// --headless:VirtualTerminal 驱动(无 TTY;scripts/tui-smoke.mjs 用)。
// ============================================================
import { TuiMainScreen, Editor, CombinedAutocompleteProvider, ProcessTerminal } from '@earendil-works/pi-tui'
import { theme } from './theme.mjs'
import { loadAuth, saveAuth, configRoot } from './lib/config.mjs'
import { createApi } from './lib/api.mjs'
import { connectAep, connectTerm } from './lib/ws.mjs'
import { createState, pushLog, withLog } from './lib/state.mjs'
import { reduceEnvelope, reduceTermFrame } from './lib/reducers.mjs'
import { dispatchCommand, slashCommandCompletions } from './commands/index.mjs'
import { ChatLog } from './components/chat-log.mjs'
import { StatusBar } from './components/status-bar.mjs'
import { MonitorPane } from './components/monitor-pane.mjs'
import { HitlCard } from './components/hitl-card.mjs'
import { buildTree } from './components/root.mjs'
import { VirtualTerminal } from './lib/virtual-terminal.mjs'

function parseArgs(argv) {
  const opts = { headless: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--headless') opts.headless = true
    else if (a === '--url') opts.url = argv[++i]
    else if (a === '--token') opts.token = argv[++i]
    else if (a === '--channel') opts.channel = argv[++i]
  }
  return opts
}

/** 认证:已存凭据 → --token → 环境变量 → 交互登录 */
async function ensureAuth(opts) {
  const saved = loadAuth()
  const baseUrl = opts.url ?? process.env.AW_TUI_URL ?? saved?.baseUrl ?? 'http://127.0.0.1:3000'
  if (opts.token) return { baseUrl, token: opts.token }
  if (saved?.token && saved.baseUrl === baseUrl) return { baseUrl, token: saved.token }

  const email = process.env.AW_TUI_EMAIL
  const password = process.env.AW_TUI_PASSWORD
  if (email && password) {
    const api = createApi({ baseUrl })
    const res = await api.login(email, password)
    const auth = { baseUrl, token: res.token, email }
    saveAuth(auth)
    return auth
  }
  if (opts.headless) throw new Error('无凭据:headless 模式请传 --token 或设 AW_TUI_EMAIL/AW_TUI_PASSWORD')

  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(`AgentWorkShop TUI 首次使用(凭据落 ${configRoot()}/tui-auth.json)`)
    const mail = await rl.question('邮箱: ')
    const pass = await rl.question('密码: ')
    const api = createApi({ baseUrl })
    const res = await api.login(mail.trim(), pass)
    const auth = { baseUrl, token: res.token, email: mail.trim() }
    saveAuth(auth)
    console.log('✔ 登录成功,凭据已保存')
    return auth
  }
  finally {
    rl.close()
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  const auth = await ensureAuth(opts)

  const store = createState()
  const state = withLog(store.state)
  state.baseUrl = auth.baseUrl
  state.token = auth.token
  const api = createApi(auth)

  // ── 终端 + 组件树 ──
  const terminal = opts.headless ? new VirtualTerminal() : new ProcessTerminal()
  if (opts.headless) (globalThis).__tuiSmokeTerminal = terminal // 无头 e2e 注入句柄
  const tui = new TuiMainScreen(terminal)
  const chatLog = new ChatLog(state)
  const monitorPane = new MonitorPane(state)
  const hitlCard = new HitlCard(state)
  const statusBar = new StatusBar(state)
  const editor = new Editor(tui, theme.editor)
  const { stack } = buildTree({ state, chatLog, monitorPane, hitlCard, statusBar, editor })

  const push = (kind, text) => {
    pushLog(state, kind, text)
    store.notify()
  }
  const echo = (kind, text) => push(kind === 'warn' ? 'hitl' : kind, text)

  // ── 装配动作(命令系统/提交路由的副作用入口) ──
  let termConn = null
  const actions = {
    async switchChannel(channelId) {
      if (state.activeChannelId && state.activeChannelId !== channelId) aep.unsubscribe(state.activeChannelId)
      state.activeChannelId = channelId
      aep.subscribe(channelId, seqCursor.get(channelId))
      await actions.refreshAgents()
      // 时间线回填:最近 20 条(人类/Agent 消息)
      try {
        const msgs = await api.listMessages(channelId, 20)
        for (const m of msgs) {
          const text = (m.parts ?? []).map(p => p?.text ?? '').join('').trim()
          if (!text) continue
          if (m.role === 'USER' || m.fromAgentId == null) push('user', text)
          else push('agent', text)
        }
      }
      catch { /* 回填失败不阻塞 */ }
      const ch = state.channels.find(c => c.id === channelId)
      push('system', `已切换到频道「${ch?.name ?? channelId.slice(0, 8)}」—— 普通文本发送任务,/help 查看命令。`)
      store.notify()
    },
    async refreshAgents() {
      if (!state.activeChannelId) return
      const list = await api.listAgents(state.activeChannelId)
      state.agents = list.map(a => ({ id: a.id, name: a.name, role: a.role, harness: a.harness, enabled: a.enabled }))
      store.notify()
    },
    openMonitor(agent) {
      termConn?.close()
      termConn = null
      state.monitor = { agentId: agent.id, name: agent.name, connected: false, waiting: false, streaming: false, lines: [], streamText: '' }
      const mon = state.monitor
      const addLine = (text, tone = 'dim') => {
        mon.lines.push({ text, tone })
        if (mon.lines.length > 120) mon.lines.splice(0, mon.lines.length - 120)
      }
      const applyFrame = (frame) => {
        if (frame.type === 'message_update') {
          const ev = frame.assistantMessageEvent
          const delta = typeof ev?.delta === 'string' ? ev.delta : typeof frame.text === 'string' ? frame.text : ''
          if (delta) mon.streamText = (mon.streamText + delta).slice(-2000)
          mon.streaming = true
          return
        }
        if (frame.type === 'message_end' || frame.type === 'turn_end') mon.streaming = false
        const { lines } = reduceTermFrameSafe(frame)
        for (const l of lines) addLine(l.text, l.tone)
      }
      termConn = connectTerm({
        baseUrl: state.baseUrl,
        token: state.token,
        agentId: agent.id,
        channelId: state.activeChannelId,
        onMessage(msg) {
          if (msg.type === 'term.init') {
            mon.connected = true
            mon.waiting = false
            addLine(`── 已接入 ${msg.meta?.name ?? agent.name} pid ${msg.meta?.pid ?? '?'}(重放 ${msg.lastSeq ?? 0} 帧)──`, 'accent')
            if (msg.hitl) {
              upsertHitlLocal(state, { kind: 'omp-dialog', id: msg.hitl.id, channelId: state.activeChannelId, agentId: agent.id, agentName: agent.name, method: msg.hitl.method, title: msg.hitl.title, options: msg.hitl.options, message: msg.hitl.message })
              addLine(`⏸ 待答对话框:${msg.hitl.title}(/hitl 作答)`, 'warn')
            }
            // 重放尾部 40 帧给上下文
            for (const f of (msg.replay ?? []).slice(-40)) applyFrame(f.frame)
          }
          else if (msg.type === 'term.frames') {
            for (const f of msg.frames ?? []) applyFrame(f.frame)
          }
          else if (msg.type === 'term.state') {
            mon.streaming = msg.streaming
          }
          else if (msg.type === 'term.notice') {
            addLine(msg.message, msg.level === 'error' ? 'error' : 'dim')
          }
          store.notify()
        },
        onClose(code) {
          if (mon.agentId !== agent.id) return
          mon.connected = false
          if (code === 4404) {
            mon.waiting = true
            addLine('omp 进程未启动(随首个任务 spawn),等待接入…', 'warn')
          }
          store.notify()
        },
      })
      push('system', `监控已开启:${agent.name}(右侧面板;/monitor off 关闭)`)
    },
    closeMonitor() {
      termConn?.close()
      termConn = null
      state.monitor = { agentId: null, name: null, connected: false, waiting: false, streaming: false, lines: [], streamText: '' }
      store.notify()
    },
    async submitHitlAnswer(text) {
      const item = state.hitlAnswering
      if (!item) return false
      const body = { kind: item.kind, id: item.id }
      if (item.kind === 'omp-dialog') {
        if (item.method === 'confirm') {
          const norm = text.trim().toLowerCase()
          if (!['y', 'n', 'yes', 'no'].includes(norm)) {
            push('error', 'confirm 对话框请输入 y(批准)或 n(拒绝)')
            return true
          }
          body.confirmed = norm.startsWith('y')
        }
        else if (item.method === 'select') {
          const idx = Number.parseInt(text.trim(), 10)
          if (!Number.isInteger(idx) || idx < 1 || idx > (item.options?.length ?? 0)) {
            push('error', `select 请输入 1-${item.options?.length ?? 0} 的序号`)
            return true
          }
          body.value = item.options[idx - 1]
        }
        else {
          body.value = text
        }
      }
      else {
        // dcw-approval:confirm 语义(y=批准/n=拒绝)+ 备注
        const norm = text.trim().toLowerCase()
        body.confirmed = norm.startsWith('y')
        if (norm.length > 1) body.comment = text
      }
      try {
        await api.hitlRespond(body)
        push('system', `✔ 应答已提交(${item.title})`)
        state.hitl = state.hitl.filter(i => !(i.kind === item.kind && i.id === item.id))
        state.hitlAnswering = null
      }
      catch (err) {
        push('error', `应答失败:${err.message}`)
        if (String(err.code) === 'ALREADY_RESOLVED') state.hitlAnswering = null
      }
      store.notify()
      return true
    },
    quit() {
      aep.close()
      termConn?.close()
      tui.stop()
      process.exit(0)
    },
  }
  const ctx = { state, store, api, echo, push, actions }

  // ── 编辑器提交路由:HITL 作答 → 命令 → 普通文本发任务 ──
  editor.onSubmit = async (text) => {
    const trimmed = text.trim()
    editor.setText('')
    editor.addToHistory?.(text)
    if (!trimmed) return
    if (state.hitlAnswering) {
      await actions.submitHitlAnswer(trimmed)
      return
    }
    if (trimmed.startsWith('/')) {
      await dispatchCommand(ctx, trimmed)
      store.notify()
      return
    }
    if (!state.activeChannelId) {
      push('error', '未选择频道:先 /channels + /channel use <名|序号>')
      return
    }
    // messages 端点要求 toAgentId:普通文本缺省路由 lead
    const ch = state.channels.find(c => c.id === state.activeChannelId)
    const leadId = ch?.leadAgentId ?? state.agents.find(a => a.role === 'lead')?.id
    if (!leadId) {
      push('error', '当前频道没有 lead:用 /channel new --lead <名> 重建,或 /send <成员> 指定收件人。')
      return
    }
    try {
      await api.sendMessage(state.activeChannelId, { toAgentId: leadId, text: trimmed, priority: 'task', fromLabel: state.userName || '用户' })
    }
    catch (err) {
      push('error', `发送失败:${err.message}`)
    }
    store.notify()
  }

  // ── AEP 事件流 ──
  const seqCursor = new Map()
  const aep = connectAep({
    baseUrl: state.baseUrl,
    token: state.token,
    onEvent(e) {
      if (e.channelId && typeof e.seq === 'number') {
        aep.cursor(e.channelId, e.seq)
        seqCursor.set(e.channelId, e.seq)
      }
      reduceEnvelope(state, e)
      store.notify()
    },
    onState(s) {
      state.connState = s
      store.notify()
    },
  })

  store.onChange(() => tui.requestRender())

  // ── 组装视图 ──
  tui.addChild({ render: width => [...stack.render(width), '', ...editor.render(width)] })
  editor.setAutocompleteProvider?.(new CombinedAutocompleteProvider(slashCommandCompletions(), process.cwd()))
  tui.setFocus(editor)

  push('system', `AgentWorkShop TUI 已就绪 ${state.baseUrl}`)
  push('system', '普通文本 = 发任务到当前频道;/help 命令列表;/hitl 处理待办。')

  // ── 启动:频道自动选择 → 订阅 ──
  try {
    const channels = await api.listChannels()
    state.channels = channels
    // 空字符串 --channel 视为未指定('' 非 nullish,?? 不会走右侧)
    const target = (opts.channel ? channels.find(c => c.name === opts.channel || c.id === opts.channel) : undefined)
      ?? channels[0]
    if (target) await actions.switchChannel(target.id)
    else push('warn', '尚无频道:/channel new <名称> 创建一个。')
    const me = await api.get('/api/workshop/users/me').catch(() => null)
    state.userName = me?.user?.name ?? me?.name ?? '用户'
  }
  catch (err) {
    push('error', `初始化失败:${err.message}`)
  }

  tui.start()
  return tui
}

function upsertHitlLocal(state, item) {
  const i = state.hitl.findIndex(x => x.kind === item.kind && x.id === item.id)
  if (i >= 0) state.hitl[i] = item
  else state.hitl.push(item)
}

/** reduceTermFrame 的防御包装(未知帧形状不炸渲染) */
function reduceTermFrameSafe(frame) {
  try {
    return reduceTermFrame(frame)
  }
  catch {
    return { lines: [] }
  }
}

// 直接运行入口(aw tui / pnpm tui 均落到这里)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  main().catch((err) => {
    console.error('[tui] 启动失败:', err.message)
    process.exit(1)
  })
}
