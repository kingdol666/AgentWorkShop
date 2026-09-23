import { ref, watch, type Ref } from 'vue'
import { message } from 'ant-design-vue'
import { useWorkshopApi, type ChannelPluginStateDto } from '@/app/composables/workshop/useWorkshopApi'
import { apiErrorMessage } from '@/app/utils/api-error'

/** 团队插件弹层依赖:开关 + 当前编组 id(打开时才读) */
export interface TeamPluginDialogOptions {
  open: Ref<boolean>
  teamId: () => string | undefined
}

/**
 * 团队级插件开关(GET → 展示各插件开关;切换即 PUT)。
 * 打开即清空为"未加载"并拉取该编组的开关视图(source=default 表示未显式配置,默认全启用);
 * 重置同样发生在渲染前(拆分前由页面 openPlugins 同步重置)。
 */
export function useTeamPluginDialog(options: TeamPluginDialogOptions) {
  const api = useWorkshopApi()
  const { t } = useI18n()

  const rows = ref<ChannelPluginStateDto[]>([])
  const source = ref<'explicit' | 'default'>('default')
  const loading = ref(false)
  const saving = ref<string | null>(null)

  const load = async (teamId: string): Promise<void> => {
    loading.value = true
    try {
      const res = await api.listTeamPlugins(teamId)
      const data = res?.data ?? {}
      rows.value = data.plugins ?? []
      source.value = data.source === 'explicit' ? 'explicit' : 'default'
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      loading.value = false
    }
  }

  watch(options.open, (v) => {
    if (!v) return
    rows.value = []
    source.value = 'default'
    const teamId = options.teamId()
    if (teamId) void load(teamId)
  })

  const toggle = async (row: ChannelPluginStateDto, next: boolean): Promise<void> => {
    const teamId = options.teamId()
    if (!teamId || saving.value) return
    saving.value = row.name
    try {
      // PUT 全量提交当前开关视图(仅翻转目标行)
      const payload = rows.value.map(r => ({ name: r.name, enabled: r.name === row.name ? next : r.enabled }))
      const res = await api.putTeamPlugins(teamId, { plugins: payload })
      const data = res?.data ?? {}
      rows.value = data.plugins ?? payload.map(p => ({ ...p }))
      source.value = data.source === 'explicit' ? 'explicit' : 'default'
      message.success(t('teams.k1plugon043'))
    }
    catch (e) {
      message.error(apiErrorMessage(e))
    }
    finally {
      saving.value = null
    }
  }

  return { rows, source, loading, saving, toggle }
}
