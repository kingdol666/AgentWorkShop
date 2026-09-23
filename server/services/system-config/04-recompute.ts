/**
 * SystemConfigServiceLayer04 —— 有效值重算与磁盘重载
 * (分层 5/8,承 SystemConfigServiceLayer03;方法体与原文件逐行一致)
 */
import { SystemConfigServiceLayer03 } from './03-plugins'
import { readSettings, validateValue } from '@/shared/config/engine.mjs'

export abstract class SystemConfigServiceLayer04 extends SystemConfigServiceLayer03 {
  /** 全部描述符重算 effective + sources（base = runtimeConfig 构建值）
   *  并可选地把 live 键应用到 runtimeConfig */
  protected recompute({ applyLive = true } = {}): void {
    const effective: Record<string, unknown> = {}
    const sources: Record<string, 'config.yml' | 'runtime' | 'env'> = {}
    for (const desc of this.allDescriptors) {
      let value: unknown
      let source: 'config.yml' | 'runtime' | 'env'
      if (this.envOverrides[desc.key] !== undefined) {
        value = this.envOverrides[desc.key]
        source = 'env'
      }
      else if (this.overrides[desc.key] !== undefined) {
        value = this.overrides[desc.key]
        source = 'runtime'
      }
      else {
        const base = this.readBase(desc.key)
        value = base !== undefined ? base : desc.default
        source = 'config.yml'
      }
      effective[desc.key] = value
      sources[desc.key] = source
      if (applyLive || this.overrides[desc.key] !== undefined) this.applyToRuntime(desc.key, value)
    }
    this.effective = effective
    this.sources = sources
  }

  /** 从磁盘重读设置文件 → 校验 → recompute → 广播 */
  reloadFromDisk(): { changed: string[] } {
    const before = this.overrides
    const raw = readSettings(this.settingsPath)
    const validated: Record<string, unknown> = {}
    const changed: string[] = []
    for (const [key, value] of Object.entries(raw)) {
      const desc = this.map[key]
      if (!desc) continue // 未知键：忽略（schema 演进容错）
      const errs = validateValue(desc, value)
      if (errs.length) {
        console.warn(`[system-config] 忽略无效运行时覆盖 ${key}=${JSON.stringify(value)}: ${errs.join('; ')}`)
        continue
      }
      validated[key] = value
      if (before[key] !== value) changed.push(key)
    }
    for (const key of Object.keys(before)) {
      if (!(key in validated) && key in before) changed.push(key)
    }
    this.overrides = validated
    this.recompute()
    // 运行语义设置读取层(settings.ts effective 3s TTL)即时失效:live 键热重载零延迟
    void import('../workshop/settings').then(m => m.invalidateRuntimeSettingsCache()).catch(() => {})
    return { changed }
  }

  /* ---------------- 文件监听（外部写入热重载） ---------------- */
}
