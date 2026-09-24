/**
 * Isolated end-to-end AgentTeam flow using a real omp Lead and two real omp workers.
 *
 * Run manually: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-agentteam-task-flow-real.ts
 * This script intentionally uses temporary data/report directories and never writes .gw* files.
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

const A_TIMEOUT_MS = 240_000
const B_TIMEOUT_MS = 900_000
const CLEANUP_TIMEOUT_MS = 20_000
const POLL_MS = 50

class FlowFailure extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FlowFailure(`${label} 超时(${timeoutMs}ms)`)), timeoutMs)
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

function requireCheck(name: string, condition: boolean): void {
  if (!condition) throw new FlowFailure(`断言失败: ${name}`)
  console.log(`PASS  ${name}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function artifactText(task: WorkspaceTask): string[] {
  return task.artifacts
    .filter(artifact => artifact.name !== 'input')
    .flatMap(artifact => artifact.parts.flatMap(part => 'text' in part ? [part.text] : []))
    .map(text => text.trim())
    .filter(Boolean)
}

async function main(): Promise<void> {
  let exitCode = 0
  let phase = '初始化隔离环境'
  let dataDir: string | undefined
  let reportPath: string | undefined
  let db: DatabaseSync | undefined
  let manager: AgentChannelManager | undefined
  let unsubscribeTaskEvents: (() => void) | undefined
  const report: string[] = [
    'AgentTeam real Harness E2E',
    `startedAt=${new Date().toISOString()}`,
  ]
  const log = (line: string): void => {
    report.push(line)
    console.log(line)
  }

  try {
    dataDir = mkdtempSync(join(tmpdir(), 'aw-agentteam-task-flow-data-'))
    const reportDir = mkdtempSync(join(tmpdir(), 'aw-agentteam-task-flow-report-'))
    reportPath = join(reportDir, `report-${Date.now()}.txt`)
    process.env.AW_DATA_DIR = dataDir
    process.env.AGENTWORKSHOP_TEST = '1'

    phase = 'omp Harness 预检'
    const { checkHarnessAvailability } = await import('../server/services/workshop/agents/harness-availability')
    const availability = checkHarnessAvailability('omp', undefined, { refresh: true })
    if (!availability.available) {
      exitCode = 2
      log('BLOCKED: omp Harness 当前不可用或无法从 PATH 定位；未创建运行时。')
      return
    }
    log('omp Harness 预检可用。')

    phase = '隔离数据库与 manager 装配'
    const [{ openWorkshopDb }, channelEventRepo, channelRepo, agentRepo, teamRepo, teamMemberRepo,
      channelTemplateRepo, channelAgentRepo, messageRepo, subscriptionRepo, taskRepo, memoryRepo,
      scheduledTaskRepo, userRepo, channelMemberRepo, chatMessageRepo, notificationRepo, outboxRepo,
      hitlRequestRepo, managerModule, { createAgentImpl }] = await Promise.all([
      import('../server/services/workshop/db/database'),
      import('../server/services/workshop/db/channel-event.repo'),
      import('../server/services/workshop/db/channel.repo'),
      import('../server/services/workshop/db/agent.repo'),
      import('../server/services/workshop/db/team.repo'),
      import('../server/services/workshop/db/team-member.repo'),
      import('../server/services/workshop/db/channel-template.repo'),
      import('../server/services/workshop/db/channel-agent.repo'),
      import('../server/services/workshop/db/message.repo'),
      import('../server/services/workshop/db/subscription.repo'),
      import('../server/services/workshop/db/task.repo'),
      import('../server/services/workshop/db/memory.repo'),
      import('../server/services/workshop/db/scheduled-task.repo'),
      import('../server/services/workshop/db/user.repo'),
      import('../server/services/workshop/db/channel-member.repo'),
      import('../server/services/workshop/db/chat-message.repo'),
      import('../server/services/workshop/db/notification.repo'),
      import('../server/services/workshop/db/outbox.repo'),
      import('../server/services/workshop/db/hitl-request.repo'),
      import('../server/services/workshop/runtime/manager'),
      import('../server/services/workshop/agents/factory'),
    ])
    db = openWorkshopDb(':memory:')
    manager = managerModule.createAgentChannelManager({
      repos: {
        users: userRepo.createUserRepo(db),
        channelEvents: channelEventRepo.createChannelEventRepo(db),
        channels: channelRepo.createChannelRepo(db),
        agents: agentRepo.createAgentRepo(db),
        teams: teamRepo.createTeamRepo(db),
        teamMembers: teamMemberRepo.createTeamMemberRepo(db),
        channelTemplates: channelTemplateRepo.createChannelTemplateRepo(db),
        channelAgents: channelAgentRepo.createChannelAgentRepo(db),
        messages: messageRepo.createMessageRepo(db),
        subscriptions: subscriptionRepo.createSubscriptionRepo(db),
        tasks: taskRepo.createTaskRepo(db),
        memories: memoryRepo.createMemoryRepo(db),
        schedules: scheduledTaskRepo.createScheduledTaskRepo(db),
        channelMembers: channelMemberRepo.createChannelMemberRepo(db),
        chatMessages: chatMessageRepo.createChatMessageRepo(db),
        notifications: notificationRepo.createNotificationRepo(db),
        outbox: outboxRepo.createOutboxRepo(db),
        hitlRequests: hitlRequestRepo.createHitlRequestRepo(db),
      },
      implFactory: createAgentImpl,
      db,
    })

    phase = '创建真实 omp Lead 与两个真实 omp worker'
    const leadConfig = {
      promptTimeoutMs: 180_000,
      superviseTimeoutMs: 90_000,
      systemPromptPrefix: 'Be concise. Do not delegate a one-step task. For multi-step tasks, follow the requested worker assignment and acceptance order exactly.',
    }
    const workerConfig = {
      promptTimeoutMs: 180_000,
      superviseTimeoutMs: 90_000,
      systemPromptPrefix: 'For assigned work, produce a concrete deliverable and call complete_task. When you receive a group-chat question asking for a short acknowledgement, reply to it briefly and then continue your assigned work.',
    }
    const owner = manager.deps.repos.users.create('agentteam-e2e-owner')
    const ownerActor = { id: owner.id }
    const channel = await manager.createChannel({
      name: `real-agentteam-${Date.now()}`,
      description: 'Isolated real omp AgentTeam task-flow test',
      workspace: join(dataDir!, 'workspace'),
      ownerUserId: owner.id,
      leadAgent: { name: 'e2e-lead', harness: 'omp', config: leadConfig },
    })
    if (!channel.leadAgentId) throw new FlowFailure('Channel 未创建 Lead 实例。')

    const researchTemplate = await manager.createAgent({
      name: 'e2e-research-specialist',
      harness: 'omp',
      config: {
        ...workerConfig,
        systemPromptPrefix: `${workerConfig.systemPromptPrefix} Research specialist: carefully inspect the supplied fact and report a concise evidence-based conclusion.`,
      },
    })
    const calculationTemplate = await manager.createAgent({
      name: 'e2e-calculation-specialist',
      harness: 'omp',
      config: {
        ...workerConfig,
        systemPromptPrefix: `${workerConfig.systemPromptPrefix} Calculation specialist: independently verify the requested arithmetic and show the calculation.`,
      },
    })
    const researchWorker = await manager.addAgentToChannel({
      channelId: channel.channelId,
      agentId: researchTemplate.id,
      role: 'worker',
    })
    const calculationWorker = await manager.addAgentToChannel({
      channelId: channel.channelId,
      agentId: calculationTemplate.id,
      role: 'worker',
    })
    await manager.updateChannel(channel.channelId, {
      visibility: 'public',
      joinPolicy: 'open',
      chatEnabled: 1,
    })
    manager.ensureChannelActive(channel.channelId, { tickMs: 100, stallMs: 240_000 })

    const memberRows = db.prepare(
      `SELECT id, role, harness, enabled FROM channel_agents WHERE channel_id = ? ORDER BY rowid`,
    ).all(channel.channelId) as Array<{ id: string, role: string, harness: string, enabled: number }>
    requireCheck(
      'channel 实例包含 1 个 omp Lead 与至少 2 个 omp worker',
      memberRows.filter(row => row.role === 'lead' && row.harness === 'omp' && row.enabled === 1).length === 1
      && memberRows.filter(row => row.role === 'worker' && row.harness === 'omp' && row.enabled === 1).length >= 2,
    )
    requireCheck(
      '两个 worker 是不同的真实 omp 实例',
      researchWorker.harness === 'omp' && calculationWorker.harness === 'omp'
      && researchWorker.id !== calculationWorker.id,
    )

    const taskEvents: Array<{ taskId: string, state: string, agentId?: string }> = []
    unsubscribeTaskEvents = manager.subscribeTaskEvents(channel.channelId, (event) => {
      if (event.state) taskEvents.push({ taskId: event.taskId, state: event.state, agentId: event.agentId })
    })
    const allTasks = (): Promise<WorkspaceTask[]> => manager!.listTasks(channel.channelId, channel.leadAgentId!)
    const getTask = (taskId: string): Promise<WorkspaceTask> => manager!.getTask(channel.channelId, channel.leadAgentId!, taskId)

    phase = 'A 简单任务由 Lead 独立完成'
    log('A: 提交要求一句精确回答的简单任务；预期 Lead 直接完成且不创建 worker 子任务。')
    const simpleTask = await manager.submitChannelTask({
      channelId: channel.channelId,
      title: 'A — Lead 简单回答',
      description: '这是一步简单任务，不要创建或委派任何子任务。请使用 complete_task 完成，deliverable 必须严格等于这一个中文句子：简单任务由Lead独立完成。不要输出第二句话。',
      fromLabel: owner.name,
    })
    const simpleDeadline = Date.now() + A_TIMEOUT_MS
    let simple = await getTask(simpleTask.id)
    while (!['COMPLETED', 'FAILED', 'CANCELED'].includes(simple.state) && Date.now() < simpleDeadline) {
      await sleep(250)
      simple = await getTask(simpleTask.id)
    }
    requireCheck('A 在有界时间内由 Lead 完成', simple.state === 'COMPLETED' && simple.assigneeId === channel.leadAgentId)
    const simpleChildren = (await allTasks()).filter(task => task.parentId === simple.id)
    requireCheck('A 未创建任何 worker 子任务', simpleChildren.length === 0)
    const simpleOutput = artifactText(simple)
    requireCheck('A 的 deliverable 是要求的一句回答', simpleOutput.some(text => text === '简单任务由Lead独立完成。'))
    const simpleCompletionEvent = taskEvents.find(event => event.taskId === simple.id && event.state === 'COMPLETED')
    requireCheck('A 的终态事件记录由 Lead 收口', simpleCompletionEvent?.agentId === channel.leadAgentId)

    phase = 'B 准备群聊回复锚点'
    const anchor = manager.sendChatMessage(channel.channelId, ownerActor, {
      text: 'E2E 群聊回复关联锚点。',
      clientMessageId: `agentteam-anchor-${Date.now()}`,
    })

    phase = 'B 两个专业子任务、执行中群聊与 Lead 验收'
    log('B: Lead 按顺序派发两个独立专业子任务；第一个 worker 运行时插入 @worker 群聊消息。')
    const parent = await manager.submitChannelTask({
      channelId: channel.channelId,
      title: 'B — 两个独立专业子任务与验收总结',
      description: [
        '这是必须由你监督并验收的双专业任务。严格按以下顺序执行，不要并行派发：',
        `1. 先将一个独立的研究核查子任务派给 ${researchWorker.name}。子任务请核查“标准大气压下水约在 100°C 沸腾”这一事实，交付明确结论。等待该 worker 状态为 COMPLETED 后，检查它的实际交付物。`,
        `2. 之后再创建第二个、与研究核查独立的计算校验子任务，派给 ${calculationWorker.name}。请核算 17 + 25，并检查实际交付物。`,
        '两个子任务必须各创建一次、分别交给上述不同 worker，且按创建顺序完成。',
        '3. 你必须阅读并检查两个已完成子任务的交付物，然后调用 complete_task 完成父任务；deliverable 写一段明确的验收总结，分别记录两项结果及检查结论。',
        '不要把父任务委派给 worker，不要在任一子任务完成前完成父任务。',
      ].join('\n'),
      fromLabel: owner.name,
    })
    const chatRowById = db.prepare(
      `SELECT id, sender_id AS senderId, reply_to_id AS replyToId,
              requester_user_id AS requesterUserId, source_chat_message_id AS sourceChatMessageId
       FROM chat_messages WHERE id = ?`,
    )
    const inboundChatId: { value: string | null } = { value: null }
    let chatSent = false
    let replyValidated = false
    let parentState: WorkspaceTask | undefined
    let children: WorkspaceTask[] = []
    const flowDeadline = Date.now() + B_TIMEOUT_MS

    while (Date.now() < flowDeadline) {
      const listed = await allTasks()
      children = listed.filter(task => task.parentId === parent.id)
      parentState = await getTask(parent.id)

      if (!chatSent) {
        const activeChild = children.find(task => task.state === 'WORKING')
        if (activeChild) {
          const worker = [researchWorker, calculationWorker].find(agent => agent.id === activeChild.assigneeId)
          if (!worker) throw new FlowFailure('B 观察到由非预期 worker 执行的子任务。')
          const sent = manager.sendChatMessage(channel.channelId, ownerActor, {
            text: `@${worker.name} 请只用一句话回复：收到群聊。然后继续当前子任务。`,
            mentions: [{ type: 'agent', id: worker.id }],
            replyToId: anchor.message.id,
            clientMessageId: `agentteam-running-chat-${Date.now()}`,
          })
          if (sent.deliveries.length !== 1 || sent.deliveries[0]?.agentId !== worker.id || sent.deliveries[0]?.status === 'failed') {
            throw new FlowFailure('运行中 @worker 群聊消息未能投递给正在工作的 worker。')
          }
          inboundChatId.value = sent.message.id
          const inbound = chatRowById.get(sent.message.id) as {
            id: string
            senderId: string
            replyToId: string | null
            requesterUserId: string | null
            sourceChatMessageId: string | null
          } | undefined
          requireCheck(
            '运行中群聊消息 @ 到 WORKING worker，且 replyToId 指向锚点',
            activeChild.state === 'WORKING'
            && inbound?.senderId === owner.id
            && inbound.requesterUserId === owner.id
            && inbound.replyToId === anchor.message.id,
          )
          chatSent = true
        }
      }

      if (chatSent && !replyValidated && inboundChatId.value) {
        const reply = db.prepare(
          `SELECT sender_id AS senderId, requester_user_id AS requesterUserId,
                  source_chat_message_id AS sourceChatMessageId, reply_to_id AS replyToId
           FROM chat_messages
           WHERE channel_id = ? AND sender_type = 'agent' AND source_chat_message_id = ?
           ORDER BY rowid LIMIT 1`,
        ).get(channel.channelId, inboundChatId.value) as {
          senderId: string
          requesterUserId: string | null
          sourceChatMessageId: string | null
          replyToId: string | null
        } | undefined
        if (reply) {
          requireCheck('agent 群聊回复 sourceChatMessageId 回指 @worker 消息', reply.sourceChatMessageId === inboundChatId.value)
          requireCheck('agent 群聊回复 requesterUserId 回指发起用户', reply.requesterUserId === owner.id)
          requireCheck('agent 群聊回复 replyToId 与 sourceChatMessageId 一致', reply.replyToId === inboundChatId.value)
          requireCheck('群聊回复来自被 @ 且执行子任务的 worker', children.some(task => task.assigneeId === reply.senderId))
          replyValidated = true
        }
      }
      if (parentState.state === 'COMPLETED' || parentState.state === 'FAILED' || parentState.state === 'CANCELED') {
        if (!chatSent || !replyValidated) {
          await sleep(POLL_MS)
          continue
        }
        break
      }
      await sleep(POLL_MS)
    }

    requireCheck('B 群聊在有界时间内实际 @ 到运行中的 worker', chatSent)
    requireCheck('B 群聊关联字段回复在有界时间内全部落库', replyValidated)
    requireCheck('B 父任务在有界时间内完成', parentState?.state === 'COMPLETED')

    const finalTasks = await allTasks()
    children = finalTasks.filter(task => task.parentId === parent.id)
    requireCheck('B 恰好创建两个子任务', children.length === 2)
    requireCheck(
      'B 子任务按研究 → 计算的创建顺序分派给两个不同 worker',
      children[0]?.assigneeId === researchWorker.id
      && children[1]?.assigneeId === calculationWorker.id
      && children[0]?.createdAt <= children[1]!.createdAt,
    )
    requireCheck('B 两个 worker 子任务均记录为 COMPLETED', children.every(task => task.state === 'COMPLETED'))
    requireCheck('B 两个 worker 都提交了非空交付物', children.every(task => artifactText(task).length > 0))
    requireCheck(
      'B 研究与计算交付物分别覆盖指定结论',
      artifactText(children[0]!).some(text => text.includes('100'))
      && artifactText(children[1]!).some(text => text.includes('42')),
    )

    const childCompletionEvents = taskEvents.filter(event =>
      children.some(task => task.id === event.taskId) && event.state === 'COMPLETED',
    )
    requireCheck(
      'B worker COMPLETED 事件按子任务创建顺序发生',
      childCompletionEvents.length === 2
      && childCompletionEvents[0]?.taskId === children[0]?.id
      && childCompletionEvents[1]?.taskId === children[1]?.id
      && childCompletionEvents[0]?.agentId === researchWorker.id
      && childCompletionEvents[1]?.agentId === calculationWorker.id,
    )
    const parentCompletionEvent = taskEvents.find(event => event.taskId === parent.id && event.state === 'COMPLETED')
    requireCheck(
      'B Lead 在两个 worker 完成之后收口父任务',
      !!parentCompletionEvent
      && parentCompletionEvent.agentId === channel.leadAgentId
      && childCompletionEvents.every(event => taskEvents.indexOf(event) < taskEvents.indexOf(parentCompletionEvent)),
    )
    const completedParent = await getTask(parent.id)
    const summary = completedParent.artifacts
      .filter(artifact => artifact.name !== 'input')
      .flatMap(artifact => artifact.parts.flatMap(part => 'text' in part ? [part.text.trim()] : []))
      .filter(Boolean)
    requireCheck(
      'B Lead 验收后为父任务写入包含两项结果的 summary/deliverable',
      summary.some(text => text.length >= 30 && text.includes('100') && text.includes('42')),
    )
    log('PASS: A Lead 独立完成；B 两个真实 omp worker 按创建顺序交付并由 Lead 验收；运行中群聊回复关联字段完整。')
    log(`隔离 AW_DATA_DIR: ${dataDir}`)
    log(`独立报告文件: ${reportPath}`)
  }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
    if (code === 'HARNESS_UNAVAILABLE') {
      exitCode = 2
      log('BLOCKED: omp Harness 在装配或启动时变为不可用；敏感错误详情已省略。')
    }
    else {
      exitCode = 1
      const detail = error instanceof FlowFailure ? error.message : '非预期运行错误；为避免泄漏凭据，异常详情已省略。'
      log(`FAIL: 阶段「${phase}」失败：${detail}`)
    }
  }
  finally {
    unsubscribeTaskEvents?.()
    if (manager) {
      try {
        await withTimeout(manager.shutdown(), CLEANUP_TIMEOUT_MS, 'manager.shutdown')
      }
      catch {
        exitCode = exitCode || 1
        log('CLEANUP WARNING: manager.shutdown 未能在有界时间内完成。')
      }
    }
    if (db) {
      try {
        // SchedulerLoop.stop() is synchronous but an in-flight tick may still be unwinding;
        // let it observe stopped state before closing SQLite statements.\n        await sleep(250)
        db.close()
      }
      catch {
        exitCode = exitCode || 1
        log('CLEANUP WARNING: 隔离内存数据库关闭失败。')
      }
    }
    report.push(`finishedAt=${new Date().toISOString()}`, `exitCode=${exitCode}`)
    if (reportPath) {
      try {
        writeFileSync(reportPath, `${report.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
      }
      catch {
        console.error('报告写入失败；未覆盖任何既有文件。')
        exitCode = exitCode || 1
      }
      console.log(`Report: ${reportPath}`)
    }
    process.exitCode = exitCode
  }
}

void main()
