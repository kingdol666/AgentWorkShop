/**
 * 批次 B：人类↔Agent 对话回合沉淀（M4）。
 *  - 1 条人类消息 + 回复 → 恰 1 行 episodic-dialog；
 *  - 重放同 messageId 不新增；
 *  - 不进自动注入；search_memory 显式检索可命中；
 *  - 30 天过期标记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-dialog-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')

test('human dialog is captured once, searchable, never auto-injected, and expires in 30d', async () => {
  const db = openWorkshopDb(':memory:')
  try {
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
      VALUES ('c1','C1','','','','{}',1,1,'',?,?)`).run(now, now)
    const repo = createMemoryRepo(db)
    const memory = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: 's1', industrialScopeEnabled: false })
    const msg = {
      messageId: 'm-1',
      contextId: 'c1',
      role: 'ROLE_USER',
      parts: [{ text: '保压压力 SP 调到 62 之后壁厚偏低，怎么处理？' }],
      metadata: { 'x-aw-from-user-id': 'u1' },
    } as never

    await memory.recordDialog(msg, '先把保压压力回调到 60，观察壁厚 3 个批次再决定。', 's1')
    await memory.recordDialog(msg, '先把保压压力回调到 60，观察壁厚 3 个批次再决定。', 's1')
    const rows = db.prepare(`SELECT id, kind, session_id AS sessionId, expires_at AS expiresAt FROM agent_memories WHERE kind = 'episodic-dialog'`).all() as Array<{ id: string, kind: string, sessionId: string, expiresAt: string | null }>
    assert.equal(rows.length, 1, '重放同一 messageId 不新增')
    assert.equal(rows[0].sessionId, 's1')
    assert.ok(rows[0].expiresAt, '应设置过期时间')
    const ttlDays = (Date.parse(rows[0].expiresAt!) - Date.now()) / 86_400_000
    assert.ok(ttlDays > 29 && ttlDays < 31, `30 天过期（实测 ${ttlDays.toFixed(1)}）`)

    const auto = String(await memory.recall('保压压力 壁厚 回调') ?? '')
    assert.ok(!auto.includes('回调到 60'), '对话摘要不得自动注入')
    const explicit = await memory.recallRows('保压压力 壁厚 回调', { scope: 'session', sessionId: 's1' })
    assert.ok(explicit.some(r => r.content.includes('回调到 60')), '显式检索应命中对话摘要')
  }
  finally {
    db.close()
  }
})
