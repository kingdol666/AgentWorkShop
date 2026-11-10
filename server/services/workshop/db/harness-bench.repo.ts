/**
 * Harness 配对评测台账仓储(2026-11-10)。
 *
 * 写入方:POST /channels/:id/harness-bench-runs(服务端复算 summary 后落库)。
 * 读取方:promote→active 的 provenance 校验(必须引用本表行)。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface HarnessBenchRunRow {
  id: string
  channelId: string
  profileId: string
  baselineProfileId: string
  kind: string
  status: string
  pValue: number | null
  primaryDelta: number
  costDelta: number
  pairs: number
  excluded: number
  seedsJson: string
  perSeedJson: string
  artifactSha256: string
  createdBy: string
  createdAt: string
  completedAt: string | null
}

const COLS = `id, channel_id AS channelId, profile_id AS profileId, baseline_profile_id AS baselineProfileId,
  kind, status, p_value AS pValue, primary_delta AS primaryDelta, cost_delta AS costDelta, pairs, excluded,
  seeds_json AS seedsJson, per_seed_json AS perSeedJson, artifact_sha256 AS artifactSha256,
  created_by AS createdBy, created_at AS createdAt, completed_at AS completedAt`

export type HarnessBenchRunRepo = ReturnType<typeof createHarnessBenchRunRepo>

export function createHarnessBenchRunRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO harness_bench_runs (id, channel_id, profile_id, baseline_profile_id, kind, status,
       p_value, primary_delta, cost_delta, pairs, excluded, seeds_json, per_seed_json,
       artifact_sha256, created_by, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const byId = db.prepare(`SELECT ${COLS} FROM harness_bench_runs WHERE id = ?`)
  const byProfile = db.prepare(`SELECT ${COLS} FROM harness_bench_runs
    WHERE channel_id = ? AND profile_id = ? ORDER BY created_at DESC LIMIT ?`)

  return {
    create(input: Omit<HarnessBenchRunRow, 'id'> & { id?: string }): HarnessBenchRunRow {
      const id = input.id ?? `hbr-${randomUUID()}`
      insert.run(
        id, input.channelId, input.profileId, input.baselineProfileId, input.kind, input.status,
        input.pValue, input.primaryDelta, input.costDelta, input.pairs, input.excluded,
        input.seedsJson, input.perSeedJson, input.artifactSha256, input.createdBy,
        input.createdAt, input.completedAt,
      )
      return byId.get(id) as unknown as HarnessBenchRunRow
    },
    get(id: string): HarnessBenchRunRow | undefined {
      return byId.get(id) as unknown as HarnessBenchRunRow | undefined
    },
    listByProfile(channelId: string, profileId: string, limit = 20): HarnessBenchRunRow[] {
      return byProfile.all(channelId, profileId, limit) as unknown as HarnessBenchRunRow[]
    },
  }
}
