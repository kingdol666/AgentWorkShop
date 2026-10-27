/**
 * DAQ 导出护栏(设置化)。
 *
 * 背景(F7b):200 万点/节点(400 页 × 5000)与 7 天窗原为常量,大用户无法调升。
 * 本模块把两个上限收口为运行时设置,并做**硬上限钳位**(设置值不能突破服务端安全边界):
 *   daq.export.pagesPerNode 缺省 400,钳 1–2000(≤1000 万点/节点);
 *   daq.export.windowMaxH   缺省 168(7 天),钳 1–8760(1 年)。
 * 缺省值 = 原常量,存量行为逐字节不变。
 */
import { settingOf } from '../settings'

export const DEFAULT_PAGES_PER_NODE = 400
export const HARD_MAX_PAGES_PER_NODE = 2000
/** 与 tsdb 适配器单查硬上限一致(满页即续拉) */
export const PAGE_LIMIT = 5000
export const DEFAULT_WINDOW_MAX_H = 168
export const HARD_MAX_WINDOW_H = 8760

/** 单节点分页上限(页数) */
export function exportPagesPerNode(): number {
  const raw = Number(settingOf('daq.export.pagesPerNode'))
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGES_PER_NODE
  return Math.min(HARD_MAX_PAGES_PER_NODE, Math.max(1, Math.round(raw)))
}

/** 单次导出时间窗上限(ms) */
export function exportWindowMaxMs(): number {
  const raw = Number(settingOf('daq.export.windowMaxH'))
  const hours = !Number.isFinite(raw) || raw <= 0
    ? DEFAULT_WINDOW_MAX_H
    : Math.min(HARD_MAX_WINDOW_H, Math.max(1, Math.round(raw)))
  return hours * 3600_000
}

/** 时间窗上限(小时;用于工具错误文案) */
export function exportWindowMaxH(): number {
  return Math.round(exportWindowMaxMs() / 3600_000)
}
