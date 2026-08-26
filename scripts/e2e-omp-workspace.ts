/**
 * 真实 omp harness 场景测试 — tmp 文件夹作为 workspace。
 *
 * 场景(简单):
 *  1. 在 .tmp-omp-e2e/ 建 workspace,放入 input.txt(一段简单内容)
 *  2. createChannel(workspace=tmp, leadAgent=omp)→ lead 模板 + 克隆实例
 *  3. createAgent(omp) 模板 → addAgentToChannel 克隆 worker 实例
 *  4. ensureChannelActive + monitorChannel 挂监控
 *  5. submitChannelTask:lead 分配,worker 用 omp 原生 read 工具读取 input.txt,回写成果
 *  6. 监控执行过程(dispatch/working/progress/artifact/completed)
 *
 * 运行: npx tsx scripts/e2e-omp-workspace.ts
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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function main(): Promise<void> {
  console.log('━━━ 真实 omp harness:tmp workspace 任务执行 + 监控 ━━━')

  const ws = resolve(process.cwd(), '.tmp-omp-e2e')
  mkdirSync(ws, { recursive: true })
  const payload = '真实场景作业:omp 读取此文件并原样回写成果'
  writeFileSync(resolve(ws, 'input.txt'), payload, 'utf8')

  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  try {
    // ---- 1. 创建 Channel(tmp workspace + omp lead)----
    console.log('\n--- 1. 创建 Channel(workspace=tmp)---')
    const ch = await manager.createChannel({
      name: 'OMP 真实场景',
      description: 'tmp workspace 简单作业',
      workspace: ws,
      leadAgent: { name: 'lead-主理人', harness: 'omp', config: {} },
    })
    check('Channel 创建成功(workspace 生效)', ch.workspace === ws && !!ch.leadAgentId)

    // ---- 2. Agent 模板 → 克隆 worker 实例 ----
    console.log('\n--- 2. Agent 模板克隆 worker 实例 ---')
    const workerTpl = await manager.createAgent({ name: 'worker-执行者', harness: 'omp', config: {} })
    const worker = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: workerTpl.id, role: 'worker' })
    check('worker 克隆出独立实例 id', worker.id !== workerTpl.id)
    check('成员结构 1 lead + 1 worker', (await manager.listChannelAgents(ch.channelId)).length === 2)

    // ---- 3. 激活 + 挂监控 ----
    console.log('\n--- 3. 激活 channel + 挂监控 ---')
    manager.ensureChannelActive(ch.channelId, { tickMs: 3000, stallMs: 60_000 })
    const mon = monitorChannel(manager, ch.channelId)
    check('监控器已启动', mon.events.some(e => e.kind === 'lifecycle'))

    // ---- 4. 提交任务(lead 真实 omp 分配)----
    console.log('\n--- 4. 提交任务 ---')
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '读取并复述 input.txt',
      description: '读取工作目录里的 input.txt 文件,把内容原样写在任务成果里,然后完成任务。简短回答。',
    })
    check('任务已提交(SUBMITTED)', task.state === 'SUBMITTED', `state=${task.state}`)
    console.log(`  task=${task.id.slice(0, 8)}…`)

    // ---- 5. 监控执行(定向等待主任务 COMPLETED;omp 真实推理,给足时间)----
    console.log('\n--- 5. 监控执行过程(真实 omp)---')
    const started = Date.now()
    const done = await mon.waitFor(e => e.kind === 'task.status' && e.taskId === task.id && e.state === 'COMPLETED', 240_000)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  ⏱  耗时 ${elapsed}s`)
    check('主任务执行完成(COMPLETED)', done !== null)

    const seenAssigned = mon.events.some(e => e.kind === 'task.status' && e.state === 'ASSIGNED')
    const seenWorking = mon.events.some(e => e.kind === 'task.status' && e.state === 'WORKING')
    const seenProgress = mon.events.some(e => e.kind === 'task.progress' && e.progress > 0)
    const seenArtifact = mon.events.some(e => e.kind === 'agent.event' && e.event.kind === 'artifact')
    const seenBusy = mon.events.some(e => e.kind === 'agent.status' && e.state === 'busy')
    const seenIdle = mon.events.some(e => e.kind === 'agent.status' && e.state === 'idle')
    check('监控到任务进入 WORKING', seenWorking)
    check('监控到进度上报', seenProgress)
    check('监控到成员 busy → idle', seenBusy && seenIdle)
    if (!seenAssigned) console.log('  信息:未捕获 ASSIGNED 事件(omp host tool 分发路径可能跳过显式 ASSIGNED 状态事件)')
    if (!seenArtifact) console.log('  信息:未捕获 artifact 事件(成果可能直接落入任务 artifacts,不经过 agent.event)')

    // ---- 6. 终态校验(成果包含 payload)----
    const engine = (manager as unknown as {
      getTaskEngine(): { list(channelId: string): Array<{ id: string, parentId: string | null, state: string, artifacts: Array<{ parts: Array<{ text?: string }> }> }> }
    }).getTaskEngine()
    const allTasks = engine.list(ch.channelId)
    const children = allTasks.filter(t => t.parentId === task.id)
    const finalTask = allTasks.find(t => t.id === task.id)
    const artifactTexts = (finalTask?.artifacts ?? []).flatMap(a => a.parts.filter(p => 'text' in p).map(p => (p as { text: string }).text)).join('\n')
    const childTexts = children.flatMap(c => c.artifacts.flatMap(a => a.parts.filter(p => 'text' in p).map(p => (p as { text: string }).text))).join('\n')
    check('lead 分配了子任务', children.length >= 1, `子任务=${children.length}`)
    check('主任务 COMPLETED + 有成果', finalTask?.state === 'COMPLETED' && (finalTask?.artifacts.length ?? 0) > 0, `state=${finalTask?.state} artifacts=${finalTask?.artifacts.length}`)
    check('成果包含 input.txt 内容(主任务或子任务)', artifactTexts.includes(payload) || childTexts.includes(payload), `parent=${artifactTexts.slice(0, 50)}… | child=${childTexts.slice(0, 50)}…`)

    // ---- 7. 监控时间线 ----
    console.log('\n--- 监控时间线 ---')
    console.log(mon.summary())
    mon.stop()

    // ---- 8. 释放 omp 子进程 ----
    console.log('\n--- 收尾:卸载 omp 子进程 ---')
    for (let i = 0; i < 20; i++) {
      await manager.unloadIdleAgents()
      if (manager.runtimeStatus().wiredAgents.length === 0) break
      await sleep(500)
    }
    check('完成后卸载(释放 omp 子进程)', manager.runtimeStatus().wiredAgents.length === 0)
  }
  finally {
    await manager.shutdown()
    db.close()
    // Windows 收尾竞态:omp 子进程(含终端镜像)可能仍持有 cwd 目录句柄,
    // 立即 rmSync 会 EPERM —— 带宽限重试,仍失败则告警保留(不掩盖功能断言结果)。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(ws, { recursive: true, force: true })
        break
      }
      catch {
        if (attempt === 4) {
          console.warn(`[e2e-omp-workspace] 临时工作区清理失败(Windows 句柄占用),已保留: ${ws}`)
          break
        }
        await sleep(500)
      }
    }
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('e2e 异常:', e)
  process.exit(1)
})
