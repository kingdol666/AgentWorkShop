/**
 * 配方证据链（WP-D1）：analysis_reports.recipe_run_id 外键回路 + verdict→成效聚合 + 渲染。
 * 纯内存库；dcw 运行态（JSON 仓储）不在本测范围（由 getRecipeEvidence 的容错兜底覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-d1-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createAnalysisRepo } = await import('../server/services/workshop/analysis/analysis.repo')
const { formatRecipeEvidence, recipeRunOutcome } = await import('../server/services/workshop/dcw/recipe-evidence')

const now = new Date().toISOString()

function fixture() {
  const db = openWorkshopDb(':memory:')
  return { db, repo: createAnalysisRepo(db) }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ar-1', lineId: 'line-1', lineName: 'L1', title: '整定分析', category: 'general',
    summary: 'IAE 下降', conclusions: ['ok'], report: '', metrics: {}, recipeId: 'rc-1', recipeVersion: '3',
    recipeRunId: 'run-9', windowFrom: null, windowTo: null, dataSources: '', context: {},
    channelId: 'ch-1', channelName: 'C', actor: 'agent-a', actorName: 'A', createdAt: now,
    ...overrides,
  }
}

test('analysis_reports.recipe_run_id 往返：写入可读回，空串缺省', () => {
  const { db, repo } = fixture()
  try {
    repo.insert(input())
    const row = repo.get('ar-1')!
    assert.equal((row as unknown as { recipeRunId: string }).recipeRunId, 'run-9', '外键列往返')

    repo.insert(input({ id: 'ar-2', recipeRunId: undefined }))
    const row2 = repo.get('ar-2')!
    assert.equal((row2 as unknown as { recipeRunId: string }).recipeRunId, '', '未关联 → 空串')
  }
  finally {
    db.close()
  }
})

test('verdict → 成效聚合：improved / no_effect / inconclusive / unassessed', () => {
  const iv = (verdict: string, effect: number | null = null) => ({
    eventId: `e-${verdict}-${effect}`, nodeName: 'n', fromValue: null, toValue: null, actualValue: null,
    ack: 'readback-verified', path: 'recipe', verdict, effect, ciLow: null, ciHigh: null, mde: null,
    criterion: null, hypothesis: '',
  })
  assert.equal(recipeRunOutcome([]), 'unassessed')
  assert.equal(recipeRunOutcome([iv('pending')]), 'unassessed')
  assert.equal(recipeRunOutcome([iv('identifiable_effect', -1.2)]), 'improved')
  assert.equal(recipeRunOutcome([iv('identifiable_effect', 0)]), 'inconclusive', '零效应不算 improved')
  assert.equal(recipeRunOutcome([iv('no_resolvable_effect')]), 'no_effect')
  assert.equal(recipeRunOutcome([iv('underpowered')]), 'inconclusive')
  assert.equal(recipeRunOutcome([iv('confounded')]), 'inconclusive')
  // 混合：只要有一条显著正效应即 improved（配方整批的意义在于整体改善）
  assert.equal(recipeRunOutcome([iv('underpowered'), iv('identifiable_effect', 0.4)]), 'improved')
})

test('证据链渲染：批次头/成效/干预判定/关联分析齐全；空链返回空串', () => {
  assert.equal(formatRecipeEvidence([]), '')
  const text = formatRecipeEvidence([{
    runId: 'run-12345678', recipeId: 'rc-1', recipeName: 'R', recipeVersion: '3',
    startedAt: '2026-11-09T01:02:03.000Z', endedAt: '2026-11-09T01:30:00.000Z',
    ackSummary: { verified: 3, unverified: 0, failed: 0, total: 3 },
    params: [{ nodeId: 'n-1', value: 218.5, ok: true, ack: 'readback-verified' }],
    interventions: [{
      eventId: 'ie-1', nodeName: '均热段', fromValue: 220, toValue: 218.5, actualValue: 218.52,
      ack: 'readback-verified', path: 'recipe', verdict: 'identifiable_effect', effect: -1.48,
      ciLow: -2.1, ciHigh: -0.8, mde: 0.6, criterion: { metric: 'iae', op: '<', threshold: 12 }, hypothesis: 'h',
    }],
    reports: [{ id: 'ar-1', title: '整定分析', summary: 'IAE 下降 12%', createdAt: now }],
    outcome: 'improved',
  }])
  assert.match(text, /配方证据链/)
  assert.match(text, /批次 run-12345678/)
  assert.match(text, /成效=improved/)
  assert.match(text, /ACK verified=3/)
  assert.match(text, /均热段 220→218\.5 回读=218\.52 ACK=readback-verified 判定=identifiable_effect effect=-1\.48 CI\[-2\.1, -0\.8\] MDE=0\.6/)
  assert.match(text, /分析「整定分析」/)
})
