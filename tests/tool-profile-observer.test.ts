/**
 * 工具面排除机制单测(产线 Co-Pilot P1:exp-miner / line-doctor 零写观察档位)。
 * 覆盖三层(档位解析依赖频道 profile 行,hostToolsForRole 非纯函数 —— 按可测层尽测):
 * 1) 纯装配层 scopedToolsForObserverProfile(合成目录):两档位的完整工具面断言(含 exp_collect,不依赖其是否已注册);
 * 2) 真实目录层:同一纯函数作用于真实 HOST_TOOLS,断言目录内既有工具按白名单收敛;
 * 3) 端到端注入层 hostToolsForRole:真实 workshop 库 + aml_channel_profiles 行经
 *    getChannelTwinProfile → catalog 分支,断言注入清单零写族(legacy 频道不受影响作对照);
 * 4) 内置模板:seed 含双模板、KNOWLEDGE_BASE_TEMPLATE_IDS 收录、任务书关键纪律在文。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tool-profile-test-'))
delete process.env.AW_BENCH_MODE

const { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES } = await import('../server/services/workshop/agents/tool-classes')
const catalog = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')
const { DEFAULT_CHANNEL_TEMPLATES } = await import('../server/services/workshop/db/database/seed')
const { KNOWLEDGE_BASE_TEMPLATE_IDS } = await import('../server/services/workshop/runtime/manager/channel-templates')

const { HOST_TOOLS, observerAllowedToolNames, scopedToolsForObserverProfile, hostToolsForRole } = catalog

/** 直接写族 = tool-classes 单一声明源 + 治理链真实写入工具(optimization_explore) */
const WRITE_FAMILY = [...HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, 'optimization_explore']

/** 合成目录:覆盖观察读面/协作面/写族/训练族/优化执行族/MES/lead 治理面的代表工具名 */
function syntheticBase() {
  const names = [
    // 观察读面(exp_collect 由经验采集底座注册,此处按名合入验证白名单)
    'ops_log', 'recipe_log', 'recipe_versions', 'line_context', 'dcw_journal', 'daq_query', 'exp_collect',
    // 协作面
    'save_memory', 'search_memory', 'send_cross_channel_message', 'send_message_to_agent', 'poll_messages',
    // 直接写族(7 件)+ 治理链真实写入
    'dcw_control', 'param_control', 'dcw_rollback', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'recipe_apply', 'optimization_explore',
    // 训练/优化执行族与 MES/lead 治理面(观察面不应注入)
    'aml_model_find', 'aml_model_reference', 'aml_leaderboard', 'twin_gate_evaluate', 'twin_trial_run', 'mpc_optimize', 'twin_bayes_optimize', 'twin_snapshot_create',
    'mes_fetch', 'dispatch_task', 'team_grant_nodes', 'aml_job_submit',
  ]
  return names.map(name => ({ name, label: name, description: `测试占位:${name}`, parameters: {} }))
}

function namesOf(tools: Array<{ name: string }>): Set<string> {
  return new Set(tools.map(t => t.name))
}

function assertNoWriteFamily(surface: Set<string>, label: string): void {
  for (const tool of WRITE_FAMILY) {
    assert.ok(!surface.has(tool), `${label} 含写族工具 ${tool}(零写被破坏)`)
  }
}

// ===== 1) 纯装配层:档位 → 工具面(不依赖 host-tools.json 内容) =====

test('exp-miner 纯装配:含观察读面(exp_collect/ops_log/line_context 等)+ 协作面,零写族', () => {
  const surface = namesOf(scopedToolsForObserverProfile('exp-miner', syntheticBase()))
  for (const tool of ['exp_collect', 'ops_log', 'recipe_log', 'recipe_versions', 'line_context', 'dcw_journal', 'daq_query']) {
    assert.ok(surface.has(tool), `exp-miner 缺观察读面工具 ${tool}`)
  }
  for (const tool of ['save_memory', 'search_memory', 'send_cross_channel_message']) {
    assert.ok(surface.has(tool), `exp-miner 缺协作面工具 ${tool}`)
  }
  assertNoWriteFamily(surface, 'exp-miner')
  assert.ok(!surface.has('mes_fetch'), 'exp-miner 不含 MES 工具')
  assert.ok(!surface.has('dispatch_task') && !surface.has('team_grant_nodes'), 'exp-miner 不含 lead 治理面工具')
})

test('line-doctor 纯装配:观察读面 + AML 只读查询面(aml_model_find/reference/gate/leaderboard),零写族且无优化执行族', () => {
  const surface = namesOf(scopedToolsForObserverProfile('line-doctor', syntheticBase()))
  for (const tool of ['ops_log', 'line_context', 'daq_query', 'aml_model_find', 'aml_model_reference', 'aml_leaderboard', 'twin_gate_evaluate']) {
    assert.ok(surface.has(tool), `line-doctor 缺工具 ${tool}`)
  }
  assertNoWriteFamily(surface, 'line-doctor')
  // P1 无优化执行族(model-backed/快照/探索激励全部不给);aml_activity/recipe_propose 本就未注册
  for (const tool of ['twin_trial_run', 'mpc_optimize', 'twin_bayes_optimize', 'twin_snapshot_create']) {
    assert.ok(!surface.has(tool), `line-doctor(P1) 不应含优化执行工具 ${tool}`)
  }
})

test('白名单全集与写族两两不相交(单一声明源不变式)', () => {
  for (const kind of ['exp-miner', 'line-doctor'] as const) {
    const allowed = observerAllowedToolNames(kind)
    for (const tool of WRITE_FAMILY) {
      assert.ok(!allowed.has(tool), `${kind} 白名单混入写族工具 ${tool}`)
    }
  }
})

// ===== 2) 真实目录层:白名单作用于真实 HOST_TOOLS =====

test('真实 HOST_TOOLS 按白名单收敛:读面/协作面保留,目录内写族不注入', () => {
  assert.ok(HOST_TOOLS.length > 0, 'HOST_TOOLS 应已加载(host-tools.json)')
  for (const kind of ['exp-miner', 'line-doctor'] as const) {
    const surface = namesOf(scopedToolsForObserverProfile(kind, HOST_TOOLS))
    assert.ok(surface.has('ops_log') && surface.has('line_context') && surface.has('daq_query'), `${kind} 真实目录装配缺观察读面`)
    assert.ok(surface.has('save_memory') && surface.has('send_cross_channel_message'), `${kind} 真实目录装配缺协作面`)
    assertNoWriteFamily(surface, `${kind}(真实目录)`)
  }
  // exp_collect 由并行改动(经验采集底座)注册:已注册则必须注入;未注册时白名单覆盖已在纯装配层断言
  if (HOST_TOOLS.some(t => t.name === 'exp_collect')) {
    assert.ok(namesOf(scopedToolsForObserverProfile('exp-miner', HOST_TOOLS)).has('exp_collect'), 'exp_collect 已注册但未注入 exp-miner')
  }
})

// ===== 3) 端到端注入层:真实库 + 频道 profile 行 → hostToolsForRole =====

const db = openWorkshopDb(join(process.env.AW_HOME!, 'tool-profile-test.sqlite'))
configureAmlRuntime(db)
const insertChannel = db.prepare('INSERT OR IGNORE INTO channels (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
const mkChannel = (id: string, name: string) => {
  const now = new Date().toISOString()
  insertChannel.run(id, name, 'tool-profile-observer-test', now, now)
  return id
}
const chMiner = mkChannel('tp-test-exp-miner', '经验工程师测试频道')
const chDoctor = mkChannel('tp-test-line-doctor', '诊断工程师测试频道')
const chLegacy = mkChannel('tp-test-legacy', 'legacy 对照频道')
for (const [channelId, profile] of [[chMiner, 'exp-miner'], [chDoctor, 'line-doctor']] as const) {
  setHybridChannelProfile({ channelId, profile, capability: { observer: true }, controlPolicy: 'recommendation_only', createdBy: 'test' })
}

test('hostToolsForRole:exp-miner 频道注入清单含读面/协作面,零写族', () => {
  const surface = namesOf(hostToolsForRole('lead', chMiner))
  assert.ok(surface.has('ops_log') && surface.has('line_context') && surface.has('daq_query'), 'exp-miner 注入清单缺观察读面')
  assert.ok(surface.has('save_memory') && surface.has('search_memory') && surface.has('send_cross_channel_message'), 'exp-miner 注入清单缺协作面')
  assertNoWriteFamily(surface, 'exp-miner(端到端)')
})

test('hostToolsForRole:line-doctor 频道含 AML 只读面,零写族且无优化执行族', () => {
  const surface = namesOf(hostToolsForRole('lead', chDoctor))
  for (const tool of ['aml_model_find', 'aml_model_reference', 'twin_gate_evaluate', 'daq_query']) {
    assert.ok(surface.has(tool), `line-doctor 注入清单缺 ${tool}`)
  }
  assertNoWriteFamily(surface, 'line-doctor(端到端)')
  assert.ok(!surface.has('optimization_explore'), 'line-doctor 不含治理写入工具 optimization_explore')
})

test('hostToolsForRole:legacy 频道工具面不受观察面白名单影响(对照回归)', () => {
  const surface = namesOf(hostToolsForRole('lead', chLegacy))
  assert.ok(!surface.has('dcw_control') && !surface.has('param_control'), '权限模型 v2:直写工具已从工具面摘除')
  assert.ok(surface.has('recipe_update') && surface.has('recipe_apply'), 'legacy 频道保持配方操作面')
})

// ===== 4) 内置模板:双模板 + KB 名单 + 任务书纪律 =====

test('seed 内置模板含经验工程师/产线诊断工程师,任务书关键纪律在文', () => {
  const miner = DEFAULT_CHANNEL_TEMPLATES.find(t => t.id === 'chtpl-exp-miner-default')
  const doctor = DEFAULT_CHANNEL_TEMPLATES.find(t => t.id === 'chtpl-line-doctor-default')
  assert.ok(miner && miner.name === '经验工程师', 'seed 缺 chtpl-exp-miner-default(经验工程师)')
  assert.ok(doctor && doctor.name === '产线诊断工程师', 'seed 缺 chtpl-line-doctor-default(产线诊断工程师)')
  // exp-miner 任务书:采集/待确认不总结/三元组/置信度演化/入库确认/诚实性纪律
  for (const marker of [/exp_collect/, /待确认/, /绝不总结/, /kb_agent\(mode=async\)/, /kb_agent_status/, /置信/, /取代《/, /不总结/]) {
    assert.match(miner!.scenarioPrompt, marker, `exp-miner 任务书缺关键纪律:${marker}`)
  }
  // line-doctor 任务书:轻巡/每日诊断/建议报告/P2 预留段
  for (const marker of [/line_context/, /diag_run\(/, /diag_status/, /仅建议/, /recipe_propose/, /runId/, /不得原样重提/]) {
    assert.match(doctor!.scenarioPrompt, marker, `line-doctor 任务书缺关键段落:${marker}`)
  }
})

test('双模板 id 已入 KNOWLEDGE_BASE_TEMPLATE_IDS(KB 作业段随 enableKnowledgeBase 追加)', () => {
  assert.ok(KNOWLEDGE_BASE_TEMPLATE_IDS.has('chtpl-exp-miner-default'), 'chtpl-exp-miner-default 未入 KB 名单')
  assert.ok(KNOWLEDGE_BASE_TEMPLATE_IDS.has('chtpl-line-doctor-default'), 'chtpl-line-doctor-default 未入 KB 名单')
})
