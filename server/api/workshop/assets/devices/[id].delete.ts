/**
 * DELETE /api/workshop/assets/devices/:id —— 删除设备模型文件(从模型库移除)。
 * - Bearer 用户 token;id 为 `dev-folder-<base>`(或裸 base 名);仅允许删除 devices 目录内文件。
 * - 已被设备孪生引用的模型删除后,对应场景节点在刷新/同步时因缺模型被跳过(不影响其余)。
 * - 返回 { deleted, file }
 */
import { getRouterParam } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import fs from 'node:fs'
import path from 'node:path'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const raw = getRouterParam(event, 'id')!
  const base = raw.replace(/^dev-folder-/, '')
  // 路径穿越与非法名防护:仅允许安全的文件基名
  if (!/^[A-Za-z0-9._ -]+$/.test(base) || base === '.' || base === '..') {
    throw new AppError(400, 'BAD_REQUEST', '非法模型 id')
  }
  const devDir = path.join(process.cwd(), 'public', 'assets', 'game', 'devices')
  const target = path.join(devDir, base)
  if (!target.startsWith(devDir + path.sep)) throw new AppError(400, 'BAD_REQUEST', '非法路径')

  // 文件可能带任意受支持扩展名:按基名匹配目录内文件
  let deleted = ''
  let entries: string[] = []
  try {
    entries = fs.readdirSync(devDir)
  }
  catch { /* 目录不存在:无文件可删 */ }
  for (const name of entries) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if ((ext === '.glb' || ext === '.gltf' || ext === '.obj' || ext === '.fbx') && name.slice(0, name.lastIndexOf('.')) === base) {
      fs.rmSync(path.join(devDir, name), { force: true })
      deleted = name
      break
    }
  }
  if (!deleted) throw new AppError(404, 'NOT_FOUND', `设备模型不存在: ${base}`)
  return { deleted: true, file: `/assets/game/devices/${deleted}` }
})
