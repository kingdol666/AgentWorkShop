/**
 * 多源异构数据 & MES 接入面验收(H1–H8,2026-11-03)。
 *
 * 与单测的分工:单测用注入假件验证纯逻辑;本脚本用**真实仓储/TSDB/对象存储/
 * 本地 HTTP 模拟 MES**,把"MES 历史 → TSDB → AML 数据集 → 训练输入"整链打通。
 * 覆盖:H1 桥接(标量/向量/图像)· H2 节点级向量网格 · H3 导出环境列 ·
 * H5 图像帧统一检索面 · H8 模板库真实试读(H4/H6/H7 见单测)。
 *
 * 隔离:临时 AW_HOME + 临时 sqlite + 127.0.0.1 随机端口模拟 MES;退出即丢弃。
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-heterogeneous-mes.ts
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'aw-h1h8-e2e-'))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = home
process.env.AW_MES_EXPORT_ROOT = join(home, 'mes-exports')
delete process.env.AW_MES_BRIDGE
delete process.env.AW_IDENT_GATE

let pass = 0
let fail = 0
const failures: string[] = []
function check(id: string, name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  PASS ${id} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    fail++
    failures.push(`${id} ${name}: ${detail}`)
    console.log(`  FAIL ${id} ${name} — ${detail}`)
  }
}

// ---------- 本地 MES 模拟器(127.0.0.1 随机端口) ----------
const RUN_START = Date.now() - 3 * 60_000
const RUN_END = Date.now() - 60_000
const PNGB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const scalarSeries = Array.from({ length: 121 }, (_, i) => ({
  ts: RUN_START + i * 1000,
  value: 35 + 2 * Math.sin(i / 12),
  lane: 'A',
}))
const vectorSeries = Array.from({ length: 25 }, (_, i) => ({
  ts: RUN_START + i * 5000,
  profile: Array.from({ length: 12 }, (_, k) => 0.5 + 0.01 * k + 0.001 * i),
  mean: 0.555 + 0.001 * i,
}))
const imageSeries = Array.from({ length: 6 }, (_, i) => ({
  ts: RUN_START + i * 10_000,
  data: PNGB64,
  mime: 'image/png',
  defects: i % 2,
}))
const mesServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://mock')
  const reply = (data: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (url.pathname === '/history-scalar') return reply({ rows: scalarSeries })
  if (url.pathname === '/history-vector') return reply({ rows: vectorSeries })
  if (url.pathname === '/history-image') return reply({ rows: imageSeries })
  // H8 模板试读(rest-scalar:GET /api/tags/{tag})
  if (url.pathname.startsWith('/api/tags/')) return reply({ value: 42.5, timestamp: new Date().toISOString() })
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
})
await new Promise<void>(resolve => mesServer.listen(0, '127.0.0.1', resolve))
const MES_BASE = `http://127.0.0.1:${(mesServer.address() as AddressInfo).port}`

// ---------- 真实平台装配 ----------
const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { getDcwController } = await import('../server/services/workshop/dcw/dcw-controller')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { getDaqController } = await import('../server/services/workshop/daq/daq-controller')
const { getTsdb, tsdbReady } = await import('../server/services/workshop/daq/storage')
const { bridgeMesHistory } = await import('../server/services/workshop/mes/mes-bridge')
const { createMesController } = await import('../server/services/workshop/mes/mes-controller')
const { mesRestDcwDriver } = await import('../server/services/workshop/dcw/drivers/mes-rest')
const { applyMesTemplate, listMesTemplates } = await import('../server/services/workshop/mes/mes-templates')
const { exportDaqDataset, createRunContextResolver } = await import('../server/services/workshop/agents/industrial/daq-export')
const { buildDataset } = await import('../server/services/workshop/aml/dataset-builder')
const { parseDatasetSpec } = await import('../server/services/workshop/aml/spec')

console.log(`\n[异构/MES 验收] AW_HOME=${home} MES=${MES_BASE}`)
const db = openWorkshopDb(join(home, 'hetero.sqlite'))
configureAmlRuntime(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit: createAuditRepo(db),
  approvalRequests: createApprovalRequestRepo(db),
})
await tsdbReady

// ---------- 夹具:产线 / 产品 / 配方 / 批次 ----------
const line = getDcwLineRepo().create({ name: '异构验收线', simulated: false })
const product = getDcwProductRepo().create({ name: '异构验收产品', lineId: line.id })
const recipe = getDcwController().createRecipe({ productId: product.id, name: '异构验收配方', params: [] })
const run = getDcwRecipeRepo().createRun(recipe)
// 批次窗口重写为固定历史窗(便于生成确定性数据;run 仍归属同一配方/产品)
run.startedAt = new Date(RUN_START).toISOString()
run.endedAt = new Date(RUN_END).toISOString()
getDcwRecipeRepo().updateRun(run)

// 控制量:真实 DAQ 节点 + 同窗样本(与 MES 目标共同构成数据集的两列)
const daq = new DaqNode({ id: 'dn-hetero-ctrl', templateRef: 'temp-tc', name: '异构验收·机筒温度', driver: 'mock', intervalMs: 1000, lineId: line.id } as ConstructorParameters<typeof DaqNode>[0])
getDaqNodeRepo().insert(daq)
const ctrlRows = Array.from({ length: 121 }, (_, i) => ({
  nodeId: daq.id,
  tsMs: RUN_START + i * 1000,
  value: 168 + 1.5 * Math.sin(i / 10),
  state: 'ok',
  lineId: line.id,
  productId: product.id,
  recipeId: recipe.id,
  runId: run.id,
}))
await getTsdb().writeSamples(ctrlRows)

// MES 点位:标量目标 / 向量断面 / 图像帧
const ctl = getDcwController()
const mesCfg = (path: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseUrl: MES_BASE,
  allowPrivateHost: 'true',
  rateLimitPerSec: 10,
  historyMap: JSON.stringify({
    method: 'GET',
    path,
    query: {},
    headers: {},
    response: { rowsPath: 'rows[*]', tsPath: 'ts', tsFormat: 'epoch_ms', ...extra },
    maxPages: 10,
  }),
})
const mesScalar = ctl.create({
  name: 'MES·膜厚(标量)', templateRef: 'pressure-sp', driver: 'mes-rest',
  driverConfig: mesCfg('/history-scalar', { valuePath: 'value', format: 'scalar' }),
  min: 0, max: 100, unit: 'um', lineId: line.id, readIntervalMs: 0,
} as Parameters<typeof ctl.create>[0])
const mesVector = ctl.create({
  name: 'MES·膜厚断面(向量)', templateRef: 'pressure-sp', driver: 'mes-rest',
  driverConfig: mesCfg('/history-vector', { valuesPath: 'profile', format: 'vector' }),
  min: 0, max: 1, unit: 'mm', lineId: line.id, readIntervalMs: 0,
} as Parameters<typeof ctl.create>[0])
const mesImage = ctl.create({
  name: 'MES·表检(图像)', templateRef: 'pressure-sp', driver: 'mes-rest',
  driverConfig: mesCfg('/history-image', { dataPath: 'data', mimePath: 'mime', format: 'image' }),
  min: 0, max: 255, unit: 'gray', lineId: line.id, readIntervalMs: 0,
} as Parameters<typeof ctl.create>[0])

// ============================================================
// H1 标量桥接 → AML 数据集
// ============================================================
console.log('\nH1 MES 历史 → TSDB → AML 数据集')
const bridgeScalar = await bridgeMesHistory({
  nodeIds: [mesScalar.id],
  fromIso: new Date(RUN_START).toISOString(),
  toIso: new Date(RUN_END).toISOString(),
  runId: run.id,
})
check('H1-1', '标量历史桥接成功', bridgeScalar.ok, bridgeScalar.text.split('\n')[0] ?? '')
check('H1-2', '写入行数与窗口内数据一致(121)', bridgeScalar.totals.inserted === 121, `inserted=${bridgeScalar.totals.inserted}`)
const bridgeAgain = await bridgeMesHistory({
  nodeIds: [mesScalar.id],
  fromIso: new Date(RUN_START).toISOString(),
  toIso: new Date(RUN_END).toISOString(),
  runId: run.id,
})
check('H1-3', '重复桥接幂等(duplicates=121, inserted=0)', bridgeAgain.totals.duplicates === 121 && bridgeAgain.totals.inserted === 0, JSON.stringify(bridgeAgain.totals))

// 数据集规格:control=DAQ 温度,target=MES 标量(跨源异构)
const spec = parseDatasetSpec({
  lineId: line.id,
  productId: product.id,
  recipeId: recipe.id,
  runIds: [run.id],
  nodes: [
    { nodeId: daq.id, role: 'control' },
    { nodeId: mesScalar.id, role: 'target' },
  ],
  beatMs: 1000,
  window: { historySteps: 5, horizonSteps: 3 },
  split: { valRatio: 0, testRatio: 0, seed: 42 },
  purpose: 'mpc_surrogate',
})
const built = await buildDataset(spec, { id: 'acceptance', kind: 'user' })
check('H1-4', 'AML 数据集构建成功(MES 点位作 target)', built.dataset.rowCount > 0, `dataset=${built.dataset.id} windows=${built.dataset.rowCount}`)
const manifest = JSON.parse(readFileSync(join(built.dataset.path, 'manifest.json'), 'utf8')) as { allNodes: string[] }
check('H1-5', 'manifest 同时含 DAQ 控制量与 MES 目标', manifest.allNodes.includes(daq.id) && manifest.allNodes.includes(mesScalar.id), manifest.allNodes.join(','))

// ============================================================
// H1/H5 向量/图像桥接 + 帧检索面
// ============================================================
console.log('\nH1/H5 向量与图像 → 帧检索面')
const bridgeVector = await bridgeMesHistory({
  nodeIds: [mesVector.id],
  fromIso: new Date(RUN_START).toISOString(),
  toIso: new Date(RUN_END).toISOString(),
  runId: run.id,
  resampleTo: 8,
})
check('H1-6', '向量桥接成功(25 帧)', bridgeVector.ok && bridgeVector.totals.inserted === 25, JSON.stringify(bridgeVector.totals))
const vecFrames = await getDaqController().frames(mesVector.id, { fromMs: RUN_START, toMs: RUN_END, limit: 100 })
check('H5-1', 'MES 向量帧可从 DAQ frames 面检索', vecFrames.length === 25, `frames=${vecFrames.length}`)
check('H5-2', 'resample_to=8 生效(meta.points 8 点)', vecFrames.every(f => (f.points?.length ?? 0) === 8), `first=${vecFrames[0]?.points?.length}`)

const bridgeImage = await bridgeMesHistory({
  nodeIds: [mesImage.id],
  fromIso: new Date(RUN_START).toISOString(),
  toIso: new Date(RUN_END).toISOString(),
  runId: run.id,
})
check('H1-7', '图像桥接成功(6 帧)', bridgeImage.ok && bridgeImage.totals.inserted === 6, JSON.stringify(bridgeImage.totals))
const imgFrames = await getDaqController().frames(mesImage.id, { fromMs: RUN_START, toMs: RUN_END, limit: 20 })
check('H5-3', 'MES 图像帧可从 DAQ frames 面检索', imgFrames.length === 6 && imgFrames.every(f => f.kind === 'image'), `frames=${imgFrames.length}`)
const firstImageAt = imgFrames[0]!.at
const content = await getDaqController().frameContent(mesImage.id, firstImageAt, false)
check('H5-4', 'frameContent 取回图像字节(对象存储)', content.data.length > 0 && content.mime === 'image/png', `${content.data.length}B`)
const thumb = await getDaqController().frameContent(mesImage.id, firstImageAt, true)
check('H5-5', '无缩略图时 thumb=1 回退主图(不 404)', thumb.data.equals(content.data), `${thumb.data.length}B`)
check('H5-6', 'MES 点位产线归属可解析(lineIdOf)', (await getDaqController().lineIdOf(mesImage.id)) === line.id)

// ============================================================
// H2 节点级向量网格
// ============================================================
console.log('\nH2 节点级向量网格覆盖')
const scan = getDaqController().create({
  name: 'H2 测厚(节点级 16 点)', templateRef: 'thickness-scan', driver: 'mock',
  driverConfig: { resamplePoints: 16 }, lineId: line.id, enabled: false,
} as Parameters<ReturnType<typeof getDaqController>['create']>[0])
const scanRuntime = getDaqController() as unknown as {
  processFrameSample: (node: typeof scan, raw: { kind: 'vector', points: number[] }, at: number) => Promise<{ frame: { points?: number[] } } | null>
}
const processed = await scanRuntime.processFrameSample(scan, { kind: 'vector', points: Array.from({ length: 64 }, (_, i) => i / 64) }, Date.now())
check('H2-1', '模板 64 点被节点覆盖为 16 点', (processed?.frame.points?.length ?? 0) === 16, `points=${processed?.frame.points?.length}`)
let badRejected = false
try {
  getDaqController().create({
    name: 'H2 坏配置', templateRef: 'thickness-scan', driver: 'mock',
    driverConfig: { sinkOverrides: '{not json' }, lineId: line.id, enabled: false,
  } as Parameters<ReturnType<typeof getDaqController>['create']>[0])
}
catch (err) {
  badRejected = /sinkOverrides|JSON/i.test(err instanceof Error ? err.message : String(err))
}
check('H2-2', '坏 sinkOverrides 创建即拒(400 级)', badRejected)

// ============================================================
// H3 导出环境/工况列
// ============================================================
console.log('\nH3 导出环境/工况列')
const mesNodeLike = {
  id: mesScalar.id,
  name: mesScalar.name,
  driver: 'mes-rest',
  lineId: line.id,
  unit: 'um',
  min: 0,
  max: 100,
  enabled: true,
  driverConfig: mesScalar.driverConfig as Record<string, string | number | boolean>,
}
const mesController = createMesController({
  nodes: () => [mesNodeLike],
  boundNodeIds: () => new Set([mesScalar.id]),
  resolveDriver: () => mesRestDcwDriver as never,
  nowMs: () => Date.now(),
  store: { createFetchJob: () => ({ jobId: 'j', datasetId: 'd' }) },
})
const mesExport = await mesController.exportData('acceptance-agent', {
  ids: [mesScalar.id],
  from: new Date(RUN_START).toISOString(),
  to: new Date(RUN_END).toISOString(),
  max_rows: 500,
  folder: 'h3',
  with_context: true,
})
const mesCsv = readFileSync(join(mesExport.dir!, mesScalar.id, 'data.csv'), 'utf8').split('\r\n')
check('H3-1', 'MES 导出表头含环境列', mesCsv[0] === 'ts,value,line_id,run_id,product_id,recipe_id', mesCsv[0] ?? '')
check('H3-2', 'MES 导出行级批次打标正确', mesCsv[1]?.split(',')[2] === line.id && mesCsv[1]?.split(',')[3] === run.id, mesCsv[1] ?? '')

const ctxResolver = createRunContextResolver()
const pagedTsdb = getTsdb() as unknown as {
  queryTaggedPage: (id: string, q: Record<string, unknown>) => Promise<{ points: Array<{ at: number, value?: number, state?: string }> }>
}
const daqExport = await exportDaqDataset({
  targets: [daq.id],
  nodeOf: id => ({ id, name: '控制量', unit: '℃', lineId: line.id }),
  readPoints: async (nodeId, win) => {
    const page = await pagedTsdb.queryTaggedPage(nodeId, { fromMs: win.fromMs, toMs: win.toMs, limit: win.limit, withState: true })
    return page.points
  },
  fromMs: RUN_START,
  toMs: RUN_END,
  rootDir: join(home, 'daq-exports'),
  withContext: true,
  contextOf: (nodeId, lineId, ts) => ctxResolver.of(lineId, nodeId, ts),
})
const daqCsv = readFileSync(join(daqExport.dir, 'nodes', `${daq.id}.csv`), 'utf8').split('\r\n')
check('H3-3', 'DAQ 导出表头含环境列', daqCsv[0] === 'ts_iso,ts_ms,value,state,line_id,run_id,product_id,recipe_id', daqCsv[0] ?? '')
check('H3-4', 'DAQ 导出行级批次打标正确', daqCsv[1]?.split(',')[4] === line.id && daqCsv[1]?.split(',')[5] === run.id, daqCsv[1] ?? '')
check('H3-5', 'DAQ 导出流式分页行数完整(121)', daqExport.files[0]?.rows === 121, `rows=${daqExport.files[0]?.rows}`)

// ============================================================
// H8 映射模板库 → 真实试读
// ============================================================
console.log('\nH8 MES 映射模板库')
const templates = listMesTemplates()
check('H8-1', '模板目录 6 个', templates.length === 6, templates.map(t => t.id).join(','))
const applied = applyMesTemplate('rest-scalar', { baseUrl: MES_BASE, tag: 'T1', secretRef: 'acceptance.mes', allowPrivateHost: true })
check('H8-2', '模板生成配置通过形状校验', applied.validation.ok, applied.validation.message)
const testRead = await mesRestDcwDriver.test(applied.driverConfig as Record<string, unknown>)
check('H8-3', '模板配置真实试读成功(42.5)', testRead.ok && /42\.5/.test(testRead.message), testRead.message)

// ---------- 汇总 ----------
const report = {
  at: new Date().toISOString(),
  pass,
  fail,
  failures,
  bridge: { scalar: bridgeScalar.totals, vector: bridgeVector.totals, image: bridgeImage.totals },
  dataset: { id: built.dataset.id, rowCount: built.dataset.rowCount, nodes: manifest.allNodes },
  frames: { vector: vecFrames.length, image: imgFrames.length },
  export: { mes: mesExport.dir, daq: daqExport.dir },
}
const outDir = join(home, 'evidence')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'heterogeneous-mes-report.json'), JSON.stringify(report, null, 2))
// 仓库内证据副本(验收产物可追溯;与 docs/audit 其它套件同构)
try {
  const repoEvidence = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'audit', 'evidence', '2026-11-03-heterogeneous-mes')
  mkdirSync(repoEvidence, { recursive: true })
  writeFileSync(join(repoEvidence, 'report.json'), JSON.stringify(report, null, 2))
}
catch { /* 证据副本失败不改变验收结论 */ }
console.log(`\n[结果] pass=${pass} fail=${fail}`)
mesServer.close()
// Windows:SQLite 句柄未释放时删目录会 EPERM(与科学闭环验收同款处理)
try {
  (db as unknown as { close?: () => void }).close?.()
}
catch { /* 句柄已释放 */ }
try {
  rmSync(home, { recursive: true, force: true })
}
catch { console.log(`[提示] 临时目录未清理:${home}`) }
if (fail > 0) {
  console.error('失败项:')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('[异构/MES 验收] ALL PASS\n')
