/**
 * ChannelMember 仓储 —— v17 群成员(channel_members)。
 *
 * 语义要点(主计划 §3.2 / §13.7):
 * - user_id 是**全局用户系统**的 id(server/repositories/user.repository),
 *   不是本库遗留 users 表;因此不做外键(跨库/跨语义)。
 * - owner 必须有且只有一条 active owner 记录;owner 不允许 leave(服务层强制)。
 * - 退出/移除 → status 置 left/removed;重新加入 → generation +1(旧审批资格不恢复)。
 * - status: active(可读/发言/审批) | pending(owner_approve 待批) | left | removed
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelMemberRow } from './database'

const COLS = 'channel_id AS channelId, user_id AS userId, role, status, generation, joined_at AS joinedAt, left_at AS leftAt'

export type ChannelMemberStatus = 'active' | 'pending' | 'left' | 'removed'
export type ChannelMemberRole = 'owner' | 'member'

export interface ChannelMemberUpsertInput {
  channelId: string
  userId: string
  role?: ChannelMemberRole
  status?: ChannelMemberStatus
  joinedAt?: string
}

export type ChannelMemberRepo = ReturnType<typeof createChannelMemberRepo>

export function createChannelMemberRepo(db: DatabaseSync) {
  const selectOne = db.prepare(`SELECT ${COLS} FROM channel_members WHERE channel_id = ? AND user_id = ?`)
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC`)
  const selectActiveByChannel = db.prepare(`SELECT ${COLS} FROM channel_members WHERE channel_id = ? AND status = 'active' ORDER BY joined_at ASC`)
  const selectByChannelStatus = db.prepare(`SELECT ${COLS} FROM channel_members WHERE channel_id = ? AND status = ? ORDER BY joined_at ASC`)
  const selectActiveByUser = db.prepare(`SELECT ${COLS} FROM channel_members WHERE user_id = ? AND status = 'active' ORDER BY joined_at ASC`)
  const selectOwners = db.prepare(`SELECT ${COLS} FROM channel_members WHERE channel_id = ? AND role = 'owner' AND status = 'active'`)

  /**
   * 幂等写入(加入/批准/回填共用):
   * - 无行 → INSERT(status 缺省 active,generation=1)
   * - 已有行 → UPDATE role/status/joined_at;若原 status 不是 active 则 generation+1
   *   (退出/被移除后重新加入 = 新代数,旧 HITL 审批资格不恢复)。
   */
  const upsert = (input: ChannelMemberUpsertInput): ChannelMemberRow => {
    const now = input.joinedAt ?? new Date().toISOString()
    const role = input.role ?? 'member'
    const status = input.status ?? 'active'
    const existing = selectOne.get(input.channelId, input.userId) as unknown as ChannelMemberRow | undefined
    if (!existing) {
      db.prepare(
        `INSERT INTO channel_members (channel_id, user_id, role, status, generation, joined_at, left_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).run(input.channelId, input.userId, role, status, now, status === 'active' ? null : now)
    }
    else {
      const bump = existing.status !== 'active' && status === 'active' ? 1 : 0
      db.prepare(
        `UPDATE channel_members SET role = ?, status = ?, generation = generation + ?, joined_at = ?, left_at = ? WHERE channel_id = ? AND user_id = ?`,
      ).run(role, status, bump, now, status === 'active' ? null : now, input.channelId, input.userId)
    }
    return selectOne.get(input.channelId, input.userId) as unknown as ChannelMemberRow
  }

  return {
    /** 幂等 upsert(见上);返回落库后的行 */
    upsert,

    /** 确保 owner 成员记录存在且为 active owner(创建/迁移/认领后调用) */
    ensureOwner(channelId: string, userId: string): ChannelMemberRow {
      return upsert({ channelId, userId, role: 'owner', status: 'active' })
    },

    findOne(channelId: string, userId: string): ChannelMemberRow | undefined {
      return (selectOne.get(channelId, userId) as unknown as ChannelMemberRow | undefined) ?? undefined
    },

    /** 是否为 active 成员(owner 或 member 皆算) */
    isActiveMember(channelId: string, userId: string): boolean {
      const row = selectOne.get(channelId, userId) as unknown as ChannelMemberRow | undefined
      return !!row && row.status === 'active'
    },

    /** 是否为 active owner */
    isActiveOwner(channelId: string, userId: string): boolean {
      const row = selectOne.get(channelId, userId) as unknown as ChannelMemberRow | undefined
      return !!row && row.status === 'active' && row.role === 'owner'
    },

    listByChannel(channelId: string): ChannelMemberRow[] {
      return selectByChannel.all(channelId) as unknown as ChannelMemberRow[]
    },

    listActiveByChannel(channelId: string): ChannelMemberRow[] {
      return selectActiveByChannel.all(channelId) as unknown as ChannelMemberRow[]
    },

    listByChannelStatus(channelId: string, status: ChannelMemberStatus): ChannelMemberRow[] {
      return selectByChannelStatus.all(channelId, status) as unknown as ChannelMemberRow[]
    },

    listActiveByUser(userId: string): ChannelMemberRow[] {
      return selectActiveByUser.all(userId) as unknown as ChannelMemberRow[]
    },

    listActiveOwners(channelId: string): ChannelMemberRow[] {
      return selectOwners.all(channelId) as unknown as ChannelMemberRow[]
    },

    /** 置为 left(本人退出)/ removed(owner 移除);未命中返回 false */
    setStatus(channelId: string, userId: string, status: 'left' | 'removed'): boolean {
      const now = new Date().toISOString()
      return db.prepare(
        `UPDATE channel_members SET status = ?, left_at = ? WHERE channel_id = ? AND user_id = ? AND status IN ('active', 'pending')`,
      ).run(status, now, channelId, userId).changes > 0
    },

    /** owner 转移:旧 owner 降为 member,新 owner 升为 owner(同一事务由调用方保证) */
    transferOwner(channelId: string, fromUserId: string, toUserId: string): void {
      db.prepare(`UPDATE channel_members SET role = 'member' WHERE channel_id = ? AND user_id = ? AND role = 'owner'`).run(channelId, fromUserId)
      upsert({ channelId, userId: toUserId, role: 'owner', status: 'active' })
    },
  }
}
