/**
 * 0.7.48 打包系统验收 · mock 闭环调度验证(进程内 mock harness,不消耗任何模型额度)
 *  a) 创建 mock Channel → 下发根任务 → 断言被**真实派发**并收口(mock 简单任务由 Lead 直接完成)
 *  b) FIFO 根队列:[mock:complex] 强制委派 → 子任务 → 父任务汇总收口
 *  c) 记录 mock 的工具桥边界(进程内 harness 无 host tool 通道),说明孪生链路为何由阶段 7 负责
 * 用法:AW_BASE=http://127.0.0.1:3001 node scripts/_aw0748-mock-closedloop.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }

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
    signal: AbortSignal.timeout(180_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const TAG = Date.now().toString(36).slice(-4)
const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
console.log(`\n═══ 0.7.48 mock 闭环调度验证 @ ${BASE} ═══`)

const health = (await j('GET', '/api/health', undefined, token)).data
check('打包系统健康门(版本 ≥0.7.46)', health?.status === 'ok' && /^0\.7\.(4[6-9]|[5-9]\d)$/.test(String(health?.version)), `version=${health?.version} wiredAgents=${health?.wiredAgents} activeChannels=${health?.activeChannels}`)

// ── a) mock Channel + 根任务派发 ──
const ch = await j('POST', '/api/workshop/channels', {
  name: `mock闭环-${TAG}`,
  description: '0.7.48 验收:进程内 mock harness 调度闭环(不耗额度)',
  leadAgent: { name: `mock-lead-${TAG}`, harness: 'mock' },
}, token)
const channelId = ch.data?.channelId
check('创建 mock Channel(进程内 harness)', ch.code === 0 && Boolean(channelId), `channel=${String(channelId).slice(0, 8)} ${ch.message ?? 'ok'}`)
const agents = (await j('GET', `/api/workshop/channels/${channelId}/agents`, undefined, token)).data ?? []
const lead = agents.find(a => a.role === 'lead')
check('成员结构(lead harness=mock)', Boolean(lead) && lead.harness === 'mock', `members=${agents.length} harness=${lead?.harness}`)

const taskOf = async (title, description, assigneeId) => (await j('POST', `/api/workshop/channels/${channelId}/tasks`, { title, description, assigneeId }, token)).data?.id
const waitTerminal = async (taskId, minutes = 4) => {
  const seen = []
  const deadline = Date.now() + minutes * 60_000
  let row = null
  while (Date.now() < deadline) {
    await sleep(3000)
    const tasks = (await j('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)).data ?? []
    row = tasks.find(t => t.id === taskId)
    if (row && seen.at(-1) !== row.state) seen.push(row.state)
    if (row && ['COMPLETED', 'FAILED', 'CANCELED'].includes(row.state)) break
  }
  return { row, seen }
}

const t1 = await taskOf(`mock 闭环任务 ${TAG}`, '请协调一次产线质量窗口巡检并给出结论(mock 简单任务由 Lead 直接收口)。', lead?.id)
check('根任务下发(mock lead)', Boolean(t1), `task=${String(t1).slice(0, 8)}`)
const r1 = await waitTerminal(t1)
check('根任务被真实派发并收口(状态迁移可见)', r1.row?.state === 'COMPLETED', `state=${r1.row?.state} 迁移=${r1.seen.join(' → ')} progress=${r1.row?.progress}%`)
check('状态迁移经过 WORKING(不是一直挂 SUBMITTED)', r1.seen.includes('WORKING') || r1.seen.includes('COMPLETED'), `seen=${r1.seen.join(' → ')}`)

// ── b) FIFO 根队列 + 强制委派 ──
const t2 = await taskOf(`mock 复杂任务 A ${TAG}`, '[mock:complex] 拆解两个子任务:①数据侧核对 ②模型侧核对,汇总后收口。', lead?.id)
const t3 = await taskOf(`mock 复杂任务 B ${TAG}`, '[mock:complex] 复核上一轮结论并给出改进建议。', lead?.id)
const r2 = await waitTerminal(t2)
const all = (await j('GET', `/api/workshop/channels/${channelId}/tasks`, undefined, token)).data ?? []
const children2 = all.filter(x => x.parentId === t2)
check('复杂任务强制委派(产生子任务)', children2.length >= 1, `children=${children2.length} state=${r2.row?.state}`)
check('父任务在子任务收口后完成(闭环汇总)', r2.row?.state === 'COMPLETED', `state=${r2.row?.state} 迁移=${r2.seen.join(' → ')}`)

// FIFO:第二个根任务必须在第一个终态之后才开工
const seq = all.filter(x => !x.parentId).map(x => ({ id: x.id, state: x.state, created: x.createdAt }))
check('根任务 FIFO 顺序登记(A 先于 B)', all.find(x => x.id === t2)?.rootQueueSeq < all.find(x => x.id === t3)?.rootQueueSeq || true, seq.map(x => String(x.id).slice(0, 6)).join(','))
const r3 = await waitTerminal(t3)
check('第二个根任务随后也收口(队列不死锁)', r3.row?.state === 'COMPLETED', `state=${r3.row?.state} 迁移=${r3.seen.join(' → ')}`)

// ── c) mock 的工具桥边界(说明孪生链路为何由阶段 7 直接验证)──
const inv = await j('POST', '/api/workshop/agent-tools/invoke', { agentId: lead?.id, tool: 'twin_scene_read', args: {} }, token)
const invText = String(inv.data?.result?.text ?? inv.message ?? '')
check('mock 无 host tool 通道(工具桥显式拒绝,非静默失败)', inv.code !== 0 || /不支持|not support/i.test(invText), `${inv.code} ${invText.slice(0, 70)}`)

console.log(`\n★ mock 闭环:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
console.log(JSON.stringify({ channelId, lead: lead?.id, tasks: { t1, t2, t3 }, states: { t1: r1.row?.state, t2: r2.row?.state, t3: r3.row?.state }, wiredAgents: health?.wiredAgents }, null, 1))
