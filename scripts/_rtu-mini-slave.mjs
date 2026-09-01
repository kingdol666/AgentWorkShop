/** 迷你 RTU over TCP 从站(15030):FC03/FC10 + CRC16,常驻供节点采样验证。 */
import net from 'node:net'

const regs = new Uint16Array(100)
let flip = false
setInterval(() => {
  flip = !flip
  // float32 42.5 / 44.25 交替(big 端 word 对 0x4222/0x0000 ↔ 0x4231/0x0000)
  const v = flip ? 0x4222 : 0x4231
  regs[0] = v >> 8
  regs[1] = v & 0xff
}, 800)
regs[0] = 0x42
regs[1] = 0x22

net.createServer((sock) => {
  let buf = Buffer.alloc(0)
  sock.on('error', err => console.error('[rtu-mini] socket error:', err.code ?? err.message))
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 7) {
      const len = buf.readUInt16BE(4)
      const total = 6 + len
      if (buf.length < total) break
      const txnId = buf.readUInt16BE(0)
      const unitId = buf[6]
      const fc = buf[7]
      let respBody = null
      if (fc === 0x03 || fc === 0x04) {
        const start = (buf[8] << 8) | buf[9]
        const count = (buf[10] << 8) | buf[11]
        respBody = Buffer.alloc(3 + count * 2)
        respBody[0] = unitId
        respBody[1] = fc
        respBody[2] = count * 2
        for (let i = 0; i < count; i++) {
          respBody[3 + i * 2] = regs[start + i] >> 8
          respBody[4 + i * 2] = regs[start + i] & 0xff
        }
      }
      else if (fc === 0x10) {
        const start = (buf[8] << 8) | buf[9]
        const count = (buf[10] << 8) | buf[11]
        for (let i = 0; i < count; i++) regs[start + i] = (buf[13 + i * 2] << 8) | buf[14 + i * 2]
        respBody = Buffer.alloc(6)
        respBody[0] = unitId
        respBody[1] = fc
        respBody.writeUInt16BE(start, 2)
        respBody.writeUInt16BE(count, 4)
      }
      if (respBody) {
        // 响应 = 标准 Modbus TCP 形式(MBAP + PDU,无 CRC);
        // TcpRTUBufferedPort 的 _emitData 会自行补 CRC 后交给事务层
        const head = Buffer.alloc(6)
        head.writeUInt16BE(txnId, 0)
        head.writeUInt16BE(0, 2)
        head.writeUInt16BE(respBody.length, 4)
        sock.write(Buffer.concat([head, respBody]))
      }
      buf = buf.subarray(total)
    }
  })
}).listen(15030, '127.0.0.1', () => console.log('[rtu-mini] RTU over TCP 从站 127.0.0.1:15030 就绪(FC03/FC10)'))
