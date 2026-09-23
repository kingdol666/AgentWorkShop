/**
 * 场景 B —— 权限矩阵:owner-only 管理端点对普通成员 403;成员可群聊读/写;非成员 403;遗留 owner=NULL Channel 既不可 join 也不可被成员读,HITL 审批旁路已收口。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 234–310 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 *
 * hitl-registry / hitl-decision 仍在原位 dynamic import(与拆分前同一时机),调用 configureHitlRuntime 的顺序不变; 仅相对路径因文件下沉一层而 +1 级(../server → ../../server),语句本身不变。
 */
import { randomUUID } from 'node:crypto'
import { check, checkThrows, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionB(ctx: GroupChatTestContext): Promise<void> {
  const { manager, db, buildChannel, A, B, C, D, ADMIN } = ctx
  section('B. 权限矩阵:owner-only 管理 vs member 群聊')
  const { channelId, workerId } = await buildChannel('perm')
  // 不变量(不依赖任何读路径副作用):新建 Channel 时 owner 成员行必须已落库
  const ownerRows = manager.groupChat.members.listActiveOwners(channelId)
  check('新建 Channel 即写入 owner 成员行(不靠读路径自愈)', ownerRows.length === 1 && ownerRows[0]!.userId === A.id, `count=${ownerRows.length}`)
  check('owner 成员行 role=owner status=active', ownerRows[0]?.role === 'owner' && ownerRows[0]?.status === 'active')
  const roster = manager.listChannelMembersProjected(channelId)
  check('成员名册立即包含 owner', roster.some(m => m.userId === A.id && m.role === 'owner'), JSON.stringify(roster.map(m => m.userId.slice(0, 6))))
  // owner 开启公开群聊
  manager.requireChannelOwner(channelId, A, 'channel')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })

  check('owner 可见自己 Channel', manager.channelPermissionsOf(channelId, A).isOwner === true)
  // 普通成员加入前后
  checkThrows('非成员读群成员列表 → 403 NOT_CHANNEL_MEMBER', () => manager.requireChannelMember(channelId, B), 'NOT_CHANNEL_MEMBER')
  check('非成员可 join(public+open)', manager.joinChannel(channelId, B).status === 'active')
  check('成员可读群成员列表', manager.requireChannelMember(channelId, B).id === channelId)
  const permsB = manager.channelPermissionsOf(channelId, B)
  check('成员 canPost/canInvokeAgent=true', permsB.canPost && permsB.canInvokeAgent)
  check('成员 canManage=false', permsB.canManage === false)

  // 越权:公开成员不得获得任何 Channel 管理权
  checkThrows('成员改 Channel 设置 → 403', () => manager.requireChannelOwner(channelId, B, 'channel'), 'SCOPE_VIOLATION')
  checkThrows('成员 activate → 403', () => manager.requireChannelOwner(channelId, B, 'channel'), 'SCOPE_VIOLATION')
  checkThrows('成员移除他人成员 → 403', () => manager.removeChannelMember(channelId, B, A.id), 'SCOPE_VIOLATION')
  // @Agent 调用资格 = 群成员 + 群聊开启
  check('成员可 invokeAgent', manager.requireCanInvokeAgent(channelId, B).id === channelId)
  checkThrows('非成员 @Agent → 403', () => manager.requireCanInvokeAgent(channelId, D), 'NOT_CHANNEL_MEMBER')
  // 未开启群聊 → 409
  const { channelId: closedId } = await buildChannel('closed')
  manager.groupChat.members.upsert({ channelId: closedId, userId: B.id, role: 'member', status: 'active' })
  checkThrows('群聊未开启时发言 → 409 CHAT_DISABLED', () => manager.requireChannelChatEnabled(closedId, B), 'CHAT_DISABLED')
  checkThrows('群聊未开启时 join → 409 CHAT_DISABLED', () => manager.requireCanJoinChannel(closedId, C), 'CHAT_DISABLED')
  // 私有 Channel 不可自行加入
  await manager.updateChannel(channelId, { visibility: 'private' })
  checkThrows('private Channel 自行加入 → 403 CHANNEL_PRIVATE', () => manager.requireCanJoinChannel(channelId, C), 'CHANNEL_PRIVATE')
  await manager.updateChannel(channelId, { visibility: 'public' })
  // owner_approve 流程
  await manager.updateChannel(channelId, { joinPolicy: 'owner_approve' })
  const cJoin = manager.joinChannel(channelId, C)
  check('owner_approve 加入 → pending', cJoin.status === 'pending', cJoin.status)
  check('pending 成员不可读群聊', !manager.groupChat.members.isActiveMember(channelId, C.id))
  checkThrows('pending 成员 requireChannelMember → 403', () => manager.requireChannelMember(channelId, C), 'NOT_CHANNEL_MEMBER')
  manager.approveMember(channelId, A, C.id)
  check('owner 批准后成员 active', manager.groupChat.members.isActiveMember(channelId, C.id))
  await manager.updateChannel(channelId, { joinPolicy: 'open' })
  // 遗留 Channel:成员不可读、不可加入(在主导入库内直接造一条 owner=NULL 行)
  const orphanId = randomUUID()
  const nowIso = new Date().toISOString()
  db.prepare(
    `INSERT INTO channels (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace, enabled, owner_user_id, created_at, updated_at)
     VALUES (?, 'orphan-main', '', '', '', NULL, '', 1, NULL, ?, ?)`,
  ).run(orphanId, nowIso, nowIso)
  checkThrows('遗留 Channel 成员读 → 403 FORBIDDEN_LEGACY', () => manager.requireChannelMember(orphanId, B), 'FORBIDDEN_LEGACY')
  checkThrows('遗留 Channel join → 403 FORBIDDEN_LEGACY', () => manager.requireCanJoinChannel(orphanId, B), 'FORBIDDEN_LEGACY')
  check('admin 可读遗留 Channel', manager.requireChannelMember(orphanId, ADMIN).id === orphanId)
  check('遗留 Channel 不出现在公开可发现清单', !manager.listDiscoverableChannels().some(c => c.id === orphanId))
  // v17 收紧:遗留无主 Channel 的 HITL 审批不得再对"任意登录用户"放行
  // (旧 respond.post 只做 getChannelForUser,而它对 owner=NULL 放行任意登录用户 → 审批旁路)
  {
    const { configureHitlRuntime } = await import('../../server/services/workshop/agents/hitl-registry')
    const { assertCanDecideHitlChannel, canDecideHitlChannel } = await import('../../server/services/workshop/agents/hitl-decision')
    configureHitlRuntime(() => manager as never)
    checkThrows(
      '遗留 Channel 普通用户审批 HITL → 403 FORBIDDEN_LEGACY_APPROVAL(审批旁路已收口)',
      () => assertCanDecideHitlChannel(orphanId, B, {}),
      'FORBIDDEN_LEGACY_APPROVAL',
    )
    check('遗留 Channel 审批资格布尔判定为 false', canDecideHitlChannel(orphanId, B, {}) === false)
    check('admin 仍可裁决遗留 Channel', canDecideHitlChannel(orphanId, ADMIN, {}) === true)
    configureHitlRuntime(null)
  }
  void workerId
}
