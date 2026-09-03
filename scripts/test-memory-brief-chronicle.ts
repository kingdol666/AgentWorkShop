/**
 * 记忆持久化面测试:L0 会话简报 / 压缩摘要入库 / 团队编年史 / 维护豁免与淘汰 /
 * manager 任务终态事件 → 团队域沉淀总线接线。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-memory-brief-chronicle.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { AgentMemory, runMemoryMaintenance, unsegmentCJK } from '../server/services/workshop/runtime/memory'
import type { AgentInterface } from '../server/services/workshop/agents/agent-interface'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => s.replace(/([\u4e00-\u9fff])/g, ' $1 ')

// ===== L0 会话简报:recordTaskOutcome / save(shared) 自动刷新,幂等单行 =====
console.log('\n--- L0 会话简报(brief)---')
{
  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'w1' })
  check('无完成记录时不产简报', repo.findByAgentDedup('ch1', 'w1', 'brief:w1') === null)
  await mem.recordTaskOutcome({
    id: 'tk1', channelId: 'ch1', assigneeId: 'w1', creatorId: 'lead', title: '网关配置任务',
    state: 'COMPLETED', progress: 100, retryCount: 0,
    artifacts: [{ artifactId: 'a1', name: 'deliverable', parts: [{ text: '网关路由表已生效' }] }],
    history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as Parameters<AgentMemory['recordTaskOutcome']>[0])
  let brief = repo.findByAgentDedup('ch1', 'w1', 'brief:w1')
  check('任务终态后简报生成', brief !== null)
  check('简报含最近完成条目', brief !== null && unsegmentCJK(repo.getById(brief.id)!.content).includes('网关配置任务'))
  check('简报为单行幂等(brief kind)', repo.listByAgentChannel('ch1', 'w1', 100).filter(r => r.kind === 'brief').length === 1)

  await mem.save({ title: '限流约定', content: '全队统一令牌桶', scope: 'shared', dedupKey: 'conv:rl' })
  brief = repo.findByAgentDedup('ch1', 'w1', 'brief:w1')
  check('共享沉淀后简报含团队约定', brief !== null && unsegmentCJK(repo.getById(brief.id)!.content).includes('限流约定'))

  // recall L0 置顶
  const block = await mem.recall('任意查询')
  check('recall 注入块含会话简报', block !== null && block.includes('会话简报'))
}

// ===== 压缩摘要入库:episodic-session,序号 dedupKey,可检索 =====
console.log('\n--- 压缩摘要(episodic-session)---')
{
  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: 'w1' })
  const s1 = await mem.recordSessionCompaction({ summary: '完成网关配置;待办:验证路由', tokensBefore: 90000, tokensAfter: 30000, reason: 'threshold' })
  const s2 = await mem.recordSessionCompaction({ summary: '第二次压缩摘要', tokensBefore: 88000 })
  check('dedupKey 序号递增不互踩', s1.dedupKey !== s2.dedupKey && repo.findByAgentDedup('ch1', 'w1', s1.dedupKey) !== null && repo.findByAgentDedup('ch1', 'w1', s2.dedupKey) !== null)
  const found = await mem.recallRows('网关配置 验证路由')
  check('压缩摘要可被 search_memory 检索', found.some(s => s.kind === 'episodic-session'), JSON.stringify(found.map(s => s.kind)))
  const row = repo.listByAgentChannel('ch1', 'w1', 100).find(r => r.kind === 'episodic-session')
  check('importance=0.75 元信息入库', row !== null && row.importance === 0.75)
}

// ===== 团队编年史:滚动重写幂等单行 =====
console.log('\n--- 团队编年史(chronicle)---')
{
  const mem = new AgentMemory(repo, { channelId: 'ch1', agentId: TEAM_AGENT_ID })
  mem.upsertChronicle(['09-02 10:00 [完成] 任务A — w1(交付 x)', '09-02 11:00 [失败] 任务B — w2'].join('\n'))
  mem.upsertChronicle(['09-02 12:00 [完成] 任务C — w3'].join('\n'))
  const rows = repo.listByAgentChannel('ch1', TEAM_AGENT_ID, 100).filter(r => r.kind === 'chronicle')
  check('编年史幂等单行(重写不新增)', rows.length === 1)
  const chron = rows[0] !== undefined ? unsegmentCJK(rows[0]!.content) : ''
  check('编年史内容为最新滚动', chron.includes('w3') && !chron.includes('任务 A'), chron)
}

// ===== 维护:session 14d 过期 / 策展层豁免 / team-task 淘汰 =====
console.log('\n--- 维护规则 v2 ---')
{
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
  repo.upsert({ channelId: 'ch1', agentId: 'w1', kind: 'episodic-session', title: '旧压缩摘要', titleFts: seg('旧压缩摘要'), content: seg('过期内容'), importance: 0.75, taskId: null, dedupKey: 'session:w1:c99' })
  db.prepare('UPDATE agent_memories SET created_at = ? WHERE dedup_key = ?').run(old, 'session:w1:c99')

  const res = runMemoryMaintenance(repo, { expireDays: 180, cap: 500 })
  check('episodic-session 14d 过期删除', res.deletedExpired >= 1 && repo.findByAgentDedup('ch1', 'w1', 'session:w1:c99') === null, JSON.stringify(res))
  check('brief 豁免保留', repo.findByAgentDedup('ch1', 'w1', 'brief:w1') !== null)
  check('chronicle 豁免保留', repo.listByAgentChannel('ch1', TEAM_AGENT_ID, 100).some(r => r.kind === 'chronicle'))

  // team-task 容量淘汰(cap=2 时仅保留 2 行)
  for (let i = 0; i < 4; i++) {
    repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'episodic-team-task', title: `团队任务${i}`, titleFts: seg(`团队任务${i}`), content: seg('成果'), importance: i < 2 ? 0.9 : 0.5, taskId: `tt-${i}`, dedupKey: `team-task:tt-${i}` })
  }
  runMemoryMaintenance(repo, { expireDays: 180, cap: 2 })
  const remaining = repo.listByAgentChannel('ch1', TEAM_AGENT_ID, 100).filter(r => r.kind === 'episodic-team-task')
  check('team episodic 纳入容量淘汰(高分保留)', remaining.length === 2 && remaining.every(r => r.importance === 0.9), `left=${remaining.length}`)
}

// ===== manager 总线接线:任务终态 → team-task 行 + 编年史(单点不双写)=====
console.log('\n--- manager 任务终态团队沉淀 ---')
{
  const tmRepos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: repo,
  }
  // 空转 impl:run 即返回(lead 自派任务的回合立即落定,不产错误)
  const stubImpl = (): AgentInterface => ({ async* run() {} })
  const manager = createAgentChannelManager({ repos: tmRepos, implFactory: stubImpl, db })
  const ch = tmRepos.channels.create({ name: 'ch-harvest' })
  const lead = tmRepos.channelAgents.create({ channelId: ch.id, templateId: null, name: 'lead-h', harness: 'mock', role: 'lead' })
  // 激活 channel runtime(创建 bus + 注册团队沉淀监听)
  manager.subscribeTaskEvents(ch.id, () => {})

  const task = await manager.dispatchTask(ch.id, lead.id, { assigneeId: lead.id, title: '数据迁移执行', description: '迁移并验证' })
  await sleep(30)
  await manager.completeTask(ch.id, lead.id, {
    taskId: task.id,
    artifacts: [{ artifactId: 'd1', name: 'deliverable', parts: [{ text: '迁移完成,校验和一致' }] }],
  })
  await sleep(30)

  const teamRow = repo.findByAgentDedup(ch.id, TEAM_AGENT_ID, `team-task:${task.id}`)
  check('任务完成 → team-task 共享行入库', teamRow !== null)
  const teamRows = repo.listByAgentChannel(ch.id, TEAM_AGENT_ID, 100).filter(r => r.kind === 'episodic-team-task')
  check('团队域单点写入(无双写)', teamRows.length === 1, `rows=${teamRows.length}`)
  check('交付物进入共享行内容', teamRow !== null && unsegmentCJK(repo.getById(teamRow.id)!.content).includes('校验和一致'))
  const chronicle = repo.listByAgentChannel(ch.id, TEAM_AGENT_ID, 100).find(r => r.kind === 'chronicle')
  check('编年史随任务终态滚动更新', chronicle !== undefined && unsegmentCJK(repo.getById(chronicle.id)!.content).includes('数据迁移执行'))
  await manager.shutdown()
}

// ===== 空闲反思:当月 episodic-task ≥ 阈值 → reflection 行聚合(月度幂等)=====
console.log('\n--- 空闲反思(reflection)---')
{
  const month = new Date().toISOString().slice(0, 7)
  for (let i = 0; i < 8; i++) {
    repo.upsert({ channelId: 'ch1', agentId: 'rx', kind: 'episodic-task', title: `反思任务${i}`, titleFts: seg(`反思任务${i}`), content: seg('结论性内容'), importance: 0.8, taskId: `rx-${i}`, dedupKey: `task:rx-${i}` })
  }
  const stubImpl = (): AgentInterface => ({ async* run() {} })
  const m2 = createAgentChannelManager({
    repos: {
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: repo,
    },
    implFactory: stubImpl,
    db,
  })
  ;(m2 as unknown as Record<string, () => void>).reflectIdleMemories()
  const reflRef = repo.findByAgentDedup('ch1', 'rx', `reflection:rx:${month}`)
  const refl = reflRef ? repo.getById(reflRef.id) : null
  check('反思行入库(月度 dedupKey)', refl !== null)
  check('反思行聚合任务结论', refl !== null && unsegmentCJK(refl.content).includes('反思任务'))

  // 再跑一轮:无新增任务 → 不重复聚合(内容不变,幂等)
  ;(m2 as unknown as Record<string, () => void>).reflectIdleMemories()
  const reflCount = repo.listByAgentChannel('ch1', 'rx', 100).filter(r => r.kind === 'reflection').length
  check('反思月度幂等(无增量不再重写)', reflCount === 1)
  await m2.shutdown()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
