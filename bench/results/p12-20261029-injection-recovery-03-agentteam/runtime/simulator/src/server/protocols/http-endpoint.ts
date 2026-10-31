/**
 * HTTP 端点 —— 与主服务器同端口(4010),无独立监听。
 * 路由:/sim-http/{deviceId}{path};主项目 http 驱动配
 *   url = http://127.0.0.1:4010/sim-http/{deviceId}/api/value
 * GET 响应:'${value}' 纯数字文本 / JSON 模板占位符 / vector:{"points":[…]} /
 *   image:PNG 二进制(content-type: image/png,主项目 image 驱动直读)。
 * POST(writable 端点):接受主项目 http DCW 驱动语义 {value: v} → 写回灌信号,
 *   响应 {ok:true, value}(含回读值)。
 * 断链故障注入:disconnect 激活期间 GET 返回 503(主项目 fetch 5s 超时/错误分类可测)。
 */
import type { DeviceNode } from '../../shared/types'
import type { ProtocolHandle } from './registry'
import { applyWriteback } from '../engine/signals'
import { saveConfig } from '../store'

const routes = new Map<string, DeviceNode>()

export function routeOf(deviceId: string, path: string): DeviceNode | undefined {
  const node = routes.get(deviceId)
  if (!node) return undefined
  return (node.config.paths ?? []).some(p => p.path === path) ? node : undefined
}

export interface HttpReply { status: number, body: string | Buffer, contentType: 'json' | 'text' | 'png' }

function renderTemplate(template: string, value: number, points: number[] | undefined): string {
  return template
    .replace(/\$\{value\}/g, String(value))
    .replace(/\$\{points\}/g, JSON.stringify(points ?? []))
}

export function serveHttp(node: DeviceNode, path: string): HttpReply {
  const m = (node.config.paths ?? []).find(p => p.path === path)
  if (!m) return { status: 404, body: 'not found', contentType: 'text' }
  const sig = (node.signals ?? []).find(s => s.id === m.signalId)
  // 断链注入:故障窗内 503
  const rt = sig?.runtime
  if (rt?.disconnectUntil && Date.now() < rt.disconnectUntil) {
    return { status: 503, body: 'disconnected(fault injection)', contentType: 'text' }
  }
  const template = m.responseTemplate
  // image 形态:无模板或模板 ${image} → PNG 二进制直出
  if (sig?.format === 'image' && rt?.image && (!template || template === '${image}')) {
    return { status: 200, body: Buffer.from(rt.image.png, 'base64'), contentType: 'png' }
  }
  const value = rt?.value ?? 0
  if (sig?.format === 'vector') {
    const body = (!template || template === '${value}')
      ? JSON.stringify({ points: rt?.vector ?? [], value })
      : renderTemplate(template, value, rt?.vector)
    return { status: 200, body, contentType: 'json' }
  }
  const body = (!template || template === '${value}') ? String(value) : renderTemplate(template, value, rt?.vector)
  return { status: 200, body, contentType: body.startsWith('{') ? 'json' : 'text' }
}

/** 按 deviceId + path 直接服务(index.ts 入口用;无循环依赖) */
export function serveById(deviceId: string, path: string): HttpReply {
  const node = routes.get(deviceId)
  if (!node) return { status: 404, body: 'not found', contentType: 'text' }
  return serveHttp(node, path)
}

/** POST 写控制(writable 端点):body {value:number} 或 {setpoint:number} 或纯数字 */
export function writeHttpControl(deviceId: string, path: string, rawBody: string): HttpReply {
  const node = routes.get(deviceId)
  if (!node) return { status: 404, body: 'not found', contentType: 'text' }
  const m = (node.config.paths ?? []).find(p => p.path === path && p.writable)
  if (!m) return { status: 405, body: 'not writable', contentType: 'text' }
  const sig = (node.signals ?? []).find(s => s.id === m.signalId)
  if (!sig) return { status: 500, body: 'signal missing', contentType: 'text' }
  let value: number | undefined
  try {
    const parsed = JSON.parse(rawBody || '{}') as Record<string, unknown>
    value = Number(parsed.value ?? parsed.setpoint)
  }
  catch { value = Number(rawBody.trim()) }
  if (!Number.isFinite(value)) return { status: 400, body: 'value must be numeric', contentType: 'text' }
  applyWriteback(sig, value)
  // HTTP writable endpoints are real control inputs; persist their setpoint.
  saveConfig()
  return { status: 200, body: JSON.stringify({ ok: true, value: sig.runtime?.value ?? value }), contentType: 'json' }
}

export async function startHttpEndpoint(node: DeviceNode): Promise<ProtocolHandle> {
  routes.set(node.id, node)
  return {
    close: async () => { routes.delete(node.id) },
    summary: () => ({ protocol: 'http', paths: (node.config.paths ?? []).map(p => `/sim-http/${node.id}${p.path}`) }),
  }
}
