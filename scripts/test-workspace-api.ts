/**
 * Workspace + 后端 API 集成测试
 *
 * 测试矩阵:
 *  A. workspace 创建与注入:创建 channel → 默认 workspace 目录生成 → agent cwd 注入验证
 *  B. 自定义 workspace:显式指定 workspace → 目录创建 → omp 子进程在该目录执行(read 工具可见)
 *  C. channel 管理 API:getChannel/getChannelWorkspace/updateChannelWorkspace
 *  D. 消息 API:sendImmediateMessage 优先级路由验证
 *
 * 运行: npx tsx scripts/test-workspace-api.ts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'

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
    await sleep(100)
  }
  return false
}

interface SetupResult {
  manager: AgentChannelManager
  db: ReturnType<typeof openWorkshopDb>
  repos: ReturnType<typeof buildRepos>
}

function buildRepos(db: ReturnType<typeof openWorkshopDb>) {
  return {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),

    teams: createTeamRepo(db),

    teamMembers: createTeamMemberRepo(db),
  }
}

function setup(): SetupResult {
  const db = openWorkshopDb(':memory:')
  const repos = buildRepos(db)
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  return { manager, db, repos }
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs = 200): void {
  manager.ensureChannelActive(channelId, { tickMs, stallMs: 60_000 })
}

async function disposeAll(manager: AgentChannelManager): Promise<void> {
  await manager.shutdown()
}

// ===== 测试 A: 默认 workspace 生成与 cwd 注入 =====
async function testDefaultWorkspace(): Promise<void> {
  console.log('\n━━━ 测试 A: 默认 workspace 生成与 cwd 注入 ━━━')

  const { manager, db } = setup()
  const tmpRoot = resolve(process.cwd(), 'data', 'workspaces')
  let channelId = ''

  try {
    const ch = await manager.createChannel({
      name: 'workspace 测试',
      leadAgent: { name: 'lead', harness: 'mock', config: {} },
    })
    channelId = ch.channelId

    // 1. workspace 默认生成在 data/workspaces/<channelId>
    check('createChannel 返回 workspace', ch.workspace.length > 0, ch.workspace)
    check('默认 workspace 路径在 data/workspaces 下', ch.workspace.startsWith(tmpRoot), ch.workspace)
    check('workspace 目录已创建', existsSync(ch.workspace))

    // 2. agent cwd 注入验证:创建 worker → 内部 implFactory 收到的 config.cwd = workspace
    let capturedCwd = ''
    const probeFactory = (agent: Parameters<typeof createAgentImpl>[0]) => {
      capturedCwd = (agent.config as { cwd?: string }).cwd ?? ''
      return createAgentImpl(agent)
    }
    // 重建 manager 使用探测工厂
    const db2 = openWorkshopDb(':memory:')
    const repos2 = buildRepos(db2)
    const manager2 = createAgentChannelManager({ repos: repos2, implFactory: probeFactory, db: db2 })
    const ch2 = await manager2.createChannel({
      name: 'cwd 探测',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 20 } },
    })
    await manager2.addAgentToChannel({ channelId: ch2.channelId, agentId: (await manager2.createAgent({ name: 'w', harness: 'mock', config: { delayMs: 20 } })).id, role: 'worker' })
    // 懒加载:显式激活触发 lead 装配
    manager2.ensureChannelActive(ch2.channelId, { tickMs: 20 })
    check('lead 装配时注入 cwd', capturedCwd === ch2.workspace, `cwd=${capturedCwd}`)
    // 提交任务触发 worker dispatch 装配
    await manager2.submitChannelTask({ channelId: ch2.channelId, title: 't' })
    await sleep(300)
    check('worker 装配时注入 cwd', capturedCwd === ch2.workspace, `cwd=${capturedCwd}`)

    // 3. getChannel 返回 workspace
    const detail = await manager.getChannel(channelId)
    check('getChannel 返回 workspace', detail.workspace === ch.workspace)
    check('getChannel 返回 agents', detail.agents.length === 1)

    await disposeAll(manager2)
    db2.close()
  }
  finally {
    await disposeAll(manager)
    db.close()
    // 清理测试生成的 workspace 目录
    if (channelId) {
      const dir = resolve(tmpRoot, channelId)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ===== 测试 B: 自定义 workspace + omp 真实 cwd 约束 =====
async function testCustomWorkspaceOmp(): Promise<void> {
  console.log('\n━━━ 测试 B: 自定义 workspace + omp 真实 cwd 约束 ━━━')

  const { manager, db } = setup()
  // 自定义 workspace:temp 目录
  const customDir = resolve(process.cwd(), '.tmp-test-ws')
  mkdirSync(customDir, { recursive: true })
  // 在自定义目录写一个标记文件,omp 用 read 应该能读到
  writeFileSync(resolve(customDir, 'MARKER.txt'), 'workspace-marker-content-12345', 'utf8')

  try {
    const ch = await manager.createChannel({
      name: 'omp cwd 测试',
      workspace: customDir,
      leadAgent: { name: 'lead', harness: 'omp', config: {} },
    })
    check('自定义 workspace 生效', ch.workspace === customDir, ch.workspace)

    const wTpl = await manager.createAgent({ name: 'w', harness: 'omp', config: {} })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl.id, role: 'worker' })
    attachScheduler(manager, ch.channelId, 500)

    // 提交任务:要求 worker 读取 MARKER.txt(只有 cwd 正确才能读到)
    const engine = (manager as unknown as {
      getTaskEngine(): {
        get(id: string): { state: string, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined
        list(channelId: string): Array<{ parentId: string | null, state: string }>
      }
    }).getTaskEngine()

    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '读取 MARKER.txt 内容',
      description: '读取当前工作目录下的 MARKER.txt 文件,报告其完整内容,然后完成任务。',
    })

    await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED' || t?.state === 'CANCELED' || t?.state === 'FAILED'
    }, 240_000)

    const final = engine.get(task.id)
    check('omp 任务完成', final?.state === 'COMPLETED', `state=${final?.state}`)

    // 验证 worker 产物包含标记内容(证明 omp 在 customDir 下执行)
    const children = engine.list(ch.channelId).filter(t => t.parentId === task.id)
    const allText = [...(final?.artifacts ?? []), ...children.flatMap(c => (c as { artifacts?: Array<{ parts: Array<{ text?: string }> }> }).artifacts ?? [])]
      .flatMap(a => a.parts)
      .map(p => p.text ?? '')
      .join(' ')
    check('omp 读取到 MARKER.txt 内容(cwd 约束生效)', allText.includes('workspace-marker-content-12345'), `内容片段: ${allText.slice(0, 80)}…`)
  }
  finally {
    await disposeAll(manager)
    db.close()
    rmSync(customDir, { recursive: true, force: true })
  }
}

// ===== 测试 C: workspace 更新 API =====
async function testWorkspaceUpdate(): Promise<void> {
  console.log('\n━━━ 测试 C: workspace 更新 ━━━')

  const { manager, db } = setup()
  try {
    const ch = await manager.createChannel({ name: 'update 测试' })
    const dir1 = resolve(process.cwd(), '.tmp-ws-a')
    const dir2 = resolve(process.cwd(), '.tmp-ws-b')

    const updated = await manager.updateChannelWorkspace(ch.channelId, dir1)
    check('workspace 更新生效', updated.workspace === dir1)
    check('更新后目录存在', existsSync(dir1))

    const updated2 = await manager.updateChannelWorkspace(ch.channelId, dir2)
    check('workspace 二次更新', updated2.workspace === dir2)
    check('二次更新目录存在', existsSync(dir2))

    // 404 场景
    let threw = false
    try {
      await manager.updateChannelWorkspace('nonexistent', dir1)
    }
    catch {
      threw = true
    }
    check('不存在的 channel 更新抛 404', threw)
  }
  finally {
    await disposeAll(manager)
    db.close()
    rmSync(resolve(process.cwd(), '.tmp-ws-a'), { recursive: true, force: true })
    rmSync(resolve(process.cwd(), '.tmp-ws-b'), { recursive: true, force: true })
  }
}

// ===== 测试 D: 消息 API 优先级路由 =====
async function testMessagePriorityRouting(): Promise<void> {
  console.log('\n━━━ 测试 D: 消息 API 优先级路由 ━━━')

  const { manager, db, repos } = setup()
  try {
    const ch = await manager.createChannel({
      name: '消息路由测试',
      leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 100 } },
    })
    const w1 = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'w1', harness: 'mock', config: { delayMs: 100 } })).id, role: 'worker' })
    attachScheduler(manager, ch.channelId)

    // immediate 消息:metadata 带 immediate
    const imm = await manager.sendImmediateMessage({
      channelId: ch.channelId,
      fromAgentId: '',
      toAgentId: w1.id,
      parts: [{ text: '实时消息' }],
    })
    check('immediate 消息带 priority metadata', imm.metadata?.['x-aw-msg-priority'] === 'immediate')

    // task 消息(经 sendA2A)
    const lead = (await manager.listChannelAgents(ch.channelId)).find(a => a.role === 'lead')!
    const tsk = await manager.sendA2A(ch.channelId, lead.id, {
      toAgentId: w1.id,
      parts: [{ text: '队列消息' }],
      metadata: { 'x-aw-msg-priority': 'task' },
    })
    check('task 消息带 priority metadata', tsk.metadata?.['x-aw-msg-priority'] === 'task')

    // 等消息被消费
    await sleep(300)
    const recent = repos.messages.listRecentByChannel(ch.channelId, 10)
    const w1Msgs = recent.filter(m => m.toAgentId === w1.id && m.partsJson.includes('消息'))
    check('消息已投递到 w1', w1Msgs.length >= 2, `消息数=${w1Msgs.length}`)
  }
  finally {
    await disposeAll(manager)
    db.close()
  }
}

// ===== 测试 E: OmpRpcAgentImpl cwd 直传验证 =====
async function testOmpImplCwdDirect(): Promise<void> {
  console.log('\n━━━ 测试 E: OmpRpcAgentImpl cwd 配置直传 ━━━')

  const customDir = resolve(process.cwd(), '.tmp-impl-cwd')
  mkdirSync(customDir, { recursive: true })
  writeFileSync(resolve(customDir, 'IMPL.txt'), 'impl-cwd-marker', 'utf8')

  try {
    // 直接构造 impl,验证 config.cwd 传入 OmpRpcClient
    const impl = new OmpRpcAgentImpl({ cwd: customDir, name: 'test', role: 'worker' })
    const config = (impl as unknown as { config: { cwd?: string } }).config
    check('OmpRpcAgentImpl 接受 cwd 配置', config.cwd === customDir, config.cwd)
  }
  finally {
    rmSync(customDir, { recursive: true, force: true })
  }
}

// ===== main =====
async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║  Workspace + API 集成测试                                   ║')
  console.log('╚════════════════════════════════════════════════════════════╝')

  await testDefaultWorkspace()
  await testWorkspaceUpdate()
  await testMessagePriorityRouting()
  await testOmpImplCwdDirect()
  await testCustomWorkspaceOmp() // 真实 omp,最慢放最后

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? `🎉 全部通过(${testCount} 项检查)` : `❌ ${failures}/${testCount} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
