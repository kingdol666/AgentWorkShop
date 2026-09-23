/**
 * peer 订阅/退订与聊天快照投影
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import type { WsPeer } from './shared'
import { AEP_VERSION, peerChannels, streams } from './shared'
import { attachScenePeer, sendControl, sendFrame } from './hub'
import { bindUserPeer } from '../../../services/workshop/runtime/user-notification-hub'
import { buildSnapshot } from './publish'
import { ensureStream } from './streams'
import { resolveUserByToken } from '../../../services/user.service'
// 非管理者快照白名单投影(拆段时生成器漏了这一条:标识符只出现在三元表达式的对象展开里)
import { projectManagementSnapshotForMember } from '../../../services/workshop/runtime/chat-projection'

export function subscribePeer(manager: AgentChannelManager, peer: WsPeer, channelId: string, lastSeq?: number, userToken?: string): void { // v17:群成员鉴权(requireChannelMember);管理面字段按 canManage 投影(§13.1)
  if (!userToken) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'USER_UNAUTHORIZED', message: 'WS 订阅需要用户 token(sub 帧携带 token 字段或连接 ?token= 查询参数)' } })
    return
  }
  const user = resolveUserByToken(userToken)
  if (!user) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'USER_UNAUTHORIZED', message: '用户 token 无效' } })
    return
  }
  // v17:token 认证成功后绑定 peer→userId(用户级通知 hub 的 recipient 隔离基础)
  bindUserPeer(peer, user.id)
  let canManage: boolean
  try {
    // 成员守卫:owner 或 active 群成员可订阅(群聊读取/发言/WS/HITL 可见性同口径);
    // 管理能力另行判定,仅用于快照投影深度。
    manager.requireChannelMember(channelId, user)
    canManage = manager.channelPermissionsOf(channelId, user).canManage
  }
  catch (err) {
    const e = err as { code?: string, message?: string }
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: e.code ?? 'FORBIDDEN', message: e.message ?? 'channel 不可见' } })
    return
  }
  const stream = ensureStream(manager, channelId)
  if (!stream) {
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId, payload: { code: 'NOT_FOUND', message: `channel 不存在: ${channelId}` } })
    return
  }
  stream.peers.add(peer)
  // 共享场景事件注册表:daq 等无频道归属广播由此直达该 peer(sub 鉴权成功后补挂)
  attachScenePeer(peer, user)
  let channels = peerChannels.get(peer)
  if (!channels) {
    channels = new Set()
    peerChannels.set(peer, channels)
  }
  channels.add(channelId)
  // 对齐策略:无游标(lastSeq 缺省/为 0)/ seq 倒退(服务重启)/ 缓冲窗外 →
  // channel.snapshot 全量(agents/tasks/queue/messages 基线,客户端事件即实体);
  // 否则重放缺失段。lastSeq=0 视为"新订阅者"(游标未建立),同样走快照路径——
  // 仅重放事件会让客户端丢失实体基线(空闲成员/历史任务永远不出现)。
  const cursor: number | undefined = (lastSeq !== undefined && lastSeq > 0) ? lastSeq : undefined
  const oldest = stream.ring[0]?.e.seq ?? stream.seq + 1
  if (cursor === undefined || cursor >= stream.seq || cursor + 1 < oldest) {
    const snapshot = buildSnapshot(manager, channelId)
    if (snapshot) {
      // v17 §13.1:非管理者只拿白名单投影(剔除 config/token/workspace/内部 mailbox/task payload);
      // 同时附带群聊侧基线(成员/群聊历史/能力/通知游标),成员无需额外 REST 即可渲染群聊。
      const payload = canManage
        ? { ...snapshot, chat: safeChatSnapshot(manager, channelId, user), permissions: safePermissions(manager, channelId, user) }
        : { ...projectManagementSnapshotForMember(snapshot), chat: safeChatSnapshot(manager, channelId, user), permissions: safePermissions(manager, channelId, user) }
      sendControl(peer, {
        v: AEP_VERSION,
        type: 'channel.snapshot',
        seq: stream.seq,
        at: new Date().toISOString(),
        channelId,
        payload,
      })
    }
  }
  else {
    // 已建立游标且缺口在缓冲窗内 → 重放缺失段(快照无需重发)
    for (const { e } of stream.ring) {
      if (e.seq > cursor) sendFrame(stream, peer, JSON.stringify(e))
    }
  }
}

/** 群聊快照(容错:群聊层不可用时返回 null,不阻断管理面快照) */
export function safeChatSnapshot(manager: AgentChannelManager, channelId: string, user: { id: string }): unknown {
  try {
    return manager.chatSnapshotOf(channelId, user)
  }
  catch {
    return null
  }
}

/** 能力视图(容错同上) */
export function safePermissions(manager: AgentChannelManager, channelId: string, user: { id: string, role?: string }): unknown {
  try {
    return manager.channelPermissionsOf(channelId, user)
  }
  catch {
    return null
  }
}

/** 退订 peer(仅移除 peer;流与订阅常驻——全时录制,无订阅者事件仍落库) */
export function unsubscribePeer(peer: WsPeer, channelId?: string): void {
  const channels = peerChannels.get(peer)
  if (!channels) return
  const targets = channelId ? [channelId] : [...channels]
  for (const id of targets) {
    channels.delete(id)
    streams.get(id)?.peers.delete(peer)
  }
  if (channels.size === 0) peerChannels.delete(peer)
}

/**
 * 场景事件广播(设备孪生 REST 变更 → 全部已连 peer)。
 * 设备实例属 workspace 而非 channel,信封 channelId='' 不进 channel 流/不落事件库;
 * 客户端经 townBus 旁路消费(scene.syncDevices 即时收敛),轮询兜底不变。
 */
export { broadcastSceneEvent } from '../../../services/workshop/scene-events'

/**
 * 频道领地布局事件(scene.layout.saved/removed):经该频道频道流广播(仅订阅该频道的
 * peer 收到;小镇页订阅全部挂载频道 → 实时同步布局)。走既有 publish 计入 seq/环形缓冲。
 */
