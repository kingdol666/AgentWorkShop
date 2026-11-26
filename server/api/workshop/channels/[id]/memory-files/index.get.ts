/**
 * GET /api/workshop/channels/:id/memory-files?path= —— 记忆文件浏览（批次 J）。
 */
import { getQuery, getRouterParam } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { getDocument, listDocuments, normalizeDocumentPath } from '../../../../../services/workshop/memory/documents'
import { scopeIdOfChannel } from '../../../../../services/workshop/memory/blocks'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const db = getAmlRuntime().db
  const scopeId = scopeIdOfChannel(channelId)
  const path = getQuery(event).path
  if (typeof path === 'string' && path) {
    const doc = getDocument(db, scopeId, normalizeDocumentPath(path))
    if (!doc) throw new AppError(404, 'NOT_FOUND', '文件不存在')
    return { document: doc }
  }
  return { items: listDocuments(db, [scopeId], { includeDeleted: getQuery(event).includeDeleted === '1' }) }
})
