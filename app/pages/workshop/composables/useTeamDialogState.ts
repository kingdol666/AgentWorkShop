import { ref } from 'vue'
import type { TeamDto } from '@/app/composables/workshop/useWorkshopApi'

/**
 * 四个弹窗的开关 + "打开时携带的编组"(页面级编排状态)。
 * 载入/提交逻辑在各自的 useTeam*Dialog;这里只留一个开关 + 一个 payload ref,
 * 点击卡片到弹窗出现的时序与拆分前一致(同步写入,不经过 watcher)。
 * 关闭时不清 payload(与拆分前的 addTeam/addTeamRef/plugTeamRef 一样,留着上一次的值)。
 */
export function useTeamDialogState() {
  const createOpen = ref(false)

  const addOpen = ref(false)
  const addTeam = ref<TeamDto | null>(null)
  const openAdd = (team: TeamDto): void => {
    addTeam.value = team
    addOpen.value = true
  }

  const deployOpen = ref(false)
  const deployTeam = ref<TeamDto | null>(null)
  const openDeploy = (team: TeamDto): void => {
    deployTeam.value = team
    deployOpen.value = true
  }

  const plugOpen = ref(false)
  const plugTeam = ref<TeamDto | null>(null)
  const openPlugins = (team: TeamDto): void => {
    plugTeam.value = team
    plugOpen.value = true
  }

  return {
    createOpen,
    addOpen,
    addTeam,
    openAdd,
    deployOpen,
    deployTeam,
    openDeploy,
    plugOpen,
    plugTeam,
    openPlugins,
  }
}
