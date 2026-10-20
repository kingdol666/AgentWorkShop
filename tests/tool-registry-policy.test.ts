/**
 * 工具注册表 + Channel 级策略单测(2026-10-20)。
 *
 * 覆盖:
 *  - 内置/插件元数据入库、幂等、卸载 available=0
 *  - all/selected 两种选择语义
 *  - 硬规则不可被 Channel 打开(observer 零写 / worker lead-only)
 *  - 执行闸门:停用工具 direct dispatch 必须 isError
 *  - 透明化视图的 effective/reason/stats
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-tool-registry-test-'))
delete process.env.AW_BENCH_MODE

const { HOST_TOOLS, hostToolsForRole, scopeHostToolsForRole } = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
const { registerPluginTool, unregisterPluginTools } = await import('../server/services/workshop/agents/plugin-tools')
const { getToolRegistryRepo } = await import('../server/services/workshop/db/tool-registry.repo')
const { syncToolRegistry, buildToolRegistrySnapshot } = await import('../server/services/workshop/tools/registry')
const { buildChannelToolView, buildGlobalToolView } = await import('../server/services/workshop/tools/catalog-view')
const { channelToolGate } = await import('../server/services/workshop/tools/policy')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { setHybridChannelProfile } = await import('../server/services/workshop/aml/twin/channel-profile')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'tool-registry-test.sqlite'))
configureAmlRuntime(db)

const now = new Date().toISOString()
const insertChannel = db.prepare('INSERT OR IGNORE INTO channels (id, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
function mkChannel(id: string, name: string): string {
  insertChannel.run(id, name, 'tool-registry-policy-test', now, now)
  return id
}

const chLegacy = mkChannel('trp-legacy', 'legacy 工具策略测试')
const chObserver = mkChannel('trp-observer', 'observer 工具策略测试')
setHybridChannelProfile({
  channelId: chObserver,
  profile: 'exp-miner',
  capability: { observer: true },
  controlPolicy: 'recommendation_only',
  createdBy: 'test',
})

const repo = getToolRegistryRepo()
const names = (tools: Array<{ name: string }>) => new Set(tools.map(t => t.name))

test('registry sync:内置全量入库,插件工具登记后可见', () => {
  const first = syncToolRegistry('test-initial')
  assert.equal(first.builtin, HOST_TOOLS.length, '内置工具数应与 host-tools.json 一致')
  assert.ok(repo.counts().total >= HOST_TOOLS.length, '目录总数至少覆盖内置工具')

  registerPluginTool('trp-test-plugin', {
    name: 'trp_plugin_echo',
    label: 'TRP Echo',
    description: '测试插件工具:回显输入',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    roles: ['lead', 'worker'],
    handler: async args => ({ text: `echo:${String(args.text ?? '')}` }),
  })
  const second = syncToolRegistry('test-plugin')
  assert.ok(second.plugin >= 1, '插件工具应进入目录')
  const row = repo.get('trp_plugin_echo')
  assert.ok(row, '插件工具行应存在')
  assert.equal(row.source, 'plugin')
  assert.equal(row.pluginName, 'trp-test-plugin')
  assert.deepEqual(row.roles, ['lead', 'worker'])
  assert.ok(names(hostToolsForRole('lead')).has('trp_plugin_echo'), '无策略时插件工具应注入')
})

test('registry sync:幂等且 hash 未变不推进 updated_at', async () => {
  const before = repo.get('trp_plugin_echo')!
  await new Promise(r => setTimeout(r, 10))
  syncToolRegistry('test-idempotent')
  const after = repo.get('trp_plugin_echo')!
  assert.equal(after.updatedAt, before.updatedAt, '定义未变时 updated_at 不应漂移')
  assert.ok(after.lastSeenAt >= before.lastSeenAt, 'last_seen_at 应刷新')
})

test('registry sync:插件卸载后 available=0,重新注册恢复', () => {
  unregisterPluginTools('trp-test-plugin')
  syncToolRegistry('test-unregister')
  assert.equal(repo.get('trp_plugin_echo')?.available, false, '卸载后应标记 unavailable')
  assert.ok(!names(hostToolsForRole('lead')).has('trp_plugin_echo'), '卸载后不应再注入')

  registerPluginTool('trp-test-plugin', {
    name: 'trp_plugin_echo',
    description: '测试插件工具:回显输入',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    roles: ['lead', 'worker'],
    handler: async args => ({ text: `echo:${String(args.text ?? '')}` }),
  })
  syncToolRegistry('test-reregister')
  assert.equal(repo.get('trp_plugin_echo')?.available, true, '重新注册后应恢复 available')
})

test('all 模式:停用 daq_query 后注入面/执行闸门同时生效,重置恢复', async () => {
  assert.ok(names(hostToolsForRole('lead', chLegacy)).has('daq_query'), '默认应注入 daq_query')
  repo.savePolicy(chLegacy, 'all', [
    { name: 'daq_query', enabled: false },
    { name: 'analysis_query', enabled: false },
  ], 'tester')
  assert.ok(!names(hostToolsForRole('lead', chLegacy)).has('daq_query'), '停用后不应注入 daq_query')
  assert.ok(names(hostToolsForRole('lead', chLegacy)).has('recipe_update'), '未停用工具不受影响')

  const gate = channelToolGate(chLegacy, 'daq_query')
  assert.equal(gate.blocked, true)
  assert.equal(gate.reason, 'CHANNEL_TOOL_DISABLED')
  assert.match(gate.message ?? '', /本 Channel 已在「设置 → 工具」中停用/)

  repo.resetPolicy(chLegacy)
  assert.ok(names(hostToolsForRole('lead', chLegacy)).has('daq_query'), '重置后应恢复注入')
})

test('selected 模式:仅勾选工具注入,缺省即停用', () => {
  repo.savePolicy(chLegacy, 'selected', [
    { name: 'report_progress', enabled: true },
    { name: 'complete_task', enabled: true },
  ], 'tester')
  const surface = names(hostToolsForRole('lead', chLegacy))
  assert.ok(surface.has('report_progress') && surface.has('complete_task'), '勾选工具应保留')
  assert.ok(!surface.has('daq_query'), '未勾选工具应停用')

  const view = buildChannelToolView(chLegacy)
  assert.equal(view.mode, 'selected')
  assert.equal(view.source, 'explicit')
  const daq = view.tools.find(t => t.name === 'daq_query')
  assert.ok(daq, '视图应包含未勾选工具')
  assert.equal(daq.channelEnabled, false)
  assert.equal(daq.effective.lead, false)
  assert.equal(daq.eligibility.lead.reason, 'CHANNEL_TOOL_DISABLED')

  repo.resetPolicy(chLegacy)
})

test('硬规则:observer 档位不能通过 Channel 选择打开写工具', () => {
  repo.savePolicy(chObserver, 'selected', [
    { name: 'recipe_update', enabled: true },
    { name: 'recipe_apply', enabled: true },
  ], 'tester')
  const surface = names(hostToolsForRole('lead', chObserver))
  assert.ok(!surface.has('recipe_update') && !surface.has('recipe_apply'), 'observer 注入面必须零写')

  const view = buildChannelToolView(chObserver)
  for (const name of ['recipe_update', 'recipe_apply']) {
    const row = view.tools.find(t => t.name === name)
    assert.ok(row, `视图应包含 ${name}`)
    assert.equal(row.eligibility.lead.eligible, false)
    assert.equal(row.effective.lead, false)
    assert.equal(row.eligibility.lead.reason, 'WRITE_GUARD')
  }
  repo.resetPolicy(chObserver)
})

test('硬规则:worker 的 lead-only 工具记录 ROLE_DENIED,lead 正常', () => {
  const workerScope = scopeHostToolsForRole('worker', chLegacy)
  assert.ok(!workerScope.tools.some(t => t.name === 'submit_task'))
  assert.equal(workerScope.excluded.get('submit_task')?.reason, 'ROLE_DENIED')
  assert.ok(scopeHostToolsForRole('lead', chLegacy).tools.some(t => t.name === 'submit_task'))
})

test('透明化视图:全局目录含内置与插件工具,统计一致', () => {
  const view = buildGlobalToolView()
  assert.ok(view.stats.total >= HOST_TOOLS.length)
  assert.equal(view.stats.builtin, HOST_TOOLS.length)
  assert.ok(view.stats.plugin >= 1)
  assert.ok(view.tools.some(t => t.name === 'daq_query' && t.source === 'builtin'))
  assert.ok(view.tools.some(t => t.name === 'trp_plugin_echo' && t.source === 'plugin'))
})

test('快照构建:插件同名内置时内置优先', () => {
  registerPluginTool('trp-test-plugin', {
    name: HOST_TOOLS[0]!.name,
    description: '同名覆盖测试',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ text: 'shadow' }),
  })
  const snapshot = buildToolRegistrySnapshot()
  const rows = snapshot.filter(r => r.name === HOST_TOOLS[0]!.name)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.source, 'builtin', '同名工具目录必须归内置')
  unregisterPluginTools('trp-test-plugin')
  // 清理后重新注册回显工具,避免影响后续文件/定时同步
  registerPluginTool('trp-test-plugin', {
    name: 'trp_plugin_echo',
    description: '测试插件工具:回显输入',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    roles: ['lead', 'worker'],
    handler: async args => ({ text: `echo:${String(args.text ?? '')}` }),
  })
  syncToolRegistry('test-cleanup')
})

test('策略仓储:removeForChannel 清理策略与行', () => {
  repo.savePolicy(chLegacy, 'all', [{ name: 'daq_query', enabled: false }], 'tester')
  assert.equal(repo.snapshot(chLegacy).source, 'explicit')
  repo.removeForChannel(chLegacy)
  assert.equal(repo.snapshot(chLegacy).source, 'default')
})
