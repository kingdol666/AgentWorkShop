/**
 * 有界 LRU —— 统一替换代码库里「无界 Map」与「超限整体 clear()」两种劣化写法。
 *
 * 现状问题(审计实测):
 *   · `daq-controller.ts` siblingsCache / opsWriteMemo:超限直接 clear() → 瞬时全量缓存穿透,
 *     紧接着的请求全部回源,形成周期性抖动;
 *   · `dcw-controller.ts` opsWriteMemo / `manager.ts` reflectCounts / ownerNameCache:
 *     完全无淘汰,长跑单调增长(ownerNameCache 有 TTL 判定但过期项只被覆盖、从不删除);
 *   · `monitor.ts`、`scene-events` 等处的按 key 节流表同型。
 *
 * 语义:get 命中即提升为最近使用;set 超限逐出最久未用;delete/clear 与 Map 同名。
 * 保持 Map 的迭代顺序语义(插入序 → 访问序),因此 `for (const k of lru.keys())` 仍然可用。
 */
export class LruMap {
  /**
   * @param {number} max 容量上限(≥1)
   * @param {(key:any, value:any) => void} [onEvict] 逐出回调(可选,用于联动清理外部资源)
   */
  constructor(max, onEvict) {
    if (!Number.isFinite(max) || max < 1) throw new Error('LruMap: max 必须是 ≥1 的数字')
    this.max = Math.floor(max)
    this.onEvict = typeof onEvict === 'function' ? onEvict : null
    /** @type {Map<any, any>} 迭代顺序 = 由旧到新 */
    this.map = new Map()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  get size() { return this.map.size }

  has(key) { return this.map.has(key) }

  get(key) {
    if (!this.map.has(key)) {
      this.misses += 1
      return undefined
    }
    // 访问即提升:删了重插(值不变),维持「尾部最新」
    const v = this.map.get(key)
    this.map.delete(key)
    this.map.set(key, v)
    this.hits += 1
    return v
  }

  /** 命中返回值,未命中用 fallback 计算并写入(单一入口,避免各处手写 get/set 样板) */
  getOrSet(key, fallback) {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const v = typeof fallback === 'function' ? fallback(key) : fallback
    this.set(key, v)
    return v
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    // while 而非 if:max 被下调或批量写入时可一次收敛
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      const val = this.map.get(oldest)
      this.map.delete(oldest)
      this.evictions += 1
      this.onEvict?.(oldest, val)
    }
    return this
  }

  delete(key) { return this.map.delete(key) }

  clear() { this.map.clear() }

  keys() { return this.map.keys() }

  values() { return this.map.values() }

  entries() { return this.map.entries() }

  [Symbol.iterator]() { return this.map[Symbol.iterator]() }

  stats() {
    const total = this.hits + this.misses
    return {
      size: this.map.size,
      max: this.max,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(4)),
    }
  }
}

export function createLru(max, onEvict) {
  return new LruMap(max, onEvict)
}
