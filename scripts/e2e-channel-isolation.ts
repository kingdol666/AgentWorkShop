/**
 * 双 Channel 隔离端到端(真实 omp harness):
 *  两个 channel 各自独立 workspace,并行验证:
 *   S1 任务下发 + workspace 隔离:两 channel 同时下发"读 shared.txt 汇报内容"任务,
 *      A 的 worker 只能看到 marker-A,B 只能看到 marker-B(cwd 隔离经真实 omp 子进程验证)
 *   S2 点对点实时通信:A 内 lead↔worker / worker↔worker 触发对话;B 内 worker→lead 触发对话
 *      (真实 LLM 回执,in_reply_to 关联)
 *   S3 channel 隔离:任务不串channel、消息不串channel、monitor 事件流互不污染
 *   S4 监控 + 实时状态:两 channel 各自 monitor 独立事件流;全员最终 idle + 队列空;
 *      queueOverview 每 channel 只返回自己的成员
 *
 * 运行: npx tsx scripts/e2e-channel-isolation.ts(依赖 PATH 上的 omp 与已配置模型)
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { monitorChannel } from '../server/services/workshop/runtime/monitor'
import type { WorkshopMonitor, MonitorEvent } from '../server/services/workshop/runtime/monitor'

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

interface Internals {
  deps: { repos: { messages: {
    listRecentByChannel(channelId: string, limit: number): Array<{ id: string, fromAgentId: string | null, toAgentId: string | null, partsJson: string, metadataJson: string }>
  } } }
  agentIndex: Map<string, unknown>
  getTaskEngine(): {
    get(id: string): { id: string, channelId: string, title: string, state: string, assigneeId: string, parentId?: string, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined
    list(channelId: string): Array<{ id: string, channelId: string, title: string, state: string, assigneeId: string, parentId?: string, artifacts: Array<{ parts: Array<{ text?: string }> }> }>
  }
}

function internalsOf(manager: AgentChannelManager): Internals {
  return manager as unknown as Internals
}

interface Msg { id: string, from: string | null, to: string | null, text: string, metadata: Record<string, unknown> }

function listMessages(manager: AgentChannelManager, channelId: string, limit = 200): Msg[] {
  return internalsOf(manager).deps.repos.messages.listRecentByChannel(channelId, limit).reverse().map(r => ({
    id: r.id,
    from: r.fromAgentId,
    to: r.toAgentId,
    text: (JSON.parse(r.partsJson) as Array<{ text?: string }>).map(p => p.text ?? '').join(' '),
    metadata: JSON.parse(r.metadataJson) as Record<string, unknown>,
  }))
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(100)
  }
  return cond()
}

function ompPidOf(manager: AgentChannelManager, channelId: string, agentId: string): number | null {
  const runtime = internalsOf(manager).agentIndex.get(`${channelId}\u0000${agentId}`) as unknown as {
    impl?: { client?: { child?: { pid?: number } } }
  } | undefined
  return runtime?.impl?.client?.child?.pid ?? null
}

/** 全部任务 artifacts 文本 */
function artifactTexts(manager: AgentChannelManager, channelId: string): string[] {
  const engine = internalsOf(manager).getTaskEngine()
  return engine.list(channelId).flatMap(t => t.artifacts.flatMap(a => a.parts.map(p => p.text ?? '')))
}

const TIMING = { task: 240_000, dialog: 180_000, idle: 60_000 }

interface Team {
  channelId: string
  workspace: string
  marker: string
  leadId: string
  workers: Array<{ id: string, name: string }>
  memberIds: string[]
  mon: WorkshopMonitor
}

async function buildTeam(
  manager: AgentChannelManager,
  name: string,
  workspace: string,
  marker: string,
): Promise<Team> {
  writeFileSync(resolve(workspace, 'shared.txt'), `marker:${marker}`, 'utf8')
  const ch = await manager.createChannel({
    name,
    workspace,
    leadAgent: { name: `${name}-lead`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } },
  })
  const wTpl1 = await manager.createAgent({ name: `${name}-w1`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } })
  const wTpl2 = await manager.createAgent({ name: `${name}-w2`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.2' } })
  const i1 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl1.id, role: 'worker' })
  const i2 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl2.id, role: 'worker' })
  // 先激活(装配 bus),monitor 订阅才有效
  manager.ensureChannelActive(ch.channelId)
  const mon = monitorChannel(manager, ch.channelId)
  const members = await manager.listChannelAgents(ch.channelId)
  return {
    channelId: ch.channelId,
    workspace,
    marker,
    leadId: members.find(m => m.role === 'lead')?.id ?? '',
    workers: [i1, i2].map(w => ({ id: w.id, name: w.name })),
    memberIds: members.map(m => m.id),
    mon,
  }
}

/** monitor 事件流泄漏检查:本 monitor 是否出现对方 channel 的成员/任务 id */
function monitorSawIdsOf(mon: WorkshopMonitor, otherMemberIds: string[], otherTaskIds: string[]): { leakedAgentIds: string[], leakedTaskIds: string[] } {
  const leakedAgentIds: string[] = []
  const leakedTaskIds: string[] = []
  for (const e of mon.events) {
    const ev = e as MonitorEvent & { agentId?: string, taskId?: string }
    if (ev.agentId && otherMemberIds.includes(ev.agentId)) leakedAgentIds.push(ev.agentId)
    if (ev.taskId && otherTaskIds.includes(ev.taskId)) leakedTaskIds.push(ev.taskId)
  }
  return { leakedAgentIds, leakedTaskIds }
}

async function main(): Promise<void> {
  console.log('━━━ 双 Channel 隔离端到端(真实 omp):任务下发 + 点对点实时通信 + 隔离 + 监控 ━━━')
  const root = resolve(process.cwd(), '.tmp-e2e-iso')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    // ---- 组队:两个 channel,各自独立 workspace ----
    mkdirSync(resolve(root, 'A'), { recursive: true })
    mkdirSync(resolve(root, 'B'), { recursive: true })
    const teamA = await buildTeam(manager, '频道A', resolve(root, 'A'), 'CHANNEL-ALPHA-7734')
    const teamB = await buildTeam(manager, '频道B', resolve(root, 'B'), 'CHANNEL-BETA-9918')
    const engine = internalsOf(manager).getTaskEngine()
    console.log(`  A: ${teamA.channelId.slice(0, 8)} ws=${teamA.workspace}`)
    console.log(`  B: ${teamB.channelId.slice(0, 8)} ws=${teamB.workspace}`)

    // ---- S1 任务下发 + workspace 隔离(两 channel 并行)----
    console.log('\n━━━ S1. 任务下发 + workspace 隔离 ━━━')
    const taskDesc = (marker: string) =>
      `Read the file shared.txt in your working directory and report its EXACT full content (it starts with "marker:"). Then call complete_task with the file content as the deliverable. Expected prefix: "marker:${marker}" — but report what you actually read.`
    const taskA = await manager.submitChannelTask({ channelId: teamA.channelId, title: '读取共享文件', description: taskDesc(teamA.marker) })
    const taskB = await manager.submitChannelTask({ channelId: teamB.channelId, title: '读取共享文件', description: taskDesc(teamB.marker) })

    const bothDone = await waitFor(() =>
      engine.get(taskA.id)?.state === 'COMPLETED' && engine.get(taskB.id)?.state === 'COMPLETED',
    TIMING.task)
    check('S1: 两 channel 任务并行下发并全部完成', bothDone,
      `A=${engine.get(taskA.id)?.state} B=${engine.get(taskB.id)?.state}`)

    // 子任务下发到本 channel worker(任务下发链路)
    const childA = engine.list(teamA.channelId).find(t => t.parentId === taskA.id)
    check('S1: A 的 lead 把任务下发给本 channel worker', !!childA && teamA.workers.some(w => w.id === childA.assigneeId),
      childA ? `assignee=${childA.assigneeId.slice(0, 8)} state=${childA.state}` : 'no child')
    const childB = engine.list(teamB.channelId).find(t => t.parentId === taskB.id)
    check('S1: B 的 lead 把任务下发给本 channel worker', !!childB && teamB.workers.some(w => w.id === childB.assigneeId),
      childB ? `assignee=${childB.assigneeId.slice(0, 8)} state=${childB.state}` : 'no child')

    // workspace 隔离:成果内容验证
    const textsA = artifactTexts(manager, teamA.channelId).join('\n')
    const textsB = artifactTexts(manager, teamB.channelId).join('\n')
    check('S1: A 成果含本 workspace 标记', textsA.includes(teamA.marker), textsA.slice(0, 60))
    check('S1: A 成果不含 B 的标记', !textsA.includes(teamB.marker))
    check('S1: B 成果含本 workspace 标记', textsB.includes(teamB.marker), textsB.slice(0, 60))
    check('S1: B 成果不含 A 的标记', !textsB.includes(teamA.marker))

    // ---- S2 点对点实时通信(两 channel 并行;真实 LLM 回执)----
    console.log('\n━━━ S2. 点对点实时通信(触发器回执)━━━')
    const m1 = await manager.sendImmediateMessage({
      channelId: teamA.channelId, fromAgentId: teamA.leadId, toAgentId: teamA.workers[0].id,
      parts: [{ text: 'What is 2+3? Answer with just the number.' }], requireReply: true,
    })
    const m2 = await manager.sendA2A(teamA.channelId, teamA.workers[0].id, {
      toAgentId: teamA.workers[1].id,
      parts: [{ text: 'What is 10-4? Answer with just the number.' }],
      metadata: { 'x-aw-msg-priority': 'task', 'x-aw-require-reply': 'true' },
    })
    const m3 = await manager.sendImmediateMessage({
      channelId: teamB.channelId, fromAgentId: teamB.workers[0].id, toAgentId: teamB.leadId,
      parts: [{ text: 'What is 6*7? Answer with just the number.' }], requireReply: true,
    })

    const [r1, r2, r3] = await Promise.all([
      (async () => {
        const deadline = Date.now() + TIMING.dialog
        while (Date.now() < deadline) {
          const hit = listMessages(manager, teamA.channelId).find(x => x.metadata['x-aw-in-reply-to'] === m1.messageId)
          if (hit) return hit
          await sleep(150)
        }
        return null
      })(),
      (async () => {
        const deadline = Date.now() + TIMING.dialog
        while (Date.now() < deadline) {
          const hit = listMessages(manager, teamA.channelId).find(x => x.metadata['x-aw-in-reply-to'] === m2.messageId)
          if (hit) return hit
          await sleep(150)
        }
        return null
      })(),
      (async () => {
        const deadline = Date.now() + TIMING.dialog
        while (Date.now() < deadline) {
          const hit = listMessages(manager, teamB.channelId).find(x => x.metadata['x-aw-in-reply-to'] === m3.messageId)
          if (hit) return hit
          await sleep(150)
        }
        return null
      })(),
    ])

    check('S2: A lead→worker 回执(2+3)', r1 !== null && r1.text.includes('5'), r1?.text.slice(0, 60) ?? 'timeout')
    check('S2: A lead→worker in_reply_to 关联', r1?.metadata['x-aw-in-reply-to'] === m1.messageId)
    check('S2: A worker↔worker 回执(10-4)', r2 !== null && r2.text.includes('6'), r2?.text.slice(0, 60) ?? 'timeout')
    check('S2: A worker↔worker in_reply_to 关联', r2?.metadata['x-aw-in-reply-to'] === m2.messageId)
    check('S2: B worker→lead 回执(6*7)', r3 !== null && r3.text.includes('42'), r3?.text.slice(0, 60) ?? 'timeout')
    check('S2: B worker→lead in_reply_to 关联', r3?.metadata['x-aw-in-reply-to'] === m3.messageId)

    // ---- S3 channel 隔离 ----
    console.log('\n━━━ S3. Channel 隔离 ━━━')
    const tasksA = engine.list(teamA.channelId)
    const tasksB = engine.list(teamB.channelId)
    check('S3: 任务不串 channel', !tasksA.some(t => t.channelId !== teamA.channelId) && !tasksB.some(t => t.channelId !== teamB.channelId),
      `A=${tasksA.length} B=${tasksB.length}`)
    const msgA = listMessages(manager, teamA.channelId)
    const msgB = listMessages(manager, teamB.channelId)
    check('S3: 消息不串 channel', !msgA.some(m => teamB.memberIds.includes(m.to ?? '')) && !msgB.some(m => teamA.memberIds.includes(m.to ?? '')))
    // monitor 事件流隔离:A 的 monitor 不含 B 的成员/任务事件
    const taskIdsB = engine.list(teamB.channelId).map(t => t.id)
    const taskIdsA = engine.list(teamA.channelId).map(t => t.id)
    const leakA = monitorSawIdsOf(teamA.mon, teamB.memberIds, taskIdsB)
    const leakB = monitorSawIdsOf(teamB.mon, teamA.memberIds, taskIdsA)
    check('S3: A monitor 无 B 成员事件泄漏', leakA.leakedAgentIds.length === 0, leakA.leakedAgentIds.join(',').slice(0, 40))
    check('S3: A monitor 无 B 任务事件泄漏', leakA.leakedTaskIds.length === 0, `n=${leakA.leakedTaskIds.length}`)
    check('S3: B monitor 无 A 成员事件泄漏', leakB.leakedAgentIds.length === 0, leakB.leakedAgentIds.join(',').slice(0, 40))
    check('S3: B monitor 无 A 任务事件泄漏', leakB.leakedTaskIds.length === 0, `n=${leakB.leakedTaskIds.length}`)

    // ---- S4 监控 + 实时状态 ----
    console.log('\n━━━ S4. 监控与实时状态 ━━━')
    const evA = teamA.mon.events
    const evB = teamB.mon.events
    check('S4: A monitor 捕获本 channel 任务完成', evA.some(e => e.kind === 'task.status' && e.taskId === taskA.id && e.state === 'COMPLETED'),
      `events=${evA.length}`)
    check('S4: B monitor 捕获本 channel 任务完成', evB.some(e => e.kind === 'task.status' && e.taskId === taskB.id && e.state === 'COMPLETED'),
      `events=${evB.length}`)
    check('S4: busy 事件携带 currentTaskId', evA.some(e => e.kind === 'agent.status' && e.state === 'busy' && e.currentTaskId != null))

    // 全员最终 idle(未装配成员 runtimeState=null 视同空闲;装配过的须 idle)
    const allIdle = await waitFor(() => {
      return [teamA, teamB].every(t =>
        t.memberIds.every((id) => {
          const s = manager.getChannelAgent(id)?.runtimeState
          return s === null || s === 'idle'
        }))
    }, TIMING.idle)
    check('S4: 两 channel 全员最终 idle', allIdle)

    const overviewA = await manager.queueOverview(teamA.channelId, teamA.leadId)
    const overviewB = await manager.queueOverview(teamB.channelId, teamB.leadId)
    check('S4: A queueOverview 仅含本 channel 3 成员', overviewA.length === 3 && overviewA.every(s => teamA.memberIds.includes(s.agentId)))
    check('S4: B queueOverview 仅含本 channel 3 成员', overviewB.length === 3 && overviewB.every(s => teamB.memberIds.includes(s.agentId)))
    check('S4: 全员队列已清空', overviewA.every(s => s.queuedCount === 0) && overviewB.every(s => s.queuedCount === 0))

    // 独立进程:两 channel 全部已装配成员 PID 互不相同
    const pids = [...teamA.memberIds.map(id => ompPidOf(manager, teamA.channelId, id)),
      ...teamB.memberIds.map(id => ompPidOf(manager, teamB.channelId, id))].filter(p => p !== null)
    check('S4: 双 channel 子进程 PID 全部互异', new Set(pids).size === pids.length, `spawned=${pids.length} pids=${pids.join(',')}`)
  }
  finally {
    await manager.shutdown()
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
