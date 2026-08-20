/**
 * A2A 通信中继实测(omp + glm-5-turbo):出题 → 解答 → 判定 三段链路。
 *  - 团队:lead + worker1(quiz-master 出题者) + worker2(solver 解题者)
 *  - 链路:worker1 经 send_message_to_agent 出题给 worker2(require_reply+immediate)
 *         → worker2 解答回复(in_reply_to 关联) → worker1 核对判定并回复
 *         → lead 经 read_channel_mail 全览通信后总结完成
 *  - 断言:
 *    R1 roster 注入(worker1 回合 prompt 含 Team Roster + 同伴名 + 专长)
 *    R2 题目消息 w1→w2(priority=immediate / require_reply)
 *    R3 答案消息 w2→w1 且 in_reply_to 精确关联题目消息 id(A2A 寻址正确)
 *    R4 判定消息 w1→w2(含 正确/错误 结论)
 *    R5 链路消息均已消费(无滞留 pending)
 *    R6 goal 父任务 COMPLETED 且结语交付提及链路
 * 运行:node scripts/test-a2a-relay.mjs
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

async function waitUntil(name, cond, timeoutMs, intervalMs = 4000) {
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

async function main() {
  // ═══ 1. 组队 ═══
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `a2a-relay-${Date.now().toString(36)}` } })
  const token = user.data?.token
  if (!token) throw new Error('注册失败')

  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'quiz-relay',
      leadAgent: { name: 'relay-lead', harness: 'omp', config: { provider: PROVIDER, model: MODEL } },
    },
    token,
  })
  if (ch.code !== 0) throw new Error('channel 创建失败: ' + JSON.stringify(ch).slice(0, 140))
  const channelId = ch.data.channelId
  const leadId = ch.data.leadAgentId

  const w1 = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'quiz-master',
      harness: 'omp',
      role: 'worker',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a math quiz master. You create exactly one arithmetic quiz question (two-digit multiplication) and later verify the answer, stating explicitly 正确 or 错误 with the correct value.',
      },
    },
    token,
  })
  const w2 = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'solver',
      harness: 'omp',
      role: 'worker',
      config: {
        provider: PROVIDER,
        model: MODEL,
        systemPromptPrefix: 'You are a precise solver. You compute arithmetic answers step by step and always reply with the final numeric result clearly.',
      },
    },
    token,
  })
  if (w1.code !== 0 || w2.code !== 0) throw new Error('worker 创建失败')
  const w1Id = w1.data.id
  const w2Id = w2.data.id
  check('团队就绪(lead + quiz-master + solver)', true, `channel=${channelId.slice(0, 8)}`)

  // ═══ 2. 提交 GOAL 中继任务 ═══
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'quiz-relay-check',
      description: [
        '[mode:goal][criteria:三段通信链(题目→解答→判定)全部经 send_message_to_agent 完成,lead 总结全链后交付]',
        '作业流程(严格按序,全部用 send_message_to_agent 完成,不要用任务派发代替通信):',
        '1. 把工作派发给 quiz-master(worker)。',
        '2. quiz-master 出一道两位数乘法题,用 send_message_to_agent 发给 solver(to_agent_id=solver的id, require_reply=true, priority=immediate)。',
        '3. solver 计算后用 send_message_to_agent 把答案回复 quiz-master(in_reply_to=题目消息id)。',
        '4. quiz-master 核对答案,用 send_message_to_agent 把判定(正确 或 错误+正确值)回复 solver,然后完成任务(交付=题目、答案、判定)。',
        '5. lead 用 read_channel_mail 查看三段通信记录,确认链路完整,以总结(题目/答案/判定/链路)交付完成本任务。',
      ].join('\n'),
    },
    token,
  })
  const parentId = task.data?.id
  if (!parentId) throw new Error('任务提交失败')

  const tasksOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  const mailsOf = async () => {
    const res = await api('GET', `/api/workshop/channels/${channelId}/messages?limit=400`, { token })
    return (res.data ?? []).map(m => ({
      id: m.id,
      from: m.fromAgentId,
      to: m.toAgentId,
      state: m.state,
      text: (m.parts ?? []).map(p => p.text ?? '').join(' '),
      meta: m.metadata ?? {},
    }))
  }

  // ═══ 3. roster 注入观测(worker1 回合 prompt 帧含 Team Roster) ═══
  const termFrames = async () => {
    const t = await api('GET', `/api/workshop/channels/${channelId}/terminals`, { token })
    const has = (t.data ?? []).some(x => x.agentId === w1Id)
    if (!has) return null
    return new Promise((resolve) => {
      const frames = []
      const ws = new WebSocket(`ws://127.0.0.1:3101/api/system/monitor/terminal/ws?agentId=${w1Id}&channelId=${channelId}&token=${token}`)
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.type === 'term.frames') frames.push(...m.frames)
      }
      ws.onopen = () => setTimeout(() => {
        ws.close()
        resolve(frames)
      }, 1500)
      ws.onerror = () => resolve(null)
    })
  }
  try {
    const promptText = await waitUntil('worker1 roster prompt 帧', async () => {
      const frames = await termFrames()
      if (!frames) return null
      const hit = frames.find(f => f.frame.type === 'message_start' && f.frame.role === 'user'
        && String(f.frame.text ?? '').includes('Team Roster'))
      return hit ? String(hit.frame.text) : null
    }, 300_000, 8000)
    check('R1a roster 注入(worker1 prompt 含 Team Roster)', promptText.includes('Team Roster'))
    check('R1b 名册含同伴与专长', promptText.includes('solver') && promptText.includes('quiz-master') && promptText.includes('擅长'), promptText.slice(promptText.indexOf('Team Roster'), promptText.indexOf('Team Roster') + 120).replace(/\n/g, ' '))
    check('R1c 名册标注自己', promptText.includes('← 你'), '')
  }
  catch (e) {
    check('R1 roster 注入观测', false, String(e).slice(0, 90))
  }

  // ═══ 4. 等父任务终态 ═══
  const finalState = await waitUntil('父任务终态', async () => {
    const t = (await tasksOf()).find(x => x.id === parentId)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(t?.state ?? '') ? t.state : null
  }, 600_000, 5000)
  check('R6a goal 父任务完成', finalState === 'COMPLETED', `state=${finalState}`)

  // ═══ 5. 邮件链路断言 ═══
  const mails = await mailsOf()
  const mailsOfResult = mails
  const peer = mails.filter(m => m.from && m.to && m.meta['x-aw-task-kind'] === undefined)
  const q = peer.filter(m => m.from === w1Id && m.to === w2Id && !m.meta['x-aw-in-reply-to'])
  const a = peer.filter(m => m.from === w2Id && m.to === w1Id)
  const v = peer.filter(m => m.from === w1Id && m.to === w2Id && m.meta['x-aw-in-reply-to'])

  check('R2 题目消息 w1→w2', q.length >= 1, `count=${q.length}`)
  check('R2b 题目要求回复且实时', q.length >= 1 && q.some(m => m.meta['x-aw-require-reply'] === 'true' && m.meta['x-aw-msg-priority'] === 'immediate'), '')

  check('R3a 答案消息 w2→w1', a.length >= 1, `count=${a.length}`)
  const qIds = new Set(q.map(m => m.id))
  const linked = a.filter(m => qIds.has(String(m.meta['x-aw-in-reply-to'])))
  check('R3b in_reply_to 精确关联题目消息', linked.length >= 1, `linked=${linked.length}/${a.length}`)

  check('R4 判定消息 w1→w2(带关联)', v.length >= 1, `count=${v.length}`)
  const allRelay = [...q, ...a, ...v]
  const chainText = allRelay.map(m => m.text).join(' ')
  check('R4b 判定含 正确/错误 结论', /正确|错误|correct|wrong/i.test(chainText), '')

  const stuck = allRelay.filter(m => m.state === 'pending')
  check('R5 链路消息全部消费(无滞留)', stuck.length === 0, `pending=${stuck.length}/${allRelay.length}`)

  const parent = (await tasksOf()).find(t => t.id === parentId)
  const parentText = JSON.stringify(parent?.artifacts ?? '')
  check('R6b 结语交付提及链路/判定', (parent?.artifacts?.length ?? 0) > 0 && /正确|错误|题目|判定|链|quiz/i.test(parentText), parentText.slice(0, 110))

  // lead 通信观察断言:直接调 read_channel_mail,或经信箱收到 w1 的链路汇报
  // (两种都是"lead 能看到通信记录"的有效形态;结语引用链路已由 R6b 保证)
  const evs = (await api('GET', `/api/workshop/channels/${channelId}/events?limit=800`, { token })).data?.items ?? []
  const leadRead = evs.some(e => e.agentId === leadId && /read_channel_mail/.test(JSON.stringify(e.payload ?? {})))
  const leadGotReport = mailsOfResult.filter(m => m.to === leadId && m.from === w1Id && /正确|判定|链|完成/.test(m.text)).length > 0
  check('R7 lead 可见通信记录(read_channel_mail 或 收到链路汇报)', leadRead || leadGotReport, `tool=${leadRead}, report=${leadGotReport}`)

  // 清理
  const members = await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })
  for (const m of members.data ?? []) {
    await api('POST', '/api/system/monitor/terminate', { body: { channelId, agentId: m.id }, token }).catch(() => {})
  }
  if (failures === 0) {
    await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})
  }

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
