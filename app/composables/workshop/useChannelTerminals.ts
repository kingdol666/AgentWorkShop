/**
 * useChannelTerminals —— harness 终端会话轮询(rpc-ui HITL;每成员独立 omp 会话)。
 *
 * 数据面:GET /workshop/channels/:id/terminals,5 秒轮询一次,归一出
 * agentId → 存活会话映射(lane 头徽标 + 终端按钮态)。
 * onMounted/onBeforeUnmount 由调用组件(AgentLanesView)的 setup 继承,生命周期与
 * 拆分前完全一致:挂载即拉一次并起定时器,卸载清定时器;该 composable 只实例化一次。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useWorkshopApi, type TerminalSessionDto } from '@/app/composables/workshop/useWorkshopApi'
import { agentHueColor } from '@/app/composables/workshop/useEventBlocks'

/** harness 终端徽章色(antd 语义 → 本设计 tone 点;仅作指示,文字仍说明状态) */
export const TERM_DOT: Record<string, string> = {
  processing: 'var(--tone-live-dot)',
  warning: 'var(--tone-warning-dot)',
  success: 'var(--tone-success-dot)',
}

/** 终端会话 → 徽章文案 + 语义色(null = 无存活会话,不渲染徽标) */
export const termBadge = (t: TerminalSessionDto | undefined): { text: string, color: string } | null => {
  if (!t) return null
  if (t.streaming) return { text: 'streaming', color: 'processing' }
  if (t.running) return { text: 'turn', color: 'warning' }
  return { text: 'idle', color: 'success' }
}

/** 泳道身份:头像章 + 稳定身份色(与聊天头像/提及卡同一哈希色相源) */
export const laneInitial = (name: string): string => name.trim().charAt(0).toUpperCase() || '?'
export const laneHue = (id: string): string => agentHueColor(id)

export function useChannelTerminals(channelId: () => string) {
  const api = useWorkshopApi()

  const terminals = ref<TerminalSessionDto[]>([])
  /** agentId → 存活终端会话(lane 头徽标 + 终端按钮态) */
  const terminalOf = computed(() => {
    const map = new Map<string, TerminalSessionDto>()
    for (const t of terminals.value) {
      if (!t.alive || !t.agentId) continue
      map.set(t.agentId, t)
    }
    return map
  })

  let terminalsTimer: ReturnType<typeof setInterval> | null = null
  const loadTerminals = async (): Promise<void> => {
    try {
      const res = await api.listChannelTerminals(channelId())
      terminals.value = res.data ?? []
    }
    catch { /* 轮询失败静默(下次恢复) */ }
  }

  onMounted(() => {
    void loadTerminals()
    terminalsTimer = setInterval(() => void loadTerminals(), 5000)
  })
  onBeforeUnmount(() => {
    if (terminalsTimer) clearInterval(terminalsTimer)
  })

  return { terminals, terminalOf, loadTerminals }
}
