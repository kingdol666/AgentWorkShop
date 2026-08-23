/**
 * Lane 历史加载端到端验证(针对 pnpm dev 起的 3000 服务):
 *  1. 注册用户 → 建 channel(mock lead)→ goal 任务跑完(产生 agent.status/
 *     agent.message/a2a.message/task.status 等真实事件,常驻录制器落库);
 *  2. GET /channels/:id/events 全量历史:信封形状 + 消息在场;
 *  3. ?agentId=&excludeTypes=agent.delta:lane 按需加载口径(仅该 agent、无过程帧);
 *  4. beforeSeq 翻页 + total 同口径;
 *  5. 清理测试 channel。
 * 运行: node scripts/test-lane-history-live.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function api(method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const waitUntil = async (name, probe, timeoutMs = 20_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await probe()
    if (v) return v
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`等待超时: ${name}`)
}

const tag = Math.random().toString(36).slice(2, 8)
const user = await api('POST', '/api/workshop/users/register', { body: { name: `lane-hist-${tag}` } })
if (!user.data?.token) {
  console.error('用户注册失败:', user)
  process.exit(1)
}
const token = user.data.token
console.log(`用户 lane-hist-${tag} 就绪`)

const ch = await api('POST', '/api/workshop/channels', {
  token,
  body: {
    name: `lane-history-${tag}`,
    leadAgent: { name: 'lead-mock', harness: 'mock', config: { delayMs: 60 } },
  },
})
check('创建 channel(含 mock lead)', ch.code === 0 && ch.data?.channelId, `channel=${ch.data?.channelId?.slice(0, 8)}`)
const channelId = ch.data.channelId
const leadId = ch.data.leadAgentId

try {
  await api('POST', `/api/workshop/channels/${channelId}/activate`, { token })
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    token,
    body: { title: `lane-history-${tag}`, description: '验证历史持久化与按 agent 加载', mode: 'goal', modeConfig: { goalCriteria: '全部完成' } },
  })
  check('提交 goal 任务', task.code === 0 && task.data?.state === 'SUBMITTED', `state=${task.data?.state}`)
  // 任务执行到 WORKING 即已产生足够事件(录制器落库);不依赖终态(与历史加载验证正交)
  const enough = await waitUntil('事件落库', async () => {
    const e = await api('GET', `/api/workshop/channels/${channelId}/events?limit=500`, { token })
    return (e.data?.items ?? []).length >= 4 ? e.data.items : null
  })
  check('事件已持久化(WORKING 阶段)', enough.length >= 4, `events=${enough.length}`)
  const items = enough

  // ── 1. 全量历史(items 已在上方取到)──
  const shapeOk = items.every(e => e.v === 1 && typeof e.seq === 'number' && e.type && e.at && e.channelId === channelId)
  check('AEP 信封同构形状', shapeOk)
  check('事件类型覆盖(消息+状态+任务)', ['a2a.message', 'agent.status', 'task.status'].every(t => items.some(e => e.type === t)),
    [...new Set(items.map(e => e.type))].join(','))

  // ── 2. lane 口径:agentId + excludeTypes ──
  const lane = await api('GET', `/api/workshop/channels/${channelId}/events?agentId=${leadId}&excludeTypes=agent.delta&limit=100`, { token })
  const laneItems = lane.data?.items ?? []
  check('agentId 过滤仅返回该 agent', laneItems.length > 0 && laneItems.every(e => e.agentId === leadId), `items=${laneItems.length}`)
  check('excludeTypes 剔除过程帧', laneItems.every(e => e.type !== 'agent.delta'))
  check('lane 历史含该 agent 事件', laneItems.some(e => e.type === 'agent.status' || e.type === 'task.status' || e.type === 'a2a.message'),
    `types=${[...new Set(laneItems.map(e => e.type))].join(',')}`)
  check('total 与过滤同口径', lane.data?.total === laneItems.length, `total=${lane.data?.total} items=${laneItems.length}`)

  // ── 3. beforeSeq 翻页(lane 维度) ──
  const midSeq = laneItems[Math.floor(laneItems.length / 2)]?.seq
  const page = await api('GET', `/api/workshop/channels/${channelId}/events?agentId=${leadId}&excludeTypes=agent.delta&beforeSeq=${midSeq}&limit=100`, { token })
  const pageItems = page.data?.items ?? []
  check('beforeSeq 翻页全部早于游标', pageItems.length > 0 && pageItems.every(e => e.seq < midSeq && e.agentId === leadId),
    `items=${pageItems.length} < seq${midSeq}`)

  // ── 4. 鉴权:无 token 拒绝 ──
  const noAuth = await api('GET', `/api/workshop/channels/${channelId}/events`)
  check('无 token 401', noAuth.status === 401, `status=${noAuth.status}`)
}
finally {
  const del = await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  console.log(`清理测试 channel:${del.code === 0 ? '已删除' : `失败(${del.code})`}`)
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
process.exit(failures === 0 ? 0 : 1)
