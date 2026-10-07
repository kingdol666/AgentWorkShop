/**
 * 对象存储 GC(P0-2)—— 帧行出清后像素文件的孤儿回收。
 *
 * 背景:daq_frames 行随 frameRetentionH 被 drop_chunks/DELETE 出清,但像素对象
 * (data/daq-objects/daq/<nodeId>/<y>/<m>/<d>/)此前从不删除 —— remove 全仓零调用,
 * 1Hz 相机场景数 GB/天/节点单调增长(实测 10285 文件/139MB)。
 *
 * 机制:24h 周期(首轮延迟 90s),按**天目录**粒度枚举 disk 后端对象,仅当
 *  ① 目录 UTC 天结束时间早于保留期地平线(frameRetentionH),且
 *  ② daq_frames 在该天窗口内已无任何行(DB 交叉校验 —— 兜住「保留期改大」「时钟回拨」「迟到帧」)
 * 才整目录删除。单轮限额 MAX_DIRS_PER_RUN,永不触碰形状不符路径。
 *
 * 首轮只对 disk 后端启用(minio 批量删除未实测,后续跟单测放行);删节点级联清像素
 * 见 daq-controller/crud.ts remove()。
 */
import { createLogger } from '../../logger'
import { daqRuntimeSettings } from '../../settings'
import { getTsdb } from '../storage'
import { getObjectStore } from './index'

const log = createLogger('daq.objectstore.gc')

const DAY_MS = 24 * 3600_000
const FIRST_RUN_DELAY_MS = 90_000
const MAX_DIRS_PER_RUN = 50

const g = globalThis as typeof globalThis & { __daqObjectGcStarted?: boolean }

/** 单轮清扫:返回删除的天目录数 */
export async function sweepObjectGcOnce(now = Date.now()): Promise<{ dirs: number, skippedByDb: number }> {
  const os = getObjectStore()
  if (os.backend !== 'disk' || !os.listDayDirs || !os.removePrefix) return { dirs: 0, skippedByDb: 0 }
  const horizonMs = now - daqRuntimeSettings().frameRetentionH * 3600_000
  const tsdb = getTsdb()
  let dirs = 0
  let skippedByDb = 0
  let entries: Awaited<ReturnType<NonNullable<typeof os.listDayDirs>>>
  try {
    entries = await os.listDayDirs()
  }
  catch (err) {
    log.warn(`[gc] 天目录枚举失败:${err instanceof Error ? err.message : String(err)}`)
    return { dirs: 0, skippedByDb: 0 }
  }
  for (const e of entries) {
    if (dirs >= MAX_DIRS_PER_RUN) break
    // ① 天界早于保留期地平线(天粒度删除 ⇒ 实际保留期向上取整到 UTC 天界,最多多留 1 天)
    if (e.dayEndMs > horizonMs) continue
    // ② DB 交叉校验:该天窗口仍有帧行则跳过(天目录边界 vs 行时间戳的强一致防线)
    const nodeId = e.prefix.split('/')[1] ?? ''
    try {
      const rows = await tsdb.queryFrames(nodeId, { fromMs: e.dayStartMs, toMs: e.dayEndMs - 1, limit: 1 })
      if (rows.length > 0) {
        skippedByDb++
        continue
      }
    }
    catch {
      // 查询失败(如后端切换窗口)→ 保守跳过,下轮再判
      skippedByDb++
      continue
    }
    try {
      await os.removePrefix(e.prefix)
      dirs++
      log.info(`[gc] 已出清过期帧对象目录 ${e.prefix}/(${new Date(e.dayStartMs).toISOString().slice(0, 10)})`)
    }
    catch (err) {
      log.warn(`[gc] 目录 ${e.prefix}/ 删除失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (dirs > 0 || skippedByDb > 0) log.info(`[gc] 本轮删除 ${dirs} 个天目录,DB 在窗跳过 ${skippedByDb} 个`)
  return { dirs, skippedByDb }
}

/** 启动挂载(server/plugins/daq.ts):90s 首轮 + 24h 周期;globalThis 防 HMR 重复;unref 不阻退出 */
export function startDaqObjectGc(): void {
  if (g.__daqObjectGcStarted) return
  g.__daqObjectGcStarted = true
  const first = setTimeout(() => {
    void sweepObjectGcOnce().catch((err) => {
      log.warn(`[gc] 首轮清扫失败:${err instanceof Error ? err.message : String(err)}`)
    })
  }, FIRST_RUN_DELAY_MS)
  first.unref?.()
  const timer = setInterval(() => {
    void sweepObjectGcOnce().catch((err) => {
      log.warn(`[gc] 定时清扫失败:${err instanceof Error ? err.message : String(err)}`)
    })
  }, DAY_MS)
  timer.unref?.()
}
