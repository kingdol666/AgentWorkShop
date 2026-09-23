/**
 * 场景 G —— 白名单投影(§13.1):非管理者快照不含 config/token/workspace/内部 mailbox 与 task artifacts 载荷。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 532–567 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 */
import { check, projectManagementSnapshotForMember, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionG(ctx: GroupChatTestContext): Promise<void> {
  const { manager, buildChannel, B } = ctx
  section('G. 白名单投影(§13.1:成员拿不到管理面字段)')
  const { channelId } = await buildChannel('proj')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1, workspace: 'D:\\secret-workspace' })
  manager.joinChannel(channelId, B)
  manager.sendChatMessage(channelId, B, { text: 'hello', clientMessageId: 'cm-proj' })

  const memberSnapshot = manager.chatSnapshotOf(channelId, B)
  const json = JSON.stringify(memberSnapshot)
  check('成员快照不含 workspace 路径', !json.includes('secret-workspace'), '')
  check('成员快照不含 agent config', !json.includes('"config"'))
  check('成员快照不含 token 字段', !json.includes('"token"'))
  check('成员快照 canManage=false 且无管理面 agents', memberSnapshot.canManage === false && memberSnapshot.agents === undefined)
  check('成员快照含群成员名册', memberSnapshot.members.some(m => m.userId === B.id))
  check('成员快照含群聊历史', memberSnapshot.chatMessages.length === 1 && memberSnapshot.chatMessages[0]!.text === 'hello')
  // 管理快照投影:非管理者不得拿到内部 mailbox/task payload
  const raw = {
    channelId,
    channel: manager.deps.repos.channels.findById(channelId),
    agents: manager.deps.repos.channelAgents.listByChannel(channelId).map(m => ({
      agentId: m.id, name: m.name, role: m.role, harness: m.harness, enabled: m.enabled, config: JSON.parse(m.configJson), token: m.token,
    })),
    tasks: [{ id: 't1', title: 'x', state: 'COMPLETED', artifacts: [{ name: 'deliverable', parts: [{ text: 'SECRET-PAYLOAD' }] }], history: [] }],
    messages: [{ messageId: 'm1', parts: [{ text: 'internal-mailbox-SECRET' }] }],
    queue: [],
  }
  const projected = projectManagementSnapshotForMember(raw as unknown as Record<string, unknown>)
  const pjson = JSON.stringify(projected)
  check('管理面投影剔除 agent config', !pjson.includes('"config"'))
  check('管理面投影剔除 agent token', !pjson.includes('"token"'))
  check('管理面投影剔除内部 mailbox 载荷', !pjson.includes('internal-mailbox-SECRET'))
  check('管理面投影剔除 task artifacts payload', !pjson.includes('SECRET-PAYLOAD'))
  check('管理面投影保留 task 摘要(id/state)', pjson.includes('"id":"t1"') && pjson.includes('"state":"COMPLETED"'))
}
