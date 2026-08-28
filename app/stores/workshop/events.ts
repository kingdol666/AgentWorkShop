/**
 * AEP 事件缓冲:per-channel 环形(ring 5000,与服务端 RING_CAP 同量级)+
 * lastSeq 游标 + 派生 selectors。全部渲染组件从本 store 派生,不直接持有事件。
 */
import { defineStore } from 'pinia'
import { useUserStore } from './user'
import { envelopeTier } from '@/app/composables/workshop/useEventBlocks'
import type { AepEnvelope } from '#shared/workshop-protocol'

const RING_CAP = 5000

/**
 * 历史回放剔除的过程帧:agent.delta 的打字机增量在历史里由落定 agent.message
 * 携带全文(终帧必落库),逐帧重放既浪费窗口又会把单 agent 的流式帧灌满
 * 全局 200 帧限额 —— 其他 agent 的消息一条都进不来(lane 空 <-> 时间线缺消息)。
 */
const HISTORY_EXCLUDE_TYPES = ['agent.delta']

export type EventFilter = 'all' | 'messages' | 'tasks' | 'team' | 'errors' | 'key'

/** 过滤器 → 允许的事件类型集合(key = 档位过滤:只看注意级+终局级,open-tag deliveryTier) */
const FILTER_TYPES: Record<EventFilter, string[] | null> = {
  all: null,
  messages: ['agent.message', 'agent.delta', 'agent.status.message', 'a2a.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  team: ['agent.member', 'task.status'],
  errors: ['error'],
  key: null,
}

/** 时间线过滤纯函数(记忆化缓存的真实计算体) */
function computeTimeline(
  items: AepEnvelope[],
  filter: EventFilter,
  allow: string[] | null,
  focus: string | null,
): AepEnvelope[] {
  return items.filter((e) => {
    if (e.type === 'channel.snapshot') return false
    // key 过滤:只看注意级 + 终局级(open-tag deliveryTier —— agent 噪声让路)
    if (filter === 'key') {
      const t = envelopeTier(e)
      return t === 'attention' || t === 'terminal'
    }
    if (allow && !allow.includes(e.type)) return false
    if (focus && e.type !== 'task.status' && e.type !== 'task.progress') {
      if (e.agentId === focus) return true
      // 消息归属发送方,但发给聚焦 Agent 的消息(a2a.message target)仍属其流
      if (e.type === 'a2a.message') {
        const target = (e.payload as { metadata?: { 'x-aw-target-agent'?: string } }).metadata?.['x-aw-target-agent']
        return target === focus
      }
      return false
    }
    return true
  })
}

/** per-channel 时间线记忆化(key 含 lastSeq/条数/过滤态;原 getter 每访问全量过滤 5000 帧) */
const timelineCache = new Map<string, { key: string, result: AepEnvelope[] }>()

interface ChannelRing {
  lastSeq: number
  items: AepEnvelope[]
  /**
   * 已消费过的全部 seq(含被 delta 合并吃掉的中间 seq)——loadHistory 的
   * 去重依据:按 item.seq 精确匹配会漏掉合并帧,导致同段 delta 重复插入。
   */
  consumed: Set<number>
}

const EMPTY_RING = (): ChannelRing => ({ lastSeq: 0, items: [], consumed: new Set() })

/** 历史接口响应壳(全局/lane 同构) */
interface EventsHistoryRes {
  code: number | string
  data?: { items: AepEnvelope[], total?: number }
}

/**
 * 历史帧合并(共享水路):seq ≤ ceiling 窗口校验(增量路径由 ingest 处理)+
 * consumed 去重(含被合并吃掉的帧)→ 排序归位 + 容量裁剪。返回净新增数。
 */
function mergeHistory(ring: ChannelRing, items: AepEnvelope[], ceiling: number): number {
  let added = 0
  for (const e of items) {
    if (typeof e.seq !== 'number' || e.seq > ceiling) continue
    if (ring.consumed.has(e.seq)) continue
    ring.items.push(e)
    ring.consumed.add(e.seq)
    added += 1
  }
  if (added > 0) {
    ring.items.sort((a, b) => a.seq - b.seq)
    if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
  }
  return added
}

export const useEventsStore = defineStore('workshop.events', {
  state: () => ({
    rings: {} as Record<string, ChannelRing>,
    filters: {} as Record<string, EventFilter>,
    /** 时间线聚焦的 agent(只看该 agent 的流;null = 全部) */
    focusAgents: {} as Record<string, string | null>,
    /** lane 历史已回填的 agent(channelId → agentId 集合;防视图切换重复拉取) */
    laneLoaded: {} as Record<string, Set<string>>,
  }),
  getters: {
    ring(state) {
      return (channelId: string): ChannelRing =>
        state.rings[channelId] ?? EMPTY_RING()
    },
    /** 应用过滤 + agent 聚焦后的时间线(虚拟滚动/自动吸底消费;per-channel 记忆化) */
    timeline(state) {
      return (channelId: string): AepEnvelope[] => {
        const ring = state.rings[channelId]
        if (!ring) return []
        const filter = state.filters[channelId] ?? 'all'
        const focus = state.focusAgents[channelId] ?? null
        const memoKey = `${filter}:${focus ?? ''}:${ring.lastSeq}:${ring.items.length}`
        const hit = timelineCache.get(channelId)
        if (hit && hit.key === memoKey) return hit.result
        const result = computeTimeline(ring.items, filter, FILTER_TYPES[filter], focus)
        timelineCache.set(channelId, { key: memoKey, result })
        return result
      }
    },
    lastSeq(state) {
      return (channelId: string): number => state.rings[channelId]?.lastSeq ?? 0
    },
  },
  actions: {
    /** 消费一帧 AEP(连接回调入口):快照重建 ring,增量追加并推进游标 */
    ingest(e: AepEnvelope): void {
      if (!e.channelId) return
      const ring = this.rings[e.channelId] ?? EMPTY_RING()
      if (e.type === 'channel.snapshot') {
        // 全量对齐:清空 ring,游标对齐快照 seq
        this.rings[e.channelId] = { lastSeq: e.seq, items: [], consumed: new Set([e.seq]) }
        return
      }
      if (typeof e.seq === 'number' && e.seq > ring.lastSeq) {
        ring.consumed.add(e.seq)
        // delta 聚合:同 agent(+同任务)连续增量合并进前一条;跨任务增量绝不粘连
        if (e.type === 'agent.delta') {
          const last = ring.items[ring.items.length - 1]
          const sameOrigin = last
            && last.type === 'agent.delta'
            && last.agentId === e.agentId
            && (last.taskId ?? null) === (e.taskId ?? null)
          if (sameOrigin && last) {
            const prev = (last.payload as { delta: string }).delta
            ;(last.payload as { delta: string }).delta = prev + (e.payload as { delta: string }).delta
            ring.lastSeq = e.seq
            this.rings[e.channelId] = ring
            return
          }
        }
        ring.items.push(e)
        if (ring.items.length > RING_CAP) ring.items.splice(0, ring.items.length - RING_CAP)
        ring.lastSeq = e.seq
        // 防泄漏:超限后从现存 items 重建(合并掉的旧 seq 允许短暂失忆——远早于 ring 窗口)
        if (ring.consumed.size > 20_000) ring.consumed = new Set(ring.items.map(i => i.seq))
        this.rings[e.channelId] = ring
      }
    },
    setFilter(channelId: string, filter: EventFilter): void {
      this.filters[channelId] = filter
    },
    /**
     * 持久化历史拉取(server 驱动):刷新后从 DB 拉最近事件并填充 ring。
     * 与 WS 增量无缝衔接:仅接受 seq ≤ 当前游标的帧;已消费过的 seq
     * (含被 delta 合并吃掉的中间 seq,经 consumed 集合识别)绝不重复插入。
     * 剔除 agent.delta 过程帧:落定 agent.message 携带全文,历史窗口
     * 不被单 agent 的打字机帧淹没(其他 agent 的消息才能进窗口)。
     */
    async loadHistory(channelId: string, limit = 200): Promise<void> {
      if (typeof window === 'undefined') return
      const ring = this.rings[channelId] ?? EMPTY_RING()
      try {
        const res = await $fetch<EventsHistoryRes>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit, excludeTypes: HISTORY_EXCLUDE_TYPES.join(',') }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code !== 0 || !res.data?.items?.length) return
        mergeHistory(ring, res.data.items, ring.lastSeq)
        this.rings[channelId] = ring
      }
      catch { /* 历史拉取失败不阻塞实时流 */ }
    },
    /**
     * 向上翻页加载更早历史(beforeSeq 游标;时间线"加载更早"按钮驱动)。
     * 仅接受 seq < 当前 ring 最小 seq 的帧,插入头部;consumed 去重防御。
     * 返回 false 表示已无更早历史(按钮隐藏)。
     */
    async loadEarlier(channelId: string, limit = 200): Promise<boolean> {
      if (typeof window === 'undefined') return false
      const ring = this.rings[channelId]
      if (!ring) return false
      const minSeq = ring.items.length > 0 ? (ring.items[0]?.seq ?? 0) : ring.lastSeq
      if (minSeq <= 1) return false
      try {
        const res = await $fetch<EventsHistoryRes>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit, beforeSeq: Math.max(1, minSeq - 1), excludeTypes: HISTORY_EXCLUDE_TYPES.join(',') }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code !== 0 || !res.data?.items?.length) return false
        const added = mergeHistory(ring, res.data.items, ring.lastSeq)
        if (added > 0) this.rings[channelId] = ring
        // 返回是否可能还有更早(拉满一页视为有;由下次点击自然探底)
        return added > 0 && res.data.items.length >= limit
      }
      catch {
        return false
      }
    },
    /**
     * lane 历史按需回填:按 agent 维度拉取该成员的全部事件(剔除 delta 过程帧),
     * 合并进 channel ring —— lanes 谓词按 agentId 过滤,时间线同样受益。
     * laneLoaded 守卫保证每订阅生命周期内每 agent 只回填一次(视图切换不重复拉取;
     * clear 随 ring 一并重置);拉取失败移除守卫,下次挂载可重试。
     * 快照竞态防御:ring 未建立(lastSeq=0,channel.snapshot 未到)时先有界等待 ——
     * 过早合并会被快照全量重建整环覆盖,等价于白拉。
     */
    async loadLaneHistory(channelId: string, agentId: string, limit = 200): Promise<void> {
      if (typeof window === 'undefined') return
      if (this.laneLoaded[channelId]?.has(agentId)) return
      ;(this.laneLoaded[channelId] ??= new Set()).add(agentId)
      for (let i = 0; i < 20 && this.lastSeq(channelId) === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (this.lastSeq(channelId) === 0) {
        // 快照迟迟未到(WS 未连/权限拒绝):放弃本次,守卫移除待重试
        this.laneLoaded[channelId]?.delete(agentId)
        return
      }
      const ring = this.rings[channelId]!
      try {
        const res = await $fetch<EventsHistoryRes>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit, agentId, excludeTypes: HISTORY_EXCLUDE_TYPES.join(',') }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code === 0 && res.data?.items?.length) {
          mergeHistory(ring, res.data.items, ring.lastSeq)
          this.rings[channelId] = ring
        }
      }
      catch {
        this.laneLoaded[channelId]?.delete(agentId)
      }
    },
    /**
     * lane 向上翻页:该 agent 在 ring 内的最小 seq 为游标,拉更早一段。
     * 返回 false 表示该 agent 已无更早历史(lane"加载更早"按钮隐藏)。
     */
    async loadLaneEarlier(channelId: string, agentId: string, limit = 200): Promise<boolean> {
      if (typeof window === 'undefined') return false
      const ring = this.rings[channelId]
      if (!ring) return false
      let minSeq = 0
      for (const e of ring.items) {
        if (e.agentId === agentId) {
          minSeq = e.seq
          break
        }
      }
      if (minSeq <= 1) return false
      try {
        const res = await $fetch<EventsHistoryRes>(
          `/api/workshop/channels/${channelId}/events`,
          { params: { limit, agentId, beforeSeq: minSeq - 1, excludeTypes: HISTORY_EXCLUDE_TYPES.join(',') }, headers: { authorization: `Bearer ${useUserStore().token}` } },
        )
        if (res.code !== 0 || !res.data?.items?.length) return false
        const added = mergeHistory(ring, res.data.items, ring.lastSeq)
        if (added > 0) this.rings[channelId] = ring
        return added > 0 && res.data.items.length >= limit
      }
      catch {
        return false
      }
    },

    setFocusAgent(channelId: string, agentId: string | null): void {
      this.focusAgents[channelId] = agentId
    },
    clear(channelId: string): void {
      Reflect.deleteProperty(this.rings, channelId)
      Reflect.deleteProperty(this.laneLoaded, channelId)
    },
  },
})
