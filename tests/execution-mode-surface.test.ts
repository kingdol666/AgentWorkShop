/**
 * 频道执行模式 observe —— 注入面/白名单派生单测(2026-10-28 三模式计划 M2)。
 * 覆盖:① 派生集 ⊆ 手工白名单 ∪ MES 只读 且 ∩ 写族 = ∅(单一声明源不变式);
 *      ② 端到端 hostToolsForRole:legacy 频道置 executionMode='observe' 后注入清单零写族、
 *        读面+MES 只读在,excluded 透明化原因存在;切回 auto 后恢复(联动可逆);
 *      ③ observe 优先于 profile 档位(更强收紧)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-execmode-surface-test-'))
delete process.env.AW_BENCH_MODE

const { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, MES_READ_TOOL_NAMES } = await import('../server/services/workshop/agents/tool-classes')
const catalog = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')

const { HOST_TOOLS, observerAllowedToolNames, observeModeAllowedToolNames, hostToolsForRole } = catalog

const WRITE_FAMILY = [...HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, 'optimization_explore', 'line_start', 'line_stop', 'recipe_propose']

function namesOf(tools: Array<{ name: string }>): Set<string> {
  return new Set(tools.map(t => t.name))
}

test('observeModeAllowedToolNames:与写族两两不相交,且 ⊆ 角色观察白名单 ∪ MES 只读(超集断言)', () => {
  const observe = observeModeAllowedToolNames()
  const manualUnion = new Set([...observerAllowedToolNames('exp-miner'), ...observerAllowedToolNames('line-doctor'), ...MES_READ_TOOL_NAMES])
  for (const tool of WRITE_FAMILY) {
    assert.ok(!observe.has(tool), `observe 白名单混入产线操作工具 ${tool}`)
  }
  for (const tool of observe) {
    assert.ok(manualUnion.has(tool), `observe 派生集越出 白名单∪MES只读:${tool}`)
  }
})

test('observeModeAllowedToolNames:含 MES 只读族(G3)与读面核心', () => {
  const observe = observeModeAllowedToolNames()
  for (const tool of ['mes_catalog', 'mes_fetch', 'mes_export', 'mes_dataset_read', 'mes_datasets']) {
    assert.ok(observe.has(tool), `observe 缺 MES 只读工具 ${tool}`)
  }
  for (const tool of ['ops_log', 'line_context', 'daq_query', 'recipe_versions', 'dcw_journal', 'analysis_query']) {
    assert.ok(observe.has(tool), `observe 缺读面工具 ${tool}`)
  }
})

// ===== 端到端:真实库 + execution_mode 行 → hostToolsForRole =====

const db = openWorkshopDb(join(process.env.AW_HOME!, 'execmode-surface-test.sqlite'))
configureAmlRuntime(db)
const insertChannel = db.prepare('INSERT OR IGNORE INTO channels (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
const mkChannel = (id: string, name: string) => {
  const now = new Date().toISOString()
  insertChannel.run(id, name, 'execmode-surface-test', now, now)
  return id
}
const chObserve = mkChannel('em-test-observe', '观察模式测试频道')
const chAuto = mkChannel('em-test-auto', 'auto 对照频道')
setHybridChannelProfile({ channelId: chObserve, profile: 'legacy', capability: {}, controlPolicy: 'recommendation_only', executionMode: 'observe', createdBy: 'test' })
setHybridChannelProfile({ channelId: chAuto, profile: 'legacy', capability: {}, controlPolicy: 'recommendation_only', executionMode: 'auto', createdBy: 'test' })

test('hostToolsForRole:observe 频道注入清单零写族,读面/MES 只读在,配方操作面摘除', () => {
  assert.ok(HOST_TOOLS.length > 0, 'HOST_TOOLS 应已加载(host-tools.json)')
  const surface = namesOf(hostToolsForRole('lead', chObserve))
  for (const tool of WRITE_FAMILY) {
    assert.ok(!surface.has(tool), `observe 频道注入了产线操作工具 ${tool}`)
  }
  assert.ok(!surface.has('recipe_update') && !surface.has('recipe_apply'), 'observe 频道不含配方操作面')
  assert.ok(surface.has('ops_log') && surface.has('daq_query') && surface.has('line_context'), 'observe 频道缺观察读面')
  assert.ok(surface.has('mes_fetch'), 'observe 频道缺 MES 只读族')
})

test('hostToolsForRole:auto 对照频道保持 legacy 配方操作面(中性缺省零行为变化)', () => {
  const surface = namesOf(hostToolsForRole('lead', chAuto))
  assert.ok(surface.has('recipe_update') && surface.has('recipe_apply'), 'auto(中性)频道应保持配方操作面')
  assert.ok(!surface.has('dcw_control') && !surface.has('param_control'), '权限模型 v2:直写工具已从工具面摘除(两模式一致)')
})

test('hostToolsForRole:observe 优先于角色档位(observe + exp-miner 档位叠加仍零写,AML 附加面一并摘除)', () => {
  const chBoth = mkChannel('em-test-observe-miner', '观察×经验工程师叠加频道')
  setHybridChannelProfile({ channelId: chBoth, profile: 'exp-miner', capability: {}, controlPolicy: 'recommendation_only', executionMode: 'observe', createdBy: 'test' })
  const surface = namesOf(hostToolsForRole('lead', chBoth))
  for (const tool of WRITE_FAMILY) {
    assert.ok(!surface.has(tool), `叠加频道注入了产线操作工具 ${tool}`)
  }
})
