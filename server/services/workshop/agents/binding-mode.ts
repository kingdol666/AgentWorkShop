/**
 * 绑定控制模式(auto/manual)切换判定 —— 纯函数,无 IO。
 *
 * 产线 Co-Pilot P2 auto 治理(计划 §5.4 / 铁律 2):
 *  - 无 mode 字段 / 与当前同名 → 不变更(无操作);
 *  - auto→manual → 自由方向(恢复人工审批,永远放行);
 *  - manual→auto → 等于**摘掉人类审批闸门**,必须携带显式 `confirm === true`
 *    (严格全等,字符串 'true'/1 一律不算)才允许切换。
 *
 * 抽成纯函数供 bindings/[id].patch.ts 路由调用,便于单测(tests/binding-mode-guard.test.ts)。
 */

export type BindingControlMode = 'auto' | 'manual'

/** 判定结论:ok=允许继续走 setMode;noop=无需变更(路由直接返回原绑定);否则 400 */
export interface ModeChangeDecision {
  ok: boolean
  /** 仅 ok=true 时可能出现:true=目标与当前一致(或未指定),无需变更 */
  noop?: boolean
  /** 仅 ok=false 时出现:true=缺风险确认(路由映射 400 + MODE_CONFIRM_REQUIRED) */
  needConfirm?: boolean
  /** ok=false 时的中文错误文案(进响应 message) */
  error?: string
}

/**
 * 判定「当前 mode + 目标 mode + confirm」是否允许切换 / 是否需要确认。
 *
 * @param current 绑定当前 mode(repo 权威值)
 * @param target  请求目标 mode;undefined=请求未携带 mode 字段 → 不变更
 * @param confirm 请求携带的确认标记;仅严格 `=== true` 视为已确认
 */
export function resolveModeChange(
  current: BindingControlMode,
  target: BindingControlMode | undefined,
  confirm: unknown,
): ModeChangeDecision {
  // 未携带 mode 字段:不变更(消掉旧实现 `?? 'auto'` 的静默缺省洞)
  if (target === undefined) return { ok: true, noop: true }
  // 同名 mode:无操作(免 confirm,也无审计必要——什么都没发生)
  if (target === current) return { ok: true, noop: true }
  // auto→manual:恢复人工审批,自由方向
  if (current === 'auto' && target === 'manual') return { ok: true }
  // manual→auto:摘审批闸门,必须显式确认
  if (confirm === true) return { ok: true }
  return {
    ok: false,
    needConfirm: true,
    error: '切换到 auto 将摘除该节点逐次人工审批闸门,需显式风险确认:请求体须携带 confirm: true(布尔)',
  }
}
