import { ref, watch, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 加入成员弹窗依赖:开关 + 当前编组 id(提交时才读)+ 成功后的刷新回调 */
export interface TeamAddMemberDialogOptions {
  open: Ref<boolean>
  teamId: () => string | undefined
  onAdded: () => void | Promise<void>
}

/**
 * 「加入成员」弹窗状态:选成员模板 + 选角色(lead/worker)。
 * 打开即回到初始态 —— 拆分前由页面 openAdd 同步重置,时序等价(watcher 在渲染前 flush,
 * 弹窗可见时表单一定已是空的)。
 */
export function useTeamAddMemberDialog(options: TeamAddMemberDialogOptions) {
  const api = useWorkshopApi()
  const { t } = useI18n()

  const addTemplateId = ref<string>('')
  const addRole = ref<'lead' | 'worker'>('worker')

  watch(options.open, (v) => {
    if (!v) return
    addTemplateId.value = ''
    addRole.value = 'worker'
  })

  const submit = async (): Promise<void> => {
    const teamId = options.teamId()
    if (!teamId || !addTemplateId.value) {
      message.warning(t('teams.k1kw4rtj025'))
      return
    }
    try {
      await api.addTeamMember(teamId, { agentId: addTemplateId.value, role: addRole.value })
      message.success(t('teams.k3n5hzw026'))
      options.open.value = false
      void options.onAdded()
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
  }

  return { addTemplateId, addRole, submit }
}
