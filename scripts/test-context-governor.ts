/**
 * 上下文治理环测试(假 RPC 客户端,零真实子进程):
 * 70% 门控 / get_state 复查 / compact→compaction_end 等待 / legacy 降级 /
 * 压缩事件分支 harvest / 被动 usage 透出 / 总开关与最小间隔。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-context-governor.ts
 */
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

type Frame = Record<string, unknown>

/** 假 omp RPC 客户端:协议面仿真(命令应答/事件订阅/被动 usage) */
class FakeOmpClient {
  alive = true
  streaming = false
  statsOk = true
  compactOk = true
  usageTokens = 0
  contextWindow = 1000
  autoCompact: boolean | null = null
  sent: Array<Record<string, unknown>> = []
  private listeners = new Set<(e: Frame) => void>()

  onEvent(fn: (e: Frame) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(e: Frame): void {
    for (const fn of this.listeners) fn(e)
  }

  async send(cmd: Record<string, unknown>): Promise<{ success: boolean, data?: unknown }> {
    this.sent.push(cmd)
    const type = cmd.type as string
    if (type === 'get_session_stats') {
      if (!this.statsOk) throw new Error('omp RPC 命令失败: get_session_stats 未知命令')
      return { success: true, data: { contextUsage: { tokens: this.usageTokens, contextWindow: this.contextWindow, percent: this.usageTokens / this.contextWindow } } }
    }
    if (type === 'get_state') {
      return { success: true, data: { isStreaming: this.streaming, isCompacting: false, sessionId: 'sess-1', model: { contextWindow: this.contextWindow } } }
    }
    if (type === 'compact') {
      if (!this.compactOk) throw new Error('omp RPC 命令失败: compact 未知命令')
      const summary = '压缩摘要:完成任务A;未竟:验证B'
      setTimeout(() => {
        this.emit({ type: 'compaction_end', result: { summary, tokensBefore: this.usageTokens, tokensAfter: 30000 }, reason: 'manual' })
      }, 10)
      return { success: true, data: {} }
    }
    if (type === 'set_auto_compaction') {
      this.autoCompact = cmd.enabled as boolean
      return { success: true }
    }
    return { success: true }
  }

  getContextUsage(): { tokens: number, contextWindow: number, percent: number } {
    return { tokens: this.usageTokens, contextWindow: this.contextWindow, percent: this.usageTokens / this.contextWindow }
  }

  setContextWindow(n: number): void {
    this.contextWindow = n
  }

  onHostToolCall(_fn: unknown): void {}
}

/** 装配:真实 OmpRpcAgentImpl + 注入假客户端/假 workspace */
function assemble(): { impl: OmpRpcAgentImpl, client: FakeOmpClient, harvested: Array<Record<string, unknown>> } {
  const impl = new OmpRpcAgentImpl({ agentId: 'a1', name: 'A', role: 'worker', channelId: 'ch1' })
  const client = new FakeOmpClient()
  const harvested: Array<Record<string, unknown>> = []
  const box = impl as unknown as Record<string, unknown>
  box.client = client
  box.workspace = {
    recordSessionMemory: async (i: Record<string, unknown>) => {
      harvested.push(i)
    },
  }
  return { impl, client, harvested }
}

const gate = (impl: OmpRpcAgentImpl, reason = 'test'): Promise<void> =>
  (impl as unknown as Record<string, unknown>).contextGate(reason) as Promise<void>

process.env.AW_OMP_COMPACT_THRESHOLD = '0.7'
process.env.AW_OMP_COMPACT_MIN_INTERVAL_MS = '300000'
process.env.AW_OMP_COMPACT_WAIT_MS = '5000'

console.log('\n--- 门控基础路径 ---')
{
  process.env.AW_OMP_COMPACT_ENABLED = '1'
  const { impl, client, harvested } = assemble()
  client.usageTokens = 500 // 50% < 70%
  await gate(impl)
  check('低于阈值不触发 compact', !client.sent.some(c => c.type === 'compact'), `sent=${client.sent.map(c => c.type)}`)

  client.usageTokens = 850 // 85% ≥ 70%
  await gate(impl)
  check('达阈值发起 compact', client.sent.some(c => c.type === 'compact'))
  check('compact 前先复查 get_state', client.sent.indexOf('get_state') !== -1 || client.sent.some(c => c.type === 'get_state'))
  await new Promise(r => setTimeout(r, 50))
  check('compaction_end 摘要 harvest 入库', harvested.length === 1 && harvested[0]!.summary === '压缩摘要:完成任务A;未竟:验证B', JSON.stringify(harvested))
  check('harvest 携带 token 元信息', harvested[0]!.tokensBefore === 850 && harvested[0]!.tokensAfter === 30000)

  // 最小间隔:压缩后立即再 gate 不应二次 compact
  client.usageTokens = 950
  await gate(impl)
  check('最小间隔防振荡(不再 compact)', client.sent.filter(c => c.type === 'compact').length === 1)
}

console.log('\n--- 安全防线 ---')
{
  // get_state 复查:流式中绝不压缩
  const { impl, client } = assemble()
  client.usageTokens = 900
  client.streaming = true
  await gate(impl)
  check('isStreaming=true 时不发起 compact', !client.sent.some(c => c.type === 'compact'))

  // 总开关
  process.env.AW_OMP_COMPACT_ENABLED = '0'
  const g2 = assemble()
  g2.client.usageTokens = 900
  await gate(g2.impl)
  check('总开关关闭不压缩', !g2.client.sent.some(c => c.type === 'compact'))
  process.env.AW_OMP_COMPACT_ENABLED = '1'

  // legacy 降级:compact 未知命令 → 标记后不再尝试
  const g3 = assemble()
  g3.client.usageTokens = 900
  g3.client.compactOk = false
  await gate(g3.impl)
  const box3 = g3.impl as unknown as Record<string, unknown>
  check('未知命令 → legacy 标记', box3.compactLegacy === true)
  g3.client.usageTokens = 980
  await gate(g3.impl)
  check('legacy 后续回合不再发 compact', g3.client.sent.filter(c => c.type === 'compact').length === 1)
}

console.log('\n--- 事件分支与状态透出 ---')
{
  const { impl, client, harvested } = assemble()
  // 回合中途原生压缩(compaction_start/end 事件):不污染事件流 + harvest
  const map = (impl as unknown as Record<string, (e: Frame) => Frame[]>).mapOmpEvent.bind(impl)
  const startOut = map({ type: 'compaction_start' }, undefined)
  const endOut = map({ type: 'compaction_end', result: { summary: '原生阈值压缩摘要', tokensBefore: 900 }, reason: 'threshold' }, undefined)
  const settledOut = map({ type: 'agent_settled' }, undefined)
  check('压缩事件映射为空(不污染 AgentEvent 流)', startOut.length === 0 && endOut.length === 0 && settledOut.length === 0)
  await new Promise(r => setTimeout(r, 20))
  check('原生压缩摘要同样 harvest', harvested.some(h => h.summary === '原生阈值压缩摘要'))

  // 被动 usage 透出 getContextStats
  client.usageTokens = 420
  const stats = (impl as unknown as Record<string, () => unknown>).getContextStats()
  check('getContextStats 透出用量与占比', JSON.stringify(stats) === JSON.stringify({ usedTokens: 420, contextWindow: 1000, percent: 0.42, compacting: false }), JSON.stringify(stats))

  // 双路去重:同摘要 60s 内只入库一次
  map({ type: 'compaction_end', result: { summary: '原生阈值压缩摘要' }, reason: 'threshold' }, undefined)
  await new Promise(r => setTimeout(r, 20))
  check('同摘要双达去重(60s 窗口)', harvested.filter(h => h.summary === '原生阈值压缩摘要').length === 1)

  // onTurnSettled 复用 gate(自守卫不抛错)
  client.usageTokens = 100
  await impl.onTurnSettled()
  check('onTurnSettled 低用量安全返回', true)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
