/**
 * 记忆衰减清理测试:episodic 过期删除 / semantic+team 豁免 / 容量淘汰(高分保留)/
 * FTS 联动清理 / 幂等 + Task 9 review 必修回归(UNIQUE 含 channel_id 的跨通道团队去重)。
 * 运行: npx tsx scripts/test-memory-maintenance.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { runMemoryMaintenance, segmentCJK } from '../server/services/workshop/runtime/memory'
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => segmentCJK(s)

/** 伪造行龄:created_at/last_accessed_at 一并回拨 days 天 */
const age = (days: number, id: string): void => {
  const iso = new Date(Date.now() - days * 86_400_000).toISOString()
  db.prepare('UPDATE agent_memories SET created_at = ?, last_accessed_at = ? WHERE id = ?').run(iso, iso, id)
}
const rowId = (title: string): string => repo.listByAgent('aged', 100).find(r => r.title === title)!.id

// ═══════════ 过期删除(仅 episodic;semantic / team 豁免)═══════════
console.log('\n--- 过期删除(episodic-only)---')
repo.upsert({ channelId: 'ch1', agentId: 'aged', kind: 'episodic-task', title: '古老任务', titleFts: seg('古老任务'), content: seg('ghosttoken 古老的登录实现'), importance: 0.8, taskId: 'old-1', dedupKey: 'task:old-1' })
repo.upsert({ channelId: 'ch1', agentId: 'aged', kind: 'semantic', title: '古老规范', titleFts: seg('古老规范'), content: seg('人工策展永不衰减'), importance: 0.9, taskId: null, dedupKey: 'manual:old-sem' })
repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'semantic', title: '古老团队守则', titleFts: seg('古老团队守则'), content: seg('团队行永不衰减'), importance: 0.9, taskId: null, dedupKey: 'team:old' })
age(200, rowId('古老任务'))
age(200, rowId('古老规范'))
age(200, repo.listByAgent(TEAM_AGENT_ID, 100).find(r => r.title === '古老团队守则')!.id)

// ═══════════ 容量淘汰(600 → 500,保留 effectiveScore 高者)═══════════
console.log('\n--- 容量淘汰(仅 episodic)---')
for (let i = 0; i < 600; i++) {
  repo.upsert({
    channelId: 'ch1', agentId: 'bulk', kind: i % 2 ? 'episodic-task' : 'episodic-peer',
    title: `批量${i}`, titleFts: seg(`批量${i}`), content: seg(`批量记忆${i}`),
    importance: i < 50 ? 0.9 : 0.3, taskId: `bulk-${i}`, dedupKey: `task:bulk-${i}`,
  })
}
repo.upsert({ channelId: 'ch1', agentId: 'bulk', kind: 'semantic', title: 'bulk 策展行', titleFts: seg('bulk 策展行'), content: seg('策展行不参与淘汰'), importance: 0.5, taskId: null, dedupKey: 'manual:bulk-sem' })

const res1 = runMemoryMaintenance(repo, { expireDays: 180, cap: 500 })
check('过期 episodic 被删除(deletedExpired=1)', res1.deletedExpired === 1, JSON.stringify(res1))
check('semantic 200 天豁免保留', repo.listByAgent('aged', 100).some(r => r.title === '古老规范'))
check('team 200 天豁免保留', repo.listByAgent(TEAM_AGENT_ID, 100).some(r => r.title === '古老团队守则'))
check('删除后 FTS 不再命中', repo.search('aged', 'ghosttoken', 5).length === 0)
check('容量淘汰至 cap(evicted=100)', res1.evicted === 100, JSON.stringify(res1))
const bulkRows = repo.listByAgent('bulk', 1000)
check('bulk 恰好剩 500 episodic + 1 semantic', bulkRows.length === 501 && bulkRows.filter(r => r.kind.startsWith('episodic')).length === 500, `len=${bulkRows.length}`)
check('高分(importance=0.9)全部保留', bulkRows.filter(r => r.importance === 0.9).length === 50)
check('孤儿 vec 清理未启用 vec 时为 0', res1.cleanedVec === 0)

const res2 = runMemoryMaintenance(repo, { expireDays: 180, cap: 500 })
check('维护幂等(第二遍 deletedExpired=0 / evicted=0)', res2.deletedExpired === 0 && res2.evicted === 0, JSON.stringify(res2))

// ═══════════ Task 9 必修回归:UNIQUE(agent_id, dedup_key, channel_id)═══════════
console.log('\n--- 跨通道团队去重(Part A)---')
const stubImpl = (): never => {
  throw new Error('impl unused')
}
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
const teamManager = createAgentChannelManager({ repos: tmRepos, implFactory: stubImpl, db })
const chA = tmRepos.channels.create({ name: 'ch-a' })
const chB = tmRepos.channels.create({ name: 'ch-b' })
const leadA = tmRepos.channelAgents.create({ channelId: chA.id, templateId: null, name: 'lead-a', harness: 'mock', role: 'lead' })
const leadB = tmRepos.channelAgents.create({ channelId: chB.id, templateId: null, name: 'lead-b', harness: 'mock', role: 'lead' })

teamManager.addTeamMemory(chA.id, leadA.id, { title: '规范甲', content: '通道甲的部署约定', dedupKey: 'shared:policy' })
teamManager.addTeamMemory(chB.id, leadB.id, { title: '规范乙', content: '通道乙的部署约定', dedupKey: 'shared:policy' })
const teamShared = repo.listByAgentChannel(chA.id, TEAM_AGENT_ID, 10)
const teamAll = repo.listByAgent(TEAM_AGENT_ID, 100)
check('跨通道同 dedupKey 团队写各留一行(不互相覆盖)', teamAll.filter(r => r.title === '规范甲' || r.title === '规范乙').length === 2)
check('listByAgentChannel 只含本通道行', teamShared.length === 1 && teamShared[0].title === '规范甲')
check('listTeamMemories 只返回本通道行', teamManager.listTeamMemories(chA.id).every(r => r.channelId === chA.id && r.title === '规范甲'))
const dedupA = repo.findByAgentDedup(chA.id, TEAM_AGENT_ID, 'shared:policy')
const dedupB = repo.findByAgentDedup(chB.id, TEAM_AGENT_ID, 'shared:policy')
check('findByAgentDedup 按通道作用域(两行不同)', dedupA !== null && dedupB !== null && dedupA.rowid !== dedupB.rowid)
check('findByAgentDedup 无匹配通道返回 null', repo.findByAgentDedup('ch-none', TEAM_AGENT_ID, 'shared:policy') === null)

// 同通道同 dedupKey 仍幂等刷新(不新增行)
teamManager.addTeamMemory(chA.id, leadA.id, { title: '规范甲', content: '通道甲的部署约定v2', dedupKey: 'shared:policy' })
check('同通道同 dedupKey 仍幂等刷新', repo.listByAgentChannel(chA.id, TEAM_AGENT_ID, 10).length === 1)

// limit 在本通道内生效(chA 3 行 / chB 2 行,dedupKey 部分重叠)
teamManager.addTeamMemory(chA.id, leadA.id, { title: '守则1', content: 'x1', dedupKey: 'r:1' })
teamManager.addTeamMemory(chA.id, leadA.id, { title: '守则2', content: 'x2', dedupKey: 'r:2' })
teamManager.addTeamMemory(chB.id, leadB.id, { title: '守则1', content: 'y1', dedupKey: 'r:1' })
check('listTeamMemories limit 作用域为本通道行', teamManager.listTeamMemories(chA.id, 2).length === 2
&& teamManager.listTeamMemories(chA.id, 2).every(r => r.channelId === chA.id))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
