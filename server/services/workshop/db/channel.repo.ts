/**
 * Channel 仓储:channels 表 CRUD(含 workspace 工作目录、scenario_prompt 场景指令)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 *
 * v17:新增群聊维度列(visibility / join_policy / approval_policy / chat_enabled / version)。
 * 迁移语义:既有行一律 private + owner_approve + owner_only + chat_enabled=0,
 * 即**不改变任何既有可见性/权限行为**;开启群聊必须由 owner 显式设置。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelRow } from './database'

/** 查询列(蛇形列名 → 驼峰行字段) */
const COLS = 'id, name, description, scenario_prompt AS scenarioPrompt, llm_json AS llmJson, lead_agent_id AS leadAgentId, workspace, enabled, owner_user_id AS ownerUserId, visibility, join_policy AS joinPolicy, approval_policy AS approvalPolicy, chat_enabled AS chatEnabled, version, created_at AS createdAt, updated_at AS updatedAt'

export interface ChannelCreateInput {
  name: string
  description?: string
  /** channel 级作业场景 prompt(注入全部成员 harness) */
  scenarioPrompt?: string
  workspace?: string
  /** 归属用户(null = 遗留公共) */
  ownerUserId?: string | null
  /** v17 可见性(缺省 private) */
  visibility?: string
  /** v17 加入策略(缺省 owner_approve) */
  joinPolicy?: string
  /** v17 HITL 审批策略(缺省 owner_only) */
  approvalPolicy?: string
  /** v17 群聊开关(缺省 0 = 未开启) */
  chatEnabled?: number
}

export interface ChannelPatch {
  name?: string
  description?: string
  scenarioPrompt?: string
  leadAgentId?: string | null
  workspace?: string
  enabled?: number
  /** channel 级默认 LLM(v11;null=清除);成员 config 未显式指定 model/provider 时注入 */
  llm?: { provider?: string, model?: string, effort?: string } | null
  /** v17 群聊维度 */
  visibility?: string
  joinPolicy?: string
  approvalPolicy?: string
  chatEnabled?: number
  /** v17 遗留 Channel 显式认领(admin 专用路径;置 null 需显式传 null) */
  ownerUserId?: string | null
}

export type ChannelRepo = ReturnType<typeof createChannelRepo>

export function createChannelRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO channels (id, name, description, scenario_prompt, lead_agent_id, workspace, enabled, owner_user_id, visibility, join_policy, approval_policy, chat_enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectAll = db.prepare(`SELECT ${COLS} FROM channels ORDER BY createdAt ASC`)
  const selectByOwner = db.prepare(`SELECT ${COLS} FROM channels WHERE owner_user_id = ? OR owner_user_id IS NULL ORDER BY createdAt ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM channels WHERE id = ?`)
  /** 群聊/成员可见的解析入口:owner 或 active 成员(member/owner) */
  const selectVisibleToUser = db.prepare(
    `SELECT ${COLS} FROM channels c
     WHERE c.owner_user_id = ?
        OR EXISTS (SELECT 1 FROM channel_members m
                   WHERE m.channel_id = c.id AND m.user_id = ? AND m.status = 'active')
     ORDER BY c.created_at ASC`,
  )
  /** 公开可发现:*仅* 已开启群聊的 public Channel(不含 owner=NULL 遗留行) */
  const selectDiscoverable = db.prepare(
    `SELECT ${COLS} FROM channels
     WHERE visibility = 'public' AND chat_enabled = 1 AND owner_user_id IS NOT NULL
     ORDER BY created_at ASC`,
  )
  const updateStmt = db.prepare(
    `UPDATE channels SET name = ?, description = ?, scenario_prompt = ?, llm_json = ?, lead_agent_id = ?, workspace = ?, enabled = ?, owner_user_id = ?, visibility = ?, join_policy = ?, approval_policy = ?, chat_enabled = ?, version = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM channels WHERE id = ?`)

  return {
    /** 创建 channel(description/scenarioPrompt 缺省空串,enabled=1,leadAgentId=null,workspace=空串) */
    create(input: ChannelCreateInput): ChannelRow {
      const now = new Date().toISOString()
      const row: ChannelRow = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        scenarioPrompt: input.scenarioPrompt ?? '',
        // INSERT 不含该列 → 落库取列默认(llm_json TEXT NOT NULL DEFAULT '',见 database.ts v11);
        // 返回的内存行按同一事实补该列,使 create() 的返回值与随后 findById() 读到的行形状一致。
        llmJson: '',
        leadAgentId: null,
        workspace: input.workspace ?? '',
        enabled: 1,
        ownerUserId: input.ownerUserId ?? null,
        visibility: input.visibility ?? 'private',
        joinPolicy: input.joinPolicy ?? 'owner_approve',
        approvalPolicy: input.approvalPolicy ?? 'owner_only',
        chatEnabled: input.chatEnabled ?? 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(
        row.id, row.name, row.description, row.scenarioPrompt, row.leadAgentId, row.workspace, row.enabled, row.ownerUserId,
        row.visibility, row.joinPolicy, row.approvalPolicy, row.chatEnabled, row.version, row.createdAt, row.updatedAt,
      )
      return row
    },

    list(): ChannelRow[] {
      return selectAll.all() as unknown as ChannelRow[]
    },

    /** 按 owner 过滤(含 NULL 遗留公共行;用户视角列表) */
    listForOwner(ownerUserId: string): ChannelRow[] {
      return selectByOwner.all(ownerUserId) as unknown as ChannelRow[]
    },

    /**
     * v17:用户可见 Channel = 本人 owner 的 + 本人 active 成员的 + 公开可发现的。
     * 这是**读取**视角;写/管理仍必须走 requireChannelOwner。
     */
    listVisibleToUser(userId: string): ChannelRow[] {
      const owned = selectVisibleToUser.all(userId, userId) as unknown as ChannelRow[]
      const seen = new Set(owned.map(c => c.id))
      const extra: ChannelRow[] = []
      for (const c of selectDiscoverable.all() as unknown as ChannelRow[]) {
        if (!seen.has(c.id)) {
          seen.add(c.id)
          extra.push(c)
        }
      }
      return [...owned, ...extra]
    },

    /** v17:公开可发现清单(已开启群聊的 public Channel) */
    listDiscoverable(): ChannelRow[] {
      return selectDiscoverable.all() as unknown as ChannelRow[]
    },

    findById(id: string): ChannelRow | undefined {
      return selectById.get(id) as unknown as ChannelRow | undefined
    },

    /**
     * 局部更新;未命中返回 undefined。
     * v17:非群聊字段变更不动 version;群聊维度(visibility/joinPolicy/approvalPolicy/chatEnabled)
     * 任一变化 → version +1(供 PATCH 乐观锁)。
     */
    update(id: string, patch: ChannelPatch): ChannelRow | undefined {
      const current = selectById.get(id) as unknown as ChannelRow | undefined
      if (!current) return undefined
      const nextVisibility = patch.visibility ?? current.visibility
      const nextJoin = patch.joinPolicy ?? current.joinPolicy
      const nextApproval = patch.approvalPolicy ?? current.approvalPolicy
      const nextChatEnabled = patch.chatEnabled ?? current.chatEnabled
      const groupChatChanged
        = nextVisibility !== current.visibility
          || nextJoin !== current.joinPolicy
          || nextApproval !== current.approvalPolicy
          || nextChatEnabled !== current.chatEnabled
      const next: ChannelRow = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        scenarioPrompt: patch.scenarioPrompt ?? current.scenarioPrompt,
        llmJson: patch.llm !== undefined ? JSON.stringify(patch.llm) : current.llmJson,
        leadAgentId: patch.leadAgentId !== undefined ? patch.leadAgentId : current.leadAgentId,
        workspace: patch.workspace ?? current.workspace,
        enabled: patch.enabled ?? current.enabled,
        ownerUserId: patch.ownerUserId !== undefined ? patch.ownerUserId : current.ownerUserId,
        visibility: nextVisibility,
        joinPolicy: nextJoin,
        approvalPolicy: nextApproval,
        chatEnabled: nextChatEnabled,
        version: current.version + (groupChatChanged ? 1 : 0),
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(
        next.name, next.description, next.scenarioPrompt, next.llmJson, next.leadAgentId, next.workspace, next.enabled,
        next.ownerUserId, next.visibility, next.joinPolicy, next.approvalPolicy, next.chatEnabled, next.version,
        next.updatedAt, id,
      )
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },
  }
}
