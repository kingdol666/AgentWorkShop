// ============================================================
// AgentWorkShop SDK — 生命周期事件清单(宿主触发;单一事实源)
// ============================================================

/** 服务端生命周期事件清单(宿主触发;文档见 docs/plugins.md) */
export const LIFECYCLE_EVENTS = Object.freeze([
  'plugin:host:init',
  'config:changed',
  'event:*',
  'daq:sample',
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
