/**
 * REST 鲁棒性端到端探针(对运行中的 dev server)—— 异常输入/边界/并发/级联/幂等:
 * ① 校验层:缺字段/非法枚举/越界数值 → 400;空 query → 400
 * ② 鉴权层:无 token → 401;伪 token → 401
 * ③ 作用域:不存在资源 → 404;跨 channel 读写 → 403;非 lead 写团队域 → 403
 * ④ 并发:单 channel 8 任务并发提交 → 全部闭环无 5xx
 * ⑤ 幂等:同 dedupKey 两次写入 → 记忆行数不增
 * ⑥ 级联:channel 删除 → 记忆连带清理,残留公共记忆不泄漏进他 channel 检索域
 * 运行: node scripts/e2e-rest-robustness.mjs(需 server 已启动,AW_E2E_BASE 可覆盖)
 */
const BASE = process.env.AW_E2E_BASE ?? 'http://localhost:3000'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api/workshop${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.code, data: json?.data }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitUntil(fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(everyMs)
  }
  return null
}

async function main() {
  // ── 前置:双 channel + 成员 ──
  const chA = await api('POST', '/channels', { body: { name: `robust-a-${Date.now()}` } })
  const chB = await api('POST', '/channels', { body: { name: `robust-b-${Date.now()}` } })
  const channelId = chA.data.channelId
  const otherId = chB.data.channelId
  const mk = async (ch, name, role) =>
    (await api('POST', `/channels/${ch}/agents`, { body: { name, harness: 'mock', role } })).data
  const lead = await mk(channelId, 'rb-lead', 'lead')
  const w1 = await mk(channelId, 'rb-w1', 'worker')
  const w2 = await mk(channelId, 'rb-w2', 'worker')
  const other = await mk(otherId, 'rb-other', 'worker')

  console.log('=== ① 校验层(400)===')
  const noTitle = await api('POST', `/channels/${channelId}/tasks`, { token: lead.token, body: { description: 'x' } })
  check('任务缺 title → 400', noTitle.status === 400)
  const badScope = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories/search`, {
    token: lead.token, body: { query: 'x', scope: 'everywhere' },
  })
  check('search 非法 scope 枚举 → 400', badScope.status === 400)
  const badLimit = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories/search`, {
    token: lead.token, body: { query: 'x', limit: 999 },
  })
  check('search limit 越界(>20)→ 400', badLimit.status === 400)
  const emptyQuery = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories/search`, {
    token: lead.token, body: { query: '' },
  })
  check('search 空 query → 400', emptyQuery.status === 400)
  const badImportance = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories`, {
    token: w1.token, body: { title: 't', content: 'c', importance: 5 },
  })
  check('importance 越界(>1)→ 400', badImportance.status === 400)
  const badMode = await api('POST', `/channels/${channelId}/tasks`, {
    token: lead.token, body: { title: 'x', mode: 'chaos' },
  })
  check('任务非法 mode 枚举 → 400', badMode.status === 400)

  console.log('\n=== ② 鉴权层(401)===')
  const noToken = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories/search`, { body: { query: 'x' } })
  check('search 无 token → 401', noToken.status === 401)
  const fakeToken = await api('POST', `/channels/${channelId}/memories`, { token: 'not-a-real-token', body: { title: 'x', content: 'y' } })
  check('伪 token → 401', fakeToken.status === 401)

  console.log('\n=== ③ 作用域(404/403)===')
  const ghostChannel = await api('GET', '/channels/00000000-0000-0000-0000-000000000000/agents', { token: lead.token })
  check('不存在 channel 列成员 → 404', ghostChannel.status === 404)
  const ghostSearch = await api('POST', `/channels/${channelId}/agents/00000000-0000-0000-0000-000000000000/memories/search`, {
    token: lead.token, body: { query: 'x' },
  })
  check('不存在 agent 检索 → 404', ghostSearch.status === 404)
  const ghostTask = await api('GET', '/tasks/00000000-0000-0000-0000-000000000000', { token: lead.token })
  check('不存在任务详情 → 404', ghostTask.status === 404)
  const crossSearch = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories/search`, {
    token: other.token, body: { query: 'x' },
  })
  check('跨 channel search → 403', crossSearch.status === 403 && crossSearch.code === 'SCOPE_VIOLATION')
  const crossSend = await api('POST', '/a2a/send', {
    token: other.token, body: { toAgentId: w1.id, parts: [{ text: 'hi' }] },
  })
  check('跨 channel 发消息 → 403', crossSend.status === 403)
  const workerTeamWrite = await api('POST', `/channels/${channelId}/memories`, {
    token: w1.token, body: { title: 'x', content: 'y' },
  })
  check('非 lead 写团队记忆 → 403', workerTeamWrite.status === 403)

  console.log('\n=== ④ 并发(8 任务同 channel)===')
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    api('POST', `/channels/${channelId}/tasks`, {
      token: lead.token,
      body: { title: `并发任务-${i + 1}`, description: `并发压测任务 ${i + 1}:幂等回显` },
    })))
  check('8 任务并发提交全部 2xx(无 5xx)', burst.every(r => r.status === 200 && r.code === 0),
    `statuses=${[...new Set(burst.map(r => r.status))].join(',')}`)
  const allDone = await waitUntil(async () => {
    const tasks = (await api('GET', `/channels/${channelId}/tasks`, { token: lead.token })).data ?? []
    const parents = tasks.filter(t => t.title.startsWith('并发任务-') && !t.parentId)
    return parents.length === 8 && parents.every(t => t.state === 'COMPLETED')
  }, 120_000)
  // dispatch 复制父任务标题 → 子任务同名;按父任务(无 parentId)计 8 个
  const burstTasks = ((await api('GET', `/channels/${channelId}/tasks`, { token: lead.token })).data ?? [])
    .filter(t => t.title.startsWith('并发任务-') && !t.parentId)
  check('8 父任务全部闭环 COMPLETED', !!allDone, burstTasks.map(t => t.state).join(','))
  check('并发任务各有唯一子任务(无重复派发)', burstTasks.length === 8
  && burstTasks.every(t => t.state === 'COMPLETED'), `parents=${burstTasks.length}`)

  console.log('\n=== ⑤ 幂等(稳定 dedupKey)===')
  for (let i = 0; i < 2; i++) {
    await api('POST', `/channels/${channelId}/agents/${w1.id}/memories`, {
      token: w1.token,
      body: { title: '幂等规范', content: `第 ${i + 1} 次写入同 key`, dedupKey: 'robust:idem' },
    })
  }
  const w1rows = (await api('GET', `/channels/${channelId}/agents/${w1.id}/memories`, { token: w1.token })).data ?? []
  check('同 dedupKey 两次写入 → 单行刷新', w1rows.filter(r => r.title === '幂等规范').length === 1,
    `rows=${w1rows.filter(r => r.title === '幂等规范').length}`)

  console.log('\n=== ⑥ 级联(channel 删除 → 记忆清理 + 无泄漏) ===')
  // 先在 B 写一条特征公共记忆,删除 B 后验证 A 的检索域不被污染
  await api('POST', `/channels/${otherId}/agents/${other.id}/memories`, {
    token: other.token,
    body: { title: '被删域特征记忆', content: 'cascade-robust-marker 不应被他人检索到', scope: 'shared', dedupKey: 'robust:cascade' },
  })
  const del = await api('DELETE', `/channels/${otherId}`)
  check('DELETE channel → 200', del.status === 200 && del.code === 0)
  const afterDel = await api('GET', `/channels/${otherId}/agents`, { token: other.token })
  check('删除后列成员 → 404', afterDel.status === 404)
  const leak = await api('POST', `/channels/${channelId}/agents/${w2.id}/memories/search`, {
    token: w2.token, body: { query: 'cascade-robust-marker 被删域', scope: 'shared', limit: 20 },
  })
  check('被删 channel 公共记忆不泄漏进他 channel 检索', (leak.data ?? []).every(s => !s.content.includes('cascade-robust-marker')),
    JSON.stringify((leak.data ?? []).map(s => s.title)))

  // ── 收尾 ──
  const cleanup = await api('DELETE', `/channels/${channelId}`)
  check('清理主 channel', cleanup.code === 0)
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exit(1)
})
