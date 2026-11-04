/**
 * PR17 M4-11 Effects/outbox（plan S11：事务内入队、提交后执行、指数退避、dead+升级）。
 *
 * 退避按 plan：5s → 300s 封顶；连续 3 次失败 → dead + 升级（notify effect）。
 * 状态只能向前：pending → running → done/dead；失败回 pending 带 next_retry_at。
 */
import type { ProjectKernelRepo, ProjectEffectRow } from '../db/project-kernel.repo'

export type EffectHandler = (effect: ProjectEffectRow, payload: Record<string, unknown>) => Promise<void> | void

export interface EffectsOutboxOptions {
  /** 注入时钟（单测）。返回 epoch ms。 */
  nowMs?: () => number
  maxAttempts?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
}

export interface DrainResult {
  done: number
  retried: number
  dead: number
  escalated: Array<{ effectId: string, dedupeKey: string }>
}

export function createEffectsOutbox(
  kernel: ProjectKernelRepo,
  handlers: Record<string, EffectHandler>,
  options: EffectsOutboxOptions = {},
) {
  const nowMs = options.nowMs ?? (() => Date.now())
  const maxAttempts = options.maxAttempts ?? 3
  const baseBackoffMs = options.baseBackoffMs ?? 5_000
  const maxBackoffMs = options.maxBackoffMs ?? 300_000

  const backoffMs = (attempts: number) => Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempts - 1))
  const iso = (ms: number) => new Date(ms).toISOString()

  return {
    /**
     * 执行到期的 pending effects。单条失败不阻塞其他；参数类错误同样退避
     * （v1 handlers 全部内部确定，无 schema 类不可重试错误需区分）。
     */
    async drain(limit = 20): Promise<DrainResult> {
      const nowIso = iso(nowMs())
      const due = kernel.effects.due(nowIso, limit)
      const result: DrainResult = { done: 0, retried: 0, dead: 0, escalated: [] }
      for (const effect of due) {
        if (!kernel.effects.claim(effect.id)) continue
        let handler: EffectHandler | undefined
        try {
          handler = handlers[effect.kind]
          if (!handler) throw new Error(`unknown effect kind: ${effect.kind}`)
          await handler(effect, JSON.parse(effect.payloadJson || '{}') as Record<string, unknown>)
          kernel.effects.markDone(effect.id)
          result.done += 1
        }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const attempts = kernel.effects.findById(effect.id)?.attempts ?? 1
          if (attempts >= maxAttempts) {
            kernel.effects.markDead(effect.id, message)
            result.dead += 1
            // 升级：dead 效果生成 owner 通知（dedupe 按 effectId，不重入）。
            const esc = kernel.effects.enqueue({
              projectId: effect.projectId,
              dedupeKey: `escalate:${effect.id}`,
              kind: 'notify',
              payload: { title: '项目副作用最终失败', effectId: effect.id, kind: effect.kind, error: message },
              traceId: effect.traceId,
            })
            if (esc.inserted) result.escalated.push({ effectId: effect.id, dedupeKey: esc.id })
          }
          else {
            kernel.effects.markRetry(effect.id, message, iso(nowMs() + backoffMs(attempts)))
            result.retried += 1
          }
        }
      }
      return result
    },
  }
}
