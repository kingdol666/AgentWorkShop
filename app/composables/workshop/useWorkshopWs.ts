/**
 * Workshop WS 会话 hook:绑定 WorkshopWsSession ↔ stores。
 * ingest 派发:events.ingest + entities.applyEvent + connection 游标;
 * 订阅引用计数(多组件安全挂载/卸载),15s 心跳。
 *
 * ===== 帧分流的两层语义(位置是承载语义的,改动前请读懂)=====
 *  ① **频道流帧**(有 channelId、seq>0,含 chat.*):先过 `channelSeqGuard` 的单调去重,
 *     重复/乱序旧帧在守卫处丢弃 —— 下游(群聊 store)不必再自证幂等。
 *  ② **用户级帧**(notification.*,seq 恒为 0、channelId 可能为空):**不能**进频道 seq 守卫,
 *     否则会把游标写成 0 导致后续重放判重失效。与 hitl.* 同级在守卫外消费,
 *     幂等由 store 的 eventId 集合负责。
 * 这两层的顺序与归属是**有意的**,不是可以随意重排/合并的 if-chain ——
 * 因此这里把它们抽成两个具名函数(而非合并成一个"按类型查表"的分发器:
 * 查表会把守卫条件摊进每个 handler,语义反而更难核对)。
 *
 * ===== 单例与生命周期 =====
 *  - 会话(WorkshopWsSession)挂 `globalThis`,多组件共享一条连接;
 *  - 心跳句柄与两个引用计数同样挂 `globalThis`:模块级变量在 HMR 重新求值时会归零,
 *    而旧的 setInterval / 已建立的订阅仍然存活 → 每次热更新泄漏一个无法回收的定时器、
 *    并使计数与实际宿主数脱节。挂 globalThis 后 HMR 与组件生命周期解耦。
 *  - **不缓存 store 句柄**:会话可能比创建它的组件(乃至那次 pinia 实例)存活更久,
 *    闭包持有旧句柄会让实时更新静默停摆(不报错、无日志)。每帧按需 `useXStore()`。
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

/** HMR 存活句柄(见文件头"单例与生命周期") */
interface WsHookGlobal {
  __workshopWs?: WorkshopWsSession
  __workshopWsHeartbeat?: ReturnType<typeof setInterval> | null
  __workshopWsHeartbeatUsers?: number
  __workshopWsNotifHosts?: number
  __workshopWsNotifSubscribed?: boolean
}
const hookGlobal = globalThis as typeof globalThis & WsHookGlobal
hookGlobal.__workshopWsHeartbeat ??= null
hookGlobal.__workshopWsHeartbeatUsers ??= 0
hookGlobal.__workshopWsNotifHosts ??= 0
hookGlobal.__workshopWsNotifSubscribed ??= false

/**
 * 频道流帧的单调 seq 守卫。
 * @returns true = 该帧应被**丢弃**(重复/倒退)
 */
function channelSeqGuard(e: AepEnvelope, appliedSeq: Map<string, number>): boolean {
  if (!e.channelId || typeof e.seq !== 'number' || e.seq <= 0 || e.type === 'channel.snapshot') return false
  const last = appliedSeq.get(e.channelId) ?? 0
  if (e.seq <= last) return true
  appliedSeq.set(e.channelId, e.seq)
  return false
}

export function useWorkshopWs() {
  const conn = useWsConnectionStore()
  const userStore = useUserStore()
  const townBus = useTownBus()

  /** 模块级单例:多组件共享一条连接 */
  let session: WorkshopWsSession | null = hookGlobal.__workshopWs ?? null
  // per-channel 已应用 seq(断线续传重放/缓冲重叠的同帧在此单点丢弃;
  // entities/场景计数等下游消费方不再各自防重)
  const appliedSeq = new Map<string, number>()

  if (!session) {
    const s = new WorkshopWsSession(
      (e: AepEnvelope) => {
        // 每帧按需取 store(见文件头:不缓存句柄,避免会话比 pinia 存活更久时静默停摆)
        const events = useEventsStore()
        const entities = useEntitiesStore()
        const chat = useChatStore()
        const hitl = useHitlStore()
        const notifications = useNotificationsStore()

        // ① 频道流帧:seq 守卫(重复帧在此直接丢弃)
        if (channelSeqGuard(e, appliedSeq)) return
        if (e.channelId && typeof e.seq === 'number' && e.seq > 0) {
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
          // 群聊侧基线(成员/最近消息/设置/能力)与快照同帧到达,投影在服务端完成(§13.1)
          const payload = e.payload as { chat?: AepChatSnapshot | null, permissions?: ChatPermissions | null }
          chat.applySnapshot(e.channelId, payload.chat ?? null, payload.permissions)
          // 持久化历史(server 驱动):快照后从 DB 拉历史填充时间线
          void events.loadHistory(e.channelId)
        }
        else {
          events.ingest(e)
          entities.applyEvent(e)
          // 群聊帧走频道流(seq/snapshot/重放):重复帧已在上方守卫丢弃(store 内仍按 id 去重兜底)
          if (typeof e.type === 'string' && e.type.startsWith('chat.')) chat.applyEnvelope(e)
        }

        // ② 用户级 / 全局帧:seq 恒为 0 或 channelId 为空,**不进**频道游标
        // HITL 全局待办(频道帧 + channelId='' 全员直推各到一次,store 内 kind+id 幂等)
        if (e.type === 'hitl.request' || e.type === 'hitl.resolved') hitl.applyEnvelope(e)
        if (e.type === 'notification.created' || e.type === 'notification.read') notifications.applyEnvelope(e)
        if (e.type === 'notification.snapshot') {
          // 补发收尾帧:关闭"补发中"窗口(窗口内入库但不弹窗)并把游标推到服务端已重放的位置,
          // 否则积压超过一页的重放会让客户端游标落后(N 条通知要等下次重连才补上)
          notifications.applyReplayCursor((e.payload as { nextCursor?: { createdAt: string, id: string } | null } | null)?.nextCursor ?? null)
          notifications.endReplay()
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
        // 重连成功 → 通知按游标补拉(REST 是事实源;与直播帧按 eventId 合并,幂等)
        if (state === 'open') void useNotificationsStore().backfill()
      },
      // 断线且有订阅游标 → 重连后待对齐(状态条"同步中"提示)
      () => { conn.pendingReplay = true },
      // 重连后首帧到达 → 记录最后数据时间(诚实在线状态);
      // pendingReplay 的清除由 ingest 的对齐语义决定(快照或非重复帧,而非任意首帧)
      () => {
        conn.lastDataAt = Date.now()
        const notifications = useNotificationsStore()
        // 首帧到达说明服务端已处理完本连接的 sub(peer 已按 token 绑定 userId)→ 此时
        // 发通知订阅帧才有意义(早于 sub 发送会被服务端以 USER_UNAUTHORIZED 拒绝)
        if (hookGlobal.__workshopWsNotifSubscribed) sendNotificationsSub()
        // 数据帧到达 = 断线期间的缺口已由重放/快照对齐 → 通知同样补齐
        void notifications.backfill()
      },
    )
    session = s
    hookGlobal.__workshopWs = session
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
    const notifications = useNotificationsStore()
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
    const notifications = useNotificationsStore()
    hookGlobal.__workshopWsNotifHosts = (hookGlobal.__workshopWsNotifHosts ?? 0) + 1
    if (!hookGlobal.__workshopWsNotifSubscribed && userStore.token) {
      hookGlobal.__workshopWsNotifSubscribed = true
      sendNotificationsSub()
      void notifications.loadSnapshot()
    }
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (hookGlobal.__workshopWsNotifHosts ?? 1) - 1
      hookGlobal.__workshopWsNotifHosts = left > 0 ? left : 0
      if (left <= 0) {
        hookGlobal.__workshopWsNotifSubscribed = false
        if (userStore.token) sendFrame({ type: 'unsubNotifications' })
      }
    }
  }

  // 用户 token 注入(登录态变化即时生效;未登录 sub 将被服务端 401 拒绝)
  watch(() => userStore.token, (t) => {
    const notifications = useNotificationsStore()
    if (session instanceof WorkshopWsSession) session.userToken = t
    if (t) {
      if ((hookGlobal.__workshopWsNotifHosts ?? 0) > 0) {
        hookGlobal.__workshopWsNotifSubscribed = true
        sendNotificationsSub()
      }
      void notifications.loadSnapshot()
    }
    else {
      // 登出:退订 + 清空本用户可见通知(防串号)
      if (hookGlobal.__workshopWsNotifSubscribed) {
        hookGlobal.__workshopWsNotifSubscribed = false
        sendFrame({ type: 'unsubNotifications' })
      }
      notifications.clear()
    }
  }, { immediate: true })

  const subscribe = (channelId: string): void => {
    // 游标未建立(lastSeq=0/无 ring)时不携带 lastSeq:服务端对其下发
    // channel.snapshot 全量(agents/tasks/queue/messages 实体基线),否则走纯事件
    // 重放路径,空闲成员/历史任务永远不会出现在前端(实体基线缺失)。
    const lastSeq = useEventsStore().lastSeq(channelId)
    session?.subscribe(channelId, lastSeq > 0 ? lastSeq : undefined)
  }
  const unsubscribe = (channelId: string): void => {
    if (!session) return
    session.unsubscribe(channelId)
    // 引用计数归零才清本地事件缓冲:仍有页面(如总览页)持有订阅时,
    // 控制台卸载不得把对方的时间线/游标抹掉(清了会导致已订阅会话收不到快照重发,实时流静默死亡)
    if (session.refCount(channelId) === 0) useEventsStore().clear(channelId)
  }
  /** 建连但不订阅 channel:纯场景事件消费方(daq 实时帧)用。
   *  服务端在连接层注册 scene peer,连上即收 daq.reading 等无频道广播。 */
  const ensureConnected = (): void => {
    session?.ensureConnected()
  }

  onMounted(() => {
    hookGlobal.__workshopWsHeartbeatUsers = (hookGlobal.__workshopWsHeartbeatUsers ?? 0) + 1
    if (hookGlobal.__workshopWsHeartbeat) return
    // 15s 心跳:pong 停止后 checkStale 的断线感知最坏 ~20-35s(服务强杀的半开连接
    // 无 RST,靠 pong 超时发现);ping 发送失败立即关闭走重连,不等 stale 检测
    hookGlobal.__workshopWsHeartbeat = setInterval(() => {
      session?.ping()
      session?.checkStale()
    }, 15_000)
  })
  onBeforeUnmount(() => {
    const left = (hookGlobal.__workshopWsHeartbeatUsers ?? 1) - 1
    hookGlobal.__workshopWsHeartbeatUsers = left > 0 ? left : 0
    if (left <= 0 && hookGlobal.__workshopWsHeartbeat) {
      clearInterval(hookGlobal.__workshopWsHeartbeat)
      hookGlobal.__workshopWsHeartbeat = null
    }
  })

  return { subscribe, unsubscribe, ensureConnected, hostNotifications, conn }
}
