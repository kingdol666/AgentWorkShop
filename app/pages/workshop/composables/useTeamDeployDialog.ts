import { ref, watch, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 部署弹窗依赖:开关 + 当前编组 id(提交时才读) */
export interface TeamDeployDialogOptions {
  open: Ref<boolean>
  teamId: () => string | undefined
}

/**
 * 「部署到 Channel」弹窗状态:目标 Channel + confirm-loading。
 * 打开即清空目标选择;成功后关闭且**不刷新编组目录** —— 拆分前的 deploy 也不 reload。
 */
export function useTeamDeployDialog(options: TeamDeployDialogOptions) {
  const api = useWorkshopApi()
  const { t } = useI18n()

  const deployChannelId = ref<string>('')
  const deploying = ref(false)

  watch(options.open, (v) => {
    if (v) deployChannelId.value = ''
  })

  const submit = async (): Promise<void> => {
    const teamId = options.teamId()
    if (!teamId || !deployChannelId.value) {
      message.warning(t('teams.selectChannel'))
      return
    }
    deploying.value = true
    try {
      const res = await api.deployTeam(teamId, deployChannelId.value)
      const agents = (res as unknown as { data?: { agents?: unknown[] } })?.data?.agents?.length ?? 0
      message.success(t('teams.kh90glh031', { p0: agents }))
      options.open.value = false
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      deploying.value = false
    }
  }

  return { deployChannelId, deploying, submit }
}
