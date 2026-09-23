/**
 * 协议头注释 / 常量 / WsPeer 与 ChannelStream 类型 / hub 单例
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AepEnvelope } from '../../../../shared/workshop-protocol'
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import { createLogger } from '../../../services/workshop/logger'
import { retentionSettings } from '../../../services/workshop/settings'

/**
 * WebSocket Hub(AEP v1)— 前端观察入口,事件驱动直推。
 * 路径 /api/workshop/ws?channelId=xxx(缺省 channelId 可连后上行 sub 订阅多 channel)。
 *
 * 协议:Agent Event Protocol(权威定义 #shared/workshop-protocol)
 *  - 下行信封:{ v, type, seq, at, channelId, agentId?, taskId?, payload }
 *    type/payload 与旧 hub 帧兼容(agent.status/task.status/task.progress/
 *    a2a.artifact/a2a.message/channel.snapshot/error/pong),信封字段为增量。
 *  - 上行:{type:'ping'} → pong;{type:'sub',channelId,lastSeq?} 断线续传重放;
 *    {type:'unsub',channelId} 退订。
 *
 * 推送机制:直订 manager ChannelBus(subscribeChannelEvents/onTaskEvent/
 * onAgentStatus/subscribeChannelMessages/subscribeMemoryEvents)——无轮询;
 * per-channel 单调 seq + 环形缓冲(5000),sub 带 lastSeq 时重放缺失段,
 * 缓冲窗外/seq 倒退(服务重启)→ 下发 channel.snapshot 全量对齐。
 */

export const log = createLogger('workshop.ws')

export const AEP_VERSION = 1
export const RING_CAP = 5000
/** ring 字节上限(含大 artifact 载荷的长会话内存有界;超出丢最旧) */
export const RING_BYTES_CAP = 4 * 1024 * 1024
/** 落库聚合缓冲上限(滞留超限即刷,防库故障时缓冲无限涨) */
export const DB_BUFFER_CAP = 2000
/** 事件保留期(天;retention.events_days,env AW_EVENTS_RETENTION_D 可覆盖) */
export const EVENTS_RETENTION_DAYS = (): number => retentionSettings().events_days
/** 单 peer 发送预算(字节/秒):超限视为慢消费者断开(1013),客户端重连快照对齐。
 *  实测常态 ~85 帧/秒 ≈ 0.1MB/s,8MB/s 保留 ~80× 余量,同时封住病态积压
 *  (原 32MB/s 过宽:慢客户端断开前每秒可积压 32MB 序列化帧) */
export const PEER_SEND_BUDGET_BYTES = 8 * 1024 * 1024

/** 最小 peer 接口(h3 2.x 未 re-export crossws 类型,duck typing;与 game/ws.ts 同风格) */
export interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** channel 级事件流:seq 单调递增 + 环形缓冲 + 订阅清理 + 优雅保留窗口 */
export interface ChannelStream {
  channelId: string
  seq: number
  /** 环形缓冲(条数 RING_CAP + 字节 RING_BYTES_CAP 双封顶;重放/续传窗口) */
  ring: Array<{ e: AepEnvelope, bytes: number }>
  ringBytes: number
  peers: Set<WsPeer>
  unsubs: Array<() => void>
  /**
   * HITL 待办事件订阅(hitl-registry 模块级总线 → 频道流)。
   * 单独存放、不进 unsubs:rebindStreamIfStale 会整体清空 unsubs 重订总线,
   * 而 registry 订阅与总线生命周期无关,只在建流/回收时挂接一次。
   */
  hitlUnsub: (() => void) | null
  /** 当前已订阅的 channel 总线对象(总线生命期短于 stream:空闲卸载会重建 bus → 需重订) */
  busRef: object | null
  /**
   * 落库聚合缓冲(全部事件类型,保持发布序):逐帧同步 insert 会阻塞事件循环;
   * 400ms 批量事务刷盘(单次 fsync 落整批)。实时广播不经缓冲(逐帧直推),
   * 只有持久化走聚合路径 —— 与旧 delta-only 缓冲同语义,推广到全部帧型。
   */
  dbBuffer: AepEnvelope[]
  dbFlushTimer: NodeJS.Timeout | null
}

/**
 * HMR 存活:nitro dev 热重载重建模块图(模块级 Map 随之蒸发),但 crossws peer 连接仍存活——
 * hub 状态挂 globalThis 跨模块实例存活;manager 更替(plugin 重新 init)时由 ensureHubBound
 * 自愈式重建订阅(peers 平移),存活连接在下一帧(最长一个 ping 周期)自动恢复事件流。
 */
export interface HubState {
  streams: Map<string, ChannelStream>
  peerChannels: Map<WsPeer, Set<string>>
  boundManager: AgentChannelManager | null
}
export const hubGlobal = globalThis as typeof globalThis & { __workshopWsHub?: HubState }
export const hub: HubState = hubGlobal.__workshopWsHub
  ?? (hubGlobal.__workshopWsHub = { streams: new Map(), peerChannels: new Map(), boundManager: null })
export const streams = hub.streams
export const peerChannels = hub.peerChannels

/**
 * hub ↔ manager 绑定校验(消息入口调用):manager 更替(HMR 后 plugin 重新 init)时,
 * 退订旧 manager 总线上的全部 stream 并按新 manager 重建订阅;已注册 peers 平移,
 * ring/seq 延续,客户端无需重连即恢复事件流。
 */
