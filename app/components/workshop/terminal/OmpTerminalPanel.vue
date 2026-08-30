<script setup lang="ts">
/**
 * OmpTerminalPanel —— omp harness 原生终端面板(依赖 DOM/xterm,浏览器端动态加载)。
 *
 * 数据面:WS /api/system/monitor/terminal/ws?pid&token(#shared/terminal-protocol)
 *  - 服务端 terminal-hub 镜像 omp `--mode rpc-ui` 子进程的全部 RPC 帧;
 *  - 本组件把结构化帧流渲染成 xterm TUI(user 回显 / assistant 流式 / thinking /
 *    工具执行 / host tool / HITL 对话框),还原"原生终端输出"体验;
 *  - 控制面(真 Human-in-the-loop):行内输入 → input(steer·follow_up 注入 omp
 *    会话);Ctrl+C / 中止按钮 → abort;HITL 面板 → ui_response(select·confirm·
 *    input·editor 对话框应答,直写 extension_ui_response)。
 *  - 断线自动重连(指数退避);重连全量重放按 seq 去重,时间线无缝续接。
 *
 * SSR 安全:xterm(CJS 包)在抽屉打开时动态 import(ensureTerm 内 await),
 * 服务端渲染路径零执行;xterm 样式经 nuxt.config css 全局注入。
 */
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import type {
  TerminalHitlDialog,
  TerminalServerMessage,
  TermFrame,
} from '#shared/terminal-protocol'

const props = defineProps<{
  /** pid 直连寻址(monitor 进程表) */
  pid?: number | null
  /** agent 寻址(lanes):解析该成员当前存活的 omp 进程,重启后自动落到新会话 */
  agentId?: string | null
  channelId?: string | null
  /** 抽屉标题附加信息(monitor 行/lane 头快照) */
  subtitle?: string
}>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const userStore = useUserStore()

// ===== 终端实例 =====
const hostEl = ref<HTMLElement | null>(null)
let term: Terminal | null = null
let fit: FitAddon | null = null
let resizeObs: ResizeObserver | null = null

// ===== 连接与状态 =====
type ConnState = 'idle' | 'connecting' | 'open' | 'retrying' | 'dead'
const connState = ref<ConnState>('idle')
const alive = ref(true)
const running = ref(false)
const streaming = ref(false)
const hitl = ref<TerminalHitlDialog | null>(null)
let ws: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
let closedByUser = false
/** 已渲染 seq(重连全量重放去重) */
let lastRenderedSeq = 0

// ===== 行内输入(原生终端体验:xterm 内直接打字) =====
let inputLine = ''
let inputHistory: string[] = []
let inputHistoryIdx = -1
/** 流式增量渲染中(避免输入行与输出交错重绘抖动的细粒度锁不需要:批后重绘) */

// ANSI 快捷片段
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  dimItalicMagenta: '\x1b[2;3;35m',
}

/** 流式行未收尾标志:光标停在流式行中间 —— 下一个块/回合收尾前先补换行 */
let streamLineOpen = false

/**
 * 冲刷流式增量:直接续写在光标后。
 * 不补换行、不清行、不碰底部输入行 —— 流式批次之间是同一段正文,
 * 旧实现按"块语义"逐批强制换行 + 重绘 prompt,导致实时消费出现逐批断行
 * (历史重放一次冲刷故正常)。
 */
function flushStream(): void {
  if (streamBuf.length === 0) return
  const text = streamBuf.join('')
  streamBuf.length = 0
  term?.write(text)
  if (!/\r?\n$/.test(text)) streamLineOpen = true
}

/** 收尾流式行:仅在光标停在流式行中时补一个换行 */
function closeStreamLine(): void {
  if (!streamLineOpen) return
  streamLineOpen = false
  term?.write('\r\n')
}

/** 写入完整块(独立行):冲刷流式增量并收尾流式行 → 清输入行 → 写块 → 重绘输入行 */
function writeBlock(text: string): void {
  if (!term) return
  flushStream()
  closeStreamLine()
  term.write('\r\x1b[K')
  term.write(text.endsWith('\r\n') || text.endsWith('\n') ? text : `${text}\r\n`)
  renderInputRow()
}

/** 重绘底部输入行(prompt + 已键入内容);流式行未收尾时跳过(回合收尾后统一补绘) */
function renderInputRow(): void {
  if (!term) return
  if (streamLineOpen || streamBuf.length > 0) return
  term.write(`\r\x1b[K${C.dim}❯${C.reset} ${C.cyan}${inputLine}${C.reset}`)
}

/**
 * 清空视图(切换目标 / 重开抽屉):丢弃上一会话的全部渲染状态与 xterm 缓冲。
 * 不清空会把前一个 Agent 的历史输出叠进本 Agent 的终端,重开抽屉还会整环
 * 重放造成重复 —— 每个 Agent 的终端必须只渲染自己的信息。
 */
function resetView(): void {
  streamBuf.length = 0
  streamLineOpen = false
  assistantStreamActive = false
  textSent.clear()
  lastHumanInput = ''
  inputLine = ''
  // 命令历史随视图一并清空:历史属于会话,跨 Agent/重开共享会串上下文
  inputHistory = []
  inputHistoryIdx = -1
  term?.reset()
  renderInputRow()
}

const ts = (): string => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** 单行/短文本裁剪(空白折叠) */
function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// ===== 帧渲染器:结构化 RPC 帧 → ANSI TUI =====

/** 最近一次人类输入(follow_up 路径 omp 回显 user 消息 → 去重) */
let lastHumanInput = ''
/** 当前回合 assistant 流式是否已输出过换行收尾标记 */
let assistantStreamActive = false
/** 流式增量缓冲(text/thinking delta 按批 flush,防与输入行交错) */
const streamBuf: string[] = []
/**
 * 正文差额账本:contentIndex → 已渲染长度。部分 provider 的 text 块不走
 * text_delta(只有换行),全文在 text_end.content 落定 —— 差额补发防止终端缺正文。
 */
const textSent = new Map<number, number>()

function renderFrame(f: TermFrame): void {
  if (f.seq <= lastRenderedSeq) return
  lastRenderedSeq = f.seq
  const frame = f.frame
  const type = frame.type as string

  switch (type) {
    case '__terminal_notice': {
      const level = String(frame.level ?? 'info')
      const color = level === 'error' ? C.red : level === 'warning' ? C.yellow : C.dim
      writeBlock(`${C.dim}[${ts()}]${C.reset} ${color}⚡ ${String(frame.message ?? '')}${C.reset}`)
      return
    }
    case '__human_input': {
      lastHumanInput = String(frame.text ?? '')
      writeBlock(`${C.bold}${C.cyan}❯ ${lastHumanInput}${C.reset}`)
      return
    }
    case 'ready':
      writeBlock(`${C.green}● omp ready${C.reset} ${C.dim}protocol v${String(frame.protocolVersion ?? '?')} · mode rpc-ui${C.reset}`)
      return
    case 'agent_start':
      assistantStreamActive = false
      textSent.clear()
      writeBlock(`${C.dim}── agent turn started ──${C.reset}`)
      return
    case 'agent_end':
      writeBlock(`${C.dim}── agent turn ended(${String(frame.messageCount ?? '?')} messages)──${C.reset}`)
      return
    case 'message_start': {
      const role = String(frame.role ?? '')
      if (role === 'user') {
        const text = String(frame.text ?? '')
        // follow_up 的 user 回显与人类输入同文 → 已渲染,跳过;平台注入的任务 prompt 正常回显
        if (text === lastHumanInput) return
        writeBlock(`${C.bold}${C.cyan}❯ ${text.replace(/\n/g, '\r\n')}${C.reset}`)
      }
      return
    }
    case 'message_update': {
      const ev = frame.assistantMessageEvent as { type?: string, delta?: string, content?: string, contentIndex?: number } | undefined
      if (!ev) return
      // 流式增量先入缓冲,按批(flushStream)统一走 writeBlock:
      // 直接 term.write 会落在底部输入行上,与输入行互相覆盖
      if (ev.type === 'text_delta' && ev.delta) {
        assistantStreamActive = true
        const ci = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0
        textSent.set(ci, (textSent.get(ci) ?? 0) + ev.delta.length)
        streamBuf.push(ev.delta.replace(/\n/g, '\r\n'))
      }
      else if (ev.type === 'text_end' && typeof ev.content === 'string' && ev.content.length > 0) {
        // 落定差额兜底:provider 未流式 text 块时全文在 text_end,补发未渲染部分
        const ci = typeof ev.contentIndex === 'number' ? ev.contentIndex : 0
        const sent = textSent.get(ci) ?? 0
        if (ev.content.length > sent) {
          assistantStreamActive = true
          textSent.set(ci, ev.content.length)
          streamBuf.push(ev.content.slice(sent).replace(/\n/g, '\r\n'))
        }
      }
      else if (ev.type === 'thinking_delta' && ev.delta) {
        assistantStreamActive = true
        streamBuf.push(`${C.dimItalicMagenta}${ev.delta.replace(/\n/g, '\r\n')}${C.reset}`)
      }
      return
    }
    case 'message_end': {
      const role = String(frame.role ?? '')
      if (role === 'assistant' && assistantStreamActive) {
        // 回合收尾:冲刷剩余增量 → 流式行补换行 → 恢复底部输入行
        assistantStreamActive = false
        flushStream()
        closeStreamLine()
        renderInputRow()
      }
      return
    }
    case 'tool_execution_start':
      writeBlock(`  ${C.yellow}⚙ ${String(frame.toolName ?? 'tool')}${C.reset}${C.dim}(${oneLine(String(frame.args ?? ''), 120)})${C.reset}`)
      return
    case 'tool_execution_update':
      writeBlock(`  ${C.dim}↳ … ${oneLine(String(frame.update ?? ''), 100)}${C.reset}`)
      return
    case 'tool_execution_end': {
      const err = frame.isError === true
      const mark = err ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`
      const preview = oneLine(String(frame.result ?? ''), 180)
      writeBlock(`  ${mark} ${C.dim}${preview}${C.reset}`)
      return
    }
    case 'host_tool_call':
      writeBlock(`  ${C.magenta}⇄ host:${String(frame.toolName ?? '?')}${C.reset}${C.dim}(${oneLine(String(frame.args ?? ''), 100)})${C.reset}`)
      return
    case 'extension_ui_request': {
      const method = String(frame.method ?? '')
      if (method === 'cancel') {
        writeBlock(t('ompTerminalPanel.k14jk3nu001', { p0: C.dim, p1: String(frame.targetId ?? ''), p2: C.reset }))
        // omp 主动撤销(回合中止等)→ 关闭交互面板
        if (hitl.value && hitl.value.id === String(frame.targetId ?? '')) hitl.value = null
        return
      }
      if (method === 'notify') {
        writeBlock(`  ${C.blue}ℹ ${String(frame.message ?? '')}${C.reset}`)
        return
      }
      if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
        const title = String(frame.title ?? '')
        writeBlock(`${C.bold}${C.magenta}⚠ HITL · ${method}: ${title}${C.reset}`)
        if (Array.isArray(frame.options)) {
          for (const opt of frame.options) {
            writeBlock(`  ${C.magenta}○${C.reset} ${String(opt)}`)
          }
        }
        // 弹出交互面板(实时帧驱动;term.init 的 hitl 仅覆盖重连时已在等待的对话框)
        hitl.value = {
          id: String(frame.id ?? ''),
          method,
          title,
          options: Array.isArray(frame.options) ? frame.options.map(String) : undefined,
          message: typeof frame.message === 'string' ? frame.message : undefined,
          placeholder: typeof frame.placeholder === 'string' ? frame.placeholder : undefined,
          prefill: typeof frame.prefill === 'string' ? frame.prefill : undefined,
          at: new Date().toISOString(),
        }
      }
      // 其余 UI 方法(setStatus/setWidget/…)静默
      return
    }
    case 'command_output':
      writeBlock(`${C.dim}${String(frame.text ?? '').replace(/\n/g, '\r\n')}${C.reset}`)
      return
    case 'response': {
      const command = String(frame.command ?? '')
      // 只回显人工控制命令的受理结果,其余(get_state 等)为噪音
      if (command === 'steer' || command === 'follow_up' || command === 'abort' || command === 'prompt') {
        const ok = frame.success !== false
        writeBlock(`  ${C.dim}· ${command} ${ok ? 'accepted' : `failed: ${String(frame.error ?? '')}`}${C.reset}`)
      }
      return
    }
    default:
      // available_commands_update / session_info_update / config_update / 未知帧:静默
      return
  }
}

// ===== WS 生命周期 =====

/** 连接目标(优先 pid 直连;否则 agentId 解析当前存活进程) */
const hasTarget = computed(() => (props.pid != null && props.pid > 0) || !!props.agentId)
/** 已连接会话的实际 pid(agent 寻址下由 term.init 回填;进程重启后变化) */
const livePid = ref<number | null>(null)

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const token = encodeURIComponent(userStore.token ?? '')
  const target = props.pid != null && props.pid > 0
    ? `pid=${props.pid}`
    : `agentId=${encodeURIComponent(props.agentId ?? '')}${props.channelId ? `&channelId=${encodeURIComponent(props.channelId)}` : ''}`
  return `${proto}://${window.location.host}/api/system/monitor/terminal/ws?${target}&token=${token}`
}

/** 上一次错误去重(NO_SESSION 重试风暴防刷屏) */
let lastErrorMessage = ''

function handleServerMessage(msg: TerminalServerMessage): void {
  switch (msg.type) {
    case 'term.init': {
      // 进程重启(agent 寻址重连)→ 新会话 seq 从 1 重来,去重游标必须重置
      if (livePid.value !== msg.meta.pid) {
        livePid.value = msg.meta.pid
        lastRenderedSeq = 0
        lastErrorMessage = ''
        writeBlock(t('ompTerminalPanel.k68kkpc002', { p0: C.dim, p1: msg.meta.pid, p2: msg.lastSeq, p3: C.reset }))
      }
      alive.value = msg.alive
      running.value = msg.running
      streaming.value = msg.streaming
      hitl.value = msg.hitl
      return
    }
    case 'term.frames':
      for (const f of msg.frames) renderFrame(f)
      flushStream()
      return
    case 'term.state':
      alive.value = msg.alive
      running.value = msg.running
      streaming.value = msg.streaming
      return
    case 'term.notice':
      message.info(msg.message)
      return
    case 'term.error': {
      // 重试期重复同错误只提示一次(进程未启动时每 2s 一条会刷屏)
      const line = `[${msg.code}] ${msg.message}`
      if (line === lastErrorMessage) return
      lastErrorMessage = line
      writeBlock(`${C.red}✗ ${line}${C.reset}`)
      return
    }
    case 'pong':
      return
  }
}

function connect(): void {
  if (!hasTarget.value || !userStore.token) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  closedByUser = false
  connState.value = retryCount === 0 ? 'connecting' : 'retrying'
  const sock = new WebSocket(wsUrl())
  ws = sock
  sock.onopen = () => {
    if (ws !== sock) return
    retryCount = 0
    connState.value = 'open'
  }
  sock.onmessage = (ev) => {
    if (ws !== sock) return
    try {
      handleServerMessage(JSON.parse(ev.data as string) as TerminalServerMessage)
    }
    catch { /* 非 JSON 帧忽略 */ }
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    hitl.value = null
    if (closedByUser || !hasTarget.value) {
      connState.value = 'dead'
      return
    }
    // 断线重连:1s 起指数退避,上限 10s(agent 寻址下进程未启动/重启由
    // NO_SESSION 关闭驱动重试,直到首个任务触发 spawn 后接入)
    retryCount += 1
    const delay = Math.min(1000 * 2 ** Math.min(retryCount - 1, 4), 10_000)
    connState.value = 'retrying'
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!closedByUser && hasTarget.value) connect()
    }, delay)
  }
  sock.onerror = () => { /* onclose 兜底 */ }
}

function disconnect(): void {
  closedByUser = true
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  ws?.close()
  ws = null
}

// ===== 控制面动作 =====

function sendRaw(obj: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
    return
  }
  writeBlock(t('ompTerminalPanel.k59zj91003', { p0: C.red, p1: C.reset }))
}

function submitInput(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  inputHistory.push(trimmed)
  inputHistory = inputHistory.slice(-50)
  inputHistoryIdx = -1
  sendRaw({ type: 'input', text: trimmed })
}

function doAbort(): void {
  sendRaw({ type: 'abort' })
  writeBlock(`${C.yellow}^C${C.reset}`)
}

function hitlRespond(response: { id: string, value?: string, confirmed?: boolean, cancelled?: boolean }): void {
  sendRaw({ type: 'ui_response', ...response })
  const label = response.cancelled
    ? 'cancelled'
    : response.confirmed !== undefined
      ? String(response.confirmed)
      : `"${oneLine(response.value ?? '', 80)}"`
  writeBlock(t('ompTerminalPanel.kvzhi95004', { p0: C.green, p1: label, p2: C.reset }))
  hitl.value = null
}

const hitlText = ref('')
watch(hitl, (h) => {
  hitlText.value = h?.prefill ?? h?.placeholder ?? ''
})

// ===== xterm 装配与输入处理 =====

let termKeydown: ((e: KeyboardEvent) => void) | null = null

async function ensureTerm(): Promise<void> {
  if (term || !hostEl.value) return
  // 模板 ref 的 unibabel 结构类型与 lib.dom 的 HTMLElement 结构不完全兼容,
  // 跨库边界(xterm / ResizeObserver)显式收窄
  const host: HTMLElement = hostEl.value as unknown as HTMLElement
  // 浏览器端动态加载 xterm(SSR 零执行;CJS 包不能静态命名导入)
  const [{ Terminal: XTerm }, { FitAddon: XFit }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ])
  term = new XTerm({
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    scrollback: 8000,
    theme: {
      background: '#10151c',
      foreground: '#d6dee8',
      cursor: '#7aa2f7',
      selectionBackground: '#33467c',
      black: '#10151c',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#d6dee8',
    },
  })
  fit = new XFit()
  term.loadAddon(fit)
  term.open(host)
  renderInputRow()

  // 输入通道 1:宿主容器 keydown(捕获阶段)——真实键盘与合成事件(CDP/自动化)
  // 都可靠触发;拦截已处理的键,阻止 xterm 内部重复消费
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        e.stopPropagation()
        doAbort()
      }
      return // 其余组合键(Ctrl+R/F5 等)交给浏览器
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      // 清掉本地键入行,由服务端 __human_input 回显统一渲染(回放观众一致,无重复)
      term?.write('\r\x1b[K')
      const line = inputLine
      inputLine = ''
      submitInput(line)
      renderInputRow()
      return
    }
    if (e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      inputLine = inputLine.slice(0, -1)
      renderInputRow()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (inputHistory.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'ArrowUp') {
        inputHistoryIdx = inputHistoryIdx < 0 ? inputHistory.length - 1 : Math.max(0, inputHistoryIdx - 1)
      }
      else {
        inputHistoryIdx = inputHistoryIdx < 0 ? -1 : Math.min(inputHistory.length - 1, inputHistoryIdx + 1)
        if (inputHistoryIdx === inputHistory.length - 1) inputHistoryIdx = -1
      }
      inputLine = inputHistoryIdx < 0 ? '' : (inputHistory[inputHistoryIdx] ?? '')
      renderInputRow()
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      inputLine += e.key
      renderInputRow()
    }
  }
  host.addEventListener('keydown', onKeyDown, true)
  termKeydown = onKeyDown

  // 输入通道 2:xterm onData 仅消费多字符输入(粘贴;单字符已由 keydown 处理)
  term.onData((data) => {
    if (data.length <= 1) return
    inputLine += data.replace(/[\r\n]+$/, '')
    renderInputRow()
  })

  resizeObs = new ResizeObserver(() => {
    try {
      fit?.fit()
    }
    catch { /* 尺寸未就绪 */ }
  })
  resizeObs.observe(host)
}

function teardownTerm(): void {
  if (termKeydown && hostEl.value) {
    hostEl.value.removeEventListener('keydown', termKeydown, true)
    termKeydown = null
  }
  resizeObs?.disconnect()
  resizeObs = null
  term?.dispose()
  term = null
  fit = null
}

// ===== 生命周期:抽屉开关驱动连接/实例 =====
watch(open, (v) => {
  if (v) {
    nextTick(async () => {
      await ensureTerm()
      resetView()
      lastRenderedSeq = 0
      retryCount = 0
      lastErrorMessage = ''
      writeBlock(`${C.dim}── AgentWorkShop harness terminal · ${props.pid ? `PID ${props.pid}` : `agent ${props.agentId?.slice(0, 8)}…`} ──${C.reset}`)
      connect()
      nextTick(() => {
        try {
          fit?.fit()
        }
        catch { /* ignore */ }
      })
    })
  }
  else {
    disconnect()
    hitl.value = null
  }
})

/** 目标切换(pid 直连或 agent 寻址变化)→ 清空视图重连(不同 Agent 的输出不得混渲染) */
watch(() => [props.pid, props.agentId], () => {
  if (!open.value) return
  disconnect()
  nextTick(() => {
    resetView()
    lastRenderedSeq = 0
    retryCount = 0
    lastErrorMessage = ''
    livePid.value = null
    writeBlock(`${C.dim}── 切换目标 · ${props.pid ? `PID ${props.pid}` : `agent ${props.agentId?.slice(0, 8)}…`} ──${C.reset}`)
    connect()
  })
})

onBeforeUnmount(() => {
  disconnect()
  teardownTerm()
})

const doClear = (): void => {
  streamBuf.length = 0
  streamLineOpen = false
  term?.clear()
  renderInputRow()
}

const stateLabel = computed(() => {
  if (!alive.value) return { text: t('terminal.stateExited'), color: 'error' as const }
  if (streaming.value) return { text: t('terminal.stateStreaming'), color: 'processing' as const }
  if (running.value) return { text: t('terminal.stateRunning'), color: 'warning' as const }
  return { text: t('terminal.stateIdle'), color: 'success' as const }
})
const connLabel = computed(() => {
  switch (connState.value) {
    case 'open': return { text: t('terminal.connOpen'), color: 'success' as const }
    case 'connecting': return { text: t('terminal.connConnecting'), color: 'default' as const }
    case 'retrying': return { text: `${t('terminal.connRetrying')}(${retryCount})`, color: 'warning' as const }
    default: return { text: t('terminal.connClosed'), color: 'default' as const }
  }
})
</script>

<template>
  <a-drawer
    v-model:open="open"
    placement="right"
    :width="860"
    :body-style="{ padding: '0', display: 'flex', flexDirection: 'column', background: '#10151c' }"
    :header-style="{ background: '#10151c', borderBottom: '1px solid #1d2733' }"
    class="omp-terminal-drawer"
  >
    <template #title>
      <div class="term-title">
        <span class="term-brand">
          <span class="i-tabler-terminal-2" />
        </span>
        <span class="term-name">{{ t('terminal.title') }}</span>
        <span class="ts-chip aw-mono ts-pid">PID {{ livePid ?? pid ?? '–' }}</span>
        <span
          v-if="subtitle"
          class="ts-chip ts-sub"
        >{{ subtitle }}</span>
      </div>
    </template>
    <template #extra>
      <div class="term-toolbar">
        <!-- 连接态 chip:呼吸点 + 文本(open=绿 / retrying=琥珀脉冲 / 其他=灰蓝) -->
        <span
          class="ts-chip aw-mono"
          :data-state="connState"
        ><span class="ts-dot" />{{ connLabel.text }}</span>
        <!-- 会话态 chip:idle=青 / busy=琥珀 / 流式=青脉冲 -->
        <span
          class="ts-chip aw-mono"
          :data-live="running ? (streaming ? 'streaming' : 'running') : 'idle'"
        >{{ stateLabel.text }}</span>
        <a-button
          size="small"
          danger
          class="ts-btn"
          :disabled="!running && !streaming"
          @click="doAbort"
        >
          <template #icon>
            <span class="i-tabler-player-stop" />
          </template>
          {{ t('terminal.abort') }}
        </a-button>
        <a-button
          size="small"
          class="ts-btn"
          @click="doClear"
        >
          <template #icon>
            <span class="i-tabler-eraser" />
          </template>
          {{ t('terminal.clear') }}
        </a-button>
      </div>
    </template>

    <div class="term-body">
      <!-- HITL 对话框(omp extension_ui_request;answer → ui_response) -->
      <div
        v-if="hitl"
        class="hitl-card"
      >
        <div class="hitl-head">
          <span class="i-tabler-user-question" />
          <b>{{ t('terminal.hitlTitle') }}</b>
          <a-tag color="magenta">
            {{ hitl.method }}
          </a-tag>
          <a-button
            size="small"
            type="text"
            danger
            @click="hitlRespond({ id: hitl.id, cancelled: true })"
          >
            {{ t('terminal.hitlCancel') }}
          </a-button>
        </div>
        <p class="hitl-question">
          {{ hitl.title }}
        </p>

        <template v-if="hitl.method === 'select'">
          <div class="hitl-options">
            <a-button
              v-for="opt in hitl.options ?? []"
              :key="opt"
              block
              @click="hitlRespond({ id: hitl.id, value: opt })"
            >
              {{ opt }}
            </a-button>
          </div>
        </template>
        <template v-else-if="hitl.method === 'confirm'">
          <p class="hitl-message">
            {{ hitl.message }}
          </p>
          <div class="hitl-row">
            <a-button
              type="primary"
              @click="hitlRespond({ id: hitl.id, confirmed: true })"
            >
              {{ t('terminal.hitlConfirm') }}
            </a-button>
            <a-button @click="hitlRespond({ id: hitl.id, confirmed: false })">
              {{ t('terminal.hitlDeny') }}
            </a-button>
          </div>
        </template>
        <template v-else>
          <a-textarea
            v-model:value="hitlText"
            :rows="3"
            :placeholder="hitl.placeholder"
            class="hitl-textarea"
            @press-enter="hitlRespond({ id: hitl.id, value: hitlText })"
          />
          <div class="hitl-row">
            <a-button
              type="primary"
              @click="hitlRespond({ id: hitl.id, value: hitlText })"
            >
              {{ t('terminal.hitlSubmit') }}
            </a-button>
            <a-button @click="hitlRespond({ id: hitl.id, cancelled: true })">
              {{ t('terminal.hitlCancel') }}
            </a-button>
          </div>
        </template>
      </div>

      <!-- xterm 终端 -->
      <div
        ref="hostEl"
        class="term-host"
      />

      <div class="term-hint aw-kicker">
        {{ t('terminal.hint') }}
      </div>
    </div>
  </a-drawer>
</template>

<style scoped>
/* 状态栏品牌块:终端图标入方形墨章(与侧栏墨方印同族,tokyo-night 冷暖对撞) */
.term-title {
  display: inline-flex;
  gap: 10px;
  align-items: center;
}
.term-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 14px;
  color: #9ece6a;
  background: rgb(158 206 106 / 10%);
  border: 1px solid rgb(158 206 106 / 22%);
  border-radius: var(--radius-panel-sm);
}
.term-name {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #e6edf3;
}

/* 状态 chip:等宽微字 + 语义点;色板对齐 xterm tokyo-night */
.ts-chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 1px 8px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: #a9b1d6;
  background: rgb(65 72 104 / 26%);
  border: 1px solid rgb(146 153 179 / 16%);
  border-radius: var(--radius-pill);
}
.ts-chip.ts-pid { color: #7dcfff; }
.ts-chip.ts-sub {
  font-family: var(--font-body);
  color: #9aa5ce;
}
.ts-dot {
  width: 6px;
  height: 6px;
  background: #565f89;
  border-radius: 50%;
}
/* 连接态语义色 */
.ts-chip[data-state='open'] { color: #9ece6a; background: rgb(158 206 106 / 10%); border-color: rgb(158 206 106 / 22%); }
.ts-chip[data-state='open'] .ts-dot { background: #9ece6a; animation: ts-breathe 2.2s ease-in-out infinite; }
.ts-chip[data-state='retrying'] { color: #e0af68; background: rgb(224 175 104 / 10%); border-color: rgb(224 175 104 / 24%); }
.ts-chip[data-state='retrying'] .ts-dot { background: #e0af68; animation: ts-breathe 1.1s ease-in-out infinite; }
.ts-chip[data-state='connecting'] { color: #7aa2f7; }
.ts-chip[data-state='connecting'] .ts-dot { background: #7aa2f7; animation: ts-breathe 1.1s ease-in-out infinite; }
/* 会话态 */
.ts-chip[data-live='streaming'] { color: #7dcfff; background: rgb(125 207 255 / 10%); border-color: rgb(125 207 255 / 24%); }
.ts-chip[data-live='streaming']::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #7dcfff;
  border-radius: 50%;
  animation: ts-breathe 0.9s ease-in-out infinite;
}
.ts-chip[data-live='running'] { color: #e0af68; background: rgb(224 175 104 / 10%); border-color: rgb(224 175 104 / 24%); }
.ts-chip[data-live='running']::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #e0af68;
  border-radius: 50%;
  animation: ts-breathe 1.6s ease-in-out infinite;
}
.ts-chip[data-live='idle'] { color: #565f89; }
.ts-chip[data-live='idle']::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #565f89;
  border-radius: 50%;
}
@keyframes ts-breathe {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ts-dot, .ts-chip::before { animation: none !important; opacity: 0.85; }
}

/* 工具按钮:暗面浮起 + 按压反馈 */
.term-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}
:deep(.ts-btn.ant-btn) {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  color: #c0caf5;
  background: rgb(65 72 104 / 30%);
  border: 1px solid rgb(146 153 179 / 18%);
  transition: background 0.15s ease, transform 0.12s ease;
}
:deep(.ts-btn.ant-btn:hover:not(:disabled)) { background: rgb(65 72 104 / 50%); }
:deep(.ts-btn.ant-btn:active:not(:disabled)) { transform: translateY(1px); }
:deep(.ts-btn.ant-btn:disabled) { opacity: 0.4; }

.term-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.term-host {
  flex: 1;
  min-height: 0;
  padding: 10px 12px 4px;
}

.term-hint {
  padding: 6px 12px 8px;
  color: rgb(214 222 232 / 45%);
  background: #10151c;
}

/* HITL 对话框:悬浮在终端上方(正在等待人类决策) */
.hitl-card {
  position: absolute;
  top: 14px;
  right: 16px;
  z-index: 10;
  width: min(420px, calc(100% - 32px));
  padding: 12px 14px;
  background: rgb(23 30 40 / 97%);
  border: 1px solid #bb9af7;
  border-radius: var(--radius-panel-sm);
  box-shadow: 0 8px 28px rgb(0 0 0 / 55%);
}

.hitl-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  color: #bb9af7;
}

.hitl-head > b {
  color: #e6edf3;
}

.hitl-head .ant-btn {
  margin-left: auto;
}

.hitl-question {
  margin: 0 0 10px;
  font-weight: 600;
  color: #e6edf3;
  white-space: pre-wrap;
}

.hitl-message {
  margin: 0 0 10px;
  color: #a9b4c0;
  white-space: pre-wrap;
}

.hitl-options {
  display: flex;
  max-height: 300px;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.hitl-options .ant-btn {
  justify-content: flex-start;
  text-align: left;
  white-space: normal;
}

.hitl-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.hitl-textarea {
  margin-top: 4px;
}
</style>

<style>
/* drawer 挂 body teleport,全局态:暗色标题/内容(xterm 主题一致) */
.omp-terminal-drawer .ant-drawer-header {
  background: linear-gradient(180deg, #131a24 0%, #10151c 100%) !important;
  border-bottom: 1px solid #1d2733 !important;
  box-shadow: inset 0 1px 0 rgb(146 153 179 / 6%);
}
.omp-terminal-drawer .ant-drawer-header-title {
  color: #e6edf3;
}
</style>
