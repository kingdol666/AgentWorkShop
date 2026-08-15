/**
 * 端到端验证:任务 + 实时通信双驱动(mock harness 全链路)。
 *
 * 场景 A:多任务(3 个)并发调度闭环 + worker 内部 FIFO
 * 场景 B:实时通信触发器矩阵:
 *   B1 worker→lead 触发消息(immediate):lead 忙碌时 steer 注入;空闲时入队消费 → 必回执
 *   B2 lead→worker 触发消息(task):worker 空闲消费 → 必回执
 *   B3 worker↔worker 触发消息:双向回执
 *   B4 无触发器消息:信息性,不产生回执
 * 回执断言:x-aw-in-reply-to 关联原消息 + 内容含"执行结果"语义 + 声明不需再响应
 * 场景 C:任务执行中(busy)触发消息 → steer 路径注入(mock 不支持 steer → 降级入队,完成后消费回执)
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'

let failures = 0
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function makeManager(db: DatabaseSync): AgentChannelManager {
  return createAgentChannelManager({
    repos: {
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
}

/** 内部 messages repo 访问(回执断言用) */
function messagesOf(manager: AgentChannelManager) {
  return (manager as unknown as {
    deps: { repos: { messages: {
      listRecentByChannel(channelId: string, limit: number): Array<{
        id: string
        fromAgentId: string | null
        toAgentId: string | null
        partsJson: string
        metadataJson: string
      }> } } }
  }).deps.repos.messages
}

interface Msg {
  id: string
  from: string | null
  to: string | null
  text: string
  metadata: Record<string, unknown>
}

function listMessages(manager: AgentChannelManager, channelId: string, limit = 100): Msg[] {
  return messagesOf(manager).listRecentByChannel(channelId, limit).reverse().map(r => ({
    id: r.id,
    from: r.fromAgentId,
    to: r.toAgentId,
    text: JSON.stringify(JSON.parse(r.partsJson) as Array<{ text?: string }>)
      .slice(1, -1),
    metadata: JSON.parse(r.metadataJson) as Record<string, unknown>,
  }))
}

/** 等待出现满足条件的回执消息 */
async function waitForReply(
  manager: AgentChannelManager,
  channelId: string,
  pred: (m: Msg) => boolean,
  timeoutMs: number,
): Promise<Msg | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = listMessages(manager, channelId).find(pred)
    if (hit) return hit
    await sleep(20)
  }
  return listMessages(manager, channelId).find(pred) ?? null
}

/** 回执完整性断言:in_reply_to 关联 + 内容含结果语义 + 声明无需再响应 */
function assertReplyShape(name: string, reply: Msg | null, origId: string, fromId: string, toId: string): void {
  check(`${name}: 回执已产生`, reply !== null)
  if (!reply) return
  check(`${name}: in_reply_to 关联原消息`, reply.metadata['x-aw-in-reply-to'] === origId,
    `in_reply_to=${String(reply.metadata['x-aw-in-reply-to'] ?? '-')}`)
  check(`${name}: 回复方/接收方正确`, reply.from === fromId && reply.to === toId,
    `from=${reply.from?.slice(0, 8)} to=${reply.to?.slice(0, 8)}`)
  check(`${name}: 内容含执行结果语义`, reply.text.includes('执行结果') || reply.text.includes('result'),
    reply.text.slice(0, 50))
  check(`${name}: 声明无需再响应`, reply.metadata['x-aw-require-reply'] === 'false',
    `require-reply=${String(reply.metadata['x-aw-require-reply'] ?? '-')}`)
}

async function scenarioMultiTask(manager: AgentChannelManager): Promise<void> {
  console.log('\n━━━ 场景 A:三任务并发调度闭环(mock)━━━')
  const ch = await manager.createChannel({
    name: 'dual-e2e-A',
    leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 0 } },
  })
  const w = await manager.createAgent({ name: 'worker', harness: 'mock', config: { delayMs: 100 } })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: w.id, role: 'worker' })
  const engine = (manager as unknown as {
    getTaskEngine(): { get(id: string): { state: string } | undefined }
  }).getTaskEngine()

  const ps = await Promise.all([
    manager.submitChannelTask({ channelId: ch.channelId, title: 'T1', description: '一' }),
    manager.submitChannelTask({ channelId: ch.channelId, title: 'T2', description: '二' }),
    manager.submitChannelTask({ channelId: ch.channelId, title: 'T3', description: '三' }),
  ])
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !ps.every(p => engine.get(p.id)?.state === 'COMPLETED')) {
    await sleep(50)
  }
  check('三任务全部完成', ps.every(p => engine.get(p.id)?.state === 'COMPLETED'),
    ps.map(p => `${p.id.slice(0, 8)}=${engine.get(p.id)?.state}`).join(' '))
}

async function scenarioTriggerChat(manager: AgentChannelManager): Promise<void> {
  console.log('\n━━━ 场景 B:实时通信触发器矩阵(mock)━━━')
  const ch = await manager.createChannel({
    name: 'dual-e2e-B',
    leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 0 } },
  })
  const wt = await manager.createAgent({ name: 'workerA', harness: 'mock', config: { delayMs: 0 } })
  const wt2 = await manager.createAgent({ name: 'workerB', harness: 'mock', config: { delayMs: 0 } })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wt.id, role: 'worker' })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wt2.id, role: 'worker' })
  const members = await manager.listChannelAgents(ch.channelId)
  const lead = members.find(m => m.role === 'lead')!
  const [wA, wB] = members.filter(m => m.role === 'worker')

  // B1 worker → lead(immediate + requireReply)
  const m1 = await manager.sendImmediateMessage({
    channelId: ch.channelId,
    fromAgentId: wA.id,
    toAgentId: lead.id,
    parts: [{ text: 'lead,请提供 T1 的验收标准' }],
    requireReply: true,
  })
  const r1 = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m1.messageId, 10_000)
  assertReplyShape('B1 worker→lead', r1, m1.messageId, lead.id, wA.id)

  // B2 lead → worker(task + requireReply,经 lead 身份)
  const m2 = await manager.sendA2A(ch.channelId, lead.id, {
    toAgentId: wB.id,
    parts: [{ text: 'workerB,请汇报当前进度' }],
    metadata: { 'x-aw-msg-priority': 'task', 'x-aw-require-reply': 'true' },
  })
  const r2 = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m2.messageId, 10_000)
  assertReplyShape('B2 lead→worker', r2, m2.messageId, wB.id, lead.id)

  // B3 worker ↔ worker(双向)
  const m3 = await manager.sendA2A(ch.channelId, wA.id, {
    toAgentId: wB.id,
    parts: [{ text: 'B,把你的中间结果发我' }],
    metadata: { 'x-aw-msg-priority': 'task', 'x-aw-require-reply': 'true' },
  })
  const r3 = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m3.messageId, 10_000)
  assertReplyShape('B3 worker↔worker', r3, m3.messageId, wB.id, wA.id)

  // B4 无触发器:信息性消息,不产生回执
  await manager.sendA2A(ch.channelId, wA.id, {
    toAgentId: wB.id,
    parts: [{ text: '收到,备忘' }],
    metadata: { 'x-aw-msg-priority': 'task' },
  })
  await sleep(800)
  const replies = listMessages(manager, ch.channelId).filter(m => m.metadata['x-aw-in-reply-to'] !== undefined)
  check('B4 无触发器:不产生回执', !replies.some(r => r.text.includes('备忘')), `replies=${replies.length}`)
}

async function scenarioBusySteer(manager: AgentChannelManager): Promise<void> {
  console.log('\n━━━ 场景 C:任务执行中触发消息(busy → steer/降级入队)━━━')
  const ch = await manager.createChannel({
    name: 'dual-e2e-C',
    leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 0 } },
  })
  const wt = await manager.createAgent({ name: 'worker', harness: 'mock', config: { delayMs: 300 } })
  await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wt.id, role: 'worker' })
  const members = await manager.listChannelAgents(ch.channelId)
  const lead = members.find(m => m.role === 'lead')!
  const w = members.filter(m => m.role === 'worker')[0]!

  const task = await manager.submitChannelTask({ channelId: ch.channelId, title: '长任务', description: '执行 1s' })
  // 等 worker busy
  const busyDeadline = Date.now() + 5000
  while (Date.now() < busyDeadline && manager.getChannelAgent(w.id)?.runtimeState !== 'busy') {
    await sleep(20)
  }
  check('worker 进入 busy', manager.getChannelAgent(w.id)?.runtimeState === 'busy')
  // busy 中 immediate 触发消息(mock 无 steer → 降级入 mailbox 队列,当前任务完成后消费回执)
  const m = await manager.sendImmediateMessage({
    channelId: ch.channelId,
    fromAgentId: lead.id,
    toAgentId: w.id,
    parts: [{ text: 'worker,中途请回报当前状态' }],
    requireReply: true,
  })
  const reply = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m.messageId, 15_000)
  assertReplyShape('C busy 中触发', reply, m.messageId, w.id, lead.id)

  const engine = (manager as unknown as {
    getTaskEngine(): { get(id: string): { state: string } | undefined }
  }).getTaskEngine()
  const doneDeadline = Date.now() + 15_000
  while (Date.now() < doneDeadline && engine.get(task.id)?.state !== 'COMPLETED') {
    await sleep(50)
  }
  check('触发消息未破坏任务执行(仍完成)', engine.get(task.id)?.state === 'COMPLETED',
    `state=${engine.get(task.id)?.state}`)
}

async function main(): Promise<void> {
  console.log('━━━ 任务 + 实时通信双驱动端到端(mock)━━━')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    await scenarioMultiTask(manager)
    await scenarioTriggerChat(manager)
    await scenarioBusySteer(manager)
  }
  finally {
    await manager.shutdown()
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
