/**
 * 记忆 session 作用域(PR-B):写入落 session 戳 / session 档检索隔离 / auto 档加分 / 工具桥透传。
 * 纯内存 DB;工具面用假 workspace 断言透传(与 lead-complete-task-binding.test.ts 同模式)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mem-session-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { handleSearchMemory, handleSaveMemory } = await import('../server/services/workshop/agents/host-tool-bridge/tools/memory')

function fixture(agentId = 'agent-a') {
  const db = openWorkshopDb(':memory:')
  const repo = createMemoryRepo(db)
  const mem = new AgentMemory(repo, { channelId: 'ch-1', agentId })
  return { db, repo, mem, agentId }
}

test('写入透传:save/recordPeerExchange/recordTaskOutcome 带 session 戳,缺省为频道级', async () => {
  const f = fixture()
  try {
    await f.mem.save({ title: '会话内结论', content: '锁定 A 方案', scope: 'private', sessionId: 'sess-1' })
    await f.mem.save({ title: '频道级结论', content: '值班手册目录', scope: 'private' })
    await f.mem.recordPeerExchange({
      messageId: 'm-1', contextId: 'ch-1', role: 'ROLE_USER',
      parts: [{ text: '请补 FAQ' }], metadata: { 'x-aw-session-id': 'sess-1' },
    }, '已补')
    await f.mem.recordTaskOutcome({
      id: 't-1', title: '交付任务', description: '', state: 'COMPLETED', artifacts: [], sessionId: 'sess-2',
    } as never)
    const rows = f.repo.listByAgentChannel('ch-1', f.agentId, 10)
    const byTitle = new Map(rows.map(r => [r.title, r]))
    assert.equal(byTitle.get('会话内结论')?.sessionId, 'sess-1')
    assert.equal(byTitle.get('频道级结论')?.sessionId, '')
    assert.equal(byTitle.get('来自 unknown 的消息')?.sessionId, 'sess-1', 'peer 交换按消息 metadata 戳 session')
    assert.equal(byTitle.get('交付任务')?.sessionId, 'sess-2', '任务终态按 task.sessionId 戳')
  }
  finally {
    f.db.close()
  }
})

test('session 档隔离:同 agent 两个会话的记忆互不可见', async () => {
  const f = fixture()
  try {
    await f.mem.save({ title: 'A 会话事实', content: 'A 方案与阈值 42', scope: 'private', sessionId: 'sess-a' })
    await f.mem.save({ title: 'B 会话事实', content: 'B 方案与阈值 43', scope: 'private', sessionId: 'sess-b' })
    const gotA = await f.mem.recallRows('A 方案 阈值', { scope: 'session', sessionId: 'sess-a' })
    const gotB = await f.mem.recallRows('B 方案 阈值', { scope: 'session', sessionId: 'sess-b' })
    assert.ok(gotA.length >= 1 && gotA.every(r => r.sessionId === 'sess-a'), 'session A 检索只回 A 行')
    assert.ok(gotB.length >= 1 && gotB.every(r => r.sessionId === 'sess-b'), 'session B 检索只回 B 行')
    assert.ok(!gotA.some(r => r.sessionId === 'sess-b') && !gotB.some(r => r.sessionId === 'sess-a'))
    // 缺 sessionId 的 session 档:不过滤(保守回退为本人域检索)
    const loose = await f.mem.recallRows('阈值', { scope: 'session' })
    assert.ok(loose.length >= 2)
  }
  finally {
    f.db.close()
  }
})

test('auto 档加分:同分时当前会话行排前(排序偏好,非过滤)', async () => {
  const f = fixture()
  try {
    // 两行标题/内容同 FTS 命中,仅 sessionId 不同 → relevance 打平,session 行应靠加分胜出
    await f.mem.save({ title: '巡检要点', content: '巡检阈值 42 每日检查', scope: 'private', sessionId: 'sess-a' })
    await f.mem.save({ title: '巡检要点', content: '巡检阈值 42 每日检查', scope: 'private' })
    const rows = await f.mem.recallRows('巡检 阈值', { scope: 'auto', sessionId: 'sess-a', limit: 5 })
    assert.ok(rows.length >= 2)
    assert.equal(rows[0]?.sessionId, 'sess-a', '当前会话行应排第一')
    // 不带 sessionId:两行分数相同,顺序不稳定但都可见
    const plain = await f.mem.recallRows('巡检 阈值', { scope: 'auto', limit: 5 })
    assert.equal(plain.length, 2)
  }
  finally {
    f.db.close()
  }
})

test('工具桥透传:handleSearchMemory/handleSaveMemory 使用会话态 sessionId', async () => {
  const f = fixture()
  try {
    const captured: Array<Record<string, unknown>> = []
    const fakeWs = {
      recallMemory: async (input: Record<string, unknown>) => {
        captured.push({ op: 'search', ...input })
        return []
      },
      saveMemory: async (input: Record<string, unknown>) => {
        captured.push({ op: 'save', ...input })
        return { scope: input.scope as 'private', dedupKey: 'k-1' }
      },
    } as never
    await handleSearchMemory({ query: '阈值', scope: 'session', limit: 3 }, fakeWs, 'sess-9')
    await handleSaveMemory({ title: 'T', content: 'C', scope: 'private' }, fakeWs, 'sess-9')
    await handleSaveMemory({ title: 'T2', content: 'C2', scope: 'private', session_scope: false }, fakeWs, 'sess-9')
    const search = captured.find(c => c.op === 'search')
    assert.equal(search?.sessionId, 'sess-9')
    assert.equal(search?.scope, 'session')
    const save = captured.filter(c => c.op === 'save')
    assert.equal(save[0]?.sessionId, 'sess-9', 'save 默认落当前会话作用域')
    assert.equal(save[1]?.sessionId, null, 'session_scope=false → 频道级')
    // 无 session 时 scope=session 应拒绝(防误用)
    const r = await handleSearchMemory({ query: 'x', scope: 'session' }, fakeWs, null)
    assert.match(r.text, /没有 session 上下文/)
  }
  finally {
    f.db.close()
  }
})

test('共享域行不串会话:team 行 session 戳只影响 session 档,auto/shared 不受影响', async () => {
  const f = fixture()
  try {
    await f.mem.save({ title: '共享约定', content: '跨会话共享约定', scope: 'shared', sessionId: 'sess-a' })
    const shared = await f.mem.recallRows('共享 约定', { scope: 'shared' })
    assert.ok(shared.length >= 1, 'shared 档照常命中 team 行')
    const sess = await f.mem.recallRows('共享 约定', { scope: 'session', sessionId: 'sess-a' })
    assert.ok(sess.length >= 1 && sess[0]?.sessionId === 'sess-a', 'session 档可命中本会话的 team 行')
    assert.equal(f.repo.listByAgentChannel('ch-1', TEAM_AGENT_ID, 5)[0]?.sessionId, 'sess-a')
  }
  finally {
    f.db.close()
  }
})
