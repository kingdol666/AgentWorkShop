/**
 * 真实 omp harness 综合场景测试 — 多 worker 多任务 + worker 互通信 + goal/loop/pipeline 三种模式。
 *
 * 场景:
 *  A. 多任务分发:lead 给 2 个 worker 分发多个任务,worker 执行并在作业中互相发消息
 *  B. goal 模式:lead 按目标标准持续作业直到满足后完成
 *  C. loop 模式:任务完成后按 interval 循环重放(maxIterations 限制)
 *  D. pipeline 模式:lead 按 stages 流水线逐阶段执行
 *
 * 模板复用:一个 lead 模板 + 两个 worker 模板,克隆进多个独立 channel(各自独立实例)。
 *
 * 运行: npx tsx scripts/e2e-omp-modes.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
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
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function check(name: string, ok: boolean, detail = ''): void {
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

/** 紧凑时间线:只保留任务/成员/生命周期事件,跳过 agent.event 噪音 */
function compactTimeline(mon: ReturnType<typeof monitorChannel>): string {
  const lines = [`monitor: ${mon.channelId.slice(0, 8)}… events=${mon.events.length}`]
  for (const e of mon.events) {
    const t = e.at.slice(11, 23)
    if (e.kind === 'agent.event') continue
    if (e.kind === 'task.status') lines.push(`  [${t}] task.status ${e.taskId.slice(0, 8)} → ${e.state}${e.agentId ? ` (by ${e.agentId.slice(0, 8)})` : ''}`)
    else if (e.kind === 'task.progress') lines.push(`  [${t}] task.progress ${e.taskId.slice(0, 8)} = ${e.progress}%`)
    else if (e.kind === 'agent.status') lines.push(`  [${t}] agent.status ${e.agentId.slice(0, 8)} → ${e.state}`)
    else if (e.kind === 'lifecycle') lines.push(`  [${t}] lifecycle ${e.message}`)
  }
  return lines.join('\n')
}

function engineOf(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): { state: string, title: string, parentId: string | null, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined
      list(channelId: string): Array<{ id: string, state: string, title: string, parentId: string | null, artifacts: Array<{ parts: Array<{ text?: string }> }> }>
    }
  }).getTaskEngine()
}

/** 等待某主任务进入终态 */
async function waitTerminal(manager: AgentChannelManager, channelId: string, taskId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  const engine = engineOf(manager)
  for (;;) {
    const t = engine.get(taskId)
    if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) return t.state
    if (Date.now() >= deadline) return engine.get(taskId)?.state ?? 'MISSING'
    await sleep(500)
  }
}

/** 卸载空闲实例(释放 omp 子进程) */
async function unloadAll(manager: AgentChannelManager): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await manager.unloadIdleAgents()
    if (manager.runtimeStatus().wiredAgents.length === 0) return
    await sleep(500)
  }
}

async function main(): Promise<void> {
  console.log('━━━ 真实 omp harness 综合场景:多任务/通信/goal/loop/pipeline ━━━')

  const ws = resolve(process.cwd(), '.tmp-omp-modes')
  mkdirSync(ws, { recursive: true })
  writeFileSync(resolve(ws, 'input.txt'), '甲文件内容:苹果 3 个,梨 2 个', 'utf8')
  writeFileSync(resolve(ws, 'note.txt'), '乙文件内容:会议纪要待汇总', 'utf8')

  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  const messagesRepo = createMessageRepo(db)
  const monitors: ReturnType<typeof monitorChannel>[] = []
  try {
    // ---- 模板(一次创建,克隆进各 channel)----
    const leadTpl = await manager.createAgent({ name: 'lead-统筹', harness: 'omp', config: {} })
    const wTplA = await manager.createAgent({ name: 'worker-甲', harness: 'omp', config: {} })
    const wTplB = await manager.createAgent({ name: 'worker-乙', harness: 'omp', config: {} })

    const newChannel = async (name: string) => {
      const ch = await manager.createChannel({ name, workspace: ws })
      await manager.addAgentToChannel({ channelId: ch.channelId, agentId: leadTpl.id, role: 'lead' })
      return ch
    }
    const addWorker = async (channelId: string, tplId: string) => {
      await manager.addAgentToChannel({ channelId, agentId: tplId, role: 'worker' })
    }

    // ========== A. 多任务分发 + worker 互通信 ==========
    console.log('\n════════ A. 多任务分发 + worker 作业中互通信 ════════')
    const chA = await newChannel('多任务通信组')
    await addWorker(chA.channelId, wTplA.id)
    await addWorker(chA.channelId, wTplB.id)
    manager.ensureChannelActive(chA.channelId, { tickMs: 4000, stallMs: 60_000 })
    const monA = monitorChannel(manager, chA.channelId)
    monitors.push(monA)

    const t1 = await manager.submitChannelTask({ channelId: chA.channelId, title: '读取 input.txt 并通知同事', description: '读取工作目录里的 input.txt,把内容作为成果,然后调用 send_message 工具给同事 worker 发送一条包含文件内容的简讯,最后完成任务。简短回答。' })
    const t2 = await manager.submitChannelTask({ channelId: chA.channelId, title: '读取 note.txt 并通知同事', description: '读取工作目录里的 note.txt,把内容作为成果,然后调用 send_message 工具给同事 worker 发送一条包含文件内容的简讯,最后完成任务。简短回答。' })
    check('A: 提交 2 个任务', !!t1.id && !!t2.id)
    const s1 = await waitTerminal(manager, chA.channelId, t1.id, 300_000)
    const s2 = await waitTerminal(manager, chA.channelId, t2.id, 300_000)
    check('A: 两个任务全部完成', s1 === 'COMPLETED' && s2 === 'COMPLETED', `t1=${s1} t2=${s2}`)

    const engineA = engineOf(manager)
    const childrenA = engineA.list(chA.channelId).filter(t => t.parentId === t1.id || t.parentId === t2.id)
    check('A: lead 分发了子任务给 worker', childrenA.length >= 1, `子任务=${childrenA.length}`)

    // worker 互通信:两个 worker 实例之间至少有一条消息
    const workersA = await manager.listChannelAgents(chA.channelId)
    const workerIds = new Set(workersA.filter(a => a.role === 'worker').map(a => a.id))
    const interMsgs = messagesRepo.listRecentByChannel(chA.channelId, 100)
      .filter(m => m.fromAgentId && workerIds.has(m.fromAgentId) && m.toAgentId && workerIds.has(m.toAgentId))
    check('A: worker 作业中互相通信(消息落库)', interMsgs.length >= 1, `消息=${interMsgs.length}`)
    for (const m of interMsgs.slice(0, 2)) {
      console.log(`     msg ${m.fromAgentId!.slice(0, 8)} → ${m.toAgentId!.slice(0, 8)}: ${JSON.parse(m.partsJson).map((p: { text?: string }) => p.text ?? '').join('').slice(0, 60)}`)
    }
    console.log('\n--- A 监控时间线 ---')
    console.log(compactTimeline(monA))
    monA.stop()
    await unloadAll(manager)

    // ========== B. goal 模式 ==========
    console.log('\n════════ B. goal 模式 ════════')
    const chB = await newChannel('goal 模式组')
    await addWorker(chB.channelId, wTplA.id)
    manager.ensureChannelActive(chB.channelId, { tickMs: 4000, stallMs: 60_000 })
    const monB = monitorChannel(manager, chB.channelId)
    monitors.push(monB)
    const goalTask = await manager.submitChannelTask({
      channelId: chB.channelId,
      title: '目标:复述 input.txt 内容',
      description: '读取 input.txt 并原样复述其内容作为成果。',
      mode: 'goal',
      modeConfig: { goalCriteria: 'input.txt 的内容已被读取并写入任务成果' },
    })
    check('B: goal 任务已提交', !!goalTask.id)
    const gs = await waitTerminal(manager, chB.channelId, goalTask.id, 300_000)
    const gFinal = engineOf(manager).get(goalTask.id)
    check('B: goal 任务完成(COMPLETED)', gs === 'COMPLETED', `state=${gs}`)
    check('B: goal 任务有成果', (gFinal?.artifacts.length ?? 0) > 0, `artifacts=${gFinal?.artifacts.length}`)
    console.log('\n--- B 监控时间线 ---')
    console.log(compactTimeline(monB))
    monB.stop()
    await unloadAll(manager)

    // ========== C. loop 模式 ==========
    console.log('\n════════ C. loop 模式 ════════')
    const chC = await newChannel('loop 模式组')
    await addWorker(chC.channelId, wTplA.id)
    manager.ensureChannelActive(chC.channelId, { tickMs: 4000, stallMs: 60_000 })
    const monC = monitorChannel(manager, chC.channelId)
    monitors.push(monC)
    const loopTask = await manager.submitChannelTask({
      channelId: chC.channelId,
      title: '循环任务:复述 input.txt',
      description: '读取 input.txt 并复述其内容作为成果。',
      mode: 'loop',
      modeConfig: { intervalMs: 4000, maxIterations: 2 },
    })
    check('C: loop 任务已提交', !!loopTask.id)
    const ls1 = await waitTerminal(manager, chC.channelId, loopTask.id, 300_000)
    check('C: 首次执行完成', ls1 === 'COMPLETED', `state=${ls1}`)
    // 等待循环重放:出现第 2 个同名任务并终态
    const engineC = engineOf(manager)
    const waitLoopReplay = async (): Promise<number> => {
      const deadline = Date.now() + 120_000
      for (;;) {
        const same = engineC.list(chC.channelId).filter(t => t.title === '循环任务:复述 input.txt')
        const allTerminal = same.length >= 1 && same.every(t => ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state))
        if (same.length >= 2 && allTerminal) return same.length
        if (Date.now() >= deadline) return same.length
        await sleep(500)
      }
    }
    const loopCount = await waitLoopReplay()
    check('C: loop 循环重放(max=2 → 至少 2 次执行)', loopCount >= 2, `执行次数=${loopCount}`)
    console.log('\n--- C 监控时间线 ---')
    console.log(compactTimeline(monC))
    monC.stop()
    await unloadAll(manager)

    // ========== D. pipeline 模式 ==========
    console.log('\n════════ D. pipeline 模式 ════════')
    const chD = await newChannel('pipeline 流水线组')
    await addWorker(chD.channelId, wTplA.id)
    await addWorker(chD.channelId, wTplB.id)
    manager.ensureChannelActive(chD.channelId, { tickMs: 4000, stallMs: 60_000 })
    const monD = monitorChannel(manager, chD.channelId)
    monitors.push(monD)
    const pipeTask = await manager.submitChannelTask({
      channelId: chD.channelId,
      title: '流水线:读取并汇总两个文件',
      description: '按阶段执行:第一阶段读取 input.txt 和 note.txt,第二阶段把两者内容合并为一份汇总成果。',
      mode: 'pipeline',
      modeConfig: {
        stages: [
          { name: '读取', description: '读取 input.txt 与 note.txt 内容' },
          { name: '汇总', description: '把两个文件内容合并成汇总成果' },
        ],
      },
    })
    check('D: pipeline 任务已提交', !!pipeTask.id)
    const ps = await waitTerminal(manager, chD.channelId, pipeTask.id, 300_000)
    const engineD = engineOf(manager)
    const stages = engineD.list(chD.channelId).filter(t => t.parentId === pipeTask.id)
    const allStageDone = stages.length > 0 && stages.every(s => s.state === 'COMPLETED')
    check('D: pipeline 主任务完成(COMPLETED)', ps === 'COMPLETED', `state=${ps}`)
    check('D: 阶段子任务全部完成', allStageDone, `stages=${stages.length} states=[${stages.map(s => s.state).join(',')}]`)
    const pipeTexts = stages.flatMap(s => s.artifacts.flatMap(a => a.parts.filter(p => 'text' in p).map(p => (p as { text: string }).text))).join('\n')
    check('D: 成果覆盖两个文件内容', pipeTexts.includes('苹果') && pipeTexts.includes('纪要'), `text=${pipeTexts.slice(0, 60)}…`)
    console.log('\n--- D 监控时间线 ---')
    console.log(compactTimeline(monD))
    monD.stop()
    await unloadAll(manager)
  }
  finally {
    for (const mon of monitors) mon.stop()
    await manager.shutdown()
    db.close()
    rmSync(ws, { recursive: true, force: true })
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('综合测试异常:', e)
  process.exit(1)
})
