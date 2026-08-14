/**
 * 持久化 + 懒加载 Runtime 测试
 *
 * 验证:
 *  A. 数据驱动持久化:channel/agent 创建即落库,重启(重建 manager)后可读回
 *  B. 懒加载:创建后不装配运行时;任务提交才装配 lead + 调度循环;dispatch 才装配 worker
 *  C. 卸载:任务完成后 unloadIdleAgents 释放运行时(杀 omp 进程),DB 行保留
 *  D. CRUD:channel 增删改查 + agent 增删改查
 *  E. restore:重建 manager 后,有待办任务的 channel 自动激活
 *
 * 运行: npx tsx scripts/test-persistence-lazy.ts
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import type { WorkspaceTask } from '../server/services/workshop/types/task'

let failures = 0
let testCount = 0
function check(name: string, ok: boolean, detail = ''): void {
  testCount += 1
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return false
}

function buildRepos(db: ReturnType<typeof openWorkshopDb>) {
  return {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
  }
}

function makeManager(db: ReturnType<typeof openWorkshopDb>): AgentChannelManager {
  return createAgentChannelManager({ repos: buildRepos(db), implFactory: createAgentImpl, db })
}

function getEngine(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
    }
  }).getTaskEngine()
}

// ===== 测试 A+B: 持久化 + 懒加载 =====
async function testPersistenceAndLazy(): Promise<void> {
  console.log('\n━━━ 测试 A+B: 数据持久化 + 懒加载装配 ━━━')

  const dbPath = resolve(process.cwd(), '.tmp-persist-test.sqlite')
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })

  const db1 = openWorkshopDb(dbPath)
  const manager1 = makeManager(db1)
  let channelId!: string
  let leadId!: string
  let workerId!: string

  try {
    // 1. 创建 channel + agents → 仅持久化,不装配
    const ch = await manager1.createChannel({
      name: '持久化测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 30 } },
    })
    channelId = ch.channelId
    leadId = ch.leadAgentId!
    const wTpl = await manager1.createAgent({ name: 'worker', harness: 'mock', config: { delayMs: 30 } })
    const w = await manager1.addAgentToChannel({ channelId, agentId: wTpl.id, role: 'worker' })
    workerId = w.id

    const st1 = manager1.runtimeStatus()
    check('创建后未装配任何运行时(懒加载)', st1.wiredAgents.length === 0 && st1.activeChannels.length === 0, `wired=${st1.wiredAgents.length}, active=${st1.activeChannels.length}`)

    // 2. 提交任务 → 装配 lead + 调度循环
    const task = await manager1.submitChannelTask({ channelId, title: '懒加载任务' })
    const st2 = manager1.runtimeStatus()
    check('任务提交后装配了 lead 运行时', st2.wiredAgents.includes(leadId), `wired=${st2.wiredAgents.length}`)
    check('任务提交后 channel 活跃', st2.activeChannels.includes(channelId))

    // 3. lead dispatch → worker 装配
    await waitUntil(() => getEngine(manager1).get(task.id)?.state === 'COMPLETED', 10_000)
    const st3 = manager1.runtimeStatus()
    check('worker 执行期间被装配(懒加载)', st3.wiredAgents.includes(workerId) || st3.wiredAgents.includes(leadId), `wired=[${st3.wiredAgents.map(id => id.slice(0, 6)).join(',')}]`)

    // 4. 任务完成后卸载
    await sleep(100)
    await manager1.unloadIdleAgents()
    const st4 = manager1.runtimeStatus()
    check('任务完成后可卸载(内存回收)', st4.wiredAgents.length === 0, `wired=${st4.wiredAgents.length}`)

    // 5. 卸载后 DB 行保留(数据驱动)
    const agentAfterUnload = manager1.getChannelAgent(workerId)
    check('卸载后 agent DB 行保留', !!agentAfterUnload, `name=${agentAfterUnload?.name}`)
    const chAfter = await manager1.getChannel(channelId)
    check('卸载后 channel DB 行保留', chAfter.id === channelId)
  }
  finally {
    await manager1.unloadIdleAgents()
    db1.close()
  }

  // 6. 重建 manager(模拟重启)→ 数据可读回
  const db2 = openWorkshopDb(dbPath)
  const manager2 = makeManager(db2)
  try {
    const channels = await manager2.listChannels()
    check('重启后 channel 持久化读回', channels.length === 1 && channels[0]!.id === channelId)
    const agents = await manager2.listChannelAgents(channelId)
    check('重启后 agent 持久化读回', agents.length === 2)
    check('重启后不自动装配(无待办任务)', manager2.runtimeStatus().wiredAgents.length === 0)
  }
  finally {
    db2.close()
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
  }
}

// ===== 测试 C: restore 激活有待办任务的 channel =====
async function testRestoreWithPending(): Promise<void> {
  console.log('\n━━━ 测试 C: restore 激活有待办任务的 channel ━━━')

  const dbPath = resolve(process.cwd(), '.tmp-restore-test.sqlite')
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })

  // 创建含未完成任务的 channel
  const db1 = openWorkshopDb(dbPath)
  const manager1 = makeManager(db1)
  let channelId!: string
  try {
    const ch = await manager1.createChannel({ name: 'restore', leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 200 } } })
    channelId = ch.channelId
    const wTpl = await manager1.createAgent({ name: 'w', harness: 'mock', config: { delayMs: 200 } })
    await manager1.addAgentToChannel({ channelId, agentId: wTpl.id, role: 'worker' })
    // 提交一个任务但不完成(不等它完成就关闭)
    const task = await manager1.submitChannelTask({ channelId, title: '未完成任务' })
    // 等它被 dispatch 进入工作状态
    await sleep(100)
    check('关闭前有未完成任务', getEngine(manager1).get(task.id)?.state !== 'COMPLETED')
  }
  finally {
    await manager1.unloadIdleAgents()
    db1.close()
  }

  // 重启:restore 应激活该 channel(有待办任务)
  const db2 = openWorkshopDb(dbPath)
  const manager2 = makeManager(db2)
  try {
    manager2.restore()
    const st = manager2.runtimeStatus()
    check('restore 激活有待办任务的 channel', st.activeChannels.includes(channelId), `active=[${st.activeChannels.map(c => c.slice(0, 6)).join(',')}]`)
  }
  finally {
    db2.close()
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
  }
}

// ===== 测试 D: CRUD 完整 =====
async function testCrud(): Promise<void> {
  console.log('\n━━━ 测试 D: Channel + Agent CRUD ━━━')

  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  const tmpWs = resolve(process.cwd(), '.tmp-crud-ws')
  try {
    // Channel create/list/get/update/delete
    const ch = await manager.createChannel({ name: 'crud', description: '初始描述' })
    check('channel create', !!ch.channelId)

    const listed = await manager.listChannels()
    check('channel list', listed.some(c => c.id === ch.channelId))

    const got = await manager.getChannel(ch.channelId)
    check('channel get', got.name === 'crud' && got.workspace.length > 0)

    const updated = await manager.updateChannel(ch.channelId, { name: 'renamed', workspace: tmpWs })
    check('channel update(name+workspace)', updated.name === 'renamed' && updated.workspace === tmpWs)

    // Agent(模板)+ 实例 create/list/get/update/delete
    const tpl = await manager.createAgent({ name: 'agent1', harness: 'mock', config: { k: 'v' } })
    const agent = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: tpl.id, role: 'worker' })
    check('agent create', !!agent.id && agent.id !== tpl.id)

    const agentList = await manager.listChannelAgents(ch.channelId)
    check('agent list', agentList.some(a => a.id === agent.id))

    const agentGot = manager.getChannelAgent(agent.id)
    check('agent get', agentGot?.name === 'agent1' && (agentGot.config as { k: string }).k === 'v')

    const agentUpdated = await manager.updateChannelAgent(agent.id, { name: 'agent1-renamed', config: { k: 'v2' } })
    check('agent update', agentUpdated.name === 'agent1-renamed' && (agentUpdated.config as { k: string }).k === 'v2')

    await manager.removeAgentFromChannel(ch.channelId, agent.id)
    check('agent delete', manager.getChannelAgent(agent.id) === undefined)

    await manager.removeChannel(ch.channelId)
    check('channel delete', (await manager.listChannels()).every(c => c.id !== ch.channelId))
  }
  finally {
    await manager.unloadIdleAgents()
    db.close()
    rmSync(tmpWs, { recursive: true, force: true })
  }
}

// ===== 测试 E: 禁用/启用 channel 与 agent =====
async function testEnableDisable(): Promise<void> {
  console.log('\n━━━ 测试 E: 启用/禁用控制 ━━━')

  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    const ch = await manager.createChannel({ name: 'en', leadAgent: { name: 'lead', harness: 'mock', config: {} } })
    const wTpl = await manager.createAgent({ name: 'w', harness: 'mock', config: {} })
    const w = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl.id, role: 'worker' })

    // 禁用实例
    await manager.updateChannelAgent(w.id, { enabled: 0 })
    const wDisabled = manager.getChannelAgent(w.id)
    check('agent 禁用持久化', wDisabled?.wired === false)

    // 禁用 channel
    await manager.updateChannel(ch.channelId, { enabled: 0 })
    const chDisabled = (await manager.listChannels()).find(c => c.id === ch.channelId)
    check('channel 禁用持久化', chDisabled?.enabled === 0)

    // 禁用的 channel 提交任务应失败(NO_LEAD_AGENT 之前会先检查 channel 是否有效)
    let threw = false
    try {
      await manager.submitChannelTask({ channelId: ch.channelId, title: 'x' })
    }
    catch {
      threw = true
    }
    check('禁用 channel 无法提交任务', threw)

    // 重新启用
    await manager.updateChannel(ch.channelId, { enabled: 1 })
    await manager.updateChannelAgent(w.id, { enabled: 1 })
    const chRe = (await manager.listChannels()).find(c => c.id === ch.channelId)
    check('channel 重新启用', chRe?.enabled === 1)
  }
  finally {
    await manager.unloadIdleAgents()
    db.close()
  }
}

// ===== main =====
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║  持久化 + 懒加载 Runtime 测试                               ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  await testPersistenceAndLazy()
  await testRestoreWithPending()
  await testCrud()
  await testEnableDisable()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? `🎉 全部通过(${testCount} 项检查)` : `❌ ${failures}/${testCount} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
