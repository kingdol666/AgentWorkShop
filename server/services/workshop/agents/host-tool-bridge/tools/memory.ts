/**
 * 记忆面(search_memory / save_memory)——原 dispatchHostTool 两个 case 的函数体按行搬运。
 * session 作用域:sessionId 由工具桥会话态注入(平台 run/supervise 回合设置);
 *   scope='session' 只检当前会话作用域行;save 默认落当前会话作用域(可显式关)。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { HostToolResult } from '../types'

type RecallScope = 'auto' | 'private' | 'shared' | 'session'
type CrossScope = 'line' | 'product' | 'global'
const CROSS_SCOPES: CrossScope[] = ['line', 'product', 'global']

export async function handleSearchMemory(args: Record<string, unknown>, ws: AgentWorkspace, sessionId?: string | null): Promise<HostToolResult> {
  const query = args.query as string
  const scope = (args.scope as RecallScope | CrossScope | undefined) ?? 'auto'
  // WP-A4:line/product/global = 跨 Channel 共享经验档(同 owner 授权在 manager 层)
  if (CROSS_SCOPES.includes(scope as CrossScope)) {
    return searchCrossChannel(args, ws, scope as CrossScope)
  }
  const recallScope = scope as RecallScope
  if (recallScope === 'session' && !sessionId) {
    return { text: '当前回合没有 session 上下文,scope=session 不可用;请改用 auto/private/shared。' }
  }
  const snippets = await ws.recallMemory({ query, scope: recallScope, limit: args.limit as number | undefined, sessionId })
  if (snippets.length === 0) {
    return { text: `记忆检索无命中(query="${query}", scope=${scope})。可尝试更换关键词或放宽 scope。` }
  }
  const lines = snippets.map((s) => {
    // §7.4:每条记忆标注来源 Channel / task / session / 可见性,便于判断可信来源
    // WP-A3:经验行额外标注作用域/极性/生命周期(scope=line:x · outcome=positive · status=validated)
    const isExperience = s.kind === 'experience'
    const provenance = [
      s.source,
      s.kind,
      `score=${s.score}`,
      s.visibility ?? '',
      isExperience && s.scopeKind ? `scope=${s.scopeKind}${s.scopeKey ? `:${s.scopeKey}` : ''}` : '',
      isExperience && s.outcome ? `outcome=${s.outcome}` : '',
      isExperience && s.status ? `status=${s.status}` : '',
      s.channelId ? `channel=${s.channelId.slice(0, 8)}` : '',
      s.taskId ? `task=${s.taskId.slice(0, 8)}` : '',
      s.sessionId ? `session=${s.sessionId.slice(0, 8)}` : '',
      s.rootId ? `root=${s.rootId.slice(0, 8)}` : '',
      s.createdAt ? s.createdAt.slice(0, 16).replace('T', ' ') : '',
    ].filter(Boolean).join(' · ')
    return `  [${provenance}] ${s.title}\n    ${s.content}`
  })
  // 召回度量透出(2026-10-05 记忆治理最小版):hit/miss 计数随每次检索可见
  const { memoryRecallStats } = await import('@/server/services/workshop/runtime/memory/recall')
  const st = memoryRecallStats()
  return { text: `记忆检索结果(${snippets.length} 条, scope=${scope};召回度量 hits=${st.hits}/misses=${st.misses}/命中率=${st.hitRate}):\n${lines.join('\n')}` }
}

export async function handleSaveMemory(args: Record<string, unknown>, ws: AgentWorkspace, sessionId?: string | null): Promise<HostToolResult> {
  const title = args.title as string
  const content = args.content as string
  const scope = args.scope as 'private' | 'shared' | 'line' | 'global'
  // session_scope=false 显式声明频道级记忆;默认(缺省/true)落当前会话作用域
  const sessionScope = args.session_scope === undefined ? true : args.session_scope === true
  const sessionIdToStamp = sessionScope ? (sessionId ?? null) : null
  // WP-A4:跨频道经验必须带证据锚点(任务 id),无锚点自述不得进入共享经验层
  const taskId = typeof args.task_id === 'string' && args.task_id.trim() ? args.task_id.trim() : null
  let saved: { scope: 'private' | 'shared' | 'line' | 'global', dedupKey: string }
  try {
    saved = await ws.saveMemory({
      title,
      content,
      importance: args.importance as number | undefined,
      scope,
      dedupKey: args.dedup_key as string | undefined,
      sessionId: sessionIdToStamp,
      taskId,
    })
  }
  catch (err) {
    // 策略/绑定/证据门拒绝:原文回给 Agent(可据此改档位重试),不伪装成功
    return { text: `记忆写入被拒绝: ${err instanceof Error ? err.message : String(err)}`, isError: true } as HostToolResult
  }
  if (scope === 'line' || scope === 'global') {
    return { text: `已沉淀${scope === 'line' ? '同产线共享经验(跨频道可检索)' : '全局共享经验(跨频道可检索)'}: "${title}"(status=candidate,待验证后晋级; dedupKey=${saved.dedupKey})` }
  }
  const where = scope === 'shared' ? 'Channel 公共记忆(全员可检索)' : '本人私有记忆'
  const sessionNote = sessionIdToStamp
    ? `;已标注会话作用域(${sessionIdToStamp.slice(0, 8)}…,scope=session 检索可命中)`
    : ';频道级(跨会话可见)'
  return { text: `已沉淀到${where}: "${title}"(dedupKey=${saved.dedupKey})${sessionNote}` }
}

/** 跨 Channel 共享经验检索(WP-A4):同 owner 频道的 experience 行,只读 */
async function searchCrossChannel(args: Record<string, unknown>, ws: AgentWorkspace, scope: CrossScope): Promise<HostToolResult> {
  if (!ws.searchSharedExperience) {
    return { text: '跨频道经验检索在当前运行时不可用(workspace 未接线)。', isError: true } as HostToolResult
  }
  const query = args.query as string
  const scopeKey = typeof args.scope_key === 'string' && args.scope_key.trim() ? args.scope_key.trim() : undefined
  if (scope === 'product' && !scopeKey) {
    return { text: 'scope=product 需要 scope_key(产品 id),例如 scope_key="prod-..."。' }
  }
  const rows = await ws.searchSharedExperience({ query, scope, scopeKey, limit: args.limit as number | undefined })
  if (rows.length === 0) {
    return { text: `跨频道经验检索无命中(query="${query}", scope=${scope}${scopeKey ? `:${scopeKey}` : ''})。仅同 owner 频道且 status=active/validated 的经验可命中。` }
  }
  const lines = rows.map((r) => {
    const provenance = [
      'cross-channel',
      r.channelName,
      `scope=${r.scopeKind}${r.scopeKey ? `:${r.scopeKey}` : ''}`,
      `outcome=${r.outcome}`,
      `status=${r.status}`,
      r.taskId ? `task=${r.taskId.slice(0, 8)}` : '',
      r.createdAt.slice(0, 16).replace('T', ' '),
    ].filter(Boolean).join(' · ')
    return `  [${provenance}] ${r.title}\n    ${r.content}`
  })
  return { text: `跨频道经验检索结果(${rows.length} 条, scope=${scope}):\n${lines.join('\n')}` }
}
