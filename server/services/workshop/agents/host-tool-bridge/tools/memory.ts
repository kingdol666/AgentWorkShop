/**
 * 记忆面(search_memory / save_memory)——原 dispatchHostTool 两个 case 的函数体按行搬运。
 * session 作用域:sessionId 由工具桥会话态注入(平台 run/supervise 回合设置);
 *   scope='session' 只检当前会话作用域行;save 默认落当前会话作用域(可显式关)。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { HostToolResult } from '../types'

export async function handleSearchMemory(args: Record<string, unknown>, ws: AgentWorkspace, sessionId?: string | null): Promise<HostToolResult> {
  const query = args.query as string
  const scope = (args.scope as 'auto' | 'private' | 'shared' | 'session' | undefined) ?? 'auto'
  if (scope === 'session' && !sessionId) {
    return { text: '当前回合没有 session 上下文,scope=session 不可用;请改用 auto/private/shared。' }
  }
  const snippets = await ws.recallMemory({ query, scope, limit: args.limit as number | undefined, sessionId })
  if (snippets.length === 0) {
    return { text: `记忆检索无命中(query="${query}", scope=${scope})。可尝试更换关键词或放宽 scope。` }
  }
  const lines = snippets.map((s) => {
    // §7.4:每条记忆标注来源 Channel / task / session / 可见性,便于判断可信来源
    const provenance = [
      s.source,
      s.kind,
      `score=${s.score}`,
      s.visibility ?? '',
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
  const scope = args.scope as 'private' | 'shared'
  // session_scope=false 显式声明频道级记忆;默认(缺省/true)落当前会话作用域
  const sessionScope = args.session_scope === undefined ? true : args.session_scope === true
  const sessionIdToStamp = sessionScope ? (sessionId ?? null) : null
  const saved = await ws.saveMemory({
    title,
    content,
    importance: args.importance as number | undefined,
    scope,
    dedupKey: args.dedup_key as string | undefined,
    sessionId: sessionIdToStamp,
  })
  const where = scope === 'shared' ? 'Channel 公共记忆(全员可检索)' : '本人私有记忆'
  const sessionNote = sessionIdToStamp
    ? `;已标注会话作用域(${sessionIdToStamp.slice(0, 8)}…,scope=session 检索可命中)`
    : ';频道级(跨会话可见)'
  return { text: `已沉淀到${where}: "${title}"(dedupKey=${saved.dedupKey})${sessionNote}` }
}
