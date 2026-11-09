import { defineEventHandler, H3Error, setResponseStatus, type H3Event } from 'h3'
import { AppError } from './errors'

/** 统一响应信封 */
export interface ApiEnvelope<T = unknown> {
  code: number | string
  message: string
  data: T | null
}

/** 成功响应 */
export function createSuccess<T>(data: T, message = 'ok'): ApiEnvelope<T> {
  return { code: 0, message, data }
}

/**
 * 沿 cause 链还原被 h3 包装的 AppError。
 *
 * h3 v2 的校验入口(`readValidatedBody`/`getValidatedQuery`)会把校验器抛出的异常交给
 * `createValidationError`:非 HTTPError 会被包成新的 HTTPError,原始错误挂在
 * `error.cause`(HTTPError 构造器把整个 details 对象赋给 cause,details.cause 才是原错误)。
 * 实测 `error.data` 与 `error.cause` 都不是 AppError,单层检查拿不到业务码。
 * 中间层可能不是 Error(是 details 字面量),所以按对象链遍历而非只认 Error;
 * 有限深度 + 自引用短路,避免环形 cause 造成死循环。
 */
function findAppError(error: unknown, maxDepth = 6): AppError | null {
  let cur: unknown = error
  for (let i = 0; i < maxDepth; i++) {
    if (cur == null || typeof cur !== 'object') return null
    const next = (cur as { cause?: unknown }).cause
    if (next === cur) return null
    if (next instanceof AppError) return next
    cur = next
  }
  return null
}

/**
 * API 路由统一包装器
 * - 业务成功 -> { code: 0, message: 'ok', data }
 * - AppError  -> 对应 HTTP 状态 + 业务错误码
 * - H3Error（含校验失败）-> 对应 HTTP 状态
 * - 未捕获异常 -> 500 + INTERNAL_ERROR（并记录日志）
 */
export function defineApiHandler<T>(handler: (event: H3Event) => Promise<T> | T) {
  return defineEventHandler(async (event): Promise<ApiEnvelope<T>> => {
    try {
      const data = await handler(event)
      return createSuccess(data)
    }
    catch (error) {
      if (error instanceof AppError) {
        setResponseStatus(event, error.status)
        return { code: error.code, message: error.message, data: null }
      }
      // 历史约定(裸 Error 自带数字 status)已全部迁移到 AppError(2026-10-30 P2-8):
      // 该分支会把任意库错误的 message(可能含内部路径/SQL)直通前端,故删除。
      // 现在只有 AppError 显式声明可对外消息;其余一律落到下面的 500 笼统文案。
      if (error instanceof H3Error) {
        // zValidator 抛出的 AppError 会被 h3 包装为 H3Error（data 或 cause 链）,此处还原精确信息
        const inner = error.data instanceof AppError ? error.data : findAppError(error)
        setResponseStatus(event, error.statusCode ?? 500)
        return {
          code: inner?.code ?? 'REQUEST_ERROR',
          message: inner?.message || error.message || error.statusMessage || '请求失败',
          data: null,
        }
      }
      console.error('[api] unhandled error:', error)
      setResponseStatus(event, 500)
      return { code: 'INTERNAL_ERROR', message: '服务器内部错误', data: null }
    }
  })
}
