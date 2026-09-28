/**
 * HTTP 防护门(公网部署基线)——单中间件四件事,内存滑窗,无外部依赖:
 * 1. User-Agent 黑名单:默认拦常见扫描器(sqlmap/nikto/nuclei…),AW_UA_BLOCKLIST 可追加(正则段,| 分隔)
 * 2. 请求体上限:Content-Length 超限 413(AW_BODY_LIMIT_MB,默认 64MB)
 * 3. 频率限流:/api 认证面(login/register/mcp/a2a)严限,A其余 API 宽限(AW_RATE_LIMIT_API_PER_MIN,默认 600)
 * 4. 404 扫描封锁:1 分钟内 /api/* 404 超过阈值(AW_SCAN_404_LIMIT,默认 60)→ 封 IP 10 分钟(反爬/反目录爆破)
 * 旁路:AW_RATE_LIMIT_OFF=1 或 AW_BENCH_MODE=1(基准隔离实例)整体停用;
 *      全部状态内存态(重启即清),多实例部署时反代层应另配限流。
 */
import { defineEventHandler, createError, getRequestIP, getRequestHeaders, getRequestURL } from 'h3'

const g = globalThis as typeof globalThis & {
  __awRateBuckets?: Map<string, { count: number, reset: number }>
  __awScanHits?: Map<string, { count: number, reset: number }>
  __awScanBlocked?: Map<string, number>
}

const envNum = (v: string | undefined, dflt: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

const OFF = process.env.AW_RATE_LIMIT_OFF === '1' || process.env.AW_BENCH_MODE === '1'
const AUTH_LIMIT = envNum(process.env.AW_RATE_LIMIT_AUTH_PER_MIN, 20)
const API_LIMIT = envNum(process.env.AW_RATE_LIMIT_API_PER_MIN, 600)
const SCAN_LIMIT = envNum(process.env.AW_SCAN_404_LIMIT, 60)
const BODY_LIMIT_MB = envNum(process.env.AW_BODY_LIMIT_MB, 64)
const BLOCK_MS = 10 * 60_000
const WINDOW_MS = 60_000
// 默认 UA 黑名单:公认攻击工具,不含任何浏览器/爬虫正常名(正常搜索引擎爬虫由 robots.txt 约束)
const UA_RE = new RegExp(process.env.AW_UA_BLOCKLIST
  || 'sqlmap|nikto|nuclei|masscan|zgrab|dirbuster|gobuster|wfuzz|ffuf|hydra|acunetix|nessus|arachni', 'i')

/** 认证/敏感面(严限):登录、注册、MCP、A2A */
function isAuthFace(pathname: string): boolean {
  return pathname.startsWith('/api/users/login')
    || pathname.startsWith('/api/users/register')
    || pathname.startsWith('/api/workshop/users/register')
    || pathname.startsWith('/api/mcp/')
    || pathname.includes('/a2a/')
}

function bucketOf(map: Map<string, { count: number, reset: number }>, key: string, limit: number, now: number): number {
  const b = map.get(key)
  if (!b || b.reset <= now) {
    map.set(key, { count: 1, reset: now + WINDOW_MS })
    return limit - 1
  }
  b.count += 1
  // 可为负:第 N+1 发起 remaining < 0,由调用方判 429(勿钳 0,否则永不触发)
  return limit - b.count
}

export default defineEventHandler((event) => {
  if (OFF) return
  const url = getRequestURL(event)
  const path = url.pathname
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'local'
  const now = Date.now()

  // 已封锁 IP(404 扫描触发):直接 403,不看别的
  const blockedUntil = g.__awScanBlocked?.get(ip)
  if (blockedUntil && blockedUntil > now) {
    throw createError({ statusCode: 403, statusMessage: `IP temporarily blocked (scanning): retry after ${Math.ceil((blockedUntil - now) / 1000)}s` })
  }
  if (blockedUntil && g.__awScanBlocked) g.__awScanBlocked.delete(ip)

  // UA 黑名单(全路径,扫描器对静态面也探)
  const ua = getRequestHeaders(event)['user-agent'] ?? ''
  if (ua && UA_RE.test(ua)) {
    throw createError({ statusCode: 403, statusMessage: 'User agent not allowed' })
  }

  // 请求体上限(带 Content-Length 才拦;chunked 走 nitro 默认)
  const len = Number(getRequestHeaders(event)['content-length'] ?? 0)
  if (len > BODY_LIMIT_MB * 1024 * 1024) {
    throw createError({ statusCode: 413, statusMessage: `Request body too large (limit ${BODY_LIMIT_MB}MB)` })
  }

  // 只对 /api/* 限流(静态/页面不做)
  if (path.startsWith('/api/')) {
    if (!g.__awRateBuckets) g.__awRateBuckets = new Map()
    const limit = isAuthFace(path) ? AUTH_LIMIT : API_LIMIT
    const remaining = bucketOf(g.__awRateBuckets, `${ip}|${limit}`, limit, now)
    if (remaining < 0) {
      throw createError({ statusCode: 429, statusMessage: 'Too many requests: slow down' })
    }
    // 404 扫描计数(res finish 时回填;blocked 判定在下轮请求入口生效)
    if (!g.__awScanHits) g.__awScanHits = new Map()
    const res = event.node?.res
    if (!res) return
    res.once('finish', () => {
      if (res.statusCode !== 404) return
      const hits = bucketOf(g.__awScanHits!, `${ip}`, SCAN_LIMIT, Date.now())
      if (hits <= 0) {
        if (!g.__awScanBlocked) g.__awScanBlocked = new Map()
        g.__awScanBlocked.set(ip, Date.now() + BLOCK_MS)
      }
    })
  }
})
