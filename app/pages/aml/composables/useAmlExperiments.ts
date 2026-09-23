/**
 * 实验排行榜:选数据集 → 谱系 + 门禁态,并派生「最优行」。
 */
import { computed, ref } from 'vue'
import { amlApi } from '../api'
import type { AmlExperiment } from '../types'

export function useAmlExperiments() {
  const expDatasetId = ref('')
  const experiments = ref<AmlExperiment[]>([])
  const expLoading = ref(false)
  const expError = ref('')

  async function loadExperiments(): Promise<void> {
    if (!expDatasetId.value) {
      experiments.value = []
      return
    }
    expLoading.value = true
    expError.value = ''
    try {
      const data = await amlApi<{ experiments: AmlExperiment[] }>(`/experiments?datasetId=${encodeURIComponent(expDatasetId.value)}`)
      experiments.value = data.experiments
    }
    catch (err) {
      expError.value = apiErrorMessage(err)
    }
    finally {
      expLoading.value = false
    }
  }

  /** 最优行:门禁通过且测试集单步 NRMSE 最小 */
  const bestExpId = computed(() => {
    let best: { id: string, nrmse: number } | null = null
    for (const e of experiments.value) {
      const n = e.metrics?.oneStepTest?.nrmse
      if (e.status === 'gates_passed' && n != null && Number.isFinite(n) && (best == null || n < best.nrmse))
        best = { id: e.id, nrmse: n }
    }
    return best?.id ?? ''
  })

  return { expDatasetId, experiments, expLoading, expError, bestExpId, loadExperiments }
}
