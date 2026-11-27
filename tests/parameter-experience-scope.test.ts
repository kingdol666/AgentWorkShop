/**
 * 参数经验作用域隔离（2026-11-28 审核轮 P0 回归）。
 *
 * 缺陷：`experience_claims` 没有 channel 列，`queryParameterExperience` 只按主张级条件
 * 过滤。REST `/channels/:id/parameter-experience` 只校验「URL 频道归你」，查询本体不带
 * 任何频道/owner 条件，SELECT 又直接带出 `agent_memories.title/content` —— 任意外部
 * 入口都能读到全库所有 owner 的经验正文。
 *
 * 修复口径（fail-closed）：
 *  - 频道档主张（无 line/product 锚点）只来自 `scopeChannelIds`；
 *  - 产线/产品档按白名单锚点跨频道共享（RLS 语义）；
 *  - 三个白名单全缺 → `(1=0)`，忘传不会退化成"查全库"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-param-scope-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { recordParameterClaim, queryParameterExperience } = await import('../server/services/workshop/experience/claims')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'param-scope.sqlite'))
configureAmlRuntime(db)
const now = new Date().toISOString()
const insertChannel = db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
  VALUES (?,?,'','','','{}',1,1,?,?,?,?)`)
insertChannel.run('c1', 'C1', 'L1', 'u1', now, now)
insertChannel.run('c2', 'C2', 'L2', 'u2', now, now)
const repo = createMemoryRepo(db)

/** 造一条经验行 + 一条结构化主张；scopeKind/scopeKey 决定 claim 的 line_id/product_id */
function seedClaim(opts: {
  channelId: string
  agentId: string
  lineId: string
  productId: string
  key: string
}): string {
  const memoryId = repo.upsertExperience({
    channelId: opts.channelId,
    agentId: opts.agentId,
    kind: 'experience',
    title: `参数经验 ${opts.key}`,
    titleFts: `参 数 经 验 ${opts.key}`,
    content: `参数经验正文 ${opts.key}`,
    importance: 0.7,
    taskId: `task-${opts.key}`,
    sessionId: '',
    dedupKey: `exp:scope:${opts.key}`,
    outcome: 'positive',
    evidence: { taskIds: [`task-${opts.key}`], interventionEventId: `intv-${opts.key}` },
    scopeKind: opts.lineId ? 'line' : 'channel',
    scopeKey: opts.lineId,
    status: 'candidate',
  }).id
  recordParameterClaim(db, {
    memoryId,
    fact: {
      source: 'intervention',
      channelId: opts.channelId,
      agentId: opts.agentId,
      eventId: `intv-${opts.key}`,
      verdict: 'identifiable_effect',
      nodeName: `节点-${opts.key}`,
      nodeId: `node-${opts.key}`,
      targetNodeId: '',
      fromValue: 60,
      toValue: 62,
      actualValue: 62,
      recipeRunId: `run-${opts.key}`,
      recipeId: 'R1',
      recipeRevision: '3',
      productId: opts.productId,
      lineId: opts.lineId,
      taskId: `task-${opts.key}`,
      sessionId: 's-1',
      attemptId: `wat-${opts.key}`,
      effect: 0.4,
      ciLow: 0.2,
      ciHigh: 0.6,
      mde: 0.1,
      criterion: { metric: 'wall_thickness', op: '>', threshold: 3.1, mde: 0.1 },
    },
  })
  return memoryId
}

const ownLine = seedClaim({ channelId: 'c1', agentId: 'a1', lineId: 'L1', productId: 'P1', key: 'own-line' })
const foreignLine = seedClaim({ channelId: 'c2', agentId: 'a2', lineId: 'L2', productId: 'P2', key: 'foreign-line' })
const foreignChannel = seedClaim({ channelId: 'c2', agentId: 'a2', lineId: '', productId: '', key: 'foreign-channel' })

const ids = (items: Array<{ memoryId: string }>): string[] => items.map(i => i.memoryId)

test('fail-closed：三个作用域白名单全缺时一条都不返回', () => {
  const items = queryParameterExperience(db, { limit: 50 })
  assert.equal(items.length, 0, `无作用域时必须空集，实际 ${items.length}`)
})

test('频道隔离：只读本频道 + 本频道绑定产线，读不到其他 owner 的经验', () => {
  const items = queryParameterExperience(db, { scopeChannelIds: ['c1'], scopeLineIds: ['L1'], limit: 50 })
  const got = ids(items)
  assert.deepEqual(got, [ownLine], `只应有本频道/本产线主张，实际 ${got.join(',')}`)
  assert.ok(!got.includes(foreignLine), '其他频道的产线经验不得出现')
  assert.ok(!got.includes(foreignChannel), '其他频道的频道档主张不得出现')
})

test('产线档按锚点跨频道共享（RLS 语义），频道档仍不外溢', () => {
  const items = queryParameterExperience(db, { scopeChannelIds: ['c1'], scopeLineIds: ['L1', 'L2'], limit: 50 })
  const got = ids(items)
  assert.ok(got.includes(ownLine))
  assert.ok(got.includes(foreignLine), '同产线经验应可跨频道读')
  assert.ok(!got.includes(foreignChannel), '频道档主张不随产线白名单外溢')
})

test('其他 owner 的频道只在自己的作用域里可见（正向对照）', () => {
  const items = queryParameterExperience(db, { scopeChannelIds: ['c2'], scopeLineIds: ['L2'], limit: 50 })
  const got = ids(items)
  assert.ok(got.includes(foreignLine))
  assert.ok(got.includes(foreignChannel), '本频道的频道档主张对本频道可见')
  assert.ok(!got.includes(ownLine))
})

test('主张自带 channelId，供工具侧二次校验', () => {
  const items = queryParameterExperience(db, { scopeChannelIds: ['c1'], scopeLineIds: ['L1'], limit: 50 })
  assert.equal(items[0]?.channelId, 'c1')
})
