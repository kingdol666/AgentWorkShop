/**
 * 临时诊断:mock Channel 上"后续根任务不派发"的确切边界
 *  1) 新建 mock Channel → task1(首个根任务)
 *  2) 紧接着 task2(第二个根任务)→ 观察是否派发
 *  3) 发一条群聊(受支持的唤醒路径)→ 再观察 task2
 * 用法:AW_BASE=http://127.0.0.1:3001 node scripts/_aw0748-mock-dispatch-diag.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const TAG = Date.now().toString(36).slice(-4)
const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
const health = async () => (await j('GET', '/api/health', undefined, token)).data
console.log(`health before: ${JSON.stringify(await health())}`)

const ch = await j('POST', '/api/workshop/channels', { name: `mock诊断-${TAG}`, description: 'mock 派发边界诊断', leadAgent: { name: `mock-lead-${TAG}`, harness: 'mock' } }, token)
const channelId = ch.data?.channelId
const members = (await j('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token)).data ?? []
const lead = members.find(m => m.role === 'lead')
console.log(`channel=${channelId} lead=${lead?.id} harness=${lead?.harness}`)

const stateOf = async (taskId) => {
  const tasks = (await j('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)).data ?? []
  return tasks.find(t => t.id === taskId)?.state
}
const mk = async title => (await j('POST', `/api/workshop/channels/${channelId}/tasks`, { title, description: 'mock 派发边界诊断', assigneeId: lead?.id }, token)).data?.id
const watch = async (taskId, minutes, label) => {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < minutes * 60_000) {
    await sleep(5000)
    const s = await stateOf(taskId)
    if (s !== last) {
      console.log(`   [${label}] ${Math.round((Date.now() - t0) / 1000)}s state=${s}`)
      last = s
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(s)) return s
  }
  return last
}

const t1 = await mk(`诊断 task1 ${TAG}`)
const s1 = await watch(t1, 2, 'task1')
console.log(`task1 → ${s1}`)
const t2 = await mk(`诊断 task2 ${TAG}`)
const s2a = await watch(t2, 2, 'task2')
console.log(`task2(未唤醒)→ ${s2a}  health=${JSON.stringify(await health())}`)

await j('PATCH', `/api/workshop/channels/${channelId}`, { visibility: 'public', joinPolicy: 'open', approvalPolicy: 'any_member', chatEnabled: 1 }, token)
await j('POST', `/api/workshop/channels/${channelId}/chat/messages`, { text: '唤醒:请确认在线。' }, token)
console.log('已发送唤醒群聊,继续观察 task2…')
const s2b = await watch(t2, 3, 'task2-after-chat')
console.log(`task2(唤醒后)→ ${s2b}  health=${JSON.stringify(await health())}`)
const t3 = await mk(`诊断 task3 ${TAG}`)
const s3 = await watch(t3, 2, 'task3-after-chat')
console.log(`task3(唤醒后新建)→ ${s3}`)
console.log(JSON.stringify({ channelId, t1: s1, t2Before: s2a, t2After: s2b, t3After: s3 }, null, 1))
