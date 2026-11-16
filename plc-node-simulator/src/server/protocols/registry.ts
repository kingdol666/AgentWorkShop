/**
 * 协议注册器 —— 按设备 protocol 分发 start/stop/summary;句柄统一生命周期。
 */
import type { DeviceNode } from '../../shared/types'

export interface ProtocolHandle {
  close: () => Promise<void>
  summary: () => Record<string, unknown>
}

const handles = new Map<string, ProtocolHandle>()

export function setHandle(nodeId: string, h: ProtocolHandle): void {
  handles.set(nodeId, h)
}

export function summaryOf(nodeId: string): Record<string, unknown> | undefined {
  return handles.get(nodeId)?.summary()
}

export function runningProtocolIds(): string[] {
  return [...handles.keys()]
}

async function startByKind(node: DeviceNode): Promise<ProtocolHandle> {
  switch (node.protocol) {
    case 'modbus-tcp': {
      const { startModbusTcp } = await import('./modbus-tcp')
      return startModbusTcp(node)
    }
    case 'modbus-rtu': {
      const { startModbusRtu } = await import('./modbus-rtu')
      return startModbusRtu(node)
    }
    case 'opcua': {
      const { startOpcUa } = await import('./opcua')
      return startOpcUa(node)
    }
    case 'mqtt': {
      const { startMqtt } = await import('./mqtt')
      return startMqtt(node)
    }
    case 'http': {
      // HTTP 端点无独立监听,挂在主 h3 服务器;注册即视为运行
      const { startHttpEndpoint } = await import('./http-endpoint')
      return startHttpEndpoint(node)
    }
  }
}

/** 启动(或按新配置重启)设备协议端点;失败抛错,由调用方记录 lastError */
export async function startProtocol(node: DeviceNode): Promise<void> {
  const existing = handles.get(node.id)
  if (existing) {
    await existing.close()
    handles.delete(node.id)
  }
  const h = await startByKind(node)
  setHandle(node.id, h)
}

export async function stopProtocol(nodeId: string): Promise<void> {
  const h = handles.get(nodeId)
  if (h) {
    await h.close()
    handles.delete(nodeId)
  }
}

export async function stopAllProtocols(): Promise<void> {
  for (const [id, h] of handles) {
    try {
      await h.close()
    }
    catch (err) {
      console.error(`[protocols] 关闭 ${id} 失败:`, (err as Error).message)
    }
  }
  handles.clear()
}
