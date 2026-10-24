/**
 * 工具注册表同步服务:把运行时工具定义投影到 `tool_registry`。
 *
 * 事实源仍是:
 *  - 内置:`HOST_TOOLS`(host-tools.json 加载结果)
 *  - 插件:`listPluginTools()`(ctx.omp.registerTool 运行时注册)
 *
 * 本模块只写元数据,不参与执行;执行仍走 host-tool-bridge / 插件 handler。
 * 同步幂等:插件注册/卸载、宿主重载、进程启动、手动 API 均可重复调用。
 */
import { createHash } from 'node:crypto'
import { HOST_TOOLS } from '../agents/host-tool-bridge/catalog'
import { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, LEAD_ONLY_TOOL_NAMES } from '../agents/tool-classes'
import { listPluginTools, onPluginToolsChange, pluginOfTool } from '../agents/plugin-tools'
import { pluginManifest } from '../plugins/host.mjs'
import { createLogger } from '../logger'
import { recordOps } from '../ops/ops'
import { declarationVerdict } from '../agents/tool-reference-spec'
import {
  getToolRegistryRepo,
  type ToolRegistryUpsert,
  type ToolRole,
} from '../db/tool-registry.repo'

const log = createLogger('workshop.tool-registry')

/**
 * WP5 登记制:工业工具必须声明引用面(references 或 noRefs)。
 * 写族未声明 → 拒绝登记(不进目录 = 注入面与执行面双关);读族未声明 → 放行+告警入册。
 * 声明字段来自 host-tools.json(迁移脚本 scripts/tool-references-migrate.ts)。
 */
const EXTRA_WRITE_TOOL_NAMES = new Set(['line_start', 'line_stop'])
function isWriteFamily(name: string, riskClass?: string): boolean {
  return riskClass === 'write' || HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES.has(name) || EXTRA_WRITE_TOOL_NAMES.has(name)
}
const warnedUndeclared = new Set<string>()
function declarationVerdictOf(tool: { name: string, references?: unknown, noRefs?: boolean, riskClass?: string }): 'ok' | 'undeclared-write' | 'undeclared-read' {
  return declarationVerdict(tool, isWriteFamily(tool.name, tool.riskClass))
}

export interface ToolRegistrySyncResult {
  builtin: number
  plugin: number
  total: number
  unavailable: number
  at: string
  reason: string
}

interface SyncState {
  last: ToolRegistrySyncResult | null
  lastError: string
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  subscribed: boolean
}

const g = globalThis as typeof globalThis & { __awToolRegistrySync?: SyncState }

function state(): SyncState {
  return g.__awToolRegistrySync ??= {
    last: null,
    lastError: '',
    timer: null,
    inFlight: false,
    subscribed: false,
  }
}

/** 稳定序列化(键排序),用于定义哈希;不可序列化值降级为字符串描述。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function safeParameters(value: unknown): { parameters: Record<string, unknown>, error?: string } {
  try {
    const clone = JSON.parse(JSON.stringify(value ?? {}))
    return {
      parameters: clone && typeof clone === 'object' && !Array.isArray(clone) ? clone as Record<string, unknown> : {},
    }
  }
  catch (err) {
    return {
      parameters: {},
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 展示分组:只影响 UI 归类,不影响权限/注入。 */
const GROUP_BY_PREFIX: Record<string, string> = {
  report: 'task',
  complete: 'task',
  submit: 'task',
  dispatch: 'task',
  reassign: 'task',
  update: 'task',
  cancel: 'task',
  refuse: 'task',
  get: 'task',
  list: 'team',
  create: 'team',
  remove: 'team',
  send: 'messaging',
  broadcast: 'messaging',
  poll: 'messaging',
  read: 'messaging',
  save: 'memory',
  search: 'memory',
  daq: 'daq',
  dcw: 'dcw',
  ops: 'line',
  line: 'line',
  recipe: 'recipe',
  mes: 'mes',
  aml: 'aml',
  twin: 'twin',
  mpc: 'twin',
  optimization: 'twin',
  optimizer: 'optimization',
  team: 'team',
  exp: 'experience',
  analysis: 'analysis',
}

function groupOf(name: string, source: 'builtin' | 'plugin', pluginName: string): string {
  if (source === 'plugin') return pluginName ? `plugin:${pluginName}` : 'plugin'
  const prefix = name.split('_')[0] ?? name
  return GROUP_BY_PREFIX[prefix] ?? prefix
}

function builtinRoles(name: string): ToolRole[] {
  return LEAD_ONLY_TOOL_NAMES.has(name) ? ['lead'] : ['lead', 'worker']
}

function hashOf(row: Omit<ToolRegistryUpsert, 'definitionHash'>): string {
  return createHash('sha256').update(stableStringify({
    name: row.name,
    source: row.source,
    pluginName: row.pluginName ?? '',
    label: row.label ?? '',
    description: row.description,
    parameters: row.parameters ?? {},
    roles: row.roles ?? [],
    group: row.group ?? '',
  })).digest('hex')
}

/** 当前运行时快照(不写库;单测可直接断言)。 */
export function buildToolRegistrySnapshot(): ToolRegistryUpsert[] {
  const out = new Map<string, ToolRegistryUpsert>()
  for (const tool of HOST_TOOLS) {
    // WP5 登记制:写族未声明引用面 → 不登记(unavailable → 注入/执行双关)
    const verdict = declarationVerdictOf(tool)
    if (verdict === 'undeclared-write') {
      log.error(`工具「${tool.name}」属写族但未声明 references/noRefs,拒绝登记(注入面与执行面均不可用)`)
      recordOps({
        actor: 'system', actorName: 'tool-registry', actorKind: 'system',
        action: 'tool.registry.rejected', kind: 'system', level: 'warn',
        targetKind: 'tool', targetId: tool.name,
        summary: `写族工具未声明引用面,拒绝登记:${tool.name}`,
      })
      continue
    }
    if (verdict === 'undeclared-read' && !warnedUndeclared.has(tool.name)) {
      warnedUndeclared.add(tool.name)
      log.warn(`工具「${tool.name}」未声明 references/noRefs,按无引用工具登记(限期补齐)`)
      recordOps({
        actor: 'system', actorName: 'tool-registry', actorKind: 'system',
        action: 'tool.registry.undeclared', kind: 'system', level: 'warn',
        targetKind: 'tool', targetId: tool.name,
        summary: `工具未声明引用面(references/noRefs):${tool.name}`,
      })
    }
    const safe = safeParameters(tool.parameters)
    const base: Omit<ToolRegistryUpsert, 'definitionHash'> = {
      name: tool.name,
      source: 'builtin',
      pluginName: '',
      pluginScope: '',
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: safe.parameters,
      roles: builtinRoles(tool.name),
      group: groupOf(tool.name, 'builtin', ''),
      metadata: {
        builtin: true,
        hidden: Boolean(tool.hidden),
        riskClass: tool.riskClass ?? '',
        referencesDeclared: Boolean(tool.references || tool.noRefs),
        ...(safe.error ? { schemaError: safe.error } : {}),
      },
    }
    out.set(tool.name, { ...base, definitionHash: hashOf(base) })
  }

  let manifest = new Map<string, { version?: string, scope?: string }>()
  try {
    manifest = new Map(pluginManifest().map(p => [p.name, { version: p.version, scope: p.scope }]))
  }
  catch {
    // 插件宿主未初始化(单测/极早启动):仍登记插件工具,scope 留空
  }

  for (const [name, tool] of listPluginTools()) {
    // 内置同名优先(registerPluginTool 已告警);目录与执行面同口径
    if (out.has(name)) continue
    const owner = pluginOfTool(name) ?? ''
    const meta = manifest.get(owner)
    const safe = safeParameters(tool.parameters)
    const base: Omit<ToolRegistryUpsert, 'definitionHash'> = {
      name,
      source: 'plugin',
      pluginName: owner,
      pluginScope: String(meta?.scope ?? ''),
      label: tool.label ?? name,
      description: tool.description,
      parameters: safe.parameters,
      roles: tool.roles && tool.roles.length > 0 ? [...tool.roles] : ['lead', 'worker'],
      group: groupOf(name, 'plugin', owner),
      metadata: {
        builtin: false,
        plugin: owner,
        pluginVersion: meta?.version ?? '',
        pluginScope: meta?.scope ?? '',
        ...(safe.error ? { schemaError: safe.error } : {}),
      },
    }
    out.set(name, { ...base, definitionHash: hashOf(base) })
  }

  return [...out.values()]
}

/** 同步一次(同步 SQLite;调用方需要异步时自行包 Promise)。 */
export function syncToolRegistry(reason = 'manual'): ToolRegistrySyncResult {
  const st = state()
  if (st.inFlight) {
    // 并发同步(插件批量注册):返回上次结果,避免重入事务
    return st.last ?? { builtin: 0, plugin: 0, total: 0, unavailable: 0, at: new Date().toISOString(), reason: `${reason}:coalesced` }
  }
  st.inFlight = true
  try {
    const repo = getToolRegistryRepo()
    const rows = buildToolRegistrySnapshot()
    repo.upsertMany(rows)
    const unavailable = repo.markUnavailableExcept(rows.map(r => r.name))
    const counts = repo.counts()
    const result: ToolRegistrySyncResult = {
      builtin: counts.builtin,
      plugin: counts.plugin,
      total: counts.total,
      unavailable,
      at: new Date().toISOString(),
      reason,
    }
    st.last = result
    st.lastError = ''
    log.info(`synced builtin=${result.builtin} plugin=${result.plugin} unavailable=${result.unavailable} total=${result.total} (${reason})`)
    return result
  }
  catch (err) {
    st.lastError = err instanceof Error ? err.message : String(err)
    log.warn(`同步失败(${reason}): ${st.lastError}`)
    throw err
  }
  finally {
    st.inFlight = false
  }
}

/** 防抖同步(插件注册/卸载/重载会连续触发)。 */
export function scheduleToolRegistrySync(reason = 'change', delayMs = 150): void {
  const st = state()
  if (st.timer) clearTimeout(st.timer)
  st.timer = setTimeout(() => {
    st.timer = null
    try {
      syncToolRegistry(reason)
    }
    catch { /* 已记录;不拖垮插件装载/请求 */ }
  }, delayMs)
  st.timer.unref?.()
}

/** 启动装配:先同步一次,再订阅插件工具变更(幂等)。 */
export function initToolRegistrySync(): void {
  try {
    syncToolRegistry('boot')
  }
  catch { /* boot 同步失败不阻断服务;手动 sync/插件变更会重试 */ }
  const st = state()
  if (st.subscribed) return
  st.subscribed = true
  onPluginToolsChange(() => scheduleToolRegistrySync('plugin-tools-change'))
}

export function getToolRegistrySyncState(): { last: ToolRegistrySyncResult | null, lastError: string } {
  const st = state()
  return { last: st.last, lastError: st.lastError }
}
