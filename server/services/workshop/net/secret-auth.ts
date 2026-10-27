/**
 * 凭据引用解析与请求头插值(DAQ/DCW http 驱动、mes-rest 共用口径)。
 *
 * 解析顺序:env(运维应急覆盖)> 运行时凭据仓 > 遗留 runtime settings。
 * 零明文:配置只存引用名;`{{SECRET:REF}}` 未解析时该头整条省略(绝不把占位符发出去)。
 */
import { AppError } from '@/server/utils/errors'

/** secretRef → env 键(通用前缀;MES 兼容前缀 AW_MES_<REF>_TOKEN 仍由 mes-rest 保留) */
export function secretEnvKey(ref: string): string {
  return `AW_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/** 解析一个凭据引用;不存在 → null */
export async function resolveSecretRef(ref: unknown): Promise<string | null> {
  const name = String(ref ?? '').trim()
  if (!name) return null
  const fromEnv = process.env[secretEnvKey(name)]
  if (fromEnv) return fromEnv
  try {
    const { getMesSecretsRepo } = await import('../mes/mes-secrets.repo')
    const v = getMesSecretsRepo().getSecret(name)
    if (v) return v
  }
  catch { /* 数据目录不可用 → 继续回落 */ }
  try {
    const { settingOf } = await import('../settings')
    const v = settingOf(`secret.${name}`)
    if (typeof v === 'string' && v !== '') return v
  }
  catch { /* 设置服务不可用 → 无凭据 */ }
  return null
}

const PLACEHOLDER = /\{\{SECRET:([^}]+)\}\}/g

/**
 * 头值插值:返回 null = 含未解析占位符(调用方整头省略,避免明文外泄/半截凭据)。
 * 无占位符时原样返回(零开销快路径)。
 */
export async function interpolateSecretHeader(value: string): Promise<string | null> {
  if (!value.includes('{{SECRET:')) return value
  let out = ''
  let last = 0
  for (const m of value.matchAll(PLACEHOLDER)) {
    const token = await resolveSecretRef(m[1])
    if (!token) return null
    out += value.slice(last, m.index)
    out += token
    last = m.index + m[0].length
  }
  out += value.slice(last)
  return out
}

/** body 模板插值:含未解析占位符 → 400(不发送半截请求体) */
export async function interpolateSecretBody(value: string): Promise<string> {
  if (!value.includes('{{SECRET:')) return value
  const out = await interpolateSecretHeader(value)
  if (out === null) throw new AppError(400, 'BAD_REQUEST', '请求体模板含未解析的 {{SECRET:REF}} 占位符(请先配置凭据引用)')
  return out
}

/**
 * 认证头装配(authType: bearer|header|none;缺省:配置了 secretRef 则 bearer,否则 none)。
 * 无凭据 → 不注入(与 mes-rest 的裸请求语义一致)。
 */
export async function authHeadersOf(cfg: Record<string, unknown>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const authType = String(cfg.authType ?? (cfg.secretRef ? 'bearer' : 'none'))
  if (authType === 'none') return out
  const token = await resolveSecretRef(cfg.secretRef)
  if (!token) return out
  if (authType === 'header') out[String(cfg.authHeaderName ?? '') || 'X-Api-Token'] = token
  else out.authorization = `Bearer ${token}`
  return out
}

/** 超时钳位:1s–60s,缺省 5000ms(非法值回落缺省) */
export function clampTimeoutMs(value: unknown, fallback = 5000): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(60_000, Math.max(1_000, Math.round(n)))
}
