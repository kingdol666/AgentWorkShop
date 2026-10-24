/**
 * 工具描述预算折叠(WP6)—— 零依赖叶子模块,便于单测。
 *
 * 折叠必须确定性:调用方先按 id 排序,本模块按顺序稳定截断,同一绑定面两次编译
 * 输出逐字节相同(否则 tools/list_changed 会因截断边界抖动持续刷屏)。
 * env AW_DESC_BUDGET=0 关闭折叠(回退全量拼接)。
 */
export const RESOURCES_GUIDE = ';完整清单用 industrial_resources 分页查询'

export function descBudget(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AW_DESC_BUDGET ?? 400)
  return Number.isFinite(n) && n >= 0 ? n : 400
}

export function sortedById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function foldList(prefix: string, items: string[], guide = RESOURCES_GUIDE, budget = descBudget()): string {
  const full = `${prefix}${items.join('、')}`
  if (budget === 0 || full.length <= budget) return full
  const head: string[] = []
  let used = prefix.length + guide.length + 16
  for (const it of items) {
    // 首项必须保留:配方条目携带完整参数面,单条即可超预算——空折叠(「等 N 项」
    // 前无任何条目)会把绑定面整体隐藏,模型连绑了哪个配方/节点都看不到,
    // per-agent 描述增强("不必先探测绑定面")失效。预算只对第 2 项起收紧。
    if (head.length > 0 && used + it.length + 1 > budget) break
    head.push(it)
    used += it.length + 1
  }
  const more = head.length < items.length ? ` 等 ${items.length} 项` : ''
  return `${prefix}${head.join('、')}${more}${guide}`
}
