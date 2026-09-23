/**
 * useTerminalRenderer —— 结构化 RPC 帧 → ANSI TUI 渲染层(自 OmpTerminalPanel 结构拆分)。
 *
 * 只做"帧/文本 → xterm 写入":流式增量缓冲、底部输入行重绘、视图重置与清屏。
 * xterm 实例不在此创建/销毁,经 getTerm 访问器借用;已渲染 seq 游标与命令历史
 * 归 session 组合式,经访问器/回调协作 —— 拆分只搬运代码,渲染时序逐字不变。
 */
import type { Ref } from 'vue'
import type { Terminal } from '@xterm/xterm'
import { nowLocalIso } from '~/composables/workshop/useLocalTime'
import type {
  TermFrame,
  TerminalHitlDialog,
} from '#shared/terminal-protocol'

/** 渲染层协作口(实例/游标/历史由 session 组合式持有) */
export interface TerminalRendererDeps {
  /** xterm 实例访问器(未装配或已销毁时为 null) */
  getTerm: () => Terminal | null
  /** 待应答 HITL 对话框(extension_ui_request cancel 分支置空) */
  hitl: Ref<TerminalHitlDialog | null>
  /** 已渲染 seq(重连全量重放去重)访问器 */
  getLastSeq: () => number
  setLastSeq: (seq: number) => void
  /** 清空命令历史(历史属于会话,随视图一并重置) */
  clearHistory: () => void
}

export function useTerminalRenderer(deps: TerminalRendererDeps) {
  const { getTerm, hitl, getLastSeq, setLastSeq, clearHistory } = deps
  const { t } = useI18n()

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

  /** 底部输入行已键入内容(按键/历史处理在 session 组合式,此处共用读写) */
  let inputLine = ''

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
    getTerm()?.write(text)
    if (!/\r?\n$/.test(text)) streamLineOpen = true
  }

  /** 收尾流式行:仅在光标停在流式行中时补一个换行 */
  function closeStreamLine(): void {
    if (!streamLineOpen) return
    streamLineOpen = false
    getTerm()?.write('\r\n')
  }

  /** 写入完整块(独立行):冲刷流式增量并收尾流式行 → 清输入行 → 写块 → 重绘输入行 */
  function writeBlock(text: string): void {
    const term = getTerm()
    if (!term) return
    flushStream()
    closeStreamLine()
    term.write('\r\x1b[K')
    term.write(text.endsWith('\r\n') || text.endsWith('\n') ? text : `${text}\r\n`)
    renderInputRow()
  }

  /** 重绘底部输入行(prompt + 已键入内容);流式行未收尾时跳过(回合收尾后统一补绘) */
  function renderInputRow(): void {
    const term = getTerm()
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
    clearHistory()
    getTerm()?.reset()
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

  function renderFrame(f: TermFrame): void {
    if (f.seq <= getLastSeq()) return
    setLastSeq(f.seq)
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
            at: nowLocalIso(),
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

  /** 清屏(仅清 xterm 缓冲与流式残行;seq 游标不动,重放去重仍有效) */
  function doClear(): void {
    streamBuf.length = 0
    streamLineOpen = false
    getTerm()?.clear()
    renderInputRow()
  }

  return {
    C,
    flushStream,
    closeStreamLine,
    writeBlock,
    renderInputRow,
    resetView,
    renderFrame,
    doClear,
    oneLine,
    /** 底部输入行读写口(按键处理/粘贴在 session 组合式) */
    get inputLine(): string {
      return inputLine
    },
    set inputLine(v: string) {
      inputLine = v
    },
  }
}
