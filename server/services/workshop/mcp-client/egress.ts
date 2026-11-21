/**
 * 外部 MCP 出站护栏：HTTPS-only、拒绝 URL 凭据/查询、DNS 解析后全量 IP 校验、
 * 同源重定向逐跳校验、连接使用已校验 IP 绑定（防 DNS rebinding）。
 *
 * 测试可注入 validate/fetchImpl；生产默认使用 node:https + pinned lookup。
 * 本模块不做任何重试（有副作用调用不得自动重放）。
 */
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { AppError } from '../../../utils/errors'

export type McpFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>

interface PinnedAddress {
  address: string
  family: 4 | 6
}

/** 非公网/保留地址（比既有 SSRF 更严：包含 CGNAT、文档/基准段、组播/保留/未指定） */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.toLowerCase().startsWith('::ffff:') ? raw.slice(7) : raw
  const v4 = isIP(ip) === 4
  if (v4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b! >= 64 && b! <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b! >= 16 && b! <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0 && [0, 2].includes(Number(ip.split('.')[2]))) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && Number(ip.split('.')[2]) === 100) return true
    if (a === 203 && b === 0 && Number(ip.split('.')[2]) === 113) return true
    if (a! >= 224) return true
    return false
  }
  if (isIP(ip) === 6) {
    const first = Number.parseInt(ip.split(':')[0] || '0', 16)
    if (ip === '::' || ip === '::1') return true
    if ((first & 0xfe00) === 0xfc00) return true
    if ((first & 0xffc0) === 0xfe80) return true
    if ((first & 0xff00) === 0xff00) return true
    return false
  }
  return true
}

function assertUrlShape(url: URL): void {
  if (url.protocol !== 'https:') throw new AppError(400, 'MCP_HTTPS_REQUIRED', 'MCP 出站仅允许 https')
  if (url.username || url.password) throw new AppError(400, 'MCP_URL_CREDENTIALS_DENIED', 'MCP URL 不能内嵌凭据')
  if (url.search) throw new AppError(400, 'MCP_URL_QUERY_DENIED', 'MCP URL 不允许查询参数')
  if (url.hash) throw new AppError(400, 'MCP_URL_FRAGMENT_DENIED', 'MCP URL 不允许片段')
}

/** 解析并校验全部 A/AAAA；任一私网/保留地址即整批拒绝（含 rebinding 防御） */
export async function resolveAndValidateHost(hostname: string): Promise<PinnedAddress[]> {
  let addresses: Array<{ address: string, family: number }>
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  }
  else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true })
    }
    catch (err) {
      throw new AppError(400, 'MCP_DNS_FAILED', `MCP 主机解析失败：${hostname}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  if (addresses.length === 0) throw new AppError(400, 'MCP_DNS_EMPTY', 'MCP 主机没有可用地址')
  const blocked = addresses.filter(x => isBlockedAddress(x.address))
  if (blocked.length > 0) {
    throw new AppError(400, 'MCP_EGRESS_DENIED', `MCP 目标解析到内网/保留地址，已拒绝：${blocked.map(x => x.address).join(', ')}`)
  }
  return addresses.map(x => ({ address: x.address, family: x.family === 6 ? 6 : 4 }))
}

/** 生产 URL 校验（不依赖 AW_ALLOW_PRIVATE_OUTBOUND，不提供私网豁免） */
export async function validateEgressUrl(url: URL): Promise<void> {
  assertUrlShape(url)
  await resolveAndValidateHost(url.hostname)
}

/** 连接层绑定已校验 IP，避免校验后再次解析到私网 */
async function pinnedLookup(hostname: string): Promise<PinnedAddress> {
  const addresses = await resolveAndValidateHost(hostname)
  return addresses[0]!
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void

/** 生产 fetch：node:https + pinned lookup + 流式 Response（供 MCP SSE/JSON） */
async function httpsFetch(input: URL | string | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
  const pinned = await pinnedLookup(url.hostname)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  let body: string | Uint8Array | undefined
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string' || init.body instanceof Uint8Array) body = init.body
    else throw new AppError(400, 'MCP_BODY_UNSUPPORTED', 'MCP 请求 body 必须是字符串或字节数组')
  }

  return await new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal: init?.signal ?? undefined,
      servername: url.hostname,
      lookup: (_hostname: string, _options: unknown, cb: LookupCallback) => cb(null, pinned.address, pinned.family),
    }, (res) => {
      const responseHeaders = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === 'string') responseHeaders.set(key, value)
        else if (Array.isArray(value)) responseHeaders.set(key, value.join(', '))
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', chunk => controller.enqueue(new Uint8Array(chunk)))
          res.on('end', () => controller.close())
          res.on('error', err => controller.error(err))
        },
      })
      resolve(new Response(stream, { status: res.statusCode ?? 502, headers: responseHeaders }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export interface GuardedFetchOptions {
  validate: (url: URL) => Promise<void>
  fetchImpl: McpFetch
  maxRedirects?: number
}

/** 通用受控 fetch：逐跳校验；跨源重定向一律拒绝；303 才改 GET；不做重试 */
export async function guardedFetch(
  input: URL | string | Request,
  init: RequestInit | undefined,
  opts: GuardedFetchOptions,
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3
  let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
  const originalOrigin = url.origin
  let method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  let body = init?.body
  if (body === undefined && input instanceof Request && method !== 'GET' && method !== 'HEAD') {
    body = await input.text()
  }
  let currentInit: RequestInit = { ...init, method, headers, body, redirect: 'manual' }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await opts.validate(url)
    const response = await opts.fetchImpl(url, currentInit)
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    if (!location) return response
    const next = new URL(location, url)
    if (next.origin !== originalOrigin) {
      throw new AppError(400, 'MCP_REDIRECT_ORIGIN_DENIED', 'MCP 重定向跨源，已拒绝')
    }
    if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET'
      body = undefined
      currentInit = { ...currentInit, method, body }
    }
    url = next
  }
  throw new AppError(400, 'MCP_REDIRECT_LIMIT', `MCP 重定向超过 ${maxRedirects} 次`)
}

/** 生产 MCP fetch 单例工厂（无私网放行参数） */
export function createMcpFetch(maxRedirects = 3): McpFetch {
  return (input, init) => guardedFetch(input, init, {
    validate: validateEgressUrl,
    fetchImpl: httpsFetch,
    maxRedirects,
  })
}
