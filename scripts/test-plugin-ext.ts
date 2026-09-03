/**
 * 插件扩展面单元测试:omp 插件工具(桥/合并/分发/热注入)+ 插件 DAQ 模板(桥/覆盖/REST 守卫)。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-plugin-ext.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import {
  hostToolsForRole,
} from '../server/services/workshop/agents/omp-agent'
import { attachOmpPluginBridge, registerPluginTool, onPluginToolsChange, listPluginTools } from '../server/services/workshop/agents/plugin-tools'
import { getDaqTemplateRegistry, findDaqTemplate } from '../server/services/workshop/daq/daq-templates'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// 全局桥接管(模拟 host.mjs 先行的装载顺序)
attachOmpPluginBridge()

// ===== omp 插件工具:注册 → 合并进角色工具面 =====
console.log('\n--- omp 插件工具注册与合并 ---')
{
  registerPluginTool('demo-plugin', {
    name: 'plugin_echo',
    description: '回显测试工具',
    parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    handler: args => ({ text: `echo:${String(args.msg ?? '')}` }),
  })
  registerPluginTool('demo-plugin', {
    name: 'plugin_lead_only',
    description: '仅 lead 可见的工具',
    parameters: { type: 'object', properties: {} },
    roles: ['lead'],
    handler: () => ({ text: 'lead tool' }),
  })

  const lead = hostToolsForRole('lead')
  const worker = hostToolsForRole('worker')
  check('lead 工具面含 plugin_echo', lead.some(t => t.name === 'plugin_echo'))
  check('worker 工具面含 plugin_echo(缺省双角色)', worker.some(t => t.name === 'plugin_echo'))
  check('roles 过滤:plugin_lead_only 仅 lead 可见', lead.some(t => t.name === 'plugin_lead_only') && !worker.some(t => t.name === 'plugin_lead_only'))
  check('内置工具不因插件合并丢失', lead.some(t => t.name === 'complete_task') && lead.some(t => t.name === 'daq_frames'))

  // 分发(handleHostTool 为类私有,经实例 + 任意未知内置名走插件查表)
  const { OmpRpcAgentImpl } = await import('../server/services/workshop/agents/omp-agent')
  const impl = new OmpRpcAgentImpl({ agentId: 'a1', name: 'A', role: 'worker', channelId: 'ch1' })
  const handle = (impl as unknown as Record<string, (req: unknown) => Promise<{ text: string, isError?: boolean }>>).handleHostTool.bind(impl)
  const out = await handle({ toolName: 'plugin_echo', arguments: { msg: 'hello' } })
  check('handleHostTool 分发到插件 handler', out.text === 'echo:hello', out.text)

  // 同名覆盖(热重载幂等:再注册同插件同名,byName 不重复)
  const before = listPluginTools().size
  registerPluginTool('demo-plugin', {
    name: 'plugin_echo',
    description: '回显测试工具 v2',
    parameters: { type: 'object', properties: {} },
    handler: () => ({ text: 'echo2' }),
  })
  check('同名覆盖不增表(热重载幂等)', listPluginTools().size === before, `size=${listPluginTools().size}`)
  const out2 = await handle({ toolName: 'plugin_echo', arguments: {} })
  check('覆盖后新 handler 生效', out2.text === 'echo2')
}

// ===== 运行时热注入:注册表变更 → 在跑实例重发 set_host_tools =====
console.log('\n--- 运行时热注入 ---')
{
  const { OmpRpcAgentImpl } = await import('../server/services/workshop/agents/omp-agent')
  const impl = new OmpRpcAgentImpl({ agentId: 'a2', name: 'B', role: 'worker', channelId: 'ch1' })
  const sent: Array<Record<string, unknown>> = []
  const fakeClient = {
    alive: true,
    onEvent: () => () => {},
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd)
      return { success: true }
    },
    onHostToolCall: () => {},
    getContextUsage: () => null,
    setContextWindow: () => {},
  }
  ;(impl as unknown as Record<string, unknown>).client = fakeClient

  let changeCount = 0
  const off = onPluginToolsChange(() => changeCount++)
  registerPluginTool('hot-plugin', {
    name: 'plugin_hot',
    description: '热注入工具',
    parameters: { type: 'object', properties: {} },
    handler: () => ({ text: 'hot' }),
  })
  off()
  await new Promise(r => setTimeout(r, 20))
  check('注册触发变更通知', changeCount >= 1, `changes=${changeCount}`)
  const setTools = sent.filter(c => c.type === 'set_host_tools')
  if (setTools.length > 0) {
    const tools = setTools[setTools.length - 1]!.tools as Array<{ name: string }>
    check('热注入重发 set_host_tools', true)
    check('热注入载荷含新插件工具', tools.some(t => t.name === 'plugin_hot'))
  }
  else {
    fail('热注入重发 set_host_tools')
  }
  impl.dispose()
}

// ===== 插件 DAQ 模板:注册 → 目录可见 → findDaqTemplate 可解析 → REST 守卫 =====
console.log('\n--- 插件 DAQ 模板 ---')
{
  const registry = getDaqTemplateRegistry()
  registry.registerPlugin({
    key: 'plug-test-probe',
    name: '插件测试模板',
    code: 'PLUG · T',
    ch: '测试信号',
    unit: 'mm',
    base: 0.5,
    amp: 0.01,
    min: 0.4,
    max: 0.6,
    decimals: 3,
    icon: 'tension',
    signalKind: 'vector',
    vector: { points: 16, min: 0.4, max: 0.6 },
    sink: { processors: [{ name: 'derive-metric', args: { name: 'avg', op: 'avg' } }] },
    metrics: [{ key: 'avg', label: '均值', unit: 'mm' }],
    plugin: 'test-plugin',
  })
  check('插件模板进入目录', registry.all().some(t => t.key === 'plug-test-probe'))
  check('findDaqTemplate 可解析插件模板', findDaqTemplate('plug-test-probe')?.signalKind === 'vector')
  check('插件标记透传', registry.all().find(t => t.key === 'plug-test-probe')?.plugin === 'test-plugin')

  // 同 key 覆盖(热重载幂等,不增行)
  const before = registry.all().length
  registry.registerPlugin({
    key: 'plug-test-probe', name: '插件测试模板 v2', code: 'PLUG · T', ch: '测试信号', unit: 'mm',
    base: 0.5, amp: 0.01, min: 0.4, max: 0.6, decimals: 3, icon: 'tension', plugin: 'test-plugin',
  })
  check('同 key 覆盖幂等(不增行)', registry.all().length === before && registry.byKey('plug-test-probe')?.name === '插件测试模板 v2')

  // REST 守卫:插件模板不可改/删
  let guarded = false
  try {
    registry.update('plug-test-probe', { name: 'hack' })
  }
  catch { guarded = true }
  check('update 插件模板被拒', guarded)
  guarded = false
  try {
    registry.remove('plug-test-probe')
  }
  catch { guarded = true }
  check('remove 插件模板被拒', guarded)

  // 与内置冲突拒绝
  let builtinClash = false
  try {
    registry.registerPlugin({ key: 'temp-tc', name: 'x', code: 'x', ch: 'x', unit: 'x', base: 0, amp: 1, min: 0, max: 1, decimals: 1, icon: 'thermo' })
  }
  catch { builtinClash = true }
  check('与内置模板 key 冲突拒绝', builtinClash)
}

// ===== db 依赖声明(类型面冒烟,防 import 环断裂)=====
console.log('\n--- 冒烟 ---')
{
  const db: DatabaseSync = openWorkshopDb(':memory:')
  check('db 可用( import 链健康)', db !== null)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
