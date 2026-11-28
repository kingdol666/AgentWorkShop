/**
 * POST /api/workshop/channels/:id/memory-files —— 记忆文件命令（批次 J，人工操作）。
 */
import { getRouterParam, readBody } from 'h3'
import { AppError } from '../../../../../utils/errors'
import { defineApiHandler } from '../../../../../utils/response'
import { getWorkshopManager } from '../../../../../plugins/workshop'
import { resolveUser } from '../../../caller'
import { getAmlRuntime } from '../../../../../services/workshop/aml/runtime'
import { createDocument, documentRevisions, insertDocument, renameDocument, replaceInDocument, restoreDocument, softDeleteDocument } from '../../../../../services/workshop/memory/documents'
import { scopeIdOfChannel } from '../../../../../services/workshop/memory/blocks'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const channelId = getRouterParam(event, 'id')!
  const manager = getWorkshopManager()
  const channel = manager.getChannelForUser(channelId, user.id)
  manager.requireOwned(channel.ownerUserId, user.id, 'channel')
  const db = getAmlRuntime().db
  const scopeId = scopeIdOfChannel(channelId)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const command = String(body.command ?? 'create')
  const path = String(body.path ?? '')
  const input = { scopeId, channelId, path, content: String(body.content ?? ''), authorKind: 'human' as const, authorId: user.id }
  try {
    if (command === 'create') return { document: createDocument(db, input) }
    if (command === 'insert') return { document: insertDocument(db, input, Number(body.afterLine ?? 0)) }
    if (command === 'str_replace') return { document: replaceInDocument(db, input, String(body.oldText ?? '')) }
    if (command === 'rename') return { document: renameDocument(db, scopeId, path, String(body.newPath ?? ''), user.id) }
    if (command === 'delete') return { ok: softDeleteDocument(db, scopeId, path, user.id) }
    if (command === 'restore') return { ok: restoreDocument(db, scopeId, path) }
    if (command === 'revisions') return { items: documentRevisions(db, scopeId, path) }
    throw new AppError(422, 'INVALID_COMMAND', `未知 command ${command}`)
  }
  catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError(422, 'FILE_OPERATION_FAILED', err instanceof Error ? err.message : String(err))
  }
})
