/**
 * 事件聚类引擎 — Codex/OpenHands 风格 turn block 增量版。
 *
 * 与旧版差异:
 *  - 增量聚类:只处理新增帧,块对象身份稳定(Vue 按 key 复用组件,流式更新不整树重建)
 *  - 内容智能去重:落定全文(status.message/agent.message)与已累计 delta 相同或为前缀扩展时
 *    绝不重复渲染第二遍——修复"连续两次重复渲染"(omp 消息流 delta 与 message_end 全文重复)
 *  - 跨块落定折回:工具调用把流切段时,deltas 累计跨块跟踪,message_end 全文按内容比对折回
 *    最后一段流块;先前流片段标记 coveredBy 折叠为一行提示(OpenHands 风格)
 *  - 纯函数供密集行视图复用:classifyEvent / foldStreamDuplicates / buildStreamText
 */
import { reactive } from 'vue'
import type { AepEnvelope } from '#shared/workshop-protocol'

export type BlockKind
  = | 'tool' // 🔧 工具调用
    | 'status' // 中间状态文本
    | 'life' // agent 生命周期(idle/busy/stopped)
    | 'route' // 点对点消息投递
    | 'stream' // LLM 输出(delta 打字机 + message 落定气泡)
    | 'task' // 任务状态迁移/进度
    | 'artifact' // 交付物
    | 'member' // 团队成员变更
    | 'memory' // 记忆沉淀
    | 'error' // 错误
    | 'other'

export interface EventBlock {
  id: string
  kind: BlockKind
  agentId: string | null
  taskId: string | null
  events: AepEnvelope[]
  firstAt: string
  lastAt: string
  /** stream:已落定(agent.message 落定 / 全文重复帧折入),渲染端隐藏打字光标 */
  settled: boolean
  /** stream:折入的重复落定帧数 */
  folded: number
  /** stream:落定全文与 delta 累计有差异(含扩展段落)时,以落定全文覆盖渲染 */
  overrideText: string | null
  /** stream:内容已被折回并块的流片块折叠为一行提示 */
  coveredBy: string | null
  /** artifact:交付物正文与相邻同源 stream 回复重复(默认折叠正文) */
  dupStream: boolean
}

// ===== 常量 =====

const TOOL_PREFIX = /^🔧\s*\S+/

/** 工具元数据:native = omp 原生作业工具;host = harness 协作工具(任务/通信/记忆/团队) */
export const TOOL_META: Record<string, { icon: string, kind: 'native' | 'host' }> = {
  read: { icon: 'i-tabler-file-search', kind: 'native' },
  write: { icon: 'i-tabler-pencil', kind: 'native' },
  edit: { icon: 'i-tabler-edit', kind: 'native' },
  bash: { icon: 'i-tabler-terminal-2', kind: 'native' },
  grep: { icon: 'i-tabler-search', kind: 'native' },
  glob: { icon: 'i-tabler-folders', kind: 'native' },
  dispatch_task: { icon: 'i-tabler-send', kind: 'host' },
  reassign_task: { icon: 'i-tabler-arrows-exchange', kind: 'host' },
  update_task: { icon: 'i-tabler-pencil-code', kind: 'host' },
  cancel_task: { icon: 'i-tabler-circle-x', kind: 'host' },
  complete_task: { icon: 'i-tabler-circle-check', kind: 'host' },
  report_progress: { icon: 'i-tabler-progress-check', kind: 'host' },
  send_message_to_agent: { icon: 'i-tabler-message', kind: 'host' },
  poll_messages: { icon: 'i-tabler-inbox', kind: 'host' },
  broadcast_message: { icon: 'i-tabler-rss', kind: 'host' },
  list_team_agents: { icon: 'i-tabler-users', kind: 'host' },
  list_channel_tasks: { icon: 'i-tabler-list', kind: 'host' },
  get_task_details: { icon: 'i-tabler-eye', kind: 'host' },
  get_my_task_queue: { icon: 'i-tabler-stack-2', kind: 'host' },
  get_queue_overview: { icon: 'i-tabler-chart-bar', kind: 'host' },
  search_memory: { icon: 'i-tabler-brain', kind: 'host' },
  save_memory: { icon: 'i-tabler-bookmark', kind: 'host' },
  create_team_agent: { icon: 'i-tabler-user-plus', kind: 'host' },
  update_team_agent: { icon: 'i-tabler-user-cog', kind: 'host' },
  remove_team_agent: { icon: 'i-tabler-user-minus', kind: 'host' },
}

/** 类别展示元数据(壳层统一渲染头部) */
export const KIND_META: Record<BlockKind, { label: string, icon: string }> = {
  tool: { label: 'tool', icon: 'i-tabler-tool' },
  status: { label: 'status', icon: 'i-tabler-dots' },
  life: { label: 'state', icon: 'i-tabler-activity' },
  route: { label: 'message', icon: 'i-tabler-route' },
  stream: { label: 'llm', icon: 'i-tabler-message-dots' },
  task: { label: 'task', icon: 'i-tabler-checklist' },
  artifact: { label: 'artifact', icon: 'i-tabler-package' },
  member: { label: 'team', icon: 'i-tabler-users' },
  memory: { label: 'memory', icon: 'i-tabler-bookmark' },
  error: { label: 'error', icon: 'i-tabler-alert-triangle' },
  other: { label: 'event', icon: 'i-tabler-dots' },
}

// ===== 基础函数 =====

/** 事件 → 聚合类别 */
export function classifyEvent(e: AepEnvelope): BlockKind {
  switch (e.type) {
    case 'agent.status.message':
      return TOOL_PREFIX.test(String((e.payload as { text?: string }).text ?? '')) ? 'tool' : 'status'
    case 'agent.status':
      return 'life'
    case 'a2a.message':
      return 'route'
    case 'agent.delta':
    case 'agent.message':
      return 'stream'
    case 'task.status':
    case 'task.progress':
      return 'task'
    case 'a2a.artifact':
      return 'artifact'
    case 'agent.member':
      return 'member'
    case 'memory.saved':
      return 'memory'
    case 'error':
      return 'error'
    default:
      return 'other'
  }
}

/** agent 稳定配色(id hash → hue;无 id 灰。饱和度/亮度压低:白字首字母可达 AA 对比) */
export function agentHueColor(agentId: string | null | undefined): string {
  if (!agentId) return '#6e6e77'
  let h = 0
  for (const ch of agentId) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 48%, 38%)`
}

/** 统一化空白比较 */
export function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 流块当前是否处于打字机状态(尾巴是 delta 且未落定) */
export function isStreaming(block: EventBlock): boolean {
  const ev = block.events[block.events.length - 1]
  if (!ev) return false
  return ev.type === 'agent.delta' && !block.settled
}

/** 任务语义类的 taskId(信封 taskId 优先) */
function taskIdOf(e: AepEnvelope): string | null {
  if (e.taskId) return e.taskId
  switch (e.type) {
    case 'task.status':
    case 'task.progress':
      return String((e.payload as { taskId?: string }).taskId ?? '') || null
    case 'a2a.artifact':
      return String((e.payload as { taskId?: string }).taskId ?? '') || null
    default:
      return null
  }
}

/** 合并键内 taskId 兼容:单侧缺省视为无约束 */
function taskCompatible(a: string | null, b: string | null): boolean {
  return a == null || b == null || a === b
}

/** 落定文本与累计水路的关系 */
function foldRelation(trail: string, short: string): 'dup' | 'extend' | 'none' {
  const t = trail.trim()
  const s = short.trim()
  if (!t || !s) return 'none'
  if (t === s || normText(t) === normText(s)) return 'dup'
  if (s.startsWith(t)) return 'extend'
  return 'none'
}

// ===== 累计水路 / 折回 =====

interface StreamTrack {
  text: string
  pieces: EventBlock[]
  last: EventBlock
}

export class BlockClusterer {
  private arr: EventBlock[] = []
  private last: EventBlock | null = null
  private tracks = new Map<string, StreamTrack>()
  private trail: Record<string, string> = Object.create(null)
  private idSeq = 0
  private processed = 0
  /** 上次同步时列表头部事件的 seq(头部变化 = 历史回填插入/ring 裁剪/过滤切换 → 必须全量重建,否则索引错位重复聚类) */
  private headSeq: number | undefined = undefined

  get blocks(): EventBlock[] {
    return this.arr
  }

  get processedCount(): number {
    return this.processed
  }

  reset(): void {
    this.arr.length = 0
    this.last = null
    this.tracks.clear()
    this.trail = Object.create(null)
    this.processed = 0
    this.headSeq = undefined
  }

  /**
   * 序列同步:只处理新增帧。列表头部 seq 变化(loadHistory 头部插入历史帧并整体
   * 排序 / ring 容量裁剪 / 过滤切换)时,已处理事件整体右移——按索引继续会把已
   * 聚类事件重复成块,故检测到头部变化即全量重建(一次重建,确定性无重复)。
   */
  sync(events: AepEnvelope[]): void {
    const head = events.length > 0 ? events[0]?.seq : undefined
    if (events.length < this.processed || head !== this.headSeq) this.reset()
    for (let i = this.processed; i < events.length; i++) this.push(events[i]!)
    this.processed = events.length
    this.headSeq = events.length > 0 ? events[0]?.seq : undefined
  }

  push(e: AepEnvelope): EventBlock | null {
    if (e.type === 'channel.snapshot' || e.type === 'pong') return this.last

    const agentId = e.agentId ?? null
    const taskId = taskIdOf(e)
    const agentKey = agentId ?? ''
    const trackKey = `${agentKey}\u0000${taskId ?? ''}`
    const baseKind = classifyEvent(e)

    // ① 流式落定帧 — 内容重复判断:折回已累计流的重复正文
    if (e.type === 'agent.status.message' && baseKind === 'status') {
      const t = textOf(e).trim()
      const track = this.tracks.get(trackKey)
      if (t && track && track.text) {
        const rel = foldRelation(track.text, t)
        if (rel === 'dup' || rel === 'extend') {
          return this.foldInto(track, e, t)
        }
      }
    }
    if (e.type === 'agent.message') {
      const t = textOf(e).trim()
      const track = this.tracks.get(trackKey)
      if (t && track && track.text) {
        const rel = foldRelation(track.text, t)
        if (rel === 'dup' || rel === 'extend') {
          return this.foldInto(track, e, t)
        }
      }
    }

    // ② 解析块类别:
    //  delta/message 直接走 stream;status.message 非🔧(未折回)保持 status,
    //  除非紧邻一个同源 OPEN 流块(消息直接跟在 delta 流后面,合并进同一个气泡)
    let kind: BlockKind = baseKind
    if (e.type === 'agent.delta') {
      kind = 'stream'
    }
    else if (e.type === 'agent.message') {
      kind = 'stream'
    }
    else if (baseKind === 'status') {
      const lb = this.last
      const adjacentOpenStream = lb !== null
        && lb.kind === 'stream'
        && e.agentId === lb.agentId
        && taskCompatible(lb.taskId, taskId)
        && !lb.settled
      if (adjacentOpenStream) kind = 'stream'
    }

    // ③ 合并判断 — 稳定块身份(delta 流型高频追加)
    const mergeable = this.last !== null
      && this.last.kind === kind
      && this.last.agentId === e.agentId
      && agentId !== null
      && taskCompatible(this.last.taskId, taskId)
      && !(kind === 'stream' && this.last.settled)
      && !(kind === 'task' && this.last.taskId && taskId && this.last.taskId !== taskId)
      && !(kind === 'artifact' && this.last.taskId && taskId && this.last.taskId !== taskId)
    if (mergeable && this.last) {
      const b = this.last
      b.events.push(e)
      b.lastAt = e.at
      if (kind === 'stream') {
        if (e.type === 'agent.delta') {
          b.settled = false
          const t = this.tracks.get(trackKey)
          if (t) {
            t.text += textOf(e)
            t.last = b
            this.setTrail(agentKey, taskId, t.text)
          }
          else {
            b.settled = false
            this.setTrail(agentKey, taskId, textOf(e))
          }
        }
        else {
          // 落定 message 相邻合并:落定收口(不清除 render 文本)
          b.settled = true
          this.setTrail(agentKey, taskId, `${textOf(e)}`)
        }
      }
      return b
    }

    // ④ 新块(reactive 化:块内 events.push / settled / overrideText 等原地变更
    //    能触发消费方(EventBlock/ClusterStream)的 computed 实时更新)
    const block: EventBlock = reactive({
      id: `b${++this.idSeq}`,
      kind,
      agentId,
      taskId,
      events: [e],
      firstAt: e.at,
      lastAt: e.at,
      settled: kind === 'stream' ? e.type !== 'agent.delta' : false,
      folded: 0,
      overrideText: null,
      coveredBy: null,
      dupStream: false,
    })
    this.arr.push(block)
    this.last = block

    if (kind === 'stream') {
      const tk = this.tracks.get(trackKey)
      if (tk && tk.pieces.length > 0 && !tk.pieces.includes(block)) {
        tk.pieces.push(block)
        tk.last = block
      }
      else if (!tk) {
        this.tracks.set(trackKey, {
          text: '',
          pieces: [block],
          last: block,
        })
      }
      if (e.type === 'agent.delta') {
        const t = this.tracks.get(trackKey)
        if (t) {
          t.text += textOf(e)
          this.setTrail(agentKey, taskId, t.text)
        }
      }
    }
    if (kind === 'artifact') {
      const t = textOf(e)
      const prior = this.trail[trackKey] ?? this.trail[`${agentKey}\u0000`]
      if (prior && t && normText(prior) === normText(t)) {
        block.dupStream = true
      }
    }
    return block
  }

  /** 内容重复折回:已累计流足够覆盖时不再成块;折回块重渲染一律以落定全文为准
   *  (跨工具切段折回时,目标块只含尾部 delta,不覆盖全文则文本被截断) */
  private foldInto(track: StreamTrack, e: AepEnvelope, text: string): EventBlock {
    const target = track.last
    target.events.push(e)
    target.folded += 1
    target.lastAt = e.at
    target.settled = true
    target.overrideText = text
    // 前序流片段被本次落定文本覆盖 → 折叠为提示行
    for (const p of track.pieces) {
      if (p !== target) p.coveredBy = target.id
    }
    track.text = ''
    track.pieces = [target]
    track.last = target
    this.setTrail(target.agentId ?? '', target.taskId, text)
    return target
  }

  private setTrail(agentKey: string, taskId: string | null, text: string): void {
    this.trail[`${agentKey}\u0000${taskId ?? ''}`] = text
  }
}

/** 事件正文(delta/status.text/message.parts/artifact.parts) */
function textOf(e: AepEnvelope): string {
  switch (e.type) {
    case 'agent.delta':
      return String((e.payload as { delta?: string }).delta ?? '')
    case 'agent.status.message':
      return String((e.payload as { text?: string }).text ?? '')
    case 'agent.message':
    case 'a2a.message': {
      const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
      return parts.map(p => p.text ?? '').join('\n')
    }
    case 'a2a.artifact': {
      const ap = (e.payload as { artifact?: { parts?: Array<{ text?: string }> } }).artifact?.parts ?? []
      return ap.map(p => p.text ?? '').join('\n')
    }
    default:
      return ''
  }
}

/** 流块的最终可见文本(delta 累计;落定帧不重复该文) */
export function buildStreamText(block: EventBlock): string {
  if (block.overrideText) return block.overrideText
  let acc = ''
  for (const e of block.events) {
    if (e.type === 'agent.delta') {
      acc += textOf(e)
      continue
    }
    // message/status 落定帧:序列不割裂,但内容重复部分不自渲染(重复判定归聚类器)
    if (e.type === 'agent.status.message') continue
    if (e.type === 'agent.message') {
      const t = textOf(e).trim()
      if (t) acc = `${acc ? `${acc}\n` : ''}${t}`
      continue
    }
    // 任务落定 / 交付物不自成为流文本
  }
  return acc
}

/**
 * 打字光标可见性(空光标闪烁修复的权威语义):
 * 仅当"已有文本 &&(流式未落定 || 揭示未追平)"时显示;空文本块绝不显示光标。
 */
export function streamCursorVisible(fullLen: number, visibleLen: number, streaming: boolean): boolean {
  return fullLen > 0 && (streaming || visibleLen < fullLen)
}

// ===== markdown-lite 渲染(流式安全:先转义后标记,输出可信 HTML) =====

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c)
}

function inlineMd(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<i>$2</i>')
}

/** GitHub 风格提示框元数据(open-tag github-alert 移植;`> [!NOTE]` 等) */
const GH_ALERTS: Record<string, { label: string, icon: string }> = {
  note: { label: '说明', icon: 'i-tabler-info-circle' },
  tip: { label: '提示', icon: 'i-tabler-bulb' },
  important: { label: '重要', icon: 'i-tabler-flag' },
  warning: { label: '警告', icon: 'i-tabler-alert-triangle' },
  caution: { label: '注意', icon: 'i-tabler-shield-half' },
}

/** 散文渲染:围栏代码块 / 段落 / # 标题 / - 列表 / > 引用 / GitHub 提示框 /
 *  任务列表勾选 / 行内代码与加粗(对部分流式文本安全) */
export function mdLite(src: string): string {
  // ① 围栏代码块先行抽离(```lang … ```):抽成占位符,正文段落流不受影响;
  //    代码块 = 头栏(语言标签 + 复制按钮,事件委托见 useCodeCopy) + 等宽正文
  const codeBlocks: string[] = []
  const fenced = escapeHtml(src).replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, body: string) => {
    const idx = codeBlocks.length
    codeBlocks.push(
      `<div class="code-block" data-lang="${lang || 'text'}">`
      + `<div class="code-head"><span class="code-lang">${lang || 'text'}</span>`
      + `<button type="button" class="code-copy">复制</button></div>`
      + `<pre><code>${body.replace(/\n$/, '')}</code></pre></div>`,
    )
    return `@@AWCODE${idx}@@`
  })
  const html = fenced.split(/\n{2,}/).map((para) => {
    const lines = para.split('\n')
    if (/^### /.test(para)) return `<h5>${inlineMd(para.slice(4))}</h5>`
    if (/^## /.test(para)) return `<h4>${inlineMd(para.slice(3))}</h4>`
    if (/^# /.test(para)) return `<h4>${inlineMd(para.slice(2))}</h4>`
    if (lines.every(l => /^\s*[-*] /.test(l))) {
      // 任务列表:任一行是 `- [ ]` / `- [x]` → 勾选列表(open-tag task-list 移植)
      if (lines.some(l => /^\s*[-*] \[[ xX]\] /.test(l))) {
        const items = lines.map((l) => {
          const m = /^\s*[-*] \[([ xX])\] (.*)$/.exec(l)!
          const done = (m[1] ?? ' ').toLowerCase() === 'x'
          return `<li class="task-item${done ? ' done' : ''}">`
            + `<span class="task-check${done ? ' on' : ''}">${done ? '✓' : ''}</span>`
            + `<span class="task-text">${inlineMd(m[2] ?? '')}</span></li>`
        }).join('')
        return `<ul class="task-list">${items}</ul>`
      }
      return `<ul>${lines.map(l => `<li>${inlineMd(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
    }
    if (lines.every(l => /^&gt;\s?/.test(l))) {
      // GitHub 提示框:首行 `> [!NOTE] [标题]`(open-tag remarkGithubAlerts 移植)
      const am = /^&gt;\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/.exec(lines[0] ?? '')
      if (am) {
        const meta = GH_ALERTS[am[1]!.toLowerCase()]!
        const firstRest = am[2] ?? ''
        const bodyLines = [
          ...(firstRest ? [firstRest] : []),
          ...lines.slice(1).map(l => l.replace(/^&gt;\s?/, '')),
        ]
        return `<div class="gh-alert gh-${am[1]!.toLowerCase()}">`
          + `<div class="gh-title"><span class="${meta.icon}"></span>${meta.label}</div>`
          + `<p>${bodyLines.map(l => inlineMd(l)).join('<br>')}</p></div>`
      }
      return `<blockquote>${lines.map(l => inlineMd(l.replace(/^&gt;\s?/, ''))).join('<br>')}</blockquote>`
    }
    // 占位符独占段落 → 原样还原(不包 <p>)
    if (lines.length === 1 && /^@@AWCODE\d+@@$/.test(para)) return para
    return `<p>${lines.map(l => inlineMd(l)).join('<br>')}</p>`
  }).join('')
  return html.replace(/@@AWCODE(\d+)@@/g, (_m, i: string) => codeBlocks[Number(i)] ?? '')
}

/**
 * 密集行视图去重:delta→全文落定同为 agent.status.message/agent.message 时,
 * fold 掉落定帧(row 只保留一段),流/工具行保持各自 row。
 */
export function foldStreamDuplicates(events: AepEnvelope[]): AepEnvelope[] {
  const out: AepEnvelope[] = []
  const trails = new Map<string, string>()
  for (const e of events) {
    const cls = classifyEvent(e)
    const key = `${e.agentId ?? ''}\u0000${taskIdOf(e) ?? ''}`
    switch (e.type) {
      case 'agent.delta':
        trails.set(key, (trails.get(key) ?? '') + textOf(e))
        out.push(e)
        break
      case 'agent.message':
      case 'agent.status.message': {
        const isTool = e.type === 'agent.status.message' && cls === 'tool'
        if (e.type === 'agent.status.message' && isTool) {
          out.push(e)
          break
        }
        const t = textOf(e).trim()
        const trail = trails.get(key) ?? ''
        trails.set(key, '')
        if (t && (foldRelation(trail, t) === 'dup' || foldRelation(trail, t) === 'extend')) {
          // 与流累计重复:流已渲染(渲染于前序 row)
          continue
        }
        out.push(e)
        break
      }
      default:
        out.push(e)
    }
  }
  return out
}

// ===== @提及高亮(open-tag Slack 声部)=====

export interface MentionMember {
  agentId: string
  name: string
}

/** @Name 形态的提及词边界(前面是行首/空白/括号,避免匹配邮箱与代码) */
function mentionRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|(?<![\\w@]))@(${escaped})(?=$|[\\s,.;:!?、,。;:!?…)\\]】」』])`, 'gu')
}

/**
 * 源文本提及占位:@Name → \uE000M{idx}\uE000(私用区码点,正文流不可能出现;
 * 先于 mdLite 转义执行,占位符不受转义/标记影响;名字按长度降序避免前缀遮蔽)。
 */
export function maskMentions(src: string, members: MentionMember[]): { text: string, hits: MentionMember[] } {
  const hits: MentionMember[] = []
  if (members.length === 0) return { text: src, hits }
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length)
  let text = src
  for (const m of sorted) {
    if (!m.name) continue
    text = text.replace(mentionRegex(m.name), (_m, _pre, _name) => {
      hits.push(m)
      return `\uE000M${hits.length - 1}\uE000`
    })
  }
  return { text, hits }
}

/** 还原占位为提及 pill HTML(mdLite 输出后执行;pill 点击由容器事件委托处理) */
export function restoreMentions(html: string, hits: MentionMember[]): string {
  return html.replace(/\uE000M(\d+)\uE000/g, (_m, i: string) => {
    const m = hits[Number(i)]
    if (!m) return ''
    return `<span class="md-mention" data-agent-id="${escapeHtml(m.agentId)}">@${escapeHtml(m.name)}</span>`
  })
}

/** mdLite + @提及高亮一体化(聊天正文渲染入口) */
export function mdLiteMentions(src: string, members: MentionMember[]): string {
  const { text, hits } = maskMentions(src, members)
  return restoreMentions(mdLite(text), hits)
}
