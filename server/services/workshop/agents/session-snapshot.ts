import { canonicalHash, canonicalJson } from '@/shared/context/hash'
import { parseJson } from '../db/database'

export interface SessionRecipeSnapshotInput {
  id: string
  productId: string
  lineId: string
  version: number
  params: unknown[]
  daqWindows: unknown[]
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
  channelMode: 'generic' | 'production_line_integrated'
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
    return {
      channelId: row.channelId,
      sessionId: row.id,
      productId: row.productId,
      lineId: row.lineId,
      bindingSnapshotHash: row.bindingSnapshotHash,
      bindingSnapshotRevision: row.bindingSnapshotRevision,
      channelMode: 'production_line_integrated',
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
        contentHash: canonicalHash({ params: recipe.params, daqWindows: recipe.daqWindows }),
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
