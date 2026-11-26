/**
 * SessionBindingService —— 会话绑定范围（product / line / recipes）运行期读写。
 *
 * 创建快照保留为初始/审计基线；本服务写入覆盖行后，执行面以覆盖为准，
 * recipe 版本按当前定义实时解析，因此范围/配方变化能在下一回合热切换生效。
 */
import type { DatabaseSync } from 'node:sqlite'
import { canonicalHash, canonicalJson } from '@/shared/context/hash'
import { AppError } from '../../../utils/errors'
import { parseJson } from '../db/database'
import { createChannelRepo } from '../db/channel.repo'
import { createChannelSessionRepo } from '../db/channel-session.repo'
import { createChannelProductBindingRepo } from '../db/channel-product-binding.repo'
import { createSessionBindingOverrideRepo } from '../db/session-binding.repo'
import { getDcwProductRepo } from '../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { resolveTrustedSessionBinding } from '../agents/session-snapshot'
import type { ProductView, RecipeView } from '../../../../shared/dcw-protocol'

/** 测试注入：产品/配方目录（默认走 DCW JSON 仓库）。 */
export interface SessionBindingCatalog {
  allProducts: () => ProductView[]
  productById: (id: string) => ProductView | undefined
  allRecipes: () => RecipeView[]
  recipeById: (id: string) => RecipeView | undefined
}

export interface SessionBindingActor { id: string, role?: string, name?: string }

export interface SessionBindingRecipeView {
  id: string
  name: string
  version: number
}

export interface SessionBindingView {
  channelId: string
  sessionId: string
  channelMode: 'generic' | 'production_line_integrated'
  productId: string | null
  lineId: string | null
  /** 有效范围 revision：覆盖行为 1..n；创建快照为 snapshot revision；无工业范围为 0 */
  revision: number
  /** 覆盖行 CAS revision（无覆盖行 = 0）；UI 保存/重置用这个 */
  overrideRevision: number
  source: 'override' | 'snapshot' | 'none'
  mutable: boolean
  recipes: SessionBindingRecipeView[]
  /** 频道已绑定产品（可切换） */
  products: Array<{ id: string, name: string, lineId: string }>
  /** 每个候选产品下的配方（供 UI 切换产品时直接联动） */
  recipesByProduct: Record<string, SessionBindingRecipeView[]>
  effectiveAt: 'next_turn'
}

export interface SessionBindingUpdateInput {
  channelId: string
  sessionId: string
  actor: SessionBindingActor
  expectedRevision: number
  reset?: boolean
  productId?: string
  recipeIds?: string[]
}

const MAX_RECIPES = 200

function recipeView(recipe: { id: string, name: string, version?: number }): SessionBindingRecipeView {
  return { id: recipe.id, name: recipe.name, version: recipe.version ?? 1 }
}

export function createSessionBindingService(db: DatabaseSync, options: { catalog?: SessionBindingCatalog } = {}) {
  const sessions = createChannelSessionRepo(db)
  const channels = createChannelRepo(db)
  const catalog: SessionBindingCatalog = options.catalog ?? {
    allProducts: () => getDcwProductRepo().all(),
    productById: id => getDcwProductRepo().byId(id),
    allRecipes: () => getDcwRecipeRepo().list(),
    recipeById: id => getDcwRecipeRepo().byId(id),
  }
  const channelProducts = createChannelProductBindingRepo(db)
  const overrides = createSessionBindingOverrideRepo(db)
  const recipeLookup = (id: string) => catalog.recipeById(id)

  function findSession(channelId: string, sessionId: string) {
    const session = sessions.findById(sessionId)
    if (!session || session.channelId !== channelId) throw new AppError(404, 'NOT_FOUND', `会话不存在: ${sessionId}`)
    return session
  }

  function viewOf(channelId: string, sessionId: string): SessionBindingView {
    const session = findSession(channelId, sessionId)
    const trusted = resolveTrustedSessionBinding(db, session, { recipeLookup })
    const override = overrides.get(sessionId)
    const boundProducts = channelProducts.listByChannel(channelId)
      .map(binding => catalog.productById(binding.productId))
      .filter((product): product is NonNullable<typeof product> => Boolean(product))
      .map(product => ({ id: product.id, name: product.name, lineId: product.lineId }))
    const recipesByProduct: Record<string, SessionBindingRecipeView[]> = {}
    for (const product of boundProducts) {
      recipesByProduct[product.id] = catalog.allRecipes()
        .filter(recipe => recipe.productId === product.id)
        .map(recipeView)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    }
    const effectiveRecipes = trusted
      ? trusted.recipes
          .map(recipe => ({
            id: recipe.id,
            name: catalog.recipeById(recipe.id)?.name ?? recipe.id,
            version: recipe.version,
          }))
      : []
    return {
      channelId,
      sessionId,
      channelMode: trusted ? 'production_line_integrated' : 'generic',
      productId: trusted?.productId ?? null,
      lineId: trusted?.lineId ?? null,
      revision: trusted?.bindingSnapshotRevision ?? 0,
      overrideRevision: override?.revision ?? 0,
      source: trusted ? (override ? 'override' : 'snapshot') : 'none',
      mutable: Boolean(trusted?.mutable),
      recipes: effectiveRecipes,
      products: boundProducts,
      recipesByProduct,
      effectiveAt: 'next_turn',
    }
  }

  async function update(input: SessionBindingUpdateInput): Promise<SessionBindingView> {
    const session = findSession(input.channelId, input.sessionId)
    if (session.instanceKind !== 'manual') throw new AppError(409, 'SESSION_MANAGED', '仅手工会话可修改绑定范围')
    if (session.status !== 'active') throw new AppError(409, 'SESSION_NOT_ACTIVE', '会话已关闭，不能修改绑定范围')
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'expectedRevision 必须是非负整数')
    }
    if (input.reset === true && (input.productId !== undefined || input.recipeIds !== undefined)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'reset 不能同时提交 productId/recipeIds')
    }
    const row = overrides.get(input.sessionId)
    const currentRevision = row?.revision ?? 0
    if (currentRevision !== input.expectedRevision) {
      throw new AppError(409, 'SESSION_BINDING_REVISION_CONFLICT', `会话范围 revision 已变化（当前 ${currentRevision}）`)
    }
    if (input.reset === true) {
      overrides.remove(input.sessionId)
      await recordAudit(input, 'channel.session.binding.reset', `重置会话绑定范围（回到创建快照）`, {
        revision: 0,
        previousRevision: currentRevision,
      })
      return viewOf(input.channelId, input.sessionId)
    }
    const creationSnapshot = parseJson<Record<string, unknown>>(session.bindingSnapshotJson, {})
    const integrated = session.channelMode === 'production_line_integrated'
      && (Boolean(row) || Object.keys(creationSnapshot).length > 0)
    if (!integrated) throw new AppError(409, 'SESSION_NOT_INTEGRATED', '该会话不是集成产线会话，不存在 product/line/recipe 范围')

    const channel = channels.findById(input.channelId)
    if (!channel?.lineId) throw new AppError(409, 'CHANNEL_LINE_REQUIRED', '频道未绑定产线，不能设置会话范围')
    const trusted = resolveTrustedSessionBinding(db, session, { recipeLookup })
    const productId = String(input.productId ?? trusted?.productId ?? session.productId ?? '').trim()
    if (!productId) throw new AppError(400, 'SESSION_PRODUCT_REQUIRED', '必须选择产品')
    const boundProductIds = channelProducts.listByChannel(input.channelId).map(binding => binding.productId)
    if (!boundProductIds.includes(productId)) {
      throw new AppError(403, 'SESSION_PRODUCT_NOT_BOUND', `产品 ${productId} 未绑定到当前 Channel`)
    }
    const product = catalog.productById(productId)
    if (!product || !product.lineId) throw new AppError(404, 'SESSION_PRODUCT_NOT_FOUND', `产品不存在或未绑定产线: ${productId}`)
    if (product.lineId !== channel.lineId) {
      throw new AppError(409, 'SESSION_PRODUCT_LINE_MISMATCH', '产品所属产线与 Channel 当前产线不一致')
    }
    const recipeIds = [...new Set(
      input.recipeIds === undefined
        ? catalog.allRecipes().filter(recipe => recipe.productId === productId).map(recipe => recipe.id)
        : input.recipeIds.map(id => String(id).trim()).filter(Boolean),
    )].sort()
    if (recipeIds.length > MAX_RECIPES) throw new AppError(400, 'VALIDATION_ERROR', `配方数量上限 ${MAX_RECIPES}`)
    for (const recipeId of recipeIds) {
      const recipe = catalog.recipeById(recipeId)
      if (!recipe) throw new AppError(404, 'SESSION_RECIPE_NOT_FOUND', `配方不存在: ${recipeId}`)
      if (recipe.productId !== productId || recipe.lineId !== product.lineId) {
        throw new AppError(409, 'SESSION_RECIPE_SCOPE_MISMATCH', `配方 ${recipeId} 不属于产品 ${productId} / 产线 ${product.lineId}`)
      }
    }
    const revision = currentRevision + 1
    const payload = {
      schemaVersion: 1,
      channelId: input.channelId,
      revision,
      productId,
      lineId: product.lineId,
      recipeIds,
    }
    const bindingJson = canonicalJson(payload)
    const bindingHash = canonicalHash(payload)
    const saved = overrides.save({
      sessionId: input.sessionId,
      expectedRevision: currentRevision,
      revision,
      bindingJson,
      bindingHash,
      updatedBy: input.actor.id,
    })
    if (!saved) {
      const current = overrides.get(input.sessionId)?.revision ?? 0
      throw new AppError(409, 'SESSION_BINDING_REVISION_CONFLICT', `会话范围 revision 已变化（当前 ${current}）`)
    }
    await recordAudit(input, 'channel.session.binding.update', `修改会话绑定范围 revision ${revision}`, {
      revision,
      productId,
      lineId: product.lineId,
      recipeIds,
      previousRevision: currentRevision,
    })
    return viewOf(input.channelId, input.sessionId)
  }

  async function recordAudit(
    input: SessionBindingUpdateInput,
    action: string,
    summary: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { recordOps } = await import('../ops/ops')
      recordOps({
        actor: input.actor.id,
        actorName: input.actor.name ?? '',
        actorKind: 'user',
        action,
        kind: 'manual',
        targetKind: 'channel_session',
        targetId: input.sessionId,
        lineId: typeof detail.lineId === 'string' ? detail.lineId : '',
        summary,
        detail: { sessionId: input.sessionId, ...detail },
      })
    }
    catch {
      // 审计面失败不改变已提交的范围；留待运维补记。
    }
  }

  return { get: viewOf, update }
}

export type SessionBindingService = ReturnType<typeof createSessionBindingService>
