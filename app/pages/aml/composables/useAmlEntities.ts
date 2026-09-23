/**
 * 元数据 CRUD 的删除半边:确认后删元数据 + ./aml 下实体目录。
 * 被引用/生产阶段的会被服务端拒绝并给出原因;删除会影响计数与对账,故回调页面全量收敛。
 */
import { message } from 'ant-design-vue'
import { amlApi } from '../api'

export interface AmlEntitiesDeps {
  reloadDatasets: () => Promise<void>
  reloadModels: () => Promise<void>
  reloadJobs: () => Promise<void>
  reloadOverview: () => Promise<void>
  reloadInventory: () => Promise<void>
}

export function useAmlEntities(deps: AmlEntitiesDeps) {
  const { t: tt } = useI18n()

  /** 确认对话框:antd Modal.confirm(带样式);动态 import 失败时退化为放行(服务端仍有二次校验) */
  async function confirmDialog(text: string): Promise<boolean> {
    try {
      const { Modal } = await import('ant-design-vue')
      return await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: text,
          okText: tt('aml.k1amlx190'),
          cancelText: tt('aml.k1amlx202'),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
    }
    catch {
      return true
    }
  }

  /** 删除实体(元数据 + ./aml 下目录);被引用/生产阶段的会被服务端拒绝并给出原因 */
  async function removeEntity(kind: 'datasets' | 'models' | 'jobs', id: string, confirmText: string): Promise<void> {
    const okToDelete = await confirmDialog(confirmText)
    if (!okToDelete) return
    try {
      await amlApi(`/${kind}/${id}`, { method: 'DELETE' })
      message.success(tt('aml.k1amlx193'))
      if (kind === 'datasets') await deps.reloadDatasets()
      else if (kind === 'models') await deps.reloadModels()
      else await deps.reloadJobs()
      await deps.reloadOverview()
      await deps.reloadInventory()
    }
    catch (err) {
      message.error(`${tt('aml.k1amlx203')}:${apiErrorMessage(err)}`)
    }
  }

  return { removeEntity }
}
