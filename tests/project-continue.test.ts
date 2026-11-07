/**
 * Project 持续开发（owner 补充需求 → 同一 Leader replan → owner 批准 → 增量物化）。
 *
 * 覆盖：
 *  - completed/paused 项目可被 owner 重新打开，且保留原 plan/交付物；
 *  - 补充需求作为办公室群聊投递给同一个 Project Leader（服务端生成 mention）；
 *  - Leader 可在重开后提出 plan vN+1 增量，owner 批准后物化新交付物/工作项；
 *  - archived/draft/非 owner 不可继续。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-project-continue-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { initProjectService } = await import('../server/services/workshop/projects/service')
type AgentChannelManager = import('../server/services/workshop/runtime/manager').AgentChannelManager

function fixture() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createChannelAgentRepo(db)
  const sentChat: Array<{
    channelId: string
    userId: string
    text: string
    mentions: Array<{ type: string, id: string }>
    clientMessageId?: string
  }> = []
  let chatSeq = 0
  let chatStatus: 'delivered' | 'failed' = 'delivered'
  const manager = {
    async createChannel(input: { name: string, ownerUserId?: string | null, leadAgent?: { name: string, harness: string, agentKind?: string } }) {
      const ch = channels.create({ name: input.name, ownerUserId: input.ownerUserId ?? null })
      channels.update(ch.id, { workspace: `data/workspaces/${ch.id}` })
      let leadAgentId: string | undefined
      if (input.leadAgent) {
        const inst = agents.create({
          channelId: ch.id,
          templateId: null,
          name: input.leadAgent.name,
          harness: input.leadAgent.harness,
          role: 'lead',
          agentKind: input.leadAgent.agentKind as never,
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
    sendChatMessage(channelId: string, user: { id: string }, input: {
      text: string
      mentions?: Array<{ type: string, id: string, label?: string }>
      clientMessageId?: string
    }) {
      chatSeq += 1
      sentChat.push({
        channelId,
        userId: user.id,
        text: input.text,
        mentions: (input.mentions ?? []).map(m => ({ type: m.type, id: m.id })),
        clientMessageId: input.clientMessageId,
      })
      const id = `chat-${chatSeq}`
      return {
        message: {
          id,
          channelId,
          senderType: 'user',
          senderId: user.id,
          senderName: 'owner',
          text: input.text,
          mentions: input.mentions ?? [],
          replyToId: null,
          requesterUserId: user.id,
          sourceChatMessageId: null,
          clientMessageId: input.clientMessageId ?? '',
          createdAt: new Date().toISOString(),
        },
        deliveries: [{ deliveryId: `delivery-${chatSeq}`, agentId: input.mentions?.[0]?.id ?? '', status: chatStatus }],
        duplicates: false,
        unresolvedMentions: [],
        mentions: input.mentions ?? [],
      }
    },
  } as unknown as AgentChannelManager
  const svc = initProjectService(manager, db)
  return {
    db,
    channels,
    agents,
    manager,
    svc,
    sentChat,
    setChatStatus: (status: 'delivered' | 'failed') => { chatStatus = status },
  }
}

type Fixture = ReturnType<typeof fixture>

async function setupProject(f: Fixture) {
  const owner = { id: 'u-owner', role: 'user' }
  const p = await f.svc.create({
    name: `continue-${randomUUID().slice(0, 8)}`,
    objective: '持续对话开发',
    autoDispatch: true,
    routingPolicy: 'technical',
    mode: 'supervised',
  }, owner)
  const dev = await f.manager.createChannel({
    name: `dev-${randomUUID().slice(0, 6)}`,
    ownerUserId: owner.id,
    leadAgent: { name: 'Dev Lead', harness: 'mock' },
  })
  f.svc.bindChannel(p.id, dev.channelId, owner)
  f.svc.createDeliverable(p.id, owner, {
    name: '初版交付',
    ownerChannelId: dev.channelId,
    acceptanceCriteria: ['artifact.present'],
  })
  f.svc.activate(p.id, owner)
  const lead = f.svc.get(p.id, owner).leadAgentId!
  return { owner, p: f.svc.get(p.id, owner), dev, lead }
}

test('completed 项目可由 owner 继续：重开 + 办公室对话 + Leader replan 物化增量', async () => {
  const f = fixture()
  const s = await setupProject(f)
  // 模拟既有 plan v1 已批准，验证持续开发提出的是 v2 增量。
  f.db.prepare('UPDATE projects SET plan_version = 1, plan_json = ? WHERE id = ?')
    .run(JSON.stringify({ deliverables: [{ key: 'base', name: '初版交付' }], work_items: [] }), s.p.id)
  f.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('completed', s.p.id)

  const result = await f.svc.continueProject(s.p.id, s.owner, {
    message: '请修复游戏 bug，并补一个移动端操作说明。',
    clientMessageId: 'continue-1',
  })
  assert.equal(result.reopened, true)
  assert.equal(result.project.status, 'active')
  assert.equal(f.sentChat.length, 1)
  assert.equal(f.sentChat[0]!.channelId, s.p.officeChannelId)
  assert.equal(f.sentChat[0]!.userId, s.owner.id)
  assert.equal(f.sentChat[0]!.clientMessageId, 'continue-1')
  assert.deepEqual(f.sentChat[0]!.mentions, [{ type: 'agent', id: s.lead }])

  const types = f.svc.listEvents(s.p.id, s.owner).map(e => e.type)
  assert.ok(types.includes('project.followup_requested'))
  assert.ok(types.includes('project.reopened'))

  // 同一个 Leader 在重开后提出增量计划（plan v2）。
  const proposal = f.svc.agentRequestPlan(s.lead, {
    deliverables: [{
      key: 'fix',
      name: '游戏修复交付',
      description: '修复已验证 bug，交付新 HTML 与回归证据',
      required: true,
      channelId: s.dev.channelId,
      acceptanceCriteria: ['artifact.present', 'text.contains:修复'],
    }],
    work_items: [{
      key: 'w-fix',
      deliverableKey: 'fix',
      channelId: s.dev.channelId,
      title: '修复游戏 bug',
      brief: '复现→根因→改动→回归验证；交付新 HTML 文件。',
      dedupeKey: 'followup-game-fix',
      execBudgetMinutes: 40,
    }],
  }, 'replan')
  assert.equal(proposal.version, 2)

  const approved = f.svc.decideApproval(s.p.id, proposal.approval.id, s.owner, true, '同意增量')
  assert.equal(approved.status, 'approved')

  const deliverables = f.svc.listDeliverables(s.p.id, s.owner)
  assert.ok(deliverables.some(d => d.name === '游戏修复交付'))
  const items = f.svc.listWorkItems(s.p.id, s.owner)
  assert.ok(items.some(w => w.title === '修复游戏 bug' && w.dedupeKey === 'followup-game-fix'))
  assert.equal(f.svc.get(s.p.id, s.owner).planVersion, 2)
  // C5：重复批准同一 plan 不得二次物化。
  const before = f.svc.listWorkItems(s.p.id, s.owner).length
  assert.throws(
    () => f.svc.decideApproval(s.p.id, proposal.approval.id, s.owner, true, '重复批准'),
    /审批状态 .* 不能决策/,
  )
  assert.equal(f.svc.listWorkItems(s.p.id, s.owner).length, before)
})

test('投递失败：回滚项目状态且不写 followup/reopened 审计', async () => {
  const f = fixture()
  const s = await setupProject(f)
  f.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('completed', s.p.id)
  f.setChatStatus('failed')

  await assert.rejects(
    () => f.svc.continueProject(s.p.id, s.owner, { message: '这条消息投不出去' }),
    /未投递到 Project Leader/,
  )
  assert.equal(f.svc.get(s.p.id, s.owner).status, 'completed')
  const types = f.svc.listEvents(s.p.id, s.owner).map(e => e.type)
  assert.ok(!types.includes('project.followup_requested'))
  assert.ok(!types.includes('project.reopened'))
})

test('paused 项目继续会恢复 active；active 项目继续不改状态', async () => {
  const f = fixture()
  const s = await setupProject(f)
  f.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('paused', s.p.id)
  const resumed = await f.svc.continueProject(s.p.id, s.owner, { message: '继续修复' })
  assert.equal(resumed.reopened, true)
  assert.equal(resumed.project.status, 'active')

  const again = await f.svc.continueProject(s.p.id, s.owner, { message: '再补充一个边界情况' })
  assert.equal(again.reopened, false)
  assert.equal(again.project.status, 'active')
  assert.equal(f.sentChat.length, 2)
})

test('archived/draft/非 owner 不能继续开发', async () => {
  const f = fixture()
  const s = await setupProject(f)

  f.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('archived', s.p.id)
  await assert.rejects(
    () => f.svc.continueProject(s.p.id, s.owner, { message: 'x' }),
    /已归档/,
  )

  f.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('draft', s.p.id)
  await assert.rejects(
    () => f.svc.continueProject(s.p.id, s.owner, { message: 'x' }),
    /尚未激活/,
  )

  f.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('completed', s.p.id)
  await assert.rejects(
    () => f.svc.continueProject(s.p.id, { id: 'u-stranger', role: 'user' }, { message: 'x' }),
    /FORBIDDEN|owner|成员|无权/,
  )
  assert.equal(f.sentChat.length, 0)
})
