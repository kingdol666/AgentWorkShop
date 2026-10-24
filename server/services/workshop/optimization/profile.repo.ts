/* eslint-disable @stylistic/max-statements-per-line */
/**
 * OptimizationProfile 仓储:版本化、published 不可变、发布时校验模型/求解器兼容。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { canonicalJson, sha256 } from '../aml/twin/contracts'
import type { OptimizationProfile, ProfileStatus } from './contracts'
import { OPTIMIZATION_SCHEMA_VERSION, assertProfileSolverCompatible } from './contracts'
import { getAmlRuntime } from '../aml/runtime'

export interface ProfileRow {
  id: string
  version: number
  name: string
  modelRef: string
  modelArtifactHash: string
  modelArtifactKind: string
  modelInterface: string
  problemTemplateRef: string
  problemConfigJson: string
  processSpecRef: string
  solverRef: string
  solverVersion: string
  conditionIdsJson: string
  status: ProfileStatus
  ownerUserId: string
  problemIrHash: string
  /** 发布不可变校验:内容 hash(不含 status/createdAt/problemIrHash) */
  contentHash: string
  createdAt: string
  updatedAt: string
}

const COLS = `id, version, name, model_ref AS modelRef, model_artifact_hash AS modelArtifactHash,
  model_artifact_kind AS modelArtifactKind, model_interface AS modelInterface,
  problem_template_ref AS problemTemplateRef, problem_config_json AS problemConfigJson,
  process_spec_ref AS processSpecRef,
  solver_ref AS solverRef, solver_version AS solverVersion, condition_ids_json AS conditionIdsJson,
  status, owner_user_id AS ownerUserId, problem_ir_hash AS problemIrHash, content_hash AS contentHash,
  created_at AS createdAt, updated_at AS updatedAt`

export function profileContentHash(profile: OptimizationProfile): string {
  const { createdAt: _createdAt, status: _status, problemIrHash: _irHash, ...stable } = profile as OptimizationProfile
  return sha256(canonicalJson({ ...stable, schemaVersion: OPTIMIZATION_SCHEMA_VERSION }))
}

export function createProfileRepo(db: DatabaseSync) {
  return {
    insert(profile: OptimizationProfile, ownerUserId = ''): ProfileRow {
      assertProfileSolverCompatible(profile)
      const now = new Date().toISOString()
      const contentHash = profileContentHash(profile)
      const existing = this.get(profile.id, profile.version)
      if (existing) {
        if (existing.contentHash && existing.contentHash !== contentHash) {
          throw new AppError(409, 'PROFILE_VERSION_IMMUTABLE', `Profile ${profile.id}@${profile.version} 已存在且内容不同;修改必须产生新版本`)
        }
        return existing
      }
      db.prepare(`INSERT INTO optimizer_profiles
        (id, version, name, model_ref, model_artifact_hash, model_artifact_kind, model_interface,
         problem_template_ref, problem_config_json, process_spec_ref, solver_ref, solver_version, condition_ids_json,
         status, owner_user_id, problem_ir_hash, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(profile.id, profile.version, profile.name ?? '', profile.modelRef.modelId, profile.modelRef.artifactHash,
          profile.modelRef.artifactKind, profile.modelRef.modelInterface, profile.problemTemplateRef,
          JSON.stringify(profile.problemConfig ?? {}), profile.processSpecRef ?? '', profile.solverRef, profile.solverVersion,
          JSON.stringify(profile.conditionIds ?? []), profile.status, ownerUserId, profile.problemIrHash ?? '', contentHash, now, now)
      return this.get(profile.id, profile.version)!
    },

    get(id: string, version?: number): ProfileRow | undefined {
      const r = version == null
        ? db.prepare(`SELECT ${COLS} FROM optimizer_profiles WHERE id = ? ORDER BY version DESC LIMIT 1`).get(id)
        : db.prepare(`SELECT ${COLS} FROM optimizer_profiles WHERE id = ? AND version = ?`).get(id, version)
      return r as unknown as ProfileRow | undefined
    },

    list(filter: { status?: string, modelRef?: string, limit?: number } = {}): ProfileRow[] {
      const where: string[] = []
      const args: unknown[] = []
      if (filter.status) { where.push('status = ?'); args.push(filter.status) }
      if (filter.modelRef) { where.push('model_ref = ?'); args.push(filter.modelRef) }
      args.push(filter.limit ?? 100)
      return db.prepare(`SELECT ${COLS} FROM optimizer_profiles ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
        .all(...(args as never[])) as unknown as ProfileRow[]
    },

    nextVersion(id: string): number {
      const r = db.prepare('SELECT MAX(version) AS v FROM optimizer_profiles WHERE id = ?').get(id) as { v: number | null }
      return (r.v ?? 0) + 1
    },

    /** 发布:冻结 problemIrHash;published 行禁止原地修改(服务层拒绝 UPDATE)。 */
    publish(id: string, version: number, problemIrHash?: string): ProfileRow {
      const row = this.get(id, version)
      if (!row) throw new AppError(404, 'PROFILE_NOT_FOUND', `Profile ${id}@${version} 不存在`)
      if (row.status === 'published') return row
      if (row.status === 'retired') throw new AppError(409, 'PROFILE_RETIRED', `Profile ${id}@${version} 已退役`)
      const r = db.prepare(`UPDATE optimizer_profiles SET status = 'published', problem_ir_hash = COALESCE(?, problem_ir_hash), updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('draft','validated')`)
        .run(problemIrHash ?? null, new Date().toISOString(), id, version)
      if (Number(r.changes) === 0) throw new AppError(409, 'PROFILE_RACE', 'Profile 状态已被并发修改')
      return this.get(id, version)!
    },

    retire(id: string, version: number): ProfileRow {
      db.prepare(`UPDATE optimizer_profiles SET status = 'retired', updated_at = ? WHERE id = ? AND version = ?`).run(new Date().toISOString(), id, version)
      const row = this.get(id, version)
      if (!row) throw new AppError(404, 'PROFILE_NOT_FOUND', `Profile ${id}@${version} 不存在`)
      return row
    },

    removeDraft(id: string, version: number): boolean {
      const row = this.get(id, version)
      if (!row) return false
      if (row.status !== 'draft') throw new AppError(409, 'PROFILE_IMMUTABLE', '只有 draft 可删除')
      db.prepare('DELETE FROM optimizer_profiles WHERE id = ? AND version = ?').run(id, version)
      return true
    },
  }
}

export type ProfileRepo = ReturnType<typeof createProfileRepo>

const g = globalThis as typeof globalThis & { __optimizerProfileRepo?: ProfileRepo }

export function getProfileRepo(): ProfileRepo {
  g.__optimizerProfileRepo ??= createProfileRepo(getAmlRuntime().db)
  return g.__optimizerProfileRepo
}

export function parseProfileRow(row: ProfileRow): OptimizationProfile {
  return {
    schemaVersion: OPTIMIZATION_SCHEMA_VERSION,
    id: row.id,
    version: row.version,
    name: row.name,
    modelRef: {
      modelId: row.modelRef,
      artifactHash: row.modelArtifactHash,
      artifactKind: row.modelArtifactKind as OptimizationProfile['modelRef']['artifactKind'],
      modelInterface: row.modelInterface as OptimizationProfile['modelRef']['modelInterface'],
      stage: 'candidate',
    },
    problemTemplateRef: row.problemTemplateRef as OptimizationProfile['problemTemplateRef'],
    problemConfig: JSON.parse(row.problemConfigJson || '{}') as OptimizationProfile['problemConfig'],
    processSpecRef: row.processSpecRef,
    solverRef: row.solverRef as OptimizationProfile['solverRef'],
    solverVersion: row.solverVersion,
    conditionIds: JSON.parse(row.conditionIdsJson || '[]') as string[],
    status: row.status,
    ownerUserId: row.ownerUserId,
    problemIrHash: row.problemIrHash || undefined,
    createdAt: row.createdAt,
  }
}
