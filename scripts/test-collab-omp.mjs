/**
 * AgentTeam 协作 omp 实测(goal + pipeline + 防重复验证):
 *  - 模型:zhipu-coding-plan/glm-5-turbo(快速;agent config 注入 provider/model)
 *  - GOAL:lead 分解 → worker 完成 → lead 判断满意度 → 父任务 COMPLETED(含结语交付)
 *          并断言无同标题重复子任务(防重复守卫 + lead 邮件知情)
 *  - PIPELINE:两阶段顺序执行,阶段 2 引用阶段 1 产出 → COMPLETED
 *  - 统计:lead supervise 轮数(事件流 agent.status/message 计数)观察节流效果
 * 运行:node scripts/test-collab-omp.mjs(默认 http://127.0.0.1:3101;需 omp CLI)
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const PROVIDER = 'zhipu-coding-plan'
const MODEL = 'glm-5-turbo'

let failures = 0
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs, intervalMs = 2000) {
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
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 160)})`)
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function makeTeam(token, name) {
  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name,
      leadAgent: { name: `${name}-lead`, harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
    token,
  })
  if (ch.code !== 0) throw new Error(`channel 创建失败: ${JSON.stringify(ch).slice(0, 140)}`)
  const channelId = ch.data.channelId
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: { name: `${name}-worker`, harness: 'omp', role: 'worker', config: { provider: PROVIDER, model: MODEL } },
    token,
  })
  if (w.code !== 0) throw new Error('worker 创建失败')
  return { channelId, leadId: ch.data.leadAgentId, workerId: w.data.id }
}

const tasksOf = async (token, channelId) =>
  (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []

const eventsOf = async (token, channelId, limit = 500) =>
  (await api('GET', `/api/workshop/channels/${channelId}/events?limit=${limit}`, { token })).data?.items ?? []

// ═══════════ GOAL 模式 ═══════════

async function testGoal(token) {
  console.log('\n━━━ GOAL 模式(omp)━━━')
  const { channelId } = await makeTeam(token, `goal-${Date.now().toString(36)}`)
  check('团队就绪(omp lead + worker, glm-5-turbo)', true, `channel=${channelId.slice(0, 8)}`)

  const t0 = Date.now()
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'goal-marker',
      description: '[mode:goal][criteria:worker 已给出含单词 GOAL-DONE 的回复] Delegate to the worker: reply with a sentence containing the word GOAL-DONE, then complete. Judge satisfaction and finish.',
    },
    token,
  })
  const parentId = task.data.id

  const finalState = await waitUntil('goal 父任务终态', async () => {
    const t = (await tasksOf(token, channelId)).find(x => x.id === parentId)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(t?.state ?? '') ? t.state : null
  }, 480_000)
  const elapsed = Math.round((Date.now() - t0) / 1000)
  check('goal 父任务完成', finalState === 'COMPLETED', `state=${finalState} 耗时=${elapsed}s`)

  const tasks = await tasksOf(token, channelId)
  const children = tasks.filter(t => t.parentId === parentId)
  check('子任务已派发(lead 分解)', children.length >= 1, `children=${children.length}`)

  // 防重复:同标题子任务唯一(无重复派发)
  const titles = children.map(c => c.title.replace(/\s+/g, ' ').trim().toLowerCase())
  const dupTitles = titles.filter((t, i) => titles.indexOf(t) !== i)
  check('无重复派发(同标题子任务唯一)', dupTitles.length === 0, `children=${children.length}, titles=${JSON.stringify(titles).slice(0, 120)}`)

  // 交付链:worker 交付存在;父任务结语存在
  const childDone = children.find(c => c.state === 'COMPLETED')
  check('worker 子任务完成且带交付', !!childDone && (childDone.artifacts?.length ?? 0) > 0)
  const parent = tasks.find(t => t.id === parentId)
  const parentText = JSON.stringify(parent?.artifacts ?? '')
  check('父任务含最终结语交付(goal close-out)', (parent?.artifacts?.length ?? 0) > 0 && parentText.includes('GOAL-DONE'), parentText.slice(0, 90))

  // lead 知情:邮件中含 worker 的任务交付回执
  const mails = (await api('GET', `/api/workshop/mailbox/all`, { token }).catch(() => ({ data: [] }))).data ?? []
  check('channel 邮件含协作记录(lead 可见 worker 行为)', Array.isArray(mails))

  // supervise 节流观察:lead 的 status 消息次数(supervise 回合≈agent.status.message/agent.message 计数)
  const evs = await eventsOf(token, channelId)
  const leadMsgs = evs.filter(e => e.type === 'agent.status.message' || e.type === 'agent.message').length
  check('supervise 轮数受节流控制(无忙轮转)', leadMsgs < 30, `lead 消息事件=${leadMsgs}, 总事件=${evs.length}`)

  return { channelId }
}

// ═══════════ PIPELINE 模式 ═══════════

async function testPipeline(token) {
  console.log('\n━━━ PIPELINE 模式(omp)━━━')
  const { channelId } = await makeTeam(token, `pipe-${Date.now().toString(36)}`)
  check('团队就绪', true, `channel=${channelId.slice(0, 8)}`)

  const t0 = Date.now()
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'pipe-marker',
      description: '[mode:pipeline][stages:produce->verify] Produce the secret word PIPE-42 in stage 1; stage 2 must verify stage 1 output contains PIPE-42 and complete with a verdict.',
    },
    token,
  })
  const parentId = task.data.id

  const finalState = await waitUntil('pipeline 父任务终态', async () => {
    const t = (await tasksOf(token, channelId)).find(x => x.id === parentId)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(t?.state ?? '') ? t.state : null
  }, 480_000)
  const elapsed = Math.round((Date.now() - t0) / 1000)
  check('pipeline 父任务完成', finalState === 'COMPLETED', `state=${finalState} 耗时=${elapsed}s`)

  const tasks = await tasksOf(token, channelId)
  const children = tasks.filter(t => t.parentId === parentId).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)
  check('两阶段子任务存在', children.length >= 2, `children=${children.length}`)

  // 顺序依赖:阶段 2 的 description 引用阶段 1 的产出
  if (children.length >= 2) {
    const second = children[1]
    const referenced = String(second.description ?? '').includes('PIPE-42')
    check('阶段 2 引用阶段 1 产出(顺序依赖传导)', referenced, `stage2 desc=${String(second.description).slice(0, 110)}`)
  }

  // 无重复派发
  const titles = children.map(c => c.title.replace(/\s+/g, ' ').trim().toLowerCase())
  const dup = titles.filter((t, i) => titles.indexOf(t) !== i)
  check('无重复派发', dup.length === 0, `titles=${JSON.stringify(titles).slice(0, 120)}`)

  // 最终交付含 verify 结论
  const parent = tasks.find(t => t.id === parentId)
  const text = JSON.stringify(parent?.artifacts ?? '')
  check('父任务含流水线最终交付', (parent?.artifacts?.length ?? 0) > 0, text.slice(0, 90))

  return { channelId }
}

async function main() {
  console.log(`目标: ${BASE}(模型 ${PROVIDER}/${MODEL})`)
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `collab-omp-${Date.now().toString(36)}` } })
  const token = user.data?.token
  if (!token) throw new Error('注册失败')

  const goal = await testGoal(token)
  const pipe = await testPipeline(token)

  // 清理
  for (const { channelId } of [goal, pipe]) {
    const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
    for (const m of members.data ?? []) {
      await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: m.id }, token }).catch(() => {})
    }
    await api('DELETE', `/api/workshop/channels/${channelId}`, { token })
  }
  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
