/**
 * Workshop WS 会话 hook:绑定 WorkshopWsSession ↔ stores。
 * ingest 派发:events.ingest + entities.applyEvent + connection 游标;
 * 订阅引用计数(多组件安全挂载/卸载),30s 心跳。
 *
 * v17 追加两条通道(不改变既有 seq 去重与快照语义):
 *  - 频道流 chat.*(chat.message/delivery/member/settings):落 **同一个 appliedSeq 守卫之后**,
 *    重复 seq 帧在守卫处就被丢弃,群聊层不必再自证幂等(store 内仍按 id 去重兜底);
 *  - 用户级 notification.*(seq=0、channelId 可能为空):**不能**进频道 seq 守卫,
 *    与既有 hitl.* 分支同级消费,幂等由 notifications store 的 eventId 集合负责。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { useUserStore } from '../../stores/workshop/user'
import { WorkshopWsSession, useWsConnectionStore } from '../../stores/workshop/connection'
import { useEventsStore } from '../../stores/workshop/events'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useHitlStore } from '../../stores/workshop/hitl'
import { useChatStore, type ChatPermissions } from '../../stores/workshop/chat'
import { useNotificationsStore } from '../../stores/workshop/notifications'
import { useTownBus } from './useTownBus'
import type { AepChatSnapshot, AepEnvelope, AepSnapshot } from '#shared/workshop-protocol'

// 心跳单例(模块作用域):所有 useWorkshopWs() 调用方共享一个 15s 定时器,
// 避免每组件实例一份冗余 ping 打向同一会话
let heartbeat: ReturnType<typeof setInterval> | null = null
let heartbeatUsers = 0

/**
 * 通知订阅引用计数(模块作用域):会话是全局单例,两个组件同时宿主通知
 * (页头铃铛 + 可能的抽屉)时只发一次 subNotifications,最后一个释放才退订。
 */
let notificationHosts = 0
let notificationsSubscribed = false

export function useWorkshopWs() {
  const conn = useWsConnectionStore()
  const userStore = useUserStore()
  const events = useEventsStore()
  const entities = useEntitiesStore()
  const hitl = useHitlStore()
  const chat = useChatStore()
  const notifications = useNotificationsStore()
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
          // v17:群聊侧基线(成员/最近消息/设置/能力)与快照同帧到达,投影在服务端完成(§13.1)
          const payload = e.payload as { chat?: AepChatSnapshot | null, permissions?: ChatPermissions | null }
          chat.applySnapshot(e.channelId, payload.chat ?? null, payload.permissions)
          // 持久化历史(server 驱动):快照后从 DB 拉历史填充时间线
          void events.loadHistory(e.channelId)
        }
        else {
          events.ingest(e)
          entities.applyEvent(e)
          // 群聊帧走频道流(seq/snapshot/重放):与 events/entities 共用同一 seq 守卫,
          // 重复帧已在守卫处 return,这里只在"首次应用"时落库(store 内仍按 id 去重)
          if (typeof e.type === 'string' && e.type.startsWith('chat.')) chat.applyEnvelope(e)
        }
        // HITL 全局待办(频道帧 + channelId='' 全员直推各到一次,store 内 kind+id 幂等)
        if (e.type === 'hitl.request' || e.type === 'hitl.resolved') hitl.applyEnvelope(e)
        // 用户级通知:seq 恒为 0,不能参与上面的频道 seq 游标(否则游标被 0 覆盖导致重放失效);
        // 幂等由 notifications store 的 eventId 负责
        if (e.type === 'notification.created' || e.type === 'notification.read') notifications.applyEnvelope(e)
        // subNotifications 补发收尾帧:关闭"补发中"窗口(窗口内入库但不弹窗)
        if (e.type === 'notification.snapshot') notifications.endReplay()
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
        // 重连成功 → 通知按游标补拉(REST 是事实源;与直播帧按 eventId 合并,幂等)
        if (state === 'open') void notifications.backfill()
      },
      // 断线且有订阅游标 → 重连后待对齐(状态条"同步中"提示)
      () => { conn.pendingReplay = true },
      // 重连后首帧到达 → 记录最后数据时间(诚实在线状态);
      // pendingReplay 的清除由 ingest 的对齐语义决定(快照或非重复帧,而非任意首帧)
      () => {
        conn.lastDataAt = Date.now()
        // 首帧到达说明服务端已处理完本连接的 sub(peer 已按 token 绑定 userId)→ 此时
        // 发通知订阅帧才有意义(早于 sub 发送会被服务端以 USER_UNAUTHORIZED 拒绝)
        if (notificationsSubscribed) sendNotificationsSub()
        // 数据帧到达 = 断线期间的缺口已由重放/快照对齐 → 通知同样补齐
        void notifications.backfill()
      },
    )
    session = s
    ;(globalThis as { __workshopWs?: WorkshopWsSession }).__workshopWs = session
  }

  /**
   * 发送一条上行帧。
   *
   * `WorkshopWsSession` 只暴露 sub/unsub/ping 三个语义方法(该类由连接层独占维护),
   * 通知订阅帧没有对应方法 —— 这里以最小侵入方式取底层 socket 直发,
   * 不改动连接层的实现与 seq/重连语义。若后续连接层开放通用 `send()`,
   * 本函数应替换为对该方法的调用。
   */
  const sendFrame = (frame: Record<string, unknown>): void => {
    const socket = (session as unknown as { ws?: WebSocket | null } | null)?.ws
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(frame))
    }
    catch {
      // 半开连接:交给心跳/pong 超时走既有重连路径
    }
  }

  const sendNotificationsSub = (): void => {
    const cursor = notifications.cursor
    // 服务端收到 subNotifications 会把游标之后的历史通知以 notification.created 帧逐条
    // 直发(与直播帧同形),收尾帧是 notification.snapshot —— store 用这个窗口抑制补发弹窗
    notifications.beginReplay()
    sendFrame(cursor ? { type: 'subNotifications', cursor } : { type: 'subNotifications' })
  }

  /**
   * 宿主用户级通知订阅(引用计数;返回释放函数)。
   * 未登录时不发送(服务端要求已认证 peer);登录后由 token watcher 补发。
   */
  const hostNotifications = (): (() => void) => {
    notificationHosts += 1
    if (!notificationsSubscribed && userStore.token) {
      notificationsSubscribed = true
      sendNotificationsSub()
      void notifications.loadSnapshot()
    }
    let done = false
    return () => {
      if (done) return
      done = true
      if (--notificationHosts <= 0) {
        notificationHosts = 0
        notificationsSubscribed = false
        if (userStore.token) sendFrame({ type: 'unsubNotifications' })
      }
    }
  }

  // 用户 token 注入(登录态变化即时生效;未登录 sub 将被服务端 401 拒绝)
  watch(() => userStore.token, (t) => {
    if (session instanceof WorkshopWsSession) session.userToken = t
    if (t) {
      if (notificationHosts > 0) {
        notificationsSubscribed = true
        sendNotificationsSub()
      }
      void notifications.loadSnapshot()
    }
    else {
      // 登出:退订 + 清空本用户可见通知(防串号)
      if (notificationsSubscribed) {
        notificationsSubscribed = false
        sendFrame({ type: 'unsubNotifications' })
      }
      notifications.clear()
    }
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

  onMounted(() => {
    heartbeatUsers++
    if (heartbeat) return
    // 15s 心跳:pong 停止后 checkStale 的断线感知最坏 ~20-35s(服务强杀的半开连接
    // 无 RST,靠 pong 超时发现);ping 发送失败立即关闭走重连,不等 stale 检测
    heartbeat = setInterval(() => {
      session?.ping()
      session?.checkStale()
    }, 15_000)
  })
  onBeforeUnmount(() => {
    if (--heartbeatUsers <= 0 && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  })

  return { subscribe, unsubscribe, ensureConnected, hostNotifications, conn }
}
