/**
 * Modbus RTU-over-TCP 从站 —— 手写帧处理(抄主项目已验证的 _rtu-mini-slave.mjs)。
 *
 * 线缆格式(关键约定,已核实):
 *   - mbap 模式(默认,与 AgentWorkShop connectTcpRTUBuffered 互通):
 *     modbus-serial 客户端线上收发即 MBAP+PDU(无 CRC)——客户端发请求时剥 CRC 加 MBAP
 *     (tcprtubufferedport.js:259),收响应时自行补 CRC(:188)。响应必须原样回显事务 id。
 *   - raw-rtu 模式(真实串口网关语义):slaveAddr + PDU + CRC16(LE),供其他主站客户端。
 */
import net from 'node:net'
import type { DeviceNode } from '../../shared/types'
import { createRegisterSpace } from './modbus-core'
import { crc16 } from '../engine/registers'
import { faultWindowActive } from '../engine/faults'
import type { ProtocolHandle } from './registry'

interface Pending {
  txnId?: number
  unitId: number
  fc: number
  start: number
  count: number
  writeValues?: number[]
}

/** 解析一帧请求(MBAP 或 RTU 裸帧) */
function parseFrame(mode: string, buf: Buffer): { frame: Pending, consumed: number } | null {
  if (mode === 'raw-rtu') {
    // slaveAddr(1) + fc(1) + data + crc(2);读请求最小 8 字节
    if (buf.length < 4) return null
    const fc = buf[1]
    const need = (fc === 0x03 || fc === 0x04 || fc === 0x06) ? 8 : fc === 0x10 ? 9 + (buf[6] ?? 0) * 2 : 4
    if (buf.length < need) return null
    const payload = buf.subarray(0, need - 2)
    const crc = buf.readUInt16LE(need - 2)
    if (crc16(payload) !== crc) return { frame: { unitId: buf[0], fc: 0x00, start: 0, count: 0 }, consumed: need }
    return { frame: parsePdu(buf[0], buf[1], buf.subarray(2, need - 2)), consumed: need }
  }
  // mbap: 事务(2) + 协议(2) + 长度(2) + unit(1) + PDU
  if (buf.length < 7) return null
  const len = buf.readUInt16BE(4)
  const total = 6 + len
  if (buf.length < total) return null
  const txnId = buf.readUInt16BE(0)
  const unitId = buf[6]
  const fc = buf[7]
  const f = parsePdu(unitId, fc, buf.subarray(8, total))
  f.txnId = txnId
  return { frame: f, consumed: total }
}

function parsePdu(unitId: number, fc: number, pdu: Buffer): Pending {
  if (fc === 0x03 || fc === 0x04) {
    return { unitId, fc, start: (pdu[0] << 8) | pdu[1], count: (pdu[2] << 8) | pdu[3] }
  }
  if (fc === 0x06) {
    return { unitId, fc, start: (pdu[0] << 8) | pdu[1], count: 1, writeValues: [(pdu[2] << 8) | pdu[3]] }
  }
  if (fc === 0x10) {
    const start = (pdu[0] << 8) | pdu[1]
    const count = (pdu[2] << 8) | pdu[3]
    const values: number[] = []
    // FC16 PDU: start(2)+count(2)+byteCount(1)+data —— data 从 pdu[5] 起;
    // 曾错用 pdu[6](把 byteCount 当数据高位字的高字节)→ RTU 写恒写入错值/0
    // (2026-09-21 协议级读写实测暴露:TCP 走 modbus-serial ServerTCP 不经此路径,故流水线未覆盖)
    for (let i = 0; i < count; i++) values.push((pdu[5 + i * 2] << 8) | pdu[6 + i * 2])
    return { unitId, fc, start, count, writeValues: values }
  }
  return { unitId, fc, start: 0, count: 0 }
}

/** 响应帧体 = [unitId, fc, data...](与 mini-slave 一致;MBAP 模式 length 含 unitId 字节) */
function buildResponse(frame: Pending, space: ReturnType<typeof createRegisterSpace>, unitId: number): Buffer | null {
  const { fc, start, count } = frame
  if (fc === 0x03 || fc === 0x04) {
    const area = fc === 0x03 ? 'holding' : 'input'
    const words = space.readWords(area, start, count)
    const body = Buffer.alloc(3 + count * 2)
    body[0] = unitId
    body[1] = fc
    body[2] = count * 2
    for (let i = 0; i < count; i++) body.writeUInt16BE(words[i] ?? 0, 3 + i * 2)
    return body
  }
  if (fc === 0x06 && frame.writeValues) {
    space.writeWords('holding', start, frame.writeValues)
    const body = Buffer.alloc(6)
    body[0] = unitId
    body[1] = fc
    body.writeUInt16BE(start, 2)
    body.writeUInt16BE(frame.writeValues[0] ?? 0, 4)
    return body
  }
  if (fc === 0x10 && frame.writeValues) {
    space.writeWords('holding', start, frame.writeValues)
    const body = Buffer.alloc(6)
    body[0] = unitId
    body[1] = fc
    body.writeUInt16BE(start, 2)
    body.writeUInt16BE(count, 4)
    return body
  }
  return null // 非法功能码:弃帧不断链(与 mini-slave 同策略)
}

export async function startModbusRtu(node: DeviceNode): Promise<ProtocolHandle> {
  const space = createRegisterSpace(node)
  const host = node.config.host ?? '0.0.0.0'
  const port = node.config.port ?? 15041
  const mode = (node.config as Record<string, unknown>).rtuMode === 'raw-rtu' ? 'raw-rtu' : 'mbap'
  const unitId = node.config.unitId ?? 1

  const listenOnce = (): Promise<net.Server> => new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0)
      sock.on('error', (err) => console.error(`[modbus-rtu ${node.name}] socket error:`, (err as Error).message))
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d])
        while (buf.length >= 4) {
          const parsed = parseFrame(mode, buf)
          if (!parsed) break
          const { frame, consumed } = parsed
          buf = buf.subarray(consumed)
          if (frame.fc === 0x00) continue
          if (unitId !== 0 && frame.unitId !== unitId) continue
          const resp = buildResponse(frame, space, unitId === 0 ? frame.unitId : unitId)
          if (!resp) continue
          if (mode === 'raw-rtu') {
            const out = Buffer.alloc(resp.length + 2)
            resp.copy(out, 0)
            out.writeUInt16LE(crc16(resp), resp.length)
            sock.write(out)
          }
          else {
            const head = Buffer.alloc(6)
            head.writeUInt16BE(frame.txnId ?? 0, 0)
            head.writeUInt16BE(0, 2)
            head.writeUInt16BE(resp.length, 4)
            sock.write(Buffer.concat([head, resp]))
          }
        }
      })
    })
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
    setTimeout(() => reject(new Error(`RTU 从站 ${host}:${port} 监听超时`)), 8000)
  })

  let server = await listenOnce()
  const closeAll = () => (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()

  // 断链注入:故障窗内关端口,窗后重启
  const guard = setInterval(async () => {
    if (faultWindowActive(node)) {
      if (server.listening) {
        server.close(() => {})
        closeAll()
      }
    }
    else if (!server.listening) {
      try {
        server = await listenOnce()
      }
      catch { /* 端口仍被占,下一拍再试 */ }
    }
  }, 1000)

  return {
    close: async () => {
      clearInterval(guard)
      // 等 close 回调(端口真正释放)再返回,否则预设切换立刻重绑同端口会 EADDRINUSE
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        try {
          closeAll()
          server.close(() => finish())
          setTimeout(finish, 2500)
        } catch { finish() }
      })
    },
    summary: () => ({ protocol: 'modbus-rtu', host, port, unitId, mode, signals: node.signals.length, listening: server.listening }),
  }
}
