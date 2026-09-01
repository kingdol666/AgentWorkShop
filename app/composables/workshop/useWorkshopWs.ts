/**
 * Workshop WS 会话 hook:绑定 WorkshopWsSession ↔ stores。
 * ingest 派发:events.ingest + entities.applyEvent + connection 游标;
 * 订阅引用计数(多组件安全挂载/卸载),30s 心跳。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useUserStore } from '../../stores/workshop/user'
import { WorkshopWsSession, useWsConnectionStore } from '../../stores/workshop/connection'
import { useEventsStore } from '../../stores/workshop/events'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useTownBus } from './useTownBus'
import type { AepEnvelope, AepSnapshot } from '#shared/workshop-protocol'

export function useWorkshopWs() {
  const conn = useWsConnectionStore()
  const userStore = useUserStore()
  const events = useEventsStore()
  const entities = useEntitiesStore()
  const townBus = useTownBus()

  // 模块级单例:多组件共享一条连接
  let session: WorkshopWsSession | null = (globalThis as { __workshopWs?: WorkshopWsSession }).__workshopWs ?? null
  // per-channel 已应用 seq(断线续传重放/缓冲重叠的同帧在此单点丢弃;
  // entities/场景计数等下游消费方不再各自防重)
  const appliedSeq = new Map<string, number>()
  if (!session) {
    const s = new WorkshopWsSession(
      (e: AepEnvelope) => {
        // seq 去重收口:快照重置游标;非快照帧 seq 单调,重复帧直接丢弃
        if (e.channelId && typeof e.seq === 'number' && e.seq > 0 && e.type !== 'channel.snapshot') {
          const last = appliedSeq.get(e.channelId) ?? 0
          if (e.seq <= last) return
          appliedSeq.set(e.channelId, e.seq)
          // 重连对齐确认:收到缺口后的新帧(或任意非重复帧)即视为已对齐
          if (conn.pendingReplay) conn.pendingReplay = false
        }
        if (e.type === 'channel.snapshot' && e.channelId) {
          // 快照 = 实体基线对齐(seq 游标以快照为准,服务重启 seq 倒退由此收敛)
          appliedSeq.set(e.channelId, typeof e.seq === 'number' ? e.seq : 0)
          conn.pendingReplay = false
          events.ingest(e)
          entities.applyEvent(e)
          entities.applySnapshot(e.payload as AepSnapshot)
          // 持久化历史(server 驱动):快照后从 DB 拉历史填充时间线
          void events.loadHistory(e.channelId)
        }
        else {
          events.ingest(e)
          entities.applyEvent(e)
        }
        if (typeof e.seq === 'number' && e.seq > 0 && e.channelId) {
          conn.cursors[e.channelId] = e.seq
          s.updateCursor(e.channelId, e.seq) // 推进重连续传游标
        }
        // 旁路广播:小镇场景与时间线拿同一实时事件流(不改既有分发,可注释回退)
        townBus.emit(e)
      },
      (state, retry) => {
        conn.state = state
        conn.retryCount = retry
      },
      // 断线且有订阅游标 → 重连后待对齐(状态条"同步中"提示)
      () => { conn.pendingReplay = true },
      // 重连后首帧到达 → 记录最后数据时间(诚实在线状态);
      // pendingReplay 的清除由 ingest 的对齐语义决定(快照或非重复帧,而非任意首帧)
      () => {
        conn.lastDataAt = Date.now()
      },
    )
    session = s
    ;(globalThis as { __workshopWs?: WorkshopWsSession }).__workshopWs = session
  }

  // 用户 token 注入(登录态变化即时生效;未登录 sub 将被服务端 401 拒绝)
  watch(() => userStore.token, (t) => {
    if (session instanceof WorkshopWsSession) session.userToken = t
  }, { immediate: true })

  const subscribe = (channelId: string): void => {
    // 游标未建立(lastSeq=0/无 ring)时不携带 lastSeq:服务端对其下发
    // channel.snapshot 全量(agents/tasks/queue/messages 实体基线),否则走纯事件
    // 重放路径,空闲成员/历史任务永远不会出现在前端(实体基线缺失)。
    const lastSeq = events.lastSeq(channelId)
    session?.subscribe(channelId, lastSeq > 0 ? lastSeq : undefined)
  }
  const unsubscribe = (channelId: string): void => {
    if (!session) return
    session.unsubscribe(channelId)
    // 引用计数归零才清本地事件缓冲:仍有页面(如总览页)持有订阅时,
    // 控制台卸载不得把对方的时间线/游标抹掉(清了会导致已订阅会话收不到快照重发,实时流静默死亡)
    if (session.refCount(channelId) === 0) events.clear(channelId)
  }
  /** 建连但不订阅 channel:纯场景事件消费方(daq 实时帧)用。
   *  服务端在连接层注册 scene peer,连上即收 daq.reading 等无频道广播。 */
  const ensureConnected = (): void => {
    session?.ensureConnected()
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    // 15s 心跳:pong 停止后 checkStale 的断线感知最坏 ~20-35s(服务强杀的半开连接
    // 无 RST,靠 pong 超时发现);ping 发送失败立即关闭走重连,不等 stale 检测
    heartbeat = setInterval(() => {
      session?.ping()
      session?.checkStale()
    }, 15_000)
  })
  onBeforeUnmount(() => {
    if (heartbeat) clearInterval(heartbeat)
  })

  return { subscribe, unsubscribe, ensureConnected, conn }
}
