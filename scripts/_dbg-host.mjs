/** 独立验证:插件宿主装载 → ctx.daq/ctx.omp 注册是否进队列/注册表 */
const cwd = 'D:/codes/ABO/AgentWorkShop'
const m = await import('file:///' + cwd + '/server/services/workshop/plugins/host.mjs')
const host = await m.initPluginHost({ cwd })
console.log('plugins:', [...host.plugins.keys()])
console.log('failures:', JSON.stringify(host.failures))
console.log('daqPluginExt pendingTemplates:', globalThis.__daqPluginExt?.pendingTemplates?.length)
console.log('daqPluginExt pendingDrivers:', globalThis.__daqPluginExt?.pendingDrivers?.length)
console.log('ompToolsBridge pending:', globalThis.__ompPluginToolsBridge?.pending?.length)
// 模拟 daq 侧接管:调用 drain 检查回放是否到达注册表
const registry = await import('file:///' + cwd + '/server/services/workshop/daq/daq-templates.ts').catch(e => { console.log('TS import err:', e.message); return null })
if (registry) {
  console.log('plug-demo-roughness in registry:', !!registry.findDaqTemplate('plug-demo-roughness'))
}
await m.shutdownPluginHost().catch(() => {})
process.exit(0)
