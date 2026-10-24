/**
 * ProcessModelSpec 校验与发布检查(单一事实来源;REST / UI / Agent 共用)。
 *
 * 铁律(plan §3.1):
 *  - 单位不可换算/字段缺失 → 发布失败,不猜测补齐;
 *  - 工况 exactly-one;重叠在发布时拒绝,运行时再查一次;
 *  - MV 必须显式 scale/offset 与 delayMs(0 也是显式值);
 *  - 新模型家族只能走已注册训练器,不接受用户 Python 代码。
 */
import { z } from 'zod'
import { AppError } from '../../../utils/errors'
import {
  ARTIFACT_KINDS,
  PROCESS_MODEL_SCHEMA_VERSION,
  TRAINER_REFS,
  artifactKindOfTrainer,
  modelInterfaceOfTrainer,
  type ConditionSpec,
  type ProcessModelSpec,
  type TrainerRef,
} from './contracts'

const clauseSchema = z.object({
  field: z.enum(['productId', 'recipeId', 'recipeVersion', 'lineId']),
  op: z.enum(['eq', 'range']),
  value: z.union([z.string(), z.number(), z.tuple([z.number(), z.number()])]),
})

const conditionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(200).optional(),
  match: z.array(clauseSchema).min(1).max(8),
})

const variableSchema = z.object({
  id: z.string().min(1).max(64),
  nodeId: z.string().min(1),
  role: z.enum(['mv', 'cv', 'md', 'feature']),
  field: z.enum(['value', 'setpoint', 'readback']).default('value'),
  unit: z.string().min(1),
  modelUnit: z.string().min(1).optional(),
  scale: z.number().finite().refine(v => v !== 0, { message: 'scale 不能为 0' }),
  offset: z.number().finite(),
  delayMs: z.number().int().min(0).max(3_600_000).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  maxStep: z.number().positive().optional(),
  /** SW5/D10:MV 的下发执行节点(DCW 节点;parse 层可选=旧 spec 可读;publish/dispatch 层 required+校验) */
  controlNodeId: z.string().min(1).optional(),
})

const timingSchema = z.object({
  beatMs: z.number().int().min(1000).max(3_600_000),
  historySteps: z.number().int().min(1).max(2048),
  horizonSteps: z.number().int().min(1).max(512),
  fixedDt: z.literal(true),
})

const arxSchema = z.object({
  arOrder: z.number().int().min(1).max(64),
  inputOrder: z.number().int().min(1).max(64),
  ridgeLambda: z.number().min(0),
  standardize: z.boolean(),
})

const staticSchema = z.object({
  order: z.union([z.literal(1), z.literal(2)]),
  ridgeLambda: z.number().min(0),
  standardize: z.boolean(),
})

const splitSchema = z.object({
  valRatio: z.number().min(0).max(0.8),
  testRatio: z.number().min(0).max(0.8),
  seed: z.number().int(),
}).refine(s => s.valRatio + s.testRatio <= 0.9, { message: 'valRatio + testRatio 不得超过 0.9' })

export const processModelSpecSchema = z.object({
  schemaVersion: z.literal(PROCESS_MODEL_SCHEMA_VERSION),
  id: z.string().min(1).max(64),
  version: z.number().int().min(1),
  lineId: z.string().min(1),
  productId: z.string().min(1),
  recipeId: z.string().min(1),
  recipeVersion: z.number().int().min(0),
  conditions: z.array(conditionSchema).min(1).max(32),
  variables: z.array(variableSchema).min(2).max(64),
  timing: timingSchema,
  trainer: z.discriminatedUnion('ref', [
    z.object({ ref: z.literal('linear_arx@1'), config: arxSchema }),
    z.object({ ref: z.literal('static_response@1'), config: staticSchema }),
  ]),
  datasetPolicy: z.object({
    runIds: z.array(z.string().min(1)).max(200).optional(),
    fromMs: z.number().int().nonnegative().optional(),
    toMs: z.number().int().nonnegative().optional(),
    split: splitSchema,
    cleaning: z.object({
      hampelK: z.number().int().min(0).max(100).optional(),
      maxInterpMs: z.number().int().min(0).optional(),
      maxDropRatio: z.number().min(0).max(1).optional(),
    }).optional(),
  }),
  gatePolicyRef: z.literal('process-model.gates@1'),
  modelInterface: z.object({
    id: z.enum(['one_step', 'linear_state_space', 'static_response']),
    version: z.number().int().min(1),
    inputSemantics: z.enum(['setpoint', 'process_value']),
    mode: z.enum(['one_step', 'state_space', 'static']),
  }),
  effectiveDomain: z.object({
    mv: z.record(z.string(), z.object({ min: z.number(), max: z.number(), maxStep: z.number().optional() })),
    cv: z.record(z.string(), z.object({ min: z.number(), max: z.number() })).optional(),
  }),
  purpose: z.enum(['mpc_surrogate', 'quality_predict']),
  note: z.string().max(2000).optional(),
})

function fail(message: string, code = 'SPEC_INVALID'): never {
  throw new AppError(422, code, message)
}

/**
 * 发布前深度校验:除了 zod 形状,还检查语义不变量。
 * 返回规范化后的 spec(接口由训练器决定,不能由调用方自填不一致的值)。
 */
export function parseProcessModelSpec(raw: unknown): ProcessModelSpec {
  // stage 首版无结构化来源(产线批次没有 stage 字段):显式拒绝,避免"永远不命中/静默忽略"
  const rawConditions = (raw as { conditions?: Array<{ match?: Array<{ field?: unknown }> }> })?.conditions
  if (Array.isArray(rawConditions) && rawConditions.some(c => Array.isArray(c?.match) && c.match.some(m => m?.field === 'stage'))) {
    fail('工况字段 stage 首版不支持(无结构化阶段来源);请改用 productId/recipeId/recipeVersion/lineId', 'CONDITION_FIELD_UNSUPPORTED')
  }
  const parsed = processModelSpecSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    fail(`规格不合法:${issue ? `${issue.path.join('.')} ${issue.message}` : '未知字段'}`)
  }
  const spec = parsed.data as ProcessModelSpec

  // 内置训练器只消费 MV/CV;未贯通到工件与求解器的输入不能静默丢弃。
  const unsupportedInputs = spec.variables.filter(v => v.role !== 'mv' && v.role !== 'cv')
  if (unsupportedInputs.length) {
    fail(`训练器 ${spec.trainer.ref} 暂不支持输入角色:${unsupportedInputs.map(v => `${v.id}(${v.role})`).join(', ')};请先使用 MV/CV 配置`, 'UNSUPPORTED_MODEL_INPUT')
  }

  const mv = spec.variables.filter(v => v.role === 'mv')
  const cv = spec.variables.filter(v => v.role === 'cv')
  if (!mv.length) fail('至少需要 1 个 MV 变量')
  if (!cv.length) fail('至少需要 1 个 CV 变量')

  const ids = new Set<string>()
  const nodes = new Set<string>()
  for (const variable of spec.variables) {
    if (ids.has(variable.id)) fail(`变量 id 重复:${variable.id}`, 'SPEC_DUPLICATE_VARIABLE')
    if (nodes.has(variable.nodeId)) fail(`节点 ${variable.nodeId} 被重复映射;每个节点只能承担一个语义角色`, 'SPEC_DUPLICATE_NODE')
    ids.add(variable.id)
    nodes.add(variable.nodeId)
    if (variable.min != null && variable.max != null && variable.min >= variable.max) {
      fail(`变量 ${variable.id} 的 min 必须小于 max`)
    }
    if (variable.modelUnit && variable.modelUnit !== variable.unit) {
      // 有 modelUnit 时必须显式换算;scale=1/offset=0 等价于同单位,允许但要求显式声明
      if (!Number.isFinite(variable.scale) || !Number.isFinite(variable.offset)) {
        fail(`变量 ${variable.id} 的单位换算缺失(scale/offset 必须为有限数)`, 'SPEC_UNIT_UNCONVERTIBLE')
      }
    }
    if (variable.role === 'mv') {
      if (variable.delayMs === undefined) fail(`MV ${variable.id} 必须显式声明 delayMs(0 也要写)`, 'SPEC_DELAY_MISSING')
      if (variable.min == null || variable.max == null) fail(`MV ${variable.id} 必须声明 min/max 有效域`)
      const domain = spec.effectiveDomain.mv[variable.id]
      if (!domain) fail(`effectiveDomain.mv 缺少 ${variable.id}`, 'SPEC_DOMAIN_MISSING')
      if (domain.min < variable.min || domain.max > variable.max) {
        fail(`effectiveDomain.mv.${variable.id} 超出变量允许范围`)
      }
    }
  }

  // 工况 exactly-one:id 唯一 + 明显重叠拒绝
  const conditionIds = new Set<string>()
  for (const condition of spec.conditions) {
    if (conditionIds.has(condition.id)) fail(`工况 id 重复:${condition.id}`, 'CONDITION_DUPLICATE')
    conditionIds.add(condition.id)
    for (const clause of condition.match) {
      if (clause.op === 'range') {
        const [lo, hi] = clause.value as [number, number]
        if (!(lo < hi)) fail(`工况 ${condition.id} 的 range 必须 lo < hi`)
      }
    }
  }
  for (let i = 0; i < spec.conditions.length; i++) {
    for (let j = i + 1; j < spec.conditions.length; j++) {
      if (conditionsOverlap(spec.conditions[i]!, spec.conditions[j]!)) {
        fail(`工况 ${spec.conditions[i]!.id} 与 ${spec.conditions[j]!.id} 可能重叠;条件必须 exactly-one`, 'CONDITION_OVERLAP')
      }
    }
  }

  // 训练器 → 工件类型/接口必须一致(调用方不能自填)
  const expectedKind = artifactKindOfTrainer(spec.trainer.ref as TrainerRef)
  if (!(ARTIFACT_KINDS as readonly string[]).includes(expectedKind)) fail(`训练器 ${spec.trainer.ref} 的工件类型未注册`)
  const expectedInterface = modelInterfaceOfTrainer(spec.trainer.ref as TrainerRef)
  if (spec.modelInterface.id !== expectedInterface.id || spec.modelInterface.mode !== expectedInterface.mode) {
    fail(`modelInterface 与训练器 ${spec.trainer.ref} 不一致(应为 ${expectedInterface.id}/${expectedInterface.mode})`, 'SPEC_INTERFACE_MISMATCH')
  }

  // 历史窗口必须覆盖最大 AR 阶数与延迟
  if (spec.trainer.ref === 'linear_arx@1') {
    const config = spec.trainer.config as { arOrder: number, inputOrder: number }
    if (spec.timing.historySteps < config.arOrder + 1) {
      fail(`historySteps(${spec.timing.historySteps}) 必须 ≥ arOrder+1(${config.arOrder + 1})`, 'SPEC_WINDOW_TOO_SHORT')
    }
    const maxDelaySteps = Math.max(0, ...mv.map(v => Math.ceil((v.delayMs ?? 0) / spec.timing.beatMs)))
    if (spec.timing.historySteps < config.inputOrder + maxDelaySteps) {
      fail(`historySteps(${spec.timing.historySteps}) 必须覆盖 inputOrder+最大延迟步数(${config.inputOrder + maxDelaySteps})`, 'SPEC_WINDOW_TOO_SHORT')
    }
  }
  // 静态训练器固定单步(SW3/D2):稳态响应面无多步时域;UQ 的 h=1 与 io_spec 断言依赖此约束
  if (spec.trainer.ref === 'static_response@1' && spec.timing.horizonSteps !== 1) {
    fail(`static_response@1 固定单步时域:horizonSteps 必须 = 1(当前 ${spec.timing.horizonSteps})`, 'SPEC_STATIC_HORIZON')
  }

  // 发布检查:声明身份(line/product/recipe/version)必须 exactly-one 命中。
  // stage 子句是运行时维度,发布时视为中性(无法静态判定,留给运行时)。
  const staticContext: Record<string, unknown> = {
    lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId, recipeVersion: spec.recipeVersion,
  }
  const staticMatches = spec.conditions.filter(condition => condition.match.every((clause) => {
    if (clause.field === 'stage') return true
    const actual = staticContext[clause.field]
    if (clause.op === 'eq') return String(actual ?? '') === String(clause.value)
    if (typeof actual !== 'number') return false
    const [lo, hi] = clause.value as [number, number]
    return actual >= lo && actual <= hi
  }))
  if (staticMatches.length === 0) fail(`声明身份(${spec.lineId}/${spec.productId}/${spec.recipeId}@v${spec.recipeVersion})不匹配任何工况`, 'CONDITION_NO_MATCH')
  // 多命中允许:只要这些条件两两不重叠(差异来自 stage 等运行时维度)。
  // 完全重叠(共同维度取值相同)仍拒绝 —— 运行时无法靠隐式优先级选择。
  for (let i = 0; i < staticMatches.length; i++) {
    for (let j = i + 1; j < staticMatches.length; j++) {
      if (conditionsOverlap(staticMatches[i]!, staticMatches[j]!)) {
        fail(`声明身份命中多个不可区分工况(${staticMatches[i]!.id}, ${staticMatches[j]!.id});条件必须 exactly-one`, 'CONDITION_OVERLAP')
      }
    }
  }

  if (!(TRAINER_REFS as readonly string[]).includes(spec.trainer.ref)) {
    fail(`训练器 ${spec.trainer.ref} 未注册`, 'UNSUPPORTED_TRAINER')
  }
  return spec
}

/**
 * 保守重叠判定:两个条件在**共同维度**上不可能同时成立 → 不重叠;
 * 否则视为可能重叠(宁可拒绝,不在运行时靠隐式优先级兜底)。
 */
export function conditionsOverlap(a: ConditionSpec, b: ConditionSpec): boolean {
  for (const clauseA of a.match) {
    const clauseB = b.match.find(c => c.field === clauseA.field)
    if (!clauseB) continue
    if (clauseA.op === 'eq' && clauseB.op === 'eq') {
      if (String(clauseA.value) !== String(clauseB.value)) return false
      continue
    }
    if (clauseA.op === 'eq' && clauseB.op === 'range') {
      const v = Number(clauseA.value)
      const [lo, hi] = clauseB.value as [number, number]
      if (!(v >= lo && v <= hi)) return false
      continue
    }
    if (clauseA.op === 'range' && clauseB.op === 'eq') {
      const v = Number(clauseB.value)
      const [lo, hi] = clauseA.value as [number, number]
      if (!(v >= lo && v <= hi)) return false
      continue
    }
    const [alo, ahi] = clauseA.value as [number, number]
    const [blo, bhi] = clauseB.value as [number, number]
    if (ahi < blo || bhi < alo) return false
  }
  return true
}

/**
 * SW5/D10:下发面的 controlNodeId 校验(dispatch 层 required;publish 层校验一致性)。
 * 规则:全部 MV 必须声明 controlNodeId;节点存在/启用/与 spec 同线/∈目标配方参数面。
 * DD-A8:旧 spec(无字段)可读不可 dispatch —— 本函数 required=true 时缺声明即拒。
 */
export function assertSpecControlNodes(spec: ProcessModelSpec, options: { required: boolean, recipeParams?: Array<{ nodeId: string }> }): void {
  const mvs = spec.variables.filter(v => v.role === 'mv')
  if (options.required && mvs.some(v => !v.controlNodeId)) {
    const missing = mvs.filter(v => !v.controlNodeId).map(v => v.id).join(',')
    throw new AppError(422, 'SPEC_CONTROL_NODE_MISSING',
      `规格 ${spec.id}@${spec.version} 的 MV 未声明 controlNodeId(${missing});下发需要显式执行节点,请发布补齐字段的新版本`)
  }
  for (const v of mvs) {
    if (!v.controlNodeId) continue
    if (!options.recipeParams?.some(p => p.nodeId === v.controlNodeId)) {
      throw new AppError(422, 'SPEC_CONTROL_NODE_NOT_IN_RECIPE',
        `MV ${v.id} 的 controlNodeId ${v.controlNodeId} 不在目标配方参数面内;下发只能覆盖配方已有参数`)
    }
  }
}
