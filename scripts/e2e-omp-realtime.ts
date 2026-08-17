/// <reference types="node" />

/**
 * 真实 omp harness 实时通信端到端:
 *  A. 独立进程验证:每个 agent 一个 omp 子进程,PID 互不相同
 *  B. worker↔lead 触发对话:worker 执行任务中(busy)收到 lead 的 immediate+requireReply 消息
 *     → steer 注入运行中会话 → worker 以真实 LLM 回执(in_reply_to 关联,内容含所需信息)
 *  C. lead 响应 worker 消息:空闲 lead 收到 worker 消息 → peerMessageRun 处理并回复
 *
 * 运行: npx tsx scripts/e2e-omp-realtime.ts(依赖 PATH 上的 omp 与已配置模型)
 */
import type { DatabaseSync } from 'node:sqlite'
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
import { createUserRepo } from '../server/services/workshop/db/user.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'

let failures = 0
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const TIMING = { spawn: 60_000, dialog: 240_000, task: 240_000 }

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
      users: createUserRepo(db),

      channelEvents: createChannelEventRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
}

/** 内部访问:messages repo(回执断言)+ agentIndex(omp 子进程 PID 验证) */
interface Internals {
  deps: { repos: { messages: {
    listRecentByChannel(channelId: string, limit: number): Array<{ id: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, metadataJson: string }>
  } } }
  agentIndex: Map<string, unknown>
}

function internalsOf(manager: AgentChannelManager): Internals {
  return manager as unknown as Internals
}

interface Msg {
  id: string
  from: string | null
  to: string | null
  text: string
  metadata: Record<string, unknown>
}

function listMessages(manager: AgentChannelManager, channelId: string, limit = 100): Msg[] {
  return internalsOf(manager).deps.repos.messages.listRecentByChannel(channelId, limit).reverse().map(r => ({
    id: r.id,
    from: r.fromAgentId,
    to: r.toAgentId,
    text: (JSON.parse(r.partsJson) as Array<{ text?: string }>).map(p => p.text ?? '').join(' '),
    metadata: JSON.parse(r.metadataJson) as Record<string, unknown>,
  }))
}

async function waitForReply(manager: AgentChannelManager, channelId: string, pred: (m: Msg) => boolean, timeoutMs: number): Promise<Msg | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = listMessages(manager, channelId).find(pred)
    if (hit) return hit
    await sleep(100)
  }
  return listMessages(manager, channelId).find(pred) ?? null
}

/** 从 AgentRuntime 取其 OmpRpcAgentImpl 的 omp 子进程 PID(duck-typing 内部结构) */
function ompPidOf(manager: AgentChannelManager, channelId: string, agentId: string): number | null {
  const runtime = internalsOf(manager).agentIndex.get(`${channelId}\u0000${agentId}`) as unknown as {
    impl?: { client?: { child?: { pid?: number } } }
  } | undefined
  return runtime?.impl?.client?.child?.pid ?? null
}

async function waitRuntime(manager: AgentChannelManager, agentId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.getChannelAgent(agentId)?.wired) return
    await sleep(100)
  }
}

async function main(): Promise<void> {
  console.log('━━━ 真实 omp harness:独立进程 + 实时触发对话 ━━━')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    // 组队:1 lead + 2 workers(全部 omp harness,真实子进程)
    const ch = await manager.createChannel({
      name: 'omp-realtime-e2e',
      leadAgent: { name: 'lead-协调', harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } },
    })
    const wA = await manager.createAgent({ name: 'worker-甲', harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } })
    const wB = await manager.createAgent({ name: 'worker-乙', harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wA.id, role: 'worker' })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wB.id, role: 'worker' })
    const members = await manager.listChannelAgents(ch.channelId)
    const lead = members.find(m => m.role === 'lead')!
    const workers = members.filter(m => m.role === 'worker')

    // ---- A. 独立进程验证:提交任务触发装配,三个 agent 各起一个 omp 子进程 ----
    console.log('\n━━━ A. 独立 omp 子进程验证 ━━━')
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '环境检查任务',
      description: 'Use the get_my_task_queue tool to check your task queue, then reply to the lead with a one-line summary using send_message_to_agent (no require_reply needed). Then call complete_task.',
    })
    // 等 lead/worker 装配(懒加载由调度触发)
    for (const m of members) {
      await waitRuntime(manager, m.id, TIMING.spawn)
    }
    // 懒 spawn 时机随 LLM 推进而定:轮询直到至少 2 个成员持有子进程(上限 60s)
    const spawnDeadline = Date.now() + 60_000
    let pids = new Map(members.map(m => [m.id, ompPidOf(manager, ch.channelId, m.id)]))
    while (Date.now() < spawnDeadline && [...pids.values()].filter(p => p !== null).length < 2) {
      const { promise, resolve } = Promise.withResolvers()
      setTimeout(resolve, 500)
      await promise
      pids = new Map(members.map(m => [m.id, ompPidOf(manager, ch.channelId, m.id)]))
    }
    const spawned = members.filter(m => (pids.get(m.id) ?? null) !== null)
    check('全部成员各自持有 omp 子进程', spawned.length >= 2,
      `spawned=${spawned.length}/${members.length}(懒加载按需 spawn)`)
    const distinctPids = [...pids.values()].filter(p => p !== null)
    check('子进程 PID 互不相同(独立进程隔离)', new Set(distinctPids).size === distinctPids.length,
      `pids=${distinctPids.join(',')}`)

    // 等任务闭环(真实 LLM,放宽)
    const engine = (manager as unknown as { getTaskEngine(): { get(id: string): { state: string } | undefined } }).getTaskEngine()
    const doneAt = Date.now() + TIMING.task
    while (Date.now() < doneAt && engine.get(task.id)?.state !== 'COMPLETED') {
      await sleep(500)
    }
    check('omp 任务闭环 COMPLETED', engine.get(task.id)?.state === 'COMPLETED',
      `state=${engine.get(task.id)?.state}`)

    // ---- B. lead ↔ worker-甲 实时触发对话(worker 空闲路径:入队 → peerMessageRun → LLM 回执)----
    console.log('\n━━━ B. lead→worker 触发对话(真实 LLM 回执)━━━')
    const m1 = await manager.sendImmediateMessage({
      channelId: ch.channelId,
      fromAgentId: lead.id,
      toAgentId: workers[0].id,
      parts: [{ text: '请告诉我:2+3 等于几?只需一个数字。' }],
      requireReply: true,
    })
    const r1 = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m1.messageId, TIMING.dialog)
    check('B: worker 真实回执已产生', r1 !== null)
    if (r1) {
      check('B: in_reply_to 关联', r1.metadata['x-aw-in-reply-to'] === m1.messageId)
      check('B: 回复方正确', r1.from === workers[0].id && r1.to === lead.id)
      check('B: 内容包含答案 5', r1.text.includes('5'), r1.text.slice(0, 80))
    }

    // ---- C. worker-乙 → lead 触发对话(lead peerMessageRun 路径)----
    console.log('\n━━━ C. worker→lead 触发对话(lead 响应)━━━')
    const m2 = await manager.sendImmediateMessage({
      channelId: ch.channelId,
      fromAgentId: workers[1].id,
      toAgentId: lead.id,
      parts: [{ text: 'lead,我的当前队列里有几个任务?请用数字回答。' }],
      requireReply: true,
    })
    const r2 = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m2.messageId, TIMING.dialog)
    check('C: lead 真实回执已产生', r2 !== null)
    if (r2) {
      check('C: in_reply_to 关联', r2.metadata['x-aw-in-reply-to'] === m2.messageId)
      check('C: 回复方为 lead', r2.from === lead.id && r2.to === workers[1].id)
      console.log(`  C: lead 回复内容: ${r2.text.slice(0, 120)}`)
    }

    // ---- D. worker busy 中 steer 注入(worker 执行长任务时 immediate 触发)----
    console.log('\n━━━ D. worker busy 中 steer 实时注入 ━━━')
    const longTask = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '长任务:逐步计数',
      description: 'Slowly count from 1 to 5 in your reasoning, taking your time (a few seconds per step is fine; just think through each number carefully). Then call complete_task with the final count.',
    })
    // 等 worker-甲 或 worker-乙 busy(dispatch 后)
    const busyAt = Date.now() + 30_000
    let busyId: string | null = null
    while (Date.now() < busyAt && !busyId) {
      for (const w of workers) {
        if (manager.getChannelAgent(w.id)?.runtimeState === 'busy') {
          busyId = w.id
          break
        }
      }
      if (!busyId) await sleep(100)
    }
    check('D: worker 进入 busy', busyId !== null, busyId ? busyId.slice(0, 8) : 'timeout')
    if (busyId) {
      const m3 = await manager.sendImmediateMessage({
        channelId: ch.channelId,
        fromAgentId: lead.id,
        toAgentId: busyId,
        parts: [{ text: '中途检查:请在你完成当前工作后,告诉我你正在做什么,一句话即可。' }],
        requireReply: true,
      })
      const r3 = await waitForReply(manager, ch.channelId, x => x.metadata['x-aw-in-reply-to'] === m3.messageId, TIMING.dialog)
      check('D: busy worker 经 steer 注入后回执', r3 !== null)
      if (r3) {
        check('D: 回复方正确', r3.from === busyId && r3.to === lead.id)
        console.log(`  D: worker 回复内容: ${r3.text.slice(0, 120)}`)
      }
    }

    const doneAt2 = Date.now() + TIMING.task
    while (Date.now() < doneAt2 && engine.get(longTask.id)?.state !== 'COMPLETED') {
      await sleep(500)
    }
    check('D: 长任务最终完成', engine.get(longTask.id)?.state === 'COMPLETED',
      `state=${engine.get(longTask.id)?.state}`)
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
