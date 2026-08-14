/**
 * workshop 持久化层测试(node + tsx 直跑,无浏览器)
 *
 * 覆盖(v2:Agent 与 Channel 分离):
 *  1. 建表:6 张表 + 4 个索引
 *  2. channel CRUD
 *  3. agent 定义 CRUD(全局,无 channel 绑定)
 *  4. channel_agents 成员 CRUD + findByToken(成员级 token)
 *  5. message 状态机(pending→consuming→consumed + resetConsuming)+ channel 作用域
 *  6. subscription 复合主键去重(channel 隔离)
 *  7. task CRUD + listNonTerminal
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb, parseJson } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

function testSchema(db: DatabaseSync): void {
  console.log('\n--- 1. 建表与索引 ---')
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels','agents','channel_agents','messages','subscriptions','tasks') ORDER BY name`,
    )
    .all() as { name: string }[]
  const names = tables.map(t => t.name)
  check('6 张表全部创建', names.length === 6, names.join(','))

  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_channel_agents_token','idx_channel_agents_channel','idx_messages_queue','idx_tasks_channel','idx_tasks_assignee')`,
    )
    .all()
  check('5 个索引全部创建', indexes.length === 5)
}

function testChannelCrud(db: DatabaseSync): void {
  console.log('\n--- 2. channel CRUD ---')
  const repo = createChannelRepo(db)

  const created = repo.create({ name: '频道A' })
  check('create 生成 id 且 description 默认空串', created.id.length > 0 && created.description === '' && created.enabled === 1)
  check('create 支持 description', repo.create({ name: '频道B', description: '描述B' }).description === '描述B')

  check('list 返回 2 条', repo.list().length === 2)
  check('findById 命中', repo.findById(created.id)?.name === '频道A')
  check('findById 未命中返回 undefined', repo.findById('nope') === undefined)

  const updated = repo.update(created.id, { name: '频道A改', description: '新描述' })
  check('update 修改 name/description', updated?.name === '频道A改' && updated?.description === '新描述')
  check('update 未命中返回 undefined', repo.update('nope', { name: 'x' }) === undefined)
  check('update 保留未提供字段', repo.findById(created.id)?.leadAgentId === null)

  repo.remove(created.id)
  check('remove 后 findById 未命中', repo.findById(created.id) === undefined)
  check('remove 后 list 长度 1', repo.list().length === 1)
}

function testAgentCrud(db: DatabaseSync): void {
  console.log('\n--- 3. agent 定义 CRUD(全局) ---')
  const repo = createAgentRepo(db)

  const lead = repo.create({ name: '主理人', harness: 'mock' })
  check('create 生成 id', lead.id.length > 0)
  check('create 默认 configJson {}', lead.configJson === '{}')

  const worker = repo.create({ name: '工人', harness: 'claude', config: { model: 'x' } })
  check('create config 序列化为 JSON', worker.configJson === JSON.stringify({ model: 'x' }))

  check('list 返回 2 条', repo.list().length === 2)
  check('findById 命中', repo.findById(lead.id)?.name === '主理人')

  const updated = repo.update(worker.id, { name: '工人改', config: { model: 'y' } })
  check('update 修改 name/config', updated?.name === '工人改' && updated?.configJson === JSON.stringify({ model: 'y' }))

  repo.remove(worker.id)
  check('remove 后 list 长度 1', repo.list().length === 1)
}

function testChannelAgentCrud(db: DatabaseSync): void {
  console.log('\n--- 4. channel_agents 实例 CRUD(克隆)+ findByToken ---')
  const channels = createChannelRepo(db)
  const ch = channels.create({ name: '主频道' })
  const agents = createAgentRepo(db)
  const a = agents.create({ name: '主理人', harness: 'mock', config: { k: 'v' } })
  const b = agents.create({ name: '工人', harness: 'claude' })

  const repo = createChannelAgentRepo(db)
  const mA = repo.create({ channelId: ch.id, templateId: a.id, name: a.name, harness: a.harness, config: { k: 'v' }, role: 'lead' })
  check('create 生成独立身份 id', mA.id.length > 0 && mA.id !== a.id)
  check('create 自动生成实例 token', mA.token.length > 0)
  check('create 复制模板 name/harness/config', mA.name === '主理人' && mA.harness === 'mock' && mA.configJson === JSON.stringify({ k: 'v' }))
  check('create 记录 template_id', mA.templateId === a.id)

  const mB = repo.create({ channelId: ch.id, templateId: b.id, name: b.name, harness: b.harness, role: 'worker', token: 'tok-1' })
  check('create 接受显式 token', mB.token === 'tok-1')
  check('同模板可克隆多实例且 id 不同', mB.id !== mA.id)

  check('listByChannel 返回 2 条', repo.listByChannel(ch.id).length === 2)
  check('findById 命中实例', repo.findById(mA.id)?.role === 'lead')
  check('findByChannelAgent 命中', repo.findByChannelAgent(ch.id, mA.id)?.role === 'lead')
  check('findByToken 命中(实例级)', repo.findByToken('tok-1')?.id === mB.id)
  check('findByToken 未命中返回 undefined', repo.findByToken('nope') === undefined)
  check('listByTemplate 返回该模板全部实例', repo.listByTemplate(a.id).length === 1)

  const updated = repo.update(mB.id, { role: 'lead', name: '工人改' })
  check('update 修改 role/name', updated?.role === 'lead' && updated?.name === '工人改')

  repo.remove(ch.id, mB.id)
  check('remove 后 listByChannel 长度 1', repo.listByChannel(ch.id).length === 1)
  check('remove 后 findByToken 未命中', repo.findByToken('tok-1') === undefined)
}

function testMessageStateMachine(db: DatabaseSync): void {
  console.log('\n--- 5. message 状态机 + channel 作用域 ---')
  const channels = createChannelRepo(db)
  const ch = channels.create({ name: '消息频道' })
  const repo = createMessageRepo(db)

  const m1 = repo.create({ channelId: ch.id, toAgentId: 'agent-a', role: 'ROLE_AGENT', parts: [{ text: 'hi' }] })
  const m2 = repo.create({ channelId: ch.id, toAgentId: 'agent-a', role: 'ROLE_AGENT', parts: [{ text: 'yo' }] })
  repo.create({ channelId: ch.id, toAgentId: 'agent-b', role: 'ROLE_USER', parts: [{ text: 'other' }], metadata: { k: 1 } })

  check('listPendingByChannelAgent 初始 2 条', repo.listPendingByChannelAgent(ch.id, 'agent-a').length === 2)
  check('partsJson 存 JSON.stringify', m1.partsJson === JSON.stringify([{ text: 'hi' }]))
  check('parseJson 读回 parts', parseJson<{ text: string }[]>(m1.partsJson, []).length === 1)
  check('parseJson 解析失败返回默认值', parseJson('{broken', []).length === 0)

  repo.markConsuming(m1.id)
  check('markConsuming 后 pending 减为 1', repo.listPendingByChannelAgent(ch.id, 'agent-a').length === 1)
  const consuming = db.prepare(`SELECT state FROM messages WHERE id = ?`).get(m1.id) as { state: string }
  check('m1 state 变为 consuming', consuming.state === 'consuming')

  repo.markConsumed(m1.id)
  const consumed = db.prepare(`SELECT state, consumed_at FROM messages WHERE id = ?`).get(m1.id) as { state: string, consumed_at: string | null }
  check('markConsumed 后 state=consumed 且 consumed_at 非空', consumed.state === 'consumed' && consumed.consumed_at != null)

  repo.markConsuming(m2.id)
  repo.resetConsuming()
  const m2After = db.prepare(`SELECT state FROM messages WHERE id = ?`).get(m2.id) as { state: string }
  check('resetConsuming 将 consuming 重置为 pending', m2After.state === 'pending')
  check('resetConsuming 后 pending 恢复为 1', repo.listPendingByChannelAgent(ch.id, 'agent-a').length === 1)

  check('listRecentByChannel 返回 3 条', repo.listRecentByChannel(ch.id, 10).length === 3)
  check('listRecentByChannel 尊重 limit', repo.listRecentByChannel(ch.id, 2).length === 2)
}

function testSubscriptionDedup(db: DatabaseSync): void {
  console.log('\n--- 6. subscription 复合主键去重(channel 隔离) ---')
  const channels = createChannelRepo(db)
  const ch = channels.create({ name: '订阅频道' })
  const agents = createAgentRepo(db)
  const channelAgents = createChannelAgentRepo(db)
  const tplA = agents.create({ name: 'A', harness: 'mock' })
  const tplB = agents.create({ name: 'B', harness: 'mock' })
  const tplC = agents.create({ name: 'C', harness: 'mock' })
  const a = channelAgents.create({ channelId: ch.id, templateId: tplA.id, name: tplA.name, harness: tplA.harness, role: 'worker' })
  const b = channelAgents.create({ channelId: ch.id, templateId: tplB.id, name: tplB.name, harness: tplB.harness, role: 'worker' })
  const c = channelAgents.create({ channelId: ch.id, templateId: tplC.id, name: tplC.name, harness: tplC.harness, role: 'worker' })

  const repo = createSubscriptionRepo(db)
  repo.add(ch.id, a.id, b.id)
  repo.add(ch.id, a.id, b.id)
  check('重复 add 同一对自动去重', repo.listByAgent(ch.id, a.id).length === 1)

  repo.add(ch.id, a.id, c.id)
  check('listByAgent 返回 2 个目标', repo.listByAgent(ch.id, a.id).length === 2)
  check('listByTarget(b) 返回 1 个订阅者', repo.listByTarget(ch.id, b.id).length === 1)

  repo.remove(ch.id, a.id, b.id)
  check('remove 后 listByAgent 长度 1', repo.listByAgent(ch.id, a.id).length === 1)
  check('remove 后 listByTarget(b) 为空', repo.listByTarget(ch.id, b.id).length === 0)
}

function testTaskCrud(db: DatabaseSync): void {
  console.log('\n--- 7. task CRUD + listNonTerminal ---')
  const channels = createChannelRepo(db)
  const ch = channels.create({ name: '任务频道' })
  const agents = createAgentRepo(db)
  const lead = agents.create({ name: '主理人', harness: 'mock' })
  const worker = agents.create({ name: '工人', harness: 'mock' })

  const repo = createTaskRepo(db)
  const parent = repo.create({ channelId: ch.id, assigneeId: lead.id, creatorId: 'user-1', title: '主任务' })
  check('create 默认 SUBMITTED/progress 0/retryCount 0', parent.state === 'SUBMITTED' && parent.progress === 0 && parent.retryCount === 0)
  check('create artifactsJson 默认 []', parent.artifactsJson === '[]')

  const child = repo.create({ channelId: ch.id, parentId: parent.id, assigneeId: worker.id, creatorId: lead.id, title: '子任务', state: 'ASSIGNED', artifacts: [{ artifactId: 'a1' }] })
  check('create 子任务 parentId/artifacts 序列化', child.parentId === parent.id && child.artifactsJson === JSON.stringify([{ artifactId: 'a1' }]))

  check('listByChannel 返回 2 条', repo.listByChannel(ch.id).length === 2)
  check('listByAssignee(worker) 返回 1 条', repo.listByAssignee(worker.id).length === 1)
  check('listNonTerminal 初始 2 条', repo.listNonTerminal().length === 2)

  const updated = repo.update(child.id, { state: 'COMPLETED', progress: 100 })
  check('update 修改 state/progress', updated?.state === 'COMPLETED' && updated?.progress === 100)
  check('listNonTerminal 排除终态', repo.listNonTerminal().length === 1)
  check('listNonTerminal 只剩父任务', repo.listNonTerminal()[0]?.id === parent.id)

  check('findById 命中', repo.findById(parent.id)?.title === '主任务')
  check('findById 未命中返回 undefined', repo.findById('nope') === undefined)
}

function main(): void {
  const db = openWorkshopDb(':memory:')
  try {
    testSchema(db)
    testChannelCrud(db)
    testAgentCrud(db)
    testChannelAgentCrud(db)
    testMessageStateMachine(db)
    testSubscriptionDedup(db)
    testTaskCrud(db)
  }
  finally {
    db.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
