/**
 * 0a2. 目标产线自适应 —— 原 L118–142
 * (由 scripts/three-system-e2e.mjs 按职责拆出;语句逐行原文搬运,仅跨模块引用/状态访问机械改写)
 *
 * 未显式指定 E2E_LINE 时,自动选「最近 10 分钟有采样」且节点最多的产线:
 * 数采按产线批次门控:无活动批次的产线没有样本,写死的默认线会随环境漂移而误报
 * (快照导出 rows=0 / diag_run「该时窗内无数采样本」)。
 */
import { api } from '../lib.mjs'
import { getLINE, getUserToken, setLINE } from '../state.mjs'

export async function run() {
  if (!process.env.E2E_LINE) {
    try {
      const daq = await api('GET', '/api/workshop/daq', { token: getUserToken() })
      const nodes = daq?.json?.data?.nodes ?? []
      const now = Date.now()
      const byLine = new Map()
      for (const n of nodes) {
        if (!n.lineId || n.lastAt == null) continue
        if (now - Date.parse(n.lastAt) > 10 * 60_000) continue
        byLine.set(n.lineId, (byLine.get(n.lineId) ?? 0) + 1)
      }
      const best = [...byLine.entries()].sort((a, b) => b[1] - a[1])[0]
      if (best) {
        setLINE(best[0])
        console.log(`  · 自动选定采样中的产线 ${getLINE()}(新鲜节点 ${best[1]} 个)`)
      }
      else {
        console.log('  ! 未发现采样中的产线,沿用默认线(相关采样断言可能失败)')
      }
    }
    catch { /* 探测失败保持默认线 */ }
  }
}
