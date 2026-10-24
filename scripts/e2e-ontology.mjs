#!/usr/bin/env tsx
/**
 * e2e-ontology —— 本体全流程集成验收(ON1..ON12)。
 *
 * 覆盖:草稿 → 文档写入 → 结构+活体校验 → 编译预览 → 证据登记 → 审查 →
 *       系统验证 → 第二人批准 → 控制级批准 → 发布冻结 → 运行时解析 →
 *       运行时守卫阻断下发意图 → 版本 diff → 退役 → Profile 漂移拒绝 → 审计留痕。
 *
 * 说明:REST 路由是同一服务层的薄封装(defineApiHandler + requireRole),本轮以服务层
 *       直驱完成全流程;HTTP 面由 typecheck + 路由文件存在性 + i18n 门禁覆盖,
 *       下一轮可加真机 HTTP 冒烟。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-e2e-ontology-'))
process.env.AW_ONTOLOGY_SOLO_OPERATOR = '0'

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open.ts')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime.ts')
const { resetOntologyRepo, getOntologyRepo } = await import('../server/services/workshop/ontology/repo.ts')
const svc = await import('../server/services/workshop/ontology/ontology.service.ts')
const { parseDraftDoc } = await import('../server/services/workshop/ontology/contracts.ts')

const db = openWorkshopDb(join(process.env.AW_HOME, 'workshop.sqlite'))
configureAmlRuntime(db)
resetOntologyRepo()

const OWNER = { userId: 'u-owner', role: 'editor' }
const REVIEWER = { userId: 'u-reviewer', role: 'editor' }
const ADMIN = { userId: 'u-admin', role: 'admin' }

const LINE = 'ln-e2e-pva'
const ONT = 'ont-e2e-pva'
const results = []
let pass = 0
let fail = 0

function check(id, name, cond, detail = '') {
  if (cond) {
    pass += 1
    results.push({ id, name, ok: true, detail })
  }
  else {
    fail += 1
    results.push({ id, name, ok: false, detail })
  }
  const mark = cond ? '✔' : '✘'
  console.log(`${mark} ${id} ${name}${detail ? ` — ${detail}` : ''}`)
}

function expectError(fn, code) {
  try {
    fn()
    return { ok: false, code: '(no throw)' }
  }
  catch (err) {
    return { ok: err?.code === code, code: err?.code ?? String(err) }
  }
}

function evidence(level, id) {
  if (level === 'validated_control') {
    return { id, level, source: { type: 'optimizer_run', runId: 'run-e2e', problemIrHash: 'ir-e2e', modelArtifactHash: 'mdl-e2e' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }
  }
  if (level === 'observed_correlation') {
    return { id, level, source: { type: 'dataset_stats', datasetId: 'ds-e2e', sha256: 'sha-e2e' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }
  }
  return { id, level, source: { type: 'expert_note', author: 'engineer', noteId: 'note-e2e' }, sourceRefHash: 'h', createdAt: new Date().toISOString() }
}

function doc() {
  return {
    schemaVersion: 1,
    name: 'PVA e2e 本体',
    lineId: LINE,
    entities: [
      { key: 'pv.melt_pressure', kind: 'process_variable', name: '熔体压力', description: '', unit: 'bar', dimension: 'pressure', role: 'control', attrs: { dataType: 'number' } },
      { key: 'cv.thickness', kind: 'quality_variable', name: '平均膜厚', description: '', unit: 'mm', dimension: 'length', role: 'target', attrs: { dataType: 'number' } },
      { key: 'st.line_speed', kind: 'process_variable', name: '线速度', description: '', unit: 'm', dimension: 'length', role: 'control', attrs: { dataType: 'number' } },
      { key: 'st.zone_temp', kind: 'process_variable', name: '温区温度', description: '', unit: '℃', dimension: 'temperature', role: 'state', attrs: { dataType: 'number' } },
    ],
    relations: [
      {
        id: 'rel-1', kind: 'influences', srcKey: 'pv.melt_pressure', dstKey: 'cv.thickness', status: 'validated',
        evidence: [evidence('validated_control', 'ev-rel')],
        properties: { sign: 'negative', gainPerUnit: -0.4, lagMs: 45000, evidenceTier: 'validated_control', variabilityChecked: true },
      },
      {
        id: 'rel-2', kind: 'influences', srcKey: 'st.line_speed', dstKey: 'cv.thickness', status: 'proposed',
        evidence: [evidence('candidate_influence', 'ev-rel2')],
        properties: { evidenceTier: 'candidate_influence', variabilityChecked: false, transportDistanceM: 10, nominalSpeedMps: 0.5 },
      },
    ],
    rules: [
      {
        id: 'R-BOUND', key: 'thickness-window', kind: 'bound',
        dsl: { type: 'bound', variableKey: 'cv.thickness', min: 48, max: 52, unit: 'mm' },
        constraintLevel: 'hard', severity: 'error', status: 'proposed',
        evidence: [evidence('validated_control', 'ev-bound-imported')], description: '膜厚工艺窗', scope: { lineId: LINE, recipeId: 'rc-e2e', conditionId: '' },
      },
      {
        id: 'R-GUARD', key: 'cold-zone-no-speedup', kind: 'state_condition',
        dsl: {
          type: 'state_condition',
          when: { variableKey: 'st.zone_temp', op: 'lt', value: 180 },
          forbid: { kind: 'positive_increment', variableKey: 'st.line_speed' },
          message: '温区未达 180℃,禁止提速',
        },
        constraintLevel: 'hard', severity: 'error', status: 'proposed',
        evidence: [evidence('validated_control', 'ev-guard-imported')], description: '冷区禁提速', scope: { lineId: LINE, recipeId: 'rc-e2e', conditionId: '' },
      },
      {
        id: 'R-INTERLOCK', key: 'estop', kind: 'interlock',
        dsl: { type: 'interlock', text: '急停回路动作时禁止任何写控' },
        constraintLevel: 'hard', severity: 'error', status: 'proposed',
        evidence: [], description: '安全联锁归 PLC', scope: { lineId: LINE, recipeId: '', conditionId: '' },
      },
    ],
    bindings: [],
    note: 'e2e',
  }
}

// ── ON1 草稿与文档写入 ──
const draft = svc.createDraft(OWNER, { ontologyId: ONT, lineId: LINE })
check('ON1.1', '创建草稿(rev=1, 单活跃)', draft.rev === 1 && draft.ontologyId === ONT)
const dup = expectError(() => svc.createDraft(OWNER, { ontologyId: ONT, lineId: LINE }), 'DRAFT_ALREADY_ACTIVE')
check('ON1.2', '同本体同属主二次起草被拒(409)', dup.ok, dup.code)

const parsed = parseDraftDoc(doc())
const saved = svc.updateDraft(draft.id, OWNER, { doc: parsed, expectedRev: draft.rev })
check('ON1.3', '整份文档写入并通过结构校验', saved.draft.rev === 2 && saved.validation.ok === true)
const stale = expectError(() => svc.updateDraft(draft.id, OWNER, { doc: parsed, expectedRev: 1 }), 'DRAFT_CONCURRENT_MODIFY')
check('ON1.4', '过期 rev 写入被拒(乐观锁 409)', stale.ok, stale.code)
const scopeDeny = expectError(() => svc.updateDraft(draft.id, REVIEWER, { doc: parsed, expectedRev: 2 }), 'DRAFT_SCOPE_VIOLATION')
check('ON1.5', '非属主编辑被拒(403)', scopeDeny.ok, scopeDeny.code)

// ── ON2 编译预览与活体绑定负例 ──
const preview = svc.compileDraft(draft.id, OWNER)
check('ON2.1', '编译预览:状态 warning(含 PLC 解释项)且四类产物齐备',
  preview.result.status === 'warning' && !!preview.result.artifacts.problemIr && !!preview.result.artifacts.controlGuard
  && !!preview.result.artifacts.processModel && !!preview.result.artifacts.sceneContract,
  `status=${preview.result.status}`)
check('ON2.2', '每条规则都有 trace(fail-closed 不静默丢弃)',
  preview.result.traces.length === parsed.rules.length,
  `traces=${preview.result.traces.length}/rules=${parsed.rules.length}`)
check('ON2.3', '膜厚窗落入 cvBounds(只收紧前的预览)',
  preview.result.artifacts.problemIr.cvBounds['cv.thickness']?.min === 48)
check('ON2.4', '联锁规则归 PLC 解释层(不产数值约束)',
  preview.result.traces.find(t => t.ruleId === 'R-INTERLOCK')?.decisionCode === 'PLC_LAYER_REQUIRED')
check('ON2.5', '关系派生训练先验:特征候选≥2、时滞含 τ=D/v',
  preview.result.artifacts.processModel.featureCandidates.length >= 2
  && preview.result.artifacts.processModel.delayPriors.some(d => d.basis === 'tau_eq_D_over_v'),
  `features=${preview.result.artifacts.processModel.featureCandidates.length}`)

// 活体绑定负例:绑定到不存在的数控节点 → 发布/写入必须拒绝
const badDoc = JSON.parse(JSON.stringify(parsed))
badDoc.bindings = [{
  id: 'b-missing', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node', platformId: 'n-not-exist',
  targetSub: '', scope: `line:${LINE}`, direction: 'write', unitDeclared: 'bar', unitTarget: 'bar', scale: 1, offset: 0,
}]
const bindingDeny = expectError(() => svc.updateDraft(draft.id, OWNER, { doc: badDoc, expectedRev: 2 }), 'ONTOLOGY_BINDING_INVALID')
check('ON2.6', '语义绑定活体校验:目标不存在 → 拒绝落库', bindingDeny.ok, bindingDeny.code)

// ── ON3 证据登记 ──
const evBound = svc.appendEvidence(draft.id, OWNER, {
  targetKind: 'rule', targetKey: 'R-BOUND', level: 'validated_control',
  source: { type: 'optimizer_run', runId: 'run-e2e', problemIrHash: 'ir-e2e', modelArtifactHash: 'mdl-e2e' },
  sourceRef: 'run-e2e',
})
svc.appendEvidence(draft.id, OWNER, {
  targetKind: 'rule', targetKey: 'R-GUARD', level: 'validated_control',
  source: { type: 'optimizer_run', runId: 'run-e2e-guard', problemIrHash: 'ir-e2e', modelArtifactHash: 'mdl-e2e' },
  sourceRef: 'run-e2e-guard',
})
check('ON3.1', '证据登记写回草稿(1→2)并留账本',
  evBound.doc.rules.find(r => r.id === 'R-BOUND').evidence.length === 2
  && svc.listEvidence(ONT, { targetKind: 'rule', targetKey: 'R-BOUND' }).length === 1)

// ── ON4 生命周期与第二人批准 ──
const jump = expectError(() => svc.transitionRule(draft.id, 'R-BOUND', OWNER, { to: 'validated' }), 'RULE_LIFECYCLE_CONFLICT')
check('ON4.1', '跳级迁移被拒(409)', jump.ok, jump.code)
const selfReview = expectError(() => svc.transitionRule(draft.id, 'R-BOUND', OWNER, { to: 'reviewed' }), 'SELF_REVIEW_FORBIDDEN')
check('ON4.2', '起草人自审被拒(403)', selfReview.ok, selfReview.code)
svc.transitionRule(draft.id, 'R-BOUND', REVIEWER, { to: 'reviewed' })
svc.transitionRule(draft.id, 'R-GUARD', REVIEWER, { to: 'reviewed' })
const validated = svc.transitionRule(draft.id, 'R-BOUND', REVIEWER, { to: 'validated' })
svc.transitionRule(draft.id, 'R-GUARD', REVIEWER, { to: 'validated' })
check('ON4.3', '第二人完成 reviewed → validated', validated.doc.rules.find(r => r.id === 'R-BOUND').status === 'validated')
const noApproval = expectError(() => svc.transitionRule(draft.id, 'R-BOUND', ADMIN, { to: 'approved_for_control' }), 'APPROVAL_REQUIRED')
check('ON4.4', '无批准单不能进入控制级(403)', noApproval.ok, noApproval.code)

const approvals = {}
for (const ruleId of ['R-BOUND', 'R-GUARD']) {
  const { approvalId } = svc.requestRuleApproval(draft.id, ruleId, OWNER)
  approvals[ruleId] = approvalId
}
const selfDecide = expectError(() => svc.decideRuleApproval(draft.id, approvals['R-BOUND'], OWNER, { approved: true }), 'SELF_REVIEW_FORBIDDEN')
check('ON4.5', '申请人不能自我裁决(403)', selfDecide.ok, selfDecide.code)
svc.decideRuleApproval(draft.id, approvals['R-BOUND'], REVIEWER, { approved: true, comment: '工艺确认' })
svc.decideRuleApproval(draft.id, approvals['R-GUARD'], REVIEWER, { approved: true, comment: '安全确认' })
const approved = svc.transitionRule(draft.id, 'R-BOUND', ADMIN, { to: 'approved_for_control', approvalId: approvals['R-BOUND'] })
svc.transitionRule(draft.id, 'R-GUARD', ADMIN, { to: 'approved_for_control', approvalId: approvals['R-GUARD'] })
check('ON4.6', '第二人批准后可进入 approved_for_control',
  approved.doc.rules.find(r => r.id === 'R-BOUND').status === 'approved_for_control')

// ── ON5 发布(仅 admin)与不可变快照 ──
const editorPublish = expectError(() => svc.publishDraft(draft.id, OWNER), 'ADMIN_REQUIRED')
check('ON5.1', 'editor 不能发布(403)', editorPublish.ok, editorPublish.code)
const published = svc.publishDraft(draft.id, ADMIN)
check('ON5.2', 'admin 发布 v1(published + contentHash/packHash)',
  published.version.status === 'published' && published.version.version === 1
  && published.version.contentHash.length === 64 && published.packHash.length === 64)
check('ON5.3', '发布快照冻结:cvBounds 与 control_guard 进 compiled_json',
  published.compile.artifacts.problemIr.cvBounds['cv.thickness'].max === 52
  && published.compile.artifacts.controlGuard.guards.some(g => g.ruleId === 'R-GUARD' && g.onViolate === 'block_recommendation'))
const traceCount = db.prepare('SELECT COUNT(*) AS n FROM ontology_rule_traces WHERE ontology_id = ? AND version = 1').get(ONT)
check('ON5.4', 'Rule Trace 落库(每规则一行)', Number(traceCount.n) === parsed.rules.length, `n=${traceCount.n}`)
const dupVersion = expectError(() => db.prepare(`INSERT INTO ontology_versions (id, version, name, line_id, content_hash, compiled_json, changelog_json, status, created_at, updated_at)
  VALUES (?, 1, 'x', '', 'other', '{}', '{}', 'published', 'now', 'now')`).run(ONT), 'ERR_SQLITE_ERROR')
check('ON5.5', '同 (本体,版本) 不可二次写入(不可变)', dupVersion.ok === true, dupVersion.code)

// ── ON6 运行时解析与守卫真正生效 ──
const active = svc.resolveActiveOntology(LINE)
check('ON6.1', '按产线解析到生效版本 v1', active?.version.version === 1 && active.packHash === published.packHash)
const blocked = svc.evaluateOntologyGuards(LINE, { values: { 'st.zone_temp': 150 }, deltas: { 'st.line_speed': 2 }, recipeId: 'rc-e2e' })
check('ON6.2', '温度 150℃(<180)+ 提速 → 阻断(block_recommendation)', blocked.blocked === true, blocked.violations[0]?.message)
const allowed = svc.evaluateOntologyGuards(LINE, { values: { 'st.zone_temp': 200 }, deltas: { 'st.line_speed': 2 }, recipeId: 'rc-e2e' })
check('ON6.3', '温度 200℃(≥180)+ 提速 → 放行', allowed.blocked === false)
const decel = svc.evaluateOntologyGuards(LINE, { values: { 'st.zone_temp': 150 }, deltas: { 'st.line_speed': -1 }, recipeId: 'rc-e2e' })
check('ON6.4', '低温下降速 → 放行(只禁正向增量)', decel.blocked === false)
const failClosed = svc.evaluateOntologyGuards(LINE, { values: {}, deltas: { 'st.line_speed': 1 }, recipeId: 'rc-e2e' })
check('ON6.5', '状态未知 + 提速 → fail-closed 阻断', failClosed.blocked === true && failClosed.violations[0]?.reason === 'state_unknown')
const otherRecipe = svc.evaluateOntologyGuards(LINE, { values: { 'st.zone_temp': 150 }, deltas: { 'st.line_speed': 2 }, recipeId: 'rc-other' })
check('ON6.6', '跨配方不触发该守卫(作用域隔离)', otherRecipe.blocked === false)

// 下发意图面(节点级):写入真实绑定行(语义绑定 → 平台节点),验证意图级守卫
db.prepare(`INSERT INTO ontology_semantic_bindings
  (id, version_id, version, entity_key, platform_kind, platform_id, target_sub, scope, direction,
   unit_declared, unit_target, scale, offset, status, last_verified_at, created_at)
  VALUES (?, ?, 1, ?, 'dcw_node', ?, '', ?, 'read', ?, ?, 1, 0, 'active', NULL, ?)`).run(
  'b-zone', ONT, 'st.zone_temp', 'n-zone-temp', `line:${LINE}`, '℃', '℃', new Date().toISOString())
db.prepare(`INSERT INTO ontology_semantic_bindings
  (id, version_id, version, entity_key, platform_kind, platform_id, target_sub, scope, direction,
   unit_declared, unit_target, scale, offset, status, last_verified_at, created_at)
  VALUES (?, ?, 1, ?, 'dcw_node', ?, '', ?, 'read', ?, ?, 1, 0, 'active', NULL, ?)`).run(
  'b-speed', ONT, 'st.line_speed', 'n-line-speed', `line:${LINE}`, 'm', 'm', new Date().toISOString())

const intent = svc.evaluateOntologyGuardsForNodes(LINE, [{ nodeId: 'n-line-speed', from: 10, to: 12 }], { recipeId: 'rc-e2e' })
check('ON6.7', '下发意图面:绑定映射成功 + 状态未知提速 → fail-closed 阻断',
  intent.blocked === true && intent.violations[0]?.reason === 'state_unknown' && intent.unmapped.length === 0,
  `unmapped=${intent.unmapped.join(',')}, blocked=${intent.blocked}`)
const intentDown = svc.evaluateOntologyGuardsForNodes(LINE, [{ nodeId: 'n-line-speed', from: 10, to: 8 }], { recipeId: 'rc-e2e' })
check('ON6.8', '下发意图面:降速意图不阻断(只禁正向)', intentDown.blocked === false)

// ── ON7 版本演进与 diff ──
const current = svc.getDraft(draft.id)
const evolved = JSON.parse(JSON.stringify(current.draftJson ? JSON.parse(current.draftJson) : parsed))
evolved.rules = evolved.rules.map(r => r.id === 'R-BOUND'
  ? { ...r, dsl: { type: 'bound', variableKey: 'cv.thickness', min: 49, max: 52, unit: 'mm' } }
  : r)
svc.updateDraft(draft.id, OWNER, { doc: evolved, expectedRev: current.rev })
const v2 = svc.publishDraft(draft.id, ADMIN)
check('ON7.1', '发布 v2(parent=1)', v2.version.version === 2 && v2.version.parentVersion === 1)
const diff = svc.compareVersions(ONT, 1, 2)
check('ON7.2', '版本 diff 精确到规则 id', diff.rules.changed.length === 1 && diff.rules.changed[0] === 'R-BOUND', JSON.stringify(diff.rules))
check('ON7.3', '运行时解析自动切到 v2 且界已收紧', svc.resolveActiveOntology(LINE)?.artifacts.problemIr.cvBounds['cv.thickness']?.min === 49)

// ── ON8 Profile 漂移拒绝 ──
svc.assertOntologyUnchanged([{ ontologyId: ONT, ontologyVersion: 2, contentHash: v2.version.contentHash }])
const drift = expectError(() => svc.assertOntologyUnchanged([{ ontologyId: ONT, ontologyVersion: 2, contentHash: 'tampered' }]), 'ONTOLOGY_PACK_DRIFTED')
check('ON8.1', 'Profile 引用的本体内容一致 → 放行', true)
check('ON8.2', '内容被篡改 → 409 ONTOLOGY_PACK_DRIFTED', drift.ok, drift.code)

// ── ON9 退役与回退解析 ──
svc.retireVersion(ONT, 2, ADMIN)
const retiredRef = expectError(() => svc.assertOntologyUnchanged([{ ontologyId: ONT, ontologyVersion: 2 }]), 'ONTOLOGY_PACK_DRIFTED')
check('ON9.1', '退役版本被引用 → 漂移拒绝', retiredRef.ok, retiredRef.code)
check('ON9.2', '退役 v2 后运行时回退到 v1(仍 published)', svc.resolveActiveOntology(LINE)?.version.version === 1)
const retireAgain = expectError(() => svc.retireVersion(ONT, 2, ADMIN), 'VERSION_NOT_PUBLISHED')
check('ON9.3', '重复退役被拒(409)', retireAgain.ok, retireAgain.code)

// ── ON10 审计留痕 ──
const actions = new Set((db.prepare('SELECT action FROM ontology_publish_log WHERE ontology_id = ?').all(ONT)).map(r => r.action))
const required = ['draft.create', 'draft.update', 'rule.transition', 'rule.approve_request', 'rule.approve', 'publish', 'retire']
check('ON10.1', '全链审计动作齐备', required.every(a => actions.has(a)), [...actions].join(','))
const agentRows = db.prepare('SELECT COUNT(*) AS n FROM ontology_publish_log WHERE actor_kind = \'agent\'').get()
check('ON10.2', 'publish_log 预留 actor_kind(可区分 agent/user/system)', Number(agentRows.n) >= 0)

// ── ON11 未获批规则拒发(独立小本体) ──
const d2 = svc.createDraft(ADMIN, { ontologyId: 'ont-e2e-unapproved', lineId: LINE })
const unapprovedDoc = parseDraftDoc(doc())
unapprovedDoc.rules = [{
  ...unapprovedDoc.rules[0], status: 'validated',
  evidence: [evidence('validated_control', 'ev-u')],
}]
svc.updateDraft(d2.id, ADMIN, { doc: unapprovedDoc, expectedRev: d2.rev })
const notApproved = expectError(() => svc.publishDraft(d2.id, ADMIN), 'ONTOLOGY_NOT_APPROVED')
check('ON11.1', '未获控制级批准的硬约束拒绝发布(422)', notApproved.ok, notApproved.code)

// ── ON12 场景子图(Agent 上下文数据面) ──
const graph = svc.sceneSubgraph(LINE)
check('ON12.1', '场景子图含实体/规则决策/守卫', !!graph && graph.entities.length >= 4 && graph.rules.length >= 3 && graph.guards.length >= 1)
check('ON12.2', '无本体的产线返回 null(零注入)', svc.sceneSubgraph('ln-none') === null)

// ── ON13 模型管理面:描述字段 + 校验自动修复 ──
const d13 = svc.createDraft(OWNER, { ontologyId: `${ONT}-fix`, lineId: LINE })
const messy = doc()
messy.description = ''
for (const entity of messy.entities) entity.description = ''
messy.entities.push({ key: 'pv.inject_speed', kind: 'process_variable', name: '注射速度', description: '', unit: 'mm/s', dimension: 'speed', role: 'control', attrs: { dataType: 'number' } })
for (const rule of messy.rules) {
  rule.scope.lineId = ''
  rule.description = ''
}
messy.bindings.push({
  id: 'b-press', entityKey: 'pv.melt_pressure', platformKind: 'dcw_node', platformId: 'dw-missing',
  targetSub: '', scope: '', direction: 'write', unitDeclared: '', unitTarget: '', scale: 0, offset: 0,
})
messy.bindings.push({
  id: 'b-orphan', entityKey: 'cv.missing', platformKind: 'daq_node', platformId: 'dn-missing',
  targetSub: '', scope: '', direction: 'read', unitDeclared: '', unitTarget: '', scale: 0, offset: 0,
})
// 模拟「历史遗留/导入」草稿:绕过严格校验直接落库(现实中旧数据/导入文档即如此),再由自动修复收敛
getOntologyRepo().updateDraft(d13.id, JSON.stringify(messy), d13.rev)
const fixed1 = svc.autoFixDraft(d13.id, OWNER)
const fixCodes = new Set(fixed1.fixes.map(f => f.code))
check('ON13.1', '自动修复:补描述(文档/实体/规则)', fixCodes.has('DOC_DESCRIPTION') && fixCodes.has('ENTITY_DESCRIPTION') && fixCodes.has('RULE_DESCRIPTION'), `fixes=${fixed1.fixes.length}`)
check('ON13.2', '自动修复:复合单位量纲清空(mm/s 不主张相容性)', fixCodes.has('ENTITY_DIMENSION') && fixed1.doc.entities.find(e => e.key === 'pv.inject_speed')?.dimension === '')
check('ON13.3', '自动修复:作用域回填 + 悬空绑定移除 + 单位回填/scale 归一', fixCodes.has('SCOPE_LINE') && fixCodes.has('ORPHAN_BINDING') && fixCodes.has('BINDING_SCALE') && fixCodes.has('BINDING_UNIT') && !fixed1.doc.bindings.some(b => b.id === 'b-orphan') && fixed1.doc.bindings.find(b => b.id === 'b-press')?.scale === 1)
check('ON13.4', '自动修复后文档校验通过且描述已落库', fixed1.validation.ok === true && String(svc.getDraftDetail(d13.id, OWNER).doc.description).length > 0)
const fixed2 = svc.autoFixDraft(d13.id, OWNER)
check('ON13.5', '自动修复幂等:第二次零修复', fixed2.fixes.length === 0, `second=${fixed2.fixes.length}`)
const d13b = svc.createDraft(OWNER, { ontologyId: `${ONT}-fix2`, lineId: LINE })
const badEvidence = doc()
badEvidence.rules[0] = { ...badEvidence.rules[0], kind: 'bound', status: 'approved_for_control', evidence: [evidence('candidate_influence', 'ev-cand')] }
getOntologyRepo().updateDraft(d13b.id, JSON.stringify(badEvidence), d13b.rev)
const fixedBad = svc.autoFixDraft(d13b.id, OWNER)
const downgrade = fixedBad.fixes.find(f => f.code === 'RULE_STATUS_DOWNGRADE')
check('ON13.6', '证据不足的控制级规则回退 validated,且证据不被伪造(仍报错)', Boolean(downgrade) && fixedBad.doc.rules[0].status === 'validated' && fixedBad.validation.ok === false, `${downgrade?.message ?? ''}`)

// ── 报告 ──
const reportDir = join('docs', 'audit')
mkdirSync(reportDir, { recursive: true })
const report = {
  script: 'scripts/e2e-ontology.mjs',
  generatedAt: new Date().toISOString(),
  home: process.env.AW_HOME,
  ontology: ONT,
  lineId: LINE,
  total: pass + fail,
  pass,
  fail,
  assertions: results,
}
writeFileSync(join(reportDir, 'e2e-ontology-report.json'), JSON.stringify(report, null, 2))
console.log(`\nONTOLOGY E2E: ${pass}/${pass + fail} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
