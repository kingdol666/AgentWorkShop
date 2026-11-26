/**
 * 记忆分区规则表：SQL 编译器 ↔ JS 求值器 差分测试。
 *
 * 目的：`compileScopeWhere` 与 `rowMatchesTier` 是同一张 SCOPE_RULES 的两种编译产物。
 * 任何一侧单独改动都会在这里被"集合不相等"抓出来（M1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryCtx } from '../server/services/workshop/runtime/memory/memory-scopes'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-scopes-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { compileScopeWhere, rowMatchesTier } = await import('../server/services/workshop/runtime/memory/memory-scopes')

const now = new Date().toISOString()

function seed() {
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
    VALUES ('c1','C1','','','','{}',1,1,'L1','u1',?,?)`).run(now, now)
  db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
    VALUES ('c2','C2','','','','{}',1,1,'','u2',?,?)`).run(now, now)
  const repo = createMemoryRepo(db)
  const mk = (dedupKey: string, input: Partial<Parameters<typeof repo.upsert>[0]> & { channelId?: string, agentId?: string }) =>
    repo.upsert({
      channelId: input.channelId ?? 'c1',
      agentId: input.agentId ?? 'a1',
      kind: input.kind ?? 'semantic',
      title: dedupKey,
      titleFts: dedupKey,
      content: dedupKey,
      importance: 0.5,
      dedupKey,
      ownerUserId: input.ownerUserId,
      sessionId: input.sessionId ?? '',
    }).id

  const priv = mk('r-private', { sessionId: 's1' })
  const team = mk('r-team', { agentId: '__team__', sessionId: 's1' })
  const ws = mk('r-workspace', { channelId: 'c1', agentId: 'x1' })
  const wsOther = mk('r-workspace-other', { channelId: 'c1', agentId: 'x1' })
  const deleted = mk('r-deleted', { sessionId: 's1' })
  const otherChannel = mk('r-other-channel', { channelId: 'c2', agentId: 'a1', sessionId: 's1' })
  const lineExp = repo.upsertExperience({
    channelId: 'c1', agentId: 'a1', kind: 'experience', title: 'r-line', titleFts: 'r-line', content: 'r-line',
    importance: 0.5, dedupKey: 'r-line', evidence: { taskIds: ['t1'] }, scopeKind: 'line', scopeKey: 'L1', status: 'validated',
  }).id
  const prodExp = repo.upsertExperience({
    channelId: 'c1', agentId: 'a1', kind: 'experience', title: 'r-product', titleFts: 'r-product', content: 'r-product',
    importance: 0.5, dedupKey: 'r-product', evidence: { taskIds: ['t2'] }, scopeKind: 'product', scopeKey: 'P1', status: 'validated',
  }).id

  // 显式归属/作用域（repo 会从 channel 解析 owner，这里覆盖成矩阵需要的值）
  db.prepare(`UPDATE agent_memories SET scope_kind='global', scope_key='' WHERE id=?`).run(ws)
  db.prepare(`UPDATE agent_memories SET scope_kind='global', scope_key='', owner_user_id='u2' WHERE id=?`).run(wsOther)
  db.prepare(`UPDATE agent_memories SET deleted_at=? WHERE id=?`).run(now, deleted)
  for (const id of [priv, team, deleted]) db.prepare(`UPDATE agent_memories SET owner_user_id='u1' WHERE id=?`).run(id)
  db.prepare(`UPDATE agent_memories SET owner_user_id='u2' WHERE id=?`).run(otherChannel)
  // line 经验：已部署 active；product 经验：无版本头（fail-closed，不可自动注入）
  db.prepare(`INSERT INTO experience_versions
    (version_id, experience_id, claim_origin_id, scope_kind, scope_key, claim_json, content, content_hash,
     evidence_json, evidence_snapshot_hash, lifecycle, deployment, claim_origin_time, beta_ancestors_json, idempotency_key, created_at)
    VALUES ('ev-line','${lineExp}','co-line','line','L1','{}','r-line','h1','[]','h2','validated','active',?,'[]','idem-line',?)`).run(now, now)
  db.prepare(`INSERT INTO experience_heads(experience_id, version_id, updated_at) VALUES (?, 'ev-line', ?)`).run(lineExp, now)
  return { db, repo, ids: { priv, team, ws, wsOther, deleted, otherChannel, lineExp, prodExp } }
}

const ctx: MemoryCtx = {
  ownerUserId: 'u1',
  channelId: 'c1',
  sessionId: 's1',
  agentId: 'a1',
  lineIds: ['L1'],
  productIds: ['P1'],
  industrial: true,
  automatic: true,
  crossChannel: false,
}

test('差分：8 个 tier 的 SQL 结果集与 JS 求值完全一致', () => {
  const { db, repo } = seed()
  try {
    const rows = db.prepare(`SELECT m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.session_id AS sessionId,
      m.scope_kind AS scopeKind, m.scope_key AS scopeKey, m.kind, m.status, m.deleted_at AS deletedAt, m.owner_user_id AS ownerUserId
      FROM agent_memories m`).all() as Array<Record<string, unknown>>
    const deploymentOf = (id: string) => repo.experienceDeployment(id)
    for (const tier of ['private', 'shared', 'session', 'workspace', 'line', 'product', 'auto', 'all'] as const) {
      const compiled = compileScopeWhere(tier, ctx)
      const sqlIds = (db.prepare(`SELECT m.id FROM agent_memories m WHERE ${compiled.sql}`).all(...compiled.params) as Array<{ id: string }>)
        .map(r => r.id).sort()
      const jsIds = rows.filter(r => rowMatchesTier(r as never, ctx, tier, deploymentOf)).map(r => String(r.id)).sort()
      assert.deepEqual(sqlIds, jsIds, `tier=${tier} 两侧集合不一致\nSQL=${sqlIds.join(',')}\nJS=${jsIds.join(',')}`)
    }
  }
  finally {
    db.close()
  }
})

test('边界：owner 隔离 / 未部署经验不注入 / tombstone 不参与 / 非工业频道排除跨域经验', () => {
  const { db, repo, ids } = seed()
  try {
    const rows = db.prepare(`SELECT m.id, m.channel_id AS channelId, m.agent_id AS agentId, m.session_id AS sessionId,
      m.scope_kind AS scopeKind, m.scope_key AS scopeKey, m.kind, m.status, m.deleted_at AS deletedAt, m.owner_user_id AS ownerUserId
      FROM agent_memories m`).all() as Array<Record<string, unknown>>
    const dep = (id: string) => repo.experienceDeployment(id)
    // workspace：只匹配 u1 的 global 行
    assert.deepEqual(rows.filter(r => rowMatchesTier(r as never, ctx, 'workspace', dep)).map(r => r.id), [ids.ws])
    // line：已部署 validated 经验命中
    assert.ok(rows.filter(r => rowMatchesTier(r as never, ctx, 'line', dep)).some(r => r.id === ids.lineExp))
    // product：无版本头 → 部署 none → 自动注入不可见
    assert.equal(rows.filter(r => rowMatchesTier(r as never, ctx, 'product', dep)).some(r => r.id === ids.prodExp), false)
    // tombstone 任何档位都不可见
    assert.equal(rows.filter(r => rowMatchesTier(r as never, ctx, 'all', dep)).some(r => r.id === ids.deleted), false)
    // 非工业频道：line/product/global 经验一律排除
    const nonIndustrial = { ...ctx, industrial: false }
    assert.equal(rows.filter(r => rowMatchesTier(r as never, nonIndustrial, 'all', dep)).some(r => r.id === ids.lineExp), false)
  }
  finally {
    db.close()
  }
})

test('共享区自动注入：top-N 截断（默认 3），跨 Channel 可见且只取本 owner', async () => {
  const prev = process.env.AW_MEMORY_SHARED_TOP_N
  process.env.AW_MEMORY_SHARED_TOP_N = '2'
  const db = openWorkshopDb(':memory:')
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, created_at, updated_at)
      VALUES ('c1','C1','','','','{}',1,1,'','u1',?,?)`).run(now, now)
    const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
    const repo = createMemoryRepo(db)
    for (let i = 0; i < 5; i += 1) {
      const id = repo.upsert({
        channelId: `src-${i}`,
        agentId: 'x',
        kind: 'semantic',
        title: `共享经验 ${i}`,
        titleFts: `共 享 经 验 ${i}`,
        content: `共享经验内容 ${i}`,
        importance: 0.8,
        dedupKey: `shared-${i}`,
        ownerUserId: 'u1',
      }).id
      db.prepare(`UPDATE agent_memories SET scope_kind='global' WHERE id=?`).run(id)
    }
    // 他人 owner 的共享行不得出现
    const otherId = repo.upsert({
      channelId: 'src-x', agentId: 'x', kind: 'semantic', title: '共享经验 9', titleFts: '共 享 经 验 9',
      content: '别人的共享经验', importance: 0.8, dedupKey: 'shared-9', ownerUserId: 'u2',
    }).id
    db.prepare(`UPDATE agent_memories SET scope_kind='global' WHERE id=?`).run(otherId)

    const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', ownerUserId: 'u1' })
    const text = await mem.recall('共享 经验')
    assert.ok(text, '共享区块应产生注入内容')
    const hits = (text!.match(/共享区/g) ?? []).length
    assert.equal(hits, 2, `top-N=2 时只注入 2 条（实际 ${hits}）`)
    assert.equal(text!.includes('别人的共享经验'), false, '他人 owner 的共享行不得注入')
  }
  finally {
    db.close()
    if (prev === undefined) delete process.env.AW_MEMORY_SHARED_TOP_N
    else process.env.AW_MEMORY_SHARED_TOP_N = prev
  }
})
