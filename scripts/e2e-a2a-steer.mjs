/**
 * A2A 点对点通信 + omp 进程内即时注入 端到端真实测试(生产服务器 + 真实 omp 子进程)。
 *
 * 流程:
 *  1. 建 channel(omp lead + omp worker)+ 提交长任务(worker 执行中)
 *  2. 等 worker busy(WORKING)
 *  3. immediate 消息注入:POST /channels/:id/messages {priority:'immediate'}
 *     → busy → AgentRuntime.injectSteer → OmpRpcAgentImpl.steer → omp rpc 'steer' 帧
 *     注入运行中 omp 会话,不打断任务
 *  4. 轮询:任务最终 COMPLETED(注入未中断执行)+ mailbox 出现 worker 回执
 *  5. 报告时间线
 *
 * 用法: node scripts/e2e-a2a-steer.mjs [--base http://127.0.0.1:3001]
 */
const BASE = (process.argv.find(a => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3001') + '/api/workshop'

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass++
  else fail++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function waitUntil(pred, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await pred()
    if (v) return v
    await sleep(everyMs)
  }
  return null
}

async function main() {
  console.log('━━━ 1. 搭建 omp 真实 channel(1 lead + 1 worker)━━━')
  // omp 模板:config.cwd 指 channel workspace;harness='omp' 由 factory 起真实子进程
  const leadTpl = await req('POST', '/agents', { name: 'a2a-lead', harness: 'omp' })
  const workerTpl = await req('POST', '/agents', { name: 'a2a-worker', harness: 'omp' })
  const ch = await req('POST', '/channels', { name: 'a2a-steer-e2e', description: 'A2A steer e2e' })
  const channelId = ch.json.data.channelId
  check('创建 channel', !!channelId, `channel=${channelId.slice(0, 8)}…`)
  const lead = await req('POST', `/channels/${channelId}/agents`, { agentId: leadTpl.json.data.id, role: 'lead' })
  const worker = await req('POST', `/channels/${channelId}/agents`, { agentId: workerTpl.json.data.id, role: 'worker' })
  const LEAD_ID = lead.json.data.id
  const WORKER_ID = worker.json.data.id
  check('部署 omp lead + worker', !!LEAD_ID && !!WORKER_ID, `lead=${LEAD_ID.slice(0, 8)}… worker=${WORKER_ID.slice(0, 8)}…`)
  const cleanupIds = { channelId, agentIds: [leadTpl.json.data.id, workerTpl.json.data.id] }

  console.log('━━━ 2. 提交长任务 → 等 worker WORKING(busy)━━━')
  // 长任务:要求多步工作,给 steer 注入留出执行窗口
  const taskResp = await req('POST', `/channels/${channelId}/tasks`, {
    title: '编写并验证一个 Node 脚本',
    description: '在当前工作目录创建 compute.js:实现 fib(n) 记忆化函数,写 3 个测试用例断言 fib(10)=55、fib(20)=6765、fib(30)=832040,用 node 执行测试并输出结果。完成后报告文件路径与测试输出。',
  })
  const taskId = taskResp.json.data.id
  check('提交任务', !!taskId, `task=${taskId.slice(0, 8)}…`)

  // 找到 worker 的子任务并等它 WORKING
  const childTask = await waitUntil(async () => {
    const { json } = await req('GET', `/channels/${channelId}/tasks`)
    const child = (json.data ?? []).find(t => t.assigneeId === WORKER_ID && t.parentId === taskId)
    return child && child.state === 'WORKING' ? child : null
  }, 60_000)
  check('worker 子任务进入 WORKING(omp 进程执行中)', !!childTask, childTask ? `child=${childTask.id.slice(0, 8)}…` : 'timeout')

  // 确认 worker 运行时 busy
  const q1 = await req('GET', `/channels/${channelId}/queue`)
  const wStat = (q1.json.data ?? []).find(a => a.id === WORKER_ID)
  check('worker 状态 busy', wStat?.state === 'busy', `state=${wStat?.state}`)
  console.log(`  [${ts()}] worker busy,currentTask=${wStat?.currentTaskId?.slice(0, 8) ?? '-'}`)

  console.log('━━━ 3. A2A 即时注入(priority=immediate)━━━')
  const steerStart = Date.now()
  const injectResp = await req('POST', `/channels/${channelId}/messages`, {
    toAgentId: WORKER_ID,
    fromAgentId: LEAD_ID,
    text: '进度确认:请在完成当前工作后,额外在最终报告里注明 fib(10) 的值。继续当前任务,不要中断。',
    priority: 'immediate',
    requireReply: true,
  })
  const injectMs = Date.now() - steerStart
  check('immediate 注入 API 即时响应', injectResp.json?.code === 0 && injectMs < 2000, `${injectMs}ms(非阻塞投递)`)
  console.log(`  [${ts()}] 注入完成,API 耗时 ${injectMs}ms`)

  // 注入后 worker 仍 busy(未被打断)
  await sleep(1500)
  const q2 = await req('GET', `/channels/${channelId}/queue`)
  const wStat2 = (q2.json.data ?? []).find(a => a.id === WORKER_ID)
  check('注入后 worker 仍 busy(任务未中断)', wStat2?.state === 'busy', `state=${wStat2?.state}`)

  console.log('━━━ 4. 等任务完成 + 观察回执 ━━━')
  const done = await waitUntil(async () => {
    const { json } = await req('GET', `/tasks/${taskId}`)
    const s = json?.data?.state
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(s) ? s : null
  }, 240_000, 2000)
  check('任务最终 COMPLETED(注入未破坏执行)', done === 'COMPLETED', `state=${done} [${ts()}]`)

  // 子任务成果(artifacts 应包含注入后的补充说明或测试输出)
  const childDetail = await req('GET', `/tasks/${childTask.id}`)
  const arts = childDetail.json?.data?.artifacts ?? []
  console.log(`  worker 产出 ${arts.length} 个 artifact;`)

  // worker 回执:requireReply=true → worker 应回消息(消息表 recent)
  const mailbox = await req('GET', `/channels/${channelId}/mailbox?agentId=${LEAD_ID}&limit=20`)
  const replies = (mailbox.json?.data ?? []).filter(m =>
    m.metadata?.['x-aw-in-reply-to'] || (m.parts ?? []).some(p => p.text?.includes('fib')))
  check('lead mailbox 收到 worker 回执', replies.length > 0, `replies=${replies.length}`)
  for (const r of replies.slice(0, 2)) {
    const text = (r.parts ?? []).map(p => p.text ?? '').join(' ').slice(0, 120)
    console.log(`  reply: ${text}`)
  }

  // 全员回 idle
  await sleep(2000)
  const q3 = await req('GET', `/channels/${channelId}/queue`)
  const states = (q3.json.data ?? []).map(a => `${a.name}:${a.state}`)
  check('完成后全员 idle', (q3.json.data ?? []).every(a => a.state === 'idle'), JSON.stringify(states))

  // 清理
  await req('DELETE', `/channels/${channelId}`)
  for (const id of cleanupIds.agentIds) await req('DELETE', `/agents/${id}`)
  console.log(`\n━━━ 结果: PASS=${pass} FAIL=${fail} ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e crashed:', err)
  process.exit(1)
})
