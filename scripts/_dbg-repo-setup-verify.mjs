// repo 实例 setup 流程 API 验证:轮询等待服务起来 → 立刻注册(抢在探针前) → 断言 admin
const BASE = 'http://127.0.0.1:3001'
const CREDS = { name: 'admin', email: 'admin@awshop.local', password: 'Awshop2026' }
const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

let alive = false
for (let i = 0; i < 120; i++) {
  try { await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) }); alive = true; break }
  catch { await new Promise(r => setTimeout(r, 500)) }
}
if (!alive) { console.error('✖ 服务未在超时内就绪'); process.exit(1) }

const s0 = await api('/api/users/setup-status')
console.log('setup-status 初始:', JSON.stringify(s0.body?.data), s0.status === 200 && s0.body?.data?.needsSetup === true ? '✔' : '✖')
if (s0.body?.data?.needsSetup !== true) process.exit(1)

const reg = await api('/api/users/register', { method: 'POST', body: JSON.stringify(CREDS) })
console.log('注册首个账号:', reg.body?.data?.user?.email, reg.body?.data?.user?.role, reg.body?.data?.user?.role === 'admin' ? '✔' : '✖')
if (reg.body?.data?.user?.role !== 'admin') process.exit(1)

const s1 = await api('/api/users/setup-status')
console.log('注册后 setup-status:', JSON.stringify(s1.body?.data), s1.body?.data?.needsSetup === false ? '✔' : '✖')

const login = await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: CREDS.email, password: CREDS.password }) })
console.log('新管理员登录:', login.body?.data?.user?.role === 'admin' ? '✔' : '✖')
const me = await api('/api/users/me', { headers: { authorization: `Bearer ${login.body?.data?.token}` } })
console.log('/api/users/me:', me.body?.data?.role === 'admin' ? '✔' : '✖')
console.log(me.body?.data?.role === 'admin' ? 'REPO-SETUP-OK' : 'REPO-SETUP-FAIL')
