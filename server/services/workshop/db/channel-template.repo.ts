/**
 * Channel 模板仓储:channel_templates 表 CRUD(v10)。
 * 模板 = 场景 prompt + 工作目录 + 成员组合(lead 内联定义 + members 引用 Agent 模板或内联)。
 * 可见性:private 仅属主;public 全员可读可用;owner NULL = 内置(恒 public,不可变更)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChannelTemplateRow } from './database'

const COLS = `id, name, description, scenario_prompt AS scenarioPrompt, workspace, lead_json AS leadJson,
  members_json AS membersJson, visibility, owner_user_id AS ownerUserId, created_at AS createdAt, updated_at AS updatedAt`

/** members_json 元素契约 */
export type ChannelTemplateMember
  = | { templateId: string, role: 'lead' | 'worker' }
    | { inline: { name: string, harness: string, config?: Record<string, unknown> }, role: 'lead' | 'worker' }

export interface ChannelTemplateCreateInput {
  name: string
  description?: string
  scenarioPrompt?: string
  workspace?: string
  lead?: { name: string, harness: string, config?: Record<string, unknown> } | null
  members?: ChannelTemplateMember[]
  visibility?: string
  ownerUserId?: string | null
}

export interface ChannelTemplatePatch {
  name?: string
  description?: string
  scenarioPrompt?: string
  workspace?: string
  lead?: { name: string, harness: string, config?: Record<string, unknown> } | null
  members?: ChannelTemplateMember[]
  visibility?: string
}

export type ChannelTemplateRepo = ReturnType<typeof createChannelTemplateRepo>

export function createChannelTemplateRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO channel_templates (id, name, description, scenario_prompt, workspace, lead_json, members_json, visibility, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectAll = db.prepare(`SELECT ${COLS} FROM channel_templates ORDER BY createdAt ASC`)
  const selectVisible = db.prepare(`SELECT ${COLS} FROM channel_templates WHERE owner_user_id = ? OR visibility = 'public' ORDER BY createdAt ASC`)
  const selectById = db.prepare(`SELECT ${COLS} FROM channel_templates WHERE id = ?`)
  const updateStmt = db.prepare(
    `UPDATE channel_templates SET name = ?, description = ?, scenario_prompt = ?, workspace = ?, lead_json = ?, members_json = ?, visibility = ?, updated_at = ? WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM channel_templates WHERE id = ?`)

  const toLeadJson = (lead: ChannelTemplateCreateInput['lead']): string =>
    lead ? JSON.stringify(lead) : ''

  return {
    create(input: ChannelTemplateCreateInput): ChannelTemplateRow {
      const now = new Date().toISOString()
      const row: ChannelTemplateRow = {
        id: randomUUID(),
        name: input.name,
        description: input.description ?? '',
        scenarioPrompt: input.scenarioPrompt ?? '',
        workspace: input.workspace ?? '',
        leadJson: toLeadJson(input.lead),
        membersJson: JSON.stringify(input.members ?? []),
        visibility: input.visibility ?? 'private',
        ownerUserId: input.ownerUserId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(row.id, row.name, row.description, row.scenarioPrompt, row.workspace, row.leadJson, row.membersJson, row.visibility, row.ownerUserId, row.createdAt, row.updatedAt)
      return row
    },

    list(): ChannelTemplateRow[] {
      return selectAll.all() as unknown as ChannelTemplateRow[]
    },

    /** 用户可见集:本人(任意可见性)+ 全部 public(含内置) */
    listVisible(userId: string): ChannelTemplateRow[] {
      return selectVisible.all(userId) as unknown as ChannelTemplateRow[]
    },

    findById(id: string): ChannelTemplateRow | undefined {
      return selectById.get(id) as unknown as ChannelTemplateRow | undefined
    },

    update(id: string, patch: ChannelTemplatePatch): ChannelTemplateRow | undefined {
      const current = selectById.get(id) as unknown as ChannelTemplateRow | undefined
      if (!current) return undefined
      const next: ChannelTemplateRow = {
        ...current,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        scenarioPrompt: patch.scenarioPrompt ?? current.scenarioPrompt,
        workspace: patch.workspace ?? current.workspace,
        leadJson: patch.lead !== undefined ? toLeadJson(patch.lead) : current.leadJson,
        membersJson: patch.members !== undefined ? JSON.stringify(patch.members) : current.membersJson,
        visibility: patch.visibility ?? current.visibility,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.description, next.scenarioPrompt, next.workspace, next.leadJson, next.membersJson, next.visibility, next.updatedAt, id)
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },
  }
}
