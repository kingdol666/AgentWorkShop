/**
 * 能力目录 registry：把平台工具/插件工具/Skill revision/MCP 已审工具投影为可发现输入。
 * 只读投影；真正授权仍由 resolver + dispatch + broker 再次判定。
 */
import { resolveRunMode } from '@/shared/config/home.mjs'
import { HOST_TOOLS } from '../agents/host-tool-bridge/catalog'
import { listPluginTools, pluginOfTool } from '../agents/plugin-tools'
import { getChannelPluginsRepo } from '../db/channel-plugins.repo'
import { listManifests } from '../mcp-client/config'
import { listManagedRevisions } from '../skills/store'
import type { PrefabCapabilityRegistryEntry } from './types'

export interface CapabilityRegistryBundle {
  registry: Record<string, PrefabCapabilityRegistryEntry>
  managedToolIds: string[]
  managedSkillIds: string[]
}

export function buildCapabilityRegistry(channelId: string, configRoot?: string): CapabilityRegistryBundle {
  const root = configRoot ?? resolveRunMode().configRoot
  const registry: Record<string, PrefabCapabilityRegistryEntry> = {}
  const toolIds = new Set<string>()
  const skillIds = new Set<string>()

  for (const tool of HOST_TOOLS) {
    registry[`tool:${tool.name}`] = { kind: 'tool', id: tool.name, enabled: true, label: tool.label }
    toolIds.add(tool.name)
  }

  let channelPlugins: Map<string, boolean> | null = null
  try {
    channelPlugins = getChannelPluginsRepo().explicitFor(channelId)
  }
  catch { /* 插件仓储不可用：保守不额外放行，插件工具仍按 registry 自身 */ }
  try {
    for (const [name, tool] of listPluginTools()) {
      const owner = pluginOfTool(name)
      const enabled = !owner || channelPlugins?.get(owner) !== false
      registry[`plugin-tool:${name}`] = { kind: 'plugin-tool', id: name, enabled, label: tool.description?.slice(0, 80) }
      // 兼容以 tool 类型引用插件工具的旧编辑器输入；仍受同一 enabled 约束
      registry[`tool:${name}`] = { kind: 'tool', id: name, enabled, label: tool.description?.slice(0, 80) }
      toolIds.add(name)
    }
  }
  catch { /* 插件工具注册表不可用：不发布插件能力 */ }

  const managedRevisions = listManagedRevisions(root)
  for (const revision of managedRevisions) {
    registry[`skill:${revision.id}`] = {
      kind: 'skill',
      id: revision.id,
      enabled: revision.enabled,
      reviewStatus: 'approved',
      label: revision.name,
    }
    skillIds.add(revision.id)
  }
  // 名称别名只在唯一时注册，避免同名 Skill 静默串用
  const byName = new Map<string, string[]>()
  for (const revision of managedRevisions) {
    const list = byName.get(revision.name) ?? []
    list.push(revision.id)
    byName.set(revision.name, list)
  }
  for (const [name, ids] of byName) {
    if (ids.length !== 1) continue
    const id = ids[0]!
    registry[`skill:${name}`] = { ...registry[`skill:${id}`]! }
  }

  for (const manifest of listManifests(root)) {
    for (const tool of manifest.tools) {
      const enabled = manifest.enabled && tool.reviewStatus === 'approved' && manifest.dataSharing === 'shared-safe'
      const entry: PrefabCapabilityRegistryEntry = {
        kind: 'mcp-tool',
        id: tool.exposedName,
        enabled,
        reviewStatus: tool.reviewStatus,
        label: `${manifest.label}/${tool.upstreamName}`,
      }
      registry[`mcp-tool:${tool.exposedName}`] = entry
      registry[`mcp-tool:${tool.id}`] = entry
      toolIds.add(tool.exposedName)
    }
  }

  return {
    registry,
    managedToolIds: [...toolIds].sort(),
    managedSkillIds: [...skillIds].sort(),
  }
}
