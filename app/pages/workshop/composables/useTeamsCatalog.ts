import { computed, ref } from 'vue'
import { useWorkshopApi, type AgentTemplateDto, type ChannelDto, type TeamDto } from '@/app/composables/workshop/useWorkshopApi'
import { useUserStore } from '@/app/stores/workshop/user'

/** 编组库筛选项:全部 / 我的 / 公开 / 内置 */
export type TeamFilter = 'all' | 'mine' | 'public' | 'builtin'

/** 可见性徽标(内置 = 锁 + 灰;公开 = 绿;私有 = 灰) */
export interface TeamVisTag {
  text: string
  color: string
  icon?: string
}

/** 成员模板下拉项(引擎未安装的模板禁用并在 label 上标注) */
export interface TeamMemberOption {
  value: string
  label: string
  disabled: boolean
}

/**
 * AgentTeam 编组库的目录 + 派生视图态(页面唯一副本):
 *  · 三张清单:编组 / 成员模板 / Channel(SSR 安全:仅客户端发请求)
 *  · harness 可用性:引擎未安装的模板在成员选择里禁用(deploy 由后端 assert 兜底)
 *  · 筛选(全部/我的/公开/内置)、可写判定、可见性徽标、admin 提示
 * 写操作不在这里:见 useTeamActions 与各 useTeam*Dialog。
 */
export function useTeamsCatalog() {
  const api = useWorkshopApi()
  const userStore = useUserStore()
  const { t } = useI18n()

  const teams = ref<TeamDto[]>([])
  const templates = ref<AgentTemplateDto[]>([])
  const channels = ref<ChannelDto[]>([])
  const loading = ref(false)

  const load = async (): Promise<void> => {
    loading.value = true
    try {
      const [teamsRes, tplRes, chRes] = await Promise.all([api.listTeams(), api.listTemplates(), api.listChannels()])
      teams.value = (teamsRes as unknown as { data?: TeamDto[] })?.data ?? []
      templates.value = (tplRes as unknown as { data?: AgentTemplateDto[] })?.data ?? []
      channels.value = (chRes as unknown as { data?: ChannelDto[] })?.data ?? []
    }
    finally {
      loading.value = false
    }
  }
  // SSR 安全:setup 期 $http(axios)无法在服务端发相对地址请求(同 agents 页注释)
  if (import.meta.client) void load()

  // ===== harness 可用性(成员选择禁用引擎未安装的模板;deploy 由后端 assert 兜底) =====
  const harnessAvail = ref<Record<string, boolean>>({})
  const loadHarnessAvail = async (): Promise<void> => {
    try {
      const res = await api.listHarnesses()
      const list = (res as unknown as { data?: { harnesses?: Array<{ id: string, available?: boolean }> } })?.data?.harnesses
      if (Array.isArray(list)) {
        const m: Record<string, boolean> = {}
        for (const h of list) m[h.id] = h.available !== false
        harnessAvail.value = m
      }
    }
    catch { /* 探测不可得时不限制选项(后端仍有强校验) */ }
  }
  if (import.meta.client) void loadHarnessAvail()
  const tplUnavailable = (tpl: AgentTemplateDto): boolean => harnessAvail.value[tpl.harness] === false
  const memberOptions = computed<TeamMemberOption[]>(() => templates.value.map((tpl) => {
    const un = tplUnavailable(tpl)
    return { value: tpl.id, label: un ? `${tpl.name}(${tpl.harness} · ${t('agents.notInstalled')})` : `${tpl.name}(${tpl.harness})`, disabled: un }
  }))

  // ===== 过滤 =====
  const filter = ref<TeamFilter>('all')
  const shown = computed(() => {
    const uid = userStore.user?.id
    switch (filter.value) {
      case 'mine': return teams.value.filter(t => t.ownerUserId === uid)
      case 'public': return teams.value.filter(t => t.visibility === 'public')
      case 'builtin': return teams.value.filter(t => t.isBuiltin)
      default: return teams.value
    }
  })

  const canWrite = (team: TeamDto): boolean =>
    !team.isBuiltin && (team.ownerUserId === userStore.user?.id || userStore.isAdmin)

  const visTag = (team: TeamDto): TeamVisTag => {
    if (team.isBuiltin) return { text: t('teams.k3x23c018'), color: 'default', icon: 'i-tabler-lock' }
    if (team.visibility === 'public') return { text: t('teams.k3wv1t019'), color: 'green' }
    return { text: t('teams.k447jj020'), color: 'default' }
  }

  /** admin 全量视图提示条(页面工具栏右侧) */
  const isAdmin = computed(() => userStore.isAdmin)

  return { teams, channels, loading, load, memberOptions, filter, shown, canWrite, visTag, isAdmin }
}
