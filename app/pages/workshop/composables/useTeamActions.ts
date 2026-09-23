import { message } from 'ant-design-vue'
import { useWorkshopApi, type TeamDto } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 卡片即时写操作依赖:刷新编组目录(页面把 useTeamsCatalog().load 传进来) */
export interface TeamActionsOptions {
  reload: () => void | Promise<void>
}

/**
 * 编组卡片上的即时写操作(不需要弹窗的三个):一键切换可见性 / 删除编组 / 移除成员。
 * 成功后统一 reload 目录(与拆分前 void load() 同一条链路)。
 * removeMember / removeTeam 拆分前就没有 catch —— 保持原样(统一由调用链路上层兜底),
 * 只有 toggleVisibility 自带 message.error 分支。
 */
export function useTeamActions(options: TeamActionsOptions) {
  const api = useWorkshopApi()
  const { t } = useI18n()

  /** 一键切换可见性(属主/admin) */
  const toggleVisibility = async (team: TeamDto, pub: boolean): Promise<void> => {
    try {
      await api.updateTeam(team.id, { visibility: pub ? 'public' : 'private' })
      message.success(pub ? t('teams.k1globhp023') : t('teams.k1xxabaf024'))
      void options.reload()
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
  }

  const removeMember = async (team: TeamDto, templateId: string): Promise<void> => {
    await api.removeTeamMember(team.id, templateId)
    void options.reload()
  }

  const removeTeam = async (team: TeamDto): Promise<void> => {
    await api.deleteTeam(team.id)
    message.success(t('teams.k1oxjrxx027'))
    void options.reload()
  }

  return { toggleVisibility, removeMember, removeTeam }
}
