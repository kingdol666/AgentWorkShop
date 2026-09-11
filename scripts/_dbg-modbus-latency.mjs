import ModbusRTU from 'modbus-serial'

const t0 = Date.now()
const c = new ModbusRTU()
await c.connectTCP('127.0.0.1', { port: 16040 })
c.setID(1)
c.setTimeout(3000)
await c.readHoldingRegisters(0, 2)
const lat = []
for (let i = 0; i < 12; i++) {
  const t = Date.now()
  const r = await c.readHoldingRegisters(0, 2)
  lat.push(Date.now() - t)
  if (i === 0) {
    const buf = Buffer.alloc(4)
    buf.writeUInt16BE(r.data[0], 0); buf.writeUInt16BE(r.data[1], 2)
    console.log('melt-temp raw =', buf.readFloatBE(0).toFixed(3))
  }
}
console.log('read latencies(ms):', lat.join(','))
console.log('avg =', (lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1), 'ms; connect+first =', Date.now() - t0, 'ms')
c.close(() => {})
