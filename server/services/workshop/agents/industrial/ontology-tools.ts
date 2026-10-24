/**
 * 本体工具族(7 件)—— Agent 侧的「读 / 起草 / 校验 / 解释 / 编译预览 / 提议发布 / 版本比较」。
 *
 * 治理:本族由 grant-guard(WVO: publish_propose 属写族)与 tool-verify(引用面)复核;
 * **没有**任何工具能直接发布版本或写设备 —— 发布仅 admin 在 REST 面执行,
 * Agent 只能 draft_create 起草、publish_propose 提请第二人批准。
 *
 * 归属:Agent 起草的草稿 owner = agentId(审计可见 actorKind='agent');
 * 读取面按 agentOpsScope 的产线/节点范围收窄。
 */
import type { HostToolResult } from '../host-tool-bridge/types'
import { AppError } from '../../../../utils/errors'
import { agentOpsScope } from './ops-tools'
import { getOntologyRepo, parseDraftRow } from '../../ontology/repo'
import type { Actor } from '../../ontology/ontology.service'
import {
  compileDraft, createDraft, getDraft, requestRuleApproval, sceneSubgraph,
  updateDraft, validateDraft, compareVersions, getVersion, listVersions,
} from '../../ontology/ontology.service'

import type { OntologyDraftDoc } from '../../ontology/contracts'

function agentActor(agentId: string): Actor {
  return { userId: agentId, role: 'editor', actorKind: 'agent' }
}

function readableLines(agentId: string): string[] {
  const scope = agentOpsScope(agentId)
  if (!scope) return []
  return [...new Set([...scope.lineIds, ...scope.boundLineIds])]
}

function assertLineInScope(agentId: string, lineId: string): void {
  const lines = readableLines(agentId)
  if (lines.length === 0) {
    throw new AppError(403, 'ONTOLOGY_SCOPE_VIOLATION', '本 Agent 没有绑定任何产线/节点,无法读取本体语义面')
  }
  if (!lines.includes(lineId)) {
    throw new AppError(403, 'ONTOLOGY_SCOPE_VIOLATION',
      `产线 ${lineId} 不在本 Agent 的可读范围(${lines.join(', ')});如需跨线请让用户绑定该产线节点或绑定频道产线`)
  }
}

function ok(text: string): HostToolResult {
  return { text }
}

function fail(text: string): HostToolResult {
  return { text, isError: true }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** 1) 场景语义子图(只读,分页) */
export async function toolOntologySceneInspect(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const lineId = stringArg(args, 'line_id')
  if (!lineId) return fail('ontology_scene_inspect 需要 line_id(line_context 可看到当前产线 id)')
  try {
    assertLineInScope(agentId, lineId)
    const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50)))
    const offset = Math.max(0, Number(args.offset ?? 0))
    const graph = sceneSubgraph(lineId, { limit: limit + offset })
    if (!graph) return ok(`产线 ${lineId} 尚未发布任何本体(0 实体/0 规则);可先用 ontology_draft_create 起草。`)
    const page = graph.entities.slice(offset, offset + limit)
    const query = stringArg(args, 'query').toLowerCase()
    const filtered = query
      ? page.filter(e => `${e.key} ${e.name} ${e.kind}`.toLowerCase().includes(query))
      : page
    return ok([
      `本体 ${graph.ontologyId}@${graph.version}(产线 ${lineId})`,
      `实体 ${graph.entities.length} / 关系 ${graph.relations.length} / 规则 ${graph.rules.length} / 守卫 ${graph.guards.length}`,
      `本页实体 ${filtered.length}(offset=${offset},limit=${limit})${query ? `;筛选"${query}"` : ''}:`,
      ...filtered.map(e => `- ${e.key} [${e.kind}/${e.role ?? '未定角色'}] ${e.name} ${e.unit ? `(${e.unit})` : ''}`
        + `${e.bindings.length ? ` ← ${e.bindings.map(b => `${b.platformKind}:${b.platformId}${b.targetSub ? `#${b.targetSub}` : ''}(${b.direction})`).join(', ')}` : '(未绑定)'}`),
      graph.relations.length ? `关系:` : '',
      ...graph.relations.slice(0, 30).map(r => `- ${r.srcKey} -${r.kind}-> ${r.dstKey} [${r.evidenceTier}]`),
      graph.rules.length ? '规则:' : '',
      ...graph.rules.slice(0, 30).map(r => `- ${r.id} ${r.kind} status=${r.status} decision=${r.decision}${r.message ? `:${r.message}` : ''}`),
      graph.entities.length > offset + limit ? '还有更多实体:增大 offset 继续分页。' : '',
    ].filter(Boolean).join('\n'))
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 2) 创建草稿(可空白起点或克隆已发布版本) */
export async function toolOntologyDraftCreate(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const ontologyId = stringArg(args, 'ontology_id')
  const lineId = stringArg(args, 'line_id')
  if (!ontologyId) return fail('ontology_draft_create 需要 ontology_id(形如 ont-pva-line01)')
  try {
    if (lineId) assertLineInScope(agentId, lineId)
    const draft = createDraft(agentActor(agentId), {
      ontologyId,
      lineId,
      name: stringArg(args, 'name') || undefined,
      cloneFromVersion: args.clone_from_version === true,
    })
    const doc = parseDraftRow(getDraft(draft.id))
    return ok([
      `已创建草稿 ${draft.id}(本体 ${ontologyId},rev=${draft.rev}${draft.baseVersion ? `,基线 v${draft.baseVersion}` : ''})`,
      `当前内容:实体 ${doc.entities.length} / 关系 ${doc.relations.length} / 规则 ${doc.rules.length} / 绑定 ${doc.bindings.length}`,
      '下一步:用 ontology_draft_validate 校验,或直接提交整份文档(update 由平台 REST 完成)。',
    ].join('\n'))
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 3) 校验草稿(结构 + 活体绑定) */
export async function toolOntologyDraftValidate(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const draftId = stringArg(args, 'draft_id')
  if (!draftId) return fail('ontology_draft_validate 需要 draft_id')
  try {
    const report = validateDraft(draftId, agentActor(agentId))
    const errors = report.issues.filter(i => i.severity === 'error')
    const warnings = report.issues.filter(i => i.severity === 'warning')
    const bindingFailures = report.bindings.failures
    return ok([
      `草稿 ${draftId}:${report.ok && report.bindings.ok ? '校验通过' : '校验未通过'}`,
      `实体 ${report.stats.entities} / 关系 ${report.stats.relations} / 规则 ${report.stats.rules} / 绑定 ${report.stats.bindings}`,
      `生命周期分布:${Object.entries(report.stats.byState).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ') || '无'}`,
      errors.length ? `错误 ${errors.length}:` : '无错误',
      ...errors.slice(0, 20).map(i => `- [${i.code}] ${i.path}: ${i.message}${i.hint ? ` → ${i.hint}` : ''}`),
      warnings.length ? `警告 ${warnings.length}:` : '',
      ...warnings.slice(0, 10).map(i => `- [${i.code}] ${i.path}: ${i.message}`),
      bindingFailures.length ? `绑定失败 ${bindingFailures.length}:` : '',
      ...bindingFailures.slice(0, 10).map(f => `- [${f.code}] ${f.message}`),
    ].filter(Boolean).join('\n'))
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 4) 规则解释(DSL + 决策 + 人读来源) */
export async function toolOntologyRuleExplain(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const ruleId = stringArg(args, 'rule_id')
  const draftId = stringArg(args, 'draft_id')
  const ontologyId = stringArg(args, 'ontology_id')
  const versionArg = args.version !== undefined ? Number(args.version) : undefined
  if (!ruleId) return fail('ontology_rule_explain 需要 rule_id')
  try {
    if (draftId) {
      const detail = validateDraft(draftId, agentActor(agentId)) // 顺带确保归属可读
      const doc: OntologyDraftDoc = parseDraftRow(getDraft(draftId))
      const rule = doc.rules.find(r => r.id === ruleId || r.key === ruleId)
      if (!rule) return fail(`草稿 ${draftId} 中没有规则 ${ruleId}`)
      const preview = compileDraft(draftId, agentActor(agentId))
      const trace = preview.result.traces.find(t => t.ruleId === rule.id)
      return ok([
        `规则 ${rule.id}(${rule.key})kind=${rule.kind} 约束级别=${rule.constraintLevel} 状态=${rule.status}`,
        `DSL:${json(rule.dsl)}`,
        `证据:${rule.evidence.map(e => `${e.level}(${e.source.type})`).join(', ') || '无'}`,
        trace ? `编译决策:${trace.decision}${trace.decisionCode ? `[${trace.decisionCode}]` : ''} — ${trace.message}` : '尚未编译',
        `规则修订 hash:${trace?.ruleRevision.slice(0, 16) ?? 'n/a'}`,
        `文档告警:${detail.issues.length}`,
      ].join('\n'))
    }
    if (ontologyId) {
      const traces = getOntologyRepo().listTraces(ontologyId, Number.isInteger(versionArg) ? versionArg : undefined)
      const trace = traces.find(t => t.ruleId === ruleId)
      if (!trace) return fail(`本体 ${ontologyId} 的已发布版本中没有规则 ${ruleId} 的溯源行`)
      const repo = getOntologyRepo()
      const version = getVersion(ontologyId, trace.version)
      const rule = repo.listRules(version.id, version.version).find(r => r.id === ruleId)
      return ok([
        `规则 ${trace.ruleId}(本体 ${ontologyId}@${trace.version})`,
        `DSL:${rule ? json(rule.dsl) : '快照缺失'}`,
        `证据级别:${trace.evidenceLevel || '无'} 约束级别:${trace.constraintLevel}`,
        `编译决策:${trace.decision}${trace.decisionCode ? `[${trace.decisionCode}]` : ''} — ${trace.message}`,
        `产物:${trace.artifacts.map(a => `${a.kind}${a.ref ? `:${a.ref}` : ''}`).join(', ') || '无(仅解释)'}`,
        `适用域:line=${trace.scope.lineId || '全局'} recipe=${trace.scope.recipeId || '-'} condition=${trace.scope.conditionId || '-'}`,
      ].join('\n'))
    }
    return fail('ontology_rule_explain 需要 draft_id 或 ontology_id 之一')
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 5) 编译预览(四类产物 + 规则溯源;不落库) */
export async function toolOntologyCompilePreview(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const draftId = stringArg(args, 'draft_id')
  if (!draftId) return fail('ontology_compile_preview 需要 draft_id')
  try {
    const preview = compileDraft(draftId, agentActor(agentId), { approvedOnly: args.approved_only === true })
    const counts = {
      compiled: preview.result.compiledCount, guard: preview.result.guardCount,
      explained: preview.result.explainedCount, rejected: preview.result.rejectedCount,
    }
    const mv = preview.result.artifacts.problemIr.mvBounds
    const cv = preview.result.artifacts.problemIr.cvBounds
    const lines = [
      `编译状态:${preview.result.status}(compiled=${counts.compiled} guard=${counts.guard} explained=${counts.explained} rejected=${counts.rejected})`,
      `contentHash=${preview.contentHash.slice(0, 16)} packHash=${preview.packHash.slice(0, 16)} rulePackHash=${preview.result.rulePackHash.slice(0, 16)}`,
      Object.keys(mv).length ? `mvBounds:${json(mv)}` : 'mvBounds:空',
      Object.keys(cv).length ? `cvBounds:${json(cv)}` : 'cvBounds:空',
      preview.result.artifacts.controlGuard.guards.length
        ? `运行时守卫 ${preview.result.artifacts.controlGuard.guards.length}:`
        : '运行时守卫:无',
      ...preview.result.artifacts.controlGuard.guards.map(g => `- ${g.id} 当 ${g.when.variableKey} ${g.when.op} ${String(g.when.value)} 时禁止 ${g.forbid.kind}(${g.forbid.variableKey}) [${g.onViolate}]`),
      preview.result.artifacts.processModel.featureCandidates.length
        ? `训练特征候选 ${preview.result.artifacts.processModel.featureCandidates.length},时滞先验 ${preview.result.artifacts.processModel.delayPriors.length}`
        : '',
      preview.result.issues.length ? `告警/拒绝 ${preview.result.issues.length}:` : '无告警',
      ...preview.result.issues.slice(0, 15).map(i => `- [${i.code}] ${i.ruleId ?? i.path}: ${i.message}`),
    ]
    return ok(lines.filter(Boolean).join('\n'))
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 6) 提议发布(只能申请第二人批准;不能自行发布) */
export async function toolOntologyPublishPropose(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const draftId = stringArg(args, 'draft_id')
  if (!draftId) return fail('ontology_publish_propose 需要 draft_id')
  try {
    const actor = agentActor(agentId)
    const draft = getDraft(draftId)
    if (draft.ownerUserId && draft.ownerUserId !== actor.userId) {
      throw new AppError(403, 'DRAFT_SCOPE_VIOLATION', `草稿 ${draftId} 不属于本 Agent`)
    }
    const doc = parseDraftRow(draft)
    const validated = doc.rules.filter(r => r.status === 'validated')
    const pending = doc.rules.filter(r => r.status === 'reviewed')
    const proposed = doc.rules.filter(r => r.status === 'proposed')
    if (validated.length === 0) {
      return ok([
        `草稿 ${draftId} 没有处于 validated 的规则可提请控制级批准。`,
        `当前:proposed=${proposed.length} reviewed=${pending.length} validated=0 approved=${doc.rules.filter(r => r.status === 'approved_for_control').length}`,
        '请先由人完成 proposed→reviewed→validated(需要 observed/validated 级证据)。',
      ].join('\n'))
    }
    const approvals = validated.map(rule => requestRuleApproval(draftId, rule.id, actor))
    // 记一条「提请发布」提案(不改变规则状态;真正的发布需 admin 在 REST 面执行)
    getOntologyRepo().appendPublishLog({
      id: `opl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ontologyId: draft.ontologyId,
      version: draft.baseVersion ?? 0,
      action: 'publish.propose',
      actor: agentId,
      actorKind: 'agent',
      soloOperator: 0,
      approvalId: approvals[0]?.approvalId ?? null,
      detailJson: JSON.stringify({ draftId, rules: approvals.map(a => a.ruleId) }),
      createdAt: new Date().toISOString(),
    })
    return ok([
      `已为 ${approvals.length} 条 validated 规则提请第二人批准(草稿 ${draftId},本体 ${draft.ontologyId}):`,
      ...approvals.map(a => `- 规则 ${a.ruleId} → approvalId=${a.approvalId}`),
      '注意:批准由人类在 /ontology 审批面裁决;批准后仍需 admin 执行 publish 才会冻结为不可变版本。',
      '本工具不会写设备,也不会绕过 HITL/D13。',
    ].join('\n'))
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 7) 版本比较(只读) */
export async function toolOntologyVersionCompare(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const ontologyId = stringArg(args, 'ontology_id')
  const from = Number(args.from ?? args.from_version)
  const to = Number(args.to ?? args.to_version)
  if (!ontologyId) return fail('ontology_version_compare 需要 ontology_id')
  try {
    void readableLines(agentId)
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      const versions = listVersions(ontologyId)
      if (versions.length === 0) return ok(`本体 ${ontologyId} 还没有版本`)
      return ok([
        `本体 ${ontologyId} 版本:${versions.map(v => `v${v.version}(${v.status})`).join(', ')}`,
        '给出 from 与 to 可查看四段差异(实体/关系/规则/绑定)。',
      ].join('\n'))
    }
    const diff = compareVersions(ontologyId, from, to)
    const section = (name: string, part: { added: string[], removed: string[], changed: string[] }) =>
      `${name}:+${part.added.length}/-${part.removed.length}/±${part.changed.length}`
      + (part.added.length ? ` 新增[${part.added.slice(0, 8).join(',')}]` : '')
      + (part.removed.length ? ` 删除[${part.removed.slice(0, 8).join(',')}]` : '')
      + (part.changed.length ? ` 变更[${part.changed.slice(0, 8).join(',')}]` : '')
    return ok([
      `本体 ${ontologyId}:v${from} → v${to}`,
      section('实体', diff.entities),
      section('关系', diff.relations),
      section('规则', diff.rules),
      section('绑定', diff.bindings),
    ].join('\n'))
  }
  catch (err) {
    return fail((err as Error).message)
  }
}

/** 内部:更新草稿(供后续工具扩展;当前 7 工具中无直接暴露) */
export async function toolOntologyDraftUpdate(agentId: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const draftId = stringArg(args, 'draft_id')
  const expectedRev = Number(args.expected_rev)
  if (!draftId || !Number.isInteger(expectedRev)) return fail('ontology_draft_update 需要 draft_id 与 expected_rev')
  try {
    const detail = updateDraft(draftId, agentActor(agentId), { doc: args.doc, expectedRev })
    return ok(`草稿 ${draftId} 已保存(rev=${detail.draft.rev});校验:${detail.validation.ok ? '通过' : '未通过'}`)
  }
  catch (err) {
    return fail((err as Error).message)
  }
}
