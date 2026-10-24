/**
 * 工具目录视图:把注册表元数据 + 硬规则资格 + Channel 选择合成为透明化行。
 *
 * 读路径无副作用(不写库、不同步);注册表为空时用运行时快照兜底展示。
 * 硬规则资格完全复用 scopeHostToolsForRole,避免 UI 与注入面两套规则。
 */
import { scopeHostToolsForRole } from '../agents/host-tool-bridge/catalog'
import { pluginManifest } from '../plugins/host.mjs'
import { getToolRegistryRepo, type ToolRegistryRow, type ToolRole } from '../db/tool-registry.repo'
import { buildToolRegistrySnapshot } from './registry'
import { getPolicySnapshot, isChannelToolEnabled } from './policy'
import type { ToolBlockReason, ToolExclusion } from './types'

export interface ToolEligibilityView {
  eligible: boolean
  reason: ToolBlockReason
  message: string
}

export interface ToolCatalogRow {
  name: string
  label: string
  description: string
  source: 'builtin' | 'plugin'
  plugin: string | null
  pluginScope: string | null
  group: string
  roles: ToolRole[]
  parameters: Record<string, unknown>
  available: boolean
  channelEnabled: boolean
  eligibility: Record<ToolRole, ToolEligibilityView>
  effective: Record<ToolRole, boolean>
}

export interface ChannelToolView {
  channelId: string
  mode: 'all' | 'selected'
  /** WP7:degraded/cached = 数据库读取失败后的降级来源(前端可提示「策略为最近快照」) */
  source: 'default' | 'explicit' | 'cached' | 'degraded'
  stale?: boolean
  updatedBy: string
  updatedAt: string | null
  stats: {
    total: number
    available: number
    eligibleLead: number
    eligibleWorker: number
    effectiveLead: number
    effectiveWorker: number
    blocked: number
    channelDisabled: number
  }
  tools: ToolCatalogRow[]
}

export interface GlobalToolRow extends Omit<ToolCatalogRow, 'channelEnabled' | 'eligibility' | 'effective'> {
  firstSeenAt: string
  updatedAt: string
  definitionHash: string
  channels: Array<{ id: string, name: string, mode: 'all' | 'selected', enabled: boolean }>
}

export interface GlobalToolView {
  lastSyncedAt: string | null
  stats: { total: number, builtin: number, plugin: number, available: number, disabledByChannels: number }
  tools: GlobalToolRow[]
}

function availableRows(): ToolRegistryRow[] {
  let rows: ToolRegistryRow[] = []
  try {
    rows = getToolRegistryRepo().list()
  }
  catch { /* DB 不可用 → 运行时快照兜底 */ }
  if (rows.length > 0) return rows
  return buildToolRegistrySnapshot().map(row => ({
    name: row.name,
    source: row.source,
    pluginName: row.pluginName ?? '',
    pluginScope: row.pluginScope ?? '',
    label: row.label ?? row.name,
    description: row.description,
    parameters: row.parameters ?? {},
    roles: row.roles ?? ['lead', 'worker'],
    group: row.group ?? '',
    metadata: row.metadata ?? {},
    definitionHash: row.definitionHash,
    available: true,
    firstSeenAt: '',
    lastSeenAt: '',
    updatedAt: '',
  }))
}

function pluginState(): { known: boolean, enabled: Set<string> } {
  try {
    const manifest = pluginManifest()
    return { known: manifest.length > 0, enabled: new Set(manifest.filter(p => p.enabled).map(p => p.name)) }
  }
  catch {
    return { known: false, enabled: new Set() }
  }
}

function scopeFor(role: ToolRole, channelId: string): { names: Set<string>, excluded: Map<string, ToolExclusion> } {
  const scope = scopeHostToolsForRole(role, channelId)
  return { names: new Set(scope.tools.map(t => t.name)), excluded: scope.excluded }
}

function reasonFor(
  name: string,
  row: ToolRegistryRow,
  scope: { names: Set<string>, excluded: Map<string, ToolExclusion> },
  available: boolean,
  channelEnabled: boolean,
): ToolEligibilityView {
  if (!available) {
    return { eligible: false, reason: 'UNAVAILABLE', message: '插件未安装或加载失败' }
  }
  if (!scope.names.has(name)) {
    const ex = scope.excluded.get(name)
    if (ex) return { eligible: false, reason: ex.reason, message: ex.message }
    return row.source === 'plugin'
      ? { eligible: false, reason: 'PLUGIN_DISABLED', message: '插件未启用或未注册' }
      : { eligible: false, reason: 'PROFILE_DENIED', message: '当前 Channel 档位不开放该工具' }
  }
  if (!channelEnabled) {
    return { eligible: true, reason: 'CHANNEL_TOOL_DISABLED', message: '本 Channel 未启用该工具' }
  }
  return { eligible: true, reason: 'OK', message: '' }
}

export function buildChannelToolView(channelId: string): ChannelToolView {
  const rows = availableRows()
  const policy = getPolicySnapshot(channelId)
  const leadScope = scopeFor('lead', channelId)
  const workerScope = scopeFor('worker', channelId)
  const plugins = pluginState()

  const tools: ToolCatalogRow[] = rows.map((row) => {
    const available = row.available && (row.source !== 'plugin' || !plugins.known || plugins.enabled.has(row.pluginName))
    const channelEnabled = isChannelToolEnabled(policy, row.name)
    const lead = reasonFor(row.name, row, leadScope, available, channelEnabled)
    const worker = reasonFor(row.name, row, workerScope, available, channelEnabled)
    return {
      name: row.name,
      label: row.label,
      description: row.description,
      source: row.source,
      plugin: row.pluginName || null,
      pluginScope: row.pluginScope || null,
      group: row.group,
      roles: row.roles,
      parameters: row.parameters,
      available,
      channelEnabled,
      eligibility: { lead, worker },
      effective: {
        lead: lead.eligible && channelEnabled,
        worker: worker.eligible && channelEnabled,
      },
    }
  }).sort((a, b) => {
    if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
    const g = a.group.localeCompare(b.group)
    return g !== 0 ? g : a.name.localeCompare(b.name)
  })

  return {
    channelId,
    mode: policy.mode,
    source: policy.source,
    ...(policy.stale ? { stale: true } : {}),
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt,
    stats: {
      total: tools.length,
      available: tools.filter(t => t.available).length,
      eligibleLead: tools.filter(t => t.eligibility.lead.eligible).length,
      eligibleWorker: tools.filter(t => t.eligibility.worker.eligible).length,
      effectiveLead: tools.filter(t => t.effective.lead).length,
      effectiveWorker: tools.filter(t => t.effective.worker).length,
      blocked: tools.filter(t => !t.eligibility.lead.eligible && !t.eligibility.worker.eligible).length,
      channelDisabled: tools.filter(t => !t.channelEnabled && (t.eligibility.lead.eligible || t.eligibility.worker.eligible)).length,
    },
    tools,
  }
}

/** 全局目录:工具元数据 + 被哪些 Channel 停用 */
export function buildGlobalToolView(): GlobalToolView {
  const rows = availableRows()
  const repo = getToolRegistryRepo()
  let policies: ReturnType<typeof repo.listPolicies> = []
  let settings: ReturnType<typeof repo.listAllSettings> = []
  let names = new Map<string, string>()
  try {
    policies = repo.listPolicies()
    settings = repo.listAllSettings()
    names = repo.channelNames()
  }
  catch { /* DB 不可用 → 无 Channel 使用信息 */ }

  const settingByChannel = new Map<string, Map<string, boolean>>()
  for (const s of settings) {
    const m = settingByChannel.get(s.channelId) ?? new Map<string, boolean>()
    m.set(s.toolName, s.enabled)
    settingByChannel.set(s.channelId, m)
  }

  const tools: GlobalToolRow[] = rows.map((row) => {
    const channels: GlobalToolRow['channels'] = []
    for (const p of policies) {
      const setting = settingByChannel.get(p.channelId)
      const enabled = p.mode === 'selected'
        ? setting?.get(row.name) === true
        : setting?.get(row.name) !== false
      if (!enabled) {
        channels.push({ id: p.channelId, name: names.get(p.channelId) ?? p.channelId, mode: p.mode, enabled })
      }
    }
    return {
      name: row.name,
      label: row.label,
      description: row.description,
      source: row.source,
      plugin: row.pluginName || null,
      pluginScope: row.pluginScope || null,
      group: row.group,
      roles: row.roles,
      parameters: row.parameters,
      available: row.available,
      firstSeenAt: row.firstSeenAt,
      updatedAt: row.updatedAt,
      definitionHash: row.definitionHash,
      channels,
    }
  })

  return {
    lastSyncedAt: (() => {
      try {
        return repo.lastSyncedAt()
      }
      catch {
        return null
      }
    })(),
    stats: {
      total: rows.length,
      builtin: rows.filter(r => r.source === 'builtin').length,
      plugin: rows.filter(r => r.source === 'plugin').length,
      available: rows.filter(r => r.available).length,
      disabledByChannels: tools.reduce((n, t) => n + t.channels.length, 0),
    },
    tools,
  }
}
