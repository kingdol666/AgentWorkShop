/**
 * 场景 J —— 人类权限上下文传播合同(§13.3):合同解析宽容 + 交集只收紧不放大;工具判定(管理面/高危写/只读);端到端接线 —— 群成员 @Agent → 作用域落到该 Agent → 委派继续传播 → 工具调用被拒;全链路关联 ID 对照。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 607–737 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 *
 * 同一 tick 内的断言与 60ms 收口等待是刻意时序,原样保留,不得插入额外 await。
 */
import {
  check,
  checkRejects,
  checkToolAgainstScope,
  intersectWorkshopPermissionScope,
  MANAGEMENT_TOOL_NAMES,
  parseWorkshopPermissionScope,
  section,
  WORKSHOP_PERMISSION_SCOPE_HEADER,
} from './lib'
import type { ChatReplyRow, GroupChatTestContext } from './lib'

export async function runSectionJ(ctx: GroupChatTestContext): Promise<void> {
  const { manager, db, buildChannel, A, B } = ctx
  section('J. 人类权限上下文传播合同(§13.3)')
  // ① 合同本身:解析宽容 + 交集只收紧不放大
  const valid = parseWorkshopPermissionScope(JSON.stringify({
    invocationId: 'inv-1', requesterUserId: B.id, channelId: 'ch-1',
    scope: 'channel_member', canManageChannel: false, canUseHighRiskTools: false,
  }))
  check('合同:合法作用域可解析', valid?.scope === 'channel_member' && valid?.requesterUserId === B.id)
  check('合同:非法 JSON → null(不抛错)', parseWorkshopPermissionScope('{oops') === null)
  check('合同:缺 channelId → null', parseWorkshopPermissionScope(JSON.stringify({ scope: 'system' })) === null)
  check('合同:未知档位降级为最保守 channel_member',
    parseWorkshopPermissionScope(JSON.stringify({ channelId: 'c', scope: 'god_mode' }))?.scope === 'channel_member')
  check('合同:低档位不得声明管理能力(能力位被强制 false)',
    parseWorkshopPermissionScope(JSON.stringify({ channelId: 'c', scope: 'channel_member', canManageChannel: true }))?.canManageChannel === false)

  const owner = parseWorkshopPermissionScope(JSON.stringify({
    invocationId: 'inv-owner', requesterUserId: A.id, channelId: 'ch-1',
    scope: 'channel_owner', canManageChannel: true, canUseHighRiskTools: true,
  }))!
  const member = valid!
  const narrowed = intersectWorkshopPermissionScope(owner, member)
  check('交集:档位取更低者', narrowed.scope === 'channel_member')
  check('交集:能力位取与(不得放大)', narrowed.canManageChannel === false && narrowed.canUseHighRiskTools === false)
  check('交集:归属字段保留发起者', narrowed.requesterUserId === A.id && narrowed.invocationId === 'inv-owner')
  const widened = intersectWorkshopPermissionScope(member, owner)
  check('交集:交换顺序不得放大(channel_member ∩ owner 仍为 member)',
    widened.scope === 'channel_member' && widened.canManageChannel === false)
  check('交集:无子作用域 → 原样返回', intersectWorkshopPermissionScope(member, null).scope === 'channel_member')

  // ② 工具判定:管理面 / 高危写 / 只读
  const mScope = member
  const denyMgmt = checkToolAgainstScope(mScope, 'dispatch_task')
  check('判定:成员作用域拒绝管理面工具(dispatch_task)',
    denyMgmt.allowed === false && denyMgmt.reason === 'MANAGEMENT_TOOL_DENIED')
  const denyRisk = checkToolAgainstScope(mScope, 'dcw_control')
  check('判定:成员作用域拒绝高危写工具(dcw_control)',
    denyRisk.allowed === false && denyRisk.reason === 'HIGH_RISK_TOOL_DENIED')
  check('判定:成员作用域拒绝配方写入(recipe_update)',
    checkToolAgainstScope(mScope, 'recipe_update').allowed === false
    && checkToolAgainstScope(mScope, 'recipe_update').reason === 'HIGH_RISK_TOOL_DENIED')
  check('判定:成员作用域拒绝配方回退(recipe_rollback)',
    checkToolAgainstScope(mScope, 'recipe_rollback').allowed === false
    && checkToolAgainstScope(mScope, 'recipe_rollback').reason === 'HIGH_RISK_TOOL_DENIED')
  check('判定:只读工具放行(dcw_read)', checkToolAgainstScope(mScope, 'dcw_read').allowed === true)
  check('判定:owner 作用域放行管理面工具', checkToolAgainstScope(owner, 'dispatch_task').allowed === true)
  check('判定:无作用域(系统/agent 自发)沿用既有授权',
    checkToolAgainstScope(null, 'dispatch_task').allowed === true)
  check('判定:管理面清单复用既有 LEAD_ONLY 集合(不是新造的)',
    MANAGEMENT_TOOL_NAMES.has('reassign_task') && MANAGEMENT_TOOL_NAMES.has('create_team_agent'))

  // ③ 端到端接线:群成员 @Agent → 作用域落到该 Agent → 委派继续传播 → 工具调用被拒
  const { channelId, workerId, leadId } = await buildChannel('chat-perm')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, B)
  const workerName = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.id === workerId)!.name
  const sent = manager.sendChatMessage(channelId, B, { text: `@${workerName} 请处理`, clientMessageId: 'cm-perm' })
  const deliveryId = sent.deliveries[0]!.deliveryId

  // 同一 tick 内断言(不 await 任何"让出事件循环"的操作):此刻还没有任何 runtime 回合跑过
  await checkRejects('接线:成员触发期间该 Agent 调管理面工具 → 403 MANAGEMENT_TOOL_DENIED',
    () => manager.invokeHostTool({ agentId: workerId, tool: 'dispatch_task' }), 'MANAGEMENT_TOOL_DENIED')
  await checkRejects('接线:成员触发期间该 Agent 调高危写工具 → 403 HIGH_RISK_TOOL_DENIED',
    () => manager.invokeHostTool({ agentId: workerId, tool: 'dcw_control' }), 'HIGH_RISK_TOOL_DENIED')

  // 委派传播:worker(持成员作用域)→ lead
  const delegated = await manager.sendA2A(channelId, workerId, {
    toAgentId: leadId,
    parts: [{ text: '请复核' }],
  })
  const delegatedScope = parseWorkshopPermissionScope(delegated.metadata[WORKSHOP_PERMISSION_SCOPE_HEADER])
  check('委派:作用域随 A2A 消息继续传播', delegatedScope != null)
  check('委派:传播后仍为成员档(不得升格)', delegatedScope?.scope === 'channel_member'
  && delegatedScope?.canManageChannel === false && delegatedScope?.canUseHighRiskTools === false)
  check('委派:关联 ID 保持同一次人类调用(invocationId=deliveryId)',
    delegatedScope?.invocationId === deliveryId, `scope.invocationId=${delegatedScope?.invocationId} deliveryId=${deliveryId}`)
  check('委派:发起者归属仍是提问成员', delegatedScope?.requesterUserId === B.id)

  // 被委派方(lead)同样受限:委派不能把成员权限洗成系统权限
  await checkRejects('委派:被委派 Agent 继承限制 → 403 MANAGEMENT_TOOL_DENIED',
    () => manager.invokeHostTool({ agentId: leadId, tool: 'dispatch_task' }), 'MANAGEMENT_TOOL_DENIED')

  // 二次委派继续收紧(lead → worker)
  const second = await manager.sendA2A(channelId, leadId, { toAgentId: workerId, parts: [{ text: '再确认' }] })
  const secondScope = parseWorkshopPermissionScope(second.metadata[WORKSHOP_PERMISSION_SCOPE_HEADER])
  check('二次委派:作用域不丢且不放大', secondScope?.scope === 'channel_member'
  && secondScope?.canManageChannel === false && secondScope?.invocationId === deliveryId)

  // 收口后解除:模拟 Agent 回复结束该人类调用(mock runtime 会走 platformReply)
  await new Promise(r => setTimeout(r, 60))
  let allowedAfterReply = true
  try {
    await manager.invokeHostTool({ agentId: workerId, tool: 'dispatch_task' })
  }
  catch (err) {
    allowedAfterReply = (err as { code?: string }).code !== 'MANAGEMENT_TOOL_DENIED'
  }
  check('收口:人类调用结束后不再长期限制该 Agent(作用域已清除)', allowedAfterReply)

  // ④ 全链路关联 ID 对照证据(§12「verifier 提供 chatMessageId、deliveryId、
  //    mailboxMessageId、nativeRequestId 对照证据」)
  {
    const ledger = manager.groupChat.chat.listDeliveries(sent.message.id)
    const row = ledger[0]!
    check('对照链:投递台账的 chatMessageId 指回群聊消息', row.chatMessageId === sent.message.id)
    check('对照链:投递台账回填 mailboxMessageId(非空)',
      typeof row.mailboxMessageId === 'string' && row.mailboxMessageId.length > 0, String(row.mailboxMessageId))
    // mailbox 消息必须真实存在于 messages 表(事实源,而不是只写在台账字段里)
    const mailboxRow = db.prepare('SELECT id, channel_id FROM messages WHERE id = ?').get(row.mailboxMessageId) as
      { id: string, channel_id: string } | undefined
    check('对照链:mailboxMessageId 在 messages 表真实存在', mailboxRow?.id === row.mailboxMessageId)
    check('对照链:mailbox 消息属于同一 Channel', mailboxRow?.channel_id === channelId)
    // 投递台账的主键即作用域里的 invocationId(同一次人类调用,可交叉核对)
    check('对照链:deliveryId = scope.invocationId', row.id === deliveryId)
    // Agent 回复落到群聊事实表时必须携带 sourceChatMessageId 与 requesterUserId(不靠"最近发言者")
    // 直接读事实表(chat_messages):这是证据本身,而不是某个投影视图的口径
    const replyRows = db.prepare(
      `SELECT id, source_chat_message_id AS sourceChatMessageId, requester_user_id AS requesterUserId,
              mentions_json AS mentionsJson
       FROM chat_messages WHERE channel_id = ? AND sender_type = 'agent'
         AND source_chat_message_id = ?`,
    ).all(channelId, sent.message.id) as Array<ChatReplyRow>
    check('对照链:Agent 回复携带 sourceChatMessageId', replyRows.length === 1, `命中 ${replyRows.length} 条`)
    check('对照链:Agent 回复携带 requesterUserId=提问者', replyRows[0]?.requesterUserId === B.id,
      String(replyRows[0]?.requesterUserId))
    const replyMentions = JSON.parse(replyRows[0]?.mentionsJson ?? '[]') as Array<{ type: string, id: string }>
    check('对照链:Agent 回复自动 @提问者(mention 稳定 ID)',
      replyMentions.some(m => m.type === 'user' && m.id === B.id), JSON.stringify(replyMentions))
  }
}
