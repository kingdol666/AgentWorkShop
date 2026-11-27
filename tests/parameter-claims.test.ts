/**
 * 批次 M：结构化参数主张（M39/M43/M51）。
 *  - 干预判定 → 结构化 claim + 不可变版本 + 证据回指；
 *  - 追加证据继承 head 的 lifecycle/deployment（不得把 validated/active 打回 candidate/none）；
 *  - 查询可按 line/product/node/revision/verdict 过滤；deployedOnly 只返回已部署；
 *  - 参数手册只汇总结构化主张。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-param-claims-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { recordParameterClaim, queryParameterExperience, buildParameterHandbook } = await import('../server/services/workshop/experience/claims')
const { getVersion, setVersionState } = await import('../server/services/workshop/experience/versions')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'param.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
  VALUES ('c1','C1','','','','{}',1,1,'L1',?,?)`).run(now, now)
const repo = createMemoryRepo(db)

const fact = {
  source: 'intervention' as const,
  channelId: 'c1',
  agentId: 'system:ledger',
  eventId: 'intv-1',
  verdict: 'identifiable_effect' as const,
  nodeName: '保压压力SP',
  nodeId: 'dcw-hold',
  targetNodeId: 'daq-thickness',
  fromValue: 60,
  toValue: 62,
  actualValue: 62,
  recipeRunId: 'run-1',
  recipeId: 'R1',
  recipeRevision: '3',
  productId: 'P1',
  lineId: 'L1',
  taskId: 'task-1',
  sessionId: 's-1',
  attemptId: 'wat-1',
  effect: 0.42,
  ciLow: 0.3,
  ciHigh: 0.54,
  mde: 0.1,
  criterion: { metric: 'wall_thickness', op: '>', threshold: 3.1, mde: 0.1 },
}

function makeExperience(key: string) {
  return repo.upsertExperience({
    channelId: 'c1',
    agentId: 'a1',
    kind: 'experience',
    title: '保压压力上调提升壁厚',
    titleFts: '保 压 压 力 上 调 提 升 壁 厚',
    content: '保压压力上调 2MPa 后壁厚上升',
    importance: 0.7,
    taskId: 'task-1',
    sessionId: 's-1',
    dedupKey: key,
    outcome: 'positive',
    evidence: { taskIds: ['task-1'], interventionEventId: 'intv-1' },
    scopeKind: 'line',
    scopeKey: 'L1',
    status: 'candidate',
  }).id
}

test('intervention verdict becomes a structured claim with evidence links', () => {
  const memoryId = makeExperience('exp:int:intv-1')
  const out = recordParameterClaim(db, { memoryId, fact })
  assert.ok(out?.claimId)
  const row = db.prepare('SELECT * FROM experience_claims WHERE memory_id = ?').get(memoryId) as Record<string, unknown>
  assert.equal(row.node_id, 'dcw-hold')
  assert.equal(row.verdict, 'identifiable_effect')
  assert.equal(row.polarity, 'support')
  assert.equal(row.effect, 0.42)
  assert.equal(row.intervention_id, 'intv-1')
  assert.equal(row.claim_status, 'structured')
  assert.equal(row.recipe_revision, '3')
  assert.ok(String(row.version_id).startsWith('ev-'))
  assert.ok(getVersion(db, String(row.version_id)))

  const items = queryParameterExperience(db, { lineId: 'L1', productId: 'P1', nodeId: 'dcw-hold', scopeChannelIds: ['c1'], scopeLineIds: ['L1'] })
  assert.equal(items.length, 1)
  assert.equal(items[0]!.interventionId, 'intv-1')
  assert.equal(items[0]!.memoryStatus, 'candidate')
  assert.equal(items[0]!.deployment, 'none')
})

test('appending evidence preserves validated/active head state', () => {
  const memoryId = makeExperience('exp:int:intv-2')
  const first = recordParameterClaim(db, { memoryId, fact: { ...fact, eventId: 'intv-2' } })
  assert.ok(first?.versionId)
  setVersionState(db, first!.versionId, { lifecycle: 'validated', deployment: 'active' }, 'reviewer')
  db.prepare(`UPDATE agent_memories SET status = 'validated' WHERE id = ?`).run(memoryId)

  const second = recordParameterClaim(db, { memoryId, fact: { ...fact, eventId: 'intv-3' } })
  assert.ok(second?.versionId)
  const version = getVersion(db, second!.versionId)!
  assert.equal(version.lifecycle, 'validated', '追加证据不得把 validated 打回 candidate')
  assert.equal(version.deployment, 'active', '追加证据不得把 active 打回 none')

  const deployed = queryParameterExperience(db, { lineId: 'L1', deployedOnly: true, scopeChannelIds: ['c1'], scopeLineIds: ['L1'] })
  assert.ok(deployed.length >= 1)
  assert.ok(deployed.every(i => i.deployment === 'active' || i.deployment === 'canary'))
})

test('parameter handbook is structured and cites interventions', () => {
  const handbook = buildParameterHandbook(db, { lineId: 'L1', scopeChannelIds: ['c1'], scopeLineIds: ['L1'] })
  assert.ok(handbook.claimCount >= 1)
  assert.ok(handbook.markdown.includes('## 1. 当前推荐'))
  assert.ok(handbook.markdown.includes('## 6. 来源'))
  assert.ok(handbook.markdown.includes('intervention='))
  assert.ok(handbook.sourceCount >= 1)
})
