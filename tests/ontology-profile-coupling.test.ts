/**
 * Profile × 本体耦合:ontologyRefs 进 profileContentHash、绝不进 problemIrHash;
 * 旧 Profile 内容域不变;漂移独立校验(ONTOLOGY_PACK_DRIFTED)。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-ontology-profile-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { createProfileRepo, profileContentHash, parseProfileRow } = await import('../server/services/workshop/optimization/profile.repo')
const { canonicalJson } = await import('../server/services/workshop/aml/twin/contracts')
const { resetOntologyRepo, createOntologyRepo } = await import('../server/services/workshop/ontology/repo')
const { assertOntologyUnchanged } = await import('../server/services/workshop/ontology/ontology.service')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'ontology-profile.sqlite'))
configureAmlRuntime(db)
resetOntologyRepo()

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const, id: 'optp-ont', version: 1,
    modelRef: { modelId: 'mdl-1', artifactKind: 'linear_state_space@1' as const, artifactHash: 'h', modelInterface: 'linear_state_space' as const, stage: 'candidate' as const },
    problemTemplateRef: 'linear_mpc_quadratic@1' as const,
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 1, targets: { cv1: 50 } } },
    solverRef: 'osqp_mpc@1' as const, solverVersion: '1', processSpecRef: 'pms@1', conditionIds: [], status: 'draft' as const,
    ...overrides,
  }
}

test('profileContentHash 含 ontologyRefs;旧 Profile(无 refs)的内容域不含该字段', () => {
  const base = profile()
  const withRefs = profile({ ontologyRefs: [{ ontologyId: 'ont-a', ontologyVersion: 1, contentHash: 'c', rulePackHash: 'r', guardCount: 1 }] })
  assert.notEqual(profileContentHash(base as never), profileContentHash(withRefs as never))
  // 旧 Profile 的 canonicalJson 不含 ontologyRefs 键 → 字节不变(不会触发 PROFILE_VERSION_IMMUTABLE)
  assert.equal(canonicalJson(base).includes('ontologyRefs'), false)
  assert.equal(canonicalJson(withRefs).includes('ontologyRefs'), true)
})

test('仓储往返:ontologyRefs 持久化;同内容幂等;改 refs 视为不同内容(409)', () => {
  const repo = createProfileRepo(db)
  const withRefs = profile({ ontologyRefs: [{ ontologyId: 'ont-a', ontologyVersion: 1, contentHash: 'c1', rulePackHash: 'r1', guardCount: 2 }] })
  const row = repo.insert(withRefs as never, 'u1')
  assert.equal(row.ontologyRefsJson.includes('ont-a'), true)
  const parsed = parseProfileRow(row)
  assert.equal(parsed.ontologyRefs?.[0]?.ontologyVersion, 1)
  assert.equal(parsed.ontologyRefs?.[0]?.guardCount, 2)
  // 幂等
  assert.equal(repo.insert(withRefs as never, 'u1').contentHash, row.contentHash)
  // 改 refs → 视为不同内容
  assert.throws(() => repo.insert(profile({
    ontologyRefs: [{ ontologyId: 'ont-a', ontologyVersion: 2, contentHash: 'c2' }],
  }) as never), (err: { code?: string }) => err.code === 'PROFILE_VERSION_IMMUTABLE')
})

test('旧 Profile(无 refs)插入后 contentHash 与不含该列时一致(不破既有冻结)', () => {
  const repo = createProfileRepo(db)
  const legacy = profile({ id: 'optp-legacy' })
  const row = repo.insert(legacy as never, 'u1')
  assert.equal(row.ontologyRefsJson, '[]')
  assert.equal(row.contentHash, profileContentHash(legacy as never))
  const parsed = parseProfileRow(row)
  assert.equal(parsed.ontologyRefs, undefined)
})

test('漂移校验:引用一致放行;篡改/缺失/退役 → ONTOLOGY_PACK_DRIFTED', () => {
  const repo = createOntologyRepo(db)
  repo.publishSnapshot({
    version: {
      id: 'ont-ref', version: 1, name: 'r', lineId: 'ln-1', parentVersion: null,
      contentHash: 'content-1', compiledJson: '{}', changelogJson: '{}',
      status: 'published', ownerUserId: 'u1', publishedBy: 'u1', createdAt: '', updatedAt: '',
    },
    entities: [], relations: [], rules: [], bindings: [], traces: [], guards: [], createdBy: 'u1',
  })
  assert.doesNotThrow(() => assertOntologyUnchanged([{ ontologyId: 'ont-ref', ontologyVersion: 1, contentHash: 'content-1' }]))
  // 无 refs / 空数组 → 跳过(无本体约束域,不是放行语义)
  assert.doesNotThrow(() => assertOntologyUnchanged(undefined))
  assert.doesNotThrow(() => assertOntologyUnchanged([]))
  // 内容篡改
  assert.throws(() => assertOntologyUnchanged([{ ontologyId: 'ont-ref', ontologyVersion: 1, contentHash: 'x' }]),
    (err: { code?: string }) => err.code === 'ONTOLOGY_PACK_DRIFTED')
  // 版本不存在
  assert.throws(() => assertOntologyUnchanged([{ ontologyId: 'ont-ref', ontologyVersion: 9 }]),
    (err: { code?: string }) => err.code === 'ONTOLOGY_PACK_DRIFTED')
  // 退役后引用即漂移
  assert.equal(repo.transitionVersion('ont-ref', 1, 'retired', 'published'), true)
  assert.throws(() => assertOntologyUnchanged([{ ontologyId: 'ont-ref', ontologyVersion: 1 }]),
    (err: { code?: string }) => err.code === 'ONTOLOGY_PACK_DRIFTED')
})
