import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ProcessModelSpec } from '../server/services/workshop/process-model/contracts'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-typed-prediction-'))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { registerModelFromJob } = await import('../server/services/workshop/aml/model-registry')
const { runBuiltinTraining } = await import('../server/services/workshop/process-model/trainers')
const { predictWithModel } = await import('../server/services/workshop/aml/predictor')
const db = openWorkshopDb(join(process.env.AW_HOME!, 'typed.sqlite'))
const rt = configureAmlRuntime(db)
after(() => db.close())

const allNodes = ['node-cv2', 'node-mv2', 'node-cv1', 'node-mv1']
const controlNodes = ['node-mv1', 'node-mv2']
const targetNodes = ['node-cv1', 'node-cv2']
const H = 12
const P = 3
const N = 60
const norm = {
  x: { mean: [20, 3, 10, -5], std: [4, 2, 3, 2] },
  u: { mean: [-5, 3], std: [2, 2] }, y: { mean: [10, 20], std: [3, 4] },
}

function steady(u1: number, u2: number): number[] {
  return [1 + 2 * u1 - 3 * u2 + 0.5 * u1 ** 2 + 0.7 * u1 * u2 - 0.2 * u2 ** 2,
    -2 - u1 + 4 * u2 - 0.4 * u1 ** 2 + 0.2 * u1 * u2 + 0.3 * u2 ** 2]
}

function registerFixture(kind: 'linear' | 'static', legacy = false) {
  const suffix = `${kind}-${legacy ? 'legacy' : 'logical'}`
  const variables = [...controlNodes, ...targetNodes].map((nodeId, i) => ({
    id: legacy ? nodeId : ['mv1', 'mv2', 'cv1', 'cv2'][i]!, nodeId,
    role: i < 2 ? 'mv' : 'cv', unit: 'sensor', modelUnit: 'model', scale: 10, offset: 100, delayMs: 0,
  }))
  const x: number[] = []
  const u: number[] = []
  const y: number[] = []
  for (let n = 0; n < N; n++) {
    let previous = [0, 0]
    for (let t = 0; t < H + P; t++) {
      const time = kind === 'static' ? 0 : t
      const u1 = Math.sin(n * 0.77 + time * 0.83) * 3
      const u2 = Math.cos(n * 1.31 + time * 1.17) * 2
      const outputs = kind === 'static'
        ? steady(u1, u2)
        : [0.4 * previous[0]! + 2 * u1 - 0.3 * u2 + 1, -0.2 * previous[1]! + 0.7 * u1 + 3 * u2 - 2]
      previous = outputs
      if (t < H) {
        const values = [outputs[1]!, u2, outputs[0]!, u1]
        x.push(...values.map((value, i) => (value - norm.x.mean[i]!) / norm.x.std[i]!))
      }
      else {
        u.push((u1 - norm.u.mean[0]!) / norm.u.std[0]!, (u2 - norm.u.mean[1]!) / norm.u.std[1]!)
        y.push(...outputs.map((value, i) => (value - norm.y.mean[i]!) / norm.y.std[i]!))
      }
    }
  }
  const datasetId = `ds-${suffix}`
  const datasetDir = join(rt.datasetsDir, datasetId)
  mkdirSync(join(datasetDir, 'arrays'), { recursive: true })
  for (const [name, values] of Object.entries({ x, u, y })) writeFileSync(join(datasetDir, 'arrays', `${name}.f32`), Buffer.from(new Float32Array(values).buffer))
  writeFileSync(join(datasetDir, 'manifest.json'), JSON.stringify({
    version: 2, allNodes, controlNodes, targetNodes, variables, norm, beatMs: 1000,
    shapes: { x: [N, H, 4], u: [N, P, 2], y: [N, P, 2] },
    split: { train: 40, val: 10, test: 10, trainRunIds: ['train'], valRunIds: ['val'], testRunIds: ['test'] },
  }))
  const now = new Date().toISOString()
  rt.repo.dataset.insert({ id: datasetId, lineId: 'line', productId: 'product', recipeId: 'recipe', runIds: ['train', 'val', 'test'], specJson: '{}', sha256: 'fixture', rowCount: N * H, fromMs: 0, toMs: 1, path: datasetDir, createdBy: 'test', createdByKind: 'user', note: '', createdAt: now })
  const jobId = `job-${suffix}`
  rt.repo.job.insert({ id: jobId, datasetId, purpose: 'mpc_surrogate', budget: {}, createdAt: now })
  const ref = kind === 'linear' ? 'linear_arx@1' : 'static_response@1'
  const config = kind === 'linear'
    ? { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-10, standardize: true }
    : { order: 2, ridgeLambda: 1e-10, standardize: true }
  const trained = runBuiltinTraining(ref, { datasetDir, jobDir: join(rt.jobsDir, jobId), spec: { variables, timing: { beatMs: 1000 }, trainer: { ref, config } } as unknown as ProcessModelSpec })
  const { modelId } = registerModelFromJob(jobId, { passed: true, checks: [] }, JSON.stringify(trained.metrics))
  assert.ok(modelId)
  return rt.repo.model.get(modelId)!
}

function frozenState(modelId: string): string {
  const row = rt.repo.model.get(modelId)!
  return JSON.stringify({ artifactHash: row.artifactHash, io: row.ioSpecJson,
    files: ['model.json', 'io_spec.json', 'artifact_manifest.json'].map(name => createHash('sha256').update(readFileSync(join(row.path, name))).digest('hex')) })
}

for (const legacy of [false, true]) {
  test(`registered ARX maps ${legacy ? 'legacy node IDs' : 'logical variable IDs'} across reordered history columns`, async () => {
    const row = registerFixture('linear', legacy)
    const before = frozenState(row.id)
    const history = Array.from({ length: H }, () => [20, -3, 10, 7])
    const controls = [[2, -1], [-2, 3], [1, 4]]
    const result = await predictWithModel(row.id, { history, controls, steps: 3 })
    let expected = [10, 20]
    for (let t = 0; t < controls.length; t++) {
      const [u1, u2] = controls[t]!
      expected = [0.4 * expected[0]! + 2 * u1! - 0.3 * u2! + 1, -0.2 * expected[1]! + 0.7 * u1! + 3 * u2! - 2]
      result.forecast[t]!.forEach((value, j) => assert.ok(Math.abs(value - expected[j]!) < 1e-4, `step ${t}, target ${j}: ${value} != ${expected[j]}`))
    }
    assert.deepEqual(result.targetNodes, targetNodes)
    const held = await predictWithModel(row.id, { history, steps: 1 })
    assert.ok(Math.abs(held.forecast[0]![0]! - (4 + 14 + 0.9 + 1)) < 1e-4)
    assert.equal(frozenState(row.id), before, 'prediction must preserve frozen artifacts, io and artifactHash')
  })

  test(`registered quadratic response preserves ${legacy ? 'node ID' : 'logical'} coefficient and interaction keys`, async () => {
    const row = registerFixture('static', legacy)
    const before = frozenState(row.id)
    const history = Array.from({ length: H }, () => [20, -3, 10, 7])
    const result = await predictWithModel(row.id, { history, controls: [[2, -1]], steps: 2 })
    assert.deepEqual(result.targetNodes, targetNodes)
    result.forecast.forEach(values => values.forEach((value, j) => assert.ok(Math.abs(value - steady(2, -1)[j]!) < 1e-4)))
    assert.equal(frozenState(row.id), before)
  })
}

test('typed prediction rejects missing, duplicate and ambiguous node mappings explicitly', async () => {
  const row = rt.repo.model.get('mdl-linear-logical')!
  const io = JSON.parse(row.ioSpecJson)
  const invalidIo = [
    { ...io, variables: io.variables.filter((v: { id: string }) => v.id !== 'mv1') },
    { ...io, variables: [...io.variables, io.variables[0]] },
    { ...io, variables: io.variables.map((v: { id: string }) => v.id === 'mv1' ? { ...v, nodeId: 'missing' } : v) },
    { ...io, allNodes: ['node-mv1', 'node-mv2', 'node-cv1', 'node-mv1'] },
    { ...io, variables: io.variables.map((v: { id: string }) => v.id === 'mv2' ? { ...v, nodeId: 'node-mv1' } : v) },
  ]
  try {
    for (const invalid of invalidIo) {
      db.prepare('UPDATE aml_models SET io_spec_json=? WHERE id=?').run(JSON.stringify(invalid), row.id)
      await assert.rejects(predictWithModel(row.id, { history: Array.from({ length: H }, () => [0, 0, 0, 0]), steps: 1 }), { code: 'AML_IO_UNSUPPORTED' })
    }
  }
  finally {
    db.prepare('UPDATE aml_models SET io_spec_json=? WHERE id=?').run(row.ioSpecJson, row.id)
  }
})
