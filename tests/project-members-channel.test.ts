/**
 * PR10：项目成员（viewer/approver）+ M5 leader 建频道提案。
 *
 * 覆盖：成员 CRUD 权限（owner 写/成员读）、viewer 只读不可写、approver 可决策审批、
 * viewer+grant 过滤叠加、leader 建频道提案→owner 应用→频道绑定、重名拒绝、leader 不能直建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-members-channel-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
const { dispatchProjectTool } = await import('../server/services/workshop/projects/tools')
const { projectExecutionGate } = await import('../server/services/workshop/projects/execution-gate')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const tasks = createTaskRepo(db)
  const manager = {
    async createChannel(input: {
      name: string
      leadAgent?: { name: string, harness: string, config?: Record<string, unknown>, agentKind?: 'channel_agent' | 'project_leader' }
      ownerUserId?: string | null
      description?: string
      scenarioPrompt?: string
    }) {
      const ch = channels.create({ name: input.name, description: input.description, scenarioPrompt: input.scenarioPrompt, ownerUserId: input.ownerUserId ?? null })
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
    async submitProjectRoot() {
      throw new Error('not used in this fixture')
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return { db, channels, agents, tasks, manager, svc }
}

async function setup() {
  const f = fixture()
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({ name: '成员项目', objective: '团队协作验证', planApprovalRequired: 0 }, owner)
  const member = await f.manager.createChannel({
    name: '成员频道', ownerUserId: owner.id, leadAgent: { name: 'Lead', harness: 'mock' },
  })
  f.svc.bindChannel(p.id, member.channelId, owner)
  const d = f.svc.createDeliverable(p.id, owner, { name: '交付物', ownerChannelId: member.channelId })
  f.svc.activate(p.id, owner)
  return { ...f, owner, p, member, d, leaderId: p.leadAgentId!, viewer: { id: 'u-viewer', role: 'user' } }
}

test('成员 CRUD：owner 可加/改/删/列；非 owner 不可写；成员可读项目', async () => {
  const s = await setup()
  try {
    const m = s.svc.addMember(s.p.id, s.owner, { userId: s.viewer.id, role: 'viewer' })
    assert.equal(m.role, 'viewer')
    // 重复添加 → 幂等返回；role 变更走 setRole
    const again = s.svc.addMember(s.p.id, s.owner, { userId: s.viewer.id, role: 'approver' })
    assert.equal(again.role, 'approver')
    // 未带 role 的重复添加不得把 approver 静默降级
    assert.equal(s.svc.addMember(s.p.id, s.owner, { userId: s.viewer.id }).role, 'approver')
    assert.equal(s.svc.listMembers(s.p.id, s.owner).length, 1)
    // owner 不能把自己加为成员
    assert.throws(
      () => s.svc.addMember(s.p.id, s.owner, { userId: 'u-owner' }),
      (e: unknown) => (e as { code?: string }).code === 'MEMBER_CONFLICT',
    )
    // 角色白名单：任意字符串不得落库
    assert.throws(
      () => s.svc.addMember(s.p.id, s.owner, { userId: 'u-bad-role', role: 'owner' }),
      (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
    )
    // viewer 可读项目（此前会 403）
    assert.equal(s.svc.get(s.p.id, s.viewer).id, s.p.id)
    assert.equal(s.svc.listMembers(s.p.id, s.viewer).length, 1)
    // viewer 写操作 → FORBIDDEN（requireOwner）
    assert.throws(
      () => s.svc.pause(s.p.id, s.viewer),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
    assert.throws(
      () => s.svc.createDeliverable(s.p.id, s.viewer, { name: 'x' }),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
    // 移除后回到 403
    s.svc.removeMember(s.p.id, s.viewer.id, s.owner)
    assert.throws(
      () => s.svc.get(s.p.id, s.viewer),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
  }
  finally {
    s.db.close()
  }
})

test('approver 可决策审批（viewer 不可）', async () => {
  const s = await setup()
  try {
    s.svc.addMember(s.p.id, s.owner, { userId: 'u-approver', role: 'approver' })
    s.svc.addMember(s.p.id, s.owner, { userId: 'u-viewer2', role: 'viewer' })
    const ap = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 1, plan: { facts: ['x'] } })
    // approver 决策成功 → planVersion=1
    const decided = s.svc.decideApproval(s.p.id, ap.id, { id: 'u-approver', role: 'user' }, true, 'ok')
    assert.equal(decided.status, 'approved')
    assert.equal(s.svc.get(s.p.id, s.owner).planVersion, 1)
    // viewer 决策 → FORBIDDEN
    const ap2 = s.svc.requestPlanApproval(s.p.id, s.owner, { version: 2, plan: { facts: ['y'] } })
    assert.throws(
      () => s.svc.decideApproval(s.p.id, ap2.id, { id: 'u-viewer2', role: 'user' }, true),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
    // 移除 approver 后决策权失效
    s.svc.removeMember(s.p.id, 'u-approver', s.owner)
    assert.throws(
      () => s.svc.decideApproval(s.p.id, ap2.id, { id: 'u-approver', role: 'user' }, true),
      (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN',
    )
  }
  finally {
    s.db.close()
  }
})

test('viewer + line grant 叠加：viewer 只读项目，成果按授权产线过滤', async () => {
  const s = await setup()
  try {
    s.svc.addMember(s.p.id, s.owner, { userId: 'u-grantless', role: 'viewer' })
    const filtered = initProjectService(s.manager, s.db, { lineAccessOf: () => new Set<string>() })
    // viewer 可读项目本身
    assert.equal(filtered.get(s.p.id, { id: 'u-grantless', role: 'user' }).id, s.p.id)
    // 但成果列表被 grant 过滤为空（owner 同样被过滤——证明 grant 独立于成员身份生效）
    assert.equal(filtered.listResults(s.p.id, s.owner).length, 0)
    // 授权后可见（此处成果无 line 绑定 → 对非 admin 仍隐藏；注入 L1 后可见）
    const rows = s.db.prepare('SELECT id FROM project_results').all() as Array<{ id: string }>
    if (rows[0]) s.db.prepare('UPDATE project_results SET line_id = \'L9\' WHERE id = ?').run(rows[0].id)
    const granted = initProjectService(s.manager, s.db, { lineAccessOf: id => (id === 'u-owner' ? new Set(['L9']) : new Set<string>()) })
    assert.equal(granted.listResults(s.p.id, s.owner).length, rows.length)
  }
  finally {
    s.db.close()
  }
})

test('M5：leader 建频道提案 → owner 应用 → 频道创建并绑定；重名拒绝；leader 执行面放行', async () => {
  const s = await setup()
  try {
    const officeCtx = { agentId: s.leaderId, channelId: s.p.officeChannelId!, role: 'lead' as const, name: 'Project Leader' }
    // 执行面：leader 调 project_propose_channel 放行（gate 不拦）
    assert.equal(projectExecutionGate(s.leaderId, 'project_propose_channel'), null)
    const resp = await dispatchProjectTool(officeCtx, 'project_propose_channel', {
      name: '质检频道',
      charter: '负责质量抽检',
    })
    assert.equal(resp.isError, undefined, resp.text)
    const proposed = JSON.parse(resp.text)
    assert.equal(proposed.status, 'proposed')

    // leader 直接创建频道无任何平台路径；applyProposal 是唯一入口
    const applied = await s.svc.applyProposal(s.p.id, proposed.proposalId, s.owner)
    assert.ok(applied.channelId, 'channelId 应返回')
    const names = (s.db.prepare(`SELECT c.name AS name FROM project_channels pc JOIN channels c ON c.id = pc.channel_id WHERE pc.project_id = ? AND pc.status = 'active'`).all(s.p.id) as Array<{ name: string }>).map(r => r.name)
    assert.ok(names.includes('质检频道'), `绑定频道应含质检频道: ${names.join(',')}`)

    // 重名提案 → 工具层返回 CHANNEL_NAME_EXISTS（服务层抛错，工具层不炸）
    const dup = await dispatchProjectTool(officeCtx, 'project_propose_channel', { name: '质检频道' })
    assert.equal(dup.isError, true)
    assert.match(dup.text, /CHANNEL_NAME_EXISTS/)
    // 与办公室重名同样拒绝
    const officeName = s.manager.getChannelForUser(s.p.officeChannelId!, s.owner.id)?.name ?? ''
    const dupOffice = await dispatchProjectTool(officeCtx, 'project_propose_channel', { name: officeName })
    assert.equal(dupOffice.isError, true)
    assert.match(dupOffice.text, /CHANNEL_NAME_EXISTS/)
    // 重复应用同一提案 → PROPOSAL_STATE_INVALID
    await assert.rejects(
      () => s.svc.applyProposal(s.p.id, proposed.proposalId, s.owner),
      (e: unknown) => (e as { code?: string }).code === 'PROPOSAL_STATE_INVALID',
    )
  }
  finally {
    s.db.close()
  }
})

test('项目组修改：解绑随行终结化在飞工作项（P0-3）；空频道可直接解绑', async () => {
  const s = await setup()
  try {
    // P0-3 解绑语义：在飞工作项随解绑终结化（CANCELED/CHANNEL_DETACHED + attempt 闭合），
    // 不再 409 拒绝 —— 旧行为会让 worker 因绑定失效 403 永远无法提交，工作项永久悬挂。
    const wi = s.svc.createWorkItem(s.p.id, s.owner, {
      deliverableId: s.d.id,
      channelId: s.member.channelId,
      title: '进行中的工作项',
    })
    s.svc.unbindChannel(s.p.id, s.member.channelId, s.owner)
    const events = s.svc.listEvents(s.p.id, s.owner)
    assert.ok(events.some(e => e.type === 'work.canceled'), '解绑必须发出 work.canceled')
    const after = s.svc.listWorkItems(s.p.id, s.owner).find(w => w.id === wi.id)
    assert.equal(after?.state, 'CANCELED')
    assert.equal(after?.stateReason, 'CHANNEL_DETACHED')
    let binding = s.svc.listChannels(s.p.id, s.owner).find(b => b.channelId === s.member.channelId)
    assert.equal(binding?.status, 'detached')

    // 已终结工作项的频道重新绑定后可直接解绑（无在飞 → 不产生新取消）
    const rebind = s.svc.bindChannel(s.p.id, s.member.channelId, s.owner, { charter: 'rebind' })
    assert.equal(rebind.status, 'active')
    s.svc.unbindChannel(s.p.id, s.member.channelId, s.owner)
    binding = s.svc.listChannels(s.p.id, s.owner).find(b => b.channelId === s.member.channelId)
    assert.equal(binding?.status, 'detached')
    assert.ok(!s.svc.listEvents(s.p.id, s.owner).some(e => e.type === 'channel.detached'), 'P0-3 后不再发 channel.detached')
  }
  finally {
    s.db.close()
  }
})
