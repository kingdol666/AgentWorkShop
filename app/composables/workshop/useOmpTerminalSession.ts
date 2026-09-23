/**
 * useOmpTerminalSession —— OmpTerminalPanel 的会话/连接层(自 OmpTerminalPanel 结构拆分)。
 *
 * 数据面:WS /api/system/monitor/terminal/ws?pid&token(#shared/terminal-protocol)
 *  - 服务端 terminal-hub 镜像 omp `--mode rpc-ui` 子进程的全部 RPC 帧;
 *  - 帧 → TUI 的渲染细节在 useTerminalRenderer(经访问器借用 xterm 实例);
 *  - 控制面(真 Human-in-the-loop):行内输入 → input(steer·follow_up 注入 omp
 *    会话);Ctrl+C / 中止按钮 → abort;HITL 面板 → ui_response。
 *  - 断线自动重连(指数退避);重连全量重放按 seq 去重,时间线无缝续接。
 *
 * SSR 安全:xterm(CJS 包)在抽屉打开时动态 import(ensureTerm 内 await),
 * 服务端渲染路径零执行。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ModelRef } from 'vue'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { message } from 'ant-design-vue'
import { useUserStore } from '@/app/stores/workshop/user'
import type {
  TerminalHitlDialog,
  TerminalServerMessage,
} from '#shared/terminal-protocol'
import { useTerminalRenderer } from '@/app/composables/workshop/useTerminalRenderer'

/** 终端面板寻址入参(与 OmpTerminalPanel 的 props 逐字一致) */
export interface OmpTerminalSessionProps {
  /** pid 直连寻址(monitor 进程表) */
  pid?: number | null
  /** agent 寻址(lanes):解析该成员当前存活的 omp 进程,重启后自动落到新会话 */
  agentId?: string | null
  channelId?: string | null
  /** 抽屉标题附加信息(monitor 行/lane 头快照) */
  subtitle?: string
}

export function useOmpTerminalSession(props: OmpTerminalSessionProps, open: ModelRef<boolean>) {
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
  let inputHistory: string[] = []
  let inputHistoryIdx = -1
  /** 流式增量渲染中(避免输入行与输出交错重绘抖动的细粒度锁不需要:批后重绘) */

  // 渲染层:实例经访问器借用,seq 游标/命令历史经访问器与回调协作
  const renderer = useTerminalRenderer({
    getTerm: () => term,
    hitl,
    getLastSeq: () => lastRenderedSeq,
    setLastSeq: (seq) => {
      lastRenderedSeq = seq
    },
    clearHistory: () => {
      inputHistory = []
      inputHistoryIdx = -1
    },
  })
  const { C, flushStream, writeBlock, renderInputRow, resetView, renderFrame, doClear, oneLine } = renderer

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
        const line = renderer.inputLine
        renderer.inputLine = ''
        submitInput(line)
        renderInputRow()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        renderer.inputLine = renderer.inputLine.slice(0, -1)
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
        renderer.inputLine = inputHistoryIdx < 0 ? '' : (inputHistory[inputHistoryIdx] ?? '')
        renderInputRow()
        return
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        renderer.inputLine += e.key
        renderInputRow()
      }
    }
    host.addEventListener('keydown', onKeyDown, true)
    termKeydown = onKeyDown

    // 输入通道 2:xterm onData 仅消费多字符输入(粘贴;单字符已由 keydown 处理)
    term.onData((data) => {
      if (data.length <= 1) return
      renderer.inputLine += data.replace(/[\r\n]+$/, '')
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
      writeBlock(`${C.dim}${t('ompTerminalPanel.switchTarget', { p0: props.pid ? `PID ${props.pid}` : `agent ${props.agentId?.slice(0, 8)}…` })}${C.reset}`)
      connect()
    })
  })

  onBeforeUnmount(() => {
    disconnect()
    teardownTerm()
  })

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

  return {
    hostEl,
    connState,
    alive,
    running,
    streaming,
    hitl,
    livePid,
    stateLabel,
    connLabel,
    hitlRespond,
    doAbort,
    doClear,
  }
}
