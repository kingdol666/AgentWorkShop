/**
 * POST /api/workshop/assets/devices —— 上传设备/实体 3D 模型(拖入小镇生成数字孪生)。
 * - Bearer 用户 token;multipart: file(.glb/.gltf)+ name(可选)
 * - 校验:扩展名白名单(glb/gltf/obj/fbx)+ 尺寸上限(30MB,3D 模型比贴图大)
 * - 写入 public/assets/game/devices/<id>.<ext>,运行期扫描接口即时可见
 * - 返回 { asset: SceneModelAsset }
 */
import { readMultipartFormData } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import fs from 'node:fs'
import path from 'node:path'

const ALLOWED_EXT = new Set(['.glb', '.gltf', '.obj', '.fbx'])
const MAX_BYTES = 30 * 1024 * 1024

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const parts = await readMultipartFormData(event)
  if (!parts || parts.length === 0) throw new AppError(400, 'BAD_REQUEST', '缺少上传文件(multipart form-data)')

  let file: { data: Uint8Array, name: string } | null = null
  let name = ''
  for (const p of parts) {
    if (p.name === 'file' && p.data) file = { data: p.data, name: p.filename ?? 'device.glb' }
    else if (p.name === 'name') name = (p.data?.toString() ?? '').trim()
  }
  if (!file) throw new AppError(400, 'BAD_REQUEST', '缺 file 字段')
  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) throw new AppError(400, 'UNSUPPORTED_TYPE', `不支持的模型类型: ${ext}(仅 ${[...ALLOWED_EXT].join('/')})`)
  if (file.data.length > MAX_BYTES) throw new AppError(400, 'TOO_LARGE', '文件超过 30MB 上限')

  const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const devDir = path.join(process.cwd(), 'public', 'assets', 'game', 'devices')
  fs.mkdirSync(devDir, { recursive: true })
  const filePath = path.join(devDir, `${id}${ext}`)
  fs.writeFileSync(filePath, file.data)

  return {
    asset: {
      id: `dev-folder-${id}`,
      name: name || file.name.replace(/\.[^.]+$/, ''),
      file: `/assets/game/devices/${id}${ext}`,
      category: 'device',
      fileType: ext.slice(1),
      defaultScale: 1,
      size: file.data.length,
      thumbnailPath: null,
      key: id,
    },
  }
})
