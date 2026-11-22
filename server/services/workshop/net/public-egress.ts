/** Direct, credential-free HTTPS downloads with public IP validation and pinning on every hop. */
import dns from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'
import { AppError } from '../../../utils/errors'

const MAX_REDIRECTS = 4
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export interface PublicFetchOptions {
  allowedHosts?: ReadonlySet<string>
  maxBytes?: number
  timeoutMs?: number
  label?: string
  signal?: AbortSignal
}

/** Conservative IANA special-use policy. IPv6 must be native global unicast (no mapped/translation addresses). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))
        || (b === 31 && c === 196) || (b === 52 && c === 193) || (b === 88 && c === 99) || (b === 175 && c === 48)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || address.includes('%')) return false
  const [a = 0, b = 0, c = 0] = address.split(':').map(h => Number.parseInt(h || '0', 16))
  return (a & 0xe000) === 0x2000
    && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) // IETF protocol assignments (incl. Teredo), documentation
    && a !== 0x2002 // 6to4
    && !(a === 0x2620 && b === 0x4f && c === 0x8000) // AS112
    && !(a === 0x3fff && b < 0x1000) // documentation
}

function checkedUrl(raw: string, options: PublicFetchOptions, base?: URL): URL {
  const label = options.label ?? '公网目标'
  let url: URL
  try {
    url = new URL(raw, base)
  }
  catch {
    throw new AppError(400, 'PUBLIC_URL_INVALID', `${label} URL 无效`)
  }
  if (url.protocol !== 'https:' || url.port) {
    throw new AppError(400, 'PUBLIC_URL_PROTOCOL_DENIED', `${label} 仅允许 HTTPS 默认端口`)
  }
  if (url.username || url.password) {
    throw new AppError(400, 'PUBLIC_URL_CREDENTIALS_DENIED', `${label} URL 不允许内嵌凭据`)
  }
  if (url.hash) throw new AppError(400, 'PUBLIC_URL_INVALID', `${label} URL 不允许片段`)
  const hostname = url.hostname
  if (hostname.endsWith('.') || hostname === 'localhost' || hostname.endsWith('.localhost')
    || (options.allowedHosts && !options.allowedHosts.has(hostname))) {
    throw new AppError(400, 'PUBLIC_URL_HOST_DENIED', `${label} 主机不在允许范围`)
  }
  return url
}

function deadline(options: PublicFetchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
}

function aborted(options: PublicFetchOptions): AppError {
  return new AppError(504, 'PUBLIC_FETCH_ABORTED', `${options.label ?? '公网目标'} 请求超时或取消`)
}

async function checkedAddress(url: URL, options: PublicFetchOptions, signal: AbortSignal): Promise<{ address: string, family: number }> {
  if (signal.aborted) throw aborted(options)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(hostname)
  const addresses = literal
    ? [{ address: hostname, family: literal }]
    : await new Promise<Awaited<ReturnType<typeof lookupAll>>>((resolve, reject) => {
        // getaddrinfo itself is not cancellable; stop waiting and never connect if the deadline fires.
        const onAbort = () => reject(aborted(options))
        signal.addEventListener('abort', onAbort, { once: true })
        void lookupAll(hostname).then(resolve, () => {
          reject(new AppError(502, 'PUBLIC_URL_DNS_FAILED', `${options.label ?? '公网目标'} DNS 解析失败`))
        }).finally(() => signal.removeEventListener('abort', onAbort))
      })
  if (signal.aborted) throw aborted(options)
  const pinned = addresses.find(a => a.family === 4) ?? addresses[0]
  if (!pinned) throw new AppError(502, 'PUBLIC_URL_DNS_EMPTY', `${options.label ?? '公网目标'} 没有可用地址`)
  if (addresses.some(a => a.family !== isIP(a.address) || !isPublicAddress(a.address))) {
    throw new AppError(400, 'PUBLIC_URL_IP_DENIED', `${options.label ?? '公网目标'} 解析到非公网或保留地址`)
  }
  return pinned
}

async function lookupAll(hostname: string) {
  return await dns.lookup(hostname, { all: true, order: 'verbatim' })
}

/** Initial URL/DNS policy only. This does not pin connections made by a separate process. */
export async function validatePublicUrl(raw: string, options: PublicFetchOptions = {}): Promise<URL> {
  const url = checkedUrl(raw, options)
  await checkedAddress(url, options, deadline(options))
  return url
}

async function requestOnce(url: URL, options: PublicFetchOptions, signal: AbortSignal): Promise<{ body: Buffer } | { location: string }> {
  const pinned = await checkedAddress(url, options, signal)
  const label = options.label ?? '公网目标'
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  // An explicit fresh agent avoids the process-wide agent and its environment proxy configuration.
  const agent = new https.Agent({ keepAlive: false })
  return await new Promise<{ body: Buffer } | { location: string }>((resolve, reject) => {
    const failed = () => reject(signal.aborted ? aborted(options) : new AppError(502, 'PUBLIC_FETCH_FAILED', `${label} HTTPS 下载失败`))
    // Keep the URL hostname for Host/SNI and certificate verification. No auth/cookie headers.
    const req = https.request(url, {
      method: 'GET',
      agent,
      rejectUnauthorized: true,
      family: pinned.family,
      signal,
      lookup: (_hostname, _opts, callback) => callback(null, pinned.address, pinned.family),
    }, (res) => {
      const status = res.statusCode ?? 0
      res.once('error', failed)
      if (REDIRECTS.has(status)) {
        const locations = res.headersDistinct.location
        if (locations?.length === 1 && locations[0]) resolve({ location: locations[0] })
        else reject(new AppError(502, 'PUBLIC_REDIRECT_INVALID', `${label} 重定向缺少唯一 Location`))
        res.destroy()
        return
      }
      if (status !== 200) {
        reject(new AppError(502, 'PUBLIC_FETCH_FAILED', `${label} 返回 HTTP ${status}`))
        res.destroy()
        return
      }
      const tooLarge = () => {
        reject(new AppError(413, 'PUBLIC_RESPONSE_TOO_LARGE', `${label} 响应超过 ${maxBytes} 字节`))
        res.destroy()
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        tooLarge()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) tooLarge()
        else chunks.push(chunk)
      })
      res.once('end', () => {
        if (res.complete) resolve({ body: Buffer.concat(chunks, size) })
        else failed()
      })
      res.once('close', () => {
        if (!res.complete) failed()
      })
    })
    req.once('error', failed)
    req.end()
  }).finally(() => agent.destroy())
}

/** One deadline for DNS, headers, redirects and body; each redirect gets a fresh pinned connection. */
export async function fetchPublicBuffer(raw: string, options: PublicFetchOptions = {}): Promise<Buffer> {
  const signal = deadline(options)
  let url = checkedUrl(raw, options)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestOnce(url, options, signal)
    if ('body' in response) return response.body
    if (hop < MAX_REDIRECTS) url = checkedUrl(response.location, options, url)
  }
  throw new AppError(502, 'PUBLIC_REDIRECT_LIMIT', `${options.label ?? '公网目标'} 重定向超过 ${MAX_REDIRECTS} 次`)
}
