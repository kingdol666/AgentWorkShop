/**
 * OptimizerBinding 仓储。作用域 = (workspace, channel, channel_agent, profile)。
 * channel_agent_id 是 channel_agents.id(实例身份),绝不是 agents.id(模板)。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import type { BindingMode } from './contracts'
import { getAmlRuntime } from '../aml/runtime'

export interface BindingRow {
  id: string
  workspaceId: string
  channelId: string
  channelAgentId: string
  profileId: string
  profileVersionNumber: number
  /** "profileId@version"(与 OptimizationProfile 的版本引用同格式) */
  profileVersion: string
  capabilities: string[]
  mode: BindingMode
  validFrom: string
  validTo: string | null
  revision: number
  createdAt: string
}

const COLS = `id, workspace_id AS workspaceId, channel_id AS channelId, channel_agent_id AS channelAgentId,
  profile_id AS profileId, profile_version AS profileVersionNumber, capabilities_json AS capabilitiesJson,
  mode, valid_from AS validFrom, valid_to AS validTo, revision, created_at AS createdAt`

function rowOf(r: Record<string, unknown>): BindingRow {
  const profileId = String(r.profileId ?? '')
  const version = Number(r.profileVersionNumber ?? 1)
  return {
    id: String(r.id),
    workspaceId: String(r.workspaceId),
    channelId: String(r.channelId),
    channelAgentId: String(r.channelAgentId),
    profileId,
    profileVersionNumber: version,
    profileVersion: `${profileId}@${version}`,
    capabilities: JSON.parse(String(r.capabilitiesJson ?? '[]')) as string[],
    mode: String(r.mode) as BindingMode,
    validFrom: String(r.validFrom),
    validTo: r.validTo == null ? null : String(r.validTo),
    revision: Number(r.revision ?? 1),
    createdAt: String(r.createdAt),
  }
}

export function createBindingRepo(db: DatabaseSync) {
  return {
    insert(input: {
      id: string
      workspaceId: string
      channelId: string
      channelAgentId: string
      profileId: string
      profileVersion: number
      capabilities: string[]
      mode: BindingMode
      validFrom?: string
      validTo?: string | null
      createdBy?: string
    }): BindingRow {
      const now = new Date().toISOString()
      const validFrom = input.validFrom ?? now
      try {
        db.prepare(`INSERT INTO optimizer_bindings
          (id, workspace_id, channel_id, channel_agent_id, profile_id, profile_version, capabilities_json,
           mode, valid_from, valid_to, revision, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
          .run(input.id, input.workspaceId, input.channelId, input.channelAgentId, input.profileId, input.profileVersion,
            JSON.stringify(input.capabilities), input.mode, validFrom, input.validTo ?? null, input.createdBy ?? '', now, now)
      }
      catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) {
          throw new AppError(409, 'BINDING_DUPLICATE', '同一 Agent 已绑定该 Profile 版本')
        }
        throw err
      }
      return this.get(input.id)!
    },

    get(id: string): BindingRow | undefined {
      const r = db.prepare(`SELECT ${COLS} FROM optimizer_bindings WHERE id = ?`).get(id) as Record<string, unknown> | undefined
      return r ? rowOf(r) : undefined
    },

    listByAgent(channelAgentId: string): BindingRow[] {
      return (db.prepare(`SELECT ${COLS} FROM optimizer_bindings WHERE channel_agent_id = ? ORDER BY created_at ASC`).all(channelAgentId) as unknown as Record<string, unknown>[]).map(rowOf)
    },

    listByChannel(channelId: string): BindingRow[] {
      return (db.prepare(`SELECT ${COLS} FROM optimizer_bindings WHERE channel_id = ? ORDER BY created_at ASC`).all(channelId) as unknown as Record<string, unknown>[]).map(rowOf)
    },

    listAll(limit = 200): BindingRow[] {
      return (db.prepare(`SELECT ${COLS} FROM optimizer_bindings ORDER BY created_at DESC LIMIT ?`).all(limit) as unknown as Record<string, unknown>[]).map(rowOf)
    },

    /** 撤权:删除行(revision 变化由删除时间体现);成员删除由 FK CASCADE 保证。 */
    remove(id: string): boolean {
      const r = db.prepare('DELETE FROM optimizer_bindings WHERE id = ?').run(id)
      return Number(r.changes) > 0
    },

    bumpRevision(id: string): number {
      db.prepare('UPDATE optimizer_bindings SET revision = revision + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
      const row = this.get(id)
      return row?.revision ?? 0
    },

    /** 模型采纳重绑:绑定升到新 Profile 版本并 bump revision(在飞求解 BINDING_STALE 收敛)。 */
    rebindVersion(id: string, toVersion: number): number {
      const r = db.prepare('UPDATE optimizer_bindings SET profile_version = ?, revision = revision + 1, valid_from = ?, updated_at = ? WHERE id = ?')
        .run(toVersion, new Date().toISOString(), new Date().toISOString(), id)
      return Number(r.changes)
    },

    removeByAgent(channelAgentId: string): number {
      const r = db.prepare('DELETE FROM optimizer_bindings WHERE channel_agent_id = ?').run(channelAgentId)
      return Number(r.changes)
    },
  }
}

export type BindingRepo = ReturnType<typeof createBindingRepo>

const g = globalThis as typeof globalThis & { __optimizerBindingRepo?: BindingRepo }

export function getBindingRepo(): BindingRepo {
  g.__optimizerBindingRepo ??= createBindingRepo(getAmlRuntime().db)
  return g.__optimizerBindingRepo
}
