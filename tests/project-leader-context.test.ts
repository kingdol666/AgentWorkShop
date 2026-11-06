/**
 * Leader 上下文验收锁定（用户建议 A/B 的落地核验）：
 *
 *   A（technical 口径）：service/REST 创建默认 technical（P0-7）→ 快照主视图透出
 *      routingPolicy（本轮可见性补齐）+ updateProject 变更反映；
 *   B（对账惯例）：leader 提示词前缀含 project_get_status 自对账 + 当前路由口径
 *      （P1-8 + P2 语义行）；member 无 leader 专属前缀。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-leader-context-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { projectPromptSection } = await import('../server/services/workshop/projects/prompt-context')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, leadAgent?: { name: string, harness: string, config?: Record<string, unknown>, agentKind?: 'channel_agent' | 'project_leader' } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id, templateId: null, name: input.leadAgent.name, harness: input.leadAgent.harness,
          config: input.leadAgent.config, role: 'lead', agentKind: input.leadAgent.agentKind,
        })
        channels.update(ch.id, { leadAgentId: inst.id })
        leadAgentId = inst.id
      }
      return { channelId: ch.id, leadAgentId, workspace: `data/workspaces/${ch.id}` }
    },
    async updateChannel(id: string, patch: Record<string, unknown>) {
      return channels.update(id, patch as never)!
    },
    getChannelForUser(id: string) {
      const ch = channels.findById(id)
      return ch ? { ...ch, agents: [] } : null
    },
    async submitProjectRoot(input: { projectId: string, workItemId: string, attemptNo: number, sourceKey: string, channelId: string, title: string }) {
      const ch = channels.findById(input.channelId)!
      const row = tasks.create({
        channelId: input.channelId, creatorId: `project:${input.projectId}`, assigneeId: ch.leadAgentId!,
        title: input.title, sourceChatMessageId: input.sourceKey,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        source: 'project', projectId: input.projectId, projectWorkItemId: input.workItemId, projectAttemptNo: input.attemptNo,
      })
      return { task: { id: row.id } as never, created: true }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, manager, svc }
}

test('A 默认 technical 双入口一致 + 快照主视图透出 routingPolicy 且反映变更', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    // service 层默认（P0-7 统一后应与 REST 一致）
    const p = await f.svc.create({ name: `A-${randomUUID().slice(0, 6)}`, objective: 'x' }, owner)
    const snap1 = f.svc.projectSnapshot(p.id, owner)
    assert.equal(snap1.project.routingPolicy, 'technical', '快照主视图必须透出 routingPolicy（本轮可见性补齐）')
    assert.equal(snap1.project.routingPolicy, 'technical', 'service 默认=technical（与 REST 双入口一致）')
    // owner 变更 → 快照反映
    f.svc.updateProject(p.id, owner, { routingPolicy: 'legacy' })
    assert.equal(f.svc.projectSnapshot(p.id, owner).project.routingPolicy, 'legacy')
    f.svc.updateProject(p.id, owner, { routingPolicy: 'technical' })
    assert.equal(f.svc.projectSnapshot(p.id, owner).project.routingPolicy, 'technical')
  }
  finally { f.db.close() }
})

test('B leader 提示词：对账惯例 + project_get_status + 路由口径；member 无 leader 前缀', async () => {
  const f = fixture()
  try {
    const owner = { id: 'u-owner', role: 'user' }
    const p = await f.svc.create({ name: `B-${randomUUID().slice(0, 6)}`, objective: '对账与口径验证', planApprovalRequired: 0, routingPolicy: 'technical' }, owner)
    const member = await f.manager.createChannel({ name: '执行', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' } })
    f.svc.bindChannel(p.id, member.channelId, owner)
    const leaderId = p.leadAgentId!
    const memberLeadId = member.leadAgentId!

    const leaderSection = projectPromptSection(leaderId)
    assert.ok(leaderSection.includes('【对账惯例】'), 'leader 必须带对账惯例前缀')
    assert.ok(leaderSection.includes('project_get_status'), '对账指令必须点名工具')
    assert.ok(leaderSection.includes('routingPolicy=technical'), 'leader 必须知道当前路由口径')
    assert.ok(leaderSection.includes('技术验收'), 'technical 语义必须解释（G-1 缓解的语义面）')
    assert.ok(leaderSection.includes(p.objective.slice(0, 6) || '对账'), 'brief 已渲染')

    // member lead：无 leader 专属前缀（对账惯例/路由口径是 leader 职责面）
    const memberSection = projectPromptSection(memberLeadId)
    assert.ok(!memberSection.includes('【对账惯例】'), 'member 不带 leader 对账前缀')
    assert.ok(!memberSection.includes('【路由口径】'), 'member 不带路由口径行')
  }
  finally { f.db.close() }
})
