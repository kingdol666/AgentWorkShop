/**
 * MCP bridge 工具面签名(C14):name/label/description/parameters + per-agent 描述。
 * 抽成独立模块:桥进程与验收脚本共用同一算法,schema-only 变更也必须触发刷新。
 */
export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

export function toolSignature(tools) {
  return JSON.stringify((Array.isArray(tools) ? tools : []).map(t => [
    t.name,
    t.label ?? '',
    t.description ?? '',
    stableValue(t.parameters ?? {}),
  ]))
}
