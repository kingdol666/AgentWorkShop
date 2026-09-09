/**
 * AML 集成测试(进程内,沙箱 cwd + 沙箱数据目录):
 *   数据集构建器全流程 —— 批次打标样本 → 清洗/对齐/滑窗 → byRun 切分确定性 → 快照落盘;
 *   隔离硬约束(跨产线节点拒绝)、配额、GC 引用计数。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-aml-integration.ts
 * 原理:process.chdir 沙箱目录(dcw JSON 仓库落 <cwd>/server/data)+ AW_DATA_DIR 沙箱
 *       (tsdb sqlite 回退 + workshop.sqlite);动态 import 避免模块在 chdir 前初始化。
 */
import assert from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
      console.error(`  ✗ ${name}: ${err?.stack ?? String(err)}`)
    })
}

const ROOT = join(tmpdir(), `aml-it-${Date.now()}`)

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'server', 'data'), { recursive: true })
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  process.env.AW_DATA_DIR = join(ROOT, 'data')
  process.chdir(ROOT)

  // ---- 1. 沙箱化服务装配(动态 import:chdir/env 生效后再加载)----
  const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
  const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
  const db = openWorkshopDb(join(process.env.AW_DATA_DIR, 'workshop.sqlite'))
  initWorkshopDb(db)
  const rt = configureAmlRuntime(db, process.env.AW_DATA_DIR)

  // ---- 2. 伪造批次注册表(dcw JSON 仓库:沙箱 cwd/server/data/dcw-runs.json)----
  // RecipeRunView 最小字段集(listRuns 按 recipeId 过滤 + endedAt 非空)
  const mkRun = (id: string, startedAt: string, endedAt: string) => ({
    id, recipeId: 'rc-it-1', productId: 'pd-it-1', lineId: 'ln-it-1',
    name: `批次 ${id}`, startedAt, endedAt, params: [], paramsSnapshot: [], results: [],
  })
  const now = Date.now()
  const runs = [0, 1, 2, 3].map(i => mkRun(
    `rr-it-${i}`,
    new Date(now - (4 - i) * 3600_000).toISOString(),
    new Date(now - (4 - i) * 3600_000 + 2400_000).toISOString(),
  ))
  writeFileSync(join(ROOT, 'server', 'data', 'dcw-runs.json'), JSON.stringify(runs))
  writeFileSync(join(ROOT, 'server', 'data', 'dcw-recipes.json'), JSON.stringify([]))
  // 数采节点夹具(daq-node.repo 读 <cwd>/server/data/daqs.json;构建器按此校验存在性与产线)
  writeFileSync(join(ROOT, 'server', 'data', 'daqs.json'), JSON.stringify([
    { id: 'daq-it-ctrl', templateRef: 'daq-temp-tc', name: 'it-ctrl', lineId: 'ln-it-1', min: 0, max: 100 },
    { id: 'daq-it-tmp', templateRef: 'daq-pressure-tx', name: 'it-tmp', lineId: 'ln-it-1', min: 0, max: 200 },
  ]))

  // ---- 3. 直接向 tsdb 写合成样本(一阶惯性 + 死区 + 噪声;逐 run 打标)----
  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const tsdb = new SqliteTimeSeriesAdapter()
  await tsdb.init()
  const beatMs = 5000
  const rows = []
  for (const [ri, run] of runs.entries()) {
    const t0 = Date.parse(run.startedAt)
    const t1 = Date.parse(run.endedAt)
    let pv = 50 + ri // 各批次不同初值(run 间差异 → byRun 切分有效)
    for (let t = t0; t <= t1; t += 1000) {
      const sp = 60 + 10 * Math.sin((t - t0) / 60000)
      pv = pv + (sp - pv) * 0.02 + (Math.random() - 0.5) * 0.3
      rows.push({ nodeId: 'daq-it-ctrl', tsMs: t, value: sp + (Math.random() - 0.5) * 0.1, state: 'ok', lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1', runId: run.id })
      rows.push({ nodeId: 'daq-it-tmp', tsMs: t, value: pv, state: 'ok', lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1', runId: run.id })
      if (t % 10000 === 5000) {
        // 离群点(供 Hampel 清洗)与一个非 ok 状态样本(供 state 过滤)
        rows.push({ nodeId: 'daq-it-tmp', tsMs: t, value: 9999, state: 'ok', lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1', runId: run.id })
      }
    }
  }
  await tsdb.writeSamples(rows)

  const { buildDataset, amlDiskUsageMb } = await import('../server/services/workshop/aml/dataset-builder')
  const { parseDatasetSpec } = await import('../server/services/workshop/aml/spec')

  const specBase = {
    lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1',
    nodes: [{ nodeId: 'daq-it-ctrl', role: 'control' }, { nodeId: 'daq-it-tmp', role: 'target' }],
    beatMs, window: { historySteps: 12, horizonSteps: 6 },
    cleaning: { hampelK: 5, maxInterpMs: 15000, maxDropRatio: 0.3 },
    split: { valRatio: 0.25, testRatio: 0.25, seed: 42 },
    purpose: 'mpc_surrogate' as const,
  }

  console.log('dataset-builder')
  let firstSha = ''
  await t('构建成功:行数/切分/统计报告齐全,清洗管线生效', async () => {
    const spec = parseDatasetSpec(specBase)
    const { dataset, report } = await buildDataset(spec, { id: 'tester', kind: 'user' })
    firstSha = dataset.sha256
    assert.ok(dataset.rowCount > 100, `行数 ${dataset.rowCount}`)
    assert.equal(dataset.runIds.length, 4)
    assert.ok(report.windowCount.train > 0 && report.windowCount.test > 0)
    assert.ok(report.nodeSummaries.length === 2)
    // Hampel 清掉离群点(4 个 run × 若干)→ cleanedRatio > 0
    const tmpStats = report.cleaning['daq-it-tmp']
    assert.ok(tmpStats && tmpStats.droppedHampel > 0, ` Hampel 应剔除离群点:${JSON.stringify(tmpStats)}`)
    // 滞后估计存在(控制→目标)
    assert.ok(report.lagEstimates.length >= 1)
  })
  await t('确定性:同 seed 两次构建 sha256 一致', async () => {
    const { dataset } = await buildDataset(parseDatasetSpec(specBase), { id: 'tester', kind: 'user' })
    assert.equal(dataset.sha256, firstSha)
  })
  await t('隔离:产线/批次归属不一致 → 拒绝(两个守卫任一生效)', async () => {
    await assert.rejects(
      () => buildDataset(parseDatasetSpec({
        ...specBase, nodes: [{ nodeId: 'daq-it-ctrl', role: 'control' }, { nodeId: 'daq-it-tmp', role: 'target' }], lineId: 'ln-other',
      }), { id: 'tester', kind: 'user' }),
      (e: unknown) => /^AML_(RUN_MISMATCH|NODE_LINE_MISMATCH)$/.test((e as { code?: string }).code ?? ''),
    )
  })
  await t('隔离:批次归属不一致 → 422 拒绝', async () => {
    await assert.rejects(
      () => buildDataset(parseDatasetSpec({ ...specBase, productId: 'pd-other' }), { id: 'tester', kind: 'user' }),
      (e: unknown) => (e as { code?: string }).code === 'AML_RUN_MISMATCH',
    )
  })
  await t('未知节点 → 404', async () => {
    await assert.rejects(
      () => buildDataset(parseDatasetSpec({
        ...specBase, nodes: [{ nodeId: 'daq-nope', role: 'control' }, { nodeId: 'daq-it-tmp', role: 'target' }],
      }), { id: 'tester', kind: 'user' }),
      (e: unknown) => (e as { code?: string }).code === 'AML_NODE_MISSING',
    )
  })
  await t('引用计数与 GC:被引用数据集在册', async () => {
    const list = rt.repo.dataset.list({ recipeId: 'rc-it-1', limit: 10 })
    assert.ok(list.length >= 2)
    const refs = rt.repo.dataset.referenceCount(list[0].id)
    assert.equal(refs.models, 0)
    assert.equal(amlDiskUsageMb(rt.root, { force: true }) > 0, true)
  })

  console.log('\n结果:' + passed + ' 通过 / ' + failed + ' 失败')
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
