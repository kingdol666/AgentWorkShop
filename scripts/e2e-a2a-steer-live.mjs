/**
 * A2A steer 注入 仪器化端到端测试(生产服务器 + 真实 omp 子进程)。
 *
 * 与朴素版区别:250ms 高频采样 agent 状态与任务状态;
 * 注入时机由「观测到 worker busy + 子任务 WORKING」触发,确保命中 omp 回合执行中窗口;
 * 用 DB 行有无作为 steer(进程内注入,不落库)vs mailbox(入队,落库)的判别证据:
 *  - busy → impl.steer → omp rpc steer 帧 → 不写 messages 表
 *  - idle → mailbox.enqueue → messages 表出现该 messageId 行
 *
 * 用法: node scripts/e2e-a2a-steer-live.mjs [--base http://127.0.0.1:3001]
 */
import { DatabaseSync } from 'node:sqlite'

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
const timeline = []
function log(e) {
  timeline.push(`${ts()} ${e}`)
  console.log(`  [${ts()}] ${e}`)
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function dbHasMessage(messageId) {
  const db = new DatabaseSync('data/workshop.sqlite', { readOnly: true })
  try {
    const row = db.prepare('SELECT state FROM messages WHERE id = ?').get(messageId)
    return row ?? null
  }
  finally { db.close() }
}

async function main() {
  console.log('━━━ 1. 搭建 omp channel ━━━')
  const leadTpl = await req('POST', '/agents', { name: 'live-lead', harness: 'omp' })
  const workerTpl = await req('POST', '/agents', { name: 'live-worker', harness: 'omp' })
  const ch = await req('POST', '/channels', { name: 'a2a-steer-live', description: 'live steer e2e' })
  const channelId = ch.json.data.channelId
  const lead = await req('POST', `/channels/${channelId}/agents`, { agentId: leadTpl.json.data.id, role: 'lead' })
  const worker = await req('POST', `/channels/${channelId}/agents`, { agentId: workerTpl.json.data.id, role: 'worker' })
  const LEAD_ID = lead.json.data.id
  const WORKER_ID = worker.json.data.id
  log(`channel=${channelId.slice(0, 8)}… lead=${LEAD_ID.slice(0, 8)}… worker=${WORKER_ID.slice(0, 8)}…`)
  const cleanup = { channelId, agentIds: [leadTpl.json.data.id, workerTpl.json.data.id] }

  console.log('━━━ 1.5 预热:小任务把 lead/worker 两个 omp 进程拉起(消除 ~55s 冷启动窗口)━━━')
  const warm = await req('POST', `/channels/${channelId}/tasks`, {
    title: 'warmup',
    description: '预热任务:直接完成,无需实际工作。',
  })
  const warmDone = await (async () => {
    for (let i = 0; i < 90; i++) {
      const { json } = await req('GET', `/tasks/${warm.json.data.id}`)
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(json?.data?.state)) return json.data.state
      await sleep(2000)
    }
    return 'timeout'
  })()
  log(`warmup ${warmDone}(omp 进程已就绪)`)
  if (warmDone !== 'COMPLETED') {
    console.log('  预热未完成,继续尝试真实测试')
  }
  const taskResp = await req('POST', `/channels/${channelId}/tasks`, {
    title: '编写并运行一个 Node 脚本',
    description: '在工作目录创建 fib.js:实现记忆化 fib(n),写测试断言 fib(10)=55、fib(20)=6765、fib(30)=832040,node 执行测试输出结果,完成后报告路径与输出。',
  })
  const taskId = taskResp.json.data.id
  log(`task 提交: ${taskId.slice(0, 8)}…`)

  // 高频采样:queue(agent 状态)+ tasks(任务状态)
  let workerBusyAt = null
  const deadline = Date.now() + 120_000
  let lastSnap = ''
  while (Date.now() < deadline) {
    const q = await req('GET', `/channels/${channelId}/queue`)
    const w = (q.json.data ?? []).find(a => a.agentId === WORKER_ID)
    const tl = await req('GET', `/channels/${channelId}/tasks`)
    const child = (tl.json.data ?? []).find(t => t.parentId === taskId)
    const snap = `worker=${w?.state ?? '?'} child=${child?.state ?? '-'}`
    if (snap !== lastSnap) {
      log(snap)
      lastSnap = snap
    }
    if (w?.state === 'busy' && child?.state === 'WORKING') {
      workerBusyAt = { agentState: w.state, childId: child.id, childState: child.state }
      break
    }
    await sleep(250)
  }
  check('观测到 worker busy + 子任务 WORKING', !!workerBusyAt,
    workerBusyAt ? `child=${workerBusyAt.childId.slice(0, 8)}…` : '120s 内未出现(检查 omp spawn)')

  if (!workerBusyAt) {
    await req('DELETE', `/channels/${channelId}`)
    console.log(`\n━━━ 结果: PASS=${pass} FAIL=${fail} ━━━`)
    process.exit(1)
  }

  console.log('━━━ 3. 注入时机已命中:immediate 消息 → omp 进程内 steer ━━━')
  const tInject = Date.now()
  const inj = await req('POST', `/channels/${channelId}/messages`, {
    toAgentId: WORKER_ID,
    fromAgentId: LEAD_ID,
    text: '实时插话:请在最终报告里补充一行「已收到实时插话」并给出 fib(10) 的值。继续当前工作不要中断。',
    priority: 'immediate',
    requireReply: true,
  })
  const apiMs = Date.now() - tInject
  const messageId = inj.json?.data?.messageId
  check('immediate API 即时返回', inj.json?.code === 0 && apiMs < 1000, `${apiMs}ms messageId=${messageId?.slice(0, 8)}…`)
  log(`immediate 注入完成(${apiMs}ms)`)

  // 立即查 DB:无行 = busy 命中 → steer 进程内注入
  await sleep(300)
  const dbRow = messageId ? dbHasMessage(messageId) : null
  check('DB 无 mailbox 行 → 走 steer 进程内注入(非队列)', dbRow === null,
    dbRow ? `DB 有行 state=${dbRow.state}(走了 mailbox:注入时 worker 非 busy)` : '无行,omp rpc steer 帧已发')

  // 注入后监控:worker 持续执行至子任务终态(不中断)
  const deadline2 = Date.now() + 240_000
  let last2 = ''
  let interrupted = false
  while (Date.now() < deadline2) {
    const tl = await req('GET', `/channels/${channelId}/tasks`)
    const c2 = (tl.json.data ?? []).find(t => t.id === workerBusyAt.childId)
    if (!c2) break
    if (c2.state === 'CANCELED' || c2.state === 'FAILED') {
      interrupted = true
      break
    }
    if (c2.state === 'COMPLETED') break
    const q = await req('GET', `/channels/${channelId}/queue`)
    const wState = (q.json.data ?? []).find(a => a.agentId === WORKER_ID)?.state
    const snap = `worker=${wState} child=${c2.state} progress=${c2.progress ?? 0}`
    if (snap !== last2) {
      log(snap)
      last2 = snap
    }
    await sleep(1000)
  }
  const finalChild = await req('GET', `/tasks/${workerBusyAt.childId}`)
  check('注入未中断执行:子任务 COMPLETED', finalChild.json?.data?.state === 'COMPLETED' && !interrupted,
    `state=${finalChild.json?.data?.state}`)

  console.log('━━━ 4. 回执与收尾 ━━━')
  // 信息性观察:注入内容是否被模型在同轮引用(LLM 行为,不作硬断言)
  const arts = finalChild.json?.data?.artifacts ?? []
  const allText = arts.map(a => a.parts.map(p => p.text ?? '').join('')).join('\n')
  const markerSeen = allText.includes('已收到实时插话')
  console.log(`  ${markerSeen ? 'PASS' : 'WARN'}  产出引用了注入内容(同轮可见)${markerSeen ? '' : ' — 模型未在报告中原样复述(取决于 LLM)'}`)

  // requireReply 回执:等 channel 消息历史出现 in_reply_to 关联的 worker→lead 回执(信息性)
  let reply = null
  for (let i = 0; i < 30 && !reply; i++) {
    await sleep(1500)
    const hist = await req('GET', `/channels/${channelId}/messages?limit=100`)
    reply = (hist.json?.data ?? []).find(m => m.toAgentId === LEAD_ID && m.metadata?.['x-aw-in-reply-to'] === messageId)
  }
  console.log(`  ${reply ? 'PASS' : 'WARN'}  worker 回执(in_reply_to 关联)${reply ? ' — ' + (reply.parts ?? []).map(p => p.text ?? '').join(' ').slice(0, 80) : ' — 未调用回执工具(LLM 行为)'}`)

  // 全员 idle(硬断言)
  await sleep(2000)
  const q3 = await req('GET', `/channels/${channelId}/queue`)
  check('收尾全员 idle', (q3.json.data ?? []).every(a => a.state === 'idle'),
    JSON.stringify((q3.json.data ?? []).map(a => `${a.name}:${a.state}`)))

  await req('DELETE', `/channels/${channelId}`)
  for (const id of cleanup.agentIds) await req('DELETE', `/agents/${id}`)
  console.log(`\n━━━ 时间线 ━━━\n${timeline.join('\n')}`)
  console.log(`\n━━━ 结果: PASS=${pass} FAIL=${fail} ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e crashed:', err)
  process.exit(1)
})
