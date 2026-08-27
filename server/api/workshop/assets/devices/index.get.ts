/**
 * GET /api/workshop/assets/devices —— 设备/角色 3D 模型资源扫描(真实文件系统)。
 *
 * 扫描 public/assets/game/devices 与 public/assets/game/character 目录下的模型文件
 * (glb/gltf/obj/fbx),为每个文件生成资源元数据清单。浏览器侧经此 API 发现模型——
 * 运行期新增文件即时可见(不依赖 Vite 构建期 glob)。
 *
 * - 目录缺失/不可读 → 空数组(不报错,前端走内置兜底);
 * - 不支持的格式不会被静默收录(扩展名白名单外忽略);
 * - 返回 { devices: ModelAsset[], characters: ModelAsset[] },ModelAsset 见下方 type。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'

/** 扫描产出的模型资源元数据(前端模型库卡片消费) */
export interface SceneModelAsset {
  id: string
  name: string
  /** 浏览器可访问 URL(/assets/...;与上传资产同源) */
  file: string
  /** 资源类别:device = 设备实体模型,character = 角色模型 */
  category: 'device' | 'character'
  fileType: 'glb' | 'gltf' | 'obj' | 'fbx'
  /** 缺省缩放倍率(拖入场景时的 baseline;3D 渲染层再按包围盒归一化) */
  defaultScale: number
  /** 文件字节数 */
  size: number
  /** 缩略图(无则缺省;3D 模型不生成预览) */
  thumbnailPath: string | null
  /** 绑定的绑定键(与前端 dev-folder-<name>/character-folder-<name> 对齐) */
  key: string
}

const SUPPORTED = new Set(['.glb', '.gltf', '.obj', '.fbx'])
const BASE_DIRS = {
  device: 'public/assets/game/devices',
  character: 'public/assets/game/character',
}

/** 薄膜双拉产线基础设备元数据(basename → 展示名 + 相对高度系数)。
 *  高度系数以 TD 拉幅机为 1.0 基准(与设计稿一致的比例关系):
 *  渲染层把每个 GLB 归一化到基准高度 × 系数 —— 产线设备高矮错落,不做等高强归一。 */
const DEVICE_META: Record<string, { label: string, hFactor: number }> = {
  'extruder': { label: '挤出机 · EXT', hFactor: 0.69 },
  'caster': { label: '流延冷却单元 · CST', hFactor: 0.87 },
  'mdo': { label: 'MD 纵拉机 · MDO', hFactor: 1.08 },
  'tdo': { label: 'TD 拉幅机 · TDO', hFactor: 1.0 },
  'winder': { label: '收卷机 · WND', hFactor: 0.78 },
  'thickness-scanner': { label: '厚度扫描仪 · THK', hFactor: 0.82 },
  'agv': { label: 'AGV 搬运车 · AGV', hFactor: 0.38 },
  'power-cabinet': { label: '配电柜 · PWR', hFactor: 0.62 },
  'device-console': { label: '控制台 · CON', hFactor: 0.5 },
  'device-robot-arm': { label: '机械臂单元 · ARM', hFactor: 0.5 },
  'device-scanner': { label: '扫描仪 · SCN', hFactor: 1.0 },
  'pump': { label: '循环泵 · PMP', hFactor: 1.0 },
}

function scanDir(category: 'device' | 'character', folder: string): SceneModelAsset[] {
  const abs = join(process.cwd(), folder)
  let entries: string[]
  try {
    entries = readdirSync(abs)
  }
  catch {
    // 目录未建立:空清单(前端兜底内置)
    return []
  }
  const out: SceneModelAsset[] = []
  for (const name of entries.sort()) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (!SUPPORTED.has(ext)) continue
    let size = 0
    try {
      size = statSync(join(abs, name)).size
    }
    catch { /* 无权限等;仅元数据缺省 */ }
    const base = name.replace(/\.[^.]+$/, '')
    const id = `${category === 'device' ? 'dev-folder-' : 'ch-folder-'}${base}`
    const meta = category === 'device' ? DEVICE_META[base] : undefined
    out.push({
      id,
      name: meta?.label ?? base.replace(/[-_]/g, ' '),
      file: `/assets/game/${category === 'device' ? 'devices' : 'character'}/${name}`,
      category,
      fileType: ext.slice(1) as SceneModelAsset['fileType'],
      defaultScale: meta?.hFactor ?? 1,
      size,
      thumbnailPath: null,
      key: base,
    })
  }
  return out
}

export default defineApiHandler(async (event) => {
  resolveUser(event)
  return {
    devices: scanDir('device', BASE_DIRS.device),
    characters: scanDir('character', BASE_DIRS.character).filter(a => a.fileType === 'glb' || a.fileType === 'gltf'),
  }
})
