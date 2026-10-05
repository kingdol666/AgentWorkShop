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
      // 兜底:服务层抛出的裸 Error 若自带数字 status(历史约定),按其映射而非一律 500
      const legacyStatus = (error as unknown as { status?: unknown }).status
      if (typeof legacyStatus === 'number' && legacyStatus >= 400 && legacyStatus < 600) {
        setResponseStatus(event, legacyStatus)
        return { code: legacyStatus === 404 ? 'NOT_FOUND' : 'REQUEST_ERROR', message: (error as Error).message, data: null }
      }
      if (error instanceof H3Error) {
        // zValidator 抛出的 AppError 会被 h3 包装为 H3Error，此处还原精确信息
        const inner = error.data instanceof AppError ? error.data : null
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
