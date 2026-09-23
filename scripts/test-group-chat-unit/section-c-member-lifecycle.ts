/**
 * 场景 C —— 成员生命周期不变量(§13.7):owner 不能 leave;退出/被移除后立即失去访问与审批资格;重新加入 generation+1 且旧审批资格不恢复;策略收紧立即生效、放宽不回溯。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 312–367 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 */
import { check, checkThrows, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionC(ctx: GroupChatTestContext): Promise<void> {
  const { manager, buildChannel, A, B, C } = ctx
  section('C. 成员生命周期不变量(§13.7)')
  const { channelId } = await buildChannel('lifecycle')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1, approvalPolicy: 'any_member' })
  manager.joinChannel(channelId, B)

  checkThrows('owner 不能 leave → 409 OWNER_CANNOT_LEAVE', () => manager.leaveChannel(channelId, A), 'OWNER_CANNOT_LEAVE')
  checkThrows('不能移除 owner → 409 OWNER_CANNOT_REMOVE', () => manager.removeChannelMember(channelId, A, A.id), 'OWNER_CANNOT_REMOVE')

  // 退出 → 立即失去访问与审批资格
  const genBefore = manager.groupChat.members.findOne(channelId, B.id)!.generation
  manager.leaveChannel(channelId, B)
  checkThrows('退出后读群聊 → 403', () => manager.requireChannelMember(channelId, B), 'NOT_CHANNEL_MEMBER')
  checkThrows('退出后审批 → 403', () => manager.requireCanApprove(channelId, B, { policy: 'any_member' }), 'NOT_CHANNEL_MEMBER')

  // 重新加入 → generation+1;旧审批资格(按冻结代数)不恢复
  const rejoin = manager.joinChannel(channelId, B)
  check('重新加入 generation 递增', rejoin.generation === genBefore + 1, `${genBefore} → ${rejoin.generation}`)
  checkThrows(
    '旧请求资格(冻结代数)在重新加入后失效 → 403 APPROVAL_FORBIDDEN',
    () => manager.requireCanApprove(channelId, B, { policy: 'any_member', snapshot: { eligibleUserIds: [B.id], memberGenerations: { [B.id]: genBefore } } }),
    'APPROVAL_FORBIDDEN',
  )
  check('当前代数可审批(any_member)', manager.requireCanApprove(channelId, B, { policy: 'any_member' }).id === channelId)

  // 被移除 → 立即失去
  manager.removeChannelMember(channelId, A, B.id)
  checkThrows('被移除后读群聊 → 403', () => manager.requireChannelMember(channelId, B), 'NOT_CHANNEL_MEMBER')

  // owner_only:成员不可审批
  await manager.updateChannel(channelId, { approvalPolicy: 'owner_only' })
  manager.joinChannel(channelId, C)
  checkThrows('owner_only 下成员审批 → 403 APPROVAL_FORBIDDEN', () => manager.requireCanApprove(channelId, C, { policy: 'owner_only' }), 'APPROVAL_FORBIDDEN')
  check('owner_only 下 owner 可审批', manager.requireCanApprove(channelId, A, { policy: 'owner_only' }).id === channelId)
  // 棘轮语义(§13.4 创建时资格 ∩ 当前资格):
  //  (a) 收紧立即生效 —— 请求创建时 any_member,当前 owner_only → 成员被拒
  await manager.updateChannel(channelId, { approvalPolicy: 'any_member' })
  check('any_member 下成员可审批(基线)', manager.requireCanApprove(channelId, C, { policy: 'any_member' }).id === channelId)
  await manager.updateChannel(channelId, { approvalPolicy: 'owner_only' })
  checkThrows(
    '当前策略收紧为 owner_only → 历史 any_member 请求的成员审批立即被拒(收紧生效)',
    () => manager.requireCanApprove(channelId, C, { policy: 'any_member' }),
    'APPROVAL_FORBIDDEN',
  )
  //  (b) 放宽不回溯 —— 请求创建时 owner_only,当前 any_member → 成员仍被拒
  await manager.updateChannel(channelId, { approvalPolicy: 'any_member' })
  checkThrows(
    '创建时为 owner_only → 当前放宽为 any_member 后成员仍被拒(放宽不回溯)',
    () => manager.requireCanApprove(channelId, C, { policy: 'owner_only' }),
    'APPROVAL_FORBIDDEN',
  )
  check('放宽不回溯:owner 始终可审批', manager.requireCanApprove(channelId, A, { policy: 'owner_only' }).id === channelId)
  await manager.updateChannel(channelId, { approvalPolicy: 'any_member' })
}
