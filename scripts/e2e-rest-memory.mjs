/**
 * REST API 端到端测试(对运行中的 dev server)—— 记忆全链 + 编排全链:
 * ① Channel/Agent(lead+2 worker)经 REST 创建(Bearer token 鉴权)
 * ② 任务提交 → lead 调配(mock supervise dispatch)→ worker 执行 → 闭环
 * ③ 执行 summary/关键动作自动沉淀为记忆(终态 harvest;worker + lead 各自落库)
 * ④ 记忆检索 REST(与 agent search_memory 工具同源算法;scope=auto/private/shared)
 * ⑤ 动态存储:REST 写私有记忆 + 写 Channel 公共记忆(scope=shared,全员可检索)
 * ⑥ 实时通讯:a2a/send 触发器消息 → 对方回执 → 双方 peer 记忆落库
 * ⑦ 新相关任务自动感知(执行后记忆增量 + 检索命中)
 * ⑧ 维护端点 / 跨 channel 隔离(403)/ 清理
 * 运行: node scripts/e2e-rest-memory.mjs(需 server 已启动,AW_E2E_BASE 可覆盖)
 */
const BASE = process.env.AW_E2E_BASE ?? 'http://localhost:3100'

// 用户级隔离:注册测试用户,管理面 API 全程携带用户 token
const __user = await fetch(BASE + '/api/workshop/users/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'e2e-' + Math.random().toString(36).slice(2, 10) }),
}).then(r => r.json()).catch(() => null)
const __userToken = __user?.data?.token
if (!__userToken) {
  console.error('用户注册失败(服务器未启动或缺少用户端点)')
  process.exit(1)
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api/workshop${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token ?? __userToken}` }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, code: json.code, data: json.data }
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
  // ── ⓪ server 就绪 ──
  const up = await waitUntil(async () => {
    try {
      await api('GET', '/channels')
      return true
    }
    catch { return false }
  }, 60_000, 1000)
  check('dev server 就绪', up === true, BASE)

  // ── ① Channel + lead + 2 worker ──
  console.log('\n=== ① Channel/Agent 创建 ===')
  const ch = await api('POST', '/channels', { body: { name: `rest-e2e-${Date.now()}`, description: 'REST e2e 记忆链路' } })
  check('POST /channels → 200', ch.status === 200 && ch.code === 0 && !!ch.data.channelId, JSON.stringify(ch.data).slice(0, 80))
  const channelId = ch.data.channelId

  const mkAgent = async (name, role) => {
    const r = await api('POST', `/channels/${channelId}/agents`, { body: { name, harness: 'mock', role } })
    return r.data
  }
  const lead = await mkAgent('rest-lead', 'lead')
  const w1 = await mkAgent('rest-w1', 'worker')
  const w2 = await mkAgent('rest-w2', 'worker')
  check('lead/worker 实例创建(含 token)', !!lead?.token && !!w1?.token && !!w2?.token, `${lead?.id?.slice(0, 8)} ${w1?.id?.slice(0, 8)} ${w2?.id?.slice(0, 8)}`)

  const listRes = await api('GET', `/channels/${channelId}/agents`, { token: lead.token })
  check('GET channel agents(lead token)→ 3 实例', listRes.code === 0 && listRes.data.length === 3)

  // ── ② 任务提交 → lead 调配 → worker 执行 ──
  console.log('\n=== ② 任务编排(lead 调配 + worker 执行) ===')
  const submit = (title, description) => api('POST', `/channels/${channelId}/tasks`, { body: { title, description } })
  const t1 = await submit('实现支付网关对接', '为订单系统对接支付宝网关,完成签名与回调验签')
  check('任务1 提交 → 200', t1.status === 200 && t1.code === 0, `taskId=${t1.data?.id?.slice(0, 8)}`)

  const done1 = await waitUntil(async () => {
    const r = await api('GET', `/channels/${channelId}/tasks`, { token: lead.token })
    return r.data.find(t => t.title === '实现支付网关对接' && t.state === 'COMPLETED')
  }, 30_000)
  check('任务1 闭环 COMPLETED', !!done1)

  const tasks1 = (await api('GET', `/channels/${channelId}/tasks`, { token: lead.token })).data
  const child1 = tasks1.find(t => t.parentId === t1.data.id)
  check('lead 自动调配(生成子任务指派 worker)', !!child1 && child1.assigneeId !== lead.id, child1 ? `assignee=${child1.assigneeId.slice(0, 8)}` : 'no child')
  check('worker 执行留痕(子任务 progress=100 + artifacts)', !!child1 && child1.progress === 100 && child1.artifacts.length > 0)

  const queue = await api('GET', `/channels/${channelId}/queue`, { token: lead.token })
  check('GET queue 状态视图(3 成员)', queue.code === 0 && queue.data.length === 3, JSON.stringify(queue.data?.map(s => `${s.name}:${s.state}`)))

  // ── ③ 执行 summary 自动沉淀记忆 ──
  console.log('\n=== ③ 执行 summary 自动沉淀 ===')
  const memOf = async (agentId, token) => {
    const r = await api('GET', `/channels/${channelId}/agents/${agentId}/memories`, { token })
    return Array.isArray(r.data) ? r.data : []
  }
  const w1mem = await waitUntil(async () => {
    const rows = await memOf(child1.assigneeId, lead.token)
    return rows.find(r => r.kind === 'episodic-task' && r.title === '实现支付网关对接') ? rows : null
  }, 10_000)
  const executorId = child1.assigneeId
  const execRow = w1mem?.find(r => r.kind === 'episodic-task' && r.title === '实现支付网关对接')
  check('执行 worker 记忆自动沉淀(episodic-task)', !!execRow, execRow?.title)
  check('记忆含执行成果(mock 成果 summary)', !!execRow && execRow.content.includes('mock 成果'), execRow?.content.slice(0, 50))

  const leadMem = await waitUntil(async () => {
    const rows = await memOf(lead.id, lead.token)
    return rows.find(r => r.kind === 'episodic-task' && r.title === '实现支付网关对接') ? rows : null
  }, 10_000)
  check('lead 记忆自动沉淀(父任务汇总 harvest)', !!leadMem, leadMem?.map(r => r.title).join(','))

  // ── ④ 记忆检索 REST(动态获取) ──
  console.log('\n=== ④ 记忆检索(REST search) ===')
  const search = (agentId, token, body) => api('POST', `/channels/${channelId}/agents/${agentId}/memories/search`, { token, body })
  const sAuto = await search(executorId, lead.token, { query: '支付网关 签名', scope: 'auto' })
  check('search auto 命中执行记忆', sAuto.code === 0 && sAuto.data.some(s => s.title === '实现支付网关对接'),
    JSON.stringify(sAuto.data?.slice(0, 2).map(s => `${s.source}:${s.title}`)))
  check('search 返回原文 content + score', sAuto.data.every(s => s.content.length > 0 && typeof s.score === 'number'))

  const sSharedEmpty = await search(executorId, lead.token, { query: '规范', scope: 'shared' })
  check('shared 域初始为空(无公共记忆)', sSharedEmpty.code === 0 && sSharedEmpty.data.length === 0)

  const s401 = await fetch(`${BASE}/api/workshop/channels/${channelId}/agents/${executorId}/memories/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x' }),
  })
  check('search 无 token → 401', s401.status === 401)

  // ── ⑤ 动态存储:私有 + Channel 公共 ──
  console.log('\n=== ⑤ 记忆动态存储(REST 写入) ===')
  const post1 = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories`, {
    token: w1.token,
    body: { title: 'w1 私有调试笔记', content: '支付回调验签必须在沙箱环境先跑通再上线', importance: 0.8, dedupKey: 'rest:private-note' },
  })
  check('REST 写私有记忆 → 200', post1.status === 200 && post1.code === 0 && post1.data.scope === 'private')

  const share1 = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories`, {
    token: w1.token,
    body: { title: '支付网关接入规范', content: '所有支付代码统一 RSA2 签名,沙箱验证后上线', importance: 0.9, scope: 'shared', dedupKey: 'rest:pay-conv' },
  })
  check('REST 写公共记忆(scope=shared)→ 200', share1.status === 200 && share1.data.scope === 'shared')

  const teamList = await api('GET', `/channels/${channelId}/memories`, { token: w2.token })
  check('公共记忆入列(GET team memories,w2 可见)', teamList.code === 0 && teamList.data.some(r => r.title === '支付网关接入规范'),
    JSON.stringify(teamList.data?.map(r => r.title)))

  const w2shared = await search(w2.id, w2.token, { query: 'RSA2 签名 规范', scope: 'shared' })
  check('w2 动态检索到 w1 存的公共记忆', w2shared.code === 0 && w2shared.data.some(s => s.title === '支付网关接入规范' && s.source === 'shared'),
    JSON.stringify(w2shared.data?.map(s => s.title)))

  const w1priv = await search(w1.id, w1.token, { query: '调试 笔记 沙箱', scope: 'private' })
  const w2priv = await search(w2.id, w2.token, { query: '调试 笔记 沙箱', scope: 'private' })
  check('私有记忆本人可检索', w1priv.code === 0 && w1priv.data.some(s => s.title === 'w1 私有调试笔记'))
  check('私有记忆他人不可见(w2 域无 w1 笔记)', w2priv.code === 0 && !w2priv.data.some(s => s.title === 'w1 私有调试笔记'))

  // ── ⑥ 实时通讯(a2a/send 触发器 → 回执 → peer 记忆) ──
  console.log('\n=== ⑥ 实时通讯 ===')
  const sendRes = await api('POST', '/a2a/send', {
    token: w1.token,
    body: {
      toAgentId: w2.id,
      parts: [{ text: '支付网关的回调地址请统一用 /api/callback,处理完回我' }],
      metadata: { 'x-aw-require-reply': 'true' },
    },
  })
  check('a2a/send 触发器消息 → 200', sendRes.status === 200 && sendRes.code === 0, sendRes.data?.messageId?.slice(0, 8))

  const peerMem = await waitUntil(async () => {
    const r = await api('GET', `/channels/${channelId}/messages?limit=50`)
    const a = Array.isArray(r.data) ? r.data : []
    return a.some(m => String(m.metadata?.['x-aw-in-reply-to'] ?? '') === sendRes.data.messageId) ? a : null
  }, 15_000)
  check('w2 实时回执送达 mailbox(in_reply_to 关联)', !!peerMem)

  const peerRows = await waitUntil(async () => {
    const r1 = await memOf(w1.id, w1.token)
    const r2 = await memOf(w2.id, w2.token)
    return r1.some(x => x.kind === 'episodic-peer') && r2.some(x => x.kind === 'episodic-peer') ? [r1, r2] : null
  }, 15_000)
  const w1peer = peerRows?.[0].find(r => r.kind === 'episodic-peer')
  const w2peer = peerRows?.[1].find(r => r.kind === 'episodic-peer')
  check('双方 peer 记忆落库(协作沉淀)', !!w1peer && !!w2peer, `${w1peer?.title} / ${w2peer?.title}`)
  // 回执文本经 sendMessage(非 message 事件)→ 落在发送方收到回复一侧的记忆(w1 的 peer 记忆含 w2 回复)
  const peerContent = `${w1peer?.content ?? ''}${w2peer?.content ?? ''}`
  check('peer 记忆含问答关键动作(mock 回复)', peerContent.includes('mock 回复'), w1peer?.content.slice(0, 50))

  // ── ⑦ 新任务自动感知(增量记忆 + 检索命中) ──
  console.log('\n=== ⑦ 新相关任务自动感知 ===')
  await submit('支付网关重试机制', '为支付网关对接增加失败重试,遵循支付网关接入规范')
  const done2 = await waitUntil(async () => {
    const r = await api('GET', `/channels/${channelId}/tasks`, { token: lead.token })
    return r.data.find(t => t.title === '支付网关重试机制' && t.state === 'COMPLETED')
  }, 30_000)
  check('任务2(相关)闭环', !!done2)

  const tasks2 = (await api('GET', `/channels/${channelId}/tasks`, { token: lead.token })).data
  const child2 = tasks2.find(t => t.title === '支付网关重试机制' && t.parentId)
  const memRowsAfter = await waitUntil(async () => {
    const rows = await memOf(child2.assigneeId, lead.token)
    return rows.some(r => r.title === '支付网关重试机制') ? rows : null
  }, 10_000)
  check('任务2 执行记忆增量沉淀', !!memRowsAfter, memRowsAfter?.map(r => r.title).join(','))

  const sAfter = await search(child2.assigneeId, lead.token, { query: '支付网关 重试', scope: 'auto', limit: 10 })
  check('检索命中新旧任务记忆(自动感知积累)', sAfter.code === 0
  && sAfter.data.some(s => s.title === '支付网关重试机制')
  && sAfter.data.some(s => s.title === '实现支付网关对接' || s.title === '支付网关接入规范'),
  JSON.stringify(sAfter.data?.map(s => `${s.source}:${s.title}`)))

  // ── ⑧ 维护 / 隔离 / 清理 ──
  console.log('\n=== ⑧ 维护 + 隔离 + 清理 ===')
  const maint = await api('POST', '/memories/maintenance', { token: lead.token })
  check('POST maintenance(lead)→ 200', maint.status === 200 && maint.code === 0, JSON.stringify(maint.data))
  const maintDenied = await api('POST', '/memories/maintenance', { token: w1.token })
  check('maintenance(非 lead)→ 403', maintDenied.status === 403)

  const ch2 = await api('POST', '/channels', { body: { name: `rest-e2e-iso-${Date.now()}` } })
  const other = await api('POST', `/channels/${ch2.data.channelId}/agents`, { body: { name: 'iso-worker', harness: 'mock' } })
  const isoSearch = await api('POST', `/channels/${channelId}/agents/${w1.id}/memories/search`, {
    token: other.data.token, body: { query: '支付' },
  })
  check('跨 channel 检索 → 403 SCOPE_VIOLATION', isoSearch.status === 403 && isoSearch.code === 'SCOPE_VIOLATION')
  const isoTeam = await api('GET', `/channels/${channelId}/memories`, { token: other.data.token })
  check('跨 channel 读公共记忆 → 403', isoTeam.status === 403)

  const del2 = await api('DELETE', `/channels/${ch2.data.channelId}`)
  const del1 = await api('DELETE', `/channels/${channelId}`)
  check('清理测试 channel ×2', del2.code === 0 && del1.code === 0)

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exit(1)
})
