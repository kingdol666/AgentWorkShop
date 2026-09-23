/**
 * AgentTeam RPG 小镇(2D Phaser 表现层)— 模型库(拖拽加载 / 换装 / 落地生成)。
 *
 * 自 TownScene.ts 抽出:只通过宿主契约(TownModelHost)触达场景成员;
 * 角色能力复用 TownAgentHost(见 town-scene-agents.ts),气泡复用 TownBubbleHost。
 */
import type * as Phaser from 'phaser'
import { resolveAnimDef, type ModelAnimSpec } from '#shared/town-anim'
import { LEAD_SHEET, WORKER_SHEETS } from './town-scene-core'
import { nearestAgent, spawnResident, swapTexture, type TownAgentHost } from './town-scene-agents'
import { showBubble, type TownBubbleHost } from './town-scene-bubbles'

/** 模型库登记条目(id → file;供拖拽换装/生成用) */
export type ModelRegistryEntry = { id: string, file: string, name: string, spec?: ModelAnimSpec }

/** 模型库宿主(仅声明本模块触达的场景成员;角色能力见 TownAgentHost,气泡见 TownBubbleHost) */
export interface TownModelHost extends TownBubbleHost, TownAgentHost {
  /** 已注册的自定义模型(id → file),供拖拽换装/生成用 */
  readonly modelsById: Map<string, ModelRegistryEntry>
  /** 已声明帧布局的动画规格(自定义模型经 registerModelFromId 注入) */
  readonly animSpecs: Map<string, ModelAnimSpec>
  readonly anims: Phaser.Animations.AnimationManager
}

// 模型库 → 场景(拖拽加载 / 换装 / 落地生成)

/** 批量注册模型库清单(由 Vue 从 useCharacterAssets 注入;幂等) */
export function registerModelsFromList(host: TownModelHost, list: Array<{ id: string, file: string, name: string, spec?: ModelAnimSpec }>) {
  for (const m of list) {
    if (!host.modelsById.has(m.id)) {
      host.modelsById.set(m.id, { id: m.id, file: m.file, name: m.name, spec: m.spec })
    }
    if (m.spec) host.animSpecs.set(m.id, m.spec)
    // 注意:此处不得调用 ensureSheetAnims —— 场景尚未挂到 game,this.anims/this.textures 未初始化。
    // 动画统一在 create()/createAnimations() 里建(那时 game 已挂载)。
  }
}

/**
 * 注册一个自定义模型(按 assetId 从模型库清单查 file);幂等。
 * 记录元信息 + 帧布局,加载纹理动画。成功返回 true。
 */
export function registerModelFromId(host: TownModelHost, id: string, file: string, name: string, spec?: ModelAnimSpec): boolean {
  if (!host.modelsById.has(id)) host.modelsById.set(id, { id, file, name, spec })
  if (spec) host.animSpecs.set(id, spec)
  if (host.textures.exists(id)) {
    ensureSheetAnims(host, id)
    return true
  }
  return false
}

/**
 * HTML5 拖拽落下 → 落到某个角色上则「换装」该角色,否则在落点「生成一个居民」。
 * assetId 由 AssetLibrary 的 dragstart 写入 dataTransfer。
 */
export function dropModelOnWorld(host: TownModelHost, worldX: number, worldY: number, assetId: string): { mode: 'rebind' | 'spawn', agentId?: string, textureKey: string, x: number, y: number } {
  // 就近找落点 80px 内的角色
  const near = nearestAgent(host, worldX, worldY, 80)
  const model = host.modelsById.get(assetId)
  const texKey = model?.id ?? assetId
  // 若纹理未注册,先按模型库 file 加载(无则回退 assetId,可能为空 → 显示原纹理)
  if (model && !host.textures.exists(texKey)) registerModelFromId(host, assetId, model.file, model.name)
  if (near) {
    // 换装:直接改该角色所用纹理 + 动画 key
    swapTexture(host, near, texKey)
    showBubble(host, near.channelId, near.agentId, 'info', `换装 → ${model?.name ?? assetId}`, 2200)
    return { mode: 'rebind', agentId: near.agentId, textureKey: texKey, x: Math.round(near.sprite.x), y: Math.round(near.sprite.y) }
  }
  // 落点生成一个"居民"(可拖拽、可游走的装饰性角色;无实际 agent 绑定)
  if (host.textures.exists(texKey)) {
    spawnResident(host, worldX, worldY, texKey, model?.name ?? assetId)
    return { mode: 'spawn', textureKey: texKey, x: Math.round(worldX), y: Math.round(worldY) }
  }
  return { mode: 'rebind', textureKey: texKey, x: Math.round(worldX), y: Math.round(worldY) }
}

export function createAnimations(host: TownModelHost): void {
  const sheets = [...WORKER_SHEETS, LEAD_SHEET, 'knight', 'mage', 'bot']
  for (const sheet of sheets) {
    ensureSheetAnims(host, sheet)
  }
}

/** 为某纹理 key 建 idle/walk/work 三态动画(幂等);内置与自定义模型统一接口 */
export function ensureSheetAnims(host: TownModelHost, key: string): void {
  const def = resolveAnimDef(key, host.animSpecs.get(key))
  for (const state of ['idle', 'walk', 'work'] as const) {
    const a = def[state]
    const animKey = a.key
    if (!host.anims.exists(animKey)) {
      host.anims.create({
        key: animKey,
        frames: host.anims.generateFrameNumbers(key, { start: a.start, end: a.end }),
        frameRate: a.frameRate,
        repeat: a.repeat,
      })
    }
  }
  // 兼容旧播放名 wu-bob-<key>(仍能播悬停)
  if (!host.anims.exists(`wu-bob-${key}`)) {
    host.anims.create({
      key: `wu-bob-${key}`,
      frames: host.anims.generateFrameNumbers(key, { start: 0, end: (host.animSpecs.get(key)?.frames ?? 4) - 1 }),
      frameRate: 3,
      repeat: -1,
    })
  }
}
