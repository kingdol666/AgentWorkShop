/**
 * HTTP/REST 写驱动(POST JSON;2xx 视为受理)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwWriteDriver } from './shared'
import { AppError } from '../../../../utils/errors'

// ============================================================
// HTTP/REST 写驱动(POST JSON 设定值;2xx 视为受理)
// ============================================================

export const httpDcwDriver: DcwWriteDriver = {
  kind: 'http',
  async available() {
    return true
  },
  async write(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.url) throw new AppError(400, 'BAD_REQUEST', '缺少写接口地址 url')
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (cfg.headersJSON) {
        const parsed: unknown = JSON.parse(String(cfg.headersJSON))
        if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) headers[k] = String(v)
        }
      }
      const body = cfg.bodyKey ? JSON.stringify({ [String(cfg.bodyKey)]: input.eng }) : JSON.stringify({ value: input.eng })
      const res = await fetch(String(cfg.url), { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) })
      if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status},设定未受理`, raw: null, readback: null }
      let readback: number | null = null
      try {
        const j: unknown = await res.json()
        const target = cfg.bodyKey
          ? (j as Record<string, unknown>)?.[String(cfg.bodyKey)]
          : (j as Record<string, unknown>)?.value
        const n = Number(target)
        if (Number.isFinite(n)) readback = n
      }
      catch { /* 非 JSON 响应忽略回读 */ }
      return {
        ok: true,
        message: readback != null
          ? `POST 成功(HTTP ${res.status}),接口回读 ${readback}`
          : `POST 成功(HTTP ${res.status};接口未回传数值)`,
        raw: input.eng,
        readback,
      }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `HTTP 写入失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.url) return { ok: false, message: '缺少写接口地址 url' }
      // 安全语义:仅探测端点可达性(GET),不执行 POST,避免误触发真实设备动作
      const res = await fetch(String(driverConfig.url), { method: 'GET', signal: AbortSignal.timeout(5000) })
      return { ok: true, message: `端点可达(GET → HTTP ${res.status};未执行写入测试,避免误触发真实命令)` }
    }
    catch (err) {
      return { ok: false, message: `HTTP 端点不可达: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
