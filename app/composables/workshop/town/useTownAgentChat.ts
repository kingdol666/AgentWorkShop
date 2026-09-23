/**
 * 小镇视图 — Agent 会话台(实时缓冲 + REST 历史)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 实时:townBus 气泡意图直采进 per-agent 缓冲(不被事件日志上限挤掉);
 *   - 历史:REST 频道事件回放(同一 mapEnvelopeToIntent 语义)+ TTL 缓存 + 手动刷新;
 *   - 合并:历史尾部时间戳之后追加实时行,时间分界天然去重;新消息自动滚底。
 */
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { ComponentPublicInstance, Ref, ShallowRef } from 'vue'
import type { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import { mapEnvelopeToIntent } from '#shared/town-protocol'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { channelColorCss } from '#shared/town-scene-math'
import type { ChatEntry } from './town-view-types'

export function useTownAgentChat(params: {
  selected: Ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>
  entities: ReturnType<typeof useEntitiesStore>
  scene3dRef: ShallowRef<TownScene3D | null>
}) {
  const { selected, entities, scene3dRef } = params
  const { t } = useI18n()

  /** 员工会话台:选中角色时展示其「本人」消息(实时缓冲直采,按 agentId 精确归属;重名不串扰) */
  const agentChatRows = computed<ChatEntry[]>(() => {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return []
    const rows = liveChatBuf.get(sel.id)
    if (!rows || rows.length === 0) return []
    // 只展示历史尾部之后的实时行(REST 回填的历史已包含更早内容,按时间分界去重)
    const lastHistAt = agentHistory.value.length
      ? agentHistory.value[agentHistory.value.length - 1]?.at ?? 0
      : 0
    return rows.filter(r => r.at > lastHistAt)
  })
  const agentChatTitle = computed(() => {
    if (!selected.value || selected.value.kind !== 'agent') return ''
    return scene3dRef.value?.getAgentName?.(selected.value.id) ?? t('townView.k3xdvm125')
  })
  /** 选中角色的实体元数据(状态/harness/角色;驱动会话台头部状态章) */
  const selectedAgentMeta = computed(() => {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return null
    for (const list of Object.values(entities.agents)) {
      const a = (list ?? []).find(x => x.agentId === sel.id)
      if (a) return a
    }
    return null
  })
  /** 选中角色的职务名(卡片标题/身份章):Leader / Worker —— 以职务取代人称,贴近 Agent Harness 习惯 */
  const selectedAgentRoleLabel = computed(() =>
    selectedAgentMeta.value?.role === 'lead' ? 'Leader' : 'Worker',
  )
  const selectedAgentRoleTag = computed(() =>
    selectedAgentMeta.value?.role === 'lead' ? 'LEADER' : 'WORKER',
  )
  const agentChatStateLabel = computed(() => {
    const st = selectedAgentMeta.value?.state
    if (st === 'busy') return t('townView.k3n4l5f163')
    if (st === 'stopped') return t('townView.k3n58d1164')
    return t('townView.k3zcvb115')
  })

  /* ============================================================
   * Agent 会话台消息流(实时 + 历史统一):
   *  - 实时:towmBus 气泡意图直采进 per-agent 缓冲(独立于 30 条上限的
   *    事件日志,其他角色刷屏不会挤掉本角色的行);
   *  - 历史:REST 频道事件回放,经同一 mapEnvelopeToIntent 还原(与头顶
   *    气泡同语义),带 TTL 缓存 + 手动刷新;
   *  - 合并:历史尾部时间戳之后追加实时行,时间分界天然去重。
   * ============================================================ */
  const agentHistory = ref<ChatEntry[]>([])
  const historyLoading = ref(false)
  /** 历史缓存(30s TTL;重选同角色短时间内免拉) */
  const historyCache = new Map<string, { rows: ChatEntry[], at: number }>()
  const HISTORY_TTL_MS = 30_000
  const chatScroll = ref<HTMLElement | null>(null)
  /** 会话记录滚动容器回填(容器随 components/TownAgentInspector.vue 搬移,自动滚底仍由父组件持有) */
  function setChatScroll(el: Element | ComponentPublicInstance | null): void {
    chatScroll.value = (el as HTMLElement | null)
  }
  /** 实时消息缓冲(agentId → 近实时条目;响应式 Map,computed 直接追踪) */
  const liveChatBuf = reactive(new Map<string, ChatEntry[]>())
  const LIVE_CAP = 80

  /** townBus 气泡意图 → 该角色实时缓冲(wireCommon 订阅内调用;与头顶气泡同语义) */
  function appendLiveChat(agentId: string, kind: string, text: string, atRaw: number | string | undefined, seq?: number): void {
    const at = typeof atRaw === 'number' ? atRaw : (atRaw ? Date.parse(String(atRaw)) : Date.now())
    if (!Number.isFinite(at) || at <= 0) return
    let rows = liveChatBuf.get(agentId)
    if (!rows) {
      rows = []
      liveChatBuf.set(agentId, rows)
    }
    // 相邻同文本抖动去重(WS 重连重放窗口)
    const last = rows[rows.length - 1]
    if (last && last.text === text && Math.abs(at - last.at) < 1500) return
    rows.push({ id: `live-${seq ?? at}-${rows.length}`, agentId, text, kind, at, live: true })
    if (rows.length > LIVE_CAP) rows.splice(0, rows.length - LIVE_CAP)
  }

  function cookieToken(): string {
    if (typeof document === 'undefined') return ''
    return (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
  }
  function channelOfAgent(agentId: string): string | undefined {
    for (const cid of Object.keys(entities.agents)) {
      if ((entities.agents[cid] ?? []).some(a => a.agentId === agentId)) return cid
    }
    return undefined
  }

  /** 拉取并缓存该角色的历史对话(按 at 升序;force 跳过 TTL 缓存) */
  async function loadAgentHistory(agentId: string, channelId: string, force = false): Promise<void> {
    const cached = historyCache.get(agentId)
    if (!force && cached && Date.now() - cached.at < HISTORY_TTL_MS) {
      agentHistory.value = cached.rows
      return
    }
    historyLoading.value = true
    try {
      const tok = cookieToken()
      const q = `/api/workshop/channels/${channelId}/events?limit=500&excludeTypes=agent.delta`
      const res = await fetch(q, { headers: tok ? { authorization: `Bearer ${decodeURIComponent(tok)}` } : {} })
      const json = await res.json().catch(() => null)
      // 接口返回 { data: { channelId, total, maxSeq, items } }(旧代码误把 data 当数组迭代,历史一直为空)
      const events: AepEnvelope[] = json?.data?.items ?? (Array.isArray(json?.data) ? json.data : [])
      const rows: ChatEntry[] = []
      for (const e of events) {
        const b = mapEnvelopeToIntent(e)?.bubble
        if (!b || b.agentId !== agentId) continue
        const atRaw = e.at
        const at = typeof atRaw === 'number' ? atRaw : (atRaw ? Date.parse(String(atRaw)) : 0)
        rows.push({ id: `${String(e.seq ?? rows.length)}-${rows.length}`, agentId: b.agentId, text: b.text, kind: b.kind, at, live: false })
      }
      rows.sort((a, b) => a.at - b.at)
      historyCache.set(agentId, { rows, at: Date.now() })
      agentHistory.value = rows
    }
    catch {
      agentHistory.value = []
    }
    finally {
      historyLoading.value = false
    }
  }

  /** 手动刷新历史(会话台头部 ↻ 按钮) */
  function onRefreshHistory(): void {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return
    const cid = channelOfAgent(sel.id)
    if (cid) void loadAgentHistory(sel.id, cid, true)
  }

  // 切换选中角色:重新加载其历史对话
  watch(() => selected.value, (sel) => {
    if (!sel || sel.kind !== 'agent') {
      agentHistory.value = []
      return
    }
    const cid = channelOfAgent(sel.id)
    if (cid) void loadAgentHistory(sel.id, cid)
    else agentHistory.value = []
  }, { immediate: true })

  /** 选中角色的身份色(频道哈希,与场景环同源) */
  const agentChatColor = computed(() => {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return '#35e0a0'
    const cid = channelOfAgent(sel.id)
    return cid ? (channelColorCss(cid) ?? '#35e0a0') : '#35e0a0'
  })

  /** 对话类型标签(工业 HMI 小印章) */
  function chatKindLabel(kind: string): string {
    switch (kind) {
      case 'artifact': return t('townView.k3w9q9165')
      case 'delta': return '……'
      case 'info': return t('townView.k44xa7166')
      case 'error': return t('townView.k3zbgf167')
      default: return ''
    }
  }

  /** 时间戳(HH:MM:SS;空值占位) */
  function fmtTime(at?: number): string {
    if (!at || !Number.isFinite(at) || at <= 0) return '--:--:--'
    const d = new Date(at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  // 新消息自动滚到底部(历史或实时条数变化)
  watch(() => agentHistory.value.length + agentChatRows.value.length, async () => {
    await nextTick()
    const el = chatScroll.value
    if (el) el.scrollTop = el.scrollHeight
  })

  return { agentChatRows, agentChatTitle, selectedAgentMeta, selectedAgentRoleLabel, selectedAgentRoleTag, agentChatStateLabel, agentHistory, historyLoading, appendLiveChat, onRefreshHistory, agentChatColor, chatKindLabel, fmtTime, setChatScroll }
}
