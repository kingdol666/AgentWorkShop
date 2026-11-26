import { recipeDefinitionHash } from './industrial/recipe-snapshot'
import { canonicalHash, canonicalJson } from '@/shared/context/hash'
import { parseJson } from '../db/database'
import { createSessionBindingOverrideRepo } from '../db/session-binding.repo'

export interface SessionRecipeSnapshotInput {
  id: string
  productId: string
  lineId: string
  version: number
  params: unknown[]
  daqWindows: unknown[]
}

/** 运行期可变范围用：按 id 读取当前 recipe 定义（缺失返回 undefined）。 */
export interface SessionBindingRecipeView {
  id: string
  productId: string
  lineId: string
  version?: number
  params?: unknown[]
  daqWindows?: unknown[]
}

export interface SessionBindingRecipeLookup {
  (id: string): SessionBindingRecipeView | undefined
}

export interface SessionAgentBindingSnapshotInput {
  agentId: string
  bindings: Array<{ nodeId: string, kind: string, mode: string, tuning?: unknown }>
}

export interface ChannelSessionBindingSnapshotInput {
  channelId: string
  selectedProductId: string
  lineId: string
  bindingRevision: number
  boundProductIds: readonly string[]
  recipes: readonly SessionRecipeSnapshotInput[]
  agentBindings: readonly SessionAgentBindingSnapshotInput[]
  executionProfile: unknown
}

export interface ChannelSessionBindingSnapshot {
  productId: string
  lineId: string
  revision: number
  snapshot: Record<string, unknown>
  json: string
  hash: string
}

export interface TrustedSessionBindingIdentity {
  channelId: string
  sessionId: string
  productId: string
  lineId: string
  bindingSnapshotHash: string
  bindingSnapshotRevision: number
  recipes: Array<{ id: string, version: number, contentHash: string }>
  channelMode: 'generic' | 'production_line_integrated'
  /** true = 覆盖行生效（product/line/recipe 可运行期修改，recipe 版本按当前定义解析） */
  mutable: boolean
  /** 范围指纹：覆盖行按当前 recipes 计算；创建快照用 snapshot hash。manager 据此触发热切换。 */
  fingerprint: string
}

/** Validate persisted industrial authorization against its immutable canonical snapshot. */
export function trustedSessionBindingIdentity(row: {
  id: string
  channelId: string
  channelMode: string
  productId: string | null
  lineId: string | null
  bindingSnapshotJson: string
  bindingSnapshotHash: string
  bindingSnapshotRevision: number
}): TrustedSessionBindingIdentity | null {
  try {
    if (row.channelMode !== 'production_line_integrated' || !row.productId || !row.lineId || !row.bindingSnapshotJson || !row.bindingSnapshotHash || !Number.isSafeInteger(row.bindingSnapshotRevision) || row.bindingSnapshotRevision < 1) return null
    const snapshot = parseJson<Record<string, unknown>>(row.bindingSnapshotJson, {})
    if (snapshot.channelId !== row.channelId || snapshot.productId !== row.productId || snapshot.lineId !== row.lineId || snapshot.bindingRevision !== row.bindingSnapshotRevision) return null
    if (canonicalJson(snapshot) !== row.bindingSnapshotJson || canonicalHash(snapshot) !== row.bindingSnapshotHash) return null
    if (!Array.isArray(snapshot.recipes)) return null
    const recipes = snapshot.recipes.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const recipe = entry as Record<string, unknown>
      if (typeof recipe.id !== 'string' || recipe.productId !== row.productId || recipe.lineId !== row.lineId || !Number.isSafeInteger(recipe.version) || typeof recipe.contentHash !== 'string') return []
      return [{ id: recipe.id, version: recipe.version as number, contentHash: recipe.contentHash }]
    })
    if (recipes.length !== snapshot.recipes.length) return null
    return {
      channelId: row.channelId,
      sessionId: row.id,
      productId: row.productId,
      lineId: row.lineId,
      bindingSnapshotHash: row.bindingSnapshotHash,
      bindingSnapshotRevision: row.bindingSnapshotRevision,
      recipes,
      channelMode: 'production_line_integrated',
      mutable: false,
      fingerprint: row.bindingSnapshotHash,
    }
  }
  catch {
    return null
  }
}

/**
 * 运行期有效绑定范围：有覆盖行时以覆盖为准（product/line/recipe 可改，recipe 版本按当前定义解析）；
 * 无覆盖行时回落到创建快照。
 *
 * `recipeLookup` 由调用方注入（避免 session-snapshot 在模块加载期拉起 DCW JSON 仓库）。
 * 覆盖行存在但未提供 lookup / JSON/hash 不自洽 → 返回 null（fail closed）。
 */
export function resolveTrustedSessionBinding(
  db: Parameters<typeof createSessionBindingOverrideRepo>[0],
  row: {
    id: string
    channelId: string
    channelMode: string
    productId: string | null
    lineId: string | null
    bindingSnapshotJson: string
    bindingSnapshotHash: string
    bindingSnapshotRevision: number
  },
  opts?: { recipeLookup?: SessionBindingRecipeLookup },
): TrustedSessionBindingIdentity | null {
  let override
  try {
    override = createSessionBindingOverrideRepo(db).get(row.id)
  }
  catch {
    return null
  }
  if (!override) return trustedSessionBindingIdentity(row)
  try {
    if (row.channelMode !== 'production_line_integrated') return null
    const parsed = parseJson<Record<string, unknown> | null>(override.bindingJson, null)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const productId = typeof parsed.productId === 'string' ? parsed.productId : ''
    const lineId = typeof parsed.lineId === 'string' ? parsed.lineId : ''
    const revision = Number(parsed.revision)
    if (parsed.schemaVersion !== 1 || parsed.channelId !== row.channelId || !productId || !lineId) return null
    if (!Number.isSafeInteger(revision) || revision < 1 || revision !== override.revision) return null
    if (canonicalJson(parsed) !== override.bindingJson || canonicalHash(parsed) !== override.bindingHash) return null
    if (!Array.isArray(parsed.recipeIds) || !parsed.recipeIds.every(id => typeof id === 'string')) return null
    if (!opts?.recipeLookup) return null
    const recipes = (parsed.recipeIds as string[])
      .map(id => opts.recipeLookup!(id))
      .flatMap((recipe) => {
        if (!recipe || recipe.productId !== productId || recipe.lineId !== lineId) return []
        return [{
          id: recipe.id,
          version: recipe.version ?? 1,
          contentHash: recipeDefinitionHash({ params: recipe.params ?? [], daqWindows: recipe.daqWindows ?? [] }),
        }]
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    const fingerprint = canonicalHash({ productId, lineId, recipes })
    return {
      channelId: row.channelId,
      sessionId: row.id,
      productId,
      lineId,
      bindingSnapshotHash: override.bindingHash,
      bindingSnapshotRevision: override.revision,
      recipes,
      channelMode: 'production_line_integrated',
      mutable: true,
      fingerprint,
    }
  }
  catch {
    return null
  }
}

/** Build the immutable per-session execution identity from trusted persisted inputs. */
export function createChannelSessionBindingSnapshot(input: ChannelSessionBindingSnapshotInput): ChannelSessionBindingSnapshot {
  if (!input.channelId || !input.selectedProductId || !input.lineId) throw new Error('SESSION_BINDING_SCOPE_REQUIRED')
  if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 1) throw new Error('SESSION_BINDING_REVISION_REQUIRED')
  if (!input.boundProductIds.includes(input.selectedProductId)) throw new Error('SESSION_PRODUCT_NOT_BOUND')

  const recipes = input.recipes
    .filter(recipe => recipe.productId === input.selectedProductId)
    .map((recipe) => {
      if (recipe.lineId !== input.lineId) throw new Error(`SESSION_RECIPE_LINE_MISMATCH:${recipe.id}`)
      return {
        id: recipe.id,
        productId: recipe.productId,
        lineId: recipe.lineId,
        version: recipe.version,
        contentHash: recipeDefinitionHash(recipe),
        params: recipe.params,
        daqWindows: recipe.daqWindows,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  const agentBindings = input.agentBindings
    .map(agent => ({
      agentId: agent.agentId,
      bindings: agent.bindings
        .map(binding => ({
          nodeId: binding.nodeId,
          kind: binding.kind,
          mode: binding.mode,
          ...(binding.tuning !== undefined ? { tuning: binding.tuning } : {}),
        }))
        .sort((a, b) => `${a.kind}:${a.nodeId}`.localeCompare(`${b.kind}:${b.nodeId}`)),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId))

  const snapshot: Record<string, unknown> = {
    schemaVersion: 1,
    channelId: input.channelId,
    bindingRevision: input.bindingRevision,
    productId: input.selectedProductId,
    lineId: input.lineId,
    recipes,
    agentBindings,
    executionProfile: input.executionProfile,
  }
  const json = canonicalJson(snapshot)
  return {
    productId: input.selectedProductId,
    lineId: input.lineId,
    revision: input.bindingRevision,
    snapshot,
    json,
    hash: canonicalHash(snapshot),
  }
}
