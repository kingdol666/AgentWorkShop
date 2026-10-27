/**
 * HTTP/REST 写驱动(POST JSON;2xx 视为受理)
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 *
 * 增强(2026-10-27 加固计划 F4):
 *  - timeoutMs(1s–60s,缺省 6s)/ secretRef + authType/authHeaderName
 *  - headersJSON 值支持 {{SECRET:REF}}(未解析整头省略);SSRF 与 mes-rest 同口径
 *  - 旧配置(url/bodyKey/headersJSON)行为不变
 */
import type { DcwWriteDriver } from './shared'
import { readbackAck } from './shared'
import { AppError } from '../../../../utils/errors'
import { assertSafeHttpUrl } from '../../net/ssrf'
import { authHeadersOf, clampTimeoutMs, interpolateSecretHeader } from '../../net/secret-auth'

// ============================================================
// HTTP/REST 写驱动(POST JSON 设定值;2xx 视为受理)
// ============================================================

async function writeHeaders(cfg: Record<string, unknown>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.headersJSON) {
    const parsed: unknown = JSON.parse(String(cfg.headersJSON))
    if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        const interpolated = await interpolateSecretHeader(String(v))
        if (interpolated !== null) headers[k] = interpolated
      }
    }
  }
  Object.assign(headers, await authHeadersOf(cfg))
  return headers
}

export const httpDcwDriver: DcwWriteDriver = {
  kind: 'http',
  async available() {
    return true
  },
  async write(input) {
    try {
      const cfg = input.driverConfig
      if (!cfg.url) throw new AppError(400, 'BAD_REQUEST', '缺少写接口地址 url')
      const url = await assertSafeHttpUrl(String(cfg.url), { allowPrivateHost: cfg.allowPrivateHost, legacyAllowPrivateWhenUnset: true, label: '写控数据源' })
      const headers = await writeHeaders(cfg)
      const body = cfg.bodyKey ? JSON.stringify({ [String(cfg.bodyKey)]: input.eng }) : JSON.stringify({ value: input.eng })
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(clampTimeoutMs(cfg.timeoutMs, 6000)) })
      if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status},设定未受理`, raw: null, readback: null, ack: 'unverified' }
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
      // ACK 鉴定如实上报:2xx+数值回传且与设定一致 = 设备证实;数值不一致 = 回读失败(不得当成功);
      // 2xx 无数值 = 仅链路受理,交写后验证器补验。
      if (readback != null) {
        const ack = readbackAck(input, readback, { raw: readback })
        if (ack.ack !== 'readback-verified') {
          return { ok: false, message: `POST 返回 HTTP ${res.status},但${ack.message}`, raw: input.eng, readback, ack: 'unverified' }
        }
        return { ...ack, message: `POST 成功(HTTP ${res.status}),${ack.message}` }
      }
      return {
        ok: true,
        ack: 'transport-ack',
        message: `POST 成功(HTTP ${res.status};接口未回传数值,设备侧待验证)`,
        raw: input.eng,
        readback: null,
      }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `HTTP 写入失败: ${err instanceof Error ? err.message : String(err)}`, raw: null, readback: null, ack: 'unverified' }
    }
  },
  async test(driverConfig) {
    try {
      if (!driverConfig.url) return { ok: false, message: '缺少写接口地址 url' }
      const url = await assertSafeHttpUrl(String(driverConfig.url), { allowPrivateHost: driverConfig.allowPrivateHost, legacyAllowPrivateWhenUnset: true, label: '写控数据源' })
      // 安全语义:仅探测端点可达性(GET),不执行 POST,避免误触发真实设备动作
      const res = await fetch(url, { method: 'GET', headers: await writeHeaders(driverConfig), signal: AbortSignal.timeout(clampTimeoutMs(driverConfig.timeoutMs, 5000)) })
      return { ok: true, message: `端点可达(GET → HTTP ${res.status};未执行写入测试,避免误触发真实命令)` }
    }
    catch (err) {
      if (err instanceof AppError) throw err
      return { ok: false, message: `HTTP 端点不可达: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
