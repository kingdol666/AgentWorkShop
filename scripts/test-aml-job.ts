/**
 * AML 作业链路冒烟测试(进程内,秒级;存根运行器):
 *   沙箱环境 → 建数据集(合成一阶动力学)→ 创建训练作业(AML_STUB 存根运行器)→
 *   门禁判定 → 实验行登记 → 注册表/工件纪律(STUB 模型不可预测)。
 *
 * 真实 Python 链路(venv 供给 + torch 训练 + ONNX 评估)由 scripts/e2e-aml.ts --real
 * 对活服覆盖 —— 本脚本专注作业状态机与登记语义,不依赖本机 Python。
 *
 * 运行:AML_STUB=1 npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-aml-job.ts
 */
import assert from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(tmpdir(), `aml-job-${Date.now()}`)

/** 路径 allowlist:测试沙箱只允许落在系统临时目录内 */
function assertInTmp(p: string, label: string): string {
  const abs = resolve(p)
  if (!abs.startsWith(tmpdir())) {
    throw new Error(`${label} 越界(仅允许系统临时目录): ${abs}`)
  }
  return abs
}

/** 确定性伪随机(测试夹具专用;[0,1)) */
let lcgState = 0x2F6E2B1
function lcg(): number {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0
  return lcgState / 0x100000000
}

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

async function main() {
  rmSync(ROOT, { recursive: true, force: true })
  const dataDir = assertInTmp(join(ROOT, 'data'), 'data')
  const serverData = assertInTmp(join(ROOT, 'server', 'data'), 'server/data')
  mkdirSync(serverData, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  process.env.AW_DATA_DIR = dataDir
  process.env.AML_STUB = '1'
  process.chdir(ROOT)

  const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
  const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
  const db = openWorkshopDb(join(dataDir, 'workshop.sqlite'))
  initWorkshopDb(db)
  const rt = configureAmlRuntime(db, dataDir)

  // ---- 夹具:批次 + 节点 + 合成一阶动力学样本(与集成测试同源) ----
  const mkRun = (id: string, startedAt: string, endedAt: string) => ({
    id, recipeId: 'rc-it-1', productId: 'pd-it-1', lineId: 'ln-it-1',
    name: id, startedAt, endedAt, params: [], paramsSnapshot: [], results: [],
  })
  const now = Date.now()
  const runs = [0, 1, 2, 3].map(i => mkRun(
    `rr-it-${i}`,
    new Date(now - (4 - i) * 3600_000).toISOString(),
    new Date(now - (4 - i) * 3600_000 + 2400_000).toISOString(),
  ))
  writeFileSync(join(serverData, 'dcw-runs.json'), JSON.stringify(runs))
  writeFileSync(join(serverData, 'dcw-recipes.json'), JSON.stringify([]))
  writeFileSync(join(serverData, 'daqs.json'), JSON.stringify([
    { id: 'daq-it-ctrl', templateRef: 'daq-temp-tc', name: 'it-ctrl', lineId: 'ln-it-1', min: 0, max: 100 },
    { id: 'daq-it-tmp', templateRef: 'daq-pressure-tx', name: 'it-tmp', lineId: 'ln-it-1', min: 0, max: 200 },
  ]))
  const { SqliteTimeSeriesAdapter } = await import('../server/services/workshop/daq/storage/sqlite.adapter')
  const tsdb = new SqliteTimeSeriesAdapter()
  await tsdb.init()
  const beatMs = 5000
  const rows = []
  for (const run of runs) {
    const t0 = Date.parse(run.startedAt)
    const t1 = Date.parse(run.endedAt)
    let pv = 50
    for (let t = t0; t <= t1; t += 1000) {
      const sp = 60 + 10 * Math.sin((t - t0) / 60000)
      pv = pv + (sp - pv) * 0.02 + (lcg() - 0.5) * 0.3
      rows.push({ nodeId: 'daq-it-ctrl', tsMs: t, value: sp, state: 'ok', lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1', runId: run.id })
      rows.push({ nodeId: 'daq-it-tmp', tsMs: t, value: pv, state: 'ok', lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1', runId: run.id })
    }
  }
  await tsdb.writeSamples(rows)

  // ---- 构建数据集 + 创建训练作业(存根代码由编排器写入工作区) ----
  const { buildDataset } = await import('../server/services/workshop/aml/dataset-builder')
  const { parseDatasetSpec } = await import('../server/services/workshop/aml/spec')
  const orchestrator = await import('../server/services/workshop/aml/job-orchestrator')
  const { dataset } = await buildDataset(parseDatasetSpec({
    lineId: 'ln-it-1', productId: 'pd-it-1', recipeId: 'rc-it-1',
    nodes: [{ nodeId: 'daq-it-ctrl', role: 'control' }, { nodeId: 'daq-it-tmp', role: 'target' }],
    beatMs, window: { historySteps: 12, horizonSteps: 6 },
    cleaning: { hampelK: 5, maxInterpMs: 15000, maxDropRatio: 0.3 },
    split: { valRatio: 0.25, testRatio: 0.25, seed: 42 },
    purpose: 'mpc_surrogate',
  }), { id: 'tester', kind: 'user' })
  console.log(`  数据集 ${dataset.id}:rows=${dataset.rowCount} runs=${dataset.runIds.length}`)

  const job = orchestrator.submitJob({
    datasetId: dataset.id,
    code: 'import amlkit\namlkit.report_progress(50, \'stub\')\namlkit.save_metrics({\'agent\': {\'note\': \'stub\'}})\nprint(\'stub done\')\n',
    changeNote: 'job-smoke 基线',
    seed: 42,
    params: { stubNrmse: 0.07, stubRolloutNrmse: 0.18 },
    agent: { id: 'tester-agent' },
  })
  console.log(`  作业 ${job.id} 已创建(存根运行器)…`)

  // ---- 轮询至终态 ----
  const started = Date.now()
  let final = rt.repo.job.get(job.id)!
  while (Date.now() - started < 60_000) {
    await new Promise(r => setTimeout(r, 1000))
    final = rt.repo.job.get(job.id)!
    if (['done', 'failed', 'timeout', 'cancelled'].includes(final.status)) break
  }

  await t('作业完成(done)', () => {
    assert.equal(final.status, 'done', `status=${final.status} err=${final.error}`)
  })
  await t('实验行已登记且门禁全过(存根达标指标)', () => {
    const exps = rt.repo.experiment.listByDataset(dataset.id)
    assert.ok(exps.length >= 1)
    assert.equal(exps[0].status, 'gates_passed')
    const gateReport = JSON.parse(exps[0].gatesJson)
    assert.ok(gateReport.passed)
    assert.ok(Array.isArray(gateReport.checks) && gateReport.checks.length >= 5)
    console.log(`    门禁:${gateReport.checks.map((c: { id: string, pass: boolean }) => `${c.id}:${c.pass ? '✓' : '✗'}`).join(' ')}`)
  })
  await t('候选模型登记:STUB 工件在册,预测服务拒绝(STUB 纪律)', async () => {
    const models = rt.repo.model.list({ recipeId: 'rc-it-1' })
    assert.ok(models.length >= 1, '应有 candidate 模型')
    const io = JSON.parse(models[0].ioSpecJson)
    assert.equal(io.modelInterface, 'one_step')
    assert.deepEqual(io.targetNodes, ['daq-it-tmp'])
    const { predictWithModel } = await import('../server/services/workshop/aml/predictor')
    await assert.rejects(
      () => predictWithModel(models[0].id, { history: [[0]] }),
      (e: unknown) => (e as { code?: string }).code === 'AML_STUB_MODEL',
    )
  })
  await t('日志可读(终态后落盘 run.log)', () => {
    const logs = orchestrator.jobLogsTail(job.id, 40)
    assert.ok(logs.length > 0)
  })
  await t('操作归属:审计留痕含提交者', () => {
    const jobs = rt.repo.job.list({ datasetId: dataset.id })
    assert.equal(jobs[0].agentId, 'tester-agent')
  })

  console.log(`\n结果:${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
