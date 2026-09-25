/**
 * 临时:唤醒指定 Channel 的 lead(发一条群聊并等真实回复),用于验证
 * "lead 未 attach 时根任务只挂 SUBMITTED,不派发" 这一调度事实。
 * 用法:AW_BASE=http://127.0.0.1:3001 AW_CHANNEL_ID=<id> node scripts/_aw0748-wake-channel.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const CHANNEL_ID = process.env.AW_CHANNEL_ID
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
const health0 = (await j('GET', '/api/health', undefined, token)).data
console.log(`health: wiredAgents=${health0?.wiredAgents} activeChannels=${health0?.activeChannels}`)

const ch = (await j('GET', `/api/workshop/channels/${CHANNEL_ID}`, undefined, token)).data
const open = await j('PATCH', `/api/workshop/channels/${CHANNEL_ID}`, { visibility: 'public', joinPolicy: 'open', approvalPolicy: 'any_member', chatEnabled: 1, version: ch?.version ?? 1 }, token)
console.log(`chat enable: status=${open.status} ${open.code ?? ''} ${open.message ?? 'ok'}`)
const sent = await j('POST', `/api/workshop/channels/${CHANNEL_ID}/chat/messages`, { text: '唤醒确认:请用一句话说明你的角色与职责。' }, token)
console.log(`chat send: status=${sent.status} ${sent.code ?? ''}`)

const before = (await j('GET', `/api/workshop/channels/${CHANNEL_ID}/chat/messages?limit=5`, undefined, token)).data?.messages?.length ?? 0
console.log(`messages before=${before}, 等待真实回复(最长 6 分钟)…`)
let reply = ''
const deadline = Date.now() + 6 * 60_000
while (Date.now() < deadline) {
  await sleep(12_000)
  const msgs = (await j('GET', `/api/workshop/channels/${CHANNEL_ID}/chat/messages?limit=10`, undefined, token)).data?.messages ?? []
  const agentMsg = [...msgs].reverse().find(m => m.role !== 'user' && String(m.text ?? '').trim().length > 0)
  if (agentMsg) {
    reply = String(agentMsg.text)
    break
  }
  process.stdout.write('.')
}
const health1 = (await j('GET', '/api/health', undefined, token)).data
console.log(`\nwiredAgents: ${health0?.wiredAgents} → ${health1?.wiredAgents}`)
console.log(reply ? `✓ lead 已 attach,回复:${reply.slice(0, 120)}` : '✗ 未收到回复')
