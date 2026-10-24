/**
 * Optimizer 工具门控(纯函数,无 Nitro/DB 依赖):
 * dispatch 与验收脚本共用同一判定,避免"注入面隐藏但当 REST/MCP 直调仍可执行"。
 */
export const OPTIMIZER_PREFIX = 'optimizer_'

export interface OptimizerGateInput {
  toolName: string
  /** Channel 档位(legacy / aml_training / aml_optimization / hybrid_twin / exp-miner / line-doctor) */
  twinKind: string
  /** 该 Agent 实例的有效绑定数(capabilities 允许 0) */
  bindingCount: number
}

export interface OptimizerGateResult {
  allowed: boolean
  /** 拒绝时的可判定错误码(前缀)与可读指引 */
  code?: 'OPTIMIZER_CHANNEL_DISABLED' | 'OPTIMIZER_PROFILE_DENIED' | 'BINDING_NOT_FOUND' | 'OPTIMIZATION_NOT_ELIGIBLE'
  message?: string
}

export function optimizerDispatchGate(input: OptimizerGateInput): OptimizerGateResult {
  const { toolName, twinKind, bindingCount } = input
  if (!toolName.startsWith(OPTIMIZER_PREFIX)) return { allowed: true }
  if (twinKind === 'legacy') {
    return {
      allowed: false,
      code: 'OPTIMIZER_CHANNEL_DISABLED',
      message: 'Channel 未启用 Twin profile,优化器工具拒绝执行。请先把 Channel 档位切到 aml_optimization(工艺优化)或 hybrid_twin。',
    }
  }
  if (twinKind !== 'aml_optimization' && twinKind !== 'hybrid_twin') {
    return {
      allowed: false,
      code: 'OPTIMIZER_PROFILE_DENIED',
      message: `${toolName} 仅在工艺优化(aml_optimization)或 hybrid_twin Channel 可用(当前 profile=${twinKind})。`,
    }
  }
  // capabilities 允许无绑定(用于解释为什么不可用);其余四个必须存在有效绑定
  if (toolName !== 'optimizer_capabilities' && bindingCount < 1) {
    return {
      allowed: false,
      code: 'BINDING_NOT_FOUND',
      message: `该 Agent 未绑定优化器 Profile;先在 Channel 设置中绑定后再调用 ${toolName}。`,
    }
  }
  return { allowed: true }
}

/**
 * 旧 `mpc_optimize` 别名迁移(G4.6):
 *  - 有优化器绑定 → 允许(新 Profile 路径仍应优先用 optimizer_solve);
 *  - 无绑定但有已绑定的 AML 模型**且该模型有优化资格** → 允许(既有 AML 模型驱动流程);
 *  - 有模型但无优化资格 / 两者皆无 → 拒绝并给"先绑定/先辨识"引导,不再返回可操作调参方案。
 */
export function legacyMpcAliasGate(input: { toolName: string, hasOptimizerBinding: boolean, hasBoundModel: boolean, hasEligibleModel?: boolean }): OptimizerGateResult {
  if (input.toolName !== 'mpc_optimize') return { allowed: true }
  if (input.hasOptimizerBinding) return { allowed: true }
  if (input.hasBoundModel && input.hasEligibleModel) return { allowed: true }
  if (input.hasBoundModel) {
    return {
      allowed: false,
      code: 'OPTIMIZATION_NOT_ELIGIBLE',
      message: '当前绑定的 AML 模型没有通过的优化资格报告(辨识不足/OOD/动作证据缺失)。请先完成 AML 数据集资格评估与模型晋级,或绑定优化器 Profile 后用 optimizer_solve。',
    }
  }
  return {
    allowed: false,
    code: 'BINDING_NOT_FOUND',
    message: 'mpc_optimize 需要已绑定优化器 Profile 或已绑定且具备优化资格的 AML 模型;当前两者皆无。请先在 Channel 设置中绑定 Profile,或完成 AML 训练与资格评估后再寻优。',
  }
}
