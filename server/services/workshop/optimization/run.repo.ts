/**
 * OptimizationRun / Candidate / Recommendation / Outcome 仓储(不可变运行台账)。
 */
/* eslint-disable @stylistic/max-statements-per-line, @stylistic/member-delimiter-style */
import type { DatabaseSync } from 'node:sqlite'
import { getAmlRuntime } from '../aml/runtime'
import type { ProblemIR, Recommendation, RecommendationStatus, SolveCandidate, SolveResult } from './contracts'
import { recommendationLabel } from './contracts'

export interface RunRow {
  id: string
  bindingId: string
  bindingRevision: number
  profileId: string
  profileVersion: number
  problemIrHash: string
  status: string
  independentCost: number | null
  startedAt: string
  finishedAt: string | null
  problemIrJson: string
  diagnosticsJson: string
}

const RUN_COLS = `id, binding_id AS bindingId, binding_revision AS bindingRevision, profile_id AS profileId,
  profile_version AS profileVersion, problem_ir_hash AS problemIrHash, status, independent_cost AS independentCost,
  started_at AS startedAt, finished_at AS finishedAt, problem_ir_json AS problemIrJson, diagnostics_json AS diagnosticsJson`

export function createRunRepo(db: DatabaseSync) {
  return {
    insertRun(input: { id: string, bindingId: string, bindingRevision: number, profileId: string, profileVersion: number, ir: ProblemIR, context: unknown, startedAt: string }): void {
      db.prepare(`INSERT INTO optimizer_runs
        (id, binding_id, binding_revision, profile_id, profile_version, problem_ir_hash, context_snapshot_json,
         problem_ir_json, status, diagnostics_json, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', '{}', ?)`)
        .run(input.id, input.bindingId, input.bindingRevision, input.profileId, input.profileVersion,
          input.ir.hash, JSON.stringify(input.context ?? {}), JSON.stringify(input.ir), input.startedAt)
    },

    finishRun(id: string, result: SolveResult): void {
      db.prepare(`UPDATE optimizer_runs SET status = ?, diagnostics_json = ?, independent_cost = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
        .run(result.status, JSON.stringify(result.diagnostics ?? {}), result.independentCost, new Date().toISOString(), id)
    },

    getRun(id: string): RunRow | undefined {
      return db.prepare(`SELECT ${RUN_COLS} FROM optimizer_runs WHERE id = ?`).get(id) as unknown as RunRow | undefined
    },

    listRuns(filter: { bindingId?: string, limit?: number } = {}): RunRow[] {
      const where = filter.bindingId ? 'WHERE binding_id = ?' : ''
      const args: unknown[] = filter.bindingId ? [filter.bindingId, filter.limit ?? 50] : [filter.limit ?? 50]
      return db.prepare(`SELECT ${RUN_COLS} FROM optimizer_runs ${where} ORDER BY started_at DESC LIMIT ?`).all(...(args as never[])) as unknown as RunRow[]
    },

    insertCandidates(runId: string, candidates: SolveCandidate[], modelId?: string): string[] {
      const ids: string[] = []
      for (const candidate of candidates) {
        const id = `oc-${runId.slice(3)}-${candidate.seq}`
        ids.push(id)
        db.prepare(`INSERT INTO optimizer_candidates
          (id, run_id, seq, controls_json, predicted_json, cost, constraints_json, verified, verify_report_json, model_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, runId, candidate.seq, JSON.stringify(candidate.controls), JSON.stringify(candidate.predicted),
            candidate.cost, JSON.stringify(candidate.constraints), candidate.feasible ? 1 : 0, JSON.stringify({ feasible: candidate.feasible }), modelId ?? '')
      }
      return ids
    },

    getCandidate(id: string): { id: string, runId: string, seq: number, controls: number[][], predicted: number[][], cost: number | null, constraints: unknown[], verified: number } | undefined {
      const r = db.prepare('SELECT id, run_id AS runId, seq, controls_json AS controls, predicted_json AS predicted, cost, constraints_json AS constraints, verified FROM optimizer_candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!r) return undefined
      return {
        id: String(r.id),
        runId: String(r.runId),
        seq: Number(r.seq),
        controls: JSON.parse(String(r.controls)) as number[][],
        predicted: JSON.parse(String(r.predicted)) as number[][],
        cost: r.cost == null ? null : Number(r.cost),
        constraints: JSON.parse(String(r.constraints)) as unknown[],
        verified: Number(r.verified ?? 0),
      }
    },

    listCandidates(runId: string): Array<{ id: string, seq: number, cost: number | null }> {
      return db.prepare('SELECT id, seq, cost FROM optimizer_candidates WHERE run_id = ? ORDER BY seq ASC').all(runId) as Array<{ id: string, seq: number, cost: number | null }>
    },

    insertRecommendation(input: {
      id: string, runId: string, candidateId: string, problemIrHash: string, modelArtifactHash: string
      evidenceSource: 'simulation' | 'real' | 'unassessed', uqEvidence: Record<string, unknown> | null
      status: RecommendationStatus, validUntil: string
    }): Recommendation {
      const now = new Date().toISOString()
      const label = recommendationLabel(input.status)
      db.prepare(`INSERT INTO optimizer_recommendations
        (id, run_id, candidate_id, problem_ir_hash, model_artifact_hash, evidence_source, uq_evidence_json,
         status, status_label, legacy, valid_until, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`)
        .run(input.id, input.runId, input.candidateId, input.problemIrHash, input.modelArtifactHash,
          input.evidenceSource, input.uqEvidence ? JSON.stringify(input.uqEvidence) : null,
          input.status, label, input.validUntil, now)
      return this.getRecommendation(input.id)!
    },

    getRecommendation(id: string): Recommendation | undefined {
      const r = db.prepare(`SELECT id, run_id AS runId, candidate_id AS candidateId, problem_ir_hash AS problemIrHash,
        model_artifact_hash AS modelArtifactHash, evidence_source AS evidenceSource, uq_evidence_json AS uqEvidenceJson,
        status, status_label AS statusLabel, valid_until AS validUntil, created_at AS createdAt
        FROM optimizer_recommendations WHERE id = ?`).get(id) as Record<string, unknown> | undefined
      if (!r) return undefined
      return {
        id: String(r.id), runId: String(r.runId), candidateId: String(r.candidateId),
        problemIrHash: String(r.problemIrHash), modelArtifactHash: String(r.modelArtifactHash),
        evidenceSource: String(r.evidenceSource) as Recommendation['evidenceSource'],
        uqEvidence: r.uqEvidenceJson ? JSON.parse(String(r.uqEvidenceJson)) as Record<string, unknown> : null,
        status: String(r.status) as RecommendationStatus, statusLabel: String(r.statusLabel || recommendationLabel(String(r.status) as RecommendationStatus)),
        validUntil: String(r.validUntil), createdAt: String(r.createdAt),
      }
    },

    latestRecommendationForRun(runId: string): Recommendation | undefined {
      const r = db.prepare('SELECT id FROM optimizer_recommendations WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(runId) as { id: string } | undefined
      return r ? this.getRecommendation(r.id) : undefined
    },

    /** 失效:工况/配方/权限/revison 变化 → 旧建议 expired(不删除,保留审计)。 */
    expireWhere(filter: { bindingId?: string, runId?: string, problemIrHash?: string }): number {
      const where: string[] = ['status != \'expired\'']
      const args: unknown[] = []
      if (filter.runId) { where.push('run_id = ?'); args.push(filter.runId) }
      if (filter.problemIrHash) { where.push('problem_ir_hash = ?'); args.push(filter.problemIrHash) }
      if (filter.bindingId) { where.push('run_id IN (SELECT id FROM optimizer_runs WHERE binding_id = ?)'); args.push(filter.bindingId) }
      const r = db.prepare(`UPDATE optimizer_recommendations SET status = 'expired', status_label = ? WHERE ${where.join(' AND ')}`)
        .run(recommendationLabel('expired'), ...(args as never[]))
      return Number(r.changes)
    },

    insertOutcome(input: { id: string, recommendationId: string, appliedAt: string | null, observed: Record<string, unknown>, delta: Record<string, unknown>, verdict: string }): void {
      db.prepare(`INSERT INTO optimizer_outcomes (id, recommendation_id, applied_at, observed_json, delta_json, verdict, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.recommendationId, input.appliedAt, JSON.stringify(input.observed), JSON.stringify(input.delta), input.verdict, new Date().toISOString())
    },

    listOutcomes(recommendationId: string): Array<{ id: string, verdict: string, delta: Record<string, unknown>, appliedAt: string | null }> {
      return (db.prepare('SELECT id, verdict, delta_json AS delta, applied_at AS appliedAt FROM optimizer_outcomes WHERE recommendation_id = ? ORDER BY created_at ASC').all(recommendationId) as Array<{ id: string, verdict: string, delta: string, appliedAt: string | null }>)
        .map(r => ({ id: r.id, verdict: r.verdict, delta: JSON.parse(r.delta) as Record<string, unknown>, appliedAt: r.appliedAt }))
    },
  }
}

export type RunRepo = ReturnType<typeof createRunRepo>

const g = globalThis as typeof globalThis & { __optimizerRunRepo?: RunRepo }

export function getRunRepo(): RunRepo {
  g.__optimizerRunRepo ??= createRunRepo(getAmlRuntime().db)
  return g.__optimizerRunRepo
}
