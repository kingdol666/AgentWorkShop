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

/** 过滤器 → 允许的事件类型集合(key = 档位过滤:只看注意级+终局级,open-tag deliveryTier)。导出供回归测试复用。 */
export const FILTER_TYPES: Record<EventFilter, string[] | null> = {
  all: null,
  messages: ['agent.message', 'agent.delta', 'agent.status.message', 'a2a.message'],
  tasks: ['task.status', 'task.progress', 'a2a.artifact'],
  team: ['agent.member', 'task.status'],
  errors: ['error'],
  key: null,
}

/**
 * 单帧是否命中时间线过滤 —— **唯一事实源**。
 * 全量重算(computeTimeline)与增量追加(timeline getter)必须共用本函数,
 * 否则两条路径的语义会悄悄分叉(表现为"刷新后少了/多了几条")。
 *
 * 导出供回归测试使用:测试要验证的是「增量维护 ⊆ 与全量重算等价」,
 * 参照实现必须调用同一个谓词,否则测的是参照写得对不对,而不是实现是否等价。
 *
 * 注意 `filter === 'key'` 是**提前返回**:该档位只看注意级/终局级,
 * 刻意不受 focus 影响(聚焦是"看某人的流",key 是"只看需要我介入的",两者正交)。
 */
export function matchesTimeline(
  e: AepEnvelope,
  filter: EventFilter,
  allow: string[] | null,
  focus: string | null,
): boolean {
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
}

/** 时间线过滤纯函数(全量重算路径;增量路径见 matchesTimeline) */
function computeTimeline(
  items: AepEnvelope[],
  filter: EventFilter,
  allow: string[] | null,
  focus: string | null,
): AepEnvelope[] {
  return items.filter(e => matchesTimeline(e, filter, allow, focus))
}

interface ChannelRing {
  lastSeq: number
  items: AepEnvelope[]
  /**
   * 已消费过的全部 seq(含被 delta 合并吃掉的中间 seq)——loadHistory 的
   * 去重依据:按 item.seq 精确匹配会漏掉合并帧,导致同段 delta 重复插入。
   */
  consumed: Set<number>
}

/** 稳定空数组:让"无数据"返回同一引用,避免下游 computed 每帧产出新数组触发重渲染 */
const EMPTY_ITEMS: AepEnvelope[] = Object.freeze([]) as unknown as AepEnvelope[]

/**
 * 时间线增量缓存。
 *
 * 为什么不再用「key 含 lastSeq 的全量记忆化」:lastSeq 每帧递增 → 每帧必然 miss →
 * 每帧对整条 ring(≤5000)全量过滤一次。改为增量:filter/focus 未变时只并入**新增尾巴**,
 * 已淘汰的头部条目从结果前部摘除。
 *
 * ⚠️ 游标必须用 **seq** 而不是数组下标。ring 满之后是「push 一条 + 头部淘汰一条」,
 * `items.length` 恒等于 RING_CAP 不变,而所有元素整体左移一位 ——
 * 用下标做游标的实现会认为"没有新元素",**静默漏掉每一个新帧**
 * (本仓库的等价性测试正是先在 messages+a1 上抓到这个 off-by-one 才改成 seq 的)。
 */
interface TimelineMemo {
  filter: EventFilter
  focus: string | null
  /** 已并入结果的最大 seq;ring 被重建(快照)时回退为 -1 */
  lastSeq: number
  result: AepEnvelope[]
}

const timelineCache = new Map<string, TimelineMemo>()

/** 在按 seq 升序的数组里找第一个 seq > 目标值 的下标(二分,O(log n)) */
function firstIndexAfterSeq(items: AepEnvelope[], seq: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((items[mid]?.seq ?? 0) > seq) hi = mid
    else lo = mid + 1
  }
  return lo
}

interface ChannelRing {
  lastSeq: number
  items: AepEnvelope[]
  /**
   * 已消费过的全部 seq(含被 delta 合并吃掉的中间 seq)——loadHistory 的
   * 去重依据:按 item.seq 精确匹配会漏掉合并帧,导致同段 delta 重复插入。
   */
  consumed: Set<number>
  /**
   * agentId → 该 agent 的事件子序列(与 items 同生命周期,增量维护)。
   *
   * 为什么需要:lane 视图对**每个成员**各跑一遍 `items.filter(e => e.agentId === id)`,
   * 即每帧 O(L×R) 次谓词调用并分配 L 个新数组(L=成员数、R=ring 长度≤5000)。
   * 取 L=8、R=2000、30 帧/s ≈ 4.8×10⁵ 次谓词/秒,且随会话时长线性劣化(越看越卡)。
   * 有了索引,lane 每帧只读一个已备好的数组 → O(1)。
   * 桶内元素与 items 中**同一个对象引用**(delta 合并是原地改 payload,索引自动可见)。
   */
  byAgent: Map<string, AepEnvelope[]>
}

const EMPTY_RING = (): ChannelRing => ({ lastSeq: 0, items: [], consumed: new Set(), byAgent: new Map() })

/** 尾部追加建档(与 items.push 配对) */
function indexAppend(ring: ChannelRing, e: AepEnvelope): void {
  const key = e.agentId
  if (!key) return
  const bucket = ring.byAgent.get(key)
  if (bucket) bucket.push(e)
  else ring.byAgent.set(key, [e])
}

/** 头部淘汰出档(与 items.splice(0, n) 配对);按引用查找,防同 seq 重放误删 */
function indexEvict(ring: ChannelRing, dropped: AepEnvelope[]): void {
  for (const e of dropped) {
    const bucket = ring.byAgent.get(e.agentId ?? '')
    if (!bucket) continue
    const idx = bucket.indexOf(e)
    if (idx >= 0) bucket.splice(idx, 1)
    if (bucket.length === 0) ring.byAgent.delete(e.agentId ?? '')
  }
}

/** 全量重建索引(排序/批量合并后调用;这类路径每次频道/成员只走一次,成本可接受) */
function reindex(ring: ChannelRing): void {
  ring.byAgent.clear()
  for (const e of ring.items) indexAppend(ring, e)
}

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
    const overflow = ring.items.length - RING_CAP
    if (overflow > 0) ring.items.splice(0, overflow)
    // 排序打乱了插入序 → 索引必须整体重建(批量历史路径,非热路径)
    reindex(ring)
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
    /** 应用过滤 + agent 聚焦后的时间线(虚拟滚动/自动吸底消费;per-channel 增量缓存) */
    timeline(state) {
      return (channelId: string): AepEnvelope[] => {
        const ring = state.rings[channelId]
        if (!ring) return EMPTY_ITEMS
        const filter = state.filters[channelId] ?? 'all'
        const focus = state.focusAgents[channelId] ?? null
        const items = ring.items
        const allow = FILTER_TYPES[filter]
        const maxSeq = items.length > 0 ? (items[items.length - 1]?.seq ?? 0) : -1
        const prev = timelineCache.get(channelId)

        // 需要全量重算的三种情况:
        //  ① 首次 / 过滤态变化 —— 增量无从谈起
        //  ② ring 被重建(channel.snapshot):maxSeq 反而变小(甚至为空)
        //  ③ 缓存里的游标超过当前最大 seq(同上,防御性)
        const needRebuild = !prev
          || prev.filter !== filter
          || prev.focus !== focus
          || (items.length === 0 && prev.result.length > 0)
          || prev.lastSeq > maxSeq
        if (needRebuild) {
          const result = computeTimeline(items, filter, allow, focus)
          timelineCache.set(channelId, { filter, focus, lastSeq: maxSeq, result })
          return result
        }

        // 摘除已淘汰的头部条目(结果与 items 同按 seq 升序 → 只可能从前往后连续失效)
        const headSeq = items[0]?.seq ?? 0
        const res = prev.result
        if (res.length > 0 && (res[0]?.seq ?? 0) < headSeq) {
          let drop = 0
          while (drop < res.length && (res[drop]?.seq ?? 0) < headSeq) drop++
          res.splice(0, drop)
        }

        // 并入新增尾巴:按 seq 定位起点(不能用下标 —— 见 TimelineMemo 的说明)
        if (maxSeq > prev.lastSeq) {
          const from = firstIndexAfterSeq(items, prev.lastSeq)
          for (let i = from; i < items.length; i++) {
            const e = items[i]!
            if (matchesTimeline(e, filter, allow, focus)) res.push(e)
          }
          prev.lastSeq = maxSeq
        }
        return res
      }
    },
    /**
     * 某 agent 的事件子序列(增量索引,O(1) 取用)。
     * lane 视图用它替代 `items.filter(e => e.agentId === id)` —— 后者每帧对每个成员
     * 各扫一遍整条 ring(见 ChannelRing.byAgent 的说明)。
     * 无数据时返回**同一个冻结空数组**,避免下游 computed 每帧产出新引用而触发重渲染。
     */
    agentEvents(state) {
      return (channelId: string, agentId: string): AepEnvelope[] => {
        if (!agentId) return EMPTY_ITEMS
        return state.rings[channelId]?.byAgent.get(agentId) ?? EMPTY_ITEMS
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
        this.rings[e.channelId] = { lastSeq: e.seq, items: [], consumed: new Set([e.seq]), byAgent: new Map() }
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
        indexAppend(ring, e)
        if (ring.items.length > RING_CAP) {
          // 淘汰与索引清理必须同拍,否则索引会持有已出窗条目(查询命中"已看不见"的事件)
          indexEvict(ring, ring.items.splice(0, ring.items.length - RING_CAP))
        }
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
