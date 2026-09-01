/** 一次性:RTU 从站隔离调试(手搓 FC03 应答;驱动 uint16 读) */
import net from 'node:net'
import { modbusRtuDriver } from '../server/services/workshop/daq/drivers.ts'

const regs = new Uint16Array(100)
regs[0] = 0x1234
regs[1] = 0x5678
const crc16 = (buf) => {
  let crc = 0xffff
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1
  }
  return crc
}
const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    console.log('slave recv:', buf.toString('hex'))
    while (buf.length >= 8) {
      const fc = buf[1]
      if (fc === 0x03) {
        const count = (buf[4] << 8) | buf[5]
        const body = Buffer.from([buf[0], fc, count * 2, regs[0] >> 8, regs[0] & 0xff, regs[1] >> 8, regs[1] & 0xff])
        const crc = Buffer.alloc(2)
        crc.writeUInt16LE(crc16(body), 0)
        const resp = Buffer.concat([body, crc])
        console.log('slave resp:', resp.toString('hex'))
        sock.write(resp)
      }
      buf = buf.subarray(8)
    }
  })
})
server.listen(15031, '127.0.0.1', async () => {
  const v = await modbusRtuDriver.sample({ ctx: { nodeId: 'x', now: Date.now(), ageMs: 0 }, config: { base: 0, amp: 0, min: 0, max: 0 }, driverConfig: { host: '127.0.0.1', port: 15031, unitId: 1, register: 40001, dataType: 'uint16', byteOrder: 'big' } })
  console.log('driver read =', v, '(expect 22136)')
  server.close()
  process.exit(0)
})
