/**
 * 出站 HTTP 安全护栏(统一口径)。
 *
 * 背景:mes-rest 已有「协议白名单 + DNS 解析后私网/环回段拒绝 + allowPrivateHost 显式白名单」,
 * 但 DAQ/DCW 的 http 驱动仍是无护栏 fetch —— 同为 admin 配置面,却存在认知差与 SSRF 面。
 * 本模块把 mes-rest 的判定原样抽出,三处共用同一实现(消息里的主体名可配置)。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '@/server/utils/errors'

export interface SafeUrlOptions {
  /** 'true' 才放行内网/环回(内网数据源显式白名单) */
  allowPrivateHost?: unknown
  /** 旧配置缺省(字段不存在)时是否沿用历史行为(允许私网);MES 保持默认拒绝 */
  legacyAllowPrivateWhenUnset?: boolean
  /** 错误文案里的主体名(如 MES / 数据源) */
  label?: string
}

/** 私有/环回段:IPv4 127/8 · 10/8 · 172.16/12 · 192.168/16 · 169.254/16;IPv6 ::1 · :: · fc00::/7 · fe80::/10 */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip // IPv4-mapped IPv6 按 IPv4 判
  if (isIP(v4) === 4) {
    const seg = v4.split('.').map(Number)
    const a = seg[0]!
    const b = seg[1]!
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  const h16 = Number.parseInt(v4.split(':')[0] ?? '', 16)
  if (!Number.isFinite(h16)) return true // 解析不了按保守拒绝
  return h16 === 0x0001 || h16 === 0 || (h16 & 0xfe00) === 0xfc00 || (h16 & 0xffc0) === 0xfe80
}

/** 主机名 → IP 列表(字面 IP 直判不经 DNS;域名全量解析,任一内网地址即整批拒绝) */
export async function resolveTargetIps(hostname: string, label = 'MES'): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  try {
    const recs = await lookup(hostname, { all: true, verbatim: true })
    return recs.map(r => r.address)
  }
  catch (err) {
    throw new AppError(400, 'BAD_REQUEST', `${label} 主机 DNS 解析失败:${hostname}(${err instanceof Error ? err.message : String(err)})`)
  }
}

/**
 * 出站目标允许内网的统一开关(默认拒绝)。
 * 报警 webhook / embedding 服务 / 插件 ctx.http 都可能部署在内网,因此提供显式
 * 开关而不是永远拒绝;但必须由运维明确打开,不能默认放行(否则等于没护栏)。
 */
export function allowPrivateOutbound(): boolean {
  return process.env.AW_ALLOW_PRIVATE_OUTBOUND === '1'
}

/**
 * 校验出站 URL:仅 http/https;未显式开白名单时解析目标并拒绝私网/环回地址。
 * 返回解析后的 URL(调用方用 .origin/.toString())。
 */
export async function assertSafeHttpUrl(rawUrl: string, opts: SafeUrlOptions = {}): Promise<URL> {
  let u: URL
  try {
    u = new URL(rawUrl)
  }
  catch {
    throw new AppError(400, 'BAD_REQUEST', `${opts.label ?? '目标'} 不是合法 URL:${rawUrl}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(400, 'BAD_REQUEST', `${opts.label ?? '目标'} 仅支持 http/https 协议(当前 ${u.protocol})`)
  }
  const raw = opts.allowPrivateHost
  const explicit = raw !== undefined && raw !== null && String(raw).trim() !== ''
  // 显式配置优先;未配置时 MES 默认拒绝,DAQ/DCW http 沿用旧行为(见 legacyAllowPrivateWhenUnset)
  const shouldCheck = explicit ? String(raw) !== 'true' : !opts.legacyAllowPrivateWhenUnset
  if (shouldCheck) {
    const ips = await resolveTargetIps(u.hostname, opts.label)
    const privateHits = [...new Set(ips.filter(a => isPrivateIp(a)))]
    if (privateHits.length > 0) {
      throw new AppError(400, 'BAD_REQUEST', `目标 ${u.hostname} 解析到内网/环回地址(${privateHits.join(', ')}),已按 SSRF 防护拒绝;若数据源确在内网,请把驱动配置 allowPrivateHost 显式设为 'true' 开启白名单`)
    }
  }
  return u
}
