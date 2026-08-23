/**
 * GET /api/workshop/assets/character —— 列出角色模型库(内置 + workspace 私有)。
 * - Bearer 用户 token;workspaceId 可选(query,缺省返回全局库)
 * - 返回 { assets: CharacterAsset[] }
 */
import { getQuery } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getCharacterAssetRepo } from '@/server/services/workshop/assets/character-asset.repo'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const q = getQuery(event)
  const workspaceId = typeof q.workspaceId === 'string' ? q.workspaceId : ''
  const repo = getCharacterAssetRepo()
  return { assets: repo.listAll(workspaceId) }
})
