/**
 * 设置面的凭据掩码(2026-10-30 安全审计 P1-3)。
 *
 * 缺陷原状:GET /api/system/settings 对 admin/editor 原样返回 effective,
 * 其中 daq.mqtt.password / daq.objectstore.secretKey / memory.embed_api_key 等为明文;
 * editor 因此可读全部运行时密钥。
 *
 * 语义(与 driverConfig 掩码同口径,见 shared/daq-protocol.ts maskDriverConfigSecrets):
 *  - 出口一律掩码(admin 也只看 ***);真实值仍在服务端内部使用;
 *  - 入口 stripMasked:前端把掩码值原样回传时**不覆盖**真实值(否则一保存就毁密钥)。
 */

/** 出口掩码值(前端原样回传时由 stripMasked 识别) */
export const SECRET_MASK = '***'

/**
 * 键名判定:最后一段以凭据语义结尾。
 * 用后缀匹配而非整段相等 —— `memory.embed_api_key` 的段名是 `embed_api_key`,
 * 整段白名单会漏掉这类"前缀 + 凭据词"的键。
 */
const SECRET_SEGMENT = /(password|passwd|secret|token|(api|access|private|secret)_?key)$/i

export function isSecretSettingKey(key: string): boolean {
  const last = key.split('.').pop() ?? key
  // 驼峰归一:secretKey → secretkey
  return SECRET_SEGMENT.test(last.replace(/[A-Z]/g, c => c.toLowerCase()))
}

/** 对键值表做出口掩码(仅当值是非空字符串;其余原样) */
export function maskSecretSettings(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    out[k] = isSecretSettingKey(k) && typeof v === 'string' && v !== '' ? SECRET_MASK : v
  }
  return out
}

/** 入口:剔除回传的掩码值(保留键本身不动,避免误删真实覆盖) */
export function stripMaskedSettings(patch: Record<string, unknown>): { clean: Record<string, unknown>, skipped: string[] } {
  const clean: Record<string, unknown> = {}
  const skipped: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === SECRET_MASK) {
      skipped.push(k)
      continue
    }
    clean[k] = v
  }
  return { clean, skipped }
}
