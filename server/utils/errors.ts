/**
 * 统一业务异常
 * service 层通过抛出 AppError 表达业务失败，由路由层统一转换为响应。
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
  }
}

/** 统一错误码枚举 */
export const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  /** 写入保持窗:节点写成功后的防震荡锁定窗内收到新写(429) */
  WRITE_FREQUENT: 'WRITE_FREQUENT',
  /** DCW safety interlocks */
  STEP_LIMIT_EXCEEDED: 'STEP_LIMIT_EXCEEDED',
  RECIPE_LIMIT_EXCEEDED: 'RECIPE_LIMIT_EXCEEDED',
  NODE_RANGE_EXCEEDED: 'NODE_RANGE_EXCEEDED',
  PARAM_LIMIT_EXCEEDED: 'PARAM_LIMIT_EXCEEDED',
  PRODUCT_LIMIT_EXCEEDED: 'PRODUCT_LIMIT_EXCEEDED',
  WRITE_INTERVAL_NOT_ELAPSED: 'WRITE_INTERVAL_NOT_ELAPSED',
  EXPLORATION_SAFE_STEP_REQUIRED: 'EXPLORATION_SAFE_STEP_REQUIRED',
  INTERNAL: 'INTERNAL_ERROR',
} as const
