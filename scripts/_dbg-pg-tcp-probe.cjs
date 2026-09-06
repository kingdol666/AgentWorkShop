const net = require('net')

const s = net.connect({ host: '127.0.0.1', port: 5432, timeout: 4000 })
s.on('connect', () => {
  console.log('TCP connected')
  // 发送 PG StartupMessage(protocol 3.0, user postgres, db awshop)
  const params = ['user', 'postgres', 'database', 'awshop']
  const body = Buffer.from([0, 3, ...Buffer.from(params.join('\0') + '\0', 'utf8'), 0])
  const head = Buffer.alloc(8)
  head.writeInt32BE(8 + body.length, 0)
  s.write(head)
})
s.on('data', (d) => {
  console.log('resp type:', String.fromCharCode(d[0]), 'len:', d.readInt32BE(1))
  s.destroy()
  process.exit(0)
})
s.on('timeout', () => {
  console.log('TIMEOUT')
  s.destroy()
  process.exit(1)
})
s.on('error', (e) => {
  console.log('ERR:', e.message)
  process.exit(1)
})
s.on('close', had => console.log('closed, hadError=', had))
