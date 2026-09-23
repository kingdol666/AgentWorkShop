import { computed, ref } from 'vue'
import { useWorkshopApi, type HarnessMetaDto } from '@/app/composables/workshop/useWorkshopApi'

/** harness 下拉项(未安装 = label 标注 + 禁用) */
export interface HarnessOption {
  value: string
  label: string
  disabled: boolean
}

/**
 * harness 注册表(引擎注册表动态拉取,含环境可用性探测;失败回退静态表)——
 * 页面唯一副本:能力矩阵徽标 capBadges、可用性 isUnavailable、元信息 harnessMeta、
 * 下拉项 harnessOptions 都在这里派生一次,由页面分发给模板表格与编辑弹窗。
 * 两个子组件不得各自再算一遍(同一条"引擎未安装"判据要处处一致),拉取也只注册一次。
 */
export function useAgentHarnessOptions() {
  const api = useWorkshopApi()
  const { t: tt } = useI18n()

  const harnesses = ref<HarnessMetaDto[]>([])
  const harnessById = computed(() => new Map(harnesses.value.map(h => [h.id, h])))
  /** 按 id 取注册表元信息(页面/子组件共用的唯一取数口) */
  const harnessMeta = (id: string): HarnessMetaDto | undefined => harnessById.value.get(id)
  const isUnavailable = (id: string): boolean => harnessById.value.get(id)?.available === false
  const harnessOptions = computed<HarnessOption[]>(() =>
    (harnesses.value.length > 0
      ? harnesses.value
      : [
          { id: 'mock', label: tt('agents.hMock'), description: '', capabilities: { steer: true, supervise: false, hitl: false, terminal: false, contextStats: false, compact: false } },
          { id: 'omp', label: tt('agents.hOmp'), description: '', capabilities: { steer: true, supervise: true, hitl: true, terminal: true, contextStats: true, compact: true } },
          { id: 'claude', label: 'claude', description: '', capabilities: { steer: false, supervise: false, hitl: false, terminal: false, contextStats: false, compact: false } },
        ] as HarnessMetaDto[]).map((h) => {
      const unavailable = h.available === false
      return { value: h.id, label: unavailable ? `${h.label}(${tt('agents.notInstalled')})` : h.label, disabled: unavailable }
    }),
  )
  const capBadges = (id: string): string[] => {
    const caps = harnesses.value.find(h => h.id === id)?.capabilities
    if (!caps) return []
    const out: string[] = []
    if (caps.steer) out.push('steer')
    if (caps.supervise) out.push('lead')
    if (caps.hitl) out.push('HITL')
    if (caps.compact) out.push('compact')
    return out
  }
  const loadHarnesses = async (): Promise<void> => {
    try {
      const res = await api.listHarnesses()
      const list = (res as unknown as { data?: { harnesses?: HarnessMetaDto[] } })?.data?.harnesses
      if (Array.isArray(list) && list.length > 0) harnesses.value = list
    }
    catch { /* 回退静态表 */ }
  }
  if (import.meta.client) void loadHarnesses()

  return { harnesses, harnessMeta, isUnavailable, harnessOptions, capBadges }
}
