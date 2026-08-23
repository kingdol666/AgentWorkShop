/**
 * DELETE /api/workshop/assets/character/:id —— 删除模型(引删保护)。
 * - Bearer 用户 token;仍被 N 个 Agent 绑定 → 不硬删,返回 used>0 提示
 * - 未绑定 → 移除注册表记录 + 磁盘文件
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getCharacterAssetRepo } from '@/server/services/workshop/assets/character-asset.repo'
import fs from 'node:fs'
import path from 'node:path'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const id = getRouterParam(event, 'id')!
  const repo = getCharacterAssetRepo()
  const asset = repo.findById(id)
  if (!asset) throw new AppError(404, 'NOT_FOUND', `模型不存在: ${id}`)

  const res = repo.remove(id)
  if (!res.kept && !res.used) {
    // 硬删文件(从 public 路径还原磁盘路径)
    // 从 public 路径还原磁盘路径:file 形如 /assets/game/character/<id>.png → public/assets/...
    const rel = asset.file.replace(/^\//, '')
    const abs = path.join(process.cwd(), 'public', rel)
    try {
      fs.unlinkSync(abs)
    }
    catch { /* 文件可能已不在,忽略 */ }
  }
  return { deleted: !res.kept, used: res.used, asset: asset.file }
})
