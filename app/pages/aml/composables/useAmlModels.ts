/**
 * 模型注册表:阶段徽标 + 指标 + 两段确认晋升。
 * 晋升会改变 production 计数,因此需要回调页面刷新概览条。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { amlApi } from '../api'
import type { AmlModelRow, AmlModelStage } from '../types'

export interface AmlModelsDeps {
  /** 晋升/退役后概览条的 production 计数需要跟着收敛 */
  reloadOverview: () => Promise<void>
}

export function useAmlModels(deps: AmlModelsDeps) {
  const { t: tt } = useI18n()

  const models = ref<AmlModelRow[]>([])

  async function loadModels(): Promise<void> {
    try {
      const data = await amlApi<{ models: AmlModelRow[] }>('/models')
      models.value = data.models
    }
    catch { /* 静默保旧值 */ }
  }

  const confirmPromote = ref('')
  const promoting = ref('')

  async function onPromote(m: AmlModelRow, to: Exclude<AmlModelStage, 'candidate'>): Promise<void> {
    const key = `${m.id}:${to}`
    if (confirmPromote.value !== key) {
      confirmPromote.value = key
      return
    }
    confirmPromote.value = ''
    promoting.value = key
    try {
      const r = await amlApi<{ ok: boolean, from?: AmlModelStage, retiredId?: string }>(`/models/${m.id}/promote`, {
        method: 'POST',
        body: JSON.stringify({ toStage: to }),
      })
      if (r.ok) message.success(tt('aml.k1amlx132', { p0: r.from ?? m.stage, p1: to }))
      await Promise.all([loadModels(), deps.reloadOverview()])
    }
    catch (err) {
      message.error(apiErrorMessage(err))
    }
    finally {
      promoting.value = ''
    }
  }

  return { models, confirmPromote, promoting, loadModels, onPromote }
}
