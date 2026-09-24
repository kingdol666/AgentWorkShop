import { provide, ref, type ComputedRef } from 'vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'

/**
 * 控制台的覆盖层状态:Agent/Task 抽屉(P1)+ ⌘K 命令面板 / A2A 调试器(P2)。
 *
 * 状态留在页面这一层(而不是收进渲染它们的子组件)是有意的:活动条、中部画布、
 * 右侧 Inspector 三处都要驱动抽屉,页面是所有入口的唯一汇聚点;底部区块只经
 * v-model 读写同一份状态,不产生第二副本。
 *
 * `aw:open-agent` 的 provide 也在这里:它必须由页面(编排层)注入,时间线/lanes
 * 全树(inject)才能解析到同一个开启函数。
 */
export interface WorkspaceTaskTarget { channelId: string, taskId: string }

export function useWorkspacePanels(wsId: ComputedRef<string>) {
  const wsStore = useWorkspacesStore()

  // 抽屉状态(P1)
  const agentDrawerOpen = ref(false)
  const agentDrawerId = ref<string | null>(null)
  const openAgent = (id: string): void => {
    agentDrawerId.value = id
    agentDrawerOpen.value = true
  }
  /** 活动条入口:跨 channel 的 busy 成员 → 先聚焦其 channel 再开抽屉 */
  const openAgentInChannel = (target: { channelId: string, agentId: string }): void => {
    wsStore.setActiveChannel(wsId.value, target.channelId)
    openAgent(target.agentId)
  }
  /** @提及 pill 点击入口(ClusterRoute/ClusterStream inject;时间线与 lanes 全树可用) */
  provide('aw:open-agent', openAgentInChannel)
  const taskDrawerOpen = ref(false)
  const taskDrawerId = ref<string | null>(null)
  const openTask = (target: WorkspaceTaskTarget): void => {
    wsStore.setActiveChannel(wsId.value, target.channelId)
    taskDrawerId.value = target.taskId
    taskDrawerOpen.value = true
  }

  // ⌘K 命令面板 + A2A 调试器(P2)
  const paletteOpen = ref(false)
  const a2aDebugOpen = ref(false)

  return {
    agentDrawerOpen,
    agentDrawerId,
    taskDrawerOpen,
    taskDrawerId,
    paletteOpen,
    a2aDebugOpen,
    openAgent,
    openAgentInChannel,
    openTask,
  }
}
