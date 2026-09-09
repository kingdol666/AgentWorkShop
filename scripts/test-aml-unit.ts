/**
 * AML 单元测试(纯函数,无服务依赖):清洗/统计/规格校验/门禁判定。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-aml-unit.ts
 */
import assert from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
let failed = 0
function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((err) => {
      failed++
      console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
    })
}

async function main() {
  const { cleanPoints, alignToGrid } = await import('../server/services/workshop/aml/clean')
  const { median, pearson, lagCrossCorr, summarize } = await import('../server/services/workshop/aml/stats')
  const { parseDatasetSpec } = await import('../server/services/workshop/aml/spec')
  const { evaluateGates } = await import('../server/services/workshop/aml/gates')

  console.log('clean.ts')
  await t('state 过滤:非 ok 样本剔除并计数', () => {
    const r = cleanPoints([
      { at: 1, value: 10, state: 'ok' },
      { at: 2, value: 11, state: 'alarm' },
      { at: 3, value: 12 },
    ], {})
    assert.equal(r.values.length, 2)
    assert.equal(r.counts.droppedState, 1)
    assert.equal(r.counts.total, 3)
  })
  await t('量程截断:模板量程外剔除', () => {
    const r = cleanPoints([{ at: 1, value: -50 }, { at: 2, value: 25 }], { range: { min: 0, max: 100 } })
    assert.equal(r.values.length, 1)
    assert.equal(r.counts.droppedRange, 1)
  })
  await t('Hampel:尖峰被移除,正常波动保留', () => {
    const base = Array.from({ length: 41 }, (_, i) => ({ at: i, value: 50 + Math.sin(i / 5) }))
    const withSpike = [...base.slice(0, 20), { at: 20, value: 500 }, ...base.slice(21)]
    const r = cleanPoints(withSpike, { hampelK: 5 })
    assert.equal(r.counts.droppedHampel, 1)
    const r2 = cleanPoints(base, { hampelK: 5 })
    assert.equal(r2.counts.droppedHampel, 0)
  })
  await t('对齐:桶均值 + 短缺口线性插值', () => {
    const beat = 1000
    const vals = [
      { at: 0, value: 0 }, { at: 500, value: 10 }, // 同桶均值 5
      { at: 3000, value: 30 }, // 缺 1000/2000 两格 → 线性插值 13.33 / 21.67
      { at: 9000, value: 90 }, // 长缺口不插
    ]
    const r = alignToGrid(vals, { beatMs: beat, maxInterpMs: 3000 })
    assert.equal(r.grid[0].at, 0)
    assert.ok(Math.abs(r.grid[0].value - 5) < 1e-9)
    assert.equal(r.counts.interpolated, 2)
    const at2000 = r.grid.find(g => g.at === 2000)
    assert.ok(at2000 && Math.abs(at2000.value - (5 + 25 * 2 / 3)) < 1e-9, `插值=${at2000?.value}`)
    assert.ok(!r.grid.some(g => g.at === 5000)) // 长缺口留空
  })

  console.log('stats.ts')
  await t('median/quantile', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 3, 2]), 2.5)
    const s = summarize('n', 'target', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0, 0)
    assert.equal(s.mean, 5.5)
    assert.equal(s.min, 1)
    assert.equal(s.max, 10)
    assert.equal(s.p50, 5.5)
  })
  await t('pearson:同向 1 / 反向 -1', () => {
    const a = [1, 2, 3, 4, 5]
    assert.ok(Math.abs(pearson(a, [2, 4, 6, 8, 10]) - 1) < 1e-9)
    assert.ok(Math.abs(pearson(a, [10, 8, 6, 4, 2]) + 1) < 1e-9)
  })
  await t('滞后互相关:能找到注入的真实时滞(控制领先目标)', () => {
    const n = 300
    const control = Array.from({ length: n }, (_, i) => Math.sin(i / 12))
    const trueLag = 7
    // 物理语义:控制领先 7 拍 → target[t] = control[t-7]
    const target = Array.from({ length: n }, (_, i) => (i - trueLag >= 0 ? control[i - trueLag] : 0))
    const est = lagCrossCorr(control, target, 20)
    assert.equal(est.lagSteps, trueLag)
    assert.ok(est.corr > 0.99)
  })

  console.log('spec.ts')
  await t('合法 spec 解析通过', () => {
    const spec = parseDatasetSpec({
      lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1',
      nodes: [{ nodeId: 'n1', role: 'control' }, { nodeId: 'n2', role: 'target' }],
      beatMs: 5000, window: { historySteps: 12, horizonSteps: 6 },
      split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
      purpose: 'mpc_surrogate',
    })
    assert.equal(spec.window.historySteps, 12)
  })
  await t('缺 target 节点 → 422', () => {
    assert.throws(() => parseDatasetSpec({
      lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1',
      nodes: [{ nodeId: 'n1', role: 'feature' }, { nodeId: 'n2', role: 'feature' }],
      beatMs: 5000, window: { historySteps: 12, horizonSteps: 6 },
      split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
    }), (e: unknown) => (e as { code?: string }).code === 'AML_SPEC_INVALID')
  })
  await t('beatMs < 1000 → 422', () => {
    assert.throws(() => parseDatasetSpec({
      lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1',
      nodes: [{ nodeId: 'n1', role: 'control' }, { nodeId: 'n2', role: 'target' }],
      beatMs: 100, window: { historySteps: 12, horizonSteps: 6 },
      split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
    }), (e: unknown) => (e as { code?: string }).code === 'AML_SPEC_INVALID')
  })

  console.log('gates.ts')
  const tmp = join(tmpdir(), `aml-gates-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'model.onnx'), Buffer.alloc(1024, 1))
  const dsMeta = { rowCount: 5000, runIds: ['a', 'b', 'c'] }
  const manifest = { split: { train: 4000, val: 500, test: 500 } } as never
  await t('全部门禁通过(好指标)', () => {
    const g = evaluateGates('mpc_surrogate', dsMeta, manifest, {
      oneStepVal: { windows: 500, nrmse: 0.08 },
      oneStepTest: { windows: 500, nrmse: 0.09 },
      rolloutTest: { windows: 100, nrmse: 0.2, horizon: 12 },
    }, tmp)
    assert.equal(g.passed, true, JSON.stringify(g.checks))
  })
  await t('滚动 NRMSE 超标 → G2 不过', () => {
    const g = evaluateGates('mpc_surrogate', dsMeta, manifest, {
      oneStepVal: { windows: 500, nrmse: 0.05 },
      oneStepTest: { windows: 500, nrmse: 0.05 },
      rolloutTest: { windows: 100, nrmse: 0.9, horizon: 12 },
    }, tmp)
    assert.equal(g.passed, false)
    assert.ok(g.checks.find(c => c.id === 'G2' && !c.pass))
  })
  await t('泛化差超标 → G3 不过', () => {
    const g = evaluateGates('mpc_surrogate', dsMeta, manifest, {
      oneStepVal: { windows: 500, nrmse: 0.05 },
      oneStepTest: { windows: 500, nrmse: 0.20 },
      rolloutTest: { windows: 100, nrmse: 0.1, horizon: 12 },
    }, tmp)
    assert.ok(g.checks.find(c => c.id === 'G3' && !c.pass))
  })
  await t('数据覆盖不足 → G4 不过', () => {
    const g = evaluateGates('mpc_surrogate', { rowCount: 100, runIds: ['a'] }, manifest, {
      oneStepVal: { windows: 50, nrmse: 0.05 },
      oneStepTest: { windows: 50, nrmse: 0.06 },
      rolloutTest: { windows: 10, nrmse: 0.1, horizon: 12 },
    }, tmp)
    assert.ok(g.checks.find(c => c.id === 'G4' && !c.pass))
  })
  await t('空工件目录 → G5 不过;quality_predict 不查 G2', () => {
    const empty = join(tmpdir(), `aml-gates-empty-${Date.now()}`)
    mkdirSync(empty, { recursive: true })
    const g = evaluateGates('mpc_surrogate', dsMeta, manifest, {
      oneStepVal: { windows: 500, nrmse: 0.08 }, oneStepTest: { windows: 500, nrmse: 0.09 },
      rolloutTest: { windows: 100, nrmse: 0.2, horizon: 12 },
    }, empty)
    assert.ok(g.checks.find(c => c.id === 'G5' && !c.pass))
    writeFileSync(join(empty, 'STUB'), 'x')
    const g2checks = evaluateGates('quality_predict', dsMeta, manifest, {
      oneStepVal: { windows: 500, nrmse: 0.08 }, oneStepTest: { windows: 500, nrmse: 0.09 },
    }, empty)
    assert.ok(!g2checks.checks.some(c => c.id === 'G2'))
    assert.ok(g2checks.passed, JSON.stringify(g2checks.checks))
  })

  console.log(`\n结果:${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main()
