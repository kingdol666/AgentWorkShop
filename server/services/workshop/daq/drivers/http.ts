/**
 * HTTP/REST 轮询真实驱动
 * (由 server/services/workshop/daq/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DaqDriver } from './shared'
import { extractNumeric, parseHeaders } from './mqtt'

// ============================================================
// HTTP/REST 轮询真实驱动(无状态 GET;JSON 路径或纯文本取值)
// ============================================================

export const httpDaqDriver: DaqDriver = {
  kind: 'http',
  async available() {
    return true
  },
  async sample({ driverConfig, signalKind }) {
    if (!driverConfig.url) throw new Error('缺少接口地址 url')
    const headers = parseHeaders(driverConfig.headersJSON)
    const res = await fetch(String(driverConfig.url), { headers, signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // v2 多形态分支(vector/image 由模板信号形态门控;标量端点零感知)
    if (signalKind === 'vector') {
      const j: unknown = JSON.parse(await res.text())
      const path = driverConfig.jsonPath ? String(driverConfig.jsonPath) : 'points'
      const target = path.split('.').reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), j)
      if (!Array.isArray(target)) throw new Error(`vector 帧报文缺少点列(jsonPath=${path})`)
      const points = (target as unknown[]).map(Number)
      if (points.length === 0 || points.length > 4096 || !points.every(Number.isFinite)) {
        throw new Error(`vector 帧点列非法(1~4096 个有限数值,实际 ${points.length})`)
      }
      return { frame: { kind: 'vector', points } }
    }
    if (signalKind === 'image') {
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('image/')) {
        const blob = Buffer.from(await res.arrayBuffer())
        if (blob.length === 0) throw new Error('image 帧响应体为空')
        // PNG 尺寸兜底:IHDR 宽高在固定偏移(width@16, height@20;大端)——端点不必额外传
        let width = Number(driverConfig.width ?? 0) || 0
        let height = Number(driverConfig.height ?? 0) || 0
        if ((!width || !height) && blob.length >= 24 && blob.readUInt32BE(12) === 0x49484452) {
          width = width || blob.readUInt32BE(16)
          height = height || blob.readUInt32BE(20)
        }
        return { frame: { kind: 'image', blob, mime: ct.split(';')[0]!, width, height } }
      }
      // JSON 报文:{ png: base64, width?, height? }
      const j = JSON.parse(await res.text()) as Record<string, unknown>
      const b64 = typeof j.png === 'string' ? j.png : typeof j.blob === 'string' ? j.blob : ''
      const blob = Buffer.from(b64, 'base64')
      if (blob.length === 0) throw new Error('image 帧报文缺少 png/blob(base64)字段')
      return { frame: { kind: 'image', blob, mime: 'image/png', width: Number(j.width ?? 0) || 0, height: Number(j.height ?? 0) || 0 } }
    }
    const text = await res.text()
    return extractNumeric(text, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
  },
  async test(driverConfig) {
    const t0 = Date.now()
    try {
      if (!driverConfig.url) return { ok: false, message: '缺少接口地址 url' }
      const headers = parseHeaders(driverConfig.headersJSON)
      const res = await fetch(String(driverConfig.url), { headers, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status}` }
      const ct = res.headers.get('content-type') ?? ''
      // 帧形态感知测试:同一端点形态可能是 vector(JSON 点列)/ image(PNG 或 base64)/ 标量
      if (ct.includes('image/')) {
        const n = (await res.arrayBuffer()).byteLength
        return { ok: true, message: `接口可达,image 帧 ${n}B(${ct.split(';')[0]})`, latencyMs: Date.now() - t0 }
      }
      const text = await res.text()
      try {
        const j = JSON.parse(text) as Record<string, unknown>
        if (Array.isArray(j.points) && (j.points as unknown[]).length > 0) {
          return { ok: true, message: `接口可达,vector 帧 ${(j.points as unknown[]).length} 点`, latencyMs: Date.now() - t0 }
        }
        if (typeof j.png === 'string' || typeof j.blob === 'string') {
          // 与生产分支同构:png/blob 至少一个是 base64 字符串(见上一行守卫)。
          // b64 的取值表达式与原来逐字一致(断言运行时擦除),只是把 unknown 标注成 string 以取 .length
          const b64 = (j.png as string | undefined) ?? (j.blob as string)
          return { ok: true, message: `接口可达,image 帧(base64, ${b64.length} chars)`, latencyMs: Date.now() - t0 }
        }
        const v = extractNumeric(text, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
        return { ok: true, message: `接口可达,取值 = ${v}`, sampleValue: v, latencyMs: Date.now() - t0 }
      }
      catch {
        const v = extractNumeric(text, driverConfig.jsonPath ? String(driverConfig.jsonPath) : undefined)
        return { ok: true, message: `接口可达,取值 = ${v}`, sampleValue: v, latencyMs: Date.now() - t0 }
      }
    }
    catch (err) {
      return { ok: false, message: `HTTP 请求失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}
