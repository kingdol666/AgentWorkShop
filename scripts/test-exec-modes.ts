/**
 * 执行模式差异验证(mock)— goal / loop / pipeline 三模式核心语义。
 *
 * 语义契约(与 execution-mode.ts 及 lead prompt 同构):
 *  - goal:     lead 接收目标 → dispatch 给 worker → worker 完成 → lead 判定目标是否满足;
 *              不满足 → 继续补充分发(goalRejectRounds 次);满足 → complete 父任务。
 *  - loop:     按 intervalMs 定时循环重放同一任务,达到 maxIterations 后停止(idle)。
 *  - pipeline: 按 stages 严格顺序分阶段执行,阶段 N 完成才启动 N+1;
 *              全部阶段完成后 complete 父任务,随即 idle(不判定 goal、不重放)。
 *
 * 运行: npx tsx scripts/test-exec-modes.ts
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
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
    await sleep(40)
  }
  return false
}

interface Harness {
  manager: AgentChannelManager
  db: ReturnType<typeof openWorkshopDb>
}

function setup(): Harness {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),
    channelEvents: createChannelEventRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  return { manager, db }
}

function getEngine(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
    }
  }).getTaskEngine()
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs = 50): void {
  manager.ensureChannelActive(channelId, { tickMs, stallMs: 60_000 })
}

async function cleanup(h: Harness): Promise<void> {
  await h.manager.shutdown()
  h.db.close()
}

const ms = (iso: string) => Date.parse(iso)

// ===== GOAL 模式:lead 判定不满足 → 继续分发;满足 → 标记完成 =====
async function testGoalMode(): Promise<void> {
  console.log('\n━━━ GOAL 模式:lead 满意度判定驱动补充分发(mock)━━━')

  const h = setup()
  try {
    const ch = await h.manager.createChannel({
      name: 'goal 测试',
      leadAgent: { name: 'lead-goal', harness: 'mock', config: { delayMs: 20, goalRejectRounds: 2 } },
    })
    await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w-goal', harness: 'mock', config: { delayMs: 20 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId)

    const engine = getEngine(h.manager)
    const task = await h.manager.submitChannelTask({
      channelId: ch.channelId,
      title: '目标任务',
      description: '交付完整设计文档',
      mode: 'goal',
      modeConfig: { goalCriteria: '设计文档需覆盖 3 项要点' },
    })

    const done = await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 20_000)
    const root = engine.get(task.id)
    const children = engine.list(ch.channelId).filter(t => t.parentId === task.id)

    check('goal 模式任务最终 COMPLETED', done && root?.state === 'COMPLETED', `state=${root?.state}`)
    // lead 判定"未完成"2 次 → 补充分发 2 轮;首轮 + 2 补充 = 3 个子任务
    check('lead 判断未满足 → 继续分发(子任务数=1+2)', children.length === 3, `子任务数=${children.length}`)
    check('补充轮次标题正确(第 1/2 轮)', children.some(c => c.title.includes('目标补充第 1 轮')) && children.some(c => c.title.includes('目标补充第 2 轮')))
    check('全部子任务 COMPLETED', children.every(c => c.state === 'COMPLETED'))
    // 补充轮严格在上一轮完成后才创建(先判定后分发,不会并行)
    const ordered = children.length === 3
      && ms(children[1]!.createdAt) >= ms(children[0]!.updatedAt)
      && ms(children[2]!.createdAt) >= ms(children[1]!.updatedAt)
    check('补充分发为顺序判定(上一轮完成才判下一轮)', ordered)
    check('父任务在最终轮完成后才收口', ms(root!.updatedAt) >= ms(children[2]!.updatedAt))
    check('goal criteria 编码进 description', root?.description?.includes('[criteria:设计文档需覆盖 3 项要点]') ?? false)

    // 对照:goalRejectRounds=0 → lead 一次判定即满足,仅 1 个子任务(不无谓补发)
    const ch2 = await h.manager.createChannel({
      name: 'goal 一次通过',
      leadAgent: { name: 'lead-goal-ok', harness: 'mock', config: { delayMs: 20, goalRejectRounds: 0 } },
    })
    await h.manager.addAgentToChannel({
      channelId: ch2.channelId,
      agentId: (await h.manager.createAgent({ name: 'w-goal-ok', harness: 'mock', config: { delayMs: 20 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch2.channelId)
    const task2 = await h.manager.submitChannelTask({
      channelId: ch2.channelId,
      title: '一次通过目标',
      description: '简单目标',
      mode: 'goal',
      modeConfig: { goalCriteria: '完成即可' },
    })
    await waitUntil(() => engine.get(task2.id)?.state === 'COMPLETED', 20_000)
    const children2 = engine.list(ch2.channelId).filter(t => t.parentId === task2.id)
    check('判定满足时一次分发即完成(子任务数=1)', children2.length === 1, `子任务数=${children2.length}`)
  }
  finally {
    await cleanup(h)
  }
}

// ===== PIPELINE 模式:顺序阶段执行,完成后即 idle(不判定 goal、不重放) =====
async function testPipelineMode(): Promise<void> {
  console.log('\n━━━ PIPELINE 模式:阶段顺序执行 + 完成后 idle(mock)━━━')

  const h = setup()
  try {
    const ch = await h.manager.createChannel({
      name: 'pipeline 测试',
      leadAgent: { name: 'lead-pipe', harness: 'mock', config: { delayMs: 20 } },
    })
    await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w-pipe', harness: 'mock', config: { delayMs: 20 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId)

    const engine = getEngine(h.manager)
    const task = await h.manager.submitChannelTask({
      channelId: ch.channelId,
      title: '流水线任务',
      description: '分阶段交付',
      mode: 'pipeline',
      modeConfig: {
        stages: [
          { name: '需求分析', description: '输出需求清单' },
          { name: '编码实现', description: '按需求落码' },
          { name: '测试验证', description: '回归通过' },
        ],
      },
    })

    const done = await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 20_000)
    const root = engine.get(task.id)
    const children = engine.list(ch.channelId).filter(t => t.parentId === task.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    check('pipeline 主任务 COMPLETED', done && root?.state === 'COMPLETED', `state=${root?.state}`)
    check('阶段子任务数 = 阶段数(3)', children.length === 3, `子任务数=${children.length}`)
    check('子任务标题按阶段命名', children[0]?.title.includes('Stage 1: 需求分析') === true
    && children[1]?.title.includes('Stage 2: 编码实现') === true
    && children[2]?.title.includes('Stage 3: 测试验证') === true)
    check('全部阶段子任务 COMPLETED', children.every(c => c.state === 'COMPLETED'))
    // 严格顺序:阶段 N+1 必须在阶段 N 完成后创建
    const ordered = children.length === 3
      && ms(children[1]!.createdAt) >= ms(children[0]!.updatedAt)
      && ms(children[2]!.createdAt) >= ms(children[1]!.updatedAt)
    check('阶段顺序:上一阶段完成才启动下一阶段', ordered,
      `S2创建=${children[1]?.createdAt.slice(17, 23)} vs S1完成=${children[0]?.updatedAt.slice(17, 23)}`)
    // 上一阶段产出作为下一阶段输入(dispatch parts → 子任务初始 artifact)
    const stage2Artifacts = children[1]!.artifacts.flatMap(a => a.parts)
    check('阶段交接:阶段 2 收到上一阶段成果', stage2Artifacts.some(p => 'text' in p && p.text.includes('上一阶段成果')))
    check('父任务汇总产物存在', (root?.artifacts.length ?? 0) > 0, `artifacts=${root?.artifacts.length}`)

    // 执行结束即 idle:完成后无 goal 判定、无循环重放、无新任务产生
    const before = engine.list(ch.channelId).length
    await sleep(800)
    const after = engine.list(ch.channelId).length
    const afterRoot = engine.get(task.id)
    check('执行结束即 idle(800ms 内无新任务/重放)', before === after && afterRoot?.state === 'COMPLETED',
      `任务数 ${before} → ${after}`)
  }
  finally {
    await cleanup(h)
  }
}

// ===== LOOP 模式:定时循环重放,限次后停止 =====
async function testLoopMode(): Promise<void> {
  console.log('\n━━━ LOOP 模式:定时循环重放 + maxIterations 停止(mock)━━━')

  const h = setup()
  try {
    const ch = await h.manager.createChannel({
      name: 'loop 测试',
      leadAgent: { name: 'lead-loop', harness: 'mock', config: { delayMs: 20 } },
    })
    await h.manager.addAgentToChannel({
      channelId: ch.channelId,
      agentId: (await h.manager.createAgent({ name: 'w-loop', harness: 'mock', config: { delayMs: 20 } })).id,
      role: 'worker',
    })
    attachScheduler(h.manager, ch.channelId, 40)

    const engine = getEngine(h.manager)
    const title = '循环采集任务'
    const intervalMs = 350
    const maxIterations = 3
    const task = await h.manager.submitChannelTask({
      channelId: ch.channelId,
      title,
      description: '周期采集',
      mode: 'loop',
      modeConfig: { intervalMs, maxIterations },
    })

    // maxIterations=3 → 首轮 + 2 次重放,共 3 个同题任务全部完成
    const ok = await waitUntil(() => {
      const rounds = engine.list(ch.channelId).filter(t => t.title === title && !t.parentId)
      return rounds.length >= maxIterations && rounds.every(t => t.state === 'COMPLETED')
    }, 20_000)

    const rounds = engine.list(ch.channelId).filter(t => t.title === title && !t.parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    check('loop 按限次重放完毕(任务数=maxIterations)', ok && rounds.length === maxIterations, `轮数=${rounds.length}`)
    check('全部轮次 COMPLETED', rounds.every(t => t.state === 'COMPLETED'))
    const spaced = rounds.length >= 2
      && ms(rounds[1]!.createdAt) - ms(rounds[0]!.updatedAt) >= intervalMs - 120
    check('定时循环:重放间隔 ≥ intervalMs(容差 120ms)',
      spaced,
      rounds.length >= 2 ? `实测间隔=${ms(rounds[1]!.createdAt) - ms(rounds[0]!.updatedAt)}ms(要求 ≥ ${intervalMs - 120})` : '轮数不足')
    const secondSpaced = rounds.length >= 3
      && ms(rounds[2]!.createdAt) - ms(rounds[1]!.updatedAt) >= intervalMs - 120
    check('第二轮重放同样遵循间隔', secondSpaced,
      rounds.length >= 3 ? `实测间隔=${ms(rounds[2]!.createdAt) - ms(rounds[1]!.updatedAt)}ms` : '')
    // 每轮 = 一次 dispatch → 执行 → complete(无 goal 判定,无多子任务)
    check('每轮仅 1 个子任务(loop 不判定 goal)', rounds.every(r =>
      engine.list(ch.channelId).filter(t => t.parentId === r.id).length === 1))
    check('首轮任务 COMPLETED', engine.get(task.id)?.state === 'COMPLETED')

    // 达到 maxIterations 后停止:再等待 > 一个周期,任务数不再增长
    const before = rounds.length
    await sleep(intervalMs + 600)
    const after = engine.list(ch.channelId).filter(t => t.title === title && !t.parentId).length
    check('达到 maxIterations 后停止循环(不再重放)', after === before, `轮数 ${before} → ${after}`)
  }
  finally {
    await cleanup(h)
  }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  执行模式差异验证(mock):goal / pipeline / loop               ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  await testGoalMode()
  await testPipelineMode()
  await testLoopMode()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${failures === 0 ? `🎉 全部通过(${testCount} 项检查)` : `❌ ${failures}/${testCount} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
