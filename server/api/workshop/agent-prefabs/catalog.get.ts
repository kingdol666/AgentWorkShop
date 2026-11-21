/**
 * GET /api/workshop/agent-prefabs/catalog — 当前系统可发现的工具/Skill/MCP 能力目录。
 * 仅返回名称/来源/启用/审阅状态；不返回凭据或完整 MCP 配置。
 */
import { defineApiHandler } from '../../../utils/response'
import { resolveUser } from '../caller'
import { buildCapabilityRegistry } from '../../../services/workshop/agent-prefabs/registry'

export default defineApiHandler((event) => {
  resolveUser(event)
  const bundle = buildCapabilityRegistry('')
  const seen = new Set<string>()
  const entries = Object.values(bundle.registry).filter((entry) => {
    const key = `${entry.kind}:${entry.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  return { entries }
})
