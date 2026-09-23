/**
 * 用户级通知 store(v17 主计划 §6)。
 *
 * 事实源是服务端 `user_notifications` 表:`notification.created` 帧只负责"到达",
 * 游标补拉(REST / WS subNotifications)负责"补齐"。因此本 store 的关键不是推送本身,
 * 而是**幂等 + 断线可补**:
 *  - `eventId` 是唯一幂等键 —— 同一条通知既可能经频道流副本、也可能经用户定向帧到达,
 *    重复 eventId 一律丢弃(绝不产生第二行、也不弹第二次);
 *  - `notification.*` 帧的 `seq` 恒为 0 且 `channelId` 可能是空串,不能参与频道 seq 去重,
 *    幂等只能落在本 store 的 eventId 集合上;
 *  - 重连/刷新后按游标向**后**补拉,与直播帧按 id 合并,不丢不重。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AepEnvelope, AepNotification, AepNotificationRead } from '#shared/workshop-protocol'
import { useUserStore } from './user'
import { narrowFetch } from './narrow-fetch'

/** 通知游标(与服务端 `createdAt|id` 复合游标一致) */
export interface NotificationCursor {
  createdAt: string
  id: string
}

/** 单页拉取上限(与服务端 max 200 对齐) */
const PAGE_LIMIT = 50

/** seenEventIds 上限(防长会话内存无限增长;淘汰最旧一半) */
const SEEN_CAP = 2000

interface ApiEnvelope<T> {
  code: number | string
  message?: string
  data?: T | null
}

export const useNotificationsStore = defineStore('workshop.notifications', () => {
  /** 新→旧 */
  const items = ref<AepNotification[]>([])
  const unreadCount = ref(0)
  /** 最新一条的游标(断线补拉的起点) */
  const cursor = ref<NotificationCursor | null>(null)
  /** 已消费的 eventId(幂等键;直播帧与补拉帧共用) */
  const seenEventIds = ref<Set<string>>(new Set())
  /** 快照是否已加载(重连时的路径选择:未加载 → 快照;已加载 → 游标补拉) */
  const loaded = ref(false)
  /** 最近一条**实时**通知(不含补拉/快照):NotificationCenter 据此弹窗,避免重连补发刷屏 */
  const liveItem = ref<AepNotification | null>(null)
  const liveSeq = ref(0)
  /**
   * 补发窗口标志:服务端 subNotifications 会把游标之后的历史通知**以
   * notification.created 帧逐条直发**(ws.ts 的补发循环),与直播帧形状完全一致。
   * 若不区分,重连补发 200 条就会弹 200 个提示 —— 这里在发出订阅帧时开窗、
   * 收到 notification.snapshot 收尾帧时关窗;窗口内照常入库,只是不弹窗。
   */
  const replaying = ref(false)
  let replayTimer: ReturnType<typeof setTimeout> | null = null

  function beginReplay(timeoutMs = 5000): void {
    replaying.value = true
    if (replayTimer) clearTimeout(replayTimer)
    // 兜底:订阅被拒(USER_UNAUTHORIZED)时不会收到收尾帧,窗口必须能自愈
    replayTimer = setTimeout(() => {
      replaying.value = false
      replayTimer = null
    }, timeoutMs)
  }

  function endReplay(): void {
    replaying.value = false
    if (replayTimer) {
      clearTimeout(replayTimer)
      replayTimer = null
    }
  }

  function markSeen(eventId: string): void {
    if (!eventId) return
    const seen = seenEventIds.value
    if (!seen.has(eventId)) seen.add(eventId)
    if (seen.size > SEEN_CAP) {
      // Set 保序:丢弃最早的一半
      const keep = [...seen].slice(-Math.floor(SEEN_CAP / 2))
      seenEventIds.value = new Set(keep)
    }
  }

  /** 按 createdAt 降序插入(同毫秒保持先到先排 => 后到者更靠前) */
  function insertDesc(n: AepNotification): void {
    const list = items.value
    let idx = 0
    while (idx < list.length && list[idx]!.createdAt >= n.createdAt) idx++
    list.splice(idx, 0, n)
  }

  /** 幂等入库;返回是否为**新增**(重复帧返回 false —— 不重复弹窗、不重复计数) */
  function upsertNotification(n: AepNotification, opts: { live?: boolean } = {}): boolean {
    if (!n?.id) return false
    const idx = items.value.findIndex(x => x.id === n.id)
    if (idx >= 0) {
      items.value[idx] = { ...items.value[idx]!, ...n }
      return false
    }
    if (n.eventId && seenEventIds.value.has(n.eventId)) return false
    markSeen(n.eventId)
    insertDesc(n)
    if (!n.readAt) unreadCount.value += 1
    advanceCursor(n)
    if (opts.live) {
      liveItem.value = n
      liveSeq.value += 1
    }
    return true
  }

  /** 游标只朝"更新"方向推进(补拉回来的旧行不倒退游标) */
  function advanceCursor(n: AepNotification): void {
    const cur = cursor.value
    if (!cur || n.createdAt > cur.createdAt || (n.createdAt === cur.createdAt && n.id > cur.id)) {
      cursor.value = { createdAt: n.createdAt, id: n.id }
    }
  }

  /** 帧消费(由 useWorkshopWs 在频道 seq 守卫之外调用:seq=0 / channelId 可能为空) */
  function applyEnvelope(e: AepEnvelope): void {
    if (e.type === 'notification.created') {
      // 补发窗口内不弹窗(仍入库):见 replaying 的说明
      upsertNotification(e.payload as AepNotification, { live: !replaying.value })
      return
    }
    if (e.type === 'notification.read') {
      applyRead(e.payload as AepNotificationRead)
    }
  }

  /** 已读帧(多标签页同步):按单条 / 频道范围 / 全部收敛 */
  function applyRead(p: AepNotificationRead): void {
    const at = p.readAt || new Date().toISOString()
    for (const n of items.value) {
      if (n.readAt) continue
      if (p.id && n.id !== p.id) continue
      if (!p.id && p.channelId && n.channelId !== p.channelId) continue
      n.readAt = at
    }
    unreadCount.value = items.value.filter(n => !n.readAt).length
  }

  /** 抓取一页通知(cursor 为空 = 最新一页) */
  async function fetchPage(c: NotificationCursor | null): Promise<{ notifications: AepNotification[], unreadCount: number, nextCursor: NotificationCursor | null }> {
    const token = useUserStore().token
    const query: Record<string, string> = { limit: String(PAGE_LIMIT) }
    if (c) query.cursor = `${c.createdAt}|${c.id}`
    const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    const res = await narrowFetch<ApiEnvelope<{ notifications: AepNotification[], unreadCount: number, nextCursor: NotificationCursor | null }>>(
      `/api/workshop/notifications?${qs}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    )
    if (res.code !== 0 || !res.data) throw new Error(res.message ?? '通知拉取失败')
    return res.data
  }

  /** 首屏/刷新快照:替换式(以 DB 为准收敛 WS 期间的可能漂移) */
  async function loadSnapshot(): Promise<void> {
    if (typeof window === 'undefined' || !useUserStore().token) return
    try {
      const data = await fetchPage(null)
      items.value = [...(data.notifications ?? [])]
      for (const n of items.value) markSeen(n.eventId)
      unreadCount.value = data.unreadCount ?? items.value.filter(n => !n.readAt).length
      // 快照新→旧:游标取最新一条(数组首元素)
      const newest = items.value[0]
      cursor.value = newest ? { createdAt: newest.createdAt, id: newest.id } : null
      loaded.value = true
    }
    catch {
      // 快照失败不阻塞实时帧(下一帧照常入库)
    }
  }

  /**
   * 断线/重连补拉:以本端游标向**后**取,按 id/eventId 合并(幂等)。
   * 未加载过快照时退化为 loadSnapshot()。
   */
  async function backfill(): Promise<number> {
    if (typeof window === 'undefined' || !useUserStore().token) return 0
    if (!loaded.value) {
      await loadSnapshot()
      return 0
    }
    try {
      const data = await fetchPage(cursor.value)
      let added = 0
      for (const n of data.notifications ?? []) {
        if (upsertNotification(n)) added += 1
      }
      if (data.nextCursor) cursor.value = data.nextCursor
      // 服务端未给 nextCursor(本次为空)时不动游标;未读数以服务端为准
      unreadCount.value = data.unreadCount ?? unreadCount.value
      return added
    }
    catch {
      return 0
    }
  }

  /** 标记已读(REST 为准;先请求后本地收敛,失败抛出交给调用方提示) */
  async function markRead(opts: { id?: string, channelId?: string, all?: boolean }): Promise<number> {
    const token = useUserStore().token
    const res = await narrowFetch<ApiEnvelope<{ ok: boolean, count: number, unreadCount: number, id?: string, channelId?: string }>>(
      '/api/workshop/notifications/read',
      {
        method: 'POST',
        body: { ...opts },
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    )
    if (res.code !== 0 || !res.data) throw new Error(res.message ?? '标记已读失败')
    const at = new Date().toISOString()
    for (const n of items.value) {
      if (n.readAt) continue
      if (opts.id && n.id !== opts.id) continue
      if (!opts.id && !opts.all && opts.channelId && n.channelId !== opts.channelId) continue
      n.readAt = at
    }
    unreadCount.value = res.data.unreadCount ?? items.value.filter(n => !n.readAt).length
    return res.data.count ?? 0
  }

  /** 退出登录:清空本用户可见内容(防串号) */
  function clear(): void {
    items.value = []
    unreadCount.value = 0
    cursor.value = null
    seenEventIds.value = new Set()
    loaded.value = false
    liveItem.value = null
    endReplay()
  }

  return {
    items,
    unreadCount,
    cursor,
    seenEventIds,
    loaded,
    liveItem,
    liveSeq,
    replaying,
    beginReplay,
    endReplay,
    applyEnvelope,
    applyRead,
    upsertNotification,
    loadSnapshot,
    backfill,
    markRead,
    clear,
  }
})
