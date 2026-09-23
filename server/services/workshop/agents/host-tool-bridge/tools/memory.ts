/**
 * 记忆面(search_memory / save_memory)——原 dispatchHostTool 两个 case 的函数体按行搬运。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { HostToolResult } from '../types'

export async function handleSearchMemory(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const query = args.query as string
  const scope = (args.scope as 'auto' | 'private' | 'shared' | undefined) ?? 'auto'
  const snippets = await ws.recallMemory({ query, scope, limit: args.limit as number | undefined })
  if (snippets.length === 0) {
    return { text: `记忆检索无命中(query="${query}", scope=${scope})。可尝试更换关键词或放宽 scope。` }
  }
  const lines = snippets.map(s =>
    `  [${s.source}·${s.kind}·score=${s.score}] ${s.title}\n    ${s.content}`,
  )
  return { text: `记忆检索结果(${snippets.length} 条, scope=${scope}):\n${lines.join('\n')}` }
}

export async function handleSaveMemory(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const title = args.title as string
  const content = args.content as string
  const scope = args.scope as 'private' | 'shared'
  const saved = await ws.saveMemory({
    title,
    content,
    importance: args.importance as number | undefined,
    scope,
    dedupKey: args.dedup_key as string | undefined,
  })
  const where = scope === 'shared' ? 'Channel 公共记忆(全员可检索)' : '本人私有记忆'
  return { text: `已沉淀到${where}: "${title}"(dedupKey=${saved.dedupKey})` }
}
