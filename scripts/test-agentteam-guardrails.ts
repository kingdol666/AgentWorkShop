/** Deterministic AgentTeam guardrail smoke tests. */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
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
const engine = new TaskEngine({ tasks, messages })
const channel = channels.create({ name: 'guardrails' })
const lead = agents.create({ name: 'lead', harness: 'mock' })
const worker = agents.create({ name: 'worker', harness: 'mock' })

const root = engine.create({
  channelId: channel.id,
  creatorId: lead.id,
  assigneeId: lead.id,
  title: '日志清理方案',
  description: '用户原始请求',
  sourceChatMessageId: 'chat-001',
  sourceChatDeliveryId: 'delivery-001',
})
engine.transition(root.id, 'WORKING', lead.id)

const children = [] as ReturnType<typeof engine.dispatch>[]
for (let i = 0; i < 3; i++) {
  const child = engine.dispatch(root, { assigneeId: worker.id, title: `执行方案-${i}` })
  children.push(child)
  engine.cancel(child.id, lead.id, 'LEAD_CANCEL')
}
check('取消子任务计入根任务预算', children.every(c => engine.get(c.id)?.state === 'CANCELED'))
try {
  engine.dispatch(root, { assigneeId: worker.id, title: '接口对齐修正' })
  check('取消预算耗尽后拒绝继续派发', false)
}
catch (err) {
  check('取消预算耗尽后拒绝继续派发', err instanceof AppError && (err as AppError).code === 'TASK_CANCEL_BUDGET_EXCEEDED')
}

try {
  engine.create({
    channelId: channel.id,
    creatorId: lead.id,
    assigneeId: lead.id,
    title: '日志清理方案-统一契约版',
    sourceChatMessageId: 'chat-001',
  })
  check('相同 sourceChatMessageId 由数据库唯一约束阻止第二根任务', false)
}
catch {
  check('相同 sourceChatMessageId 由数据库唯一约束阻止第二根任务', true)
}

const parent = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: lead.id, title: '取消级联' })
engine.transition(parent.id, 'WORKING', lead.id)
const child = engine.dispatch(parent, { assigneeId: worker.id, title: '活动子任务' })
try {
  engine.dispatch(child, { assigneeId: worker.id, title: '孙任务' })
  check('普通任务禁止递归创建孙任务', false)
}
catch (err) {
  check('普通任务禁止递归创建孙任务', err instanceof AppError && (err as AppError).code === 'TASK_DEPTH_EXCEEDED')
}
const canceled = engine.cancelTree(parent.id, lead.id)
check('取消父任务级联关闭活动后代', canceled.length === 2 && [parent.id, child.id].every(id => engine.get(id)?.state === 'CANCELED'))

try {
  engine.complete(child.id, [{ artifactId: 'late', name: 'deliverable', parts: [{ text: 'late' }] }])
  check('取消后的迟到完成被拒绝', false)
}
catch (err) {
  check('取消后的迟到完成被拒绝', err instanceof AppError && (err as AppError).code === 'TASK_TERMINAL')
}

const timeoutRoot = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: lead.id, title: '超时根任务' })
engine.transition(timeoutRoot.id, 'WORKING', lead.id)
const timeoutChild = engine.dispatch(timeoutRoot, { assigneeId: worker.id, title: '超时子任务' })
const timeoutClosed = engine.timeoutTree(timeoutRoot.id, lead.id)
check('根任务超时关闭 root 与活动 child', timeoutClosed.length === 2
&& engine.get(timeoutRoot.id)?.state === 'FAILED'
&& engine.get(timeoutRoot.id)?.closeReason === 'ROOT_TIMEOUT'
&& engine.get(timeoutChild.id)?.state === 'CANCELED'
&& engine.get(timeoutChild.id)?.closeReason === 'ROOT_TIMEOUT')

db.close()
if (failures > 0) process.exitCode = 1
else console.log('ALL PASS')
