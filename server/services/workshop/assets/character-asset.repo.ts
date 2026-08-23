/**
 * CharacterAsset 注册表 —— JSON 文件持久化(轻量,无需迁移 DB)。
 *
 * 记录用户上传/内置的角色模型元信息(id/file/name/kind/sheet/anims/anchor/scale/author/createdAt/appliedTo)。
 * 应用级单例,写入 server/data/character-assets.json,进程内缓存,启动读盘。
 * 引删保护:appliedTo 里仍有 agent 绑定时,删除改为"停用"而非硬删。
 */

import fs from 'node:fs'
import path from 'node:path'

export interface CharacterAsset {
  id: string
  /** 作用域:空字符串 = 全局共享库;否则为该 workspace 私有 */
  workspaceId: string
  name: string
  /** 相对 public 的路径,供 Phaser 加载 */
  file: string
  kind: 'single' | 'sheet' | 'zip' | 'glb'
  /** 精灵表帧布局(与 town-anim 的 ModelAnimSpec 对齐) */
  sheet?: { frameWidth: number, frameHeight: number, frames: number }
  anims?: Partial<Record<'idle' | 'walk' | 'work', { start: number, count: number, frameRate?: number }>>
  anchor?: { x: number, y: number }
  scale?: number
  /** 已绑定该模型的 agentId 反向索引(引删保护用) */
  appliedTo: string[]
  author: string
  createdAt: string
}

const DB_PATH = process.cwd().endsWith('server') ? 'data/character-assets.json' : path.join(process.cwd(), 'server', 'data', 'character-assets.json')

function load(): CharacterAsset[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

function save(list: CharacterAsset[]): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2), 'utf-8')
}

class CharacterAssetRepo {
  private list: CharacterAsset[] = load()
  private readonly dbPath = DB_PATH

  listAll(workspaceId?: string): CharacterAsset[] {
    if (!workspaceId) return this.list
    return this.list.filter(a => a.workspaceId === workspaceId || a.workspaceId === '')
  }

  findById(id: string): CharacterAsset | undefined {
    return this.list.find(a => a.id === id)
  }

  create(asset: Omit<CharacterAsset, 'appliedTo' | 'createdAt'>): CharacterAsset {
    if (this.list.some(a => a.id === asset.id)) {
      const existing = this.list.find(a => a.id === asset.id)!
      // 幂等覆盖元信息,保留 appliedTo
      const merged: CharacterAsset = { ...existing, ...asset, appliedTo: existing.appliedTo ?? [] }
      this.list = this.list.map(a => a.id === asset.id ? merged : a)
      save(this.list)
      return merged
    }
    const full: CharacterAsset = { ...asset, appliedTo: [], createdAt: new Date().toISOString() }
    this.list.push(full)
    save(this.list)
    return full
  }

  bind(assetId: string, agentId: string): void {
    const asset = this.findById(assetId)
    if (!asset) return
    if (!asset.appliedTo.includes(agentId)) {
      asset.appliedTo.push(agentId)
      save(this.list)
    }
  }

  unbind(assetId: string, agentId: string): void {
    const asset = this.findById(assetId)
    if (!asset) return
    asset.appliedTo = asset.appliedTo.filter(id => id !== agentId)
    save(this.list)
  }

  /**
   * 删除(引删保护):仍被绑定 → 改为停用标记并返回 {ok, used};未绑定 → 硬删。
   * 返回是否成功删除文件(由调用方决定是否移除磁盘文件)。
   */
  remove(id: string): { ok: boolean, used: number, kept: boolean } {
    const asset = this.findById(id)
    if (!asset) return { ok: false, used: 0, kept: false }
    if (asset.appliedTo.length > 0) {
      // 仍被使用 → 保留记录(调用方据 used>0 提示"仍被 N 个 Agent 使用",不删文件)
      return { ok: true, used: asset.appliedTo.length, kept: true }
    }
    this.list = this.list.filter(a => a.id !== id)
    save(this.list)
    return { ok: true, used: 0, kept: false }
  }

  /** 是否存在空 workspaceId 的全局库(供前端展示区分) */
  readonly dbFile = this.dbPath
}

// 应用级单例
let singleton: CharacterAssetRepo | null = null
export function getCharacterAssetRepo(): CharacterAssetRepo {
  if (!singleton) singleton = new CharacterAssetRepo()
  return singleton
}
