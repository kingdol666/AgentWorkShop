/**
 * 频道 Harness overlay 的注入取用（WP-B1）。
 *
 * 装配点：`BaseAgent.contextPrefix()` —— 所有 harness 共用同一组装函数，
 * 因此只改一处即可让 14 个引擎一致生效。
 *
 * 三条铁律：
 *  - 无 active profile → 返回 ''（prompt 与现状逐字节一致）；
 *  - 任何失败 → 返回 ''（学习环绝不阻断回合装配）；
 *  - pins 只渲染仍存在的经验行（被删/退休 → 自然消失，不报错）。
 */
import { getAmlRuntime } from '../aml/runtime'
import { createMemoryRepo } from '../db/memory.repo'
import { createHarnessProfileRepo, renderHarnessOverlay } from './harness-profile'
import { unsegmentCJK } from '../runtime/memory/helpers'

/** 进程内缓存：同一频道 60s 内不重复查库（profile 变更最迟 1 分钟生效，可接受） */
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number, text: string }>()

/** 测试用：清空缓存（避免跨用例串味） */
export function resetHarnessOverlayCache(): void {
  cache.clear()
}

export function channelOverlayText(channelId: string): string {
  if (!channelId) return ''
  const hit = cache.get(channelId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text
  let text = ''
  try {
    const db = getAmlRuntime().db
    const profile = createHarnessProfileRepo(db).activeOf(channelId)
    if (profile) {
      const memRepo = createMemoryRepo(db)
      const pinned = (profile.layers.pins ?? [])
        .map(id => memRepo.getById(id))
        .filter((r): r is NonNullable<typeof r> => !!r && r.status !== 'retired')
        .map(r => ({ title: r.title, content: unsegmentCJK(r.content) }))
      text = renderHarnessOverlay(profile, pinned)
    }
  }
  catch {
    text = ''
  }
  cache.set(channelId, { at: Date.now(), text })
  return text
}
