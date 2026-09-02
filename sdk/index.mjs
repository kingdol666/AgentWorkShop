// ============================================================
// AgentWorkShop SDK — 门面
// ------------------------------------------------------------
// 插件作者两种写法:
//   1) 零依赖(推荐,全局安装零解析链约束下的标准形态):
//        export default { name, version, setup(ctx), client: './client.mjs', routes: [...] }
//      —— ctx 由宿主注入,本 SDK 对插件运行时非必需。
//   2) 显式糖(本地开发/单体使用时):
//        import { definePlugin } from 'agentworkshop/sdk'
//        export default definePlugin({ ... })
// 生命周期(宿主触发):
//   服务端: setup(ctx) → plugin:host:init → event:*/daq:sample/dcw:write/line:start|stop
//           → server:close
//   客户端: client.mjs setup(ctx) → client:init → event:*/page:change
// ============================================================
import { SDK_VERSION, definePlugin, createPluginContext, createRouteTable, validatePluginModule, pluginKvExists } from './context.mjs'
import { HookBus } from './hooks.mjs'
import { createPlatformClient } from './api.mjs'
import { CLIENT_SDK_VERSION, createClientContext } from './client.mjs'
import { LIFECYCLE_EVENTS, CLIENT_EVENTS } from './lifecycle.mjs'

export { SDK_VERSION, definePlugin, createPluginContext, createRouteTable, validatePluginModule, pluginKvExists } from './context.mjs'
export { HookBus } from './hooks.mjs'
export { createPlatformClient } from './api.mjs'
export { CLIENT_SDK_VERSION, createClientContext } from './client.mjs'
export { LIFECYCLE_EVENTS, CLIENT_EVENTS } from './lifecycle.mjs'

export default {
  SDK_VERSION,
  definePlugin,
  HookBus,
  createPluginContext,
  createRouteTable,
  validatePluginModule,
  pluginKvExists,
  createPlatformClient,
  CLIENT_SDK_VERSION,
  createClientContext,
  LIFECYCLE_EVENTS,
  CLIENT_EVENTS,
}
