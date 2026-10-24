import { AppError } from '../../../utils/errors'

/** 旧 ARX 零延迟工件把当拍输入放进 D,会丢失下一拍反馈;只拒绝该已知布局。 */
export function assertArxArtifactCurrent(artifact: unknown, modelId: string): void {
  if (!artifact || typeof artifact !== 'object') return
  const arx = artifact as Record<string, unknown>
  if (arx.kind !== 'linear_state_space@1'
    || !Number.isInteger(arx.arOrder) || Number(arx.arOrder) < 1
    || !Number.isInteger(arx.inputOrder) || Number(arx.inputOrder) < 1
    || !arx.layout || typeof arx.layout !== 'object') return
  if (!Array.isArray(arx.mvOrder) || !Array.isArray(arx.D) || !arx.delaysSteps || typeof arx.delaysSteps !== 'object') return
  const delays = arx.delaysSteps as Record<string, unknown>
  for (const [m, mv] of arx.mvOrder.entries()) {
    if (typeof mv !== 'string' || delays[mv] !== 0) continue
    if (arx.D.some(row => Array.isArray(row) && typeof row[m] === 'number' && row[m] !== 0)) {
      throw new AppError(409, 'MODEL_RETRAIN_REQUIRED', `模型 ${modelId} 使用旧版零延迟 ARX 工件(${mv} 的 D 非零);请使用修复后的训练器重新训练并发布新模型`)
    }
  }
}
