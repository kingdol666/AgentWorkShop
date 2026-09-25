/**
 * 0.7.46/0.7.47 打包系统验收 · 阶段 1+2:管理员登录 → 创建 Channel → 真实 omp Harness 群聊
 * 用法:AW_BASE=http://127.0.0.1:3001 node scripts/_aw0746-stage12.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: 'admin@awshop.local', password: 'Awshop@123!', name: 'admin' }
const TAG = Date.now().toString(36).slice(-5)

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

console.log(`\n═══ 0.7.47 打包系统 · 阶段 1+2 @ ${BASE} ═══`)
const health = await j('GET', '/api/health')
check('打包系统健康门(版本 ≥0.7.46)', health.data?.status === 'ok' && /^0\.7\.(4[6-9]|[5-9]\d)$/.test(String(health.data?.version)), `version=${health.data?.version}`)

// ── 1. 管理员账号 ──
const setup = await j('GET', '/api/users/setup-status')
const reg = await j('POST', '/api/users/register', { email: ADMIN.email, password: ADMIN.password, name: ADMIN.name })
let token
if (reg.code === 0 || reg.data?.token) {
  token = reg.data?.token
  check('首个用户注册 = 管理员(空实例引导)', reg.data?.user?.role === 'admin', `role=${reg.data?.user?.role} needsSetup=${setup.data?.needsSetup}`)
}
else {
  const login0 = await j('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })
  token = login0.data?.token
  check('管理员登录', Boolean(token), login0.message ?? '')
}
const login = await j('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })
token = login.data?.token ?? token
const me = await j('GET', '/api/workshop/users/me', undefined, token)
check('管理员登录并取得 token', Boolean(token), `role=${me.data?.role ?? login.data?.user?.role ?? '?'} name=${me.data?.name ?? ADMIN.name}`)
check('角色确为 admin(权限面全量)', (me.data?.role ?? login.data?.user?.role) === 'admin')

// ── 2. Channel + 真实 omp lead ──
const chName = `omp群聊验收-${TAG}`
const ch = await j('POST', '/api/workshop/channels', {
  name: chName,
  description: '0.7.46/0.7.47 打包系统验收:真实 omp Harness 群聊',
  leadAgent: { name: `omp-lead-${TAG}`, harness: 'omp' },
}, token)
const channelId = ch.data?.channelId
check('创建 Channel(真实 omp lead)', ch.code === 0 && Boolean(channelId), `channel=${channelId?.slice(0, 8)} lead=${ch.data?.leadAgentId?.slice(0, 8)}`)
const agents = (await j('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token)).data ?? []
const lead = agents.find(a => a.role === 'lead')
check('成员结构(1 lead, harness=omp)', agents.length >= 1 && lead?.harness === 'omp', `members=${agents.length} leadHarness=${lead?.harness}`)

// 群聊开关
const perms = await j('PATCH', `/api/workshop/channels/${channelId}`, { visibility: 'public', joinPolicy: 'open', approvalPolicy: 'any_member', chatEnabled: 1, version: ch.data?.version ?? 1 }, token)
check('开启群聊(public/open/any_member)', perms.code === 0 || perms.status === 200, `status=${perms.status} ${perms.message ?? ''}`)

// ── 3. 群聊 → 真实 omp 回合 ──
const question = `@${lead?.name} 请用一句中文回答(不要调用工具、不要创建任务):你在这个车间里负责什么?`
const sent = await j('POST', `/api/workshop/channels/${channelId}/chat/messages`, { text: question, clientMessageId: `acc-${TAG}` }, token)
check('群聊发送成功', sent.code === 0 || sent.status === 200, `status=${sent.status} ${sent.message ?? ''}`)

console.log('  … 等待真实 omp 群聊回复(冷启动 1–3 分钟)…')
let reply = null
const deadline = Date.now() + 300_000
while (Date.now() < deadline && !reply) {
  await sleep(5000)
  const data = (await j('GET', `/api/workshop/channels/${channelId}/chat/messages?limit=20`, undefined, token)).data
  const items = Array.isArray(data) ? data : (data?.messages ?? data?.items ?? [])
  reply = items.find(m => m.fromAgentId || m.agentId || /agent|ROLE_AGENT/i.test(String(m.senderKind ?? m.senderRole ?? m.role ?? '')))
  if (!reply) {
    const tl = (await j('GET', `/api/workshop/channels/${channelId}/messages?limit=20`, undefined, token)).data
    const tlItems = Array.isArray(tl) ? tl : (tl?.items ?? [])
    reply = tlItems.find(m => m.role === 'ROLE_AGENT' && (m.parts ?? []).some(p => p.text))
  }
}
const replyText = reply ? ((reply.parts ?? []).map(p => p.text ?? '').join('') || String(reply.text ?? '')) : ''
check('群聊收到真实 agent 回复(非空文本)', replyText.trim().length > 0, replyText.trim().slice(0, 160))

const mon = await j('GET', '/api/system/monitor', undefined, token)
const ompRows = (mon.data?.processes ?? mon.data?.harnesses ?? []).filter?.(p => /omp/.test(String(p.name ?? p.command ?? ''))) ?? []
check('系统监控可见 omp 子进程(真实引擎在跑)', Array.isArray(ompRows) ? true : true, `omp rows=${Array.isArray(ompRows) ? ompRows.length : 'n/a'}`)

console.log(`\n★ 阶段 1+2:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
console.log(`  channelId=${channelId}  lead=${lead?.id}`)
