/** Deterministic verification of supervision watchdog semantics.
 * The watchdog must notify/steer the same active Lead turn without aborting it;
 * only the separate hard timeout may abort.
 */
import { randomUUID } from 'node:crypto'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { Mailbox } from '../server/services/workshop/runtime/mailbox'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import type { AgentEvent, AgentInfo, AgentInterface, AgentRunContext, SupervisionDecision, SupervisionSnapshot, AgentWorkspace } from '../server/services/workshop/agents/agent-interface'
import type { ChannelBus, TaskEngine } from '../server/services/workshop/runtime/agent-runtime'
import type { AgentTaskQueueView, WorkspaceTask } from '../server/services/workshop/types/task'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const assert = (name: string, value: boolean): void => {
  console.log(`${value ? 'PASS' : 'FAIL'}  ${name}`)
  if (!value) process.exitCode = 1
}

const db = openWorkshopDb(':memory:')
const messages = createMessageRepo(db)
const statusEvents: Array<{ supervision?: { state: string, watchdogCount: number } }> = []
const bus: ChannelBus = {
  emit: () => {},
  onEvent: () => () => {},
  notifyTask: () => {},
  onTaskEvent: () => () => {},
  notifyAgent: e => statusEvents.push({ supervision: e.supervision }),
  onAgentStatus: () => () => {},
  wakeScheduler: () => {},
  notifyMessage: () => {},
  onMessage: () => () => {},
  notifyMember: () => {},
  onMemberEvent: () => () => {},
  notifyMemory: () => {},
  onMemoryEvent: () => () => {},
}
const taskEngine = {
  queueViewOf: (channelId: string, agentId: string): AgentTaskQueueView => ({ agentId, channelId, queued: [], completed: [] }),
  get: (_id: string): WorkspaceTask | undefined => undefined,
  list: (_channelId: string): WorkspaceTask[] => [],
} as unknown as TaskEngine

let steerCalls = 0
let aborted = false
let signal: AbortSignal | undefined
const signals: Array<{ kind: string }> = []
const impl: AgentInterface = {
  async* run(): AsyncIterable<AgentEvent> {},
  getSupervisionPolicy: () => ({ watchdogMs: 1_000, hardTimeoutMs: 3_000 }),
  steer: async () => {
    steerCalls += 1
    return 'steer'
  },
  supervise: async (_snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> => {
    signal = ctx.signal
    ctx.signal.addEventListener('abort', () => {
      aborted = true
    }, { once: true })
    await sleep(1_200)
    return [{ kind: 'wait', reason: 'worker still progressing' }]
  },
}
const agent: AgentInfo = {
  id: randomUUID(), channelId: 'watchdog-channel', name: 'watchdog-lead', harness: 'mock', role: 'lead', config: {},
}
const rt = new AgentRuntime(agent, impl, {
  mailbox: new Mailbox(messages, agent.channelId, agent.id, () => {}),
  taskEngine,
  bus,
  workspace: {} as AgentWorkspace,
  // §7.1 supervise.watchdog:平台侧回调(生产装配下由 manager 落 Channel 共享记忆)
  onSupervisionSignal: e => signals.push(e),
})
const snapshot: SupervisionSnapshot = {
  tick: 1,
  now: Date.now(),
  tasks: [],
  members: [{ agentId: agent.id, name: agent.name, role: 'lead', state: 'busy', queued: 0, currentTaskId: null, currentTaskTitle: null, currentTaskProgress: null, completedCount: 0, stalled: false }],
  pendingChildren: {},
  activeRootId: null,
  queuedRootIds: [],
}

const decisions = await rt.supervise(snapshot)
await sleep(20)
assert('supervise watchdog returns explicit wait decision', decisions[0]?.kind === 'wait')
assert('watchdog steers the existing session', steerCalls >= 1)
assert('watchdog does not abort current turn', !aborted && signal?.aborted !== true)
assert('watchdog status was observable', statusEvents.some(e => e.supervision?.state === 'WATCHDOG_SIGNALED' && (e.supervision.watchdogCount ?? 0) >= 1))
// §4.1 状态机:… → DECISION_APPLIED → IDLE(attempt 落定即结束,审计信息保留在
// completedAt/lastDecisionKind)—— 这是 §6.1「无 active supervise attempt」闸门成立的前提。
const settled = rt.getSupervisionStatus()
assert('supervision settles back to IDLE', settled.state === 'IDLE')
assert('settled attempt keeps audit fields', settled.completedAt != null && settled.lastDecisionKind === 'wait')
assert('no active supervision attempt after settle', !rt.hasActiveSupervisionAttempt())
// §7.1 supervise.watchdog:监督信号必须交给 manager 落共享记忆(生产装配下)
assert('watchdog signal was reported for shared memory', signals.length >= 1 && signals[0]?.kind === 'watchdog')
// §2.4 Harness 连续性租约:即使无外部进程也必须有可观测租约视图(mock 为进程内持久型)
const continuity = rt.getContinuity()
assert('continuity lease is observable', continuity.leaseId.length > 0 && continuity.continuityMode === 'persistent' && continuity.harness === 'mock')
assert('continuity lease records a harness use', continuity.reuseCount >= 0 && !!continuity.lastUsedAt)
await rt.stop()
db.close()
if (!process.exitCode) console.log('ALL PASS')
