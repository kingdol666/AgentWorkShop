/**
 * F2A 优化经验台账装配单测(纯函数,不触真实仓储):
 * dcw 节点按 nodeId、配方按 recipeId 匹配;配方无记录时如实提示。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-opt-notes-'))

const { optimizationNoteLines } = await import('../server/services/workshop/agents/industrial-context')

const rec = (nodeName: string, verdict: string | null, reason = '', status = 'judged') => ({
  nodeName,
  status,
  judge: verdict ? { verdict, reason } : null,
})

describe('optimizationNoteLines', () => {
  it('dcw 节点按 nodeId 聚合 keep/rollback(与旧行为同格式)', () => {
    const asks: Array<Record<string, string | undefined>> = []
    const lines = optimizationNoteLines({
      dcwNodes: ['dn-1'],
      recipes: [],
      recordsOf: (f) => {
        asks.push(f)
        return [rec('烘箱温度', 'keep'), rec('烘箱温度', 'rollback', '膜厚变薄')]
      },
    })
    assert.deepEqual(asks, [{ nodeId: 'dn-1' }])
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /烘箱温度:近 2 次调控\(keep 1\/rollback 1\)/)
    assert.match(lines[0]!, /最近判定 keep|最近判定 rollback/)
  })

  it('配方绑定按 recipeId 匹配记录', () => {
    const asks: Array<Record<string, string | undefined>> = []
    const lines = optimizationNoteLines({
      dcwNodes: [],
      recipes: [{ recipeId: 'rr-100', name: 'BOPET 主线配方' }],
      recordsOf: (f) => {
        asks.push(f)
        return [rec('拉伸比', 'keep', '厚度入窗'), rec('拉伸比', 'rollback', '破膜')]
      },
    })
    assert.deepEqual(asks, [{ recipeId: 'rr-100' }])
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /BOPET 主线配方\(配方\):近 2 次调控\(keep 1\/rollback 1\)/)
  })

  it('配方无记录 → 如实提示一行(不返回空,避免模型误判查询失败)', () => {
    const lines = optimizationNoteLines({
      dcwNodes: [],
      recipes: [{ recipeId: 'rr-empty', name: '新配方' }],
      recordsOf: () => [],
    })
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /新配方:暂无历史调控记录/)
  })

  it('无绑定 → 空数组', () => {
    assert.deepEqual(optimizationNoteLines({ dcwNodes: [], recipes: [], recordsOf: () => [] }), [])
  })
})
