/**
 * AgentTeam 协作守卫专项 e2e(mock):
 *  - 防重复派发:同父同标题子任务在途 → 409 DUPLICATE_DISPATCH
 *  - 规范化匹配:大小写/空白变体同样被拦
 *  - 已完成且有交付 → 409 并附既有成果预览(lead 直接引用,不重做)
 *  - 不同标题 → 正常派发
 *  - 指纹节流下 mock 三模式回归(goal 快速一例)
 * 运行:node scripts/test-collab-e2e.mjs(默认 http://127.0.0.1:3101)
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'

let failures = 0
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs = 60_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 140)})`)
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  console.log(`目标: ${BASE}\n`)
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `collab-${Date.now().toString(36)}` } })
  const token = user.data?.token
  if (!token) throw new Error('注册失败')

  // mock channel(lead + worker)
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: `collab-${Date.now().toString(36)}`, leadAgent: { name: 'lead', harness: 'mock' } },
    token,
  })
  const channelId = ch.data.channelId
  const leadId = ch.data.leadAgentId
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { name: 'worker', harness: 'mock', role: 'worker' }, token })
  const workerId = w.data.id
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
  const leadToken = (members.data ?? []).find(m => m.id === leadId)?.token
  check('channel + lead/worker 就绪', !!leadToken && !!workerId)

  // 父任务
  const parent = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: { title: 'collab-guard-parent', description: '守卫专项父任务' },
    token,
  })
  const parentId = parent.data.id
  check('父任务提交', !!parentId)

  // ① 首次派发成功
  const d1 = await api('POST', `/api/workshop/tasks/${parentId}/dispatch`, {
    body: { assigneeId: workerId, title: 'dup-test', description: '首次派发' },
    token: leadToken,
  })
  check('① 首次派发成功', d1.code === 0, `code=${d1.code}`)

  // ② 同标题重复派发(在途)→ 409
  const d2 = await api('POST', `/api/workshop/tasks/${parentId}/dispatch`, {
    body: { assigneeId: workerId, title: 'dup-test', description: '重复!' },
    token: leadToken,
  })
  check('② 在途同标题重复派发被拒', d2.code === 'DUPLICATE_DISPATCH' || d2.status === 409, `code=${d2.code}`)
  check('② 拒绝信息指明在途状态', String(d2.message ?? '').includes('已在执行中'))

  // ③ 规范化变体(大小写+空白)同样被拦
  const d3 = await api('POST', `/api/workshop/tasks/${parentId}/dispatch`, {
    body: { assigneeId: workerId, title: '  DUP-Test  ', description: '变体' },
    token: leadToken,
  })
  check('③ 大小写/空白变体被拦(规范化匹配)', d3.code === 'DUPLICATE_DISPATCH' || d3.status === 409)

  // ④ 不同标题 → 正常
  const d4 = await api('POST', `/api/workshop/tasks/${parentId}/dispatch`, {
    body: { assigneeId: workerId, title: 'other-work', description: '不同工作' },
    token: leadToken,
  })
  check('④ 不同标题正常派发', d4.code === 0)

  // ⑤ 等 dup-test 完成(mock)→ 同标题再派发 → 409 且含交付预览
  await waitUntil('dup-test 完成', async () => {
    const tasks = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
    const t = (tasks.data ?? []).find(x => x.title === 'dup-test')
    return t?.state === 'COMPLETED' ? t : null
  })
  const d5 = await api('POST', `/api/workshop/tasks/${parentId}/dispatch`, {
    body: { assigneeId: workerId, title: 'dup-test', description: '完成后重派' },
    token: leadToken,
  })
  check('⑤ 已完成同标题重派被拒', d5.code === 'DUPLICATE_DISPATCH' || d5.status === 409)
  check('⑤ 拒绝信息附既有成果提示', String(d5.message ?? '').includes('已完成并交付'))

  // ⑥ 指纹节流下 goal 模式回归(快速)
  const goal = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'goal-regress',
      description: '[mode:goal][criteria:mock 完成] 指纹节流下的 goal 回归',
    },
    token,
  })
  const goalId = goal.data.id
  const goalFinal = await waitUntil('goal 任务终态', async () => {
    const tasks = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
    const t = (tasks.data ?? []).find(x => x.id === goalId)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(t?.state ?? '') ? t.state : null
  }, 90_000)
  check('⑥ 指纹节流下 goal 模式正常完成', goalFinal === 'COMPLETED', `state=${goalFinal}`)

  // 清理
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
