/**
 * AML 数据集规格:zod 校验(单一事实来源;REST 与 Agent 工具共用)。
 * 隔离三元组 (lineId, productId, recipeId) 必填 —— 防 Recipe 串味是硬约束。
 */
import { z } from 'zod'
import { AppError } from '../../../utils/errors'

export const amlDatasetSpecSchema = z.object({
  lineId: z.string().min(1),
  productId: z.string().min(1),
  recipeId: z.string().min(1),
  /** 缺省 = 该配方全部已完结批次 */
  runIds: z.array(z.string().min(1)).max(200).optional(),
  nodes: z.array(z.object({
    nodeId: z.string().min(1),
    /** control = 可控输入(未来轨迹已知);target = 预测目标;feature = 仅历史特征 */
    role: z.enum(['control', 'feature', 'target']),
  })).min(2).max(64),
  fromMs: z.number().int().nonnegative().optional(),
  toMs: z.number().int().nonnegative().optional(),
  /** 对齐节拍(ms),≥1000(与 daq 查询下限一致) */
  beatMs: z.number().int().min(1000).max(3_600_000),
  window: z.object({
    historySteps: z.number().int().min(1).max(2048),
    horizonSteps: z.number().int().min(1).max(512),
  }),
  cleaning: z.object({
    /** Hampel 窗口半径(点数),0 = 关闭 */
    hampelK: z.number().int().min(0).max(100).optional(),
    /** 短缺口线性插值上限(ms) */
    maxInterpMs: z.number().int().min(0).optional(),
    /** 单 run 缺失率超过则整 run 丢弃 */
    maxDropRatio: z.number().min(0).max(1).optional(),
  }).optional(),
  split: z.object({
    valRatio: z.number().min(0).max(0.8),
    testRatio: z.number().min(0).max(0.8),
    seed: z.number().int(),
  }).refine(s => s.valRatio + s.testRatio <= 0.9, { message: 'valRatio + testRatio 不得超过 0.9(须保留 train 切分)' }),
  purpose: z.enum(['mpc_surrogate', 'quality_predict']),
  note: z.string().max(2000).optional(),
})

export type AmlDatasetSpec = z.infer<typeof amlDatasetSpecSchema>

export interface AmlNodeSpec {
  nodeId: string
  role: 'control' | 'feature' | 'target'
}

/** 解析失败抛 AppError(422,带 zod 首个 issue 的可读路径) */
export function parseDatasetSpec(raw: unknown): AmlDatasetSpec {
  const r = amlDatasetSpecSchema.safeParse(raw)
  if (!r.success) {
    const iss = r.error.issues[0]
    if (!iss) throw new AppError(422, 'AML_SPEC_INVALID', '数据集规格不合法')
    throw new AppError(422, 'AML_SPEC_INVALID', `数据集规格不合法:${iss.path.join('.')} ${iss.message}`)
  }
  if (r.data.nodes.filter(n => n.role === 'target').length === 0) {
    throw new AppError(422, 'AML_SPEC_INVALID', '数据集规格不合法:至少需要 1 个 target 节点')
  }
  return r.data
}
