/**
 * 场景/DAQ 事件广播总线 —— 从 ws 路由模块解耦出的常驻服务。
 *
 * 职责:持有 WS 在线 peer 注册表(由 workshop-ws 路由在连接/订阅时登记),
 * 提供无频道归属事件(device.created|updated|deleted、daq.reading|
 * daq.node.changed|daq.controller 等)的全员直推。device-twins 与 daq 的 REST
 * 路由改为从本模块导入广播函数 —— 避免"路由文件被当库静态导入"引发
 * nitro 打包的循环初始化(TDZ)问题。
 */
import type { AepEnvelope } from '../../../shared/workshop-protocol'
import { emitPluginEvent } from './plugins/host.mjs'

const AEP_VERSION = 1

/** 最小 peer 接口(crossws peer 的 duck typing) */
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

const g = globalThis as typeof globalThis & {
  __sceneEventPeers?: Set<WsPeer>
}

/** 在线 peer 注册表(ws 路由 sub 成功时登记,断开/退订移除) */
function peers(): Set<WsPeer> {
  return g.__sceneEventPeers ??= new Set()
}

export function registerScenePeer(peer: WsPeer): void {
  peers().add(peer)
}

export function unregisterScenePeer(peer: WsPeer): void {
  peers().delete(peer)
}

export function sceneEventPeerCount(): number {
  return peers().size
}

/** 全员直推(channelId='' 不落库;死连接静默剔除)。
 *  信封序列化一次、全 peer 复用:dag 遥测经此出口 N 节点×P 页面/秒高频扇出,
 *  per-peer 重复 stringify 是纯浪费。 */
export function broadcastSceneEvent(type: string, payload: unknown): void {
  // 插件宿主事件桥(event:<type> 钩子;宿主未装载时 no-op)——先于 peers 短路,插件不依赖在线页面
  emitPluginEvent(type, payload)
  if (peers().size === 0) return
  const e: AepEnvelope = {
    v: AEP_VERSION,
    type,
    seq: 0,
    at: new Date().toISOString(),
    channelId: '',
    payload: payload as AepEnvelope['payload'],
  }
  const frame = JSON.stringify(e)
  for (const peer of peers()) {
    try {
      peer.send(frame)
    }
    catch {
      peers().delete(peer)
    }
  }
}
