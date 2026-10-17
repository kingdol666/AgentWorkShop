/**
 * tool-verify 单测(不联网):工业工具调用的统一预检 ——
 *   ① 引用归属:未绑定节点(用户场景:绑了 1 号节点,传 2 号)→ 拒绝且文案可行动(列绑定面);
 *      绑定内节点 → 放行;同线未绑定节点、无频道绑线 → 拒绝(与 daqTargetsOf 同源口径);
 *      频道绑线只读扩权:绑线数采节点(未绑定)可读,他线仍拒;
 *      配方面:绑定配方可操作,他线配方拒;链式:跨线数据集拒、本人/本线数据集放行;
 *   ② 参数形状:缺必填引用(dcw_journal 无参)、非字符串 ID → 拒绝(hint 说明该传什么);
 *   ③ 拒绝入册:授权性拒绝写 audit_log(action=tool.call.denied);
 *   ④ 零回归面:无引用参数的工具(my_industrial_nodes)不受预检影响。
 *
 * 分发层全路径(dispatchHostTool → verify → handler)不在本文件:host-tool-bridge 依赖链
 * 会拉入 nitro 专有 `#imports`(server/utils/config),测试环境无法加载 —— 该接线由
 * tmp-e2e 真实实例验收覆盖(REST invoke 走同一分发入口)。
 *
 * 环境策略同 recipe-op-interval: AW_MODE=home + AW_HOME 临时目录 + 临时 sqlite,
 * manager 用最小 stub(channelLineBindingOf + channels.findById)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const awHome = mkdtempSync(join(tmpdir(), 'aw-tool-verify-test-'))
process.env.AW_HOME = awHome
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const { createAlarmEventRepo, createApprovalHistoryRepo, createApprovalRequestRepo, createAuditRepo } = await import('../server/services/workshop/db/ops.repo')
const { getAgentNodeBindingRepo } = await import('../server/services/workshop/agents/node-bindings.repo')
const { getDcwNodeRepo } = await import('../server/services/workshop/dcw/dcw-node.repo')
const { getDaqNodeRepo } = await import('../server/services/workshop/daq/daq-node.repo')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
const { getDcwProductRepo } = await import('../server/services/workshop/dcw/dcw-product.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')
const { DcwNode } = await import('../server/services/workshop/dcw/dcw-node')
const { DaqNode } = await import('../server/services/workshop/daq/daq-node')
const { createAmlRepo } = await import('../server/services/workshop/aml/aml.repo')
const { verifyIndustrialToolCall, resolveRefFaces } = await import('../server/services/workshop/agents/industrial/tool-verify')
const { toolMyIndustrialNodes } = await import('../server/services/workshop/agents/industrial/dcw-tools')

const db = openWorkshopDb(join(awHome, 'data', 'tool-verify-test.sqlite'))
const audit = createAuditRepo(db)
bindOpsRepos({
  approvalHistory: createApprovalHistoryRepo(db),
  alarmEvents: createAlarmEventRepo(db),
  audit,
  approvalRequests: createApprovalRequestRepo(db),
})

// AML 运行时最小 stub(dataset 链式解析要读四表仓储;其余字段未用)
const g = globalThis as typeof globalThis & { __amlRuntime?: unknown, __workshopManager?: unknown }
g.__amlRuntime = {
  db,
  root: awHome,
  rootMode: 'test',
  projectRoot: null,
  repo: createAmlRepo(db),
  datasetsDir: '',
  jobsDir: '',
  modelsDir: '',
  venvDir: '',
  toolsDir: '',
  runtimeDir: '',
}

// ---------- fixtures:两条产线 + 各线节点/配方 ----------

const lineA = getDcwLineRepo().create({ name: '校验线A' })
const lineB = getDcwLineRepo().create({ name: '校验线B' })

const mkDcw = (id: string, lineId: string): DcwNode =>
  new DcwNode({ id, lineId, templateRef: 'dcw-temp-sp', driver: 'mock', name: `数控-${id}`, min: 0, max: 100, unit: '℃', decimals: 1 })
const mkDaq = (id: string, lineId: string): DaqNode =>
  new DaqNode({ id, lineId, templateRef: 'daq-temp', driver: 'mock', name: `数采-${id}`, unit: '℃', min: 0, max: 100, decimals: 1 })

const dwA = mkDcw('dw-va', lineA.id)
const dwB = mkDcw('dw-vb', lineB.id)
const dnA = mkDaq('dn-va', lineA.id)
const dnA2 = mkDaq('dn-va2', lineA.id) // 同线未绑定(验证「同线不等于可见」)
const dnB = mkDaq('dn-vb', lineB.id)
for (const n of [dwA, dwB]) getDcwNodeRepo().insert(n)
for (const n of [dnA, dnA2, dnB]) getDaqNodeRepo().insert(n)

const productA = getDcwProductRepo().create({ name: '校验产品A', lineId: lineA.id })
const productB = getDcwProductRepo().create({ name: '校验产品B', lineId: lineB.id })
const rcA = getDcwRecipeRepo().create({ name: '校验配方A', productId: productA.id, params: [{ nodeId: dwA.id, value: 50 }] })
const rcB = getDcwRecipeRepo().create({ name: '校验配方B', productId: productB.id, params: [{ nodeId: dwB.id, value: 50 }] })

// 频道绑线只读扩权:仅 ag-chan 的频道绑定「校验线A」
g.__workshopManager = {
  channelLineBindingOf: (agentId: string) => (agentId === 'ag-chan' ? lineA.id : null),
  deps: { repos: { channels: { findById: (_: string) => ({ name: '校验频道' }) } } },
}

const repo = getAgentNodeBindingRepo()
// 用户场景:worker 只绑了「1 号」数采节点(+ 一个数控节点用于 journal 正例)
repo.bind('ag-w', dnA.id, 'daq', 'auto')
repo.bind('ag-w', dwA.id, 'dcw', 'auto')
repo.bind('ag-chan', dnA.id, 'daq', 'auto')
repo.bind('ag-r', rcA.id, 'recipe', 'auto')

// ---------- ① 引用归属:节点面(用户场景) ----------

test('user scenario: worker 绑 1 号节点、传 2 号节点(他线)→ 拒绝且文案列出绑定面', () => {
  const r = verifyIndustrialToolCall('ag-w', 'daq_query', { node_id: dnB.id })
  assert.ok(r, '越界节点必须被预检拦截')
  assert.equal(r!.isError, true)
  assert.match(r!.text, /引用校验/)
  assert.match(r!.text, new RegExp(dnB.id))
  assert.match(r!.text, new RegExp(dnA.id), '文案必须列出你的绑定节点(让 Agent 能自我纠正)')
  assert.match(r!.text, /归属产线/)
})

test('user scenario: 同线但未绑定的 2 号节点、且频道未绑线 → 同样拒绝(未绑定不等于可见)', () => {
  const r = verifyIndustrialToolCall('ag-w', 'daq_query', { node_id: dnA2.id })
  assert.ok(r)
  assert.equal(r!.isError, true)
  assert.match(r!.text, new RegExp(dnA2.id))
})

test('绑定面内节点放行(node/line 引用均通过)', () => {
  assert.equal(verifyIndustrialToolCall('ag-w', 'daq_query', { node_id: dnA.id }), null)
  assert.equal(verifyIndustrialToolCall('ag-w', 'daq_query', { line_id: lineA.id }), null)
  assert.equal(verifyIndustrialToolCall('ag-w', 'ops_log', { node_id: dwA.id }), null)
  assert.equal(verifyIndustrialToolCall('ag-w', 'dcw_journal', { node_id: dwA.id }), null)
})

test('不存在的节点:拒绝文案与「未授权」区分(提示核对 id)', () => {
  const r = verifyIndustrialToolCall('ag-w', 'daq_query', { node_id: 'dn-ghost' })
  assert.ok(r)
  assert.match(r!.text, /节点不存在或已删除/)
})

test('频道绑线只读扩权:绑线数采节点(未绑定)可读;他线节点仍拒', () => {
  assert.equal(verifyIndustrialToolCall('ag-chan', 'daq_query', { node_id: dnA2.id }), null, '绑线扩权:同线数采节点可读')
  const r = verifyIndustrialToolCall('ag-chan', 'daq_query', { node_id: dnB.id })
  assert.ok(r, '他线节点不在任何面内')
  assert.match(r!.text, /频道绑线/)
})

test('nodes[] 深路径与 arrays:aml_dataset_build 逐节点校验', () => {
  const ok = verifyIndustrialToolCall('ag-w', 'aml_dataset_build', { line_id: lineA.id, nodes: [{ node_id: dnA.id, role: 'target' }, { node_id: 'dn-ghost', role: 'feature' }] })
  assert.ok(ok, '含越界节点的 nodes[] 必须拒绝')
  assert.match(ok!.text, /dn-ghost/)
})

test('配方面:绑定配方可操作;他线配方(未绑定/不可读)拒', () => {
  assert.equal(verifyIndustrialToolCall('ag-r', 'recipe_apply', { recipe_id: rcA.id }), null)
  const r = verifyIndustrialToolCall('ag-r', 'recipe_apply', { recipe_id: rcB.id })
  assert.ok(r)
  assert.match(r!.text, /配方/)
  assert.match(r!.text, /你绑定的配方/)
})

// ---------- ② 参数形状 ----------

test('dcw_journal:无参(此前返回全量记录)与越界 node_id 均拒,越界文案列可查对象', () => {
  const missing = verifyIndustrialToolCall('ag-w', 'dcw_journal', {})
  assert.ok(missing)
  assert.match(missing!.text, /node_id 或 recipe_id 至少提供一个/)
  const out = verifyIndustrialToolCall('ag-w', 'dcw_journal', { node_id: dnB.id })
  assert.ok(out)
  assert.match(out!.text, /引用校验/)
})

test('形状:引用参数非字符串 → 拒绝并说明应为字符串 ID', () => {
  const r = verifyIndustrialToolCall('ag-w', 'daq_query', { node_id: { id: dnA.id } as unknown as string })
  assert.ok(r)
  assert.match(r!.text, /必须是字符串 ID/)
})

// ---------- ③ 拒绝入册 ----------

test('授权性拒绝写入 audit_log(tool.call.denied),形状类拒绝不入册', () => {
  const rows = db.prepare(`SELECT action, target_id, detail_json FROM audit_log WHERE action = 'tool.call.denied' ORDER BY at DESC`).all() as Array<{ action: string, target_id: string, detail_json: string }>
  assert.ok(rows.length > 0, '越界拒绝应入册')
  const last = rows[0]!
  assert.ok(['daq_query', 'dcw_journal', 'aml_dataset_build', 'recipe_apply'].includes(last.target_id), `target_id=${last.target_id}`)
  assert.match(String(last.detail_json), /"param"/)
  const shapeRows = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.call.denied' AND detail_json LIKE '%必须是字符串%'`).all() as Array<{ n: number }>
  assert.equal(shapeRows[0]!.n, 0, '形状类拒绝不应入册(避免噪音)')
})

// ---------- ⑤ 链式引用(AML 谱系) ----------

test('链式:跨线数据集拒(谱系回溯到产线),本人数据集放行', () => {
  const amlRepo = createAmlRepo(db)
  const row = (id: string, lineId: string, createdBy: string) => ({
    id, lineId, productId: 'p-1', recipeId: 'r-1', runIds: [] as string[], specJson: '{}', sha256: 'x',
    rowCount: 1, fromMs: null, toMs: null, path: '', createdBy, createdByKind: 'agent', note: '', createdAt: new Date().toISOString(),
  })
  amlRepo.dataset.insert(row('ads-mine', lineA.id, 'ag-w'))
  amlRepo.dataset.insert(row('ads-foreign', lineB.id, 'ag-other'))
  assert.equal(verifyIndustrialToolCall('ag-w', 'aml_dataset_stats', { dataset_id: 'ads-mine' }), null)
  const r = verifyIndustrialToolCall('ag-w', 'aml_dataset_stats', { dataset_id: 'ads-foreign' })
  assert.ok(r)
  assert.match(r!.text, /越出你的数据范围/)
  assert.match(r!.text, /可读产线/)
})

// ---------- ⑥ 零回归面 ----------

test('无引用参数的工具不受预检影响(my_industrial_nodes 原样进入 handler)', async () => {
  assert.equal(verifyIndustrialToolCall('ag-w', 'my_industrial_nodes', {}), null)
  const text = (await toolMyIndustrialNodes('ag-w')).text
  assert.match(text, /通用规则/)
  const zero = (await toolMyIndustrialNodes('ag-nobind')).text
  assert.match(zero, /尚未绑定/, '零绑定 agent 仍走工具自身的引导文案')
})

// ---------- ⑦ 面自检(供后续回归) ----------

test('resolveRefFaces:绑定面/可读线/配方面/频道绑线面一致', () => {
  const f = resolveRefFaces('ag-w')
  assert.ok(f.boundNodes.has(dnA.id) && f.boundNodes.has(dwA.id))
  assert.ok(f.daqBoundNodes.has(dnA.id) && !f.daqBoundNodes.has(dwA.id))
  assert.ok(f.readableLines.has(lineA.id))
  assert.ok(!f.readableLines.has(lineB.id))
  const fc = resolveRefFaces('ag-chan')
  assert.equal(fc.channelLineId, lineA.id)
  assert.ok(fc.channelLineNodes.has(dnA2.id), '绑线数采节点进只读扩权面')
  const fr = resolveRefFaces('ag-r')
  assert.ok(fr.boundRecipes.has(rcA.id))
  assert.ok(fr.boundNodes.has(dwA.id), '配方参数节点进绑定面')
})
