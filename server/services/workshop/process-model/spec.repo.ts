/* eslint-disable @stylistic/max-statements-per-line */
/**
 * ProcessModelSpec 仓储:版本化、发布不可变、内容 hash 唯一。
 *
 * 发布语义(plan §3.1):
 *  - draft 可改;published 行**禁止 UPDATE**,修改 = 新版本行;
 *  - 同一 (line, product, recipe, recipeVersion, contentHash) 只登记一次(幂等)。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { canonicalJson, sha256 } from '../aml/twin/contracts'
import type { ProcessModelSpec, ProcessModelStatus } from './contracts'
import { PROCESS_MODEL_SCHEMA_VERSION } from './contracts'
import { getAmlRuntime } from '../aml/runtime'

export interface ProcessModelSpecRow {
  id: string
  version: number
  lineId: string
  productId: string
  recipeId: string
  recipeVersion: number
  contentHash: string
  specJson: string
  status: ProcessModelStatus
  ownerUserId: string
  createdAt: string
  updatedAt: string
}

const COLS = `id, version, line_id AS lineId, product_id AS productId, recipe_id AS recipeId,
  recipe_version AS recipeVersion, content_hash AS contentHash, spec_json AS specJson, status,
  owner_user_id AS ownerUserId, created_at AS createdAt, updated_at AS updatedAt`

/** 内容 hash:稳定序列化(不含 created/status 等运行时字段),同配置必同 hash。 */
export function specContentHash(spec: ProcessModelSpec): string {
  const { createdAt: _createdAt, status: _status, ...stable } = spec as ProcessModelSpec & { status?: string }
  return sha256(canonicalJson({ ...stable, schemaVersion: PROCESS_MODEL_SCHEMA_VERSION }))
}

export function createProcessModelSpecRepo(db: DatabaseSync) {
  return {
    insert(spec: ProcessModelSpec, opts: { ownerUserId?: string, status?: ProcessModelStatus } = {}): ProcessModelSpecRow {
      const now = new Date().toISOString()
      const contentHash = specContentHash(spec)
      const existing = db.prepare(`SELECT ${COLS} FROM process_model_specs WHERE id = ? AND version = ?`).get(spec.id, spec.version) as Record<string, unknown> | undefined
      if (existing) {
        const row = existing as unknown as ProcessModelSpecRow
        if (row.contentHash !== contentHash) {
          throw new AppError(409, 'SPEC_VERSION_IMMUTABLE', `ProcessModelSpec ${spec.id}@${spec.version} 已存在且内容不同;修改必须产生新版本`)
        }
        return row
      }
      const dedup = db.prepare(`SELECT ${COLS} FROM process_model_specs WHERE line_id = ? AND product_id = ? AND recipe_id = ? AND recipe_version = ? AND content_hash = ?`)
        .get(spec.lineId, spec.productId, spec.recipeId, spec.recipeVersion, contentHash) as Record<string, unknown> | undefined
      if (dedup) return dedup as unknown as ProcessModelSpecRow
      db.prepare(`INSERT INTO process_model_specs
        (id, version, line_id, product_id, recipe_id, recipe_version, content_hash, spec_json, status, owner_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(spec.id, spec.version, spec.lineId, spec.productId, spec.recipeId, spec.recipeVersion, contentHash,
          JSON.stringify(spec), opts.status ?? 'draft', opts.ownerUserId ?? '', now, now)
      return this.get(spec.id, spec.version)!
    },

    get(id: string, version?: number): ProcessModelSpecRow | undefined {
      const r = version == null
        ? db.prepare(`SELECT ${COLS} FROM process_model_specs WHERE id = ? ORDER BY version DESC LIMIT 1`).get(id)
        : db.prepare(`SELECT ${COLS} FROM process_model_specs WHERE id = ? AND version = ?`).get(id, version)
      return r as unknown as ProcessModelSpecRow | undefined
    },

    list(filter: { lineId?: string, status?: string, limit?: number } = {}): ProcessModelSpecRow[] {
      const where: string[] = []
      const args: unknown[] = []
      if (filter.lineId) { where.push('line_id = ?'); args.push(filter.lineId) }
      if (filter.status) { where.push('status = ?'); args.push(filter.status) }
      const sql = `SELECT ${COLS} FROM process_model_specs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`
      args.push(filter.limit ?? 100)
      return db.prepare(sql).all(...(args as never[])) as unknown as ProcessModelSpecRow[]
    },

    nextVersion(id: string): number {
      const r = db.prepare('SELECT MAX(version) AS v FROM process_model_specs WHERE id = ?').get(id) as { v: number | null }
      return (r.v ?? 0) + 1
    },

    /** 发布:只允许 draft/validated;发布后不可再改(改 = 新版本)。 */
    publish(id: string, version: number): ProcessModelSpecRow {
      const row = this.get(id, version)
      if (!row) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${id}@${version} 不存在`)
      if (row.status === 'published') return row
      if (row.status === 'retired') throw new AppError(409, 'SPEC_RETIRED', `ProcessModelSpec ${id}@${version} 已退役,不能发布`)
      const r = db.prepare(`UPDATE process_model_specs SET status = 'published', updated_at = ? WHERE id = ? AND version = ? AND status IN ('draft','validated')`)
        .run(new Date().toISOString(), id, version)
      if (Number(r.changes) === 0) throw new AppError(409, 'SPEC_RACE', 'ProcessModelSpec 状态已被并发修改')
      return this.get(id, version)!
    },

    retire(id: string, version: number): ProcessModelSpecRow {
      db.prepare(`UPDATE process_model_specs SET status = 'retired', updated_at = ? WHERE id = ? AND version = ?`).run(new Date().toISOString(), id, version)
      const row = this.get(id, version)
      if (!row) throw new AppError(404, 'SPEC_NOT_FOUND', `ProcessModelSpec ${id}@${version} 不存在`)
      return row
    },

    removeDraft(id: string, version: number): boolean {
      const row = this.get(id, version)
      if (!row) return false
      if (row.status !== 'draft') throw new AppError(409, 'SPEC_IMMUTABLE', '只有 draft 可删除;published/retired 保留谱系')
      db.prepare('DELETE FROM process_model_specs WHERE id = ? AND version = ?').run(id, version)
      return true
    },
  }
}

export type ProcessModelSpecRepo = ReturnType<typeof createProcessModelSpecRepo>

const g = globalThis as typeof globalThis & { __processModelSpecRepo?: ProcessModelSpecRepo }

export function getProcessModelSpecRepo(): ProcessModelSpecRepo {
  g.__processModelSpecRepo ??= createProcessModelSpecRepo(getAmlRuntime().db)
  return g.__processModelSpecRepo
}

export function parseSpecRow(row: ProcessModelSpecRow): ProcessModelSpec {
  return JSON.parse(row.specJson) as ProcessModelSpec
}
