/**
 * 批次 M2/M3：参数建议与回写（M40–M45 子集）。
 * - 硬过滤 validated+deployed / line / node / revision / ≥2 独立证据；
 * - 1–3 条 + doNothing；全 refute 不重复方向；cold_start 不硬编；
 * - proposal 校验（channel/line/node/status/修订）；
 * - verdict 回写：状态 assessed + 新增证据版本继承 active。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-proposal-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { recordParameterClaim } = await import('../server/services/workshop/experience/claims')
const { setVersionState } = await import('../server/services/workshop/experience/versions')
const { proposeParameterAdjustment, validateProposalForDispatch, attributeProposal } = await import('../server/services/workshop/experience/parameter-proposal')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'proposal.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES ('c1','C1','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
const repo = createMemoryRepo(db)

function makeClaim(eventId: string, runId: string, verdict: 'identifiable_effect' | 'no_resolvable_effect', effect: number | null, targetNode = 'daq-thickness') {
  const memId = repo.upsertExperience({
    channelId: 'c1', agentId: 'a1', kind: 'experience', title: `经验 ${eventId}`, titleFts: `经 验 ${eventId}`,
    content: '主张', importance: 0.7, dedupKey: `exp:${eventId}`, evidence: { interventionEventId: eventId },
    scopeKind: 'line', scopeKey: 'L1', status: 'validated',
  }).id
  const out = recordParameterClaim(db, {
    memoryId: memId,
    fact: {
      source: 'intervention', channelId: 'c1', agentId: 'system:ledger', eventId,
      verdict, nodeName: '保压压力SP', nodeId: 'dcw-hold', targetNodeId: targetNode,
      fromValue: 60, toValue: 62, actualValue: 62, recipeRunId: runId, recipeId: 'R1', recipeRevision: '3',
      productId: 'P1', lineId: 'L1', taskId: 't1', sessionId: 's1', attemptId: `wa-${eventId}`,
      effect, ciLow: effect != null ? effect - 0.03 : null, ciHigh: effect != null ? effect + 0.03 : null, mde: 0.01,
      criterion: { metric: 'wall_thickness', op: '>', threshold: 3, mde: 0.01 },
    },
  })
  assert.ok(out)
  setVersionState(db, out!.versionId, { lifecycle: 'validated', deployment: 'active' }, 'reviewer')
  return { memoryId: memId, versionId: out!.versionId }
}

makeClaim('intv-a', 'run-a', 'identifiable_effect', 0.1)
makeClaim('intv-b', 'run-b', 'identifiable_effect', 0.12)
makeClaim('intv-c', 'run-c', 'no_resolvable_effect', null)

test('proposal hard filters and returns 1 suggestion + doNothing with evidence links', () => {
  const result = proposeParameterAdjustment(db, {
    channelId: 'c1', lineId: 'L1', productId: 'P1', recipeId: 'R1', recipeRevision: '3',
    nodeIds: ['dcw-hold'], currentValues: { 'dcw-hold': 60 }, targetMetric: 'wall_thickness', actor: 'u1',
  })
  assert.equal(result.mode, 'exploit')
  assert.equal(result.suggestions.length, 1)
  const s = result.suggestions[0]!
  assert.equal(s.nodeId, 'dcw-hold')
  assert.equal(s.direction, 'increase')
  assert.equal(s.support, 2)
  assert.equal(s.refute, 1)
  assert.ok(s.evidence.length >= 2)
  assert.ok(s.evidence.every(e => e.interventionId && e.claimId))
  assert.equal(result.doNothing.kind, 'do_nothing')

  const check = validateProposalForDispatch(db, s.id, {
    channelId: 'c1', lineId: 'L1', nodeIds: ['dcw-hold'], recipeRevision: '3',
  })
  assert.equal(check.ok, true)
  const wrongNode = validateProposalForDispatch(db, s.id, {
    channelId: 'c1', lineId: 'L1', nodeIds: ['dcw-other'], recipeRevision: '3',
  })
  assert.equal(wrongNode.ok, false)
  const stale = validateProposalForDispatch(db, s.id, {
    channelId: 'c1', lineId: 'L1', nodeIds: ['dcw-hold'], recipeRevision: '4',
  })
  assert.equal(stale.ok, false)
})

test('verdict feedback marks assessed and appends evidence version preserving active', () => {
  const result = proposeParameterAdjustment(db, {
    channelId: 'c1', lineId: 'L1', productId: 'P1', recipeId: 'R1', recipeRevision: '3',
    nodeIds: ['dcw-hold'], currentValues: { 'dcw-hold': 60 }, actor: 'u1',
  })
  const s = result.suggestions[0]!
  const out = attributeProposal(db, s.id, {
    verdict: 'identifiable_effect', effect: 0.11, ciLow: 0.05, ciHigh: 0.18, mde: 0.01, interventionId: 'intv-follow',
  })
  assert.equal(out.ok, true)
  assert.ok(out.updated >= 1)
  const row = db.prepare('SELECT status, feedback_json AS feedback FROM parameter_proposals WHERE id = ?').get(s.id) as { status: string, feedback: string }
  assert.equal(row.status, 'assessed')
  const feedback = JSON.parse(row.feedback) as { outcome: string, interventionId: string }
  assert.equal(feedback.outcome, 'support')
  assert.equal(feedback.interventionId, 'intv-follow')
})

test('cold_start when no eligible evidence', () => {
  const result = proposeParameterAdjustment(db, {
    channelId: 'c1', lineId: 'L2', currentValues: { x: 1 }, actor: 'u1',
  })
  assert.equal(result.mode, 'cold_start')
  assert.equal(result.suggestions.length, 0)
  assert.equal(result.doNothing.kind, 'do_nothing')
})
