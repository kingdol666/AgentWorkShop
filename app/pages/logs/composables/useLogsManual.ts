/**
 * 人工记录(值班/处置/备注)弹窗的开合与提交。
 *
 * 草稿由弹窗组件持有(打开时按筛选口径重置),这里只保留「开合 + 提交」两个动作:
 * 成功后立即重查一次(人工事件与自动操作同一流水,必须立刻出现在结果表里)、关窗、提示;
 * 失败由 useOpsLog.error.post 承载(弹窗保持打开,输入不丢),同时弹一条全局错误提示。
 */
import { ref } from 'vue'
import { message } from 'ant-design-vue'
import { useOpsLog } from '@/app/composables/workshop/useOpsLog'

/** 人工记录草稿(弹窗内编辑;提交时按需折叠成 detail.note) */
export interface LogsManualDraft {
  summary: string
  detail: string
  lineId: string
  productId: string
  recipeId: string
}

/** 人工记录的归属口径(打开弹窗时 = 筛选区当前维度) */
export interface LogsManualScope {
  lineId: string
  productId: string
  recipeId: string
}

export interface LogsManualDeps {
  /** 提交成功后的重查(页面接 useLogsQuery 的 doQuery) */
  onPosted: () => void
}

export function useLogsManual(deps: LogsManualDeps) {
  const opsLog = useOpsLog()
  const { t: tt } = useI18n()

  const manualOpen = ref(false)

  function openManual(): void {
    manualOpen.value = true
  }

  async function submitManual(draft: LogsManualDraft): Promise<void> {
    try {
      const note = draft.detail.trim()
      await opsLog.postManual({
        summary: draft.summary.trim(),
        lineId: draft.lineId,
        productId: draft.productId,
        recipeId: draft.recipeId,
        ...(note ? { detail: { note } } : {}),
      })
      message.success(tt('logs.mOk'))
      manualOpen.value = false
      deps.onPosted()
    }
    catch (err) {
      message.error(apiErrorMessage(err))
    }
  }

  return { manualOpen, openManual, submitManual }
}
