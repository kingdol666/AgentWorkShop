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
import type { AepEnvelope, AepSnapshot } from '#shared/workshop-protocol'

export function useWorkshopWs() {
  const conn = useWsConnectionStore()
  const userStore = useUserStore()
  const events = useEventsStore()
  const entities = useEntitiesStore()

  // 模块级单例:多组件共享一条连接
  let session: WorkshopWsSession | null = (globalThis as { __workshopWs?: WorkshopWsSession }).__workshopWs ?? null
  if (!session) {
    const s = new WorkshopWsSession(
      (e: AepEnvelope) => {
        events.ingest(e)
        entities.applyEvent(e)
        if (e.type === 'channel.snapshot') {
          entities.applySnapshot(e.payload as AepSnapshot)
          // 持久化历史(server 驱动):快照后从 DB 拉历史填充时间线
          void events.loadHistory(e.channelId)
        }
        if (typeof e.seq === 'number' && e.seq > 0 && e.channelId) {
          conn.cursors[e.channelId] = e.seq
          s.updateCursor(e.channelId, e.seq) // 推进重连续传游标
        }
      },
      (state, retry) => {
        conn.state = state
        conn.retryCount = retry
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
    session?.subscribe(channelId, events.lastSeq(channelId))
  }
  const unsubscribe = (channelId: string): void => {
    session?.unsubscribe(channelId)
    events.clear(channelId)
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    heartbeat = setInterval(() => {
      session?.ping()
      session?.checkStale()
    }, 30_000)
  })
  onBeforeUnmount(() => {
    if (heartbeat) clearInterval(heartbeat)
  })

  return { subscribe, unsubscribe, conn }
}
