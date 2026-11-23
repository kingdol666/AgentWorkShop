/**
 * 经验条目重放不变量（2026-11-23 发版审查）。
 *
 * dedup_key 是来源键（`exp:task:<id>` 等）、不含内容哈希：同一任务重跑会产出新正文。
 * validated/retired 是人工策展结果，重放只能刷新证据计数一类的非策展字段，
 * 不得改写正文/标题/结论/范围/权重，也不得把状态打回 candidate。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-experience-replay-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')

function fixture() {
  const db = openWorkshopDb(':memory:')
  return { db, repo: createMemoryRepo(db) }
}

const base = {
  channelId: 'ch-1',
  agentId: 'agent-a',
  kind: 'experience',
  dedupKey: 'exp:task:t-1',
  scopeKind: 'line',
  scopeKey: 'line-1',
} as const

test('validated 行重放:正文/标题/结论/范围/权重全部保持策展值', (t) => {
  const f = fixture()
  t.after(() => f.db.close())
  const id = f.repo.upsertExperience({
    ...base,
    title: '均热段整定',
    titleFts: '均 热 段 整 定',
    content: '温差 ±3℃',
    importance: 0.8,
    outcome: 'positive',
    evidence: { taskIds: ['t-1', 't-2'] },
    status: 'validated',
    expiresAt: null,
  } as never).id

  f.repo.upsertExperience({
    ...base,
    title: '重放后的新标题',
    titleFts: '重 放 后 的 新 标 题',
    content: '完全不同的一段话',
    importance: 0.2,
    outcome: 'negative',
    evidence: { taskIds: ['t-1'] },
    status: 'candidate',
    expiresAt: null,
  } as never)

  const row = f.repo.getById(id) as Record<string, unknown>
  assert.equal(row.title, '均热段整定')
  assert.equal(row.content, '温差 ±3℃')
  assert.equal(row.outcome, 'positive')
  assert.equal(row.scopeKey, 'line-1')
  assert.equal(Number(row.importance), 0.8)
  assert.equal(row.status, 'validated', '受保护状态不得被打回 candidate')
  assert.deepEqual(JSON.parse(String(row.evidenceJson)).taskIds, ['t-1', 't-2'], '证据同样不得被重放改写')
})

test('candidate 行重放:正文与状态随最新一次蒸馏刷新', (t) => {
  const f = fixture()
  t.after(() => f.db.close())
  const id = f.repo.upsertExperience({
    ...base,
    title: '初版结论',
    titleFts: '初 版 结 论',
    content: '第一次蒸馏',
    importance: 0.5,
    outcome: 'positive',
    evidence: { taskIds: ['t-1'] },
    status: 'candidate',
    expiresAt: null,
  } as never).id

  f.repo.upsertExperience({
    ...base,
    title: '二次结论',
    titleFts: '二 次 结 论',
    content: '第二次蒸馏',
    importance: 0.7,
    outcome: 'negative',
    evidence: { taskIds: ['t-1', 't-2'] },
    status: 'candidate',
    expiresAt: null,
  } as never)

  const row = f.repo.getById(id) as Record<string, unknown>
  assert.equal(row.title, '二次结论')
  assert.equal(row.content, '第二次蒸馏')
  assert.equal(row.outcome, 'negative')
  assert.equal(Number(row.importance), 0.7)
})
