/**
 * Modbus TCP 从站 —— modbus-serial ServerTCP(与主项目 dev-plc-simulator 同构,已验证)。
 * 主项目 modbus-tcp 驱动 connectTCP 拨入,每采样周期 FC03/FC04 读寄存器。
 * 断链故障注入:disconnect 激活期间 close server(端口关闭 → 主项目连接被拒),窗后自动重启。
 */
import type { DeviceNode } from '../../shared/types'
import { createRegisterSpace, vectorOf } from './modbus-core'
import { faultWindowActive } from '../engine/faults'
import type { ProtocolHandle } from './registry'

type ServerTCPInst = {
  on: (ev: string, fn: (err?: Error) => void) => void
  close: (cb?: () => void) => void
  closeAllConnections?: () => void
}

const live = new Map<string, ServerTCPInst>()

async function listenOnce(node: DeviceNode, space: ReturnType<typeof createRegisterSpace>): Promise<ServerTCPInst> {
  const { ServerTCP } = await import('modbus-serial')
  const host = node.config.host ?? '0.0.0.0'
  const port = node.config.port ?? 16040
  const unitId = node.config.unitId ?? 1
  // unitId=0 → 255(modbus-serial 语义:接受任意 unitId 的请求);否则精确匹配
  const server = new ServerTCP(vectorOf(space), { host, port, unitID: unitId === 0 ? 255 : unitId, debug: false }) as unknown as ServerTCPInst
  await new Promise<void>((resolve, reject) => {
    server.on('initialized', () => resolve())
    server.on('error', (err) => reject(err ?? new Error('listen error')))
    setTimeout(() => reject(new Error(`Modbus TCP ${host}:${port} 初始化超时`)), 8000)
  })
  return server
}

/** 跟踪本设备的全部 client socket(断链演练:close 时必须销毁,否则主项目连接池持有半开连接挂起) */
const clientSockets = new Map<string, Set<import('node:net').Socket>>()

export async function startModbusTcp(node: DeviceNode): Promise<ProtocolHandle> {
  const space = createRegisterSpace(node)
  const server = await listenOnce(node, space)
  live.set(node.id, server)
  // 跟踪 client socket:modbus-serial 不透传 net.Server 的 connection 事件,
  // 经 _server(net.Server 实例)挂 connection 监听
  const sockets = new Set<import('node:net').Socket>()
  clientSockets.set(node.id, sockets)
  const netServer = (server as unknown as { _server?: import('node:net').Server })._server
  netServer?.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sockets.delete(sock))
  })
  const killSockets = (): void => {
    for (const s of sockets) {
      try { s.destroy() } catch { /* 已断 */ }
    }
    sockets.clear()
  }

  // 断链注入:故障窗内关闭端口,窗结束后重启
  const guard = setInterval(async () => {
    if (faultWindowActive(node)) {
      const cur = live.get(node.id)
      if (cur) {
        try {
          cur.close(() => {})
          killSockets()
        }
        catch { /* 已关 */ }
        live.delete(node.id)
      }
    }
    else if (!live.has(node.id)) {
      try {
        const again = await listenOnce(node, space)
        live.set(node.id, again)
      }
      catch { /* 端口仍被占,下一拍再试 */ }
    }
  }, 1000)

  return {
    close: async () => {
      clearInterval(guard)
      const cur = live.get(node.id)
      if (cur) {
        // 等 close 回调(端口真正释放)再返回,否则预设切换立刻重绑同端口会 EADDRINUSE
        await new Promise<void>((resolve) => {
          let done = false
          const finish = () => { if (!done) { done = true; resolve() } }
          try {
            ;(cur as { closeAllConnections?: () => void }).closeAllConnections?.()
            cur.close(() => finish())
            setTimeout(finish, 2500)
          } catch { finish() }
        })
        live.delete(node.id)
      }
      killSockets()
      clientSockets.delete(node.id)
    },
    summary: () => ({
      protocol: 'modbus-tcp', host: node.config.host ?? '0.0.0.0', port: node.config.port ?? 16040,
      unitId: node.config.unitId ?? 1, signals: node.signals.length,
      ...(live.has(node.id) ? {} : { disconnected: true }),
    }),
  }
}
