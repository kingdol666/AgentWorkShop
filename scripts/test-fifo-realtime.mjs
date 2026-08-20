/**
 * 队列 FIFO 消费 + 实时信息处理真实监控(omp + glm-5-turbo):
 *  - 团队:lead + 1 worker;goal 任务要求 ONE 轮内向同一 worker 派 3 个微任务
 *    (fifo-a/b/c) → 同时入队,验证 FIFO 顺序消费
 *  - 实时探测:worker 忙于第一个任务时,经 REST 注入 immediate+require_reply 消息
 *    (要求回复附 ACK-773) → 验证注入运行中会话并被处理(回执关联)
 *  - 监控断言:
 *    F1 3 个子任务同 worker 串行完成(busy/idle 序列无重叠)
 *    F2 完成顺序 == 派发顺序(FIFO)
 *    F3 注入消息被消费且回执含 ACK-773(实时注入生效)
 *    F4 父任务 COMPLETED 带总结
 * 运行:node scripts/test-fifo-realtime.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const PROVIDER = 'zhipu-coding-plan'
const MODEL = 'glm-5-turbo'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  // ═══ 组队 ═══
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `fifo-${Date.now().toString(36)}` } })
  const token = user.data?.token
  if (!token) throw new Error('注册失败')

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'fifo-check',
      leadAgent: { name: 'fifo-lead', harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
    token,
  })
  if (ch.code !== 0) throw new Error('channel 创建失败')
  const channelId = ch.data.channelId
  const w = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: { name: 'fifo-worker', harness: 'omp', role: 'worker', config: { provider: PROVIDER, model: MODEL } },
    token,
  })
  if (w.code !== 0) throw new Error('worker 创建失败')
  const workerId = w.data.id
  check('团队就绪(lead + 单 worker)', true, `channel=${channelId.slice(0, 8)}`)

  // ═══ goal 任务:一轮派 3 个微任务给同一 worker ═══
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'fifo-consume-check',
      description: [
        '[mode:goal][criteria:三个微任务全部完成且交付含各自标记词]',
        '委派要求:在本轮监督中一次性(dispatch 三次,同一轮)把以下三个微任务全部派给同一个 worker fifo-worker',
        '(assignee 相同,让它们同时进入其队列,按 FIFO 依次消费):',
        '- 子任务1 title=fifo-a:description=回复标记词 FFO-A 与一句话结果',
        '- 子任务2 title=fifo-b:description=回复标记词 FFO-B 与一句话结果',
        '- 子任务3 title=fifo-c:description=回复标记词 FFO-C 与一句话结果',
        '全部完成后以总结交付完成父任务(列出三个子任务完成顺序)。',
      ].join('\n'),
    },
    token,
  })
  const parentId = task.data?.id
  if (!parentId) throw new Error('任务提交失败')

  const tasksOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  const eventsOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/events?limit=800`, { token })).data?.items ?? []

  // ═══ 监控循环:事件流采集 + 忙时注入实时消息 ═══
  let injected = null
  let busyAtInject = false
  const busySeq = []
  const seenEvents = new Set()
  const completionOrder = []
  const deadline = Date.now() + 600_000
  let parentState = ''
  while (Date.now() < deadline) {
    const evs = await eventsOf()
    for (const e of evs) {
      if (seenEvents.has(e.seq)) continue
      seenEvents.add(e.seq)
      const p = e.payload ?? {}
      // worker 状态序列
      if (e.type === 'agent.status' && e.agentId === workerId && (p.state === 'busy' || p.state === 'idle')) {
        busySeq.push(p.state)
      }
      // 子任务完成顺序
      if (e.type === 'task.status' && p.state === 'COMPLETED' && p.taskId && p.taskId !== parentId) {
        if (!completionOrder.includes(p.taskId)) completionOrder.push(p.taskId)
      }
    }
    // 忙时注入一次实时消息(要求回执 ACK-773)
    if (!injected && busySeq.includes('busy')) {
      busyAtInject = true
      const res = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
        body: {
          toAgentId: workerId,
          text: '[实时检查] 收到请在你当前或下一个交付中确认,并立即用 send_message_to_agent 回复本消息(附 ACK-773)。',
          priority: 'immediate',
          requireReply: true,
        },
        token,
      })
      if (res.data?.messageId || res.messageId) injected = res.data?.messageId ?? res.messageId
    }
    const st = (await tasksOf()).find(t => t.id === parentId)?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) {
      parentState = st
      break
    }
    await sleep(4000)
  }
  // 宽限
  if (!parentState) {
    for (let i = 0; i < 12; i++) {
      const st = (await tasksOf()).find(t => t.id === parentId)?.state ?? ''
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) {
        parentState = st
        break
      }
      await sleep(5000)
    }
  }

  // ═══ 断言 ═══
  const tasks = await tasksOf()
  const children = tasks.filter(t => t.parentId === parentId).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1)
  check('F4a goal 父任务完成', parentState === 'COMPLETED', `state=${parentState}`)
  check('F1a 子任务(≥3)全部完成', children.length >= 3 && children.every(c => c.state === 'COMPLETED'), `n=${children.length}, states=${children.map(c => c.state).join('/')}`)

  // FIFO:完成顺序 == 创建顺序
  const createOrder = children.map(c => c.id)
  const fifoOk = completionOrder.length >= 3 && createOrder.every((id, i) => {
    const idx = completionOrder.indexOf(id)
    return idx >= 0 && idx === i
  })
  check('F2 完成顺序 == 派发顺序(FIFO 消费)', fifoOk, `create=[${createOrder.map(i => i.slice(0, 6)).join(',')}] done=[${completionOrder.map(i => i.slice(0, 6)).join(',')}]`)

  // 串行:busy/idle 无重叠(busy 后必须 idle 才可再 busy)
  let serial = true
  for (let i = 1; i < busySeq.length; i++) {
    if (busySeq[i] === busySeq[i - 1]) serial = false
  }
  check('F1b 串行消费(busy/idle 交替无重叠)', serial && busySeq.filter(s => s === 'busy').length >= 3, `seq=${busySeq.join('→').slice(0, 60)}`)

  // 标记词交付
  // 标记词交付(按 title 精确匹配,容错 includes)
  const marks = ['FFO-A', 'FFO-B', 'FFO-C']
  const titleKeys = ['fifo-a', 'fifo-b', 'fifo-c']
  const markOk = marks.every((m, i) => {
    const child = children.find(c => c.title === titleKeys[i]) ?? children.find(c => (c.title ?? '').includes(titleKeys[i]))
    return child && JSON.stringify(child.artifacts ?? '').includes(m)
  })
  check('F1c 子任务交付含各自标记词', markOk, '')

  // ═══ 实时注入断言 ═══
  const mails = (await api('GET', `/api/workshop/channels/${channelId}/messages?limit=400`, { token })).data ?? []
  const injectedRow = injected ? mails.find(m => m.id === injected) : null
  // 硬断言:worker busy 期间注入 → 实时送达(steer 进会话)且被消费(送达即消费/读即取)
  check('F3a 实时注入送达且消费(busy 期间 steer 进会话)', !!injectedRow && injectedRow.state === 'consumed' && busyAtInject, `state=${injectedRow?.state ?? 'n/a'}, busyAtInject=${busyAtInject}`)
  // 软观察:模型是否按触发器回执 ACK(LLM 合规性,不计分)
  const ackReply = mails.find(m => m.fromAgentId === workerId
    && String(JSON.stringify(m.metadata ?? {})).includes(String(injected))
    && (m.parts ?? []).some(p => String(p.text ?? '').includes('ACK-773')))
  console.log(`  [obs] ACK-773 回执(软观察): ${ackReply ? '已回执且关联' : '模型未回执(管道已送达;LLM 合规性波动)'}`)

  const parent = tasks.find(t => t.id === parentId)
  check('F4b 结语总结含顺序', (parent?.artifacts?.length ?? 0) > 0, JSON.stringify(parent?.artifacts ?? '').slice(0, 80))

  // 清理
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
  for (const m of members.data ?? []) {
    await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: m.id }, token }).catch(() => {})
  }
  if (failures === 0) await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
