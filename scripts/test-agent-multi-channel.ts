/**
 * Agent 多 Channel 复用测试 —— 验证「Agent 模板可复用,放入每个 Channel 克隆出独立身份 id 的实例」。
 *
 * 覆盖:
 *  1. 同一模板放入两个 channel → 克隆出两个独立身份 id 的实例(id 互不相同且不同于模板)
 *  2. role/token 按实例独立
 *  3. 元数据复制:实例复制模板 name/harness/config
 *  4. 独立 AgentRuntime:同一模板的两实例各装配独立运行时
 *  5. mailbox 按 channel 隔离
 *  6. 移除实例 ≠ 删除模板
 *  7. 模板更新不传播到已克隆实例(复制语义),新克隆取新值
 *  8. 删除模板后实例保留
 *
 * 运行: npx tsx scripts/test-agent-multi-channel.ts
 */
import type { DatabaseSync } from 'node:sqlite'
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

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS ${name}`)
  }
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
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
    },
    implFactory: createAgentImpl,
    db,
  })
}

async function main(): Promise<void> {
  console.log('━━━ Agent 模板多 Channel 复用(克隆独立身份)━━━')
  const db = openWorkshopDb(':memory:')
  const messagesRepo = createMessageRepo(db)
  const manager = makeManager(db)
  try {
    // ---- 1. 同一模板克隆出独立身份 id ----
    console.log('\n--- 1. 克隆独立身份 id ---')
    const chA = await manager.createChannel({ name: 'A' })
    const chB = await manager.createChannel({ name: 'B' })
    const tpl = await manager.createAgent({ name: 'shared', harness: 'mock', config: { delayMs: 10 } })

    const a1 = await manager.addAgentToChannel({ channelId: chA.channelId, agentId: tpl.id, role: 'lead' })
    const b1 = await manager.addAgentToChannel({ channelId: chB.channelId, agentId: tpl.id, role: 'worker' })

    check('两实例 id 互不相同', a1.id !== b1.id, `a1=${a1.id.slice(0, 8)} b1=${b1.id.slice(0, 8)}`)
    check('实例 id 不同于模板 id', a1.id !== tpl.id && b1.id !== tpl.id)
    check('实例复制模板 name', a1.name === 'shared' && b1.name === 'shared')
    check('实例复制模板 harness', a1.harness === 'mock' && b1.harness === 'mock')

    // ---- 2. role/token 按实例独立 ----
    console.log('\n--- 2. role/token 按实例独立 ---')
    check('role 按 channel 独立(A=lead)', (await manager.listChannelAgents(chA.channelId))[0]!.role === 'lead')
    check('role 按 channel 独立(B=worker)', (await manager.listChannelAgents(chB.channelId))[0]!.role === 'worker')
    check('实例 token 各不相同', a1.token !== b1.token)
    check('findByToken(A) 解析到 channel A', manager.findByToken(a1.token!)?.channelId === chA.channelId)
    check('findByToken(B) 解析到 channel B', manager.findByToken(b1.token!)?.channelId === chB.channelId)

    // ---- 3. 模板详情含实例 ----
    console.log('\n--- 3. 模板详情 ---')
    const tplDetail = manager.getAgent(tpl.id)!
    check('模板 instances=2', tplDetail.instances.length === 2, `n=${tplDetail.instances.length}`)
    check('模板 instances 含两实例 id', tplDetail.instances.some(i => i.id === a1.id) && tplDetail.instances.some(i => i.id === b1.id))

    // ---- 4. 独立 AgentRuntime(同一模板两实例各装配)----
    console.log('\n--- 4. 独立 AgentRuntime ---')
    const chC = await manager.createChannel({ name: 'C' })
    const chD = await manager.createChannel({ name: 'D' })
    const dup = await manager.createAgent({ name: 'dup', harness: 'mock', config: { delayMs: 10 } })
    const c1 = await manager.addAgentToChannel({ channelId: chC.channelId, agentId: dup.id, role: 'lead' })
    const d1 = await manager.addAgentToChannel({ channelId: chD.channelId, agentId: dup.id, role: 'lead' })

    manager.ensureChannelActive(chC.channelId, { tickMs: 60_000 })
    manager.ensureChannelActive(chD.channelId, { tickMs: 60_000 })
    const wired = manager.runtimeStatus().wiredAgents
    check('两 channel 各装配一个 runtime(共 2)', wired.length === 2, `n=${wired.length}`)
    check('两个 runtime 属于不同实例 id', wired.length === 2 && wired.includes(c1.id) && wired.includes(d1.id))

    await manager.unloadAgent(chC.channelId, c1.id)
    check('卸载 C 实例不影响 D 实例', manager.runtimeStatus().wiredAgents.length === 1)

    // ---- 5. mailbox channel 隔离 ----
    console.log('\n--- 5. mailbox channel 隔离 ---')
    await manager.sendImmediateMessage({ channelId: chA.channelId, toAgentId: a1.id, parts: [{ text: 'hi-A' }] })
    const recentA = messagesRepo.listRecentByChannel(chA.channelId, 10)
    const recentB = messagesRepo.listRecentByChannel(chB.channelId, 10)
    check('消息只落在 channel A', recentA.length === 1 && recentA[0]!.toAgentId === a1.id, `n=${recentA.length}`)
    check('channel B 无该消息', recentB.length === 0, `n=${recentB.length}`)

    // ---- 6. 移除实例 ≠ 删除模板 ----
    console.log('\n--- 6. 移除实例 vs 删除模板 ---')
    await manager.removeAgentFromChannel(chB.channelId, b1.id)
    check('移除 B 实例后模板仍存在', manager.getAgent(tpl.id) !== undefined)
    check('A 实例保留', (await manager.listChannelAgents(chA.channelId)).some(a => a.id === a1.id))
    check('B 实例已移除', (await manager.listChannelAgents(chB.channelId)).length === 0)
    check('移除后模板 instances=1', manager.getAgent(tpl.id)?.instances.length === 1)

    // ---- 7. 模板更新不传播(复制语义)----
    console.log('\n--- 7. 模板更新不传播 ---')
    await manager.updateAgent(tpl.id, { name: 'renamed' })
    check('更新后已克隆实例名不变', manager.getChannelAgent(a1.id)?.name === 'shared')
    const chE = await manager.createChannel({ name: 'E' })
    const e1 = await manager.addAgentToChannel({ channelId: chE.channelId, agentId: tpl.id, role: 'worker' })
    check('新克隆取新模板名', e1.name === 'renamed')

    // ---- 8. 删除模板后实例保留 ----
    console.log('\n--- 8. 删除模板后实例保留 ---')
    await manager.removeAgent(tpl.id)
    check('删除模板后 getAgent 为 undefined', manager.getAgent(tpl.id) === undefined)
    check('A 实例仍存在', manager.getChannelAgent(a1.id) !== undefined)
  }
  finally {
    await manager.shutdown()
    db.close()
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
