/**
 * 本体草稿自动修复 —— 只做「安全、确定、幂等」的规范化,绝不伪造证据。
 *
 * 可自动修复(修复后有 fix 记录):
 *  1. DOC_DESCRIPTION / ENTITY_DESCRIPTION / RULE_DESCRIPTION:补人读描述,
 *     让 Agent 与用户一眼看出这个模型代表什么;
 *  2. ENTITY_DIMENSION:量纲跟随单位(复合/未知单位不强行声明量纲,避免误配);
 *  3. SCOPE_LINE:B 规则/绑定作用域回填文档产线;
 *  4. BINDING_UNIT / BINDING_SCALE:绑定声明单位回填实体单位;scale=0 归一为 1;
 *  5. ORPHAN_RELATION / ORPHAN_BINDING:悬空引用(实体不存在)确定性移除;
 *  6. DUPLICATE_ID:完全重复的项去重;同 id 不同内容追加 `-dupN` 后缀保留两份;
 *  7. RULE_STATUS_DOWNGRADE:证据未达 validated_control 的硬约束(bound/rate/nonlinear)
 *     不允许停在 approved_for_control —— 回退到 validated(证据不可自动伪造)。
 *
 * 不作为自动修复(仍需人/Agent 补真实信息,由 validator 报告):
 *  - 证据缺失/级别不足(需真实数据或专家记录);
 *  - 未知实体引用之外的语义冲突(RULE_CONFLICT);
 *  - 平台侧绑定漂移(节点/配方不存在、单位与真实对象不符)。
 */
import { dimensionOf } from '@/shared/dimensions'
import { validateDraftDoc } from './validator'
import type { OntologyDraftDoc, OntologyEntity, OntologyRule } from './contracts'

export interface OntologyAutoFix {
  code: string
  path: string
  message: string
}

export interface AutoFixOutcome {
  doc: OntologyDraftDoc
  fixes: OntologyAutoFix[]
  /** 修复后的校验结论(便于调用方一次看清还剩什么) */
  validation: ReturnType<typeof validateDraftDoc>
}

const EVIDENCE_RANK: Record<string, number> = {
  candidate_influence: 0,
  observed_correlation: 1,
  validated_control: 2,
}

const CONTROL_HARD_KINDS = new Set(['bound', 'rate', 'nonlinear'])

function bestEvidenceLevel(rule: OntologyRule): string {
  return rule.evidence.reduce((best, item) => (
    (EVIDENCE_RANK[item.level] ?? 0) > (EVIDENCE_RANK[best] ?? 0) ? item.level : best
  ), 'candidate_influence')
}

function ruleDescription(rule: OntologyRule): string {
  const dsl = rule.dsl
  switch (dsl.type) {
    case 'bound': {
      const range = [dsl.min != null ? `≥${dsl.min}` : '', dsl.max != null ? `≤${dsl.max}` : ''].filter(Boolean).join(' 且 ')
      return `${dsl.variableKey} 界限${range ? `(${range}${dsl.unit ? ` ${dsl.unit}` : ''})` : ''}`
    }
    case 'rate':
      return `${dsl.variableKey} 变化率上限 ${dsl.maxStep}${dsl.unit ? ` ${dsl.unit}` : ''}/步`
    case 'state_condition':
      return dsl.message?.trim() || `当 ${dsl.when.variableKey} ${dsl.when.op} ${dsl.when.value} 时禁止 ${dsl.forbid.variableKey} 增量`
    case 'interlock':
      return dsl.text
    case 'linear_coupling':
      return `${dsl.variableKey} 线性耦合于 ${dsl.ofKey}`
    case 'nonlinear':
      return `${dsl.variableKey} 非线性约束:${dsl.expression}`
    default:
      return dsl.text
  }
}

function entityDimension(entity: OntologyEntity): string {
  const computed = dimensionOf(entity.unit)
  // 复合/未知单位自成一域(如 mm/s),不强行声明量纲 —— 留空表示「不主张相容性」
  if (computed.startsWith('compound:') || computed.startsWith('unit:')) return ''
  return computed
}

function scopeLineOf(doc: OntologyDraftDoc): string {
  return String(doc.lineId ?? '').trim()
}

/** 修复本体草稿(纯函数;返回新对象,不修改入参) */
export function autoFixDraftDoc(input: OntologyDraftDoc): AutoFixOutcome {
  const doc: OntologyDraftDoc = JSON.parse(JSON.stringify(input)) as OntologyDraftDoc
  const fixes: OntologyAutoFix[] = []
  const lineId = scopeLineOf(doc)

  // ── 1. 文档描述 ──
  if (!String(doc.description ?? '').trim()) {
    doc.description = `${doc.name}${lineId ? `(产线 ${lineId})` : '(全局本体)'} —— 实体 ${doc.entities.length} / 关系 ${doc.relations.length} / 规则 ${doc.rules.length} / 绑定 ${doc.bindings.length}`
    fixes.push({ code: 'DOC_DESCRIPTION', path: 'description', message: '补写文档描述(供 Agent 与用户理解模型含义)' })
  }

  // ── 2. 实体:描述 + 量纲 ──
  doc.entities = doc.entities.map((entity, index) => {
    const next = { ...entity }
    if (!String(next.description ?? '').trim()) {
      next.description = next.name
      fixes.push({ code: 'ENTITY_DESCRIPTION', path: `entities[${index}]`, message: `实体「${next.key}」补描述为名称` })
    }
    const dimension = entityDimension(next)
    if ((next.dimension ?? '') !== dimension) {
      fixes.push({ code: 'ENTITY_DIMENSION', path: `entities[${entity.key}]`, message: `量纲「${next.dimension || '空'}」→「${dimension || '空'}」(跟随单位 ${next.unit || '无量纲'})` })
      next.dimension = dimension
    }
    return next
  })
  const entityKeys = new Set(doc.entities.map(e => e.key))
  const entityByKey = new Map(doc.entities.map(e => [e.key, e]))

  // ── 3. 关系:悬空引用移除 + 去重 ──
  const relationIds = new Map<string, number>()
  doc.relations = doc.relations.filter((relation, index) => {
    if (!entityKeys.has(relation.srcKey) || !entityKeys.has(relation.dstKey)) {
      fixes.push({ code: 'ORPHAN_RELATION', path: `relations[${index}]`, message: `关系「${relation.id}」引用不存在的实体,已移除` })
      return false
    }
    const seen = relationIds.get(relation.id)
    if (seen != null) {
      const first = doc.relations[seen]
      if (JSON.stringify(first) === JSON.stringify(relation)) {
        fixes.push({ code: 'DUPLICATE_ID', path: `relations[${index}]`, message: `关系「${relation.id}」完全重复,已去重` })
        return false
      }
      relation.id = `${relation.id}-dup${index}`
      fixes.push({ code: 'DUPLICATE_ID', path: `relations[${index}]`, message: `关系 id 冲突,已改为「${relation.id}」保留两份` })
    }
    relationIds.set(relation.id, index)
    return true
  })

  // ── 4. 规则:描述/作用域/状态回退 ──
  doc.rules = doc.rules.map((rule, index) => {
    const next = { ...rule, scope: { ...rule.scope } }
    if (!String(next.description ?? '').trim()) {
      next.description = ruleDescription(next)
      fixes.push({ code: 'RULE_DESCRIPTION', path: `rules[${index}]`, message: `规则「${next.id}」补描述` })
    }
    if (lineId && !String(next.scope.lineId ?? '').trim()) {
      next.scope.lineId = lineId
      fixes.push({ code: 'SCOPE_LINE', path: `rules[${index}]`, message: `规则「${next.id}」作用域回填产线 ${lineId}` })
    }
    if (next.status === 'approved_for_control' && CONTROL_HARD_KINDS.has(`${next.kind}`)) {
      const level = bestEvidenceLevel(next)
      if ((EVIDENCE_RANK[level] ?? 0) < (EVIDENCE_RANK.validated_control ?? 2)) {
        next.status = 'validated'
        fixes.push({ code: 'RULE_STATUS_DOWNGRADE', path: `rules[${index}]`, message: `规则「${next.id}」证据级别 ${level} 不足控制级,状态回退为 validated(证据不可自动伪造)` })
      }
    }
    return next
  })

  // ── 5. 绑定:悬空移除 / 单位回填 / scale 归一 / 作用域 ──
  const bindingIds = new Map<string, number>()
  doc.bindings = doc.bindings.filter((binding, index) => {
    if (!entityKeys.has(binding.entityKey)) {
      fixes.push({ code: 'ORPHAN_BINDING', path: `bindings[${index}]`, message: `绑定「${binding.id}」引用的实体不存在,已移除` })
      return false
    }
    const seen = bindingIds.get(binding.id)
    if (seen != null) {
      const first = doc.bindings[seen]
      if (JSON.stringify(first) === JSON.stringify(binding)) {
        fixes.push({ code: 'DUPLICATE_ID', path: `bindings[${index}]`, message: `绑定「${binding.id}」完全重复,已去重` })
        return false
      }
      binding.id = `${binding.id}-dup${index}`
      fixes.push({ code: 'DUPLICATE_ID', path: `bindings[${index}]`, message: `绑定 id 冲突,已改为「${binding.id}」保留两份` })
    }
    bindingIds.set(binding.id, index)
    return true
  }).map((binding, index) => {
    const next = { ...binding }
    const entity = entityByKey.get(next.entityKey)
    const unit = String(entity?.unit ?? '').trim()
    if (unit && !String(next.unitDeclared ?? '').trim()) {
      next.unitDeclared = unit
      fixes.push({ code: 'BINDING_UNIT', path: `bindings[${index}]`, message: `绑定「${next.id}」声明单位回填 ${unit}` })
    }
    if (unit && !String(next.unitTarget ?? '').trim()) {
      next.unitTarget = unit
      fixes.push({ code: 'BINDING_UNIT', path: `bindings[${index}]`, message: `绑定「${next.id}」目标单位回填 ${unit}` })
    }
    if (!Number.isFinite(next.scale) || next.scale === 0) {
      next.scale = 1
      fixes.push({ code: 'BINDING_SCALE', path: `bindings[${index}]`, message: `绑定「${next.id}」scale 非法,归一为 1` })
    }
    if (lineId && (!String(next.scope ?? '').trim() || String(next.scope).trim() === 'global')) {
      next.scope = `line:${lineId}`
      fixes.push({ code: 'SCOPE_LINE', path: `bindings[${index}]`, message: `绑定「${next.id}」作用域回填 line:${lineId}` })
    }
    return next
  })

  return { doc, fixes, validation: validateDraftDoc(doc) }
}
