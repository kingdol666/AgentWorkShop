/**
 * WS 协议解析验证 — 通过真实 WebSocket 连接验证 CMDParser 在消息边界的行为
 *
 * 验证矩阵:
 *  A. 上行规范指令: session.join / player.pos / agent.pos / input.move → 服务端消费(无 error 回传)
 *  B. 上行不规范指令: 坏JSON / 缺payload / 未知指令 / 越界枚举 → 服务端回传 error 指令(BAD_MESSAGE/UNKNOWN_COMMAND/INVALID_PAYLOAD)
 *  C. 服务行规范下行: 自动 session.ready / agent.state 均可被前端 CMDParser 解析
 *
 * 仅验证"线上解析"层(前后端消息边界);"前端渲染"由浏览器截图单独验证。
 * 使用 Node 内置全局 WebSocket(Node 22+),无需第三方依赖。
 */
/** 业务 WS 鉴权:先注册临时用户拿 token(?token= 查询参数) */
async function bootstrapToken(): Promise<string> {
  const base = (process.env.WS_URL ?? 'ws://localhost:3000').replace(/^ws/, 'http').replace(/\/api\/game\/ws$/, '')
  const r = await fetch(`${base}/api/users/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `wsp-${Date.now().toString(36)}`, email: `wsp-${Date.now().toString(36)}@test.local`, password: 'Passw0rd!123' }),
  }).then(x => x.json())
  if (r.code !== 0) throw new Error(`注册失败: ${r.message}`)
  return r.data.token as string
}
const USER_TOKEN = await bootstrapToken()
const WS_URL = `${process.env.WS_URL ?? 'ws://localhost:3000/api/game/ws'}?token=${encodeURIComponent(USER_TOKEN)}`
let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fail += 1
}

interface WireMsg { type: string, payload: Record<string, unknown> }

type WsLike = InstanceType<typeof WebSocket>

function connect(): Promise<WsLike> {
  const { promise, resolve, reject } = Promise.withResolvers<WsLike>()
  const ws = new WebSocket(WS_URL)
  ws.addEventListener('open', () => resolve(ws as WsLike))
  ws.addEventListener('error', () => reject(new Error('ws connect failed')))
  return promise
}

/** 收集指定时间窗内的下行消息 */
function collect(ws: WsLike, ms: number): Promise<WireMsg[]> {
  const msgs: WireMsg[] = []
  const { promise, resolve } = Promise.withResolvers<WireMsg[]>()
  const handler = (ev: MessageEvent) => {
    try {
      msgs.push(JSON.parse(ev.data as string))
    }
    catch {
      msgs.push({ type: '__unparseable__', payload: {} })
    }
  }
  ws.addEventListener('message', handler)
  setTimeout(() => {
    ws.removeEventListener('message', handler)
    resolve(msgs)
  }, ms)
  return promise
}

/** 发送上行并等待回传(收集 200ms) */
function sendAndCollect(ws: WsLike, raw: string): Promise<WireMsg[]> {
  const p = collect(ws, 200)
  ws.send(raw)
  return p
}

async function main(): Promise<void> {
  console.log(`\n=== WS 协议解析验证 (${WS_URL}) ===`)
  const ws = await connect()
  console.log('connected\n')

  // 连接后服务端自动下发 session.ready + agent.state,验证"规范下行可被解析"
  const initial = await collect(ws, 500)
  const types = initial.map(m => m.type)
  check('连接收到 session.ready', types.includes('session.ready'), JSON.stringify(types))
  check('连接收到 agent.state', types.includes('agent.state'))
  check('session.ready 有 agentName + spawn', (() => {
    const m = initial.find(x => x.type === 'session.ready')
    return !!m && typeof m.payload.agentName === 'string' && !!m.payload.spawn
  })())

  // ---------------- A. 上行规范指令(应被消费,无 error) ----------------
  console.log('\n--- A. 上行规范指令(应无 error 回传) ---')

  const a1 = await sendAndCollect(ws, JSON.stringify({ type: 'player.pos', payload: { x: 700, y: 650, tileX: 21, tileY: 20 } }))
  check('player.pos 规范 → 无 error', a1.every(m => m.type !== 'error'), JSON.stringify(a1.map(m => m.type)))

  const a2 = await sendAndCollect(ws, JSON.stringify({ type: 'agent.pos', payload: { x: 720, y: 656 } }))
  check('agent.pos 规范 → 无 error', a2.every(m => m.type !== 'error'))

  const a3 = await sendAndCollect(ws, JSON.stringify({ type: 'input.move', payload: { dx: 1, dy: 0 } }))
  check('input.move 规范(dx=1) → 无 error', a3.every(m => m.type !== 'error'))

  const a4 = await sendAndCollect(ws, JSON.stringify({ type: 'input.move', payload: { dx: -1, dy: 0 } }))
  check('input.move 规范(dx=-1) → 无 error', a4.every(m => m.type !== 'error'))

  // ---------------- B. 上行不规范指令(应回传对应 error) ----------------
  console.log('\n--- B. 上行不规范指令(应回传 error) ---')

  const b1 = await sendAndCollect(ws, '{not valid json')
  check('坏JSON → error(BAD_MESSAGE)', b1.some(m => m.type === 'error' && m.payload.code === 'BAD_MESSAGE'), JSON.stringify(b1))

  const b2 = await sendAndCollect(ws, JSON.stringify({ type: 'input.move', payload_dx: 1 }))
  check('缺payload → error(BAD_MESSAGE)', b2.some(m => m.type === 'error' && m.payload.code === 'BAD_MESSAGE'))

  const b3 = await sendAndCollect(ws, JSON.stringify({ type: 'totally.unknown', payload: {} }))
  check('未知指令 → error(UNKNOWN_COMMAND)', b3.some(m => m.type === 'error' && m.payload.code === 'UNKNOWN_COMMAND'))

  const b4 = await sendAndCollect(ws, JSON.stringify({ type: 'input.move', payload: { dx: 5, dy: 0 } }))
  check('dx=5越界枚举 → error(INVALID_PAYLOAD)', b4.some(m => m.type === 'error' && m.payload.code === 'INVALID_PAYLOAD'), JSON.stringify(b4))

  const b5 = await sendAndCollect(ws, JSON.stringify({ type: 'player.pos', payload: { x: 1, y: 2 } }))
  check('player.pos 缺tileX/tileY → error(INVALID_PAYLOAD)', b5.some(m => m.type === 'error' && m.payload.code === 'INVALID_PAYLOAD'))

  const b6 = await sendAndCollect(ws, JSON.stringify({ type: 'input.move', payload: { dx: 'left', dy: 0 } }))
  check('dx=字符串类型错误 → error(INVALID_PAYLOAD)', b6.some(m => m.type === 'error' && m.payload.code === 'INVALID_PAYLOAD'))

  const b7 = await sendAndCollect(ws, JSON.stringify({ type: 'session.join', payload: { agentId: 'x', extra: 1 } }))
  check('额外字段(闭合schema) → error(INVALID_PAYLOAD)', b7.some(m => m.type === 'error' && m.payload.code === 'INVALID_PAYLOAD'))

  ws.close()
  console.log(`\n=== ${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} (${pass}/${pass + fail}) ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('WS 验证失败:', e)
  process.exit(1)
})
