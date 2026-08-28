/** 一次性:上行 sub 帧 → channel.snapshot 的直达验证(Node 原生 WS) */
const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const H = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }
const chanId = (await fetch(`${BASE}/api/workshop/channels`, { headers: H }).then(r => r.json())).data[0]?.id
console.log('channel =', chanId)

const seen = { open: false, pong: false, snap: false, err: null, daqReading: 0 }
const sock = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?token=${token}`)
sock.onopen = () => {
  seen.open = true
  sock.send(JSON.stringify({ type: 'ping' }))
}
sock.onmessage = (ev) => {
  const d = JSON.parse(String(ev.data))
  if (d.type === 'pong') {
    if (!seen.pong) {
      seen.pong = true
      console.log('pong → sending sub')
      sock.send(JSON.stringify({ type: 'sub', channelId: chanId, token }))
    }
    return
  }
  if (d.type === 'channel.snapshot') { seen.snap = true; console.log('snapshot arrived') }
  else if (d.type === 'daq.reading') seen.daqReading++
  else if (d.type === 'error') { seen.err = d.payload }
}
setTimeout(() => {
  console.log(JSON.stringify(seen))
  process.exit(0)
}, 6000)
