/**
 * AgentTeam 任务与群聊真实集成测试(内存 Workshop SQLite + 隔离用户数据目录)。
 * 运行: pnpm exec tsx --tsconfig scripts/tsconfig.json scripts/test-agentteam-task-chat-flow.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'

const isolatedDataDir = mkdtempSync(join(tmpdir(), 'aw-agentteam-task-chat-flow-'))
process.env.AW_DATA_DIR = isolatedDataDir
process.env.AGENTWORKSHOP_TEST = '1'

const TIMEOUT_MS = 20_000
const POLL_MS = 20

type Outcome = 'PASS' | 'FAIL' | 'BLOCKED'
const outcomes: Outcome[] = []

function report(outcome: Outcome, name: string, detail = ''): void {
  outcomes.push(outcome)
  console.log(`${outcome} ${name}${detail ? ` — ${detail}` : ''}`)
}

function check(name: string, passed: boolean, detail = ''): void {
  report(passed ? 'PASS' : 'FAIL', name, detail)
}

function blocked(name: string, detail: string): void {
  report('BLOCKED', name, detail)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = TIMEOUT_MS,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!predicate(value) && Date.now() < deadline) {
    await sleep(POLL_MS)
    value = await read()
  }
  return predicate(value) ? value : undefined
}

function partText(part: unknown): string {
  if (typeof part !== 'object' || part === null) return ''
  if ('text' in part && typeof part.text === 'string') return part.text
  if ('data' in part) return JSON.stringify(part.data)
  return ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

let db: DatabaseSync | undefined
let manager: AgentChannelManager | undefined
let resetUserRepository: (() => void) | undefined

try {
  // AW_DATA_DIR 必须先隔离，再动态导入会解析用户数据库路径的 repository。
  const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
  const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
  const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
  const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
  const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
  const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
  const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
  const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
  const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
  const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
  const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
  const managerMod = await import('../server/services/workshop/runtime/manager')
  const { createAgentImpl } = await import('../server/services/workshop/agents/factory')
  const { userRepository } = await import('../server/repositories/user.repository')
  resetUserRepository = () => userRepository._resetForTest()

  db = openWorkshopDb(':memory:')
  initWorkshopDb(db)
  manager = managerMod.createAgentChannelManager({
    repos: {
      users: undefined as never,
      channelEvents: createChannelEventRepo(db),
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      schedules: undefined as never,
    },
    implFactory: createAgentImpl,
    db,
  })

  function createUser(name: string): { id: string, name: string, role: string } {
    const { user } = userRepository.createWithRoleBootstrap({
      name,
      email: `${name}@agentteam-flow.local`,
      password: 'Passw0rd!123',
      role: 'user',
      status: 'active',
    })
    return { id: user.id, name: user.name, role: user.role }
  }

  const bootstrapAdmin = createUser('agentteam-flow-admin')
  const owner = createUser('agentteam-flow-owner')
  check('使用隔离用户仓库创建真实用户', bootstrapAdmin.role === 'admin' && owner.role === 'user', `owner=${owner.id.slice(0, 8)}`)

  const channel = await manager.createChannel({
    name: 'agentteam-task-chat-flow',
    description: '独立任务与群聊集成测试',
    ownerUserId: owner.id,
    workspace: join(isolatedDataDir, 'workspaces', 'agentteam-task-chat-flow'),
    leadAgent: { name: 'flow-lead', harness: 'mock', config: { delayMs: 20 } },
  })
  if (!channel.leadAgentId) throw new Error('创建 channel 时没有 leadAgentId')
  const channelId = channel.channelId
  const leadAgentId = channel.leadAgentId

  const fastTemplate = await manager.createAgent({
    name: 'flow-worker-fast',
    harness: 'mock',
    config: { delayMs: 200 },
  })
  const slowTemplate = await manager.createAgent({
    name: 'flow-worker-slow',
    harness: 'mock',
    config: { delayMs: 650 },
  })
  await manager.addAgentToChannel({ channelId, agentId: fastTemplate.id, role: 'worker' })
  await manager.addAgentToChannel({ channelId, agentId: slowTemplate.id, role: 'worker' })

  const configuredChannel = manager.deps.repos.channels.update(channelId, {
    visibility: 'public',
    joinPolicy: 'open',
    chatEnabled: 1,
  })
  if (!configuredChannel) throw new Error('启用 channel 群聊失败')
  const channelAgents = await manager.listChannelAgents(channelId)
  const workerMembers = channelAgents.filter(agent => agent.role === 'worker')
  const workerIds = new Set(workerMembers.map(agent => agent.id))
  check('真实 AgentChannelManager 与 MockAgentImpl 成员已装配', workerMembers.length >= 2)

  // 先经真实群聊路由懒装配 lead，再 ensureChannelActive；避免首次装配时重复创建 scheduler。
  const leadMember = channelAgents.find(agent => agent.id === leadAgentId)
  if (!leadMember) throw new Error('创建 channel 后找不到 lead 成员')
  const leadProbe = manager.sendChatMessage(channelId, owner, {
    text: `@${leadMember.name} 初始化隔离集成测试运行时。`,
    mentions: [{ type: 'agent', id: leadMember.id, label: leadMember.name }],
    clientMessageId: 'agentteam-task-chat-flow-lead-bootstrap',
  })
  const leadWired = await waitFor(
    () => manager!.runtimeStatus(),
    status => status.wiredAgents.includes(leadAgentId),
  )
  if (!leadWired) throw new Error('群聊路由未能装配 lead runtime')
  manager.ensureChannelActive(channelId, { tickMs: 50 })

  const listTasks = () => manager!.listTasks(channelId, leadAgentId)

  // ① 未标注复杂度的普通短任务应由 lead 直接完成。
  const simpleTask = await manager.submitChannelTask({
    channelId,
    title: '简短问候',
    description: '写一句简洁的问候语。',
  })
  check('默认简单任务已提交', simpleTask.state === 'SUBMITTED', `state=${simpleTask.state}`)

  const simpleSnapshot = await waitFor(
    listTasks,
    tasks => tasks.some(task => task.id === simpleTask.id && task.state === 'COMPLETED'),
  )
  if (!simpleSnapshot) {
    const latest = (await listTasks()).find(task => task.id === simpleTask.id)
    blocked('默认简单任务由 lead 完成且无 child', `等待超时，state=${latest?.state ?? 'missing'}`)
    blocked('默认简单任务产出 lead-direct-answer', '简单任务未进入 COMPLETED，无法检查产物')
  }
  else {
    const simpleFinal = simpleSnapshot.find(task => task.id === simpleTask.id)!
    const simpleChildren = simpleSnapshot.filter(task => task.parentId === simpleTask.id)
    check('默认简单任务由 lead 直接 COMPLETED 且无 child',
      simpleFinal.state === 'COMPLETED' && simpleChildren.length === 0,
      `state=${simpleFinal.state}, children=${simpleChildren.length}`)
    check('简单任务产物包含 lead-direct-answer',
      simpleFinal.artifacts.some(artifact => artifact.name === 'lead-direct-answer'),
      simpleFinal.artifacts.map(artifact => artifact.name).join(', ') || '(无产物)')
  }

  // ② 复杂任务必须派发给至少两个 worker；③ 在 worker WORKING 时发群聊 @ 并校验回复关联。
  const complexTask = await manager.submitChannelTask({
    channelId,
    title: '[mock:complex] 复杂方案核验',
    description: '拆成多个独立部分完成并相互核对。',
  })
  check('复杂任务已提交', complexTask.state === 'SUBMITTED', `state=${complexTask.state}`)

  const withTwoChildren = await waitFor(listTasks, tasks =>
    tasks.filter(task => task.parentId === complexTask.id).length >= 2,
  )
  const currentComplexTasks = withTwoChildren ?? await listTasks()
  let targetWorkerId: string | undefined
  let chatMessageId: string | undefined

  if (withTwoChildren) {
    const children = withTwoChildren.filter(task => task.parentId === complexTask.id)
    check('复杂任务至少创建两个 worker 子任务',
      children.length >= 2 && children.every(child => workerIds.has(child.assigneeId)),
      `children=${children.length}`)
  }
  else {
    const parent = currentComplexTasks.find(task => task.id === complexTask.id)
    const childCount = currentComplexTasks.filter(task => task.parentId === complexTask.id).length
    if (parent?.state === 'FAILED' || parent?.state === 'CANCELED' || parent?.state === 'COMPLETED') {
      report('FAIL', '复杂任务至少创建两个 worker 子任务', `parent=${parent.state}, children=${childCount}`)
    }
    else {
      blocked('复杂任务至少创建两个 worker 子任务', `等待超时，parent=${parent?.state ?? 'missing'}, children=${childCount}`)
    }
    blocked('worker WORKING 时发送 @ 群聊消息', '没有观察到两个复杂任务子任务')
    blocked('worker 完成后 parent 先保持 WAITING', '没有观察到两个复杂任务子任务')
    blocked('lead 按创建顺序验收真实交付后完成 parent', '没有观察到两个复杂任务子任务')
    blocked('chat_messages 回复的 worker/requesterUserId/replyToId 正确', '没有 worker 可接收测试提问')
  }

  if (withTwoChildren) {
    const workingSnapshot = await waitFor(listTasks, tasks =>
      tasks.some(task => task.parentId === complexTask.id && task.state === 'WORKING'),
    )
    const workingChild = workingSnapshot?.find(task =>
      task.parentId === complexTask.id && task.state === 'WORKING',
    )

    if (!workingChild) {
      const parent = (await listTasks()).find(task => task.id === complexTask.id)
      blocked('worker WORKING 时发送 @ 群聊消息', `未观察到 WORKING 子任务，parent=${parent?.state ?? 'missing'}`)
      blocked('worker 完成后 parent 先保持 WAITING', '没有观察到 worker WORKING 阶段')
      blocked('lead 按创建顺序验收真实交付后完成 parent', '没有观察到 worker WORKING 阶段')
      blocked('chat_messages 回复的 worker/requesterUserId/replyToId 正确', '没有可验证的工作中提问')
    }
    else {
      targetWorkerId = workingChild.assigneeId
      const beforeSendTasks = await listTasks()
      const childAtSend = beforeSendTasks.find(task => task.id === workingChild.id)
      const parentAtSend = beforeSendTasks.find(task => task.id === complexTask.id)
      const targetWorker = (await manager.listChannelAgents(channelId)).find(agent => agent.id === targetWorkerId)
      if (!targetWorker) throw new Error(`找不到工作中子任务的 worker ${targetWorkerId}`)

      try {
        const sent = manager.sendChatMessage(channelId, owner, {
          text: `@${targetWorker.name} 子任务仍在执行时请确认当前交付进度。`,
          mentions: [{ type: 'agent', id: targetWorker.id, label: targetWorker.name }],
          clientMessageId: 'agentteam-task-chat-flow-working-question',
        })
        chatMessageId = sent.message.id
        const delivery = sent.deliveries.find(item => item.agentId === targetWorker.id)
        check('worker WORKING 时通过 manager.sendChatMessage 发出 @ 提问',
          childAtSend?.state === 'WORKING'
            && parentAtSend !== undefined
            && !['COMPLETED', 'FAILED', 'CANCELED'].includes(parentAtSend.state)
            && !!delivery
            && delivery.status !== 'failed',
          `parent=${parentAtSend?.state ?? 'missing'}, child=${childAtSend?.state ?? 'missing'}, worker=${targetWorker.name}`)
      }
      catch (error) {
        report('FAIL', 'worker WORKING 时通过 manager.sendChatMessage 发出 @ 提问', errorText(error))
        blocked('chat_messages 回复的 worker/requesterUserId/replyToId 正确', '群聊提问未成功投递')
      }

      // 至少一个 worker 已交付，而另一个仍在执行时，parent 必须继续 WAITING。
      const waitingAfterDelivery = await waitFor(listTasks, tasks => {
        const children = tasks.filter(task => task.parentId === complexTask.id)
        const parent = tasks.find(task => task.id === complexTask.id)
        return parent?.state === 'WAITING'
          && children.some(child => child.state === 'COMPLETED')
          && children.some(child => child.state === 'WORKING')
      })
      if (waitingAfterDelivery) {
        const children = waitingAfterDelivery.filter(task => task.parentId === complexTask.id)
        const parent = waitingAfterDelivery.find(task => task.id === complexTask.id)
        check('worker 已完成部分交付后 parent 仍为 WAITING',
          parent?.state === 'WAITING'
            && children.some(child => child.state === 'COMPLETED')
            && children.some(child => child.state === 'WORKING'),
          `completed=${children.filter(child => child.state === 'COMPLETED').length}, working=${children.filter(child => child.state === 'WORKING').length}`)
      }
      else {
        const latest = await listTasks()
        const parent = latest.find(task => task.id === complexTask.id)
        const children = latest.filter(task => task.parentId === complexTask.id)
        if (parent?.state === 'COMPLETED') {
          report('FAIL', 'worker 已完成部分交付后 parent 仍为 WAITING', '未观察到 WAITING 与部分交付并存的状态')
        }
        else {
          blocked('worker 已完成部分交付后 parent 仍为 WAITING',
            `未观察到验收前窗口，parent=${parent?.state ?? 'missing'}, children=${children.map(child => child.state).join(',')}`)
        }
      }

      const completedSnapshot = await waitFor(listTasks, tasks =>
        tasks.some(task => task.id === complexTask.id && task.state === 'COMPLETED'),
      )
      if (!completedSnapshot) {
        const latest = await listTasks()
        const parent = latest.find(task => task.id === complexTask.id)
        if (parent?.state === 'FAILED' || parent?.state === 'CANCELED') {
          report('FAIL', 'lead 基于 worker 交付完成复杂 parent', `parent=${parent.state}`)
          blocked('lead 按创建顺序验收真实交付', 'parent 未完成')
        }
        else {
          blocked('lead 基于 worker 交付完成复杂 parent', `等待超时，parent=${parent?.state ?? 'missing'}`)
          blocked('lead 按创建顺序验收真实交付', 'parent 未完成')
        }
      }
      else {
        const parent = completedSnapshot.find(task => task.id === complexTask.id)!
        const children = completedSnapshot.filter(task => task.parentId === complexTask.id)
        const acceptance = parent.artifacts.find(artifact => artifact.name === 'lead-acceptance-summary')
        check('复杂 parent 由 lead 产出的 acceptance summary 后 COMPLETED',
          parent.state === 'COMPLETED' && !!acceptance,
          `state=${parent.state}, artifacts=${parent.artifacts.map(artifact => artifact.name).join(', ')}`)

        const orderedAndGrounded = !!acceptance
          && children.length >= 2
          && acceptance.parts.length === children.length
          && children.every((child, index) => {
            const summaryLine = partText(acceptance.parts[index])
            const expectedPrefix = `验收 ${index + 1}/${children.length}｜${child.title}：`
            const deliveredText = child.artifacts
              .filter(artifact => artifact.name !== 'input')
              .flatMap(artifact => artifact.parts.map(partText))
              .filter(Boolean)
            return summaryLine.startsWith(expectedPrefix)
              && deliveredText.length > 0
              && deliveredText.every(text => summaryLine.includes(text))
          })
        check('lead-acceptance-summary 按子任务创建顺序并引用真实交付', orderedAndGrounded,
          acceptance?.parts.map(partText).join(' | ') ?? 'summary missing')
      }

      if (chatMessageId) {
        const readChatReply = () => db!.prepare(
          `SELECT sender_id AS senderId,
                  requester_user_id AS requesterUserId,
                  reply_to_id AS replyToId,
                  source_chat_message_id AS sourceChatMessageId,
                  text
           FROM chat_messages
           WHERE channel_id = ? AND sender_type = 'agent' AND source_chat_message_id = ?
           ORDER BY rowid ASC LIMIT 1`,
        ).get(channelId, chatMessageId) as {
          senderId: string
          requesterUserId: string | null
          replyToId: string | null
          sourceChatMessageId: string | null
          text: string
        } | undefined
        const reply = await waitFor(readChatReply, value => value !== undefined)
        if (!reply) {
          blocked('chat_messages 收到对应 worker 回复', `等待超时，sourceChatMessageId=${chatMessageId}`)
          blocked('worker 回复的 requesterUserId 与 replyToId 正确', '没有找到对应 worker 回复')
        }
        else {
          check('chat_messages 收到对应 worker 回复', reply.senderId === targetWorkerId, `sender=${reply.senderId}`)
          check('worker 回复的 requesterUserId 与 replyToId 正确',
            reply.requesterUserId === owner.id
              && reply.replyToId === chatMessageId
              && reply.sourceChatMessageId === chatMessageId,
            `requester=${reply.requesterUserId}, replyTo=${reply.replyToId}, source=${reply.sourceChatMessageId}`)
        }
      }
    }
  }
}
catch (error) {
  report('FAIL', '集成测试执行异常', errorText(error))
}
finally {
  if (manager) {
    try {
      await manager.shutdown()
    }
    catch (error) {
      report('FAIL', 'manager.shutdown()', errorText(error))
    }
  }
  if (db) {
    try {
      db.close()
    }
    catch (error) {
      report('FAIL', '关闭内存 SQLite', errorText(error))
    }
  }
  try {
    resetUserRepository?.()
  }
  catch (error) {
    report('FAIL', '关闭隔离用户数据库', errorText(error))
  }
}

const passed = outcomes.filter(outcome => outcome === 'PASS').length
const failed = outcomes.filter(outcome => outcome === 'FAIL').length
const blockedCount = outcomes.filter(outcome => outcome === 'BLOCKED').length
const overall: Outcome = failed > 0 ? 'FAIL' : blockedCount > 0 ? 'BLOCKED' : 'PASS'
console.log(`${overall} AgentTeam task/chat integration — ${passed} PASS, ${failed} FAIL, ${blockedCount} BLOCKED`)
console.log(`Isolated AW_DATA_DIR: ${isolatedDataDir}`)
process.exitCode = overall === 'PASS' ? 0 : 1