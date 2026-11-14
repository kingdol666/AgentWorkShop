import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TsdbTagQuery } from '../server/services/workshop/daq/storage/tsdb-port'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-dcw-run-data-isolation-'))
delete process.env.AW_BENCH_MODE
delete process.env.DAQ_TSDB_URL

const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller/facade')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const storage = await import('../server/services/workshop/daq/storage')

test('runData only queries and summarizes samples tagged for that product and run', async () => {
  const lineId = 'ln-run-data-isolation'
  const product = getDcwProductRepo().create({ name: 'Run data isolation product', lineId })
  const recipe = getDcwRecipeRepo().create({ name: 'Run data isolation recipe', productId: product.id })
  const run = getDcwRecipeRepo().createRun(recipe)
  run.startedAt = new Date(Date.now() - 5_000).toISOString()
  run.endedAt = new Date().toISOString()

  const node = new DaqNode({
    id: 'dn-run-data-isolation',
    templateRef: 'daq-temp-tc',
    name: 'Run data isolation temperature',
    lineId,
    decimals: 1,
  })
  getDaqNodeRepo().insert(node)

  const samples = [
    { nodeId: node.id, lineId, productId: product.id, recipeId: recipe.id, runId: run.id, at: Date.parse(run.startedAt) + 1_000, value: 10 },
    { nodeId: node.id, lineId, productId: 'prod-other', recipeId: recipe.id, runId: run.id, at: Date.parse(run.startedAt) + 2_000, value: 999 },
    { nodeId: node.id, lineId, productId: product.id, recipeId: recipe.id, runId: 'run-other', at: Date.parse(run.startedAt) + 3_000, value: 777 },
  ]
  const queryCalls: string[] = []
  const taggedQueries: Array<Record<string, unknown>> = []
  const fakeTsdb = {
    query: async (nodeId: string) => {
      queryCalls.push(nodeId)
      return samples.filter(s => s.nodeId === nodeId).map(s => ({ at: s.at, value: s.value }))
    },
    queryTagged: async (q: TsdbTagQuery) => {
      taggedQueries.push(q)
      const nodeIds = q.nodeIds ?? []
      const matches = samples.filter(s =>
        nodeIds.includes(s.nodeId)
        && s.lineId === q.lineId
        && s.productId === q.productId
        && s.recipeId === q.recipeId
        && s.runId === q.runId
        && s.at >= Number(q.fromMs)
        && s.at <= Number(q.toMs),
      )
      return new Map([[node.id, matches.map(s => ({ at: s.at, value: s.value }))]])
    },
  }
  const tsdbState = globalThis as typeof globalThis & { __daqTsdbState?: { current?: unknown } }
  tsdbState.__daqTsdbState = { current: fakeTsdb }
  void storage

  const result = await getDcwController().runData(run.id)

  assert.deepEqual(queryCalls, [], 'runData must not use untagged node queries')
  assert.equal(taggedQueries.length, 1)
  assert.deepEqual(taggedQueries[0], {
    lineId,
    productId: product.id,
    recipeId: recipe.id,
    runId: run.id,
    nodeIds: [node.id],
    fromMs: Date.parse(run.startedAt),
    toMs: Date.parse(run.endedAt!),
    bucketMs: undefined,
    limit: 500,
  })
  assert.equal(result.daq.length, 1)
  assert.equal(result.daq[0]!.latest, 10)
  assert.equal(result.daq[0]!.avg, 10)
  assert.equal(result.daq[0]!.cnt, 1)
})
