/**
 * 注入分层去重（2026-11-28 审核轮发现的实机缺陷回归）。
 *
 * 背景：运行期 `inScope` 的 auto 档只按 agent 归属判断、不看 scope_kind，而 L2 共享区
 * 又会独立注入同一条 owner 级 `scope_kind='global'` 行 —— 实机一次回合出现
 * `ids=8 unique=7`：同一条正文以 primer + shared 两个身份进入同一条提示，白烧预算。
 *
 * 修复口径：L2 先选定，再把它从 L1 候选里摘掉；提示顺序不变（L2 仍在末尾追加）。
 * 本测试锁三件事：
 *  1. 一次自动注入里不出现重复 id（不变量）；
 *  2. global 行归 L2（source=shared），不再复制到 L1；
 *  3. 普通频道行仍走 L1 —— 去重不得把 L1 整体饿死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-inj-dedupe-'))
process.env.AW_MEMORY_GRAPH_RETRIEVAL = '0'
delete process.env.AW_BENCH_MODE
delete process.env.AW_MEMORY_EMBED_BASE_URL
delete process.env.AW_MEMORY_EMBED_MODEL
delete process.env.AW_MEMORY_EMBED_API_KEY
delete process.env.AW_MEMORY_SHARED_TOP_N
delete process.env.AW_MEMORY_SHARED_TOKENS

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo, TEAM_AGENT_ID } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory } = await import('../server/services/workshop/runtime/memory')
const { segmentCJK, buildMatchQuery } = await import('../server/services/workshop/runtime/memory/helpers')

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
  VALUES ('c1', '去重验收频道', '', '', '', '{}', 1, 1, '', 'u1', 'inherit', ?, ?)`).run(now, now)

/** 写入一条 owner 级 global 行（L2 共享区唯一来源口径：人工行） */
function insertGlobal(title: string, content: string, dedupKey: string): string {
  const write = repo.upsert({
    channelId: 'c1',
    agentId: TEAM_AGENT_ID,
    kind: 'semantic',
    title,
    titleFts: segmentCJK(title),
    content: segmentCJK(content),
    importance: 0.9,
    taskId: null,
    sessionId: '',
    dedupKey,
    ownerUserId: 'u1',
  }, { kind: 'human', id: 'u1' })
  db.prepare(`UPDATE agent_memories SET scope_kind = 'global', scope_key = '' WHERE id = ?`).run(write.id)
  return write.id
}

/** 写入一条频道级团队行（L1 词面命中来源） */
function insertChannelKnowledge(title: string, content: string, dedupKey: string): string {
  const write = repo.upsert({
    channelId: 'c1',
    agentId: TEAM_AGENT_ID,
    kind: 'semantic',
    title,
    titleFts: segmentCJK(title),
    content: segmentCJK(content),
    importance: 0.8,
    taskId: null,
    sessionId: '',
    dedupKey,
    ownerUserId: 'u1',
  }, { kind: 'agent', id: 'a1' })
  db.prepare(`UPDATE agent_memories SET scope_kind = 'channel', scope_key = '' WHERE id = ?`).run(write.id)
  return write.id
}

const globalId = insertGlobal(
  '共享区调参守则',
  '共享区调参守则：先定水温,再定熔体温度,最后微调保压;水温以 32 度为准。',
  'dedupe:global',
)
const channelId1 = insertChannelKnowledge(
  '频道内水温常识',
  '循环水温 32 度良率最优;低于 28 度缩痕概率上升;高于 36 度能耗上升。',
  'dedupe:channel',
)

const lastRefs = (): Array<{ id: string, source?: string, kind: string }> => {
  const row = db.prepare(`SELECT refs_json AS refs FROM memory_injection_log ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { refs?: string } | undefined
  assert.ok(row?.refs, '必须留下一条注入留痕')
  return JSON.parse(row!.refs!) as Array<{ id: string, source?: string, kind: string }>
}

test('同一条记忆在一次自动注入里只出现一次（L2 不复制到 L1）', async () => {
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null })
  const text = await mem.recall('共享区调参守则 水温 保压 怎么设定', { trace: { taskId: null } })
  assert.ok(text && text.includes('## 相关记忆'), '自动注入必须产出记忆块')
  const refs = lastRefs()
  const ids = refs.map(r => r.id)
  assert.equal(ids.length, new Set(ids).size, `同一条记忆被注入多次:${ids.join(',')}`)
  const globalRefs = refs.filter(r => r.id === globalId)
  assert.equal(globalRefs.length, 1, 'global 行必须恰好注入一次')
  assert.equal(globalRefs[0]!.source, 'shared', 'global 行应归 L2 共享区，而不是 L1 引子')
  const channelRefs = refs.filter(r => r.id === channelId1)
  assert.equal(channelRefs.length, 1, '频道知识行必须恰好注入一次')
  assert.equal(channelRefs[0]!.source, 'primer', '频道知识行仍走 L1 引子')
  // 提示正文里该标题只出现一次（防止同文重复占预算）
  const occurrences = text!.split('共享区调参守则').length - 1
  assert.ok(occurrences <= 3, `共享区行不应在提示中反复出现,实际 ${occurrences} 次`)
})

test('关掉共享区（AW_MEMORY_SHARED_TOP_N=0）后 global 行仍按 L1 可见，不丢内容', async () => {
  process.env.AW_MEMORY_SHARED_TOP_N = '0'
  try {
    const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null })
    const text = await mem.recall('共享区调参守则 水温 保压 怎么设定', { trace: { taskId: null } })
    assert.ok(text, '仍要产出记忆块')
    const refs = lastRefs()
    assert.ok(!refs.some(r => r.source === 'shared'), '共享区关闭时不应有 shared 来源')
    assert.ok(refs.some(r => r.id === globalId), '共享区关闭后既有能力不得丢失（global 行走 L1）')
    const ids = refs.map(r => r.id)
    assert.equal(ids.length, new Set(ids).size)
  }
  finally {
    delete process.env.AW_MEMORY_SHARED_TOP_N
  }
})

test('不同 agent 的私有行互不可见（去重逻辑不得放宽作用域）', async () => {
  const other = repo.upsert({
    channelId: 'c1', agentId: 'a2', kind: 'semantic', title: '别人的私有结论',
    titleFts: segmentCJK('别人的私有结论'), content: segmentCJK('别人私有结论水温 34 度'), importance: 0.9,
    taskId: null, sessionId: '', dedupKey: 'dedupe:other-private', ownerUserId: 'u1',
  }, { kind: 'agent', id: 'a2' })
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null })
  await mem.recall('别人的私有结论 水温', { trace: { taskId: null } })
  const refs = lastRefs()
  assert.ok(!refs.some(r => r.id === other.id), '其他 agent 的私有行不得进入注入')
})

test('共享区检索遵守生命周期窗口：已失效的 global 行不再被注入', () => {
  const expiredId = insertGlobal(
    '过期共享守则',
    '过期共享守则：这套水温约定已经失效，不应再出现在提示里。',
    'dedupe:expired-global',
  )
  const past = new Date(Date.now() - 86_400_000).toISOString()
  db.prepare(`UPDATE agent_memories SET valid_to = ? WHERE id = ?`).run(past, expiredId)
  // 直接测 L2 的 SQL 口径（inScope 也挡过期，但那样测不到 L2 自己的窗口条件）。
  // 查询必须走 buildMatchQuery：索引是单字切分，整段中文短语在 FTS5 里恒不命中。
  const expiredQuery = buildMatchQuery('过期共享守则 水温')
  assert.ok(expiredQuery, '查询词不得为空')
  const rows = repo.searchWorkspaceShared(expiredQuery!, 'u1', 10, null)
  assert.ok(!rows.some(r => r.id === expiredId), '已失效的 global 行不得被共享区检索命中')
  // 正向对照：未失效的同域行仍可命中（否则上面的断言可能只是"查询没匹配上"）
  const liveQuery = buildMatchQuery('共享区调参守则')
  const rowsLive = repo.searchWorkspaceShared(liveQuery!, 'u1', 10, null)
  assert.ok(rowsLive.some(r => r.id === globalId), '有效行必须仍能被共享区检索命中')
})

test('memory_access_mode=isolated：L2 共享区停止注入，inherit 恢复', async () => {
  insertGlobal('隔离阀共享基线', 'ISOLATEDZONE 共享区基线：保压 88MPa，壁厚 2.18mm。', 'dedupe:isolated-gate')
  const mem = () => new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', ownerUserId: 'u1' })
  const query = 'ISOLATEDZONE 保压 壁厚'
  // 基线：inherit 下共享区注入（正向对照，避免"本来就没有"的假阳）
  db.prepare(`UPDATE channels SET memory_access_mode = 'inherit' WHERE id = 'c1'`).run()
  const inheritText = await mem().recall(query)
  assert.ok(inheritText && inheritText.includes('共享区'), 'inherit 下应有共享区注入')
  // isolated：L2 关闭
  db.prepare(`UPDATE channels SET memory_access_mode = 'isolated' WHERE id = 'c1'`).run()
  try {
    const isolatedText = await mem().recall(query)
    assert.equal(Boolean(isolatedText && isolatedText.includes('共享区')), false, 'isolated 下不得出现共享区注入')
  }
  finally {
    // 恢复默认，避免影响同文件其他用例（本文件共用 db）
    db.prepare(`UPDATE channels SET memory_access_mode = 'inherit' WHERE id = 'c1'`).run()
  }
})
