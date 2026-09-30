/**
 * POST /api/workshop/dcw/mes-test-read —— MES REST 映射试读(body: { driverConfig })。
 * 供驱动表单调试 readMap:用户面鉴权 → 调 mes-rest 驱动 read 原语 →
 * { ok, eng, ts, latencyMs, message }(ts 从驱动消息的 ts=<ISO> 约定中提取;latencyMs 为本次调用墙钟)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { mesRestDcwDriver } from '@/server/services/workshop/dcw/drivers/mes-rest'

export default defineApiHandler(async (event) => {
  resolveUser(event)
  const body = await readBody<{
    driverConfig?: Record<string, unknown>
    domain?: { min?: number, max?: number }
  }>(event) ?? {}
  const domain = { min: Number(body.domain?.min ?? 0), max: Number(body.domain?.max ?? 100) }
  const t0 = Date.now()
  const r = await mesRestDcwDriver.read!({ domain, driverConfig: body.driverConfig ?? {} })
  const latencyMs = Date.now() - t0
  // 驱动 read 消息约定携带 ts=<ISO>;提取为结构化字段(缺省 null)
  const ts = r.message.match(/ts=([^\s,)]+)/)?.[1] ?? null
  return { ok: r.ok, eng: r.eng, ts, latencyMs, message: r.message }
})
