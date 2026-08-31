import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'

const db = openWorkshopDb(':memory:')
const now = new Date().toISOString()
db.prepare('INSERT INTO channels (id, name, enabled, created_at, updated_at) VALUES (\'ch1\', \'test\', 1, ?, ?)').run(now, now)
const tasks = createTaskRepo(db)
const messages = createMessageRepo(db)
const engine = new TaskEngine({ tasks, messages })

let failed = 0
const okIf = (m: string, c: boolean) => {
  if (c) console.log(`PASS ${m}`)
  else {
    console.log(`FAIL ${m}`)
    failed++
  }
}

const parent = engine.create({ channelId: 'ch1', creatorId: 'u1', assigneeId: 'lead', title: 'parent', description: '[mode:goal] do it' })
// 调度器同款前置:SUBMITTED → WORKING 后 dispatch(WORKING → WAITING 合法)
engine.transition(parent.id, 'WORKING', 'lead')
engine.dispatch(parent, { assigneeId: 'w1', title: 'child one' })

// 判重:同父 + 归一化同题(大小写/空白)+ 非终态 → 409,不创建新任务
let caught409 = false
try {
  engine.dispatch(parent, { assigneeId: 'w2', title: 'Child  ONE' })
}
catch (e) {
  const err = e as { code?: string, statusCode?: number, status?: number }
  caught409 = err.code === 'DUPLICATE_DISPATCH' || err.statusCode === 409 || err.status === 409
}
okIf('duplicate-dispatch-409', caught409)

// 409 后无新任务:parent + child one = 2 行;children = 1
const lite = engine.listLite('ch1')
const views = engine.queueViewsOfLite('ch1')
okIf(`listLite rows after 409: ${lite.length} (expect 2: parent+child one)`, lite.length === 2)
okIf('lite fields ok(状态/进度/数组字段齐备,大列置空)', lite.every(t => typeof t.id === 'string' && t.state && typeof t.progress === 'number' && Array.isArray(t.history) && Array.isArray(t.artifacts)))
okIf(`queueViewsLite assignees: ${[...views.keys()].sort().join(',')} (expect lead,w1)`, [...views.keys()].sort().join(',') === 'lead,w1')
okIf(`queued in w1 view: ${views.get('w1')?.queued.length ?? -1} (expect 1)`, views.get('w1')?.queued.length === 1)
okIf(`listChildrenMeta after 409: ${tasks.listChildrenMeta('ch1', parent.id).length} (expect 1)`, tasks.listChildrenMeta('ch1', parent.id).length === 1)

// 异题派发合法:第二个子任务可建
const c3 = engine.dispatch(parent, { assigneeId: 'w2', title: 'child two' })
okIf('second-distinct-child', !!c3)
okIf(`listLite rows after child two: ${engine.listLite('ch1').length} (expect 3)`, engine.listLite('ch1').length === 3)
okIf(`listChildrenMeta after child two: ${tasks.listChildrenMeta('ch1', parent.id).length} (expect 2)`, tasks.listChildrenMeta('ch1', parent.id).length === 2)

// 完成闸门:仅一个子完成 → parent 仍 WAITING;双子终态后显式 complete(parent) 放行
const childrenIds = tasks.listChildrenMeta('ch1', parent.id).map(r => r.id)
engine.transition(childrenIds[0]!, 'WORKING', 'w1')
engine.complete(childrenIds[0]!, [{ artifactId: 'a1', name: 'output', parts: [{ text: 'done' }] }])
okIf(`complete-child: ${engine.get(childrenIds[0]!)?.state} (expect COMPLETED)`, engine.get(childrenIds[0]!)?.state === 'COMPLETED')
okIf(`parent state(单子完成): ${engine.get(parent.id)?.state} (expect WAITING)`, engine.get(parent.id)?.state === 'WAITING')
engine.transition(childrenIds[1]!, 'WORKING', 'w2')
engine.complete(childrenIds[1]!, [{ artifactId: 'a2', name: 'output2', parts: [{ text: 'done2' }] }])
// 父任务收口由调度器(goal 宽限窗/规则引擎)负责;TaskEngine 层验证 done-check 闸门:
// 全部子任务终态后 complete(parent) 应放行(WAITING → COMPLETED 合法迁移)
engine.complete(parent.id, [{ artifactId: 'a3', name: 'summary', parts: [{ text: 'all done' }] }])
okIf(`parent state(双子终态后显式 complete): ${engine.get(parent.id)?.state} (expect COMPLETED)`, engine.get(parent.id)?.state === 'COMPLETED')

// F1:legacy 迁移列与索引
const cols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name)
okIf('route_reason column present', cols.includes('route_reason'))
okIf('idx_tasks_parent present', !!db.prepare('SELECT name FROM sqlite_master WHERE type=\'index\' AND name=\'idx_tasks_parent\'').get())

console.log(failed ? `SMOKE FAILED(${failed})` : 'SMOKE ALL PASS')
process.exit(failed ? 1 : 0)
