import { onUnmounted, ref } from 'vue'
import { apiErrorMessage } from '@/app/utils/api-error'
import { apiFetch } from '~/composables/workshop/apiClient'

/**
 * 本地调整待确认队列(产线 Co-Pilot 经验采集)—— 采集器推断的「非平台写入」设定值
 * 变化,未经人工确认不进经验总结(铁律:待确认队列人工转正)。
 *
 * 数据源 GET /api/workshop/exp/confirmations?lineId=&status=pending;裁决走
 * POST /api/workshop/exp/confirmations/:id/decide({ ok }):确认=认可为产线侧本地
 * 调整,进入经验总结流水线;忽略=不总结。乐观更新(行即时消失)+失败回滚+行内报错。
 * 轮询节拍可配(详情卡默认 30s,对齐 useDcwParamApprovals;总览角标传 60s),
 * 页面卸载清理;详情页传 lineId 只拉本产线,总览页不传一次拉全量。
 */

/** 确认行(服务端确认队列条目的客户端投影;只取用到的字段) */
export interface ExpConfirmRow {
  id: string
  lineId: string
  nodeId: string
  nodeName: string
  /** 变化前/后设定值(采集器轮间 diff 检出) */
  from: number
  to: number
  /** 检出时刻(ISO) */
  at: string
  /** 判定依据一句话(如「±窗内无平台写入锚」) */
  evidence: string
  status: 'pending' | 'confirmed' | 'ignored'
  decidedBy?: string
  decidedAt?: string
}

export function useExpConfirmations(opts: {
  /** 详情页传当前产线取值函数:GET 只拉本产线;总览页不传,一次拉全量 */
  lineId?: () => string
  /** 轮询间隔(ms);默认 30s */
  intervalMs?: number
} = {}) {
  const { t } = useI18n()

  const items = ref<ExpConfirmRow[]>([])
  const loading = ref(false)
  /** 在飞裁决的行 id(行内按钮禁用) */
  const decidingId = ref('')
  /** 裁决失败提示(后端可读文案优先;i18n 兜底;成功即清空) */
  const decideError = ref('')

  async function load(): Promise<void> {
    loading.value = true
    try {
      const q = new URLSearchParams({ status: 'pending' })
      const lid = opts.lineId?.()
      if (lid) q.set('lineId', lid)
      const r = await apiFetch<{ confirmations?: ExpConfirmRow[] }>({ base: '/api/workshop/exp/confirmations', path: `?${q.toString()}` })
      items.value = r.confirmations ?? []
    }
    catch {
      // 轮询失败保持既有数据(空态不渲染整卡,不打扰产线操作台)
    }
    finally {
      loading.value = false
    }
  }

  /** 手动刷新(裁决链路之外的兜底入口) */
  async function refresh(): Promise<void> {
    await load()
  }

  /** 裁决:ok=true 确认(进经验总结);false 忽略(不总结)。乐观移除+失败回滚 */
  async function decide(id: string, ok: boolean): Promise<void> {
    if (decidingId.value)
      return
    decidingId.value = id
    decideError.value = ''
    const snapshot = items.value
    items.value = items.value.filter(c => c.id !== id)
    try {
      await apiFetch({
        base: '/api/workshop/exp/confirmations',
        path: `/${encodeURIComponent(id)}/decide`,
        init: { method: 'POST', body: JSON.stringify({ ok }) },
      })
    }
    catch (err) {
      items.value = snapshot
      decideError.value = apiErrorMessage(err, t('expConfirm.decideFail'))
      return
    }
    finally {
      decidingId.value = ''
    }
    await load()
  }

  // 数据轮询(详情卡 30s / 总览角标 60s);页面卸载清理
  const timer = setInterval(() => {
    void load()
  }, opts.intervalMs ?? 30_000)
  onUnmounted(() => clearInterval(timer))

  void load()

  return { items, loading, refresh, decide, decidingId, decideError }
}
