/**
 * Agent Team 协调配合实测(US-307):真实 mailbox 全链。
 *
 * 流路:lead 经 send_message/dispatch 信箱投递任务 → worker poll_messages 领取 →
 * worker report_progress/complete_task 回执 → lead poll 确认结果。全程走
 * /api/workshop/a2a REST(Agent token 鉴权),与 Agent 运行时真实信箱同源。
 *
 * 运行:node scripts/team-coordination-e2e.mjs <scenario-context.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/team-coordination-e2e.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-acceptance')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}

async function a2a(agent, tool, args, timeoutMs = 90_000) {
  // Team 协作工具是 host tools:经 agent-tools invoke 桥调用(与 Agent 运行时同一分发入口)
  const r = await fetch(c.base + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
    body: JSON.stringify({ agentId: agent.id, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => ({}))
  const text = String(j?.data?.result?.text ?? '')
  return { status: r.status, ok: r.status === 200 && !j?.data?.result?.isError, data: j?.data?.result, message: text }
}

async function main() {
  console.log(`━━━ Agent Team 协调配合实测 @ ${c.base} channel=${c.channelId} ━━━`)
  const lead = c.agents?.lead
  const worker = c.agents?.analyst
  ok('T0', 'lead/worker 就绪(含 token)', Boolean(lead?.token && worker?.token), `lead=${lead?.id?.slice(0, 8)} worker=${worker?.id?.slice(0, 8)}`)
  if (!lead?.token || !worker?.token) process.exit(1)

  // ①+② lead 投递与 worker 阻塞轮询并行(worker 先挂 wait_seconds 阻塞等待,到信即醒)
  const workerWait = a2a(worker, 'poll_messages', { limit: 20, wait_seconds: 12 }, 30_000)
  await sleep(1200)
  const send = await a2a(lead, 'send_message_to_agent', {
    to_agent_id: worker.id,
    message: `[Team 协调实测] 请分析你绑定节点的最近数据,完成后回报结论摘要。任务编号 TC-${Date.now().toString(36)}`,
  })
  const workerWaited = await workerWait
  ok('T1', 'lead→worker 信箱投递', send.ok, send.message.slice(0, 140))
  ok('T2', 'worker 阻塞轮询收到任务(到信即醒)', workerWaited.ok && !/收件箱为空/.test(workerWaited.message), workerWaited.message.slice(0, 160))

  // ③+④ worker 回执 → lead 阻塞轮询确认(闭环)
  const leadWait = a2a(lead, 'poll_messages', { limit: 20, wait_seconds: 12 }, 30_000)
  await sleep(1200)
  const reply = await a2a(worker, 'send_message_to_agent', {
    to_agent_id: lead.id,
    message: `[Team 协调实测·回执] 分析完成:绑定节点数据窗口内均值/极差已核对,结论=窗口内无越限,建议保持当前配方。`,
  })
  const leadWaited = await leadWait
  ok('T3', 'worker 结果回报投递', reply.ok, reply.message.slice(0, 140))
  ok('T4', 'lead 收到 worker 回执(闭环)', leadWaited.ok && !/收件箱为空/.test(leadWaited.message), leadWaited.message.slice(0, 160))

  // ⑤ 任务面派发(dispatch_task)→worker 任务队列可见
  const dispatch = await a2a(lead, 'dispatch_task', {
    assignee_id: worker.id,
    title: `[Team 实测] 数据核对任务`,
    description: '核对绑定节点最近 10 分钟数据并回报点数与均值。',
  })
  ok('T5', 'lead 派发结构化任务', dispatch.ok, dispatch.message.slice(0, 140))
  let queueText = ''
  for (let i = 0; i < 8; i++) {
    await sleep(1500)
    const q = await a2a(worker, 'get_my_task_queue', {})
    queueText = q.message || q.data?.text || ''
    if (queueText.includes('数据核对任务')) break
  }
  ok('T6', 'worker 任务队列出现派发任务', queueText.includes('数据核对任务'), queueText.slice(0, 200))

  writeFileSync(join(EVID, 'team-coordination.json'), JSON.stringify({ at: new Date().toISOString(), base: c.base, channelId: c.channelId, results }, null, 2))
  const pass = results.filter(r => r.pass).length
  console.log(`\n═══ Team 协调配合: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
