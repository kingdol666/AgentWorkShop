/**
 * 项目任务实例回归（plan 2026-11-07-project-task-session-plan.md P1）：
 *
 *   TI-A 模板成员筛选：排除办公室 leader、既有会话/任务实例克隆与停用成员
 *   TI-B 任务实例创建：专属 Channel（模板名派生）+ 全成员克隆（lead 保持 lead 身份）
 *        + 节点绑定面复制 + 会话行（project/workItem/kind=task 溯源 + 真实 memberMap）
 *   TI-C 会话 repo 新列与按工作项查询（重试复用 active 行的依据）
 *   TI-D 任务终态回收语义的前置：会话 close 幂等（repo 级）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-task-instance-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelSessionRepo } = await import('../server/services/workshop/db/channel-session.repo')
const { createTaskInstanceChannel, templateMembersOf, TASK_INSTANCE_MARKER } = await import('../server/services/workshop/agents/task-channel')
type TaskInstanceDeps = import('../server/services/workshop/agents/task-channel').TaskInstanceDeps

function fixture() {
  const db = openWorkshopDb(':memory:')
  const sessions = createChannelSessionRepo(db)
  const bindingsByAgent: Record<string, Array<{ nodeId: string, kind: string, mode?: string }>> = {}
  const createdChannels: Array<{ name: string, description?: string, leadAgent?: { name: string } }> = []
  const createdMembers: Array<{ channelId: string, name: string, role: string }> = []
  const templateMembers = [
    { id: 'tpl-lead', name: 'Lead·协调', harness: 'mock', role: 'lead', enabled: 1, agentKind: 'channel_agent', configJson: '{"provider":"x"}' },
    { id: 'tpl-w1', name: 'Worker·产线', harness: 'mock', role: 'worker', enabled: 1, agentKind: 'channel_agent', configJson: '{}' },
    { id: 'tpl-w2', name: 'Worker·停用', harness: 'mock', role: 'worker', enabled: 0, agentKind: 'channel_agent', configJson: '{}' },
    { id: 'tpl-office', name: 'Office·Leader', harness: 'mock', role: 'lead', enabled: 1, agentKind: 'project_leader', configJson: '{}' },
    { id: 'tpl-sess', name: `Worker·产线${'·session·'}1`, harness: 'mock', role: 'worker', enabled: 1, agentKind: 'channel_agent', configJson: '{}' },
    { id: 'tpl-task', name: `Worker·产线${TASK_INSTANCE_MARKER}ab12`, harness: 'mock', role: 'worker', enabled: 1, agentKind: 'channel_agent', configJson: '{}' },
  ]
  bindingsByAgent['tpl-lead'] = [{ nodeId: 'dw-1', kind: 'dcw', mode: 'auto' }]
  bindingsByAgent['tpl-w1'] = [{ nodeId: 'dw-2', kind: 'daq', mode: 'auto' }, { nodeId: 'dw-1', kind: 'dcw', mode: 'auto' }]

  const deps: TaskInstanceDeps = {
    channels: {
      findById: (id: string) => id === 'ch-template'
        ? { id: 'ch-template', name: '交付执行频道', scenarioPrompt: '落地页交付', llmJson: '{"provider":"lm-studio","model":"m1"}', ownerUserId: 'u-1' }
        : undefined,
    },
    channelAgents: {
      listByChannel: (channelId: string) => channelId === 'ch-template' ? templateMembers : [],
      create: (input) => {
        const id = `inst-${createdMembers.length + 1}`
        createdMembers.push({ channelId: input.channelId, name: input.name, role: input.role })
        return { id, name: input.name, role: input.role }
      },
    },
    bindings: {
      byAgent: (agentId: string) => bindingsByAgent[agentId] ?? [],
      bind: (agentId, nodeId, kind, mode) => {
        (bindingsByAgent[agentId] ??= []).push({ nodeId, kind, mode })
      },
    },
    sessions,
    createChannel: async (input) => {
      createdChannels.push({ name: input.name, description: input.description, leadAgent: input.leadAgent })
      // 模拟 manager.createChannel 建 lead 实例
      bindingsByAgent['inst-lead'] = []
      return { channelId: 'ch-task-1', leadAgentId: 'inst-lead', workspace: 'data/workspaces/ch-task-1' }
    },
    notify: () => {},
  }
  return { db, sessions, deps, createdChannels, createdMembers, bindingsByAgent }
}

test('TI-A 模板成员筛选：排除办公室 leader / 会话克隆 / 任务克隆 / 停用成员', () => {
  const f = fixture()
  try {
    const rows = templateMembersOf(f.deps, 'ch-template')
    assert.deepEqual(rows.map(r => r.id), ['tpl-lead', 'tpl-w1'], '只保留启用的 lead/worker 基础成员')
  }
  finally { f.db.close() }
})

test('TI-B 任务实例创建：专属 Channel + 全成员克隆 + 绑定复制 + 会话溯源', async () => {
  const f = fixture()
  try {
    const r = await createTaskInstanceChannel(f.deps, {
      projectId: 'p-1',
      workItemId: 'wi-1',
      templateChannelId: 'ch-template',
      title: '落地页设计与实现',
      actorId: 'u-1',
    })
    // 专属 Channel：名称由模板派生并带任务标记；lead 名称带标记
    assert.equal(r.channelId, 'ch-task-1')
    assert.equal(r.leadAgentId, 'inst-lead')
    assert.equal(f.createdChannels.length, 1)
    assert.match(f.createdChannels[0]!.name, /交付执行频道 · 任务 /)
    assert.match(f.createdChannels[0]!.leadAgent!.name, new RegExp(TASK_INSTANCE_MARKER))
    // 成员：lead 保持 lead 身份（channel_lead 工具面前提），worker 为 worker
    assert.equal(r.members.length, 2, '克隆 lead + 1 个启用 worker')
    assert.equal(r.members.find(m => m.role === 'lead')!.instanceId, 'inst-lead')
    const worker = r.members.find(m => m.templateAgentId === 'tpl-w1')!
    assert.equal(worker.role, 'worker')
    assert.ok(f.createdMembers.some(m => m.name.includes(TASK_INSTANCE_MARKER) && m.role === 'worker'))
    // 节点绑定面复制：lead 与 worker 的绑定都落到实例成员
    assert.equal(f.bindingsByAgent['inst-lead']!.length, 1)
    assert.equal(f.bindingsByAgent[worker.instanceId]!.length, 2)
    // 会话行：任务溯源 + 真实 memberMap（模板成员 → 实例成员）
    const s = f.sessions.findById(r.sessionId)!
    assert.equal(s.projectId, 'p-1')
    assert.equal(s.projectWorkItemId, 'wi-1')
    assert.equal(s.instanceKind, 'task')
    assert.equal(s.createdByKind, 'project')
    assert.equal(s.channelId, 'ch-task-1')
    assert.match(s.title, /任务：落地页设计与实现/)
    const map = JSON.parse(s.memberMapJson) as Record<string, string>
    assert.deepEqual(map, { 'tpl-lead': 'inst-lead', 'tpl-w1': worker.instanceId })
    // 按工作项可查（重试复用 active 实例的依据）
    assert.equal(f.sessions.listByWorkItem('wi-1').length, 1)
    assert.equal(f.sessions.listByProject('p-1').length, 1)
  }
  finally { f.db.close() }
})

test('TI-C 会话 close 幂等：任务终态回收可重复执行', async () => {
  const f = fixture()
  try {
    const r = await createTaskInstanceChannel(f.deps, {
      projectId: 'p-1', workItemId: 'wi-2', templateChannelId: 'ch-template', title: 't', actorId: 'u-1',
    })
    assert.equal(f.sessions.close(r.sessionId), true)
    assert.equal(f.sessions.close(r.sessionId), false, '已关闭会话重复 close 返回 false')
    assert.equal(f.sessions.listByWorkItem('wi-2')[0]!.status, 'closed')
  }
  finally { f.db.close() }
})

test('TI-D 模板无可用 lead → 409（禁止建立无调度器的任务实例）', async () => {
  const f = fixture()
  try {
    f.deps.channelAgents.listByChannel = () => [
      { id: 'w', name: 'Worker', harness: 'mock', role: 'worker', enabled: 1, agentKind: 'channel_agent', configJson: '{}' },
    ]
    await assert.rejects(
      () => createTaskInstanceChannel(f.deps, {
        projectId: 'p', workItemId: 'wi', templateChannelId: 'ch-template', title: 't', actorId: 'u',
      }),
      /没有可克隆的 lead/,
    )
  }
  finally { f.db.close() }
})
