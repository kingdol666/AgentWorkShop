/**
 * POST /api/workshop/eda/spc —— 注册控制图(见 index.get.ts 头注;Nitro 同路径双方法需分文件)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError } from '@/server/utils/errors'
import { createSpcChart } from '@/server/services/workshop/eda/spc'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<Record<string, unknown>>(event) ?? {}
  try {
    const chart = await createSpcChart(user, {
      lineId: String(body.line_id ?? ''),
      nodeId: String(body.node_id ?? ''),
      metric: body.metric == null ? '' : String(body.metric),
      kind: String(body.kind ?? 'i_mr'),
      params: (body.params ?? {}) as Record<string, unknown>,
    })
    return { chart }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = /可读范围/.test(msg) ? 403 : 400
    throw new AppError(status, 'VALIDATION_ERROR' as never, msg)
  }
})
