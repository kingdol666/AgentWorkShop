/**
 * 数据集快照:注册表 + 行内展开(清洗报告/滞后估计/run 概览)。
 * 展开详情按 id 缓存(dsDetails),点开过的不重复请求。
 */
import { reactive, ref } from 'vue'
import { amlApi } from '../api'
import type { AmlDatasetBundle, AmlDatasetRow, DsDetail } from '../types'

export function useAmlDatasets() {
  const datasets = ref<AmlDatasetRow[]>([])
  const expandedDs = ref('')

  async function loadDatasets(): Promise<void> {
    try {
      const data = await amlApi<{ datasets: AmlDatasetRow[] }>('/datasets')
      datasets.value = data.datasets
    }
    catch { /* 概览条已呈现错误,列表静默保持旧值 */ }
  }

  const dsDetails = reactive<Record<string, DsDetail>>({})

  async function toggleDs(id: string): Promise<void> {
    expandedDs.value = expandedDs.value === id ? '' : id
    if (expandedDs.value && !dsDetails[id]) {
      dsDetails[id] = { loading: true, error: '', report: null }
      try {
        const data = await amlApi<AmlDatasetBundle>(`/datasets/${id}`)
        dsDetails[id] = { loading: false, error: '', report: data.report }
      }
      catch (err) {
        dsDetails[id] = { loading: false, error: apiErrorMessage(err), report: null }
      }
    }
  }

  return { datasets, expandedDs, dsDetails, loadDatasets, toggleDs }
}
