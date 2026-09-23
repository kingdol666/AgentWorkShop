/**
 * 训练作业:REST 快照 + WS 实时投影合并,行内展开 = 门禁逐项 + 日志尾随。
 * 实时帧经 useAmlStream 单例读取(不复制),REST 行只做兜底。
 */
import { computed, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useAmlStream } from '@/app/composables/workshop/useAmlStream'
import { amlApi } from '../api'
import { useAmlFormat } from './useAmlFormat'
import type { AmlJobBundle, AmlJobRow, JobDetail } from '../types'

export function useAmlJobs() {
  const { t: tt } = useI18n()
  const { shortId } = useAmlFormat()
  const aml = useAmlStream()

  const jobs = ref<AmlJobRow[]>([])

  async function loadJobs(): Promise<void> {
    try {
      const data = await amlApi<{ jobs: AmlJobRow[] }>('/jobs')
      jobs.value = data.jobs
    }
    catch { /* 同上:静默保旧值 */ }
  }

  /** WS 实时投影覆盖 status/stage/progress(帧权威,REST 兜底) */
  const jobRows = computed<Array<AmlJobRow & { live?: boolean }>>(() =>
    jobs.value.map((j) => {
      const live = aml.jobs.value.get(j.id)
      if (!live) return j
      return { ...j, status: live.status || j.status, stage: live.stage || j.stage, progress: live.progress ?? j.progress, live: true }
    }))

  const jobDetails = reactive<Record<string, JobDetail>>({})
  const expandedJob = ref('')

  async function fetchJobLogs(id: string): Promise<string[]> {
    const data = await amlApi<{ logs: string[] }>(`/jobs/${id}/logs?lines=120`)
    return data.logs
  }

  async function toggleJob(id: string): Promise<void> {
    expandedJob.value = expandedJob.value === id ? '' : id
    if (expandedJob.value && !jobDetails[id]) {
      jobDetails[id] = { loading: true, error: '', metrics: null, gates: null, logs: [] }
      try {
        const [detail, logs] = await Promise.all([
          amlApi<AmlJobBundle>(`/jobs/${id}`),
          fetchJobLogs(id),
        ])
        jobDetails[id] = { loading: false, error: '', metrics: detail.metrics, gates: detail.gates, logs }
      }
      catch (err) {
        jobDetails[id] = { loading: false, error: apiErrorMessage(err), metrics: null, gates: null, logs: [] }
      }
    }
  }

  /** 活跃作业 5s 轮询尾随日志(仅刷新日志,不重拉门禁) */
  async function refreshJobLogs(id: string): Promise<void> {
    const d = jobDetails[id]
    if (!d) return
    try {
      d.logs = await fetchJobLogs(id)
    }
    catch { /* 轮询失败静默,下一拍再试 */ }
  }

  const confirmCancel = ref('')
  const cancelling = ref('')

  async function onCancelJob(id: string): Promise<void> {
    if (confirmCancel.value !== id) {
      confirmCancel.value = id
      return
    }
    confirmCancel.value = ''
    cancelling.value = id
    try {
      await amlApi(`/jobs/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) })
      message.success(tt('aml.k1amlx097', { p0: shortId(id) }))
      await loadJobs()
    }
    catch (err) {
      message.error(apiErrorMessage(err))
    }
    finally {
      cancelling.value = ''
    }
  }

  const confirmRetry = ref('')
  const retrying = ref('')

  async function onRetryJob(id: string): Promise<void> {
    if (confirmRetry.value !== id) {
      confirmRetry.value = id
      return
    }
    confirmRetry.value = ''
    retrying.value = id
    try {
      await amlApi(`/jobs/${id}/retry`, { method: 'POST', body: JSON.stringify({}) })
      message.success(tt('aml.k1amlx098', { p0: shortId(id) }))
      await loadJobs()
    }
    catch (err) {
      message.error(apiErrorMessage(err))
    }
    finally {
      retrying.value = ''
    }
  }

  return {
    jobs,
    jobRows,
    jobDetails,
    expandedJob,
    confirmCancel,
    cancelling,
    confirmRetry,
    retrying,
    loadJobs,
    toggleJob,
    refreshJobLogs,
    onCancelJob,
    onRetryJob,
  }
}
