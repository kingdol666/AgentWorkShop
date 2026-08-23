/**
 * POST /api/workshop/assets/character —— 上传角色模型(单帧 PNG 或精灵表)。
 * - Bearer 用户 token;multipart: file(图片)+ name + workspaceId + kind/sheet/anims(可选)
 * - 校验:type 白名单(png/webp/gif)+ 尺寸上限(5MB)+ 像素尺寸读取
 * - 写入 public/assets/game/character/<id>.png;注册表登记
 * - 返回 { asset: CharacterAsset }
 */
import { readMultipartFormData } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { AppError } from '@/server/utils/errors'
import { defineApiHandler } from '@/server/utils/response'
import { getCharacterAssetRepo } from '@/server/services/workshop/assets/character-asset.repo'
import fs from 'node:fs'
import path from 'node:path'

const ALLOWED = new Set(['image/png', 'image/webp', 'image/gif', 'model/gltf-binary', 'model/gltf+json', 'application/octet-stream'])
const MAX_BYTES = 5 * 1024 * 1024
/** 精灵表:读取 IHDR 宽高(大端) */
function readPngSize(buf: Uint8Array): { w: number, h: number } | null {
  if (buf.length < 24) return null
  // PNG signature 8 + IHDR len/type 8 → width at 16, height at 20(big-endian)
  const sig = (buf[12]! << 24) | (buf[13]! << 16) | (buf[14]! << 8) | buf[15]!
  if (sig !== 0x49484452) return null
  const rd16 = (o: number) => (buf[o]! << 24) | (buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!
  return { w: rd16(16), h: rd16(20) }
}
/** 是否为 3D 模型(.glb/.gltf) */
function is3dKind(type: string): boolean {
  return type === 'model/gltf-binary' || type === 'model/gltf+json' || type === 'application/octet-stream'
}

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const parts = await readMultipartFormData(event)
  if (!parts || parts.length === 0) throw new AppError(400, 'BAD_REQUEST', '缺少上传文件(multipart form-data)')

  let file: { data: Uint8Array, name: string, type: string } | null = null
  let name = ''
  let workspaceId = ''
  let kind = 'sheet'
  let frameWidth = 48
  let frameHeight = 88
  let frames = 4
  for (const p of parts) {
    if (p.name === 'file' && p.data) {
      file = { data: p.data, name: p.filename ?? 'model.png', type: p.type ?? '' }
    }
    else if (p.name === 'name') name = (p.data?.toString() ?? '').trim()
    else if (p.name === 'workspaceId') workspaceId = (p.data?.toString() ?? '').trim()
    else if (p.name === 'kind') kind = (p.data?.toString() ?? '').trim() || 'sheet'
    else if (p.name === 'frameWidth') frameWidth = Number(p.data?.toString() ?? 48) || 48
    else if (p.name === 'frameHeight') frameHeight = Number(p.data?.toString() ?? 88) || 88
    else if (p.name === 'frames') frames = Number(p.data?.toString() ?? 4) || 4
  }
  if (!file) throw new AppError(400, 'BAD_REQUEST', '缺 file 字段')
  if (!file.type || !ALLOWED.has(file.type)) throw new AppError(400, 'UNSUPPORTED_TYPE', `不支持的文件类型: ${file.type}(仅 png/webp/gif/glb/gltf)`)
  if (file.data.length > MAX_BYTES) throw new AppError(400, 'TOO_LARGE', '文件超过 5MB 上限')

  const is3d = is3dKind(file.type) || /\.(glb|gltf)$/i.test(file.name)

  // 像素校验(仅 png 可读 IHDR;webp/gif 跳过尺寸读取,靠浏览器渲染;glb/gltf 不校验像素)
  let dims: { w: number, h: number } | null = null
  if (file.type === 'image/png') dims = readPngSize(file.data)
  if (file.type === 'image/png' && !dims) throw new AppError(400, 'BAD_PIXEL', 'PNG 像素尺寸读取失败(文件损坏或非标准 PNG)')

  const id = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const ext = is3d
    ? (/\.gltf$/i.test(file.name) ? 'gltf' : 'glb')
    : file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'gif'
  const charDir = path.join(process.cwd(), 'public', 'assets', 'game', 'character')
  fs.mkdirSync(charDir, { recursive: true })
  const filePath = path.join(charDir, `${id}.${ext}`)
  fs.writeFileSync(filePath, file.data)

  const publicFile = `/assets/game/character/${id}.${ext}`
  const repo = getCharacterAssetRepo()
  const asset = repo.create({
    id,
    workspaceId,
    name: name || file.name.replace(/\.[^.]+$/, ''),
    file: publicFile,
    kind: (is3d ? 'glb' : kind === 'single' ? 'single' : kind === 'zip' ? 'zip' : 'sheet') as 'single' | 'sheet' | 'zip' | 'glb',
    sheet: !is3d && kind !== 'single' ? { frameWidth, frameHeight, frames } : undefined,
    author: 'user',
  })
  return { asset }
})
