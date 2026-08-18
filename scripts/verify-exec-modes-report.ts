/**
 * 执行模式验证报告(mock lead)— goal / pipeline / loop 三模式端到端 + goal 模式总结性输出。
 *
 * 验证目标:
 *  - goal:    lead 判定目标满足后必须产出「目标完成总结」(goal-summary artifact,结论化最终描述)
 *  - pipeline:按阶段顺序执行,阶段交接传递上一阶段成果,完成后父任务汇总交付
 *  - loop:    定时循环重放,达到 maxIterations 后停止,每轮完整完成
 *
 * 运行:pnpm tsx scripts/verify-exec-modes-report.ts
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
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { WorkspaceTask, TaskState } from '../server/services/workshop/types/task'

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passes += 1
  else failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(30)
  }
  return cond()
}

interface Harness {
  manager: AgentChannelManager
  db: ReturnType<typeof openWorkshopDb>
  channelId: string
}

async function setup(leadName: string, leadConfig: Record<string, unknown>, workerName = 'worker'): Promise<Harness> {
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
  const ch = await manager.createChannel({ name: `${leadName} 频道`, leadAgent: { name: leadName, harness: 'mock', config: leadConfig } })
  await manager.addAgentToChannel({
    channelId: ch.channelId,
    agentId: (await manager.createAgent({ name: workerName, harness: 'mock', config: { delayMs: 15 } })).id,
    role: 'worker',
  })
  manager.ensureChannelActive(ch.channelId, { tickMs: 40, stallMs: 60_000 })
  return { manager, db, channelId: ch.channelId }
}

function getEngine(manager: AgentChannelManager) {
  const internal = manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
    }
  }
  return internal.getTaskEngine()
}

async function teardown(h: Harness): Promise<void> {
  await h.manager.shutdown()
  h.db.close()
}

function artifactText(a: { parts: Array<{ text?: string, data?: unknown }> }): string {
  return a.parts.map(p => p.text ?? JSON.stringify(p.data ?? '')).join('\n')
}

// ===== 1. GOAL 模式 =====
async function runGoal(): Promise<void> {
  console.log('\n[1] GOAL 模式 —— 目标满意度判定 + 完成后的总结性输出')
  const h = await setup('lead-goal', { delayMs: 15, goalRejectRounds: 1 })
  try {
    const engine = getEngine(h.manager)
    const criteria = '设计文档需覆盖需求清单、架构与测试要点'
    const task = await h.manager.submitChannelTask({
      channelId: h.channelId,
      title: '交付完整设计文档',
      description: '输出一份完整设计文档',
      mode: 'goal',
      modeConfig: { goalCriteria: criteria },
    })
    const done = await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 20_000)
    const root = engine.get(task.id)!
    const children = engine.list(h.channelId).filter(t => t.parentId === task.id)

    console.log(`  主任务: "${root.title}" state=${root.state} 子任务数=${children.length}`)
    check('主任务最终 COMPLETED', done, `state=${String(root.state)}`)
    check('判定未满足 → 补充分发 1 轮(子任务数=2)', children.length === 2, `子任务数=${children.length}`)
    check('补充轮在首轮完成后才创建(顺序判定)', children.length === 2 && ms(children[1]!.createdAt) >= ms(children[0]!.updatedAt))
    check('全部子任务 COMPLETED', children.every(c => c.state === 'COMPLETED'))

    // 总结性输出断言:goal-summary artifact 含结构化结论
    const goalSummary = root.artifacts.find(a => a.name === 'goal-summary')
    const summaryText = goalSummary ? artifactText(goalSummary) : ''
    check('目标满足后产出 goal-summary 总结 artifact', !!goalSummary, `artifacts=${root.artifacts.map(a => a.name).join(',')}`)
    check('总结含「目标完成总结」标题', summaryText.includes('【目标完成总结】'))
    check('总结含目标描述', summaryText.includes(root.title))
    check('总结含判定标准', summaryText.includes(criteria))
    check('总结含完成过程(子任务链)', summaryText.includes('全部完成') && summaryText.includes('「'))
    check('总结含最终成果与结论', summaryText.includes('最终成果') && summaryText.includes('结论: 目标已达成'))

    console.log(`  ── goal-summary 总结内容 ──\n${summaryText.split('\n').map(l => `    ${l}`).join('\n')}`)
  }
  finally {
    await teardown(h)
  }
}

// ===== 2. PIPELINE 模式 =====
async function runPipeline(): Promise<void> {
  console.log('\n[2] PIPELINE 模式 —— 阶段顺序执行 + 父任务汇总交付')
  const h = await setup('lead-pipe', { delayMs: 15 })
  try {
    const engine = getEngine(h.manager)
    const stages = [
      { name: '需求分析', description: '输出需求清单' },
      { name: '编码实现', description: '按需求落码' },
      { name: '测试验证', description: '回归通过' },
    ]
    const task = await h.manager.submitChannelTask({
      channelId: h.channelId,
      title: '流水线任务',
      description: '分阶段交付',
      mode: 'pipeline',
      modeConfig: { stages },
    })
    const done = await waitUntil(() => engine.get(task.id)?.state === 'COMPLETED', 20_000)
    const root = engine.get(task.id)!
    const children = engine.list(h.channelId).filter(t => t.parentId === task.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    console.log(`  主任务: "${root.title}" state=${root.state} 阶段子任务=${children.length}`)
    check('主任务 COMPLETED', done, `state=${String(root.state)}`)
    check('阶段子任务数 = 阶段数(3)', children.length === 3, `子任务数=${children.length}`)
    check('阶段按序命名(Stage 1..3)', children[0]?.title.includes('Stage 1: 需求分析') === true
    && children[1]?.title.includes('Stage 2: 编码实现') === true
    && children[2]?.title.includes('Stage 3: 测试验证') === true)
    check('全部阶段 COMPLETED', children.every(c => c.state === 'COMPLETED'))
    check('阶段顺序:上一阶段完成才启动下一阶段', children.length === 3
    && ms(children[1]!.createdAt) >= ms(children[0]!.updatedAt)
    && ms(children[2]!.createdAt) >= ms(children[1]!.updatedAt))
    const stage2Input = children[1]!.artifacts.flatMap(a => a.parts)
    check('阶段交接:阶段 2 携带上一阶段成果', stage2Input.some(p => 'text' in p && p.text.includes('上一阶段成果')))
    check('父任务汇总 artifact 存在(summary)', root.artifacts.some(a => a.name === 'summary'), `artifacts=${root.artifacts.map(a => a.name).join(',')}`)
    const summary = root.artifacts.find(a => a.name === 'summary')
    if (summary) {
      const text = artifactText(summary)
      console.log(`  ── 父任务汇总 ──\n${text.split('\n').filter(Boolean).slice(-3).map(l => `    ${l}`).join('\n')}`)
    }
  }
  finally {
    await teardown(h)
  }
}

// ===== 3. LOOP 模式 =====
async function runLoop(): Promise<void> {
  console.log('\n[3] LOOP 模式 —— 定时循环重放 + maxIterations 停止')
  const h = await setup('lead-loop', { delayMs: 15 })
  try {
    const engine = getEngine(h.manager)
    const title = '循环采集任务'
    const intervalMs = 250
    const maxIterations = 3
    await h.manager.submitChannelTask({
      channelId: h.channelId,
      title,
      description: '周期采集',
      mode: 'loop',
      modeConfig: { intervalMs, maxIterations },
    })
    const ok = await waitUntil(() => {
      const rounds = engine.list(h.channelId).filter(t => t.title === title && !t.parentId)
      return rounds.length >= maxIterations && rounds.every(t => t.state === 'COMPLETED')
    }, 20_000)
    const rounds = engine.list(h.channelId).filter(t => t.title === title && !t.parentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    console.log(`  主任务轮次=${rounds.length}(首轮 + ${rounds.length - 1} 次重放)`)
    check('循环轮次达到 maxIterations(3)', ok && rounds.length === 3, `轮次=${rounds.length}`)
    check('每轮完整完成(COMPLETED)', rounds.every(t => t.state === 'COMPLETED'))
    check('轮次按间隔重放(时间递增)', rounds.length >= 2 && ms(rounds[1]!.createdAt) >= ms(rounds[0]!.createdAt))
    // 达到上限后停止:800ms 内不再出现新轮次
    const before = engine.list(h.channelId).length
    await sleep(800)
    const after = engine.list(h.channelId).length
    check('达到 maxIterations 后停止重放(无新轮次)', before === after, `任务数 ${before} → ${after}`)
    const last = rounds.at(-1)!
    const states = rounds.map(t => t.state as TaskState).join(',')
    console.log(`  各轮状态: ${states} | 最后一轮完成于 ${last.updatedAt.slice(11, 23)}`)
  }
  finally {
    await teardown(h)
  }
}

const ms = (iso: string) => Date.parse(iso)

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(' AgentWorkShop 执行模式验证报告(mock lead)')
  console.log(' goal / pipeline / loop 三模式端到端 + 目标完成总结性输出')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  await runGoal()
  await runPipeline()
  await runLoop()

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(` 报告汇总: ${passes} PASS / ${failures} FAIL`)
  console.log('  1) GOAL     — 满意度判定闭环 + goal-summary 总结性输出 ✓(以断言为准)')
  console.log('  2) PIPELINE — 阶段顺序执行 + 阶段成果交接 + 父任务汇总')
  console.log('  3) LOOP     — 定时重放 + maxIterations 限次停止')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
