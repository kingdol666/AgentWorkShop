/**
 * 预测控制台:production 模型 → ioSpec → history JSON 粘贴 → forecast 表。
 * 只依赖模型注册表(只读),状态自持 —— 预测控制台整体是一个独立子组件。
 */
import { computed, ref } from 'vue'
import { message } from 'ant-design-vue'
import { amlApi } from '../api'
import type { AmlModelRow, PredictResult } from '../types'

/** 矩阵文本(history/controls)的解析守卫:非空二维数值数组才算合法 */
function isNumberMatrix(v: unknown): v is number[][] {
  return Array.isArray(v) && v.length > 0
    && v.every(r => Array.isArray(r) && r.length > 0 && r.every(x => typeof x === 'number' && Number.isFinite(x)))
}

/** @param models 模型注册表取值器(页面/子组件持有的只读来源,不复制) */
export function useAmlPredict(models: () => AmlModelRow[]) {
  const { t: tt } = useI18n()

  const productionModels = computed(() => models().filter(m => m.stage === 'production'))
  const predModelId = ref('')
  const predModel = computed(() => models().find(m => m.id === predModelId.value) ?? null)
  const predHistory = ref('')
  const predControls = ref('')
  const predSteps = ref<number | null>(null)
  const predBusy = ref(false)
  const predError = ref('')
  const predResult = ref<PredictResult | null>(null)

  function onPullLatest(): void {
    // 页面暂不内联拉数:引导用户走 Agent 工具取数(与任务口径一致)
    message.info(tt('aml.k1amlx146'))
  }

  function parseMatrix(text: string): number[][] | null {
    const t = text.trim()
    if (!t) return null
    try {
      const v: unknown = JSON.parse(t)
      return isNumberMatrix(v) ? v : null
    }
    catch {
      return null
    }
  }

  async function doPredict(): Promise<void> {
    predError.value = ''
    predResult.value = null
    const model = predModel.value
    if (!model) return
    const history = parseMatrix(predHistory.value)
    if (!history) {
      predError.value = tt('aml.k1amlx153')
      return
    }
    const controls = predControls.value.trim() ? parseMatrix(predControls.value) : undefined
    if (predControls.value.trim() && !controls) {
      predError.value = tt('aml.k1amlx153')
      return
    }
    predBusy.value = true
    try {
      const steps = typeof predSteps.value === 'number' && Number.isFinite(predSteps.value) ? predSteps.value : undefined
      const data = await amlApi<{ prediction: PredictResult }>(`/models/${model.id}/predict`, {
        method: 'POST',
        body: JSON.stringify({ history, controls, steps }),
      })
      predResult.value = data.prediction
      message.success(tt('aml.k1amlx154', { p0: data.prediction.forecast.length, p1: data.prediction.targetNodes.length }))
    }
    catch (err) {
      predError.value = apiErrorMessage(err)
    }
    finally {
      predBusy.value = false
    }
  }

  return {
    productionModels,
    predModelId,
    predModel,
    predHistory,
    predControls,
    predSteps,
    predBusy,
    predError,
    predResult,
    onPullLatest,
    doPredict,
  }
}
