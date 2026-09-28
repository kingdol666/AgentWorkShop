/**
 * ParamLimits —— 工艺参数写入限界的分层解析与联锁断言(策略层)。
 *
 * 分层限界(层层收窄,任一层越界即拒;有效限界 = 各生效层交集):
 *   1. node    节点工艺安全量程(结构性硬边界,驱动层 validateEng 结构性兜底,不可旁路)
 *   2. param   工艺参数基准限界(常驻边界,配置在参数映射上)
 *   3. product 产品限界(该产线活动批次产品的 paramLimits[paramKey];换产品即换边界)
 *   4. recipe  配方窗口(活动批次配方对该执行节点的 param.min/max;开跑期间生效)
 *
 * 四路写路径(手动 REST / Agent 工具 / 配方下发 / 回退)共用 DcwController.write
 * 咽喉点 → 断言在咽喉点单点生效,用户与 Agent 一体约束,不存在旁路来源。
 * D8 基准消融:includeSoft=false 时仅保留 node 结构层(软联锁消融臂语义)。
 */

import { AppError, ErrorCodes } from '../../../utils/errors'
import type { ParamLimitLayer, ParamLimitsBreakdown } from '../../../../shared/dcw-protocol'
import type { DcwNode } from './dcw-node'
import { getDcwParamRepo } from './param-map.repo'
import { getDcwProductRepo } from './dcw-product.repo'
import { getDcwRecipeRepo } from './dcw-recipe.repo'
import { getActiveLineRun } from './line-run'

export interface LimitResolveOpts {
  /** false = 仅结构层(消融臂/展示结构层);缺省 true = 全层 */
  includeSoft?: boolean
  /** 跳过配方窗口层(配方下发路径传 true:下发值已在配方保存时对自身窗口校验,
   *  且中途应用新配方不应被旧批次配方窗口误伤;手动/Agent 写恒受活动配方窗口约束) */
  skipRecipe?: boolean
}

/** 解析某执行节点当前生效的限界层(node 层恒在;软层按配置/运行态可有可无) */
export function limitLayersOf(node: DcwNode, opts: LimitResolveOpts = {}): ParamLimitLayer[] {
  const includeSoft = opts.includeSoft !== false
  const layers: ParamLimitLayer[] = [{
    layer: 'node',
    label: '节点安全量程',
    min: node.min,
    max: node.max,
  }]
  if (!includeSoft) return layers

  const paramRepo = getDcwParamRepo()
  const param = paramRepo.byNode(node.id)
  const paramKey = param?.key ?? null
  if (param && (param.min != null || param.max != null)) {
    layers.push({
      layer: 'param',
      label: `工艺参数「${param.key}」基准限界`,
      min: param.min,
      max: param.max,
    })
  }

  const run = getActiveLineRun(node.lineId)
  if (!run) return layers

  if (paramKey) {
    const product = getDcwProductRepo().byId(run.productId)
    const range = product?.paramLimits?.[paramKey]
    if (product && range && (range.min != null || range.max != null)) {
      layers.push({
        layer: 'product',
        label: `产品「${product.name}」限界`,
        min: range.min ?? null,
        max: range.max ?? null,
      })
    }
  }

  const recipe = getDcwRecipeRepo().byId(run.recipeId)
  const recipeParam = recipe?.params.find(p => p.nodeId === node.id)
  if (!opts.skipRecipe && recipe && recipeParam && (recipeParam.min != null || recipeParam.max != null)) {
    layers.push({
      layer: 'recipe',
      label: `配方「${recipe.name}」工艺窗口`,
      min: recipeParam.min ?? null,
      max: recipeParam.max ?? null,
    })
  }
  return layers
}

/** 各层交集(最紧有效限界;node 层恒在,恒有值) */
export function intersectLayers(layers: ParamLimitLayer[]): { min: number, max: number } {
  let min = Number.NEGATIVE_INFINITY
  let max = Number.POSITIVE_INFINITY
  for (const l of layers) {
    if (l.min != null && l.min > min) min = l.min
    if (l.max != null && l.max < max) max = l.max
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    // 结构层缺失属编程错误(节点构造恒有量程);兜底全开域避免误杀写路径
    return { min: Number.isFinite(min) ? min : -Number.MAX_VALUE, max: Number.isFinite(max) ? max : Number.MAX_VALUE }
  }
  return { min, max }
}

/** 有效限界全量剖面(参数台账/前端展示/Agent 语义回包共用) */
export function limitsBreakdownOf(node: DcwNode, opts: LimitResolveOpts = {}): ParamLimitsBreakdown {
  const param = getDcwParamRepo().byNode(node.id)
  const layers = limitLayersOf(node, opts)
  const step = stepLimitOf(node, opts)
  return {
    nodeId: node.id,
    paramId: param?.id ?? null,
    paramKey: param?.key ?? null,
    layers,
    effective: intersectLayers(layers),
    stepLimit: step.value,
    stepLimitSource: step.source,
    stepLimitLayers: step.layers,
  }
}

export interface StepLimitProfile {
  value: number | null
  source: 'recipe' | 'param' | 'node' | 'default' | 'none'
  layers: Array<{ layer: 'recipe' | 'param' | 'node' | 'default', label: string, value: number | null }>
}

/** 解析单步变化上限:配方覆盖 > 参数覆盖 > 节点默认;有效值取所有已配置层的最小值。 */
export function stepLimitOf(node: DcwNode, opts: LimitResolveOpts = {}): StepLimitProfile {
  const param = getDcwParamRepo().byNode(node.id)
  const layers: StepLimitProfile['layers'] = [
    { layer: 'node', label: '节点默认单步限制', value: finitePositive(node.stepLimit) },
  ]
  if (param?.stepLimit != null) layers.push({ layer: 'param', label: `参数「${param.key}」单步限制`, value: finitePositive(param.stepLimit) })
  const run = getActiveLineRun(node.lineId)
  const recipe = run ? getDcwRecipeRepo().byId(run.recipeId) : undefined
  const recipeParam = recipe?.params.find(p => p.nodeId === node.id)
  if (!opts.skipRecipe && recipeParam?.stepLimit != null) layers.push({ layer: 'recipe', label: `配方「${recipe?.name ?? run?.recipeId ?? ''}」单步限制`, value: finitePositive(recipeParam.stepLimit) })
  const configured = layers.filter(x => x.value != null)
  if (configured.length === 0) return { value: null, source: 'none', layers }
  const effective = Math.min(...configured.map(x => x.value!))
  const winner = [...configured].reverse().find(x => x.value === effective) ?? configured[0]!
  return { value: effective, source: winner.layer, layers }
}

function finitePositive(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 探索/未验证模型写入的单步卡控;previous=null 时首写必须使用有限绝对值。 */
export function assertStepLimit(node: DcwNode, eng: number, opts: LimitResolveOpts = {}, previous: number | null = node.value): StepLimitProfile {
  const profile = stepLimitOf(node, opts)
  if (profile.value == null) throw new AppError(409, ErrorCodes.EXPLORATION_SAFE_STEP_REQUIRED, `节点「${node.name}」未配置有限 stepLimit，探索阶段拒绝无界写入；请在节点/工艺参数映射中配置每步最大变化量`)
  if (previous != null && Math.abs(eng - previous) > profile.value + 1e-9) {
    throw new AppError(409, ErrorCodes.STEP_LIMIT_EXCEEDED, `节点「${node.name}」本次变化 ${Math.abs(eng - previous)}${node.unit} 超过单步限制 ${profile.value}${node.unit}（来源:${profile.source}）`)
  }
  return profile
}

/**
 * 写入联锁断言:逐层校验,越界即 400,错误消息点名层来源与可用区间。
 * 在 DcwController.write 咽喉点调用 —— 手动/Agent/配方/回退四路一体约束。
 */
export function assertWithinLimits(node: DcwNode, eng: number, opts: LimitResolveOpts = {}): void {
  if (!Number.isFinite(eng)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `设定值需为数字(当前: ${String(eng)})`)
  }
  const layers = limitLayersOf(node, opts)
  const paramKey = getDcwParamRepo().byNode(node.id)?.key ?? null
  const unit = node.unit ?? ''
  const { min, max } = intersectLayers(layers)
  for (const l of layers) {
    if (l.min == null && l.max == null) continue
    if (l.min != null && eng < l.min) {
      throw new AppError(400, errorCodeForLayer(l.layer), `${violatedText(l, '低于下限', eng, unit, paramKey)}(当前有效写入区间 ${min}~${max}${unit};各层限界按安全规约取交集,越界写入已拒绝)`)
    }
    if (l.max != null && eng > l.max) {
      throw new AppError(400, errorCodeForLayer(l.layer), `${violatedText(l, '超出上限', eng, unit, paramKey)}(当前有效写入区间 ${min}~${max}${unit};各层限界按安全规约取交集,越界写入已拒绝)`)
    }
  }
}

function errorCodeForLayer(layer: ParamLimitLayer['layer']): string {
  if (layer === 'node') return ErrorCodes.NODE_RANGE_EXCEEDED
  if (layer === 'recipe') return ErrorCodes.RECIPE_LIMIT_EXCEEDED
  if (layer === 'param') return ErrorCodes.PARAM_LIMIT_EXCEEDED
  if (layer === 'product') return ErrorCodes.PRODUCT_LIMIT_EXCEEDED
  return ErrorCodes.VALIDATION_ERROR
}

function violatedText(l: ParamLimitLayer, dir: string, eng: number, unit: string, paramKey: string | null): string {
  const bound = dir === '低于下限' ? l.min : l.max
  const subject = l.layer === 'node'
    ? '节点工艺安全量程'
    : l.layer === 'param'
      ? `工艺参数「${paramKey ?? ''}」基准限界`
      : l.label + (paramKey ? `(工艺参数 ${paramKey})` : '')
  return `设定值 ${eng}${unit} ${dir} ${subject} 的 ${bound}${unit} —— 约束层:${l.label}`
}
