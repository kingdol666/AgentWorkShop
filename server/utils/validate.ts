import type { ZodTypeAny, output } from 'zod'
import { AppError, ErrorCodes } from './errors'

/**
 * 将 Zod schema 包装为 h3 兼容的校验函数
 * 校验失败抛出 AppError(400)，由 h3 统一包装为 400 响应，错误信息精确到首个字段。
 *
 * 泛型取 ZodTypeAny 而非 `ZodType<T>`：后者要求 input 与 output 同型，
 * `.default({})` / `.transform()` 这类 input≠output 的 schema 会因变异性被拒。
 * 返回类型取 `output<T>`，调用方拿到的仍是解析后的值。
 */
export function zValidator<T extends ZodTypeAny>(schema: T) {
  return (data: unknown): output<T> => {
    const result = schema.safeParse(data)
    if (!result.success) {
      const issue = result.error.issues[0]
      const field = issue?.path.join('.') || '参数'
      const detail = issue ? `${field}: ${issue.message}` : '参数校验失败'
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, detail)
    }
    return result.data
  }
}
