/**
 * Ontology 仓储(版本快照不可变 + 草稿单活跃 + 证据/日志/溯源追加行)。
 *
 * 约定对齐 process_model_specs / optimizer_profiles:
 *  - (id, version) 主键;published 行服务层拒改;
 *  - 草稿是**整份 JSON 文档**(服务层不散改行),发布时物化为不可变快照;
 *  - 证据、发布日志、规则溯源为 append-only 追加行。
 */
import type { DatabaseSync } from 'node:sqlite'
import { AppError } from '../../../utils/errors'
import { getAmlRuntime } from '../aml/runtime'
import { withTransaction } from '../db/transaction'
import type { ControlGuard, OntologyDraftDoc, OntologyEntity, OntologyRelation, OntologyRule, OntologyRuleTrace, BindingDraft } from './contracts'

export type VersionStatus = 'draft' | 'published' | 'retired'

export interface DraftRow {
  id: string
  ontologyId: string
  baseVersion: number | null
  rev: number
  draftJson: string
  ownerUserId: string
  createdAt: string
  updatedAt: string
}

export interface VersionRow {
  id: string
  version: number
  name: string
  lineId: string
  parentVersion: number | null
  contentHash: string
  compiledJson: string
  changelogJson: string
  status: VersionStatus
  ownerUserId: string
  publishedBy: string
  createdAt: string
  updatedAt: string
}

export interface EvidenceRow {
  id: string
  ontologyId: string
  targetKind: string
  targetKey: string
  level: string
  sourceType: string
  sourceRef: string
  sourceRefHash: string
  detailJson: string
  createdBy: string
  createdAt: string
}

export interface PublishLogRow {
  id: string
  ontologyId: string
  version: number
  action: string
  actor: string
  actorKind: string
  soloOperator: number
  approvalId: string | null
  detailJson: string
  createdAt: string
}

export interface BindingRow {
  id: string
  versionId: string
  version: number
  entityKey: string
  platformKind: string
  platformId: string
  targetSub: string
  scope: string
  direction: string
  unitDeclared: string
  unitTarget: string
  scale: number
  offset: number
  status: string
  lastVerifiedAt: string | null
  createdAt: string
}

const DRAFT_COLS = `id, ontology_id AS ontologyId, base_version AS baseVersion, rev,
  draft_json AS draftJson, owner_user_id AS ownerUserId, created_at AS createdAt, updated_at AS updatedAt`

const VERSION_COLS = `id, version, name, line_id AS lineId, parent_version AS parentVersion,
  content_hash AS contentHash, compiled_json AS compiledJson, changelog_json AS changelogJson,
  status, owner_user_id AS ownerUserId, published_by AS publishedBy,
  created_at AS createdAt, updated_at AS updatedAt`

export function createOntologyRepo(db: DatabaseSync) {
  const repo = {
    // ===== 草稿 =====
    insertDraft(input: { id: string, ontologyId: string, baseVersion: number | null, draftJson: string, ownerUserId: string }): DraftRow {
      const now = new Date().toISOString()
      const existing = db.prepare(`SELECT ${DRAFT_COLS} FROM ontology_drafts WHERE ontology_id = ? AND owner_user_id = ?`)
        .get(input.ontologyId, input.ownerUserId) as DraftRow | undefined
      if (existing) {
        throw new AppError(409, 'DRAFT_ALREADY_ACTIVE',
          `本体 ${input.ontologyId} 已存在活跃草稿(${existing.id}, rev=${existing.rev});请继续编辑或先删除该草稿`)
      }
      db.prepare(`INSERT INTO ontology_drafts (id, ontology_id, base_version, rev, draft_json, owner_user_id, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(input.id, input.ontologyId, input.baseVersion, input.draftJson, input.ownerUserId, now, now)
      return repo.getDraft(input.id)!
    },

    getDraft(id: string): DraftRow | undefined {
      return db.prepare(`SELECT ${DRAFT_COLS} FROM ontology_drafts WHERE id = ?`).get(id) as DraftRow | undefined
    },

    getActiveDraft(ontologyId: string, ownerUserId: string): DraftRow | undefined {
      return db.prepare(`SELECT ${DRAFT_COLS} FROM ontology_drafts WHERE ontology_id = ? AND owner_user_id = ?`)
        .get(ontologyId, ownerUserId) as DraftRow | undefined
    },

    listDrafts(filter: { ownerUserId?: string, ontologyId?: string } = {}): DraftRow[] {
      const where: string[] = []
      const params: Array<string> = []
      if (filter.ownerUserId) {
        where.push('owner_user_id = ?')
        params.push(filter.ownerUserId)
      }
      if (filter.ontologyId) {
        where.push('ontology_id = ?')
        params.push(filter.ontologyId)
      }
      const sql = `SELECT ${DRAFT_COLS} FROM ontology_drafts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 200`
      return db.prepare(sql).all(...params) as unknown as DraftRow[]
    },

    /** 乐观锁:rev 不匹配 → 409(并发编辑必须显式重读) */
    updateDraft(id: string, draftJson: string, expectedRev: number): DraftRow {
      const current = repo.getDraft(id)
      if (!current) throw new AppError(404, 'DRAFT_NOT_FOUND', `草稿 ${id} 不存在`)
      if (current.rev !== expectedRev) {
        throw new AppError(409, 'DRAFT_CONCURRENT_MODIFY',
          `草稿 ${id} 已被修改(期望 rev=${expectedRev},当前 rev=${current.rev});请重新读取后再提交`)
      }
      const now = new Date().toISOString()
      const changes = db.prepare('UPDATE ontology_drafts SET draft_json = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?')
        .run(draftJson, now, id, expectedRev).changes
      if (changes === 0) throw new AppError(409, 'DRAFT_CONCURRENT_MODIFY', `草稿 ${id} 并发修改冲突`)
      return repo.getDraft(id)!
    },

    updateDraftMeta(id: string, patch: { baseVersion?: number | null }): void {
      const now = new Date().toISOString()
      if (patch.baseVersion !== undefined) {
        db.prepare('UPDATE ontology_drafts SET base_version = ?, updated_at = ? WHERE id = ?').run(patch.baseVersion, now, id)
      }
    },

    deleteDraft(id: string): boolean {
      return db.prepare('DELETE FROM ontology_drafts WHERE id = ?').run(id).changes > 0
    },

    // ===== 版本 =====
    getVersion(id: string, version: number): VersionRow | undefined {
      return db.prepare(`SELECT ${VERSION_COLS} FROM ontology_versions WHERE id = ? AND version = ?`)
        .get(id, version) as VersionRow | undefined
    },

    listVersions(id: string): VersionRow[] {
      return db.prepare(`SELECT ${VERSION_COLS} FROM ontology_versions WHERE id = ? ORDER BY version DESC`)
        .all(id) as unknown as VersionRow[]
    },

    latestVersion(id: string, status?: VersionStatus): VersionRow | undefined {
      const row = status
        ? db.prepare(`SELECT ${VERSION_COLS} FROM ontology_versions WHERE id = ? AND status = ? ORDER BY version DESC LIMIT 1`).get(id, status)
        : db.prepare(`SELECT ${VERSION_COLS} FROM ontology_versions WHERE id = ? ORDER BY version DESC LIMIT 1`).get(id)
      return row as VersionRow | undefined
    },

    nextVersionNumber(id: string): number {
      const row = db.prepare('SELECT MAX(version) AS maxVersion FROM ontology_versions WHERE id = ?').get(id) as { maxVersion: number | null } | undefined
      return (row?.maxVersion ?? 0) + 1
    },

    /** 某产线当前生效的已发布版本(该线最新的 published;退役版本自然被跳过) */
    latestPublishedForLine(lineId: string): VersionRow | undefined {
      return db.prepare(`SELECT ${VERSION_COLS} FROM ontology_versions
        WHERE line_id = ? AND status = 'published' ORDER BY version DESC, updated_at DESC LIMIT 1`)
        .get(lineId) as VersionRow | undefined
    },

    listAllOntologyIds(lineId?: string): Array<{ id: string, lineId: string, versions: number, latest: number, status: string }> {
      const sql = `SELECT v.id AS id, MAX(v.line_id) AS lineId, COUNT(*) AS versions, MAX(v.version) AS latest,
        (SELECT status FROM ontology_versions v2 WHERE v2.id = v.id ORDER BY v2.version DESC LIMIT 1) AS status
        FROM ontology_versions v ${lineId ? 'WHERE v.line_id = ?' : ''} GROUP BY v.id ORDER BY MAX(v.updated_at) DESC LIMIT 200`
      return (lineId ? db.prepare(sql).all(lineId) : db.prepare(sql).all()) as Array<{ id: string, lineId: string, versions: number, latest: number, status: string }>
    },

    /** 发布快照:版本行 + 实体/关系/规则/绑定 + 溯源,单事务原子落库 */
    publishSnapshot(input: {
      version: VersionRow
      entities: OntologyEntity[]
      relations: OntologyRelation[]
      rules: OntologyRule[]
      bindings: BindingDraft[]
      traces: OntologyRuleTrace[]
      guards: ControlGuard[]
      createdBy: string
    }): VersionRow {
      return withTransaction(db, () => {
        const now = new Date().toISOString()
        db.prepare(`INSERT INTO ontology_versions
          (id, version, name, line_id, parent_version, content_hash, compiled_json, changelog_json,
           status, owner_user_id, published_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.version.id, input.version.version, input.version.name, input.version.lineId,
            input.version.parentVersion, input.version.contentHash, input.version.compiledJson,
            input.version.changelogJson, input.version.status, input.version.ownerUserId,
            input.version.publishedBy, now, now)

        const entityStmt = db.prepare(`INSERT INTO ontology_entities
          (version_id, version, entity_key, kind, name, description, unit, dimension, role, attributes_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const entity of input.entities) {
          entityStmt.run(input.version.id, input.version.version, entity.key, entity.kind, entity.name,
            entity.description, entity.unit, entity.dimension, entity.role ?? '', JSON.stringify(entity.attrs), now)
        }

        const relationStmt = db.prepare(`INSERT INTO ontology_relations
          (id, version_id, version, src_key, dst_key, predicate, properties_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const rel of input.relations) {
          relationStmt.run(rel.id, input.version.id, input.version.version, rel.srcKey, rel.dstKey, rel.kind,
            JSON.stringify({ ...rel.properties, evidence: rel.evidence }), rel.status, now)
        }

        const ruleStmt = db.prepare(`INSERT INTO ontology_rules
          (id, version_id, version, rule_key, kind, dsl_json, constraint_level, severity, status, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const rule of input.rules) {
          ruleStmt.run(rule.id, input.version.id, input.version.version, rule.key, rule.kind,
            JSON.stringify({ dsl: rule.dsl, evidence: rule.evidence, scope: rule.scope }),
            rule.constraintLevel, rule.severity, rule.status, rule.description, now)
        }

        const bindingStmt = db.prepare(`INSERT INTO ontology_semantic_bindings
          (id, version_id, version, entity_key, platform_kind, platform_id, target_sub, scope, direction,
           unit_declared, unit_target, scale, offset, status, last_verified_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        for (const binding of input.bindings) {
          bindingStmt.run(binding.id, input.version.id, input.version.version, binding.entityKey,
            binding.platformKind, binding.platformId, binding.targetSub, binding.scope, binding.direction,
            binding.unitDeclared, binding.unitTarget, binding.scale, binding.offset, now, now)
        }

        const traceStmt = db.prepare(`INSERT INTO ontology_rule_traces
          (id, ontology_id, version, rule_pack_hash, rule_id, rule_revision, rule_kind, evidence_level,
           constraint_level, decision, decision_code, message, bindings_json, artifacts_json, scope_json, row_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const trace of input.traces) {
          traceStmt.run(trace.id, trace.ontologyId, trace.version, trace.rulePackHash, trace.ruleId,
            trace.ruleRevision, trace.ruleKind, trace.evidenceLevel, trace.constraintLevel, trace.decision,
            trace.decisionCode, trace.message, JSON.stringify(trace.bindings), JSON.stringify(trace.artifacts),
            JSON.stringify(trace.scope), trace.rowHash, trace.createdAt)
        }
        return repo.getVersion(input.version.id, input.version.version)!
      })
    },

    /** 状态原子转移(条件 UPDATE;changes=0 → 409 由调用方判定) */
    transitionVersion(id: string, version: number, to: VersionStatus, from: VersionStatus): boolean {
      const now = new Date().toISOString()
      return db.prepare('UPDATE ontology_versions SET status = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?')
        .run(to, now, id, version, from).changes > 0
    },

    listEntities(versionId: string, version: number): OntologyEntity[] {
      const rows = db.prepare(`SELECT entity_key AS key, kind, name, description, unit, dimension, role, attributes_json AS attrsJson
        FROM ontology_entities WHERE version_id = ? AND version = ? ORDER BY entity_key`).all(versionId, version) as Array<Record<string, string>>
      return rows.map(r => ({
        key: r.key!, kind: r.kind as OntologyEntity['kind'], name: r.name!, description: r.description ?? '',
        unit: r.unit ?? '', dimension: r.dimension ?? '',
        role: (r.role || undefined) as OntologyEntity['role'],
        attrs: JSON.parse(r.attrsJson || '{}') as OntologyEntity['attrs'],
      }))
    },

    listRelations(versionId: string, version: number): OntologyRelation[] {
      const rows = db.prepare(`SELECT id, src_key AS srcKey, dst_key AS dstKey, predicate, properties_json AS propsJson, status
        FROM ontology_relations WHERE version_id = ? AND version = ? ORDER BY id`).all(versionId, version) as Array<Record<string, string>>
      return rows.map((r) => {
        const props = JSON.parse(r.propsJson || '{}') as Record<string, unknown>
        return {
          id: r.id!, kind: r.predicate as OntologyRelation['kind'], srcKey: r.srcKey!, dstKey: r.dstKey!,
          status: (r.status ?? 'proposed') as OntologyRelation['status'],
          evidence: Array.isArray(props.evidence) ? props.evidence as OntologyRelation['evidence'] : [],
          properties: {
            sign: props.sign as OntologyRelation['properties']['sign'],
            gainPerUnit: props.gainPerUnit as number | undefined,
            lagMs: props.lagMs as number | undefined,
            evidenceTier: (props.evidenceTier ?? 'candidate_influence') as OntologyRelation['properties']['evidenceTier'],
            variabilityChecked: !!props.variabilityChecked,
            transportDistanceM: props.transportDistanceM as number | undefined,
            nominalSpeedMps: props.nominalSpeedMps as number | undefined,
            controlApplicability: props.controlApplicability as OntologyRelation['properties']['controlApplicability'],
          },
        }
      })
    },

    listRules(versionId: string, version: number): OntologyRule[] {
      const rows = db.prepare(`SELECT id, rule_key AS ruleKey, kind, dsl_json AS dslJson, constraint_level AS constraintLevel,
        severity, status, description FROM ontology_rules WHERE version_id = ? AND version = ? ORDER BY id`)
        .all(versionId, version) as Array<Record<string, string>>
      return rows.map((r) => {
        const parsed = JSON.parse(r.dslJson || '{}') as { dsl?: unknown, evidence?: OntologyRule['evidence'], scope?: OntologyRule['scope'] }
        return {
          id: r.id!, key: r.ruleKey!, kind: r.kind as OntologyRule['kind'],
          dsl: parsed.dsl as OntologyRule['dsl'],
          constraintLevel: (r.constraintLevel ?? 'soft') as OntologyRule['constraintLevel'],
          severity: (r.severity ?? 'error') as OntologyRule['severity'],
          status: (r.status ?? 'proposed') as OntologyRule['status'],
          evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
          description: r.description ?? '',
          scope: parsed.scope ?? { lineId: '', recipeId: '', conditionId: '' },
        }
      })
    },

    listBindings(versionId: string, version: number): BindingRow[] {
      return db.prepare(`SELECT id, version_id AS versionId, version, entity_key AS entityKey,
        platform_kind AS platformKind, platform_id AS platformId, target_sub AS targetSub, scope, direction,
        unit_declared AS unitDeclared, unit_target AS unitTarget, scale, offset, status,
        last_verified_at AS lastVerifiedAt, created_at AS createdAt
        FROM ontology_semantic_bindings WHERE version_id = ? AND version = ? ORDER BY entity_key, platform_kind`)
        .all(versionId, version) as unknown as BindingRow[]
    },

    listBindingsByTarget(platformKind: string, platformId: string): BindingRow[] {
      return db.prepare(`SELECT id, version_id AS versionId, version, entity_key AS entityKey,
        platform_kind AS platformKind, platform_id AS platformId, target_sub AS targetSub, scope, direction,
        unit_declared AS unitDeclared, unit_target AS unitTarget, scale, offset, status,
        last_verified_at AS lastVerifiedAt, created_at AS createdAt
        FROM ontology_semantic_bindings WHERE platform_kind = ? AND platform_id = ? AND status = 'active'`)
        .all(platformKind, platformId) as unknown as BindingRow[]
    },

    markBindingStatus(id: string, status: 'active' | 'drifted' | 'retired'): void {
      const now = new Date().toISOString()
      db.prepare('UPDATE ontology_semantic_bindings SET status = ?, last_verified_at = ? WHERE id = ?').run(status, now, id)
    },

    // ===== 证据 =====
    appendEvidence(row: EvidenceRow): void {
      db.prepare(`INSERT INTO ontology_evidence
        (id, ontology_id, target_kind, target_key, level, source_type, source_ref, source_ref_hash, detail_json, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.ontologyId, row.targetKind, row.targetKey, row.level, row.sourceType,
          row.sourceRef, row.sourceRefHash, row.detailJson, row.createdBy, row.createdAt)
    },

    listEvidence(ontologyId: string, filter: { targetKind?: string, targetKey?: string, limit?: number } = {}): EvidenceRow[] {
      const where = ['ontology_id = ?']
      const params: Array<string | number> = [ontologyId]
      if (filter.targetKind) {
        where.push('target_kind = ?')
        params.push(filter.targetKind)
      }
      if (filter.targetKey) {
        where.push('target_key = ?')
        params.push(filter.targetKey)
      }
      params.push(filter.limit ?? 200)
      return db.prepare(`SELECT id, ontology_id AS ontologyId, target_kind AS targetKind, target_key AS targetKey,
        level, source_type AS sourceType, source_ref AS sourceRef, source_ref_hash AS sourceRefHash,
        detail_json AS detailJson, created_by AS createdBy, created_at AS createdAt
        FROM ontology_evidence WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as unknown as EvidenceRow[]
    },

    // ===== 发布日志 =====
    appendPublishLog(row: PublishLogRow): void {
      db.prepare(`INSERT INTO ontology_publish_log
        (id, ontology_id, version, action, actor, actor_kind, solo_operator, approval_id, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.ontologyId, row.version, row.action, row.actor, row.actorKind,
          row.soloOperator, row.approvalId, row.detailJson, row.createdAt)
    },

    listPublishLog(ontologyId: string, limit = 100): PublishLogRow[] {
      return db.prepare(`SELECT id, ontology_id AS ontologyId, version, action, actor, actor_kind AS actorKind,
        solo_operator AS soloOperator, approval_id AS approvalId, detail_json AS detailJson, created_at AS createdAt
        FROM ontology_publish_log WHERE ontology_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(ontologyId, limit) as unknown as PublishLogRow[]
    },

    // ===== 规则溯源 =====
    listTraces(ontologyId: string, version?: number, limit = 500): OntologyRuleTrace[] {
      const where = ['ontology_id = ?']
      const params: Array<string | number> = [ontologyId]
      if (version !== undefined) {
        where.push('version = ?')
        params.push(version)
      }
      params.push(limit)
      const rows = db.prepare(`SELECT id, ontology_id AS ontologyId, version, rule_pack_hash AS rulePackHash,
        rule_id AS ruleId, rule_revision AS ruleRevision, rule_kind AS ruleKind, evidence_level AS evidenceLevel,
        constraint_level AS constraintLevel, decision, decision_code AS decisionCode, message,
        bindings_json AS bindingsJson, artifacts_json AS artifactsJson, scope_json AS scopeJson,
        row_hash AS rowHash, created_at AS createdAt
        FROM ontology_rule_traces WHERE ${where.join(' AND ')} ORDER BY rule_id LIMIT ?`)
        .all(...params) as Array<Record<string, string | number>>
      return rows.map(r => ({
        id: String(r.id), ontologyId: String(r.ontologyId), version: Number(r.version),
        rulePackHash: String(r.rulePackHash), ruleId: String(r.ruleId), ruleKey: String(r.ruleId),
        ruleRevision: String(r.ruleRevision), ruleKind: String(r.ruleKind) as OntologyRuleTrace['ruleKind'],
        evidenceLevel: String(r.evidenceLevel ?? '') as OntologyRuleTrace['evidenceLevel'],
        constraintLevel: String(r.constraintLevel) as OntologyRuleTrace['constraintLevel'],
        decision: String(r.decision) as OntologyRuleTrace['decision'],
        decisionCode: String(r.decisionCode), message: String(r.message),
        bindings: JSON.parse(String(r.bindingsJson || '[]')) as OntologyRuleTrace['bindings'],
        artifacts: JSON.parse(String(r.artifactsJson || '[]')) as OntologyRuleTrace['artifacts'],
        scope: JSON.parse(String(r.scopeJson || '{}')) as OntologyRuleTrace['scope'],
        rowHash: String(r.rowHash), createdAt: String(r.createdAt),
      }))
    },
  }
  return repo
}

let cached: ReturnType<typeof createOntologyRepo> | null = null

/** 进程级仓储(单连接:workshop 只有一条主连接) */
export function getOntologyRepo(): ReturnType<typeof createOntologyRepo> {
  if (!cached) cached = createOntologyRepo(getAmlRuntime().db)
  return cached
}

/** 测试/重连后重置(单测在 fresh home 打开新库时调用) */
export function resetOntologyRepo(): void {
  cached = null
}

export function parseDraftRow(row: DraftRow): OntologyDraftDoc {
  return JSON.parse(row.draftJson) as OntologyDraftDoc
}
