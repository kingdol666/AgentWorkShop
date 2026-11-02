/**
 * P2 干预台账单测(科学探索计划,docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - 台账往返:record → attach verdict → 读回(verdict/effect/CI/MDE/verdictDetail)
 *  - 前置门数据源:pendingUnclosedEvent(判读窗未满)/ recentBlockedVerdictEvent(欠功效建议窗未过)
 *  - 无判读上下文路径(manual/recipe)→ unassessed,不参与前置门拦截
 *  - 写咽喉挂钩:recordDcwWriteOps 成功路径落台账一行(ack/readback/path/channel 归因)+ 10s 去重不重复落行
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-intv-ledger-'))

const ledger = await import('../server/services/workshop/aml/intervention-ledger')
const { recordDcwWriteOps, opsWriteMemo } = await import('../server/services/workshop/dcw/dcw-controller/write-audit')

// AML runtime 引导(与 aml-job-success.test.ts 同范式):打开库(含 SCHEMA_SQL 幂等建表)后注入 runtime
const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
configureAmlRuntime(openWorkshopDb(join(process.env.AW_HOME!, 'intervention-ledger.sqlite')))

const engineVerdict = (verdict: string, significant = false) => ({ verdict, significant, reasons: [] }) as Parameters<typeof ledger.verdictCodeOf>[0]

describe('intervention-ledger 台账往返', () => {
  it('record → attach → 读回:verdict/effect/CI/MDE/verdictDetail 全落', () => {
    const id = ledger.recordIntervention({
      nodeId: 'dw-t1',
      nodeName: '吹压SP',
      lineId: 'ln-t',
      fromValue: 2.6,
      toValue: 2.4,
      actualValue: 2.4,
      ack: 'readback-verified',
      path: 'agent',
      actor: 'ag-1',
      channelId: 'ch-1',
      hypothesis: '测试假设',
      targetNodeId: 'daq-t',
      criterion: { metric: 'wall_thickness', op: '>', threshold: 0.003, mde: 0.003 },
      settleMs: 45_000,
    })
    assert.ok(id, '台账写入应返回 id')
    const row = ledger.latestIntervention('dw-t1')
    assert.ok(row)
    assert.equal(row!.verdict, 'pending')
    assert.equal(row!.fromValue, 2.6)
    assert.equal(row!.toValue, 2.4)
    assert.equal(row!.ack, 'readback-verified')
    assert.equal(row!.criterion?.mde, 0.003)
    assert.equal(row!.targetNodeId, 'daq-t')

    assert.ok(ledger.attachAssessment(id!, {
      verdict: 'underpowered',
      effect: 0.0012,
      ciLow: -0.002,
      ciHigh: 0.004,
      mde: 0.0042,
      detail: { suggestedWindowMs: 100, postCoveragePeriods: 0.17 },
    }))
    const after = ledger.latestIntervention('dw-t1')!
    assert.equal(after.verdict, 'underpowered')
    assert.equal(after.effect, 0.0012)
    assert.equal(after.mde, 0.0042)
    assert.equal((after.verdictDetail?.suggestedWindowMs as number), 100)
    const line = ledger.interventionLines([after])[0] ?? ''
    assert.match(line, /欠功效/)
    assert.match(line, /MDE/)
  })

  it('无判读上下文路径 → unassessed,不参与前置门拦截', () => {
    ledger.recordIntervention({ nodeId: 'dw-t2', lineId: 'ln-t', fromValue: 1, toValue: 2, actualValue: null, path: 'manual', actor: 'u1' })
    const row = ledger.latestIntervention('dw-t2')!
    assert.equal(row.verdict, 'unassessed')
    assert.equal(ledger.pendingUnclosedEvent('dw-t2'), null)
  })

  it('verdictCodeOf:引擎五态映射(负结果≠欠功效)', () => {
    assert.equal(ledger.verdictCodeOf(engineVerdict('IDENTIFIABLE', true)), 'identifiable_effect')
    assert.equal(ledger.verdictCodeOf(engineVerdict('IDENTIFIABLE', false)), 'no_resolvable_effect')
    assert.equal(ledger.verdictCodeOf(engineVerdict('UNDERPOWERED')), 'underpowered')
    assert.equal(ledger.verdictCodeOf(engineVerdict('CONFOUNDED')), 'confounded')
    assert.equal(ledger.verdictCodeOf(engineVerdict('INSUFFICIENT_DATA')), 'unassessed')
  })
})

describe('前置门数据源(时间窗语义,短窗实测)', () => {
  it('pendingUnclosedEvent:判读窗内非空,窗满/收口后为 null', async () => {
    const id = ledger.recordIntervention({ nodeId: 'dw-gate', lineId: 'ln-t', fromValue: 1, toValue: 1.1, actualValue: null, path: 'agent', actor: 'a', targetNodeId: 'daq-t', settleMs: 120 })
    assert.ok(ledger.pendingUnclosedEvent('dw-gate'), '判读窗内必须拦截')
    ledger.attachAssessment(id!, { verdict: 'no_resolvable_effect' })
    assert.equal(ledger.pendingUnclosedEvent('dw-gate'), null, '已收口不再拦截')
    await sleep(140)
    assert.equal(ledger.pendingUnclosedEvent('dw-gate'), null)
  })

  it('recentBlockedVerdictEvent:欠功效建议窗内拦截,窗满放行', async () => {
    const id = ledger.recordIntervention({ nodeId: 'dw-gate2', lineId: 'ln-t', fromValue: 1, toValue: 1.1, actualValue: null, path: 'agent', actor: 'a', targetNodeId: 'daq-t', settleMs: 50 })
    ledger.attachAssessment(id!, { verdict: 'underpowered', detail: { suggestedWindowMs: 120 } })
    const blocked = ledger.recentBlockedVerdictEvent('dw-gate2')
    assert.ok(blocked, '建议窗内必须拦截')
    assert.equal(blocked!.suggestedWindowMs, 120)
    await sleep(140)
    assert.equal(ledger.recentBlockedVerdictEvent('dw-gate2'), null, '建议窗满放行')
  })
})

describe('写咽喉挂钩(recordDcwWriteOps → 台账)', () => {
  it('成功路径落一行:ack/readback/path/channel 归因;同值 10s 去重不重复落行', () => {
    opsWriteMemo.clear()
    const args = {
      id: 'dw-hook-1',
      node: { name: '温度SP', unit: '℃', lineId: 'ln-hook' },
      eng: 63.5,
      prevValue: 61 as number | null,
      outcome: { ok: true, message: 'ok', ack: 'readback-verified', readback: 63.5 },
      src: 'agent' as const,
      meta: { source: 'agent' as const, actor: 'ag-9', channelId: 'ch-hook' },
      recipeRunId: null as string | null,
    }
    recordDcwWriteOps(args)
    const row = ledger.latestIntervention('dw-hook-1')
    assert.ok(row, '写咽喉成功路径必须落台账')
    assert.equal(row!.path, 'agent')
    assert.equal(row!.ack, 'readback-verified')
    assert.equal(row!.actualValue, 63.5)
    assert.equal(row!.fromValue, 61)
    assert.equal(row!.channelId, 'ch-hook')
    const before = ledger.listInterventions({ nodeId: 'dw-hook-1', limit: 50 }).length
    recordDcwWriteOps(args)
    const after = ledger.listInterventions({ nodeId: 'dw-hook-1', limit: 50 }).length
    assert.equal(after, before, '同值 10s 去重内不重复落行')
    opsWriteMemo.clear()
  })
})
