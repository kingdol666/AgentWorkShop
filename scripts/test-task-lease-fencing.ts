/**
 * 确定性验证:任务执行租约与运行中重分配栅栏(设计文档 §5.1/§5.2)+
 * 根任务 FIFO 完整性(§2.1)与 Channel 过程记忆事件契约(§7.1/§7.2)。
 *
 * 覆盖的验收项:
 *  - §2.1 root 一律获得 root_queue_seq(含人类直发 worker 的 root);
 *  - §5.1 每次新分配/重分配产生新的 assignmentGeneration + executionLeaseId;
 *  - §5.2 运行中 reassign:旧 lease 撤销、generation+1、旧 worker 迟到事件被丢弃、
 *    新 worker 收到新 assign;终态任务租约撤销;
 *  - §7.1 事件名契约(root.created/root.queued/child.dispatched/...)可由状态机派生。
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import { fenceFromMetadata, fenceMatches } from '../server/services/workshop/runtime/task-engine/lease'
import { AppError } from '../server/utils/errors'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db = openWorkshopDb(':memory:')
const channels = createChannelRepo(db)
const agents = createAgentRepo(db)
const tasks = createTaskRepo(db)
const messages = createMessageRepo(db)
const changes: Array<{ taskId: string, state?: string, reassignFrom?: string }> = []
const engine = new TaskEngine({ tasks, messages }, { onTaskChange: e => changes.push({ taskId: e.taskId, state: e.state, reassignFrom: e.reassignFrom }) })

const channel = channels.create({ name: 'lease' })
const lead = agents.create({ name: 'lead', harness: 'mock' })
const alice = agents.create({ name: 'alice', harness: 'mock' })
const bob = agents.create({ name: 'bob', harness: 'mock' })

// ===== §2.1 root 队列序号:即使调用方显式传 null 也必须发号 =====
const explicitNullRoot = engine.create({
  channelId: channel.id,
  creatorId: lead.id,
  assigneeId: alice.id,
  title: '直发 worker 的 root',
  rootQueueSeq: null,
})
check('§2.1 显式 null 的 root 仍获得 root_queue_seq', typeof explicitNullRoot.rootQueueSeq === 'number', `seq=${explicitNullRoot.rootQueueSeq}`)
const queueAfterNull = engine.rootQueue(channel.id)
check('§2.1 该 root 出现在 rootQueue 中(不被 IS NOT NULL 过滤)',
  queueAfterNull.activeRoot?.id === explicitNullRoot.id || queueAfterNull.queuedRoots.some(t => t.id === explicitNullRoot.id))

// ===== §5.1 创建即持有租约 =====
check('§5.1 创建任务即产生 generation/lease',
  explicitNullRoot.assignmentGeneration === 0 && !!explicitNullRoot.executionLeaseId
  && explicitNullRoot.executionLeaseAgentId === alice.id && !explicitNullRoot.executionLeaseRevokedAt,
  `gen=${explicitNullRoot.assignmentGeneration} lease=${explicitNullRoot.executionLeaseId?.slice(0, 8)}`)

// ===== §5.2 运行中重分配 =====
engine.transition(explicitNullRoot.id, 'WORKING', alice.id)
const before = engine.get(explicitNullRoot.id)!
const moved = engine.reassignRunning(explicitNullRoot.id, bob.id, lead.id, 'WORKER_STALLED')
check('§5.2 运行中重分配改变执行者', moved.task.assigneeId === bob.id && moved.previousAssigneeId === alice.id)
check('§5.2 generation +1', (moved.task.assignmentGeneration ?? 0) === (before.assignmentGeneration ?? 0) + 1)
check('§5.2 lease 换新且持有者=新 worker',
  !!moved.task.executionLeaseId && moved.task.executionLeaseId !== before.executionLeaseId
  && moved.task.executionLeaseAgentId === bob.id && !moved.task.executionLeaseRevokedAt)
check('§5.2 任务状态不变(仅执行权转移)', moved.task.state === 'WORKING')
check('§7.1 重分配发出事件(旧/新 assignee 可追溯)', changes.some(c => c.taskId === explicitNullRoot.id && c.reassignFrom === alice.id))

// ===== §5.2 旧 worker 迟到事件被丢弃 =====
const staleFence = { generation: before.assignmentGeneration ?? 0, leaseId: before.executionLeaseId }
const currentFence = { generation: moved.task.assignmentGeneration ?? 0, leaseId: moved.task.executionLeaseId }
check('§5.2 旧 worker 栅栏被判定过期', !engine.assertAssignmentFence(explicitNullRoot.id, staleFence))
check('§5.2 新 worker 栅栏被接受', engine.assertAssignmentFence(explicitNullRoot.id, currentFence))

const artifactsBefore = engine.get(explicitNullRoot.id)!.artifacts.length
engine.applyEvent(explicitNullRoot.id, {
  kind: 'artifact',
  artifact: { artifactId: 'late-artifact', name: 'deliverable', parts: [{ text: '旧 worker 的迟到交付' }] },
  lastChunk: true,
  totalChunks: 1,
}, staleFence)
check('§5.2 旧 worker 迟到 artifact 不写入任务', engine.get(explicitNullRoot.id)!.artifacts.length === artifactsBefore)

engine.applyEvent(explicitNullRoot.id, {
  kind: 'artifact',
  artifact: { artifactId: 'new-artifact', name: 'deliverable', parts: [{ text: '新 worker 的交付' }] },
  lastChunk: true,
  totalChunks: 1,
}, currentFence)
check('§5.2 新 worker artifact 正常写入', engine.get(explicitNullRoot.id)!.artifacts.some(a => a.artifactId === 'new-artifact'))

// ===== 无栅栏的历史任务放行(升级兼容) =====
const legacy = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: alice.id, title: '历史无租约任务' })
tasks.update(legacy.id, { executionLeaseId: null, assignmentGeneration: 0 })
check('升级兼容:无 lease 任务对任意栅栏放行', engine.assertAssignmentFence(legacy.id, { generation: 99, leaseId: 'ghost' }))

// ===== 分配消息携带栅栏 =====
const deliverChannel = channels.create({ name: 'lease-delivery' })
const parent = engine.create({ channelId: deliverChannel.id, creatorId: lead.id, assigneeId: lead.id, title: '父任务' })
engine.transition(parent.id, 'WORKING', lead.id)
const child = engine.dispatch(parent, { assigneeId: alice.id, title: '子任务' })
const pending = messages.listPendingByChannelAgent(deliverChannel.id, alice.id)
const assignMsg = pending.find(m => m.taskId === child.id)
const assignMeta = JSON.parse(assignMsg?.metadataJson ?? '{}') as Record<string, unknown>
const fence = fenceFromMetadata(assignMeta)
check('§5.1 assign 投递携带 generation/lease',
  !!fence && fence.leaseId === engine.get(child.id)!.executionLeaseId && fence.generation === 0,
  `lease=${fence?.leaseId?.slice(0, 8)}`)
check('§5.1 栅栏与当前任务匹配', !!fence && fenceMatches(engine.get(child.id)!, fence))

// ===== §5.1 终态撤销租约 =====
engine.transition(child.id, 'WORKING', alice.id)
engine.applyEvent(child.id, {
  kind: 'artifact',
  artifact: { artifactId: 'child-deliverable', name: 'deliverable', parts: [{ text: 'done' }] },
  lastChunk: true,
  totalChunks: 1,
}, fence)
engine.complete(child.id)
const done = engine.get(child.id)!
check('§5.1 终态任务租约被撤销', done.state === 'COMPLETED' && !!done.executionLeaseRevokedAt)

// ===== §10 Root identity:并发/重复提交仍只有一个 canonical root =====
const rootA = engine.createOrGetRoot({ channelId: channel.id, creatorId: lead.id, assigneeId: lead.id, title: 'A', sourceChatMessageId: 'm-1' })
const rootB = engine.createOrGetRoot({ channelId: channel.id, creatorId: lead.id, assigneeId: lead.id, title: 'A-改名', sourceChatMessageId: 'm-1' })
check('同 source 不同标题 → 同一 canonical root', rootA.task.id === rootB.task.id && rootB.created === false)

// ===== §5.2 队列中(非运行中)重分配仍走原路径 =====
const queued = engine.createOrGetRoot({ channelId: channel.id, creatorId: lead.id, assigneeId: lead.id, title: 'B', sourceChatMessageId: 'm-2' })
const queuedBefore = engine.get(queued.task.id)!
const queuedMoved = engine.reassign(queued.task.id, alice.id, 'QUEUED_REASSIGN')
check('排队态按 §5.1 也换发新 lease',
  queuedMoved.assigneeId === alice.id
  && queuedMoved.executionLeaseId !== queuedBefore.executionLeaseId
  && (queuedMoved.assignmentGeneration ?? 0) === (queuedBefore.assignmentGeneration ?? 0) + 1)

// ===== 运行中重分配对同一目标幂等(不反复作废自己的 lease) =====
const again = engine.reassignRunning(explicitNullRoot.id, bob.id, lead.id, 'LEAD_REASSIGN')
check('§5.2 同目标重复决策幂等', again.task.executionLeaseId === moved.task.executionLeaseId)

// ===== 非运行中任务不得走 reassignRunning =====
try {
  engine.reassignRunning(queued.task.id, bob.id, lead.id, 'X')
  check('§5.2 非运行中任务拒绝 reassignRunning', false)
}
catch (err) {
  check('§5.2 非运行中任务拒绝 reassignRunning', err instanceof AppError && (err as AppError).code === 'INVALID_STATE')
}

db.close()
if (failures > 0) process.exitCode = 1
else console.log('ALL PASS')
