/**
 * SystemConfigServiceLayer06 —— 写入 / 重置 / 重载 / 订阅与广播
 * (分层 7/8,承 SystemConfigServiceLayer05;方法体与原文件逐行一致)
 */
import { SystemConfigServiceLayer05 } from './05-snapshot'
import type { ConfigEventPayload, Listener } from './types'
import { AppError } from '../../utils/errors'
import { saveSettings, validateValue } from '@/shared/config/engine.mjs'

export abstract class SystemConfigServiceLayer06 extends SystemConfigServiceLayer05 {
  /**
   * 应用一批覆盖（PATCH 语义）。
   * @param patch { [key]: value }  value === null 表示清除该键覆盖（回落 config.yml/base）
   * @returns { changed, restartRequired, effective, sources }
   */
  patch(patch: Record<string, unknown>): { changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, unknown> } {
    const errors: Record<string, string[]> = {}
    const next = { ...this.overrides }
    const changed: string[] = []
    for (const [key, rawValue] of Object.entries(patch)) {
      const desc = this.map[key]
      if (!desc) {
        errors[key] = ['未知设置项（不在 shared/config/schema.json 中）']
        continue
      }
      // null → 清除覆盖
      if (rawValue === null || rawValue === undefined) {
        if (key in next) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- 撤销覆盖语义
          delete next[key]
          changed.push(key)
        }
        continue
      }
      const errs = validateValue(desc, rawValue)
      if (errs.length) {
        errors[key] = errs
        continue
      }
      if (next[key] !== rawValue) changed.push(key)
      next[key] = rawValue
    }
    if (Object.keys(errors).length) {
      throw new AppError(400, 'VALIDATION_ERROR', `设置校验失败: ${Object.entries(errors).map(([k, e]) => `${k}: ${e.join('; ')}`).join(' | ')}`)
    }
    if (changed.length) {
      this.overrides = next
      saveSettings(next, this.settingsPath)
      this.recompute()
    }
    return this.result(changed)
  }

  /** 清空全部运行时覆盖（回落 config.yml/base + env） */
  reset(): { changed: string[], restartRequired: string[] } {
    const changed = Object.keys(this.overrides)
    this.overrides = {}
    saveSettings({}, this.settingsPath)
    this.recompute()
    const res = this.result(changed)
    this.broadcast({ type: 'config:reset', changed, ...this.eventTail() })
    return res
  }

  /** 手动重载（外部已改文件）并广播 */
  reload(): { changed: string[], restartRequired: string[] } {
    const { changed } = this.reloadFromDisk()
    const res = this.result(changed)
    this.broadcast({ type: 'config:reloaded', changed, ...this.eventTail() })
    return res
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  protected eventTail() {
    return { restartRequired: this.restartRequiredKeys(), effective: { ...this.effective }, sources: { ...this.sources }, overrides: { ...this.overrides }, at: new Date().toISOString() }
  }

  protected result(changed: string[]): { changed: string[], restartRequired: string[], effective: Record<string, unknown>, sources: Record<string, unknown> } {
    const out = this.eventTail()
    const res = { changed, restartRequired: out.restartRequired as string[], effective: out.effective, sources: out.sources }
    if (changed.length) this.broadcast({ type: 'config:changed', changed, ...out })
    return res
  }

  protected restartRequiredKeys(): string[] {
    return this.allDescriptors.filter(d => d.applies === 'restart' && this.overrides[d.key] !== undefined).map(d => d.key)
  }

  protected broadcast(payload: ConfigEventPayload): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(payload)
      }
      catch (err) {
        console.error('[system-config] 广播监听器异常:', err)
      }
    }
  }
}
