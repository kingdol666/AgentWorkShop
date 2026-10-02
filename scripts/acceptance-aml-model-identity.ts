/**
 * AML 模型人读身份(label/description/line_id/objective_id)验收:
 *  1) legacy 库迁移:migrateAmlModelIdentityColumns 对旧形表补四列;
 *  2) 注册派生:registerModelFromJob 从 dataset+budget 派生 label/description 并落 line/objective;
 *  3) 过滤:repo.model.list 按 lineId/objectiveId 过滤生效。
 * AW_AML_DIR 指向临时目录,不触碰共享 ./aml。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateAmlModelIdentityColumns } from '../server/services/workshop/db/database/migrations'
import { openWorkshopDb } from '../server/services/workshop/db/database/open'
import { configureAmlRuntime } from '../server/services/workshop/aml/runtime'
import { registerModelFromJob } from '../server/services/workshop/aml/model-registry'

const fail = (msg: string): never => {
  console.error(`FAIL ${msg}`)
  process.exit(1)
}

// 旧形 aml_models(无身份四列)的建表语句,仅用于验收加列迁移
const LEGACY_MODELS_DDL = [
  'CREATE TABLE aml_models (',
  'id TEXT PRIMARY KEY, experiment_id TEXT, dataset_id TEXT, product_id TEXT, recipe_id TEXT,',
  'purpose TEXT NOT NULL DEFAULT \'mpc_surrogate\', stage TEXT NOT NULL DEFAULT \'candidate\',',
  'io_spec_json TEXT NOT NULL DEFAULT \'{}\', metrics_json TEXT NOT NULL DEFAULT \'{}\',',
  'path TEXT NOT NULL DEFAULT \'\', artifacts_pruned INTEGER NOT NULL DEFAULT 0,',
  'created_by TEXT NOT NULL DEFAULT \'\', promoted_by TEXT, promoted_at TEXT,',
  'note TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL)',
].join(' ')

// ---- 1) legacy 升级路径:旧形 aml_models 表 + 加列迁移 ----
{
  const legacyPath = join(tmpdir(), `aw-legacy-models-${process.pid}-${Date.now()}.sqlite`)
  const raw = new DatabaseSync(legacyPath)
  raw.prepare(LEGACY_MODELS_DDL).run()
  migrateAmlModelIdentityColumns(raw)
  const cols = (raw.prepare('PRAGMA table_info(aml_models)').all() as Array<{ name: string }>).map(c => c.name)
  const missing = ['label', 'description', 'line_id', 'objective_id'].filter(c => !cols.includes(c))
  raw.close()
  try {
    rmSync(legacyPath)
  }
  catch { /* temp cleanup best effort */ }
  if (missing.length) fail(`legacy 迁移缺列:${missing.join(',')}`)
  console.log('PASS legacy 迁移补齐 label/description/line_id/objective_id')
}

// ---- 2) 注册派生身份 ----
const root = mkdtempSync(join(tmpdir(), `aw-aml-identity-${process.pid}-`))
const amlRoot = join(root, 'aml')
process.env.AW_AML_DIR = amlRoot
const dbPath = join(root, 'workshop.sqlite')
const db = openWorkshopDb(dbPath)
const rt = configureAmlRuntime(db)

const datasetId = 'ds-mi-1'
const dsDir = join(root, 'dataset-entity', datasetId)
mkdirSync(dsDir, { recursive: true })
writeFileSync(join(dsDir, 'manifest.json'), JSON.stringify({
  allNodes: ['n-hold', 'n-temp'], controlNodes: ['n-hold'], targetNodes: ['n-temp'],
  shapes: { x: [1, 8, 2], u: [1, 4, 1], y: [1, 4, 1] },
  norm: { x: { mean: [0, 0], std: [1, 1] }, u: { mean: [0], std: [1] }, y: { mean: [0], std: [1] } },
  beatMs: 1000,
}))
rt.repo.dataset.insert({
  id: datasetId, lineId: 'line-1', productId: 'prd-cap', recipeId: 'rcp-thin',
  runIds: ['run-1'], specJson: '{}', sha256: 'x', rowCount: 600,
  fromMs: 0, toMs: 0, path: dsDir, createdBy: 'tester', createdByKind: 'user',
  note: '', createdAt: new Date().toISOString(),
})

const submitJob = (budgetExtra: Record<string, unknown>): string => {
  const jobId = `job-mi-${Math.random().toString(36).slice(2, 8)}`
  // 注册回退路径 = <AW_AML_DIR>/jobs/<jobId>/artifacts(与 runtime.jobsDir 对齐)
  const artifacts = join(amlRoot, 'jobs', jobId, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'model.onnx'), 'stub')
  rt.repo.job.insert({
    id: jobId, datasetId, purpose: 'mpc_surrogate',
    budget: { seed: 42, params: {}, changeNote: 'identity acceptance', ...budgetExtra },
    agentId: 'agt-tester', createdAt: new Date().toISOString(),
  })
  return jobId
}

// 2a) 自拟名 + 目标:label = name(谱系尾) #短id;description 透传
{
  const jobId = submitJob({
    modelName: '薄壁注塑调参模型', modelDescription: '面向薄壁配方的保压闭环调参代理',
    sceneId: 'scn-inj', sceneVersion: '3', objectiveId: 'obj-hold-tracking', jobKind: 'hybrid_residual',
  })
  const r = registerModelFromJob(jobId, { passed: true, checks: [] }, '{}')
  if (!r.modelId) fail('2a 门禁通过应登记模型')
  const m = rt.repo.model.get(r.modelId!)!
  if (!m.label.startsWith('薄壁注塑调参模型(') || !m.label.includes('prd-cap/rcp-thin') || !m.label.includes('目标:obj-hold-tracking') || !m.label.includes(`#${m.id.slice(-6)}`)) {
    fail(`2a label 不合预期:${m.label}`)
  }
  if (m.description !== '面向薄壁配方的保压闭环调参代理') fail(`2a description 未透传:${m.description}`)
  if (m.lineId !== 'line-1' || m.objectiveId !== 'obj-hold-tracking') fail(`2a line/objective 未落库:${m.lineId}/${m.objectiveId}`)
  if (!existsSync(join(m.path, 'io_spec.json'))) fail('2a io_spec.json 未随实体落盘')
  console.log(`PASS 自拟名注册 label=${m.label}`)
}

// 2b) 缺省派生:label = 场景@版本·产品/配方·purpose 中文目标;description 派生谱系
{
  const jobId = submitJob({ sceneId: 'scn-inj', sceneVersion: '2' })
  const r = registerModelFromJob(jobId, { passed: true, checks: [] }, '{}')
  const m = rt.repo.model.get(r.modelId!)!
  if (!m.label.startsWith('scn-inj@2·') || !m.label.includes('prd-cap/rcp-thin') || !m.label.includes('MPC调参代理')) {
    fail(`2b label 派生不合预期:${m.label}`)
  }
  for (const frag of ['产线 line-1', '配方 rcp-thin', '优化目标 MPC调参代理(purpose=mpc_surrogate)', '场景 scn-inj@2']) {
    if (!m.description.includes(frag)) fail(`2b description 缺「${frag}」:${m.description}`)
  }
  if (m.objectiveId !== '') fail('2b 无 objective 时 objectiveId 应为空串')
  console.log(`PASS 缺省派生 label=${m.label}`)
}

// ---- 3) 过滤:lineId / objectiveId ----
{
  const byLine = rt.repo.model.list({ lineId: 'line-1', limit: 50 })
  const byOther = rt.repo.model.list({ lineId: 'line-elsewhere', limit: 50 })
  const byObj = rt.repo.model.list({ objectiveId: 'obj-hold-tracking', limit: 50 })
  if (byLine.length !== 2 || byOther.length !== 0 || byObj.length !== 1) {
    fail(`3 过滤计数不合预期 line=${byLine.length} other=${byOther.length} obj=${byObj.length}`)
  }
  console.log('PASS lineId/objectiveId 过滤生效')
}

db.close()
try {
  rmSync(root, { recursive: true, force: true })
}
catch { /* temp cleanup best effort */ }
console.log('ALL PASS aml-model-identity')
