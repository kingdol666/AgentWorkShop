/**
 * 故障窗口 —— 断链(disconnect)的触发与判定。
 * 断链是协议级故障:窗内协议端点拒绝/关闭连接(端口关闭 / HTTP 503),窗后自愈;
 * 值级故障(stuckAt/spike/drift)由 engine/signals.ts 处理。
 */
import type { DeviceNode } from '../../shared/types'

/** 任一信号当前处于断链窗内 */
export function faultWindowActive(node: DeviceNode): boolean {
  const now = Date.now()
  return (node.signals ?? []).some(s => (s.runtime?.disconnectUntil ?? 0) > now)
}

/** 每拍调用:按概率触发断链窗(写 runtime.disconnectUntil) */
export function maybeArmDisconnect(node: DeviceNode): void {
  const now = Date.now()
  for (const s of node.signals ?? []) {
    const d = s.faults?.disconnect
    if (!d || !s.runtime) continue
    if ((s.runtime.disconnectUntil ?? 0) > now) continue
    if (Math.random() < (d.probability ?? 0.002)) {
      s.runtime.disconnectUntil = now + d.durationMs
    }
  }
}
