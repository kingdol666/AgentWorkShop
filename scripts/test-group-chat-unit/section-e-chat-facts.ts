/**
 * 场景 E —— 群聊事实层:无 @ / 仅 @用户 → Agent 执行次数严格为 0;@Agent 每个唯一 Agent 恰好一条 delivery;clientMessageId 幂等;Agent 回复定位唯一提问者并自动 @。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 399–487 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 */
import { check, checkThrows, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionE(ctx: GroupChatTestContext): Promise<void> {
  const { manager, buildChannel, B, C, D } = ctx
  section('E. 群聊事实层:幂等 / 投递 / 零 Agent 执行')
  const { channelId, workerId } = await buildChannel('chat')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, B)
  manager.joinChannel(channelId, C)

  // ① 普通发言(无 @)→ Agent 执行次数严格为 0
  const plain = manager.sendChatMessage(channelId, B, { text: '大家好,今天进度如何?', clientMessageId: 'cm-plain' })
  check('普通发言:0 条 delivery', plain.deliveries.length === 0, JSON.stringify(plain.deliveries))
  check('普通发言:chat_deliveries 计数 0', manager.groupChat.chat.countDeliveries(channelId) === 0)
  check('普通发言:agent 消息计数 0', manager.groupChat.chat.countBySenderType(channelId, 'agent') === 0)

  // ② @用户 → 群消息 + 目标用户通知,Agent 执行次数仍为 0
  const atUser = manager.sendChatMessage(channelId, B, { text: '@carol 你看下这个', clientMessageId: 'cm-user' })
  check('@用户:0 条 delivery', atUser.deliveries.length === 0)
  check('@用户:解析为 user mention 稳定 ID', atUser.mentions.some(m => m.type === 'user' && m.id === C.id), JSON.stringify(atUser.mentions))
  const cNotifs = manager.groupChat.notifications.listRecent(C.id, 10)
  check('@用户:C 收到定向通知', cNotifs.some(n => n.type === 'mention' && n.chatMessageId === atUser.message.id))
  check('@用户:B(发送者)不给自己发通知', !manager.groupChat.notifications.listRecent(B.id, 10).some(n => n.type === 'mention' && n.chatMessageId === atUser.message.id))
  check('@用户:仍 0 条 delivery', manager.groupChat.chat.countDeliveries(channelId) === 0)

  // ③ @Agent → 每个唯一 Agent 恰好一条 delivery
  const workerName = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.id === workerId)!.name
  const atAgent = manager.sendChatMessage(channelId, B, { text: '@不存在的同事 请 @chat-worker 分析', clientMessageId: 'cm-agent' })
  check('混合 @(未知名 + Agent 名)→ 只投递可解析目标且报告 unresolved', atAgent.deliveries.length === 1 && atAgent.unresolvedMentions.includes('不存在的同事'), JSON.stringify(atAgent.unresolvedMentions))
  const atAgent2 = manager.sendChatMessage(channelId, B, { text: `@${workerName} 请分析`, clientMessageId: 'cm-agent2' })
  check('@Agent:解析出 agent mention', atAgent2.mentions.some(m => m.type === 'agent' && m.id === workerId), JSON.stringify(atAgent2.mentions))
  check('@Agent:恰好 1 条 delivery', atAgent2.deliveries.length === 1 && atAgent2.deliveries[0]!.agentId === workerId, JSON.stringify(atAgent2.deliveries))
  check('@Agent:投递状态 delivered', atAgent2.deliveries[0]!.status === 'delivered', atAgent2.deliveries[0]!.status)
  const deliveries = manager.groupChat.chat.listDeliveries(atAgent2.message.id)
  check('同一消息同 Agent 只有一条投递台账', deliveries.length === 1)
  // 同消息重复 @ 同一 Agent(文本 + 显式 mention)→ 仍只一条 delivery
  const dupMention = manager.sendChatMessage(channelId, B, {
    text: `@${workerName} 再看一次`,
    mentions: [{ type: 'agent', id: workerId }],
    clientMessageId: 'cm-agent-dup',
  })
  check('文本与显式 mention 指向同一 Agent → 去重为 1 条 delivery', dupMention.deliveries.length === 1)
  void atAgent

  // ④ clientMessageId 幂等:重复提交只产生一条消息、不重复投递
  const before = manager.groupChat.chat.count(channelId)
  const retry = manager.sendChatMessage(channelId, B, { text: `@${workerName} 请分析`, clientMessageId: 'cm-agent2' })
  check('重复 clientMessageId → duplicates=true', retry.duplicates === true)
  check('重复 clientMessageId → 消息 id 与首次一致', retry.message.id === atAgent2.message.id)
  check('重复 clientMessageId → 消息总数不增', manager.groupChat.chat.count(channelId) === before)
  check('重复 clientMessageId → 投递数不增(仍 1)', manager.groupChat.chat.listDeliveries(atAgent2.message.id).length === 1)
  check('重复 clientMessageId → 通知数不增', manager.groupChat.notifications.listRecent(C.id, 50).filter(n => n.type === 'mention').length === 1)

  // ⑤ 非成员发言 / 越权
  checkThrows('非成员发言 → 403', () => manager.sendChatMessage(channelId, D, { text: 'hi' }), 'NOT_CHANNEL_MEMBER')
  checkThrows('空文本 → 400', () => manager.sendChatMessage(channelId, B, { text: '   ' }), 'BAD_REQUEST')
  checkThrows('replyToId 跨 Channel → 400', () => manager.sendChatMessage(channelId, B, { text: 'x', replyToId: 'no-such-msg' }), 'BAD_REPLY_TARGET')
  const foreign = manager.sendChatMessage(channelId, B, {
    text: 'hi',
    mentions: [{ type: 'agent', id: 'agent-not-here' }],
    clientMessageId: 'cm-foreign',
  })
  check('显式 mention 外部 Agent → 不投递且记入 unresolvedMentions', foreign.deliveries.length === 0 && foreign.unresolvedMentions.length === 1, JSON.stringify(foreign.unresolvedMentions))

  // ⑥ Agent 回复关联:唯一提问者 + 自动 @ + replyTo 链
  const reply = manager.agentReplyToChat({
    channelId,
    agentId: workerId,
    agentName: workerName,
    text: '分析完成:结论 A',
    sourceChatMessageId: atAgent2.message.id,
    requesterUserId: B.id,
  })
  check('Agent 回复写入群聊(sender=agent)', !!reply && reply.senderType === 'agent', JSON.stringify(reply?.senderType))
  check('Agent 回复 replyToId = 源消息 id', reply!.replyToId === atAgent2.message.id)
  check('Agent 回复 sourceChatMessageId 保留', reply!.sourceChatMessageId === atAgent2.message.id)
  check('Agent 回复 requesterUserId = 唯一提问者(非最近发言者)', reply!.requesterUserId === B.id)
  check('Agent 回复自动 @提问者', reply!.mentions.some(m => m.type === 'user' && m.id === B.id), JSON.stringify(reply!.mentions))
  check('提问者收到 agent_reply 通知', manager.groupChat.notifications.listRecent(B.id, 50).some(n => n.type === 'agent_reply' && n.chatMessageId === reply!.id))
  check('投递台账收敛为 consumed', manager.groupChat.chat.findDelivery(atAgent2.message.id, workerId)!.status === 'consumed')

  // 并发交错:两个提问者各 @ 同一 Agent → 回复各归其人(不串)
  const q1 = manager.sendChatMessage(channelId, B, { text: `@${workerName} 问题一`, clientMessageId: 'cm-q1' })
  const q2 = manager.sendChatMessage(channelId, C, { text: `@${workerName} 问题二`, clientMessageId: 'cm-q2' })
  const r1 = manager.agentReplyToChat({ channelId, agentId: workerId, agentName: workerName, text: '答一', sourceChatMessageId: q1.message.id, requesterUserId: B.id })
  const r2 = manager.agentReplyToChat({ channelId, agentId: workerId, agentName: workerName, text: '答二', sourceChatMessageId: q2.message.id, requesterUserId: C.id })
  check('并发提问回复不串人:r1 → B', r1!.requesterUserId === B.id && r1!.mentions[0]!.id === B.id)
  check('并发提问回复不串人:r2 → C', r2!.requesterUserId === C.id && r2!.mentions[0]!.id === C.id)
  check('两条回复分别关联各自源消息', r1!.sourceChatMessageId === q1.message.id && r2!.sourceChatMessageId === q2.message.id)
}
