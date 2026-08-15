/**
 * OMP Harness 实战演示 — 真实 omp 子进程驱动 lead-worker 全流程(懒加载版)
 *
 * 场景: lead 统筹「项目分析」,分解给 2 个 worker(懒加载装配),
 *       worker 用 omp 原生 read 工具作业,lead 汇总完成。
 *
 * 懒加载:创建后不装配;任务提交才装配 lead + 调度循环;dispatch 才装配 worker;
 *         完成后 unloadIdleAgents 释放 omp 子进程与内存。
 *
 * 运行: npx tsx scripts/demo-omp-channel.ts
 */
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
import type { WorkspaceTask } from '../server/services/workshop/types/task'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(300)
  }
  return false
}

function getEngine(manager: AgentChannelManager) {
  return (manager as unknown as {
    getTaskEngine(): {
      get(id: string): WorkspaceTask | undefined
      list(channelId: string): WorkspaceTask[]
    }
  }).getTaskEngine()
}

async function main(): Promise<void> {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════════╗')
  console.log('║  OMP Harness 实战演示 — 真实 omp 子进程(懒加载)                 ║')
  console.log('╚══════════════════════════════════════════════════════════════════╝')

  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),

    teams: createTeamRepo(db),

    teamMembers: createTeamMemberRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
  const startTime = Date.now()

  try {
    // Step 1: 创建团队(仅持久化,不装配)
    const ch = await manager.createChannel({
      name: 'OMP 分析组',
      leadAgent: { name: 'lead-统筹者', harness: 'omp', config: {} },
    })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-包分析', harness: 'omp', config: {} })).id, role: 'worker' })
    await manager.addAgentToChannel({ channelId: ch.channelId, agentId: (await manager.createAgent({ name: 'worker-配置分析', harness: 'omp', config: {} })).id, role: 'worker' })

    check('创建后不装配(懒加载)', manager.runtimeStatus().wiredAgents.length === 0)

    // Step 2: 提交任务(触发 lead + 调度循环装配)
    const task = await manager.submitChannelTask({
      channelId: ch.channelId,
      title: '读取 package.json 报告项目名',
      description: '使用 read 工具读取 package.json,报告 name 字段。简短回答。',
    })
    console.log(`  任务已提交: ${task.id.slice(0, 8)}…`)
    check('任务提交后装配 lead', manager.runtimeStatus().wiredAgents.length >= 1)

    // Step 3: 等待闭环
    const engine = getEngine(manager)
    const done = await waitUntil(() => {
      const t = engine.get(task.id)
      return t?.state === 'COMPLETED' || t?.state === 'FAILED' || t?.state === 'CANCELED'
    }, 300_000)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  ⏱  耗时: ${elapsed}s`)
    check('主任务完成', done, `state=${engine.get(task.id)?.state}`)

    const children = engine.list(ch.channelId).filter(t => t.parentId === task.id)
    const completed = children.filter(c => c.state === 'COMPLETED')
    check('lead dispatch 子任务', children.length >= 1, `子任务=${children.length}`)
    check('worker 完成子任务', completed.length >= 1, `${completed.length}/${children.length}`)

    // Step 4: 卸载(释放 omp 子进程;omp 收尾较慢,轮询重试)
    await waitUntil(async () => {
      await manager.unloadIdleAgents()
      return manager.runtimeStatus().wiredAgents.length === 0
    }, 20_000)
    check('完成后卸载(内存回收)', manager.runtimeStatus().wiredAgents.length === 0)
  }
  finally {
    await manager.shutdown()
    db.close()
  }

  console.log('')
  console.log(`  ${failures === 0 ? '🎉 全部通过' : `❌ ${failures} 项失败`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('演示异常:', e)
  process.exit(1)
})
