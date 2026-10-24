/**
 * 单位 → 量纲归一(共享叶子模块)。
 *
 * 本体(Ontology)与 PhysicsSpec 共用同一张量纲表:先把单位别名归一为规范键,
 * 再比对量纲是否相容。**本模块不做任何数值换算** —— 工程↔模型单位换算的
 * 唯一边界是 shared/units.ts(D23),禁止在此按 1/0 兜底。
 *
 * 归一覆盖的真实缺口(2026-10-24):`℃`(U+2103)与 `°C` 此前都落不进
 * UNIT_DIMENSIONS(旧实现只做 `'°'→'deg'`),而平台模板单位正是 `℃`
 * (shared/daq-protocol.ts 温度变送器)。这里统一收敛。
 */
import type { UnitTransform } from './units'

/** 无量纲单位(可直接与 scalar 相容) */
export const DIMENSIONLESS_UNITS: ReadonlySet<string> = new Set(['', '1', 'ratio', 'fraction', 'percent', '%'])

/** 单位别名 → 量纲。键为 normalizeUnit() 后的规范键。 */
export const UNIT_DIMENSIONS: Readonly<Record<string, string>> = {
  s: 'time',
  sec: 'time',
  ms: 'time',
  min: 'time',
  h: 'time',
  degc: 'temperature',
  c: 'temperature',
  k: 'temperature',
  degf: 'temperature',
  f: 'temperature',
  pa: 'pressure',
  kpa: 'pressure',
  mpa: 'pressure',
  bar: 'pressure',
  psi: 'pressure',
  g: 'mass',
  kg: 'mass',
  mg: 'mass',
  m: 'length',
  cm: 'length',
  mm: 'length',
  um: 'length',
  km: 'length',
  a: 'current',
  v: 'voltage',
  w: 'power',
  j: 'energy',
  n: 'force',
}

/**
 * 归一味素单位。`℃`(U+2103)/`℃`变体与 `°C` 都收敛到 `degc`;`℉` → `degf`。
 * 只保留小写与去空白,不做乘法/指数展开(复合单位以原串作 compound 量纲)。
 */
export function normalizeUnit(unit: string | undefined | null): string {
  return (unit ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('\u2103', 'degc')
    .replaceAll('\u2109', 'degf')
    .replaceAll('\u03bc', 'u')
    .replaceAll('\u00b5', 'u')
    .replace('°', 'deg')
    .replace(/\s+/g, '')
}

/**
 * 量纲判定:
 * - 无量纲 → 'dimensionless'
 * - 已知单位别名 → 规范量纲名(如 'temperature')
 * - 含 `/` `*` `^` → 'compound:<归一串>'(仅与完全相同者相容)
 * - 其他 → 'unit:<归一串>'(未知单位自成一体,不与任何其他未知单位误配)
 */
export function dimensionOf(unit: string | undefined | null): string {
  const key = normalizeUnit(unit)
  if (DIMENSIONLESS_UNITS.has(key)) return 'dimensionless'
  const known = UNIT_DIMENSIONS[key]
  if (known) return known
  // 后缀归一:um/mm/cm/km 之外的复合与指数形态原样保留
  if (key.includes('/') || key.includes('*') || key.includes('^')) return `compound:${key}`
  return key ? `unit:${key}` : 'scalar'
}

/** 两个量纲是否相容('*' 为显式通配;dimensionless 与 scalar 互认) */
export function dimensionsCompatible(a: string, b: string): boolean {
  if (a === '*' || b === '*') return true
  if (a === b) return true
  return (a === 'dimensionless' && b === 'scalar') || (b === 'dimensionless' && a === 'scalar')
}

/** 两单位是否同为可判定量纲且相容(未知单位只与自身同串相容) */
export function unitsCompatible(a: string | undefined | null, b: string | undefined | null): boolean {
  return dimensionsCompatible(dimensionOf(a), dimensionOf(b))
}

/**
 * 判断两单位之间是否需要显式换算:
 * - 归一后字面相同 → 无需换算
 * - 同量纲但字面不同(如 degc/k)→ 需要显式 scale/offset(调用方必须给出)
 * - 不同量纲 → 不可换算
 */
export function unitRelation(a: string | undefined | null, b: string | undefined | null):
  | { kind: 'same' }
  | { kind: 'convertible' }
  | { kind: 'incompatible', from: string, to: string } {
  const ka = normalizeUnit(a)
  const kb = normalizeUnit(b)
  if (ka === kb) return { kind: 'same' }
  if (dimensionsCompatible(dimensionOf(a), dimensionOf(b))) return { kind: 'convertible' }
  return { kind: 'incompatible', from: dimensionOf(a), to: dimensionOf(b) }
}

/**
 * 校验一个换算契约与单位声明的自洽性(只校验形状与方向,不求值换算)。
 * 语义:`scale` 非零有限、`offset` 有限;同量纲可换算单位必须显式给契约。
 */
export function assertUnitTransformShape(t: UnitTransform | undefined, what = '绑定'): { scale: number, offset: number } {
  const scale = Number(t?.scale)
  const offset = Number(t?.offset)
  if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) {
    const err = new Error(`${what} 的单位换算契约非法(scale=${String(t?.scale)},offset=${String(t?.offset)}):scale 必须为非零有限数,offset 必须为有限数;禁止兜底`)
    Object.assign(err, { status: 422, code: 'UNIT_CONTRACT_INVALID' })
    throw err
  }
  return { scale, offset }
}
