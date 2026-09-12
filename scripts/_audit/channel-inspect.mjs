/**
 * channel-inspect.mjs —— 按名字看某个 Channel 的任务与消息(排障常用)
 * 用法:node scripts/_audit/channel-inspect.mjs --base http://127.0.0.1:3112 --match 矩阵-A [--full]
 */
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:3112').replace(/\/$/, '')
const MATCH = arg('match', '')
const FULL = process.argv.includes('--full')

let TOKEN = null
const api = async (method, path, { body } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const data = r => r?.data ?? {}

TOKEN = data(await api('POST', '/api/users/login', { body: { email: 'plant@awshop.local', password: 'Plant!2026' } })).token
if (!TOKEN) { console.error('✖ 登录失败'); process.exitCode = 2; throw new Error('login') }

const raw = data(await api('GET', '/api/workshop/channels'))
const chans = Array.isArray(raw) ? raw : (raw.channels ?? [])
const targets = MATCH ? chans.filter(c => new RegExp(MATCH).test(c.name)) : chans
if (!targets.length) {
  console.log(`没有匹配「${MATCH}」的 Channel。现有:${chans.map(c => c.name).join(' | ')}`)
  process.exitCode = 1
}
else {
  for (const ch of targets) {
    console.log(`\n═══ ${ch.name}  (${ch.id})  lead=${String(ch.leadAgentId).slice(0, 8)} ═══`)
    const tasks = data(await api('GET', `/api/workshop/channels/${ch.id}/tasks`)) ?? []
    for (const t of (Array.isArray(tasks) ? tasks : [])) {
      console.log(`  TASK ${t.id.slice(0, 8)} ${String(t.state).padEnd(10)} progress=${String(t.progress ?? 0).padEnd(4)} retry=${t.retryCount ?? 0} history=${(t.history ?? []).length} assignee=${String(t.assigneeId).slice(0, 8)}  ${t.title}`)
    }
    const m = data(await api('GET', `/api/workshop/channels/${ch.id}/messages?limit=60`))
    const msgs = Array.isArray(m) ? m : (m.messages ?? [])
    console.log(`  ── 消息 ${msgs.length} 条 ──`)
    for (const x of msgs.slice(-10)) {
      const text = (x.parts ?? []).map(p => String(p.text ?? '')).join(' ').replace(/\s+/g, ' ')
      const meta = x.metadata ? ` meta=${JSON.stringify(x.metadata)}` : ''
      console.log(`  · ${(x.kind ?? x.role ?? '?')}${meta}`)
      console.log(`    ${FULL ? text : text.slice(0, 400)}`)
    }
  }
}
