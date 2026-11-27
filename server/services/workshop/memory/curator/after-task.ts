/**
 * 任务终态后的"即时汇整"触发（2026-11-28）。
 *
 * 时机问题：Curator 默认 30 分钟一轮，图谱首轮还要等 60s 初始延迟 —— 全新频道跑完
 * 第一个真实任务后，第二回合的 L0.5（知识手册/图谱摘要）是空的，要等半小时才有料。
 * 知识的价值窗口就在"下一次作业开始前"，所以这里在任务成功收口后安排一次性汇整：
 *
 * 纪律：
 *  - 去抖：同频道 45s 内的多次完成只跑一次（lead 收口 + worker 收口会各触发一次）；
 *  - 不打扰：只在"还没有手册"或"上一轮手册已超过 10 分钟"时触发，避免高频任务下
 *    每次收口都重写手册（重写有 revision 成本与人工编辑保护判定）；
 *  - 异步 + 静默：失败只记日志，绝不影响任务状态机；单飞由 runCuratorForChannel 保证。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../../logger'
import { runCuratorForChannel } from './index'

const log = createLogger('memory.curator.after-task')

const DEBOUNCE_MS = 45_000
const STALE_AFTER_MS = 10 * 60_000
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** 频道手册是否"值得立即重算"：无手册，或手册超过 10 分钟未更新 */
function needsFreshCuration(db: DatabaseSync, channelId: string): boolean {
  try {
    const row = db.prepare(
      `SELECT updated_at AS updatedAt FROM agent_memories
        WHERE channel_id = ? AND kind = 'curated' AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
    ).get(channelId) as { updatedAt?: string } | undefined
    if (!row?.updatedAt) return true
    const at = Date.parse(row.updatedAt)
    if (!Number.isFinite(at)) return true
    return Date.now() - at > STALE_AFTER_MS
  }
  catch {
    return false
  }
}

/** 任务成功收口后调用（幂等、静默、可重复） */
export function scheduleCuratorAfterTask(db: DatabaseSync, channelId: string): void {
  if (!channelId || pending.has(channelId)) return
  if (!needsFreshCuration(db, channelId)) return
  const timer = setTimeout(() => {
    pending.delete(channelId)
    // 延迟到收口之后 45s：让同批任务的其它沉淀（团队任务行/编年史）先落库，
    // 手册一次性吸收，而不是连写两版。
    void runCuratorForChannel(db, channelId, { useLlm: Boolean(process.env.AW_MEMORY_CURATOR_LLM_URL?.trim()) })
      .then((res) => {
        if (res.status === 'ok') log.info(`[curator] 任务后即时汇整完成 channel=${channelId.slice(0, 8)} sources=${res.sourceCount}`)
      })
      .catch((err) => {
        log.warn(`[curator] 任务后即时汇整失败 channel=${channelId.slice(0, 8)}:`, err instanceof Error ? err.message : err)
      })
  }, DEBOUNCE_MS)
  timer.unref?.()
  pending.set(channelId, timer)
}

/** 停机清理（manager.stop 时调用，防撕裂的定时器） */
export function stopCuratorAfterTaskTimers(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}
