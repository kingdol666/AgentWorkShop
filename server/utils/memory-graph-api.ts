/**
 * 图谱 API 公共上下文/校验 schema。
 * 读写权限沿用记忆中心：读=频道可见成员；写=owner/admin。
 */
import type { H3Event } from 'h3'
import type { DatabaseSync } from 'node:sqlite'
import { getRouterParam } from 'h3'
import { z } from 'zod'
import { resolveUser } from '../api/workshop/caller'
import { getWorkshopManager } from '../plugins/workshop'
import { createMemoryGraphService, type GraphService } from '../services/workshop/memory/graph/service'
import { AppError } from './errors'

export interface GraphRequestContext {
  user: ReturnType<typeof resolveUser>
  channelId: string
  service: GraphService
  actor: { id: string, name: string }
  ownerUserId: string | null
  lineId: string
  db: DatabaseSync
}

export function graphContext(event: H3Event, write: boolean): GraphRequestContext {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')
  if (!channelId) throw new AppError(404, 'CHANNEL_NOT_FOUND', '频道不存在')
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  if (write) manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const service = createMemoryGraphService(manager.deps.db)
  if (!service.available) throw new AppError(503, 'GRAPH_UNAVAILABLE', '知识图谱尚未初始化')
  const row = manager.deps.db.prepare('SELECT owner_user_id AS ownerUserId, COALESCE(line_id, \'\') AS lineId FROM channels WHERE id = ?')
    .get(channelId) as { ownerUserId?: string | null, lineId?: string } | undefined
  return {
    user, channelId, service, actor: { id: user.id, name: user.name || user.id },
    ownerUserId: row?.ownerUserId ?? null, lineId: row?.lineId ?? '',
    db: manager.deps.db,
  }
}

const aliases = z.array(z.string().trim().min(1).max(80)).max(20).optional()

export const graphEntityCreateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  canonicalName: z.string().trim().min(1).max(200).optional(),
  type: z.string().trim().min(1).max(40).optional(),
  entityType: z.string().trim().min(1).max(40).optional(),
  aliases,
  summary: z.string().max(2000).optional(),
  scopeKind: z.enum(['channel', 'session', 'line', 'product', 'global']).optional(),
  scopeKey: z.string().max(200).optional(),
  productId: z.string().max(200).optional(),
  confidence: z.number().min(0).max(1).optional(),
  salience: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  validFrom: z.string().max(64).optional(),
}).strict().refine(v => Boolean(v.name || v.canonicalName), { message: 'name 必填' })

export const graphEntityUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200).optional(),
  canonicalName: z.string().trim().min(1).max(200).optional(),
  type: z.string().trim().min(1).max(40).optional(),
  entityType: z.string().trim().min(1).max(40).optional(),
  aliases,
  summary: z.string().max(2000).optional(),
  status: z.enum(['active', 'provisional', 'rejected', 'retired']).optional(),
  locked: z.boolean().optional(),
  validFrom: z.string().max(64).nullable().optional(),
  validTo: z.string().max(64).nullable().optional(),
}).strict()

export const graphMergeSchema = z.object({
  targetId: z.string().trim().min(1).max(200),
}).strict()

export const graphEdgeCreateSchema = z.object({
  srcId: z.string().trim().min(1).max(200).optional(),
  sourceId: z.string().trim().min(1).max(200).optional(),
  dstId: z.string().trim().min(1).max(200).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
  relation: z.string().trim().min(1).max(60),
  relationLabel: z.string().max(120).optional(),
  fact: z.string().max(600).optional(),
  polarity: z.enum(['positive', 'negative', 'neutral']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  weight: z.number().min(0).max(100).optional(),
  locked: z.boolean().optional(),
  evidenceMemoryIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  validFrom: z.string().max(64).optional(),
  validTo: z.string().max(64).nullable().optional(),
}).strict().refine(v => Boolean((v.srcId || v.sourceId) && (v.dstId || v.targetId)), { message: 'srcId/dstId 必填' })

export const graphEdgeUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  relation: z.string().trim().min(1).max(60).optional(),
  relationLabel: z.string().max(120).optional(),
  fact: z.string().max(600).optional(),
  polarity: z.enum(['positive', 'negative', 'neutral']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  weight: z.number().min(0).max(100).optional(),
  status: z.enum(['active', 'provisional', 'rejected', 'superseded', 'retired']).optional(),
  locked: z.boolean().optional(),
  validFrom: z.string().max(64).nullable().optional(),
  validTo: z.string().max(64).nullable().optional(),
}).strict()

export const graphRejectSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  reason: z.string().max(300).optional(),
}).strict()

export const graphRunSchema = z.object({
  mode: z.enum(['incremental', 'full']).default('incremental'),
  scope: z.enum(['channel', 'session', 'shared', 'line', 'product']).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  productId: z.string().trim().min(1).max(200).optional(),
}).strict()

export const graphSettingsSchema = z.object({
  enabled: z.boolean(),
}).strict()
