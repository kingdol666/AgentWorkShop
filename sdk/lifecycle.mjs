// ============================================================
// AgentWorkShop SDK — 生命周期事件清单(宿主触发;单一事实源)
// ============================================================

/** 服务端生命周期事件清单(宿主触发;文档见 docs/plugins.md 与文档站 /sdk/lifecycle)。
 *  daq:frame 与 daq:sample 同由数采管线发射(host.mjs emitDaqFrame,帧入账路径),
 *  入册使清单与实际发射面一致。 */
export const LIFECYCLE_EVENTS = Object.freeze([
  'plugin:host:init',
  'config:changed',
  'permissions:changed',
  'event:*',
  'daq:sample',
  'daq:frame',
  'dcw:write',
  'line:start',
  'line:stop',
  'server:close',
])

/** 客户端生命周期事件清单 */
export const CLIENT_EVENTS = Object.freeze([
  'client:init',
  'event:*',
  'page:change',
  'client:destroy',
])

export default { LIFECYCLE_EVENTS, CLIENT_EVENTS }
