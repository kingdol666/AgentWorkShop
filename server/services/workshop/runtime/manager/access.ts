/**
 * ManagerAccess —— 用户面、owner/member 守卫、群成员管理
 * (拆分层,承 ManagerWorkspace)
 */
import { ManagerWorkspace } from './workspace'
import type { ActingUser } from './types'
import type { ChannelMemberRepo } from '../../db/channel-member.repo'
import type { ChannelMemberRow, ChannelRow, UserRow } from '../../db/database'
import type { ChatMessageRepo } from '../../db/chat-message.repo'
import type { HitlRequestRepo } from '../../db/hitl-request.repo'
import type { NotificationRepo } from '../../db/notification.repo'
import type { OutboxRepo } from '../../db/outbox.repo'
import { AppError } from '../../../../utils/errors'
import { audit } from '../../ops/ops'
import { createChannelMemberRepo } from '../../db/channel-member.repo'
import { createChatMessageRepo } from '../../db/chat-message.repo'
import { createHitlRequestRepo } from '../../db/hitl-request.repo'
import { createNotificationRepo } from '../../db/notification.repo'
import { createOutboxRepo } from '../../db/outbox.repo'
import { log } from './helpers'

export abstract class ManagerAccess extends ManagerWorkspace {
  /** 注册用户(name 唯一 → 409;token 仅此一次返回) */
  registerUser(name: string): UserRow {
    const trimmed = name.trim()
    if (!trimmed) throw new AppError(400, 'BAD_REQUEST', '用户名不能为空')
    if (this.deps.repos.users.getByName(trimmed)) {
      throw new AppError(409, 'USER_EXISTS', `用户名已存在: ${trimmed}`)
    }
    return this.deps.repos.users.create(trimmed)
  }

  /** 用户 token → 用户(无效 → 401;REST resolveUser / WS sub 共用) */
  getUserByToken(token: string): UserRow | null {
    return this.deps.repos.users.getByToken(token)
  }

  /**
   * 资源 owner 守卫:owner 匹配放行;NULL owner(遗留公共数据)只读——
   * 写操作一律拒绝(FORBIDDEN_LEGACY,提示归属缺失);他人资源 → 403。
   */
  requireOwned(ownerUserId: string | null | undefined, userId: string, what: string): void {
    if (ownerUserId === null || ownerUserId === undefined) {
      throw new AppError(403, 'FORBIDDEN_LEGACY', `${what} 为遗留公共数据(无归属),禁止变更`)
    }
    if (ownerUserId !== userId) {
      throw new AppError(403, 'SCOPE_VIOLATION', `${what} 不属于当前用户`)
    }
  }

  /**
   * 模板/资源可写守卫(v10 权限系统):
   * - 内置模板(owner NULL)→ 任何人(含 admin)不可修改删除(TEMPLATE_BUILTIN);
   * - 属主 → 放行;
   * - admin → 越权放行(最高管理权限);
   * - 其余 → 403 SCOPE_VIOLATION。
   */
  requireWritable(ownerUserId: string | null | undefined, user: ActingUser, what: string): void {
    if (ownerUserId === null || ownerUserId === undefined) {
      throw new AppError(403, 'TEMPLATE_BUILTIN', `${what} 为内置公共模板,不可修改或删除`)
    }
    if (ownerUserId === user.id) return
    if (user.role === 'admin') return
    throw new AppError(403, 'SCOPE_VIOLATION', `${what} 不属于当前用户`)
  }

  /**
   * 模板可读守卫:属主 / public / admin 放行;他人 private → 403(不存在语义由调用方先判)。
   */
  requireTemplateReadable(tpl: { ownerUserId: string | null, visibility: string }, user: ActingUser, what: string): void {
    if (tpl.ownerUserId === null || tpl.ownerUserId === user.id) return
    if (tpl.visibility === 'public') return
    if (user.role === 'admin') return
    throw new AppError(403, 'SCOPE_VIOLATION', `${what} 不属于当前用户且未公开`)
  }

  /** channel 读取(已认证用户可见本人 + 遗留公共;不存在 → 404) */
  getChannelForUser(channelId: string, userId: string): ChannelRow {
    const channel = this.requireChannelRow(channelId)
    if (channel.ownerUserId !== null && channel.ownerUserId !== userId) {
      throw new AppError(403, 'SCOPE_VIOLATION', 'channel 不属于当前用户')
    }
    return channel
  }

  // ===== v17:owner / member 双守卫(主计划 §4)=====
  //
  // 语义边界(不可混淆,混用会把普通成员提升为管理员):
  //   getChannelForUser      仅读、owner 或遗留公共(owner=NULL)—— 保持原状,不放宽
  //   requireChannelOwner    所有 Channel 配置与 Agent/Task/Plugin/Memory/删除管理
  //   requireChannelMember   仅群聊读取/发言/WS 订阅/HITL 可见性
  //   requireCanJoinChannel  加入资格(visibility/joinPolicy/chatEnabled)
  //   requireCanInvokeAgent  @Agent 调用资格(v1 固定 members_only)
  //   requireCanApprove      HITL 审批资格(审批策略 + 成员代数)

  /** v17 群聊层仓储惰性装配(旧测试脚手架只传 11 个 repo;仓储都是 db 的纯工厂,按需构造即可) */
  protected get channelMemberRepo(): ChannelMemberRepo {
    const r = this.deps.repos.channelMembers
    if (r) return r
    const built = createChannelMemberRepo(this.deps.db)
    this.deps.repos.channelMembers = built
    return built
  }

  protected get chatMessageRepo(): ChatMessageRepo {
    const r = this.deps.repos.chatMessages
    if (r) return r
    const built = createChatMessageRepo(this.deps.db)
    this.deps.repos.chatMessages = built
    return built
  }

  protected get notificationRepo(): NotificationRepo {
    const r = this.deps.repos.notifications
    if (r) return r
    const built = createNotificationRepo(this.deps.db)
    this.deps.repos.notifications = built
    return built
  }

  protected get outboxRepo(): OutboxRepo {
    const r = this.deps.repos.outbox
    if (r) return r
    const built = createOutboxRepo(this.deps.db)
    this.deps.repos.outbox = built
    return built
  }

  protected get hitlRequestRepo(): HitlRequestRepo {
    const r = this.deps.repos.hitlRequests
    if (r) return r
    const built = createHitlRequestRepo(this.deps.db)
    this.deps.repos.hitlRequests = built
    return built
  }

  /** v17 群聊层仓储的公开访问面(路由/服务层用;避免各处重复断言 private) */
  get groupChat(): {
    members: ChannelMemberRepo
    chat: ChatMessageRepo
    notifications: NotificationRepo
    outbox: OutboxRepo
    hitl: HitlRequestRepo
  } {
    return {
      members: this.channelMemberRepo,
      chat: this.chatMessageRepo,
      notifications: this.notificationRepo,
      outbox: this.outboxRepo,
      hitl: this.hitlRequestRepo,
    }
  }

  /**
   * 取 Channel 行;不存在 → 404 `NOT_FOUND`。
   *
   * 单一入口:此前 `channel 不存在: ${channelId}` 这段 404 构造在本文件里手写了 5 处
   * (owner/member/join 守卫、能力视图、getChannel),错误码与文案一旦漂移,
   * 客户端就无法统一按 code 处理"频道没了"。
   */
  requireChannelRow(channelId: string): ChannelRow {
    const channel = this.deps.repos.channels.findById(channelId)
    if (!channel) throw new AppError(404, 'NOT_FOUND', `channel 不存在: ${channelId}`)
    return channel
  }

  /**
   * owner 管理守卫:所有 Channel 配置 / Agent / Task / Plugin / Memory / 删除操作。
   * 语义与既有各路由的 getChannelForUser + requireWritable 组合完全一致
   * (owner 放行 / admin 越权放行 / owner=NULL 遗留 → FORBIDDEN_LEGACY / 他人 → 403),
   * **不放宽**任何既有管理权限。
   */
  requireChannelOwner(channelId: string, user: ActingUser, what = 'channel'): ChannelRow {
    const channel = this.requireChannelRow(channelId)
    this.requireWritable(channel.ownerUserId, user, what)
    return channel
  }

  /**
   * 群成员守卫(仅群聊语义:读历史 / 发言 / WS 订阅 / HITL 可见)。
   * - admin 放行(最高管理权限,与其余守卫一致);
   * - Channel owner 放行(并自愈 owner 成员落库);
   * - 否则必须存在 status='active' 的成员记录,否则 403 NOT_CHANNEL_MEMBER。
   * **不得**用于任何管理端点。
   */
  requireChannelMember(channelId: string, user: ActingUser): ChannelRow {
    const channel = this.requireChannelRow(channelId)
    if (user.role === 'admin') return channel
    if (channel.ownerUserId !== null && channel.ownerUserId === user.id) {
      // owner 成员记录自愈(迁移/异常删除后仍可群聊;幂等)
      this.channelMemberRepo.ensureOwner(channelId, user.id)
      return channel
    }
    if (this.channelMemberRepo.isActiveMember(channelId, user.id)) return channel
    if (channel.ownerUserId === null) {
      throw new AppError(403, 'FORBIDDEN_LEGACY', 'channel 为遗留公共数据(无归属),未开放群聊成员访问')
    }
    throw new AppError(403, 'NOT_CHANNEL_MEMBER', '不是该 Channel 的群成员')
  }

  /** 群聊**发言**守卫:成员资格 + 群聊已开启(未开启 → 409,与契约一致) */
  requireChannelChatEnabled(channelId: string, user: ActingUser): ChannelRow {
    const channel = this.requireChannelMember(channelId, user)
    if (channel.chatEnabled !== 1) {
      throw new AppError(409, 'CHAT_DISABLED', '该 Channel 未开启群聊(需 owner 显式开启)')
    }
    return channel
  }

  /** 加入资格:公开 + 已开启群聊 + (open 直接加入 | owner_approve 转 pending) */
  requireCanJoinChannel(channelId: string, user: ActingUser): { channel: ChannelRow, status: 'active' | 'pending' } {
    const channel = this.requireChannelRow(channelId)
    if (channel.ownerUserId === null) {
      throw new AppError(403, 'FORBIDDEN_LEGACY', 'channel 为遗留公共数据(无归属),不可加入;需管理员先显式认领')
    }
    if (channel.ownerUserId === user.id) return { channel, status: 'active' }
    if (channel.chatEnabled !== 1) {
      throw new AppError(409, 'CHAT_DISABLED', '该 Channel 未开启群聊,无法加入')
    }
    if (channel.visibility !== 'public') {
      throw new AppError(403, 'CHANNEL_PRIVATE', '该 Channel 未公开,无法自行加入(需 owner 邀请)')
    }
    // 已是 active 成员 → 幂等返回
    if (this.channelMemberRepo.isActiveMember(channelId, user.id)) return { channel, status: 'active' }
    return { channel, status: channel.joinPolicy === 'open' ? 'active' : 'pending' }
  }

  /**
   * @Agent 调用资格(v1 固定 members_only,主计划 §3.1 invokePolicy 未落地前不放宽)。
   * 返回 channel 供调用方继续 use。
   */
  requireCanInvokeAgent(channelId: string, user: ActingUser): ChannelRow {
    return this.requireChannelChatEnabled(channelId, user)
  }

  /**
   * HITL 审批资格(§13.4 资格判定 = **创建时资格 ∩ 当前资格**)。
   *
   * 两重资格都必须满足:
   *  - **当前**策略(channels.approval_policy):owner_only → 仅 owner/admin。
   *    这保证「运行中把策略收紧为 owner_only」**立即生效**(否则历史请求会继续按旧策略放行)。
   *  - **创建时**冻结策略(`opts.policy`,来自持久化行):若创建时是 owner_only,
   *    即使后来放宽为 any_member,该历史请求仍仅 owner 可裁决 ——
   *    「策略变更不放宽已有请求」(单向棘轮:放松不回溯,收紧立即生效)。
   *
   * @param snapshot 创建时冻结的策略快照(命中持久化行时必传;缺省表示只看当前策略)
   */
  requireCanApprove(
    channelId: string,
    user: ActingUser,
    opts: { policy?: string, snapshot?: { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } } = {},
  ): ChannelRow {
    const channel = this.requireChannelMember(channelId, user)
    if (user.role === 'admin') return channel
    const isOwner = channel.ownerUserId !== null && channel.ownerUserId === user.id
    const currentPolicy = channel.approvalPolicy ?? 'owner_only'
    const frozenPolicy = opts.policy
    // 任一侧要求 owner_only → 仅 owner(收紧立即生效;放宽不回溯)
    const requiresOwner = currentPolicy !== 'any_member'
      || (frozenPolicy !== undefined && frozenPolicy !== 'any_member')
    if (requiresOwner && !isOwner) {
      const reason = currentPolicy !== 'any_member'
        ? '该 Channel 当前的 HITL 审批策略为 owner_only,仅 owner 可决策'
        : '该请求创建时的审批策略为 owner_only(创建时资格冻结),仅 owner 可决策'
      throw new AppError(403, 'APPROVAL_FORBIDDEN', reason)
    }
    // 创建时资格 ∩ 当前资格:创建时不在名单 → 无资格(策略收紧不可被绕过)
    const eligible = opts.snapshot?.eligibleUserIds
    if (eligible && eligible.length > 0 && !eligible.includes(user.id)) {
      throw new AppError(403, 'APPROVAL_FORBIDDEN', '该请求创建时不具备审批资格(资格按创建时快照冻结)')
    }
    // 退出后重新加入 = 新代数,不恢复旧请求资格
    const frozenGen = opts.snapshot?.memberGenerations?.[user.id]
    if (typeof frozenGen === 'number') {
      const current = this.channelMemberRepo.findOne(channelId, user.id)
      if (!current || current.status !== 'active' || current.generation !== frozenGen) {
        throw new AppError(403, 'APPROVAL_FORBIDDEN', '成员资格已变化(退出/被移除/重新加入),不可决策该历史请求')
      }
    }
    return channel
  }

  /** 当前用户在 Channel 内的能力视图(前端按钮可用性;单一事实源在服务端) */
  channelPermissionsOf(channelId: string, user: ActingUser): {
    isOwner: boolean
    isMember: boolean
    isAdmin: boolean
    status: string | null
    role: string | null
    canJoin: boolean
    canPost: boolean
    canInvokeAgent: boolean
    canApprove: boolean
    canManage: boolean
  } {
    const channel = this.requireChannelRow(channelId)
    const isAdmin = user.role === 'admin'
    const isOwner = channel.ownerUserId !== null && channel.ownerUserId === user.id
    const row = this.channelMemberRepo.findOne(channelId, user.id)
    const isMember = isOwner || (!!row && row.status === 'active')
    const chatOn = channel.chatEnabled === 1
    const discoverable = channel.visibility === 'public' && chatOn && channel.ownerUserId !== null
    return {
      isOwner,
      isMember,
      isAdmin,
      status: isOwner ? 'active' : (row?.status ?? null),
      role: isOwner ? 'owner' : (row?.role ?? null),
      canJoin: !isMember && discoverable && (channel.joinPolicy === 'open' || channel.joinPolicy === 'owner_approve'),
      canPost: chatOn && (isMember || isAdmin),
      canInvokeAgent: chatOn && (isMember || isAdmin),
      canApprove: isAdmin || isOwner || (isMember && channel.approvalPolicy === 'any_member'),
      canManage: isAdmin || isOwner,
    }
  }

  /**
   * 用户可见 Channel(读视角):本人 owner 的 + active 成员的 + 公开可发现的。
   * 管理面写操作仍须 requireChannelOwner。
   */
  listChannelsVisibleTo(user: ActingUser): ChannelRow[] {
    if (user.role === 'admin') return this.deps.repos.channels.list()
    return this.deps.repos.channels.listVisibleToUser(user.id)
  }

  /** 公开可发现清单(已开启群聊的 public Channel;owner=NULL 遗留行不在内) */
  listDiscoverableChannels(): ChannelRow[] {
    return this.deps.repos.channels.listDiscoverable()
  }

  // ===== v17:群成员管理 =====

  /** 成员列表(投影:不含 token / 工作目录 / Harness 凭据 —— 见 chat-projection) */
  listChannelMembers(channelId: string): ChannelMemberRow[] {
    return this.channelMemberRepo.listByChannel(channelId)
  }

  /**
   * 加入 Channel。
   * - 已是 active → 幂等返回 { status: 'active' }
   * - joinPolicy=open → 直接 active
   * - joinPolicy=owner_approve → pending(需 owner 调 approveMember)
   */
  joinChannel(channelId: string, user: ActingUser): { channelId: string, status: 'active' | 'pending', generation: number } {
    const { channel, status } = this.requireCanJoinChannel(channelId, user)
    if (channel.ownerUserId === user.id) {
      const row = this.channelMemberRepo.ensureOwner(channelId, user.id)
      return { channelId, status: 'active', generation: row.generation }
    }
    const existing = this.channelMemberRepo.findOne(channelId, user.id)
    if (existing && existing.status === 'active') {
      return { channelId, status: 'active', generation: existing.generation }
    }
    const row = this.channelMemberRepo.upsert({ channelId, userId: user.id, role: 'member', status })
    this.auditMemberChange('member.join', channelId, user.id, { status })
    return { channelId, status, generation: row.generation }
  }

  /** owner 批准 pending 成员 → active */
  approveMember(channelId: string, owner: ActingUser, userId: string): ChannelMemberRow {
    this.requireChannelOwner(channelId, owner, 'channel')
    const row = this.channelMemberRepo.findOne(channelId, userId)
    if (!row) throw new AppError(404, 'NOT_FOUND', `成员申请不存在: ${userId}`)
    if (row.status === 'active') return row
    const updated = this.channelMemberRepo.upsert({ channelId, userId, role: 'member', status: 'active' })
    this.auditMemberChange('member.approve', channelId, userId, { by: owner.id })
    return updated
  }

  /**
   * 退出 Channel。owner **不允许** leave(§13.7:只能转移 owner 或删除 Channel)。
   * 退出后:撤销通知、pending 投递置 cancelled。
   */
  leaveChannel(channelId: string, user: ActingUser): { ok: boolean, status: string } {
    const channel = this.requireChannelMember(channelId, user)
    if (channel.ownerUserId === user.id) {
      throw new AppError(409, 'OWNER_CANNOT_LEAVE', 'owner 不能退出群聊;请先转移 owner 或删除 Channel')
    }
    const ok = this.channelMemberRepo.setStatus(channelId, user.id, 'left')
    this.revokeMemberAccess(channelId, user.id, 'left')
    this.auditMemberChange('member.leave', channelId, user.id, {})
    return { ok, status: 'left' }
  }

  /** owner 移除成员(不能移除 owner 自己;须先转移 owner) */
  removeChannelMember(channelId: string, owner: ActingUser, userId: string): { ok: boolean, status: string } {
    const channel = this.requireChannelOwner(channelId, owner, 'channel')
    if (channel.ownerUserId === userId) {
      throw new AppError(409, 'OWNER_CANNOT_REMOVE', '不能移除 owner;请先转移 owner')
    }
    const ok = this.channelMemberRepo.setStatus(channelId, userId, 'removed')
    this.revokeMemberAccess(channelId, userId, 'removed')
    this.auditMemberChange('member.remove', channelId, userId, { by: owner.id })
    return { ok, status: 'removed' }
  }

  /**
   * 成员失去访问权时的级联收敛(退出/被移除共用;§13.7)。
   *
   * 实际做的两件事:
   *  ① **删除**其在本 Channel 的定向通知 —— 补发路径只按 `recipient_user_id` 过滤、
   *     **不查成员资格**,所以只"标记已读"不足以阻止其重连/刷新后拿到全部旧通知
   *     (`markChannelRead` 仅置 read_at,行仍在,补发照发)。
   *  ② 记一条 outbox 事件(撤权留痕;失败不影响主流程)。
   *
   * 明确的**未做**(避免注释许诺代码不兑现):
   *  - 不取消该用户历史消息产生的 pending 投递。`chat_deliveries` 只关联
   *    `target_agent_id`,没有 requester 列,无法按"提问者"定位投递;要支持需
   *    先加 `requester_user_id`(或 join chat_messages)—— 属 schema 变更,本轮不做。
   *    Agent 被移除时的投递取消走 `removeAgentFromChannel` → `cancelPendingDeliveriesForAgent`。
   *  - 不回收该用户已获得的 HITL 审批资格:HITL 可见/可裁决由持久化策略快照 ∩ 当前成员资格
   *    判定(`requireCanApprove`),退出后 `requireChannelMember` 立即 403,无需额外清理。
   */
  protected revokeMemberAccess(channelId: string, userId: string, reason: 'left' | 'removed'): void {
    try {
      const purged = this.notificationRepo.deleteForChannel(userId, channelId)
      log.info(`[member] 撤权收敛 channel=${channelId.slice(0, 8)} user=${userId.slice(0, 8)} reason=${reason} 通知清理=${purged}`)
    }
    catch (err) {
      log.error('[member] 撤权级联异常:', err)
    }
    try {
      this.outboxRepo.enqueue({
        aggregateType: 'channel_member',
        aggregateId: `${channelId}:${userId}`,
        eventType: 'member.access_revoked',
        payload: { channelId, userId, reason },
        // 确定性幂等键(去掉 Date.now()):同一次撤权重复调用只登记一行 outbox
        eventId: `member.access_revoked:${channelId}:${userId}`,
      })
    }
    catch (err) {
      log.error('[member] 撤权 outbox 写入失败:', err)
    }
  }

  /** 用户操作审计(群成员变更/群聊发送共用;审计失败不影响主流程) */
  protected auditUserAction(action: string, targetKind: string, targetId: string, actor: string, detail: Record<string, unknown>): void {
    try {
      audit({ actor, actorName: '', actorKind: 'user', action, targetKind, targetId, detail })
    }
    catch { /* 审计不可用(测试脚手架):忽略 */ }
  }

  /** 群成员变更审计 */
  protected auditMemberChange(action: string, channelId: string, userId: string, detail: Record<string, unknown>): void {
    this.auditUserAction(action, 'channel-member', `${channelId}:${userId}`, userId, { channelId, ...detail })
  }

  /** 用户视角 channel 列表(本人 + 遗留公共) */
  listChannelsForUser(userId: string): ChannelRow[] {
    return this.deps.repos.channels.listForOwner(userId)
  }

  // ===== v17:群聊事实层(主计划 §5-§7)=====
}
