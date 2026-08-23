/**
 * town-anim —— 角色模型 → 动画状态映射(纯函数,零 Phaser,可单测)。
 *
 * 让「内置精魂」与「自定义上传模型」走同一套动画接口:
 *  - resolveAnimDef(textureKey, model) → 依模型帧布局给出 idle/walk/work 的帧区间与帧率。
 *  - 约定:模型若声明 anims 就用之;否则回退默认(4 帧悬停 bob = 全部帧循环)。
 *  - 供 TownScene 在 registerModelFromId / createAnimations / swapTexture 统一取帧。
 */

/** 一个动画状态的定义 */
export interface AnimDef {
  key: string
  /** 起止帧号(含 end) */
  start: number
  end: number
  frameRate: number
  /** 是否循环 */
  repeat: number
}

/** 模型帧布局声明(与 CharacterAsset.sheet/anims 对齐) */
export interface ModelAnimSpec {
  frameWidth?: number
  frameHeight?: number
  frames?: number
  /** 各状态帧覆盖;缺省按默认整表循环 */
  anims?: Partial<Record<'idle' | 'walk' | 'work', { start: number, count: number, frameRate?: number }>>
}

/** 默认悬停 bob(与内置 wu-* 一致):全部帧循环 */
const DEFAULT_BOB = { start: 0, end: 3, frameRate: 3, repeat: -1 }

/** 解析某纹理 key 对应的动画定义(idle/walk/work)。缺省给悬停 bob。 */
export function resolveAnimDef(textureKey: string, spec?: ModelAnimSpec): Record<'idle' | 'walk' | 'work', AnimDef> {
  const mk = (state: 'idle' | 'walk' | 'work'): AnimDef => {
    const a = spec?.anims?.[state]
    if (!a) {
      // 默认:无状态覆盖 → 整表循环(悬停 bob),区分 idle 慢、walk 中间、work 快
      const rate = state === 'idle' ? DEFAULT_BOB.frameRate : state === 'work' ? 8 : 5
      return { key: `${textureKey}-${state}`, start: 0, end: DEFAULT_BOB.end, frameRate: rate, repeat: -1 }
    }
    return {
      key: `${textureKey}-${state}`,
      start: a.start,
      end: a.start + (a.count || 1) - 1,
      frameRate: a.frameRate ?? 6,
      repeat: -1,
    }
  }
  return { idle: mk('idle'), walk: mk('walk'), work: mk('work') }
}

/** 便捷:是否已声明多状态(否则仅悬停 bob) */
export function hasMultiState(spec?: ModelAnimSpec): boolean {
  return Boolean(spec?.anims)
}
