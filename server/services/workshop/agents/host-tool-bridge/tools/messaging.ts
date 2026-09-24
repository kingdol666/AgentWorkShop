/**
 * 通信面(send_message_to_agent / send_cross_channel_message / list_other_teams /
 * search_other_teams_memory / poll_messages / read_channel_mail / broadcast_message)
 * ——原 dispatchHostTool 对应 case 的函数体按行搬运,闭包捕获的变量改为显式参数。
 */
import type { AgentWorkspace } from '../../agent-interface'
import type { HostToolBridgeContext, HostToolResult, HostToolSessionState } from '../types'
import { partsToText } from '../session'

export async function handleSendMessageToAgent(
  args: Record<string, unknown>,
  state: HostToolSessionState,
  ws: AgentWorkspace,
): Promise<HostToolResult> {
  const toAgentId = args.to_agent_id as string
  const message = args.message as string
  // 回执自动实时:回复(in_reply_to)默认提升为 immediate——
  // 接收方正等待该结果,realtime 路由会把回复直接注入其运行中的会话
  let priority = (args.priority as string | undefined) ?? 'task'
  const metadata: Record<string, unknown> = {}
  if (args.require_reply === true) metadata['x-aw-require-reply'] = 'true'
  let inReplyTo = args.in_reply_to as string | undefined
  // 自动关联兜底:LLM 省略 in_reply_to 时,按待回执上下文盖章
  const replyCtx = state.replyContext
  state.replyContext = null
  if (!inReplyTo && replyCtx && replyCtx.fromId === toAgentId) {
    inReplyTo = replyCtx.messageId
  }
  if (inReplyTo) {
    metadata['x-aw-in-reply-to'] = inReplyTo
    if (priority === 'task') priority = 'immediate'
  }
  metadata['x-aw-msg-priority'] = priority
  const sent = await ws.sendMessage({ toAgentId, parts: [{ text: message }], metadata })
  const triggerNote = inReplyTo
    ? `(回复 ${inReplyTo.slice(0, 8)}…,已实时推送给对方)`
    : metadata['x-aw-require-reply'] === 'true' ? '(已要求对方回复)' : ''
  return { text: `消息 ${sent.messageId.slice(0, 8)}… 已发送给 ${toAgentId}(priority=${priority})${triggerNote}` }
}

export async function handleSendCrossChannelMessage(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const toChannelId = args.to_channel_id as string
  const message = args.message as string
  if (!toChannelId || !message) return { text: '缺少 to_channel_id 或 message', isError: true }
  try {
    const r = await ws.sendCrossChannelMessage({
      toChannelId,
      parts: [{ text: message }],
      requireReply: args.require_reply === true,
      inReplyTo: args.in_reply_to as string | undefined,
    })
    const note = args.require_reply === true ? '(已要求对方 Leader 回复)' : ''
    return { text: `跨 Channel 消息 ${r.messageId.slice(0, 8)}… 已送达 channel「${r.toChannelName}」的 Leader(${r.toLeadAgentId.slice(0, 8)}…)${note}。对方将按你的信息需求处理;其回复会经 mailbox 到达你这里。` }
  }
  catch (err) {
    return { text: `跨 Channel 发送失败: ${err instanceof Error ? err.message : String(err)}(仅 Leader 可跨 Channel 通信)`, isError: true }
  }
}

export async function handleListOtherTeams(ws: AgentWorkspace): Promise<HostToolResult> {
  const teams = await ws.listOtherTeams()
  if (teams.length === 0) return { text: '当前没有其他团队(或均未启用)。' }
  const text = teams.map((t) => {
    const active = t.activeTasks.length > 0
      ? t.activeTasks.map(x => `「${x.title}」(${x.state})`).join('、')
      : '无进行中任务'
    const done = t.recentCompleted.length > 0
      ? t.recentCompleted.map(x => `「${x.title}」`).join('、')
      : '无'
    const mem = t.sharedMemories > 0 ? `共享记忆 ${t.sharedMemories} 条(可检索)` : '暂无共享记忆'
    return `- ${t.name}${t.description ? `(${t.description})` : ''} · lead=${t.leadName ?? '?'} · ${mem}\n  进行中: ${active}\n  近期完成: ${done}\n  channel_id: ${t.channelId}`
  }).join('\n')
  return { text: `其他团队概览:\n${text}\n(需要协作时用 send_cross_channel_message 向对应团队 Leader 发信;查具体知识用 search_other_teams_memory)` }
}

export async function handleSearchOtherTeamsMemory(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const query = (args.query as string | undefined) ?? ''
  if (!query) return { text: '缺少 query', isError: true }
  const rows = await ws.searchOtherTeamsMemory({ query, limit: Number(args.limit ?? 5) })
  if (rows.length === 0) return { text: `其他团队的共享记忆中没有命中「${query}」的内容。` }
  const text = rows.map((r) => {
    // §7.4:来源 Channel + root/task + 时间 + 可见性必须一起呈现,便于 Lead 判断可信来源
    const provenance = [
      `[${r.channelName}]`,
      r.createdAt.slice(0, 10),
      r.visibility ?? 'cross-channel',
      r.taskId ? `task=${r.taskId.slice(0, 8)}` : '',
      r.rootId ? `root=${r.rootId.slice(0, 8)}` : '',
    ].filter(Boolean).join(' · ')
    return `- ${provenance} 「${r.title}」: ${r.content}`
  }).join('\n')
  return { text: `其他团队共享记忆命中 ${rows.length} 条:\n${text}` }
}

export async function handlePollMessages(
  args: Record<string, unknown>,
  state: HostToolSessionState,
  ws: AgentWorkspace,
): Promise<HostToolResult> {
  const limit = (args.limit as number | undefined) ?? 10
  const waitSec = Math.min(180, Math.max(0, Number(args.wait_seconds ?? 0) || 0))
  const msgs = await ws.waitMailbox(limit, waitSec * 1000)
  if (msgs.length === 0) {
    return {
      text: waitSec > 0
        ? `等待 ${waitSec}s 后收件箱仍为空。若此前已有"[实时消息 from X]"注入你的会话,那就是回复本身(无需再轮询);否则可继续处理其他工作,对方回复会以新回合送达。`
        : '收件箱为空(无未消费消息)。等待回复请用 wait_seconds 参数阻塞等待,不要反复空轮询。',
    }
  }
  // 读即取:协作消息(非任务投递)取出即确认;任务指派(assign)不确认
  const ackIds = msgs
    .filter(m => !m.metadata?.['x-aw-task-kind'])
    .map(m => m.messageId)
  if (ackIds.length > 0) await ws.ackMailbox(ackIds)
  const trigger = msgs.find(m =>
    m.metadata?.['x-aw-require-reply'] === 'true'
    && typeof m.metadata?.['x-aw-from-agent'] === 'string')
  if (trigger) {
    state.replyContext = {
      fromId: String(trigger.metadata!['x-aw-from-agent']),
      messageId: trigger.messageId,
    }
  }
  const text = msgs.map((m, i) => {
    const from = m.metadata?.['x-aw-from-agent'] ?? '?'
    const reply = m.metadata?.['x-aw-in-reply-to']
      ? ` (回复 ${String(m.metadata['x-aw-in-reply-to']).slice(0, 8)}…)`
      : ''
    const needReply = m.metadata?.['x-aw-require-reply'] === 'true'
      ? ` [需回复:用 send_message_to_agent 回 ${from},in_reply_to=${m.messageId}]`
      : ''
    const body = m.parts.map(p => 'text' in p ? p.text : '').join(' ')
    return `  [${i + 1}/${msgs.length}] [from ${from}]${needReply}${reply} ${body.slice(0, 2000)}`
  }).join('\n')
  return {
    text:
      `未消费消息(${msgs.length},已读即取):\n${text}`
      + (msgs.length > 1
        ? '\n(收到多条:请按编号逐条处理并逐条回复,不要只回应最后一条或合并敷衍)'
        : ''),
  }
}

export async function handleReadChannelMail(args: Record<string, unknown>, ws: AgentWorkspace): Promise<HostToolResult> {
  const limit = (args.limit as number | undefined) ?? 50
  const agentId = args.agent_id as string | undefined
  const mails = await ws.listMail({ limit, agentId })
  if (mails.length === 0) return { text: 'Channel 无邮件记录(或该成员无往来)' }
  const text = mails.map((m) => {
    const from = m.fromAgentId ?? '(系统)'
    const to = m.toAgentId ?? '(广播)'
    const body = partsToText(m.parts).trim().slice(0, 2000)
    const reply = m.metadata?.['x-aw-in-reply-to']
      ? ` [回复 ${String(m.metadata['x-aw-in-reply-to']).slice(0, 8)}…]`
      : ''
    const label = m.metadata?.['x-aw-task-kind'] === 'assign'
      ? '[任务指派]'
      : m.metadata?.['x-aw-msg-priority'] === 'immediate' ? '[实时]' : '[协作]'
    const state = m.state === 'pending' ? '未读' : m.state === 'consuming' ? '处理中' : '已读'
    return `  ${m.createdAt.slice(11, 19)} ${label} ${from} → ${to} (${state})${reply}: ${body || '(空)'}`
  }).join('\n')
  return { text: `Channel 邮件(${mails.length},倒序;可传 agent_id 查看指定成员信箱):\n${text}` }
}

export async function handleBroadcastMessage(
  args: Record<string, unknown>,
  identity: HostToolBridgeContext['identity'],
  ws: AgentWorkspace,
): Promise<HostToolResult> {
  const message = args.message as string
  const priority = (args.priority as string | undefined) ?? 'task'
  const agents = await ws.listAgents()
  const others = agents.filter(a => a.id !== identity.agentId)
  for (const agent of others) {
    await ws.sendMessage({
      toAgentId: agent.id,
      parts: [{ text: message }],
      metadata: { 'x-aw-msg-priority': priority },
    })
  }
  return { text: `已广播给 ${others.length} 个 agent(priority=${priority})` }
}
