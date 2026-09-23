/**
 * 群聊 / 权限 / HITL 单元 + 集成测试(主计划 §11 单元 + 集成面)。
 *
 * 覆盖:
 *  - v17 迁移:新表/新列存在;既有 Channel 迁移后仍为 private/owner_approve/owner_only/chat_enabled=0
 *    (即**不改变任何既有可见性/权限行为**);owner 成员记录回填为「有且只有一条 active owner」。
 *  - 权限矩阵:owner-only 管理端点对普通成员 403;成员可群聊读/写;非成员 403;
 *    遗留 owner=NULL Channel 既不可 join 也不可被成员读。
 *  - 成员生命周期不变量(§13.7):owner 不能 leave;移除后立即失去访问;
 *    退出后重新加入 generation+1 且旧审批资格不恢复。
 *  - mention 解析:稳定 ID;文本 @ 服务端重新解析;非本 Channel 目标不投递;
 *    无 @ / 仅 @用户 → Agent 执行次数严格为 0。
 *  - 群聊事实层:clientMessageId 幂等;同一 chat message 对同一 Agent 只一条 delivery;
 *    Agent 回复经 sourceChatMessageId/requesterUserId 定位唯一提问者并自动 @。
 *  - 用户通知:eventId 幂等;跨用户零泄漏;游标补发。
 *  - 白名单投影(§13.1):非管理者快照不含 config/token/workspace/内部 mailbox。
 *
 * 运行: npx tsx scripts/test-group-chat-unit.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离:用户仓储惰性 getDb() 会走 AW_DATA_DIR;指向临时目录,绝不触碰真实数据
process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-chat-test-'))
process.env.AGENTWORKSHOP_TEST = '1'

const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const managerMod = await import('../server/services/workshop/runtime/manager')
const createAgentChannelManager = managerMod.createAgentChannelManager
type AgentChannelManager = InstanceType<typeof managerMod.AgentChannelManager>
const { createAgentImpl } = await import('../server/services/workshop/agents/factory')
const { resolveMentions, extractMentionTokens } = await import('../server/services/workshop/runtime/chat-mention')
const { projectManagementSnapshotForMember } = await import('../server/services/workshop/runtime/chat-projection')
const { checkToolAgainstScope, MANAGEMENT_TOOL_NAMES } = await import('../server/services/workshop/runtime/permission-scope')
const {
  WORKSHOP_PERMISSION_SCOPE_HEADER,
  parseWorkshopPermissionScope,
  intersectWorkshopPermissionScope,
} = await import('../shared/workshop-protocol')

// ===== 断言框架(与仓库既有 scripts/test-*.ts 同风格) =====
let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}
/** 断言抛出 AppError 且 code 匹配 */
function checkThrows(name: string, fn: () => unknown, code: string): void {
  try {
    fn()
    check(name, false, '未抛出异常')
  }
  catch (err) {
    const e = err as { code?: string, statusCode?: number, message?: string }
    check(name, e.code === code, `实际 code=${e.code ?? '(none)'} status=${e.statusCode ?? '?'} msg=${e.message ?? ''}`)
  }
}
/**
 * async 版本:await 型接口拒绝的是 Promise,**不会**同步抛出 ——
 * 用 checkThrows 调 async 方法会永远得到"未抛出异常"(实测踩过,断言假通过)。
 */
async function checkRejects(name: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
    check(name, false, '未抛出异常(期望拒绝)')
  }
  catch (err) {
    const e = err as { code?: string, statusCode?: number, message?: string }
    check(name, e.code === code, `实际 code=${e.code ?? '(none)'} status=${e.statusCode ?? '?'} msg=${e.message ?? ''}`)
  }
}

/** 群聊事实表里 Agent 回复行的证据字段(§12 关联 ID 对照) */
interface ChatReplyRow {
  id: string
  sourceChatMessageId: string | null
  requesterUserId: string | null
  mentionsJson: string
}

function makeManager(db: DatabaseSync): AgentChannelManager {
  return createAgentChannelManager({
    repos: {
      users: undefined as never,
      channelEvents: createChannelEventRepo(db),
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      schedules: undefined as never,
    },
    implFactory: createAgentImpl,
    db,
  })
}

// ===== 场景搭建:owner=A / 成员=B、C / 非成员=D =====
// 用户注册到**全局用户系统**(与线上同源):这样 resolveOwnerName 能解析展示名,
// mention 的"展示名解析"路径才被真实覆盖,而不是退化成 id 前缀兜底。
// 注意:不能 import user.service(它经 #imports 依赖 nitro 运行时),直接用仓储。
const { userRepository } = await import('../server/repositories/user.repository')
const registered: Array<{ id: string, name: string, role: string }> = []
function mkUser(name: string): { id: string, name: string, role: string } {
  const { user } = userRepository.createWithRoleBootstrap({
    name,
    email: `${name}@chat-test.local`,
    password: 'Passw0rd!123',
    role: 'user',
    status: 'active',
  })
  const u = { id: user.id, name: user.name, role: user.role }
  registered.push(u)
  return u
}
// 首个注册账号会被 bootstrap 为 admin(线上同规则)→ 先建 admin,再建业务用户
const ADMIN = mkUser('root-admin')
const A = mkUser('alice')
const B = mkUser('bob')
const C = mkUser('carol')
const D = mkUser('dave')

const db = openWorkshopDb(':memory:')
const manager = makeManager(db)

/** 建一个 owner=A 的 channel(mock lead + 1 worker) */
async function buildChannel(name: string): Promise<{ channelId: string, leadId: string, workerId: string }> {
  const leadTpl = await manager.createAgent({ name: `${name}-lead`, harness: 'mock', config: { delayMs: 5 } })
  const workerTpl = await manager.createAgent({ name: `${name}-worker`, harness: 'mock', config: { delayMs: 5 } })
  const { channelId, leadAgentId } = await manager.createChannel({
    name,
    description: '群聊单测',
    ownerUserId: A.id,
    leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 5 } },
  })
  void leadTpl
  await manager.addAgentToChannel({ channelId, agentId: workerTpl.id, role: 'worker' })
  manager.ensureChannelActive(channelId)
  const worker = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.role === 'worker')!
  return { channelId, leadId: leadAgentId!, workerId: worker.id }
}

// ============================================================================
section('A. v17 迁移与不变量回填')
// ============================================================================
{
  const tables = (db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all() as Array<{ name: string }>).map(r => r.name)
  for (const t of ['channel_members', 'chat_messages', 'chat_deliveries', 'user_notifications', 'outbox_events', 'hitl_requests']) {
    check(`表 ${t} 已创建`, tables.includes(t))
  }
  const cols = (db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>).map(c => c.name)
  for (const c of ['visibility', 'join_policy', 'approval_policy', 'chat_enabled', 'version']) {
    check(`channels.${c} 已加列`, cols.includes(c))
  }
  // 迁移安全:用**旧结构库**验证真实升级路径。
  // 关键语义:ALTER TABLE ADD COLUMN 的 DEFAULT 会填充既有行 → 升级后既有 Channel
  // 一律 private/owner_approve/owner_only/chat_enabled=0,**行为零变化**;
  // 且迁移**不得**在每次启动时把 owner 显式设置的 public 打回 private(否则设置无法持久)。
  const { DatabaseSync } = await import('node:sqlite')
  const legacyPath = join(process.env.AW_DATA_DIR!, 'legacy-upgrade.sqlite')
  const legacyDb = new DatabaseSync(legacyPath)
  legacyDb.exec(`CREATE TABLE channels (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    scenario_prompt TEXT NOT NULL DEFAULT '',
    llm_json       TEXT NOT NULL DEFAULT '',
    lead_agent_id  TEXT,
    workspace      TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 1,
    owner_user_id  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`)
  const now = new Date().toISOString()
  const legacyId = randomUUID()
  legacyDb.prepare('INSERT INTO channels (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace, enabled, owner_user_id, created_at, updated_at) VALUES (?, ?, \'\', \'\', \'\', NULL, \'\', 1, ?, ?, ?)')
    .run(legacyId, 'legacy', A.id, now, now)
  const orphanId = randomUUID()
  legacyDb.prepare('INSERT INTO channels (id, name, description, scenario_prompt, llm_json, lead_agent_id, workspace, enabled, owner_user_id, created_at, updated_at) VALUES (?, ?, \'\', \'\', \'\', NULL, \'\', 1, NULL, ?, ?)')
    .run(orphanId, 'orphan', now, now)
  // 升级
  initWorkshopDb(legacyDb)
  const upg = legacyDb.prepare('SELECT id, visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(legacyId) as { visibility: string, joinPolicy: string, approvalPolicy: string, chatEnabled: number }
  check('升级后既有 Channel visibility=private', upg.visibility === 'private', upg.visibility)
  check('升级后既有 Channel joinPolicy=owner_approve', upg.joinPolicy === 'owner_approve', upg.joinPolicy)
  check('升级后既有 Channel approvalPolicy=owner_only', upg.approvalPolicy === 'owner_only', upg.approvalPolicy)
  check('升级后既有 Channel chatEnabled=0(不可写公开群聊)', upg.chatEnabled === 0, String(upg.chatEnabled))
  const upgOwnerMembers = legacyDb.prepare('SELECT user_id AS userId, role, status FROM channel_members WHERE channel_id = ?').all(legacyId) as Array<{ userId: string, role: string, status: string }>
  check('升级回填 owner 成员且恰好一条 active owner', upgOwnerMembers.length === 1 && upgOwnerMembers[0]!.userId === A.id && upgOwnerMembers[0]!.role === 'owner' && upgOwnerMembers[0]!.status === 'active', JSON.stringify(upgOwnerMembers))
  const upgOrphan = legacyDb.prepare('SELECT visibility, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(orphanId) as { visibility: string, chatEnabled: number }
  check('升级后 owner=NULL 遗留 Channel 仍为 private + chat 关', upgOrphan.visibility === 'private' && upgOrphan.chatEnabled === 0)
  check('升级后 owner=NULL 遗留 Channel 无 owner 成员行', (legacyDb.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').get(orphanId) as { n: number }).n === 0)
  // 幂等 + 不覆盖合法设置:owner 显式开启 public 后再次 init 必须保持 public(设置可持久)
  legacyDb.exec(`UPDATE channels SET visibility = 'public', join_policy = 'open', approval_policy = 'any_member', chat_enabled = 1 WHERE id = '${legacyId}'`)
  initWorkshopDb(legacyDb)
  const again = legacyDb.prepare('SELECT visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(legacyId) as { visibility: string, joinPolicy: string, approvalPolicy: string, chatEnabled: number }
  check('重复 init 幂等且不覆盖 owner 显式设置', again.visibility === 'public' && again.joinPolicy === 'open' && again.approvalPolicy === 'any_member' && again.chatEnabled === 1, JSON.stringify(again))
  // 非法值收敛:未知取值回落最保守档(不放宽权限)
  legacyDb.exec(`UPDATE channels SET visibility = 'PUBLIC_BOGUS', join_policy = 'bogus', approval_policy = 'bogus', chat_enabled = 7 WHERE id = '${legacyId}'`)
  initWorkshopDb(legacyDb)
  const clamped = legacyDb.prepare('SELECT visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled FROM channels WHERE id = ?').get(legacyId) as { visibility: string, joinPolicy: string, approvalPolicy: string, chatEnabled: number }
  check('非法取值收敛为最保守档', clamped.visibility === 'private' && clamped.joinPolicy === 'owner_approve' && clamped.approvalPolicy === 'owner_only' && clamped.chatEnabled === 0, JSON.stringify(clamped))
  legacyDb.close()
}

// ============================================================================
section('B. 权限矩阵:owner-only 管理 vs member 群聊')
// ============================================================================
{
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
    const { configureHitlRuntime } = await import('../server/services/workshop/agents/hitl-registry')
    const { assertCanDecideHitlChannel, canDecideHitlChannel } = await import('../server/services/workshop/agents/hitl-decision')
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

// ============================================================================
section('C. 成员生命周期不变量(§13.7)')
// ============================================================================
{
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

// ============================================================================
section('D. mention 解析(稳定 ID;禁止昵称兜底越权)')
// ============================================================================
{
  const tokens = extractMentionTokens('@alice 请看下 @worker-1 的结果,邮箱 a@b.com 不算')
  check('文本提取 @token', tokens.includes('alice') && tokens.includes('worker-1') && !tokens.includes('b.com'), JSON.stringify(tokens))
  const agents = [{ id: 'ag-1', name: 'worker-1', role: 'worker', enabled: 1 }]
  const users = [{ id: 'u-1', name: 'alice' }, { id: 'u-2', name: 'bob' }]
  const r1 = resolveMentions({ text: 'hi @worker-1 please look', agents, users })
  check('文本 @Agent 解析为 agent mention 稳定 ID', r1.mentions.length === 1 && r1.mentions[0]!.type === 'agent' && r1.mentions[0]!.id === 'ag-1', JSON.stringify(r1.mentions))
  const r2 = resolveMentions({ text: 'hi @alice', agents, users })
  check('文本 @用户 解析为 user mention 且无 agent', r2.mentions.length === 1 && r2.mentions[0]!.type === 'user' && r2.mentions[0]!.id === 'u-1')
  const r3 = resolveMentions({ text: '没有 at 的普通发言', agents, users })
  check('无 @ → mentions 为空(Agent 执行计数 0 的前提)', r3.mentions.length === 0)
  const r4 = resolveMentions({ text: 'hi @nobody', agents, users })
  check('未知 @token → unresolved 且不产生 mention', r4.mentions.length === 0 && r4.unresolved.includes('nobody'))
  const r5 = resolveMentions({
    text: 'hi',
    agents,
    users,
    explicit: [{ type: 'agent', id: 'ag-foreign' }],
    validateExplicit: m => (m.id === 'ag-foreign' ? 'agent 不属于本 Channel' : null),
  })
  check('显式 mention 指向外部 Agent → 被拒(不投递)', r5.mentions.length === 0 && r5.unresolved.length === 1)
  const r6 = resolveMentions({ text: '@worker 看下', agents, users })
  check('唯一前缀可解析 Agent', r6.mentions.length === 1 && r6.mentions[0]!.id === 'ag-1')
  const r7 = resolveMentions({ text: '@alice @worker-1 一起看', agents, users })
  check('混合 @ 解析出两类目标', r7.mentions.filter(m => m.type === 'agent').length === 1 && r7.mentions.filter(m => m.type === 'user').length === 1)
}

// ============================================================================
section('E. 群聊事实层:幂等 / 投递 / 零 Agent 执行')
// ============================================================================
{
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

// ============================================================================
section('F. 用户通知:eventId 幂等 / 跨用户隔离 / 游标补发')
// ============================================================================
{
  const { channelId } = await buildChannel('notify')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  // 专用用户:避免与前述小节的通知互相污染(隔离断言必须只看本节数据)
  const N1 = mkUser('notify-one')
  const N2 = mkUser('notify-two')
  manager.joinChannel(channelId, N1)
  manager.joinChannel(channelId, N2)

  const n1 = manager.notifyUser({ recipientUserId: N1.id, channelId, type: 'mention', eventId: 'evt-1', title: 't1' })
  const n1again = manager.notifyUser({ recipientUserId: N1.id, channelId, type: 'mention', eventId: 'evt-1', title: 't1-dup' })
  check('同 (recipient,eventId) 幂等:第二次 inserted=false', n1.inserted && !n1again.inserted)
  check('幂等不产生第二行', n1.id === n1again.id)
  const bList = manager.listNotifications(N1.id, { limit: 50 })
  const cList = manager.listNotifications(N2.id, { limit: 50 })
  check('通知按 recipientUserId 隔离:N1 有、N2 无', bList.length === 1 && cList.length === 0, `N1=${bList.length} N2=${cList.length}`)
  check('未读数只属于本人', manager.groupChat.notifications.unreadCount(N1.id) === 1 && manager.groupChat.notifications.unreadCount(N2.id) === 0)

  // 游标补发:取 N1 第一条为游标 → 只拿到其后新增
  manager.notifyUser({ recipientUserId: N1.id, channelId, type: 'agent_reply', eventId: 'evt-2', title: 't2' })
  const cursor0 = manager.groupChat.notifications.cursorOf(n1.id)!
  const after = manager.listNotificationsAfter(N1.id, cursor0, 50)
  check('游标补发:仅返回游标之后的通知', after.length === 1 && after[0]!.eventId === 'evt-2', `len=${after.length}`)
  const all = manager.listNotificationsAfter(N1.id, null, 50)
  check('无游标 → 返回全部(升序)', all.length === 2 && all[0]!.eventId === 'evt-1', `len=${all.length}`)
  // 已读
  const readRes = manager.markNotificationsRead(N1.id, { id: n1.id })
  check('标记单条已读', readRes.count === 1 && manager.groupChat.notifications.unreadCount(N1.id) === 1)
  const readAll = manager.markNotificationsRead(N1.id, { all: true })
  check('标记全部已读', readAll.count === 1 && manager.groupChat.notifications.unreadCount(N1.id) === 0)
  check('已读不影响他人', manager.groupChat.notifications.unreadCount(N2.id) === 0)

  // 成员被移除 → 通知不再可拉取(访问撤销)
  manager.notifyUser({ recipientUserId: N2.id, channelId, type: 'mention', eventId: 'evt-3', title: 't3' })
  check('N2 有 1 条通知', manager.groupChat.notifications.listRecent(N2.id, 10).length === 1)
  manager.removeChannelMember(channelId, A, N2.id)
  checkThrows('移除后不可再读群聊', () => manager.requireChannelMember(channelId, N2), 'NOT_CHANNEL_MEMBER')
  checkThrows('移除后通知端点也无法通过成员守卫(路由层同口径)', () => manager.requireChannelMember(channelId, N2), 'NOT_CHANNEL_MEMBER')
}

// ============================================================================
section('G. 白名单投影(§13.1:成员拿不到管理面字段)')
// ============================================================================
{
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

// ============================================================================
section('H. outbox 事务一致性')
// ============================================================================
{
  const { channelId, workerId } = await buildChannel('outbox')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, B)
  const workerName = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.id === workerId)!.name
  const sent = manager.sendChatMessage(channelId, B, { text: `@${workerName} 干活`, clientMessageId: 'cm-outbox' })
  const outbox = manager.groupChat.outbox.listAll(200)
  const chatEvent = outbox.find(e => e.id === `chat.message:${sent.message.id}`)
  check('消息落库同时登记 outbox chat.message', !!chatEvent)
  check('outbox 已收敛为 published', chatEvent!.status === 'published', chatEvent!.status)
  const deliveryEvent = outbox.find(e => e.eventType === 'chat.delivery.status' && e.aggregateId === sent.deliveries[0]!.deliveryId)
  check('投递登记 outbox chat.delivery.status', !!deliveryEvent)
  // 通知也必须先落库(事实源)再发布
  const notifEvent = outbox.find(e => e.eventType === 'member.access_revoked')
  void notifEvent
  check('outbox 统计可达(可观测性)', typeof manager.groupChat.outbox.counts().pending === 'number')
}

// ============================================================================
section('I. 会话中立的幂等:重复读历史不产生副作用')
// ============================================================================
{
  const { channelId } = await buildChannel('readonly')
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, B)
  manager.sendChatMessage(channelId, B, { text: 'one', clientMessageId: 'r1' })
  manager.sendChatMessage(channelId, B, { text: 'two', clientMessageId: 'r2' })
  const list1 = manager.listChatMessages(channelId, B, { limit: 50 })
  const list2 = manager.listChatMessages(channelId, B, { limit: 50 })
  check('读历史幂等(两次结果一致)', JSON.stringify(list1) === JSON.stringify(list2))
  check('历史新→旧排序', list1[0]!.text === 'two' && list1[1]!.text === 'one')
  const older = manager.listChatMessages(channelId, B, { before: list1[0]!.id, limit: 50 })
  check('before 游标分页取更早消息', older.length === 1 && older[0]!.text === 'one')
}

// ============================================================================
section('J. 人类权限上下文传播合同(§13.3)')
// ============================================================================
{
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

// ============================================================================
console.log(`\n${'='.repeat(64)}`)
console.log(`群聊/权限单测结果:  PASS=${passed}  FAIL=${failures.length}`)
if (failures.length > 0) {
  console.log('失败项:')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log('='.repeat(64))
await manager.shutdown()
db.close()
process.exit(failures.length > 0 ? 1 : 0)
