// 审计修复负向断言:越权 start/stop/samples/WS 无鉴权
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const ADMIN_PASS = process.argv[3] ?? 'admin123'
let step = 0
const ok = (name, cond, detail = '') => {
  step++
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) process.exitCode = 1
}
const api = async (path, opts = {}, tok) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...opts.headers },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const adminTok = (await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: 'admin@awshop.local', password: ADMIN_PASS }) })).body?.data?.token
ok('admin 登录', Boolean(adminTok))

// 拿 admin 视角的有线 dcw 节点 + 有线节点 samples
const dcw = (await api('/api/workshop/dcw', {}, adminTok)).body?.data ?? {}
const lineNode = dcw.nodes?.find(n => n.lineId)
ok('admin 可见有产线节点', Boolean(lineNode), lineNode?.id)

// plain(复用权限 E2E 建的账号或新注册,默认零授权)
const stamp = Date.now().toString(36)
const reg = await api('/api/users/register', { method: 'POST', body: JSON.stringify({ name: `a-${stamp}`, email: `a-${stamp}@awshop.local`, password: 'Plain2026' }) })
const plainTok = reg.body?.data?.token
ok('plain 注册', Boolean(plainTok))

// 越权断言
const r1 = await api(`/api/workshop/dcw/lines/${lineNode.lineId}/start`, { method: 'POST', body: '{}' }, plainTok)
ok('零授权 start 产线被拒(403)', r1.status === 403, r1.body?.message)
const r2 = await api(`/api/workshop/dcw/lines/${lineNode.lineId}/stop`, { method: 'POST', body: '{}' }, plainTok)
ok('零授权 stop 产线被拒(403)', r2.status === 403, r2.body?.message)
const daq = (await api('/api/workshop/daq', {}, adminTok)).body?.data ?? {}
const daqNode = daq.nodes?.find(n => n.lineId)
const r3 = await api(`/api/workshop/daq/${daqNode.id}/samples?limit=5`, {}, plainTok)
ok('零授权读历史采样被拒(403)', r3.status === 403, r3.body?.message)
const r4 = await api(`/api/workshop/daq/${daqNode.id}/frames?limit=5`, {}, plainTok)
ok('零授权读帧列表被拒(403)', r4.status === 403, r4.body?.message)

// ws 未鉴权:裸连(无 token)应收不到 scene 帧(10s 无 daq.reading)
const wsUrl = `${BASE.replace('http', 'ws')}/api/workshop/ws`
const ws = new WebSocket(wsUrl)
let frames = 0
ws.onmessage = () => frames++
await new Promise(r => setTimeout(r, 10000))
ws.close()
ok('无 token WS 连接收不到遥测帧(10s)', frames === 0, `frames=${frames}`)

// 带 token 的 WS:admin 能收到遥测(存活验证)
const ws2 = new WebSocket(`${wsUrl}?token=${adminTok}`)
let frames2 = 0
ws2.onmessage = (ev) => {
  const d = JSON.parse(ev.data)
  if (d.type === 'daq.reading' || d.type === 'dcw.read') frames2++
}
await new Promise(r => setTimeout(r, 12000))
ws2.close()
ok('带 token WS 收到遥测帧', frames2 > 0, `frames=${frames2}`)

console.log(`\n===== audit negative E2E: ${step} 项 =====`)
