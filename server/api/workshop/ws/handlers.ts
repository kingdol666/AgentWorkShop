/**
 * 场景布局广播 / 事件记录器预热 / defineWebSocketHandler 入口
 * (由 server/api/workshop/ws.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentChannelManager } from '../../../services/workshop/runtime/manager'
import { AEP_VERSION, peerIdentities, peerUsers } from './shared'
import { attachScenePeer, ensureHubBound, resolveChannelIdFromUrl, resolveQueryParam, sendControl } from './hub'
import { bindUserPeer, unbindUserPeer } from '../../../services/workshop/runtime/user-notification-hub'
import { defineWebSocketHandler } from 'h3'
import { ensureStream } from './streams'
import { getWorkshopManager } from '../../../plugins/workshop'
import { handleNotificationUplink } from './notification-uplink'
import { publish } from './publish'
import { resolveWsTicketUser } from '../../../services/auth/browser-session'
import { resolveUserByToken } from '../../../services/user.service'
import { subscribePeer, unsubscribePeer } from './peer-sub'
import { unregisterScenePeer } from '../../../services/workshop/scene-events'

export function publishSceneLayoutEvent(
  manager: AgentChannelManager,
  channelId: string,
  type: 'scene.layout.saved' | 'scene.layout.removed',
  payload: unknown,
): void {
  const stream = ensureStream(manager, channelId)
  if (!stream) return
  publish(manager, stream, type, payload)
}

/** 插件启动钩子:为全部存量 channel 建立常驻录制流(新 channel 由 ensureStream 即时建) */
export async function ensureAllEventRecorders(manager: AgentChannelManager): Promise<void> {
  for (const ch of await manager.listChannels()) {
    ensureStream(manager, ch.id)
  }
}

export default defineWebSocketHandler({
  open(peer) {
    let manager: AgentChannelManager
    try {
      manager = getWorkshopManager()
    }
    catch (error) {
      sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'WORKSHOP_NOT_READY', message: error instanceof Error ? error.message : 'workshop 未初始化' } })
      peer.close(1011, 'workshop not ready')
      return
    }
    ensureHubBound(manager)
    // 旧 query-token 仅给外部兼容客户端；浏览器使用首帧 auth(ticket)。
    const qpToken = resolveQueryParam(peer, 'token')
    const qpUser = qpToken ? resolveUserByToken(qpToken) : null
    if (qpUser) {
      peerIdentities.set(peer, { userId: qpUser.id, role: qpUser.role })
      peerUsers.set(peer, { id: qpUser.id, name: qpUser.name, role: qpUser.role, createdAt: qpUser.createdAt })
      attachScenePeer(peer, qpUser)
      // v17:认证即绑定 peer→userId(用户级通知的 recipient 隔离基础;
      // 仅凭 ?token= 连接的客户端无需再 sub 一个 channel 也能收定向通知)
      bindUserPeer(peer, qpUser.id)
    }
    // 兼容旧路径:?channelId= 连接即订阅(无 lastSeq → 快照对齐)
    const channelId = resolveChannelIdFromUrl(peer)
    if (!channelId) return // 纯上行 sub 模式(多 channel 复用一条连接)
    subscribePeer(manager, peer, channelId, undefined, resolveQueryParam(peer, 'token'))
  },

  message(peer, message) {
    const raw = message.text()
    if (!raw) return
    let parsed: { type?: unknown, channelId?: unknown, lastSeq?: unknown, token?: unknown, ticket?: unknown }
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'BAD_MESSAGE', message: '上行消息必须是 JSON' } })
      return
    }
    if (parsed.type === 'auth' && typeof parsed.ticket === 'string') {
      const user = resolveWsTicketUser(parsed.ticket)
      if (!user) {
        sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'USER_UNAUTHORIZED', message: 'WS ticket 无效、过期或已使用' } })
        peer.close(4401, 'invalid ws ticket')
        return
      }
      peerIdentities.set(peer, { userId: user.id, role: user.role })
      peerUsers.set(peer, { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt })
      attachScenePeer(peer, user)
      bindUserPeer(peer, user.id)
      sendControl(peer, { v: AEP_VERSION, type: 'auth.ok', seq: 0, at: new Date().toISOString(), channelId: '', payload: { userId: user.id } })
      return
    }
    if (parsed.type === 'ping') {
      // HMR 自愈入口:manager 更替(nitro reload)后首个 ping 触发订阅重建,pong 正常应答
      try {
        ensureHubBound(getWorkshopManager())
      }
      catch { /* manager 未就绪:pong 照常,下次 ping 再自愈 */ }
      sendControl(peer, { v: AEP_VERSION, type: 'pong', seq: 0, at: new Date().toISOString(), channelId: '', payload: { t: Date.now() } })
      return
    }
    if (parsed.type === 'sub' && typeof parsed.channelId === 'string') {
      let manager: AgentChannelManager
      try {
        manager = getWorkshopManager()
      }
      catch (error) {
        sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: parsed.channelId, payload: { code: 'WORKSHOP_NOT_READY', message: error instanceof Error ? error.message : 'workshop 未初始化' } })
        return
      }
      ensureHubBound(manager)
      subscribePeer(manager, peer, parsed.channelId, typeof parsed.lastSeq === 'number' ? parsed.lastSeq : undefined, typeof parsed.token === 'string' ? parsed.token : undefined)
      return
    }
    if (parsed.type === 'unsub' && typeof parsed.channelId === 'string') {
      unsubscribePeer(peer, parsed.channelId)
      return
    }
    // ===== v17 用户级通知上行(recipient 由服务端 peer 绑定决定,客户端不可指定 userId)=====
    if (parsed.type === 'subNotifications' || parsed.type === 'unsubNotifications' || parsed.type === 'notification.read') {
      let manager: AgentChannelManager
      try {
        manager = getWorkshopManager()
      }
      catch (error) {
        sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'WORKSHOP_NOT_READY', message: error instanceof Error ? error.message : 'workshop 未初始化' } })
        return
      }
      handleNotificationUplink(manager, peer, parsed)
      return
    }
    sendControl(peer, { v: AEP_VERSION, type: 'error', seq: 0, at: new Date().toISOString(), channelId: '', payload: { code: 'UNSUPPORTED_UPLINK', message: `不支持的上行消息: ${String(parsed.type)}` } })
  },

  close(peer) {
    unsubscribePeer(peer)
    unregisterScenePeer(peer)
    unbindUserPeer(peer)
  },

  error(peer, error) {
    console.error('[workshop-ws] connection error:', error)
    unsubscribePeer(peer)
    unregisterScenePeer(peer)
    unbindUserPeer(peer)
  },
})
