import { message } from 'ant-design-vue'
import { useWorkshopApi, type AgentTemplateDto } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 行级写操作依赖:刷新回调 = 页面的 load(成功后 void reload(),与拆分前 void load() 一致) */
export interface AgentTemplateActionsOptions {
  reload: () => void | Promise<void>
}

/**
 * Agent 模板的行级即时写操作:删除 / 启停 / 一键切换可见性。
 * 校验与弹窗提交(新建·编辑)不在这里:见 useAgentTemplateForm。
 */
export function useAgentTemplateActions(options: AgentTemplateActionsOptions) {
  const api = useWorkshopApi()
  const { t: tt } = useI18n()

  const remove = async (t: AgentTemplateDto): Promise<void> => {
    await api.deleteTemplate(t.id)
    message.success(tt('agents.k3n5sd7022'))
    void options.reload()
  }

  const toggleEnabled = async (t: AgentTemplateDto): Promise<void> => {
    await api.updateTemplate(t.id, { enabled: t.enabled === 1 ? 0 : 1 })
    void options.reload()
  }

  /** 一键切换可见性(属主/admin;行内 switch) */
  const toggleVisibility = async (t: AgentTemplateDto, pub: boolean): Promise<void> => {
    try {
      await api.updateTemplate(t.id, { visibility: pub ? 'public' : 'private' })
      message.success(pub ? tt('agents.kxa6cxx023') : tt('agents.k1xxabaf024'))
      void options.reload()
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
  }

  return { remove, toggleEnabled, toggleVisibility }
}
