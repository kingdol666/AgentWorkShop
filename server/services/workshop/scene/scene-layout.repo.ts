/**
 * SceneLayout 注册表 —— 频道领地放置(JSON 文件持久化)。
 *
 * 记录「哪个频道被放到 3D 小镇的哪个位置、边界多大」:
 *  - 场景初始为空场地;用户把频道坞里的频道拖入场景 → upsert 一条放置;
 *  - x/z = 领地中心(世界坐标);radiusX/radiusZ = 边界半径/半宽;shape = 椭圆/矩形;
 *  - rotationY = 边界朝向(度)。
 * 频道内的 Agent 只能在边界内活动(前端 FSM 按此钳制),初始铺位也用此边界。
 * 应用级单例,写入 server/data/scene-layouts.json,进程内缓存,启动读盘。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface SceneLayout {
  channelId: string
  /** 领地中心(世界坐标) */
  x: number
  z: number
  /** 边界半径(ellipse)/半宽(rect),世界单位 */
  radiusX: number
  radiusZ: number
  /** 边界形状 */
  shape: 'ellipse' | 'rect'
  /** 边界朝向(度) */
  rotationY: number
  /** 工作区(空 = 全局;供隔离扩展,当前全域读取) */
  workspaceId: string
  updatedAt: string
}

export interface SceneLayoutInput {
  x: number
  z: number
  radiusX: number
  radiusZ: number
  shape?: 'ellipse' | 'rect'
  rotationY?: number
  workspaceId?: string
}

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/scene-layouts.json'
  : path.join(process.cwd(), 'server', 'data', 'scene-layouts.json')

function load(): SceneLayout[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}
function save(list: SceneLayout[]): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2), 'utf-8')
}

class SceneLayoutRepo {
  private list: SceneLayout[] = load()

  listAll(): SceneLayout[] {
    return this.list
  }

  findByChannel(channelId: string): SceneLayout | undefined {
    return this.list.find(l => l.channelId === channelId)
  }

  /** 放置/更新(幂等 upsert) */
  upsert(channelId: string, input: SceneLayoutInput): SceneLayout {
    const now = new Date().toISOString()
    const next: SceneLayout = {
      channelId,
      x: Math.round(input.x * 10) / 10,
      z: Math.round(input.z * 10) / 10,
      radiusX: Math.max(40, Math.round(input.radiusX * 10) / 10),
      radiusZ: Math.max(40, Math.round(input.radiusZ * 10) / 10),
      shape: input.shape === 'rect' ? 'rect' : 'ellipse',
      rotationY: Math.round((input.rotationY ?? 0) * 10) / 10,
      workspaceId: input.workspaceId ?? '',
      updatedAt: now,
    }
    const idx = this.list.findIndex(l => l.channelId === channelId)
    if (idx >= 0) {
      this.list[idx] = next
    }
    else {
      this.list.push(next)
    }
    save(this.list)
    return next
  }

  remove(channelId: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(l => l.channelId !== channelId)
    if (this.list.length !== before) {
      save(this.list)
      return true
    }
    return false
  }
}

let singleton: SceneLayoutRepo | null = null
export function getSceneLayoutRepo(): SceneLayoutRepo {
  if (!singleton) singleton = new SceneLayoutRepo()
  return singleton
}
