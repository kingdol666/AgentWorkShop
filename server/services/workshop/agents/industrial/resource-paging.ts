/**
 * 绑定面资源分页(纯函数,零依赖)—— industrial_resources 的实现核心,便于单测。
 * 语义:筛选(query: id/name/detail 模糊)→ 确定性排序(kind → id)→ 分页。
 */
export interface ResourcePageItem {
  kind: string
  id: string
  name: string
  detail?: string
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(Math.max(Math.trunc(n), min), max)
}

export function paginateResourceItems<T extends ResourcePageItem>(
  items: T[],
  opts: { query?: string, offset?: number, limit?: number },
): { page: T[], total: number, hasMore: boolean, offset: number, limit: number } {
  const offset = clampInt(opts.offset, 0, 0, 100_000)
  const limit = clampInt(opts.limit, 50, 1, 200)
  const q = String(opts.query ?? '').trim().toLowerCase()
  const filtered = q
    ? items.filter(it => it.id.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || (it.detail ?? '').toLowerCase().includes(q))
    : items
  filtered.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1))
  const page = filtered.slice(offset, offset + limit)
  return { page, total: filtered.length, hasMore: offset + page.length < filtered.length, offset, limit }
}
