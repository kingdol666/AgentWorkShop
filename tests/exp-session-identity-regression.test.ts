import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateAnchorsToEpisodes, collectEpisodes } from '../server/services/workshop/exp/exp-collector'
import { ExpStateRepo, episodeHashOf } from '../server/services/workshop/exp/exp-state.repo'
import type { DcwJournalAnchor } from '../shared/dcw-protocol'

const lineId = 'line-session'
const identity = {
  recipeRunId: 'run-42',
  productId: 'product-7',
  recipeId: 'recipe-3',
  sessionId: 'session-11',
}

const anchor: DcwJournalAnchor & { sessionId?: string } = {
  id: 'anchor-1',
  lineId,
  nodeId: 'node-1',
  prevValue: 10,
  newValue: 20,
  source: 'recipe',
  actor: 'operator-1',
  at: '2026-11-14T09:00:00.000Z',
  recipeRunId: identity.recipeRunId,
  // A journal payload must not be allowed to smuggle session scope into evidence.
  sessionId: 'untrusted-session',
}

const expectedDraft = {
  nodeIds: ['node-1'],
  kind: 'platform' as const,
  source: 'recipe' as const,
  actor: 'operator-1',
  actorKind: 'system' as const,
  params: [{ nodeId: 'node-1', from: 10, to: 20 }],
  at: anchor.at,
  anchors: [anchor.id],
  auditIds: [],
  comments: [],
}

function identityOf(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(identity).map(key => [key, record[key]]))
}

test('exp aggregation retains recipe run identity without trusting anchor scope fields', () => {
  const [draft] = aggregateAnchorsToEpisodes(lineId, [anchor])
  assert.ok(draft)
  assert.equal(draft.recipeRunId, identity.recipeRunId)
  assert.equal(draft.productId, null)
  assert.equal(draft.recipeId, null)
  assert.equal(draft.sessionId, null)
})

test('exp-state persists identity across repo reload and hashes its provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-session-identity-'))
  const path = join(dir, 'exp-state.json')
  try {
    const taggedDraft = { ...expectedDraft, ...identity }
    new ExpStateRepo(path).recordEpisodes(lineId, [taggedDraft])

    const [saved] = new ExpStateRepo(path).listEpisodes({ lineId })
    assert.ok(saved)
    assert.deepEqual(identityOf(saved), identity)
    assert.equal(saved.status, 'pending')
    assert.notEqual(
      episodeHashOf({ lineId, ...expectedDraft, recipeRunId: identity.recipeRunId, productId: identity.productId, recipeId: identity.recipeId, sessionId: identity.sessionId }),
      episodeHashOf({ lineId, ...expectedDraft, recipeRunId: 'run-other', productId: identity.productId, recipeId: identity.recipeId, sessionId: identity.sessionId }),
    )

    const [withoutIdentity] = new ExpStateRepo(join(dir, 'exp-state-null.json')).recordEpisodes(lineId, [expectedDraft])
    assert.ok(withoutIdentity)
    assert.deepEqual(identityOf(withoutIdentity), { recipeRunId: null, productId: null, recipeId: null, sessionId: null })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectEpisodes resolves run scope and takes sessionId only from trusted context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-collector-identity-'))
  const globals = globalThis as typeof globalThis & {
    __expStateRepo?: ExpStateRepo
    __recipeRollBackRepo?: { listAnchorsSince: () => DcwJournalAnchor[] }
    __dcwRecipeRepo?: { runById: (id: string) => unknown, byId: (id: string) => unknown }
  }
  const previous = {
    state: globals.__expStateRepo,
    rollback: globals.__recipeRollBackRepo,
    recipes: globals.__dcwRecipeRepo,
  }
  const state = new ExpStateRepo(join(dir, 'exp-state.json'))
  const run = { id: identity.recipeRunId, recipeId: identity.recipeId, productId: identity.productId }
  try {
    globals.__expStateRepo = state
    globals.__recipeRollBackRepo = {
      listAnchorsSince: () => [anchor],
    }
    globals.__dcwRecipeRepo = {
      runById: (id: string) => id === run.id ? run : undefined,
      byId: (id: string) => id === run.recipeId ? { id: run.recipeId, productId: run.productId } : undefined,
    }

    await collectEpisodes(lineId, { nowMs: Date.parse('2026-11-14T09:02:00.000Z') }, { sessionId: identity.sessionId })
    const [saved] = state.listEpisodes({ lineId })
    assert.ok(saved)
    assert.deepEqual(identityOf(saved), identity)
    assert.equal(saved.status, 'pending')

    const nullState = new ExpStateRepo(join(dir, 'exp-state-null-context.json'))
    globals.__expStateRepo = nullState
    await collectEpisodes(lineId, { nowMs: Date.parse('2026-11-14T09:02:00.000Z') }, { sessionId: null })
    const [withoutSession] = nullState.listEpisodes({ lineId })
    assert.ok(withoutSession)
    assert.equal(withoutSession.sessionId, null)
  }
  finally {
    globals.__expStateRepo = previous.state
    globals.__recipeRollBackRepo = previous.rollback
    globals.__dcwRecipeRepo = previous.recipes
    rmSync(dir, { recursive: true, force: true })
  }
})

test('capturing an episode does not promote a candidate registry entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exp-candidate-'))
  const repo = new ExpStateRepo(join(dir, 'exp-state.json'))
  const key = `${lineId}:node-1:recipe-adjustment`
  try {
    const candidate = {
      title: 'Recipe adjustment',
      version: 1,
      confidence: '候选' as const,
      lastAt: anchor.at,
      taskIds: ['task-1'],
    }
    repo.registrySet(key, candidate)
    repo.recordEpisodes(lineId, [expectedDraft])
    assert.equal(repo.registryGet(key)?.confidence, '候选')

    repo.registrySet(key, { ...candidate, confidence: '稳' })
    assert.equal(repo.registryGet(key)?.confidence, '稳')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
