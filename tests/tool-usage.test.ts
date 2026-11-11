/**
 * 频道工具用量聚合(计划 H12,2026-11-11)—— Block 管线的**下游业务消费者**。
 *
 * 此前 agent.block 只有渲染+回放两个消费面;本模块为业务面提供:
 *  - repo:listByTypes(按类型正查,窗口/上限受控)
 *  - aggregateToolUsage(纯函数:按 harness|tool|agent 聚合 start/ok/error/unknown)
 *  - GET /api/workshop/channels/:id/tool-usage(REST 面)
 * 契约:坏载荷不计入任何桶但必须计数暴露(invalid);聚合键含 agentId(多实例分账)。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-toolusage-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { aggregateToolUsage } = await import('../server/services/workshop/agents/tool-usage')
const { normalizeToolLine } = await import('../shared/agent-blocks')

const block = (line: string, harness: string) => ({ block: normalizeToolLine(line, harness)! })

describe('channel-event repo · listByTypes', () => {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const ch = channels.create({ name: 'usage-ch' })
  const repo = createChannelEventRepo(db)

  const ev = (seq: number, type: string, at: string, payload: unknown, agentId: string | null = 'agent-1') =>
    repo.insert(ch.id, { seq, type, at, agentId, taskId: null, payload })

  ev(1, 'agent.status.message', '2026-11-11T00:00:01Z', { text: '🔧 a(x)' })
  ev(2, 'agent.block', '2026-11-11T00:00:02Z', block('🔧 daq_query({"node_id":"dn-1"})', 'omp'))
  ev(3, 'agent.block', '2026-11-11T00:00:03Z', block('🔧 daq_query ✅ 完成: ok', 'omp'))
  ev(4, 'agent.delta', '2026-11-11T00:00:04Z', { delta: 'x' })
  ev(5, 'agent.block', '2026-11-11T00:00:05Z', { block: { garbage: true } })
  ev(6, 'agent.block', '2026-11-11T00:00:06Z', block('🔧 recipe_trial(y)', 'omp'), 'agent-2')

  it('只取指定类型,正序返回', () => {
    const rows = repo.listByTypes(ch.id, ['agent.block'], 100)
    assert.deepEqual(rows.map(r => r.seq), [2, 3, 5, 6])
  })
  it('limit 倒序截取后仍正序(取最新段)', () => {
    const rows = repo.listByTypes(ch.id, ['agent.block'], 2)
    assert.deepEqual(rows.map(r => r.seq), [5, 6])
  })
  it('since 窗口过滤(at >= since)', () => {
    const rows = repo.listByTypes(ch.id, ['agent.block'], 100, '2026-11-11T00:00:05Z')
    assert.deepEqual(rows.map(r => r.seq), [5, 6])
  })
  it('多类型并集', () => {
    const rows = repo.listByTypes(ch.id, ['agent.block', 'agent.status.message'], 100)
    assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 5, 6])
  })
})

describe('aggregateToolUsage · 纯函数聚合', () => {
  const mk = (at: string, agentId: string | null, payload: unknown) => ({ at, agentId, payload })

  it('按 harness|tool|agent 聚合 start/ok/error 与 lastAt', () => {
    const rows = [
      mk('2026-11-11T00:00:02Z', 'agent-1', block('🔧 daq_query(x)', 'omp')),
      mk('2026-11-11T00:00:03Z', 'agent-1', block('🔧 daq_query ✅ 完成: ok', 'omp')),
      mk('2026-11-11T00:00:05Z', 'agent-1', block('🔧 recipe_trial ❌ 失败: denied', 'omp')),
      mk('2026-11-11T00:00:06Z', 'agent-2', block('🔧 daq_query(x)', 'omp')),
    ]
    const out = aggregateToolUsage(rows as never)
    assert.equal(out.total, 4)
    assert.equal(out.invalid, 0)
    const byKey = new Map(out.tools.map(t => [t.key, t]))
    const a1 = byKey.get('omp|daq_query|agent-1')!
    assert.equal(a1.starts, 1)
    assert.equal(a1.ok, 1)
    assert.equal(a1.error, 0)
    const err = byKey.get('omp|recipe_trial|agent-1')!
    assert.equal(err.error, 1)
    assert.equal(byKey.get('omp|daq_query|agent-2')!.starts, 1, '不同 agentId 分账')
  })

  it('end 按 status 入桶(end+ok→ok);harness 不同分账;坏载荷计 invalid', () => {
    const rows = [
      mk('2026-11-11T00:00:02Z', 'agent-1', block('🔧 t ✅ 完成: ok', 'omp')),
      mk('2026-11-11T00:00:03Z', 'agent-1', block('🔧 t ✓', 'cursor')),
      mk('2026-11-11T00:00:04Z', 'agent-1', { block: { garbage: true } }),
      mk('2026-11-11T00:00:05Z', 'agent-1', { text: '不是块' }),
    ]
    const out = aggregateToolUsage(rows as never)
    assert.equal(out.invalid, 2, '坏载荷/非块帧计 invalid 暴露,不静默吞')
    const tRows = out.tools.filter(t => t.tool === 't')
    assert.equal(tRows.length, 2, 'omp/cursor harness 不同 → 分账两行')
    for (const row of tRows) {
      assert.equal(row.ok, 1, 'ok end 入 ok 桶 —— 已知结果不得降级为 unknown')
      assert.equal(row.unknown, 0)
      assert.equal(row.starts, 0, '无对应 start 帧(cursor 成功静默发射)是源侧事实,不伪造 starts')
    }
  })

  it('按 starts 降序排序;lastAt 取最大', () => {
    const rows = [
      mk('2026-11-11T00:00:02Z', 'a', block('🔧 hot(x)', 'omp')),
      mk('2026-11-11T00:00:03Z', 'a', block('🔧 hot(y)', 'omp')),
      mk('2026-11-11T00:00:09Z', 'a', block('🔧 cold(x)', 'omp')),
    ]
    const out = aggregateToolUsage(rows as never)
    assert.equal(out.tools[0].tool, 'hot')
    assert.equal(out.tools[0].lastAt, '2026-11-11T00:00:03Z')
  })
})
