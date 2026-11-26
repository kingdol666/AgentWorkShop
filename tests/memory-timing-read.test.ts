/**
 * 批次 A：自动注入会话隔离（M1）。
 *
 * 反例：同一 agent 在 s1 的自动注入块出现 s2 的内容。
 * 正例：session_id='' 的频道级沉淀仍可见；显式 scope=session 严格隔离。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-timing-read-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

test('automatic recall isolates sessions but keeps channel-level rows', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
      VALUES ('c1','C1','','','','{}',1,1,'',?,?)`).run(now, now)
    const repo = createMemoryRepo(db)
    const mk = (sessionId: string, content: string, key: string) => repo.upsert({
      channelId: 'c1', agentId: 'a1', kind: 'semantic', title: `温度阈值 ${key}`,
      titleFts: `温 度 阈 值 ${key}`, content, importance: 0.8, sessionId, dedupKey: key,
    })
    mk('s1', '本会话结论 182.5', 'k1')
    mk('s2', '另一会话机密结论 999', 'k2')
    mk('', '频道级通用约定 777', 'k3')

    const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1', industrialScopeEnabled: false })
    const block = String(await memory.recall('温度 阈值 结论 约定') ?? '')
    assert.ok(block.includes('182.5'), '本会话行应注入')
    assert.ok(!block.includes('999'), '其他会话行不得进入自动注入')
    assert.ok(block.includes('777'), 'session_id=\'\' 的频道级行应保留')

    const explicit = await memory.recallRows('温度 阈值 结论 约定', { scope: 'session', sessionId: 's1' })
    assert.ok(explicit.every(r => r.sessionId === 's1'), '显式 session 档仍严格')
  }
  finally {
    db.close()
  }
})

test('automatic recall without session fails closed to channel-level rows only', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
      VALUES ('c1','C1','','','','{}',1,1,'',?,?)`).run(now, now)
    const repo = createMemoryRepo(db)
    repo.upsert({ channelId: 'c1', agentId: 'a1', kind: 'semantic', title: '阈值 会话', titleFts: '阈 值 会 话', content: '会话内容 111', importance: 0.8, sessionId: 's1', dedupKey: 'k1' })
    repo.upsert({ channelId: 'c1', agentId: 'a1', kind: 'semantic', title: '阈值 通用', titleFts: '阈 值 通 用', content: '通用内容 222', importance: 0.8, sessionId: '', dedupKey: 'k2' })
    const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', industrialScopeEnabled: false })
    const block = String(await memory.recall('阈值 内容') ?? '')
    assert.ok(!block.includes('111'), '无会话身份时不得注入会话行')
    assert.ok(block.includes('222'), '无会话身份时频道级行仍可用')
  }
  finally {
    db.close()
  }
})
