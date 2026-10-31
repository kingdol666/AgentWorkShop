/**
 * 设备运行时 —— 每设备独立 tick:信号推进 + 环形历史 + WS 推送。
 * 协议端点(Modbus/OPC UA 响应读请求;MQTT/HTTP 发布)按需读 runtime.value。
 */
import type { DeviceNode } from '../shared/types'
import { tickSignal, tickExpressionSignal, tickHookSignal } from './engine/signals'
import { maybeArmDisconnect } from './engine/faults'
import { broadcast } from './bus'
import { findNode, getConfig } from './store'

const timers = new Map<string, NodeJS.Timeout>()

/** 节点内所有信号的当前值快照(按 name 索引,表达式策略用) */
export function signalValues(node: DeviceNode): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of node.signals ?? []) out[s.name] = s.runtime?.value ?? 0
  return out
}

/** 推进设备内全部信号一拍(表达式/hook 信号最后处理,可引用其他信号;plant 绑定信号由模型接管) */
export function tickNode(node: DeviceNode, now = Date.now()): void {
  if (!node.enabled) return
  maybeArmDisconnect(node)
  const changed: Array<{ id: string, name: string, value: number, unit?: string }> = []
  const plain = (node.signals ?? []).filter(s =>
    !s.plantBinding && s.strategy.kind !== 'expression' && s.strategy.kind !== 'hook')
  const computed = (node.signals ?? []).filter(s =>
    !s.plantBinding && (s.strategy.kind === 'expression' || s.strategy.kind === 'hook'))
  for (const s of plain) {
    if (!s.runtime) s.runtime = { value: 0, hist: [] }
    const v = tickSignal(s, now)
    changed.push({ id: s.id, name: s.name, value: v, unit: s.unit })
  }
  const vars = signalValues(node)
  for (const s of computed) {
    if (!s.runtime) s.runtime = { value: 0, hist: [] }
    const v = s.strategy.kind === 'hook'
      ? tickHookSignal(s, vars, now)
      : tickExpressionSignal(s, vars, now)
    changed.push({ id: s.id, name: s.name, value: v, unit: s.unit })
    vars[s.name] = v
  }
  if (changed.length > 0) {
    broadcast({ type: 'signal.update', payload: { nodeId: node.id, signals: changed, at: now } })
  }
}

/** 启动设备定时器(每设备单 timer,节拍 = 全局 tickMs) */
export function startNode(node: DeviceNode): void {
  stopNode(node.id)
  const timer = setInterval(() => {
    const cur = findNode(node.id)
    if (!cur || !cur.enabled) return
    tickNode(cur)
  }, Math.max(node.tickMs, 200))
  timers.set(node.id, timer)
  node.runtime = { ...node.runtime, startedAt: Date.now() }
  // 启动即先推一拍,首值立即可读(否则 Modbus 测试连接读到 0)
  tickNode(node)
}

export function stopNode(id: string): void {
  const t = timers.get(id)
  if (t) { clearInterval(t); timers.delete(id) }
}

export function isRunning(id: string): boolean {
  return timers.has(id)
}

/** 启动全部 enabled 设备 */
export function startAll(): void {
  for (const n of getConfig().nodes) {
    if (n.enabled) startNode(n)
  }
}

export function stopAll(): void {
  for (const id of [...timers.keys()]) stopNode(id)
}
