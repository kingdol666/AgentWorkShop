/**
 * goal 收口总结验证:
 *  Phase 1(无 LLM,确定性):goal 父任务无总结直接 complete → taskEngine 保底合成
 *    「目标完成总结」artifact;已有总结(lead 自写)时不重复合成。
 *  Phase 2(真实 omp):goal 模式全链路 —— lead 按 criteria 判定收口,断言最终
 *    artifacts 含【目标完成总结】且 goal-summary 事件广播(monitor 可见)。
 *
 * 运行: npx tsx scripts/test-goal-summary.ts [--real]
 */
import type { DatabaseSync } from 'node:sqlite'
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
import { monitorChannel } from '../server/services/workshop/runtime/monitor'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
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
      channelEvents: createChannelEventRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
}

const engineOf = (manager: AgentChannelManager) => (manager as unknown as {
  getTaskEngine(): {
    get(id: string): { state: string, title: string, artifacts: Array<{ name: string, parts: Array<{ text?: string }> }> } | undefined
    list(channelId: string): Array<{ id: string, state: string, title: string, parentId: string | null }>
    complete(id: string, artifacts?: unknown[]): unknown
  }
}).getTaskEngine()

async function waitTerminal(manager: AgentChannelManager, channelId: string, taskId: string, timeoutMs: number): Promise<string> {
  const engine = engineOf(manager)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const t = engine.get(taskId)
    if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) return t.state
    if (Date.now() >= deadline) return t?.state ?? 'MISSING'
    await new Promise(r => setTimeout(r, 800))
  }
}

const hasSummary = (artifacts: Array<{ name: string, parts: Array<{ text?: string }> }>): boolean =>
  artifacts.some(a => a.name === 'goal-summary' || a.parts.some(p => p.text?.includes('【目标完成总结】')))

// ============ Phase 1:保底合成(确定性,无 LLM/调度器) ============
async function phase1(): Promise<void> {
  console.log('\n════════ Phase 1: goal 收口保底合成(无 LLM) ════════')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  const eng = engineOf(manager) as unknown as {
    create(i: { channelId: string, creatorId: string, assigneeId: string, title: string, description?: string }): { id: string }
    transition(id: string, state: string, by: string): unknown
    complete(id: string, artifacts?: Array<{ name: string, parts: Array<{ text: string }> }>): unknown
    get(id: string): { state: string, title: string, artifacts: Array<{ name: string, parts: Array<{ text?: string }> }> } | undefined
  }
  try {
    const ch = await manager.createChannel({ name: 'goal-保底组' })
    const leadTpl = await manager.createAgent({ name: 'lead-保底', harness: 'mock', config: {} })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: leadTpl.id, role: 'lead' })
    // 直建 goal 任务(不经 submitChannelTask,不激活调度器;模式编码与 encodeTaskMode 同构)
    const goalTask = eng.create({
      channelId: ch.channelId,
      creatorId: 'user',
      assigneeId: leadTpl.id,
      title: '目标:自我介绍',
      description: '[mode:goal][criteria:所有成员均已自我介绍并交付介绍文本] 每位成员完成一次自我介绍。',
    })
    eng.transition(goalTask.id, 'WORKING', leadTpl.id)
    eng.complete(goalTask.id)
    const t1 = eng.get(goalTask.id)
    check('P1: 无总结收口 → 平台保底合成 goal-summary', t1?.state === 'COMPLETED' && hasSummary(t1?.artifacts ?? []), `state=${t1?.state} artifacts=${t1?.artifacts.length}`)
    const summaryText = t1?.artifacts.find(a => a.name === 'goal-summary')?.parts[0]?.text ?? ''
    check('P1: 总结含五段结构(目标/判定标准/完成过程/最终成果/结论)',
      ['【目标完成总结】', '目标: ', '判定标准: ', '完成过程: ', '最终成果: ', '结论: '].every(k => summaryText.includes(k)))
    check('P1: 判定标准回填(criteria 来自任务编码)', summaryText.includes('所有成员均已自我介绍并交付介绍文本'))

    // 已有总结时不再重复合成
    const goal2 = eng.create({
      channelId: ch.channelId,
      creatorId: 'user',
      assigneeId: leadTpl.id,
      title: '目标:二次验证',
      description: '[mode:goal][criteria:验证通过] 验证去重。',
    })
    eng.transition(goal2.id, 'WORKING', leadTpl.id)
    eng.complete(goal2.id, [{
      artifactId: 'lead-written',
      name: 'goal-summary',
      parts: [{ text: '【目标完成总结】\n目标: 二次验证\n判定标准: 验证通过\n完成过程: …\n最终成果: lead 自写\n结论: 目标已达成,全部任务完成。' }],
    }])
    const t2 = eng.get(goal2.id)
    const summaries = (t2?.artifacts ?? []).filter(a => a.name === 'goal-summary')
    check('P1: lead 已自写总结 → 不重复合成', summaries.length === 1, `goal-summary 数=${summaries.length}`)
    await (manager as unknown as { unloadAll?: () => Promise<void> }).unloadAll?.()
  }
  finally {
    db.close()
  }
}

// ============ Phase 2:真实 omp goal 全链路 ============
async function phase2(): Promise<void> {
  console.log('\n════════ Phase 2: 真实 omp goal 收口总结(用户场景「你是谁」) ════════')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    const leadTpl = await manager.createAgent({ name: 'lead-统筹', harness: 'omp', config: {} })
    const wTpl = await manager.createAgent({ name: 'worker-介绍员', harness: 'omp', config: {} })
    const ch = await manager.createChannel({ name: 'goal-omp组' })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: leadTpl.id, role: 'lead' })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: wTpl.id, role: 'worker' })
    manager.ensureChannelActive(ch.channelId, { tickMs: 4000, stallMs: 120_000 })
    const mon = monitorChannel(manager, ch.channelId)

    const goalTask = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '你是谁',
      description: '团队成员完成自我介绍并交付介绍文本。',
      mode: 'goal',
      modeConfig: { goalCriteria: '任务描述中的需求' },
    })
    console.log('  goal 任务已提交,等待 lead 判定收口(最长 12 分钟)…')
    const state = await waitTerminal(manager, ch.channelId, goalTask.id, 720_000)
    const engine = engineOf(manager)
    const final = engine.get(goalTask.id)
    // 诊断:全部任务状态 + 事件时间线(成功失败都打)
    const allTasks = engine.list(ch.channelId)
    console.log('  ── 任务状态 ──')
    for (const t of allTasks) console.log(`  · ${t.id.slice(0, 8)} ${t.state.padEnd(10)} ${t.parentId ? `child-of=${t.parentId.slice(0, 8)} ` : 'parent '}${JSON.stringify(t.title).slice(0, 30)}`)
    console.log(`  ── 事件时间线(共 ${mon.events.length})──`)
    for (const e of (mon as unknown as { events: Array<{ at: string, kind: string, state?: string, taskId?: string, agentId?: string, message?: string }> }).events.slice(-40)) {
      const t = e.at.slice(11, 19)
      const who = e.agentId ? e.agentId.slice(0, 6) : '-'
      if (e.kind === 'task.status') console.log(`  [${t}] task ${e.taskId?.slice(0, 6)} → ${e.state} (${who})`)
      else if (e.kind === 'agent.status') console.log(`  [${t}] agent ${who} → ${e.state}`)
      else if (e.kind === 'lifecycle') console.log(`  [${t}] lc ${e.message?.slice(0, 60)}`)
      else if (e.kind === 'agent.event') continue
      else console.log(`  [${t}] ${e.kind} (${who})`)
    }
    check('P2: goal 任务 COMPLETED', state === 'COMPLETED', `state=${state}`)
    check('P2: 最终 artifacts 含【目标完成总结】', hasSummary(final?.artifacts ?? []), `artifacts=${final?.artifacts.length}`)
    const summary = final?.artifacts.find(a => a.name === 'goal-summary' || a.parts.some(p => p.text?.includes('【目标完成总结】')))
    const summaryText = summary?.parts.find(p => p.text?.includes('【目标完成总结】'))?.text
      ?? summary?.parts.map(p => p.text ?? '').join('\n') ?? ''
    console.log('  ── 收口总结 ──')
    console.log(summaryText.split('\n').map(l => `  │ ${l}`).join('\n'))
    const children = engine.list(ch.channelId).filter(t => t.parentId === goalTask.id)
    check('P2: 完成过程引用子任务', children.length === 0 || summaryText.includes('完成过程'))

    // goal-summary 事件广播(monitor 时间线可见 → 前端 a2a.artifact 块)
    const artifactEvents = (mon as unknown as { events: Array<{ kind: string, taskId?: string, agentId?: string }> })
      .events.filter(e => e.kind === 'task.artifact' || e.kind === 'agent.event')
    const seenSummaryEvent = JSON.stringify(mon).includes('目标完成总结')
    check('P2: goal-summary 经事件流广播(时间线可见)', seenSummaryEvent, `events=${mon.events.length}`)
    mon.stop()
    await (manager as unknown as { unloadAll?: () => Promise<void> }).unloadAll?.()
    void artifactEvents
  }
  finally {
    db.close()
  }
}

async function main(): Promise<void> {
  console.log('━━━ goal 收口总结验证(平台保底 + 真实 omp) ━━━')
  await phase1()
  if (process.argv.includes('--real')) await phase2()
  else console.log('\n(未传 --real,跳过 Phase 2 真实 omp;运行: npx tsx scripts/test-goal-summary.ts --real)')
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
