/**
 * 判据 DSL 的数值扩展（WP-C4）—— `metric.*` 判据。
 *
 * 语法（大小写不敏感；key 与 metrics 表的键一致）：
 *   metric.within:<key>=<target>±<tol>   |actual - target| <= tol
 *   metric.lt:<key>=<value>              actual < value
 *   metric.gt:<key>=<value>              actual > value
 *
 * **fail-closed**：metrics 缺失该 key / 非有限数 / 语法不合法 → 判失败（阻断），
 * 绝不以"没有证据"当作"通过"。指标来源必须是独立观测（回读/DAQ），
 * 不接受 Agent 自述——由调用方保证传入的 metrics 不来自 payload 自报。
 */

export interface MetricCriterionResult {
  /** 是否识别为 metric 判据（false = 交给后续判据类型） */
  matched: boolean
  pass: boolean
  detail: string
}

const WITHIN = /^metric\.within[:：]\s*([\w.$-]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*±\s*(-?\d+(?:\.\d+)?)$/i
const LT = /^metric\.lt[:：]\s*([\w.$-]+)\s*=\s*(-?\d+(?:\.\d+)?)$/i
const GT = /^metric\.gt[:：]\s*([\w.$-]+)\s*=\s*(-?\d+(?:\.\d+)?)$/i

/** 解析并判定一条 metric 判据；非 metric 语法返回 matched=false */
export function evaluateMetricCriterion(criterion: string, metrics: Record<string, number> | undefined): MetricCriterionResult {
  const c = criterion.trim()
  const within = c.match(WITHIN)
  if (within) {
    const [, key, targetRaw, tolRaw] = within
    const target = Number(targetRaw)
    const tol = Math.abs(Number(tolRaw))
    return judge(key!, metrics, actual => Math.abs(actual - target) <= tol, `|${key} - ${target}| <= ${tol}`)
  }
  const lt = c.match(LT)
  if (lt) {
    const [, key, v] = lt
    return judge(key!, metrics, actual => actual < Number(v), `${key} < ${v}`)
  }
  const gt = c.match(GT)
  if (gt) {
    const [, key, v] = gt
    return judge(key!, metrics, actual => actual > Number(v), `${key} > ${v}`)
  }
  return { matched: false, pass: false, detail: '' }
}

function judge(key: string, metrics: Record<string, number> | undefined, fn: (actual: number) => boolean, expectation: string): MetricCriterionResult {
  const raw = metrics?.[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { matched: true, pass: false, detail: `缺独立指标 ${key}（fail-closed；不接受自述值）` }
  }
  return { matched: true, pass: fn(raw), detail: `实际 ${key}=${raw}；期望 ${expectation}` }
}
