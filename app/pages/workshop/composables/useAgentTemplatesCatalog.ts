import { computed, ref } from 'vue'
import { useWorkshopApi, type AgentTemplateDto } from '@/app/composables/workshop/useWorkshopApi'
import { useUserStore } from '@/app/stores/workshop/user'
import { seedName } from '@/app/utils/builtin-catalog'

/** 模板库筛选项:全部 / 我的 / 公开 / 内置(admin 另有"他人私有") */
export type AgentTemplateFilter = 'all' | 'mine' | 'public' | 'builtin' | 'others'

/** 筛选项(带计数的 label) */
export interface AgentTemplateFilterOption {
  value: AgentTemplateFilter
  label: string
}

/** 可见性徽标(内置 = 锁 + 灰;公开 = 绿;私有 = 灰) */
export interface AgentTemplateVisTag {
  text: string
  color: string
  icon?: string
}

/**
 * Agent 模板库目录 + 派生视图态(页面唯一副本):
 *  · 模板清单(SSR 安全:仅客户端发请求)+ 载入态
 *  · 筛选(全部/我的/公开/内置;admin 另有"他人私有")、计数、可写判定、可见性徽标
 *  · 内置种子模板显示名(tplName)
 * 行级写操作不在这里:见 useAgentTemplateActions;弹窗表单/提交见 useAgentTemplateForm。
 */
export function useAgentTemplatesCatalog() {
  const api = useWorkshopApi()
  const userStore = useUserStore()
  const { t: tt } = useI18n()

  /** 内置种子模板按稳定 id 翻译(服务端种子名是中文数据);自建/改名回退原名 */
  const tplName = (r: { id: string, name: string }): string => seedName(tt, r)

  const templates = ref<AgentTemplateDto[]>([])
  const loading = ref(false)
  const load = async (): Promise<void> => {
    loading.value = true
    try {
      const res = await api.listTemplates()
      templates.value = (res as unknown as { data?: AgentTemplateDto[] })?.data ?? []
    }
    finally {
      loading.value = false
    }
  }
  // SSR 安全:setup 期 $http(axios)无法在服务端发相对地址请求,拒绝会变成未处理
  // rejection 直杀渲染进程;页面数据一律客户端装载
  if (import.meta.client) void load()

  // ===== 过滤(全部/我的/公开/内置;admin 另有"他人私有") =====
  const filter = ref<AgentTemplateFilter>('all')
  const filterOptions = computed<AgentTemplateFilterOption[]>(() => {
    const opts: AgentTemplateFilterOption[] = [
      { value: 'all', label: tt('chips.chipAll', { n: templates.value.length }) },
      { value: 'mine', label: tt('chips.chipMine', { n: templates.value.filter(t => t.ownerUserId === userStore.user?.id).length }) },
      { value: 'public', label: tt('chips.chipPublic', { n: templates.value.filter(t => t.visibility === 'public').length }) },
      { value: 'builtin', label: tt('chips.chipBuiltin', { n: templates.value.filter(t => t.isBuiltin).length }) },
    ]
    if (userStore.isAdmin) {
      opts.push({ value: 'others', label: tt('chips.chipOthers', { n: templates.value.filter(t => t.ownerUserId !== null && t.ownerUserId !== userStore.user?.id && t.visibility === 'private').length }) })
    }
    return opts
  })
  const shown = computed(() => {
    const uid = userStore.user?.id
    switch (filter.value) {
      case 'mine': return templates.value.filter(t => t.ownerUserId === uid)
      case 'public': return templates.value.filter(t => t.visibility === 'public')
      case 'builtin': return templates.value.filter(t => t.isBuiltin)
      case 'others': return templates.value.filter(t => t.ownerUserId !== null && t.ownerUserId !== uid && t.visibility === 'private')
      default: return templates.value
    }
  })

  // 写权限:属主或 admin;内置/他人公开模板只读
  const canWrite = (t: AgentTemplateDto): boolean =>
    !t.isBuiltin && (t.ownerUserId === userStore.user?.id || userStore.isAdmin)

  const visTag = (t: AgentTemplateDto): AgentTemplateVisTag => {
    if (t.isBuiltin) return { text: tt('agents.k3x23c017'), color: 'default', icon: 'i-tabler-lock' }
    if (t.visibility === 'public') return { text: tt('agents.k3wv1t018'), color: 'green' }
    return { text: tt('agents.k447jj019'), color: 'default' }
  }

  /** admin 全量视图提示条(页面工具栏右侧) */
  const isAdmin = computed(() => userStore.isAdmin)

  return { loading, load, tplName, filter, filterOptions, shown, canWrite, visTag, isAdmin }
}
