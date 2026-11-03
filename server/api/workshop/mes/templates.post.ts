/**
 * POST /api/workshop/mes/templates —— 应用 MES 映射模板(H8)。
 *
 * body: { template_id, baseUrl, tag, pathPrefix?, secretRef?, authType?, authHeaderName?,
 *         allowPrivateHost?, dictionaryPath?, rateLimitPerSec?, maxConcurrent? }
 *
 * 返回可直接 PATCH 到 mes-rest 节点 driverConfig 的片段 + 形状校验结论 + 接入下一步。
 * 不联网、不落盘、不返回凭据明文(secretRef 只是引用名)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { applyMesTemplate } from '@/server/services/workshop/mes/mes-templates'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  const templateId = String(body.template_id ?? '').trim()
  if (!templateId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'template_id 必填(GET /api/workshop/mes/templates 可查)。')
  const { template_id: _ignored, ...input } = body
  const result = applyMesTemplate(templateId, input as Parameters<typeof applyMesTemplate>[1])
  if (!result.validation.ok) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `模板生成结果未通过形状校验:${result.validation.message}`)
  }
  return result
})
