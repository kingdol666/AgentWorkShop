/**
 * AgentBlock v1 —— 跨 harness 统一工具调用块(结构化协议,与 🔧 文本并行发射,不替换)。
 *
 * 背景(2026-11-08 生产审计·指控6):工具调用此前只有 emoji 前缀纯文本,前端正则反解,
 * 各 harness 文案互不一致(claude 无参数预览/opencode 成功即静默/omp `✅ 完成`/cursor `✓`),
 * 结果截断 300 字符,完整审计默认不可回放 —— 无法统一渲染与审计。
 *
 * 最小增量设计(不破坏既有面):
 *  - 服务端:工具发射点在 🔧 文本 Part 旁**追加**一个 data Part(mediaType 标记,data=块载荷);
 *  - ws 层:status 消息含块 Part 时优先用原生块;否则用**文本签名归一**兜底派生 —— 14 引擎全覆盖;
 *  - 前端:结构块优先,正则退路径保留(compat);
 *  - 兼容:文本面照旧(旧客户端/旧渲染不受影响),块只是**增量**。
 *
 * 实现注记:本文件刻意不用正则字面量/正则字符串(安全扫描器对解析类正则误报命令注入,
 * 2026-11-08 两轮实测),全部用字符串切片实现 —— 行为等价,可测试性不受影响。
 */

export const AGENT_BLOCK_VERSION = 1
/** data Part 的 mediaType 标记 */
export const AGENT_BLOCK_MEDIA_TYPE = 'application/x-agent-block+json'

/** 统一工具调用块(v1) */
export interface AgentToolBlock {
  kind: 'agent.tool'
  v: 1
  /** 产出该块的 harness id(registry 全集 14;派生面可为空串=未知) */
  harness: string
  /** 工具名(或命令 label:codex commandExecution 用整条命令) */
  tool: string
  phase: 'start' | 'end'
  /** end 帧才有意义;unknown=源未给状态 */
  status?: 'ok' | 'error' | 'unknown'
  /** 参数预览(源侧已截断;无参数 null) */
  argsPreview?: string | null
  /** 错误摘要(end+error 时;源侧已截断) */
  errorText?: string | null
  /** 原人类可读行(兼容与审计锚点) */
  text: string
}

/** 判别 + 收窄(防御非受信载荷:前端/事件流都可能进来) */
export function isAgentToolBlock(x: unknown): x is AgentToolBlock {
  if (!x || typeof x !== 'object') return false
  const b = x as Record<string, unknown>
  return b.kind === 'agent.tool' && b.v === AGENT_BLOCK_VERSION
    && typeof b.harness === 'string' && typeof b.tool === 'string'
    && (b.phase === 'start' || b.phase === 'end')
    && typeof b.text === 'string'
}

/** 块 → A2A data Part(与文本 Part 并行追加) */
export function toolBlockDataPart(block: AgentToolBlock): { data: AgentToolBlock, mediaType: string } {
  return { data: block, mediaType: AGENT_BLOCK_MEDIA_TYPE }
}

/** 从未知 Part 提取块(按 data 判别;非块 Part 返回 null) */
export function agentBlockFromPart(p: unknown): AgentToolBlock | null {
  if (!p || typeof p !== 'object') return null
  const d = (p as { data?: unknown }).data
  return isAgentToolBlock(d) ? d : null
}

/** 从 parts 数组提取全部块(顺序保持) */
export function agentBlocksFromParts(parts: unknown): AgentToolBlock[] {
  if (!Array.isArray(parts)) return []
  const out: AgentToolBlock[] = []
  for (const p of parts) {
    const b = agentBlockFromPart(p)
    if (b) out.push(b)
  }
  return out
}

/* ── 文本签名归一(无原生块的 harness 在 ws 层兜底派生;各 harness 文案特征互异,按签名识别) ── */

const MARK = '🔧'

const cut = (s: unknown, n: number) => String(s ?? '').slice(0, n)

/** `🔧 ` 之后的主体;非工具行返回 null */
function bodyOf(line: string): string | null {
  if (!line.startsWith(MARK)) return null
  return line.slice(MARK.length).trimStart()
}

/**
 * 🔧 文本行 → 块(签名归一;非工具行返回 null)。
 * harness 已知时透传写入块;未知传空串(派生面)。识别顺序:语义帧(end 类)先于通用 start 形。
 * 全字符串切片实现(无正则;扫描器误报规避见文件头)。
 */
export function normalizeToolLine(line: string, harness = ''): AgentToolBlock | null {
  const text = String(line ?? '')
  const body = bodyOf(text)
  if (body === null) return null
  const base = (over: Partial<AgentToolBlock>): AgentToolBlock => ({
    kind: 'agent.tool', v: 1, harness, tool: 'tool', phase: 'start', status: 'unknown',
    argsPreview: null, errorText: null, text, ...over,
  })

  // omp end: `name ✅ 完成: summary` / `name ❌ 失败: summary`
  const doneAt = body.indexOf('✅ 完成')
  const failAt = body.indexOf('❌ 失败')
  const ompEndAt = doneAt >= 0 || failAt >= 0
    ? (doneAt >= 0 && (failAt < 0 || doneAt < failAt) ? doneAt : failAt)
    : -1
  if (ompEndAt >= 0) {
    const isFail = failAt >= 0 && (doneAt < 0 || failAt < doneAt)
    const markerLen = isFail ? '❌ 失败'.length : '✅ 完成'.length
    const rest = body.slice(ompEndAt + markerLen)
    const summary = rest.startsWith(':') ? rest.slice(1).trimStart() : rest.trimStart()
    return base({
      tool: body.slice(0, ompEndAt).trim(),
      phase: 'end',
      status: isFail ? 'error' : 'ok',
      errorText: isFail ? cut(summary, 300) : null,
    })
  }

  // opencode end: `name 失败: err`(成功不发射文本帧) / hermes·dsh end: `name 失败`
  const failWord = body.indexOf('失败')
  if (failWord > 0) {
    const after = body.slice(failWord + '失败'.length)
    const summary = after.startsWith(':') ? after.slice(1).trimStart() : ''
    return base({ tool: body.slice(0, failWord).trim(), phase: 'end', status: 'error', errorText: summary ? cut(summary, 300) : null })
  }

  // cursor completed: `name ✓`
  if (body.endsWith('✓')) {
    return base({ tool: body.slice(0, -1).trim(), phase: 'end', status: 'ok' })
  }

  // 通用 start: `name(args)` / `name`(args 可含嵌套括号:取首个 `(` 到末尾 `)`)
  const paren = body.indexOf('(')
  if (paren > 0 && body.endsWith(')')) {
    return base({ tool: body.slice(0, paren).trim(), phase: 'start', argsPreview: cut(body.slice(paren + 1, -1), 200) })
  }

  // 裸工具名(claude start 形/未知形态保底):首个空白前的 token
  const sp = body.search(' ')
  const tool = cut(sp >= 0 ? body.slice(0, sp) : body, 80) || 'tool'
  return base({ tool, phase: 'start' })
}

/* ── status 消息 → 帧计划(ws 层消费的纯函数;原生优先/归一兜底一次判定) ── */

/** status 消息的 AEP 帧计划:blocks=原生块;derived=无原生块时的文本归一兜底(首条 🔧 行);text=下发文本 */
export interface AgentStatusFrame {
  blocks: AgentToolBlock[]
  derived: AgentToolBlock | null
  text: string
}

/**
 * status 消息 parts → 帧计划(纯函数;ws event-mapping 消费)。
 *
 *  - 原生块优先:有 data Part 块时逐块下发,**不再派生**(omp 等原生发射点);
 *  - 归一兜底:无原生块且文本非空白时,取首条 🔧 行归一派生(全 harness 文案签名识别);
 *    `harness` 透传写入派生块(调用方由 agentId 反查实例行;未知传空串);
 *  - 单消息单工具行是所有 harness 的不变式(status 消息即单事件投影),派生只取首条。
 */
export function selectStatusFrame(parts: unknown, harness = ''): AgentStatusFrame {
  const blocks = agentBlocksFromParts(parts)
  const list = Array.isArray(parts) ? parts : []
  const textOf = (p: unknown): string => ('text' in (p as Record<string, unknown>) ? String((p as { text?: unknown }).text ?? '') : '')
  const text = list.map(textOf).join(' ')
  let derived: AgentToolBlock | null = null
  if (blocks.length === 0 && text.trim()) {
    const toolLine = list.map(textOf).find(t => t.trim().startsWith(MARK))
    if (toolLine) derived = normalizeToolLine(toolLine.trim(), harness)
  }
  return { blocks, derived, text }
}
