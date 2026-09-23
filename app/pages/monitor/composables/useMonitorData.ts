/**
 * 监控页的数据面:快照轮询、自动刷新定时器、终止动作。
 *
 * 副作用只在这里注册一次 —— 快照(ref)与 5s 定时器都是**唯一副本**,页面调一次、
 * 子组件只消费 props,所以拆组件不会多出第二份实时数据或第二个定时器;
 * onMounted 建定时器与 onBeforeUnmount 拆定时器仍成对出现在同一个 composable 里
 * (子组件不碰任何订阅/清理,调用方也无须再造一遍清理逻辑)。
 */
import { message } from 'ant-design-vue'
import type { AgentView, ApiEnvelope, MonitorSnapshot, ProcessView } from '../types'
import { narrowFetch } from '../../../stores/workshop/narrow-fetch'
import { useUserStore } from '../../../stores/workshop/user'

export interface MonitorDataHooks {
  /** 首次拉取完成后的回调(?agentId=&channelId= 深链自动开终端;只有 onMounted 那次拉取会触发) */
  onInitialPoll?: () => void
}

export function useMonitorData(hooks: MonitorDataHooks = {}) {
  const { t } = useI18n()
  const userStore = useUserStore()

  const snapshot = ref<MonitorSnapshot | null>(null)
  const loading = ref(false)
  const autoRefresh = ref(true)
  const lastUpdated = ref('')

  const poll = async (): Promise<void> => {
    if (!userStore.token) return
    loading.value = true
    try {
      const res = await narrowFetch<ApiEnvelope<MonitorSnapshot>>('/api/system/monitor', {
        headers: { authorization: `Bearer ${userStore.token}` },
      })
      snapshot.value = res.data
      lastUpdated.value = new Date().toLocaleTimeString()
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : t('monitor.loadFailed'))
    }
    finally {
      loading.value = false
    }
  }

  // 自动刷新(默认 5s;仅在已登录且有 token 时轮询)
  let timer: ReturnType<typeof setInterval> | null = null
  const applyTimer = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (autoRefresh.value && userStore.token) {
      timer = setInterval(() => void poll(), 5000)
    }
  }
  watch(autoRefresh, () => applyTimer())
  watch(() => userStore.token, () => {
    if (userStore.token) void poll()
    else snapshot.value = null
    applyTimer()
  })

  onMounted(() => {
    if (userStore.token) {
      void poll().then(() => hooks.onInitialPoll?.())
    }
    applyTimer()
  })
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
  })

  // ===== 终止动作 =====
  const terminating = ref(false)
  const doTerminateAgent = async (a: AgentView): Promise<void> => {
    terminating.value = true
    try {
      const res = await narrowFetch<ApiEnvelope<{ agentId: string, stopped: boolean }>>('/api/system/monitor/terminate', {
        method: 'POST',
        headers: { authorization: `Bearer ${userStore.token}` },
        body: { channelId: a.channelId, agentId: a.agentId },
      })
      message.success(res.code === 0 ? `${a.name} ${t('monitor.terminated')}` : (res.message ?? t('monitor.failed')))
      await poll()
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : t('monitor.failed'))
    }
    finally {
      terminating.value = false
    }
  }

  const doTerminatePid = async (p: ProcessView): Promise<void> => {
    terminating.value = true
    try {
      const res = await narrowFetch<ApiEnvelope<{ pid: number, killed: boolean }>>('/api/system/monitor/terminate', {
        method: 'POST',
        headers: { authorization: `Bearer ${userStore.token}` },
        body: { pid: p.pid },
      })
      message.success(res.code === 0 ? `PID ${p.pid} ${t('monitor.terminated')}` : (res.message ?? t('monitor.failed')))
      await poll()
    }
    catch (e) {
      message.error(e instanceof Error ? e.message : t('monitor.failed'))
    }
    finally {
      terminating.value = false
    }
  }

  return {
    snapshot,
    loading,
    autoRefresh,
    lastUpdated,
    terminating,
    poll,
    doTerminateAgent,
    doTerminatePid,
  }
}
