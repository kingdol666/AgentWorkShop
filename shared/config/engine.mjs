// ============================================================
// AgentWorkShop 运行时配置引擎（零框架依赖，CLI / 启动脚本 / Nuxt 配置 / 服务端通用）
// ------------------------------------------------------------
// 优先级（低 → 高）：config.yml 默认值 < data/runtime-settings.json 运行时覆盖 < 环境变量
// 每个可编辑设置项由 shared/config/schema.json 的描述符声明（类型/枚举/范围/生效方式）。
// 本文件为 .mjs 以便在任意 Node ESM 环境直接运行，不依赖 tsx/构建。
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

export const SETTINGS_FILENAME = 'runtime-settings.json'

/** 解析 dotted key（'server.dev.port' → ['server','dev','port']） */
export function keyPath(key) {
  return String(key).split('.').filter(Boolean)
}

/** 读取对象深层路径（不存在返回 undefined） */
export function getPath(obj, key) {
  let cur = obj
  for (const seg of keyPath(key)) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** 设置对象深层路径（返回是否写入） */
export function setPath(obj, key, value) {
  const segs = keyPath(key)
  if (!segs.length) return false
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]
    if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {}
    cur = cur[s]
  }
  cur[segs.at(-1)] = value
  return true
}

/** 删除对象深层路径 */
export function unsetPath(obj, key) {
  const segs = keyPath(key)
  if (!segs.length) return false
  const parent = segs.slice(0, -1).reduce((a, s) => (a && typeof a[s] === 'object' ? a[s] : undefined), obj)
  if (!parent) return false
  return delete parent[segs.at(-1)]
}

/** 读取描述符清单（shared/config/schema.json）
 * 多路径兜底：CLI/脚本按真实文件位置；Nitro dev 外部化同样命中真实路径；
 * 生产 bundle 后 import.meta.url 指向产物，改用 cwd 相对路径（repo/home 模式下
 * schema.json 都在运行根附近）。 */
export function loadDescriptors() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'schema.json'),
    resolve(process.cwd(), 'shared', 'config', 'schema.json'),
    resolve(process.cwd(), 'config', 'schema.json'),
  ]
  // 启动器注入的载荷根(start.mjs / dev-guard 恒设置;全局安装 = 包根,shared/ 随包发布)
  if (process.env.AW_PACKAGE_ROOT) {
    candidates.push(join(process.env.AW_PACKAGE_ROOT, 'shared', 'config', 'schema.json'))
  }
  // 用户级兜底(home 中枢,AW_HOME 可重定向)
  if (process.env.AW_HOME) {
    candidates.push(join(process.env.AW_HOME, 'shared', 'config', 'schema.json'))
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, 'utf8')).settings
      }
    }
    catch { /* 继续尝试下一个候选 */ }
  }
  throw new Error(`[config] 找不到 schema.json（尝试: ${candidates.join(' | ')}）`)
}

/** 读取描述符映射（key → descriptor） */
export function loadDescriptorMap(descriptors = loadDescriptors()) {
  return Object.fromEntries(descriptors.map(d => [d.key, d]))
}

/**
 * 按描述符把字符串值强转为目标类型（CLI / 环境变量传入时使用）。
 * 无效返回 null（调用方应报错）。
 */
export function coerceValue(desc, value) {
  if (value == null || value === '') return null
  switch (desc.type) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (/^(1|true|yes|on)$/i.test(String(value))) return true
      if (/^(0|false|no|off)$/i.test(String(value))) return false
      return null
    }
    default:
      return String(value)
  }
}

/** 按描述符校验值；返回错误消息数组（空 = 通过） */
export function validateValue(desc, value) {
  const errors = []
  if (value == null) return []
  switch (desc.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${desc.key} 应为字符串`]
      if (typeof desc.minLength === 'number' && value.length < desc.minLength) errors.push(`长度不足 ${desc.minLength}`)
      if (typeof desc.maxLength === 'number' && value.length > desc.maxLength) errors.push(`长度超过 ${desc.maxLength}`)
      break
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${desc.key} 应为数字`]
      if (typeof desc.min === 'number' && value < desc.min) errors.push(`不能小于 ${desc.min}`)
      if (typeof desc.max === 'number' && value > desc.max) errors.push(`不能大于 ${desc.max}`)
      break
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return [`${desc.key} 应为布尔值`]
      break
    }
    case 'color': {
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value))) errors.push('须为十六进制颜色，如 #35e0a0')
      break
    }
    case 'select': {
      if (!desc.options?.includes(value)) errors.push(`须为 ${desc.options?.join(' / ')} 之一`)
      break
    }
    default:
      break
  }
  return errors
}

/** 校验一组覆盖（{key: value}）；返回 { ok, errors: {key: msg[]} } */
export function validateOverrides(overrides, descriptors = loadDescriptors()) {
  const map = loadDescriptorMap(descriptors)
  const errors = {}
  let ok = true
  for (const [key, value] of Object.entries(overrides)) {
    const desc = map[key]
    if (!desc) {
      errors[key] = ['未知设置项（不在 schema.json 中）']
      ok = false
      continue
    }
    const errs = validateValue(desc, value)
    if (errs.length) {
      errors[key] = errs
      ok = false
    }
  }
  return { ok, errors }
}

/** 向上查找文件（如 config.yml），返回绝对路径或 null */
export function findUp(startDir, filename) {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 读取 settings 覆盖文件（不存在返回空对象） */
export function readSettings(settingsPath) {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {}
  }
  catch {
    return {}
  }
}

/**
 * 原子写入 settings 覆盖文件（tmp + rename）。
 * 结构：{ version, updatedAt, overrides: { 'key': value } }
 */
export function saveSettings(overrides, settingsPath, { version = 1 } = {}) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  const payload = {
    version,
    updatedAt: new Date().toISOString(),
    overrides,
  }
  const tmp = `${settingsPath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, settingsPath)
  return payload
}

/**
 * 环境变量 → 设置 key 的映射（AW_ 前缀 + 点转下划线，如 AW_SERVER_DEV_PORT）。
 * 另支持常见惯例：PORT/NITRO_PORT/HOST/NITRO_HOST（launcher 模式下映射到对应 mode 端口）。
 */
export function envOverridesFromEnv(env = process.env, descriptors = loadDescriptors(), mode) {
  const out = {}
  for (const desc of descriptors) {
    const varName = `AW_${desc.key.toUpperCase().replace(/\./g, '_')}`
    // aliases:历史环境变量名兼容(迁移前已在用的非 AW_ 前缀/异序名,如 DAQ_FRAME_RETENTION_H;
    // 优先级 AW_<KEY> > aliases 中声明顺序)
    const legacy = (desc.aliases ?? []).map(a => env[a]).find(v => v !== undefined)
    const rawEnv = env[varName] !== undefined ? env[varName] : legacy
    if (rawEnv !== undefined) {
      const coerced = coerceValue(desc, rawEnv)
      if (coerced !== null) out[desc.key] = coerced
    }
  }
  // 端口/主机惯例变量（launcher 才有 mode 意识）
  if (mode) {
    const portKey = mode === 'dev' ? 'server.dev.port' : 'server.prod.port'
    const p = env.PORT ?? env.NITRO_PORT ?? env.NUXT_PORT
    if (p !== undefined) {
      const n = Number(p)
      if (Number.isFinite(n)) out[portKey] = n
    }
    const h = env.HOST ?? env.NITRO_HOST
    if (h !== undefined) out['server.host'] = h
  }
  return out
}

/**
 * 加载有效配置。返回：
 * {
 *   defaults,              // config.yml 原始对象
 *   overrides,             // 运行时覆盖（flat dotted map）
 *   envOverrides,          // 环境变量覆盖（flat dotted map）
 *   effective,             // 逐设置项合并后的有效值（flat dotted map）
 *   sources,               // key → 'config.yml' | 'runtime' | 'env'
 *   descriptors,
 *   configPath, settingsPath
 * }
 */
export function loadEffective({ configPath, settingsPath, env = process.env, mode } = {}) {
  const descriptors = loadDescriptors()
  const defaults = configPath && existsSync(configPath)
    ? (YAML.load(readFileSync(configPath, 'utf8')) ?? {})
    : {}
  const overrides = settingsPath ? readSettings(settingsPath) : {}
  const envOverrides = envOverridesFromEnv(env, descriptors, mode)

  const effective = {}
  const sources = {}
  for (const desc of descriptors) {
    let value
    let source
    if (envOverrides[desc.key] !== undefined) {
      value = envOverrides[desc.key]
      source = 'env'
    }
    else if (overrides[desc.key] !== undefined) {
      value = overrides[desc.key]
      source = 'runtime'
    }
    else {
      const fromYaml = getPath(defaults, desc.key)
      value = fromYaml !== undefined ? fromYaml : desc.default
      source = 'config.yml'
    }
    effective[desc.key] = value
    sources[desc.key] = source
  }
  return { defaults, overrides, envOverrides, effective, sources, descriptors, configPath, settingsPath }
}

/** 便捷：默认 settings 文件路径（<root>/data/runtime-settings.json） */
export function settingsPathFor(root) {
  return join(root, 'data', SETTINGS_FILENAME)
}

export default {
  SETTINGS_FILENAME,
  keyPath,
  getPath,
  setPath,
  unsetPath,
  loadDescriptors,
  loadDescriptorMap,
  coerceValue,
  validateValue,
  validateOverrides,
  findUp,
  readSettings,
  saveSettings,
  envOverridesFromEnv,
  loadEffective,
  settingsPathFor,
}
