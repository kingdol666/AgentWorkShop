/**
 * 验证:lead 能看 Channel 全部邮件(worker 间通信)+ 调度快照携带最近邮件。
 * 复刻用户场景:
 *   lead dispatch → worker1「计算 1+1 并把结果发给 worker2 让它再加 1」
 *   worker1 经 mail 把结果发给 worker2(require_reply)→ mock worker2 自动回执结果
 *   → 断言 lead 能看到这条往返(而不只是自己的收件箱),worker 看不到全量;
 *   并断言 SchedulerLoop 快照的 mail 上下文已注入(lead 据此判断"结果已被产出",避免重复派发)。
 *
 * 运行:pnpm tsx scripts/verify-lead-mail.ts
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import type {
  AgentEvent,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
  SupervisionDecision,
  SupervisionSnapshot,
} from '../server/services/workshop/agents/agent-interface'
import type { ChannelMail } from '../server/services/workshop/types/a2a'
import { AppError } from '../server/utils/errors'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

/** probe lead:真实 LLM lead 的替身——记录每轮快照收到的最近邮件(调度上下文可见性证据) */
class ProbeLeadImpl implements AgentInterface {
  constructor(private readonly captured: Array<{ tick: number, mail: ChannelMail[] }>) {}

  async* run(_request: AgentRunRequest, _ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    // lead 的作业在 supervise 完成,run 无消息负载
  }

  async supervise(snapshot: SupervisionSnapshot, _ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    this.captured.push({ tick: snapshot.tick, mail: snapshot.mail ?? [] })
    return []
  }
}

async function main(): Promise<void> {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),
    channelEvents: createChannelEventRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
  }

  // lead 用 probe 捕获快照邮件;worker 用 mock(收发均通过真实 mailbox/route 链路)
  const capturedMail: Array<{ tick: number, mail: ChannelMail[] }> = []
  const manager = createAgentChannelManager({
    repos,
    implFactory: (agent) => {
      if (agent.harness === 'probe') return new ProbeLeadImpl(capturedMail)
      return createAgentImpl(agent)
    },
    db,
  })

  const ch = await manager.createChannel({
    name: 'mail 可见性验证',
    leadAgent: { name: 'lead', harness: 'probe' },
  })
  const w1Tpl = await manager.createAgent({ name: 'worker1', harness: 'mock', config: { delayMs: 5 } })
  const w2Tpl = await manager.createAgent({ name: 'worker2', harness: 'mock', config: { delayMs: 5 } })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: w1Tpl.id, role: 'worker' })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: w2Tpl.id, role: 'worker' })

  manager.ensureChannelActive(ch.channelId, { tickMs: 30, stallMs: 60_000 })

  const members = await manager.listChannelAgents(ch.channelId)
  const lead = members.find(m => m.role === 'lead')!
  const w1 = members.find(m => m.name === 'worker1')!
  const w2 = members.find(m => m.name === 'worker2')!
  check('团队就绪(lead + 2 workers)', !!lead && !!w1 && !!w2, `lead=${lead?.id ?? '-'} w1=${w1?.id ?? '-'} w2=${w2?.id ?? '-'}`)

  // ===== 场景:lead 派发任务给 worker1,worker1 完成后 mail worker2 加 1,worker2 回执 =====
  const task = await manager.dispatchTask(ch.channelId, lead.id, {
    assigneeId: w1.id,
    title: '计算 1+1',
    description: '把计算结果 2 发给 worker2,让它再加 1',
  })

  // worker1(经真实 sendA2A 链路)→ worker2:要求回执
  await manager.sendA2A(ch.channelId, w1.id, {
    toAgentId: w2.id,
    parts: [{ text: '我是 worker1:1+1=2。请帮我加 1,并把结果回给我。' }],
    metadata: { 'x-aw-require-reply': 'true' },
  })

  // worker2(mock)自动回执 → worker1 收件箱
  const replySeen = await waitUntil(() => {
    const seen = capturedMail.some(c => c.mail.some(m => m.fromAgentId === w2.id && m.toAgentId === w1.id))
    return seen
      || repos.messages.listRecentByChannel(ch.channelId, 50).some(r => r.fromAgentId === w2.id && r.toAgentId === w1.id)
  }, 8_000)
  check('worker2 已回执结果(mock 自动回复)', replySeen)

  // 任务由 mock worker1 正常执行完成(端到端无回归)
  {
    interface Eng { get(id: string): { state: string } | undefined }
    const internal = manager as unknown as { getTaskEngine(): Eng }
    const engine = internal.getTaskEngine()
    const completed = await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 8_000)
    const state = engine.get(task.id)?.state ?? null
    check('worker1 任务正常完成(mock 链路无回归)', completed, `state=${String(state)}`)
  }

  await sleep(120) // 等快照稳定含邮件

  // ===== 断言 1:worker 看不到全量邮件(仅 lead 可全览) =====
  let workerDenied = false
  try {
    await manager.listChannelMail(ch.channelId, w2.id)
  }
  catch (e) {
    workerDenied = e instanceof AppError && e.code === 'SCOPE_VIOLATION'
  }
  check('worker2 调用 listChannelMail → SCOPE_VIOLATION(仅 lead 全览)', workerDenied)

  // ===== 断言 2:lead 看得到全部邮件(含 worker 间往返与任务指派) =====
  const all = await manager.listChannelMail(ch.channelId, lead.id)
  const fromW1 = all.filter(m => m.fromAgentId === w1.id)
  const fromW2 = all.filter(m => m.fromAgentId === w2.id)
  const assign = all.filter(m => m.metadata?.['x-aw-task-kind'] === 'assign')
  check('lead 可见全部邮件(≥3:assign + w1→w2 + w2→w1)', all.length >= 3, `count=${all.length}`)
  check('lead 可见 worker1→worker2 的 mail 原文', fromW1.some(m => m.toAgentId === w2.id && m.parts.some(p => 'text' in p && p.text.includes('1+1=2'))))
  check('lead 可见 worker2→worker1 的回执结果', fromW2.some(m => m.toAgentId === w1.id && m.parts.some(p => 'text' in p && p.text.includes('mock 回复'))))
  check('lead 可见任务指派邮件(assign)', assign.length >= 1, `assign=${assign.length}`)
  check('邮件携带投递状态与时间', all.every(m => ['pending', 'consuming', 'consumed'].includes(m.state) && !!m.createdAt))
  check('邮件倒序(最新在前)', all.every((m, i) => i === 0 || all[i - 1]!.createdAt >= m.createdAt))

  // ===== 断言 3:agentId 过滤 =====
  const w2Only = await manager.listChannelMail(ch.channelId, lead.id, { agentId: w2.id })
  check('agentId 过滤只含 worker2 参与邮件', w2Only.length > 0 && w2Only.every(m => m.fromAgentId === w2.id || m.toAgentId === w2.id), `count=${w2Only.length}`)

  // ===== 断言 4:调度快照携带最近邮件(lead supervise 上下文可见) =====
  const snapWithReply = capturedMail.find(c => c.mail.some(m => m.fromAgentId === w2.id && m.toAgentId === w1.id))
  check('SchedulerLoop 快照注入最近邮件(lead supervise 上下文)', !!snapWithReply, `capturedTicks=${capturedMail.length}`)
  const w1Context = snapWithReply ?? capturedMail.at(-1)
  if (w1Context) {
    const w1Mails = w1Context.mail.filter(m => m.fromAgentId === w1.id || m.toAgentId === w1.id)
    check('快照邮件包含 worker1 的往来(含 w2 回执)', w1Mails.length >= 2, `w1Mails=${w1Mails.length}`)
    check('快照邮件含回执原文', w1Mails.some(m => m.parts.some(p => 'text' in p && p.text.includes('mock 回复'))))
  }

  await manager.shutdown()
  db.close()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
