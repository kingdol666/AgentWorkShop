/**
 * 频道执行三模式(observe / manual / auto)—— 语义单一声明源。
 *
 * 计划:docs/plans/2026-10-28-execution-modes-plan.md(M1)。
 * 频道层是**叠加钳位**:生效审批 = 频道 manual ∪ 产线 controlMode ∪ 绑定 mode(任一 manual 即挂审批)。
 *   - observe:观察模式 —— 写族工具注入面摘除 + 分发层按名拒写,Agent 只能数采/分析/查台账;
 *   - manual:手动模式 —— 频道层强制每次写动作挂 HITL(reason 必填,人类在审批卡可见"为什么");
 *   - auto:自动模式(**频道层中性缺省**)—— 频道不加额外约束,写动作的审批与限界由
 *     产线 controlMode(缺省 manual)与绑定 mode(首绑恒 manual)决定;自动执行仍受
 *     四层限界∩单步上限∩运行门∩60s 联锁∩越窗自动回退,且 rationale(hypothesis)必填入册。
 * 缺省恒 'auto'(频道层不收紧):存量频道(NULL/未知值)回到既有线/绑定判定,升级零行为变化;
 * fail-safe 由既有两层承担(线级缺省 manual、首绑恒 manual)。
 *
 * 依赖方向:本模块运行时导入 channel-profile(读频道模式);channel-profile 对本模块
 * 仅类型引用(内联归一),无环。
 */
import { getChannelTwinProfile } from '../aml/twin/channel-profile'

export type ExecutionMode = 'observe' | 'manual' | 'auto'

/** 非法/空值一律回落 auto(频道层中性:不额外收紧,fail-safe 由线/绑定层承担;升级零行为变化) */
export function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === 'observe' || value === 'manual' ? value : 'auto'
}

/** 频道当前执行模式(repo 权威值;异常/未配置 → auto 中性) */
export function executionModeOfChannel(channelId: string): ExecutionMode {
  try {
    return normalizeExecutionMode(getChannelTwinProfile(channelId).executionMode)
  }
  catch {
    return 'auto'
  }
}

/** Agent 所属频道的执行模式(经全局 manager 解析 agent→channel;未装配/未绑 = auto 中性)。
 *  供无 channelId 入参的判定点(recipe-gate 等)按 Agent 归属取钳位。 */
export function executionModeOfAgent(agentId: string): ExecutionMode {
  try {
    const g = globalThis as typeof globalThis & { __workshopManager?: { channelIdOfAgent(id: string): string | null } }
    const channelId = g.__workshopManager?.channelIdOfAgent(agentId) ?? null
    return channelId ? executionModeOfChannel(channelId) : 'auto'
  }
  catch {
    return 'auto'
  }
}

/**
 * 生效 HITL 判定(三层取最严;max manual):
 * 频道 manual 或产线 manual 或绑定 manual 任一成立即挂审批 —— 三层全 auto 才免批。
 * observe 频道不会走到写动作(注入面摘除 + 分发守卫拒写),本函数无需处理 observe。
 */
export function effectiveHitlRequired(channelMode: ExecutionMode, lineMode: 'auto' | 'manual', bindingMode: 'auto' | 'manual'): boolean {
  return channelMode === 'manual' || lineMode === 'manual' || bindingMode === 'manual'
}

export interface ExecutionModeDecision {
  ok: boolean
  /** true=目标与当前一致,无需变更(路由直接返回现值) */
  noop?: boolean
  /** true=缺风险确认(路由映射 400 + MODE_CONFIRM_REQUIRED) */
  needConfirm?: boolean
  error?: string
}

/**
 * 频道执行模式切换判定(纯函数,与 binding-mode.resolveModeChange 同语义家族):
 *   - 同名 → noop;
 *   - 收紧方向(auto→manual、任意→observe)自由;
 *   - 放开方向(manual→auto、observe→manual/auto)等于放开审批/写能力,必须显式 `confirm === true`。
 */
export function resolveExecutionModeChange(current: ExecutionMode, target: ExecutionMode, confirm: unknown): ExecutionModeDecision {
  if (target === current) return { ok: true, noop: true }
  const escalates = current === 'observe'
    || (current === 'manual' && target === 'auto')
  if (!escalates || confirm === true) return { ok: true }
  return {
    ok: false,
    needConfirm: true,
    error: target === 'auto'
      ? '切换到 auto 将放开频道层审批钳位(写动作仍受产线总闸与绑定模式约束、自动执行仍受限界/运行门/60s 联锁),需显式风险确认:请求体须携带 confirm: true(布尔)'
      : '从观察模式切出将开放工具写入面,需显式风险确认:请求体须携带 confirm: true(布尔)',
  }
}

/** observe 频道写动作拒绝文案(分发守卫与 handler 兜底共用,带行动指引) */
export function observeWriteRejectedText(toolName: string): string {
  return `${toolName} 在观察模式频道不可用:该频道为只读分析档(物理零写)。请改用数采/台账/分析工具完成作业;若确需下发控制,请由频道管理员把执行模式切到 manual(逐动作批准)或 auto(限界自动)。`
}
