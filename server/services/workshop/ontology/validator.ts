/**
 * 本体文档校验(零 DB 纯函数,可单测)。
 *
 * 只做结构/语义自洽判定;存在性、归属、读写能力等「活体」判定在
 * semantic-binding.service(需要查 daq/dcw/recipe 真实对象)。
 *
 * fail-closed 原则:每条问题都带可行动 hint,禁止静默降级。
 */
import type { CompileIssue, EvidenceLevel, OntologyDraftDoc, OntologyEntity, OntologyRule } from './contracts'
import {
  ONTOLOGY_STATES,
  RULE_ERROR_CODES,
  entityUnitIssue,
  evidenceLevelRank,
  maxEvidenceLevel,
  unitsCompatible,
} from './contracts'

export interface DraftStats {
  entities: number
  relations: number
  rules: number
  bindings: number
  byState: Record<string, number>
  byEvidence: Record<string, number>
}

export interface DraftValidationReport {
  ok: boolean
  issues: CompileIssue[]
  stats: DraftStats
}

function issue(code: string, path: string, message: string, severity: 'error' | 'warning' = 'error', hint?: string, ruleId?: string): CompileIssue {
  return { code, path, message, severity, hint, ruleId }
}

/** 规则 DSL 里出现的全部变量引用 */
export function ruleVariableRefs(rule: OntologyRule): string[] {
  const dsl = rule.dsl
  switch (dsl.type) {
    case 'bound': return [dsl.variableKey]
    case 'rate': return [dsl.variableKey]
    case 'linear_coupling': return [dsl.variableKey, dsl.ofKey]
    case 'nonlinear': return [dsl.variableKey]
    case 'state_condition': return [dsl.when.variableKey, dsl.forbid.variableKey]
    case 'interlock': return dsl.variableKey ? [dsl.variableKey] : []
    case 'informal': return []
    default: return []
  }
}

/** 规则证据能支持的最强级别 */
export function ruleEvidenceLevel(rule: OntologyRule): EvidenceLevel | '' {
  return maxEvidenceLevel(rule.evidence.map(e => e.level))
}

export function validateDraftDoc(doc: OntologyDraftDoc): DraftValidationReport {
  const issues: CompileIssue[] = []
  const entityByKey = new Map<string, OntologyEntity>()

  // ---- 实体 ----
  const seenKeys = new Set<string>()
  doc.entities.forEach((entity, index) => {
    if (seenKeys.has(entity.key)) {
      issues.push(issue(RULE_ERROR_CODES.INVALID, `entities[${index}]`, `实体 key「${entity.key}」重复`, 'error', '实体 key 必须在单份本体文档内唯一'))
    }
    seenKeys.add(entity.key)
    entityByKey.set(entity.key, entity)
    if (entity.unit) {
      const unitIssue = entityUnitIssue(entity)
      if (unitIssue) issues.push(unitIssue)
    }
    if (entity.kind === 'process_variable' || entity.kind === 'quality_variable') {
      if (!entity.role) {
        issues.push(issue(RULE_ERROR_CODES.ROLE_UNRESOLVED, `entities[${entity.key}]`,
          `变量实体「${entity.key}」缺少 role`, 'warning',
          '缺 role 时无法参与 bound/rate 规则编译(编译器会拒绝);建议补 control/target/disturbance/feature/state/guard/observation'))
      }
    }
  })

  // ---- 关系 ----
  const relationIds = new Set<string>()
  const relationTriples = new Set<string>()
  doc.relations.forEach((rel, index) => {
    const path = `relations[${index}]`
    if (relationIds.has(rel.id)) issues.push(issue(RULE_ERROR_CODES.INVALID, path, `关系 id「${rel.id}」重复`))
    relationIds.add(rel.id)
    const triple = `${rel.srcKey}|${rel.dstKey}|${rel.kind}`
    if (relationTriples.has(triple)) {
      issues.push(issue(RULE_ERROR_CODES.INVALID, path, `关系重复(${rel.srcKey} -${rel.kind}-> ${rel.dstKey})`))
    }
    relationTriples.add(triple)
    if (rel.srcKey === rel.dstKey) {
      issues.push(issue(RULE_ERROR_CODES.INVALID, path, `关系 ${rel.id} 自引用(src 与 dst 相同)`, 'warning'))
    }
    if (!entityByKey.has(rel.srcKey)) {
      issues.push(issue(RULE_ERROR_CODES.UNKNOWN_ENTITY, path, `关系 ${rel.id} 的 srcKey「${rel.srcKey}」不存在`, 'error', '先在 entities 里定义该实体'))
    }
    if (!entityByKey.has(rel.dstKey)) {
      issues.push(issue(RULE_ERROR_CODES.UNKNOWN_ENTITY, path, `关系 ${rel.id} 的 dstKey「${rel.dstKey}」不存在`, 'error', '先在 entities 里定义该实体'))
    }
    const tier = rel.properties.evidenceTier
    const declaredMax = maxEvidenceLevel(rel.evidence.map(e => e.level))
    if (rel.evidence.length > 0 && evidenceLevelRank(tier) > evidenceLevelRank(declaredMax)) {
      issues.push(issue(RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT, path,
        `关系 ${rel.id} 声明证据档 ${tier} 高于其证据最高级别 ${declaredMax || '无'}`,
        'error', '补足对应级别证据,或下调 evidenceTier'))
    }
    if ((rel.properties.gainPerUnit !== undefined || rel.properties.lagMs !== undefined) && tier !== 'validated_control') {
      issues.push(issue(RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT, path,
        `关系 ${rel.id} 携带增益/时滞,但证据档为 ${tier}`,
        'error', '增益与时滞只能来自受控验证(validated_control:run+crosscheck+outcome);否则请留空,仅作候选影响'))
    }
  })

  // ---- 规则 ----
  const ruleIds = new Set<string>()
  const ruleKeys = new Set<string>()
  doc.rules.forEach((rule, index) => {
    const path = `rules[${index}]`
    if (ruleIds.has(rule.id)) issues.push(issue(RULE_ERROR_CODES.INVALID, path, `规则 id「${rule.id}」重复`))
    ruleIds.add(rule.id)
    if (ruleKeys.has(rule.key)) issues.push(issue(RULE_ERROR_CODES.INVALID, path, `规则 key「${rule.key}」重复`))
    ruleKeys.add(rule.key)
    if (rule.kind !== rule.dsl.type) {
      issues.push(issue(RULE_ERROR_CODES.INVALID, path,
        `规则 ${rule.id} 的 kind(${rule.kind}) 与 dsl.type(${rule.dsl.type}) 不一致`,
        'error', 'kind 决定编译形态,必须与 DSL 形态一致'))
    }
    for (const ref of ruleVariableRefs(rule)) {
      if (!entityByKey.has(ref)) {
        issues.push(issue(RULE_ERROR_CODES.UNKNOWN_ENTITY, path,
          `规则 ${rule.id} 引用的实体「${ref}」不存在`, 'error', '先定义实体,或改用语义绑定后的平台变量', rule.id))
      }
    }
    const level = ruleEvidenceLevel(rule)
    // 硬约束只约束「数值强制」形态(bound/rate/nonlinear);state_condition 与 interlock
    // 分别落运行时守卫 / PLC 解释层,不改变数值可行域,因此不要求 validated_control。
    const numericHard = rule.constraintLevel === 'hard' && (rule.dsl.type === 'bound' || rule.dsl.type === 'rate' || rule.dsl.type === 'nonlinear')
    if (numericHard && level !== 'validated_control') {
      issues.push(issue(RULE_ERROR_CODES.EVIDENCE_INSUFFICIENT, path,
        `规则 ${rule.id} 要求硬约束,但证据最高级别为 ${level || '无'}`,
        'error', '硬约束只接受 validated_control(run+crosscheck+outcome);否则降为 soft 或改为 guard', rule.id))
    }
    if (rule.dsl.type === 'bound' && rule.dsl.min !== undefined && rule.dsl.max !== undefined && rule.dsl.min > rule.dsl.max) {
      issues.push(issue(RULE_ERROR_CODES.RULE_CONFLICT, path,
        `规则 ${rule.id} 的界区间为空(min ${rule.dsl.min} > max ${rule.dsl.max})`, 'error', '检查上下限是否写反', rule.id))
    }
    if (rule.dsl.type === 'nonlinear') {
      // 简单阈值形态可由运行时守卫执行;复杂表达式需后端支持
      const simple = /^\s*[a-z][a-z0-9_.]*\s*(<=|>=|<|>|==|!=)\s*-?\d+(?:\.\d+)?\s*$/.test(rule.dsl.expression)
      if (!simple) {
        issues.push(issue(RULE_ERROR_CODES.UNSUPPORTED_FORM, path,
          `规则 ${rule.id} 的非线性表达式无法由运行时守卫执行`,
          'warning', '建议改写为「变量 比较 阈值」形式,或落到 PhysicsSpec 由求解器/孪生后端支持', rule.id))
      }
    }
  })

  // ---- 语义绑定(草稿期) ----
  const bindingIds = new Set<string>()
  const bindingTriples = new Set<string>()
  doc.bindings.forEach((binding, index) => {
    const path = `bindings[${index}]`
    if (bindingIds.has(binding.id)) issues.push(issue(RULE_ERROR_CODES.INVALID, path, `绑定 id「${binding.id}」重复`))
    bindingIds.add(binding.id)
    const triple = `${binding.entityKey}|${binding.platformKind}|${binding.platformId}`
    if (bindingTriples.has(triple)) {
      issues.push(issue(RULE_ERROR_CODES.INVALID, path, `绑定重复(实体 ${binding.entityKey} → ${binding.platformKind}:${binding.platformId})`))
    }
    bindingTriples.add(triple)
    const entity = entityByKey.get(binding.entityKey)
    if (!entity) {
      issues.push(issue(RULE_ERROR_CODES.UNKNOWN_ENTITY, path, `绑定 ${binding.id} 的实体「${binding.entityKey}」不存在`))
      return
    }
    if (entity.unit && binding.unitDeclared && !unitsCompatible(entity.unit, binding.unitDeclared)) {
      issues.push(issue(RULE_ERROR_CODES.UNIT_MISMATCH, path,
        `绑定 ${binding.id} 的声明单位「${binding.unitDeclared}」与实体「${entity.key}」单位「${entity.unit}」量纲不相容`))
    }
    if (binding.unitDeclared && binding.unitTarget && !unitsCompatible(binding.unitDeclared, binding.unitTarget)) {
      issues.push(issue(RULE_ERROR_CODES.UNIT_MISMATCH, path,
        `绑定 ${binding.id} 的单位「${binding.unitDeclared}」与目标单位「${binding.unitTarget}」量纲不相容`))
    }
    if (!Number.isFinite(binding.scale) || binding.scale === 0) {
      issues.push(issue(RULE_ERROR_CODES.INVALID, path, `绑定 ${binding.id} 的 scale 必须为非零有限数(禁止兜底)`))
    }
    if (binding.platformKind === 'daq_node' && binding.direction !== 'read') {
      issues.push(issue(RULE_ERROR_CODES.INVALID, path,
        `绑定 ${binding.id} 把数采节点声明为 ${binding.direction}`, 'warning',
        '平台数采节点通常是只读通道;写入应绑定 dcw_node 或 recipe_param(活体校验会拒绝)'))
    }
  })

  const byState: Record<string, number> = {}
  for (const state of ONTOLOGY_STATES) byState[state] = 0
  for (const rule of doc.rules) byState[rule.status] = (byState[rule.status] ?? 0) + 1
  const byEvidence: Record<string, number> = { candidate_influence: 0, observed_correlation: 0, validated_control: 0 }
  for (const rule of doc.rules) {
    const level = ruleEvidenceLevel(rule)
    if (level) byEvidence[level] = (byEvidence[level] ?? 0) + 1
  }

  return {
    ok: !issues.some(i => i.severity === 'error'),
    issues,
    stats: {
      entities: doc.entities.length,
      relations: doc.relations.length,
      rules: doc.rules.length,
      bindings: doc.bindings.length,
      byState,
      byEvidence,
    },
  }
}
