/**
 * 消息级停滞看门狗的纯判定(2026-11-16 复现回归的语义核心)。
 *
 * 历史缺陷:固定 600s 从 claim 起算、不区分活动、HITL 人工等待也算停滞——
 * 实测把 16 分钟的健康治理回合(含 4 分钟 HITL)连续 abort+重投 3 次直到 dead,
 * 同一 message_id 被整段重放三轮,还连坐取消了频道内其它 active 任务。
 *
 * 新语义(只回答"现在该不该 fire",进程/计时器归 AgentRuntime):
 *  1. 运行时已停止 → 永不 fire;
 *  2. 距最近一次 harness 活动(事件/流式 delta/工具调用)< stallMs → 不 fire;
 *  3. 本 agent 有挂起 HITL 审批 → 不 fire("有人在裁"是合法等待,不是停滞);
 *  4. 其余(真无活动超过阈值)→ fire。
 */
export interface MessageWatchdogSnapshot {
  /** 运行时状态(stopped 时整个看门狗应已随回合结束而清除) */
  state: string
  /** 最近一次 harness 活动(epoch ms;claim 时初始化) */
  lastActivityAt: number
  /** 当前时间(epoch ms) */
  now: number
  /** 无活动阈值 ms(来自 harness_stall_timeout_ms,下限 60s) */
  stallMs: number
  /** 本 agent 是否有挂起 HITL 审批 */
  hasPendingApprovals: boolean
}

export function shouldFireMessageWatchdog(s: MessageWatchdogSnapshot): boolean {
  if (s.state === 'stopped') return false
  if (s.now - s.lastActivityAt < s.stallMs) return false
  if (s.hasPendingApprovals) return false
  return true
}

/** 看门狗巡检节奏( 每 tick 检查一次活动窗口;独立于 stallMs 本身) */
export const MESSAGE_WATCHDOG_TICK_MS = 30_000
