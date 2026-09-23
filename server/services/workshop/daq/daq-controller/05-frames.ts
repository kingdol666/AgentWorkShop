/**
 * DaqControllerLayer05 —— 帧缓冲:检索、淘汰、内容与点列
 * (分层 6/9,承 DaqControllerLayer04;方法体与原文件逐行一致)
 */
import { DaqControllerLayer04 } from './04-views'
import type { DaqFrameRecord, DaqFrameRow } from '../storage/tsdb-port'
import { getObjectStore } from '../objectstore'
import { getTsdb, tsdbReady } from '../storage'

export abstract class DaqControllerLayer05 extends DaqControllerLayer04 {
  /**
   * 帧查询的「内存读穿透」索引 —— 帧先入 frameBuffer 再广播 thumbUrl(contentUrl),
   * TSDB 为 500ms 防抖异步刷盘,收到 WS 立刻回查会在落库前 404,故查询侧先看 buffer。
   *
   * 为什么要有索引:早先 frameContent 直接线性扫 frameBuffer,而 frames() 更糟 ——
   * 它对每个 pending 行都调一次 framesFromBuffer(),即**在 O(n) 的外层里再套 O(n) 的全扫**
   * (n = FRAME_BUFFER_CAP = 2000):突发写入后缓冲全满时,单次 REST 查询 ≈ 4×10⁶ 次迭代
   * + 2000 次多余对象构造,而它和 250ms 采样 sweep 跑在同一个事件循环上。
   *
   * 现在:byNode 按节点分桶(范围查询只扫该节点的行),byKey 给出 (nodeId, tsMs) 的 O(1) 命中。
   * 两个索引与 frameBuffer 严格同生命周期 —— 所有 push/淘汰/flush 都必须经下面的私有方法,
   * 不允许直接操作 frameBuffer,否则索引会与缓冲漂移(表现为"刚采到的帧查不到")。
   */
  protected readonly frameByNode = new Map<string, DaqFrameRow[]>()
  protected readonly frameByKey = new Map<string, DaqFrameRow>()

  /** 帧索引键((nodeId, tsMs) 唯一:同一节点同一毫秒只会有一帧) */
  protected static frameKey(nodeId: string, tsMs: number): string {
    return `${nodeId}@${tsMs}`
  }

  /** 入缓冲 + 同步三处索引 */
  protected pushFrame(row: DaqFrameRow): void {
    this.frameBuffer.push(row)
    const key = DaqControllerLayer05.frameKey(row.nodeId, row.tsMs)
    this.frameByKey.set(key, row)
    const bucket = this.frameByNode.get(row.nodeId)
    if (bucket) bucket.push(row)
    else this.frameByNode.set(row.nodeId, [row])
  }

  /** 淘汰最旧若干行,并同步清理索引(避免索引持有已淘汰行的强引用 → 内存泄漏) */
  protected evictFrames(keepLast: number): number {
    const excess = this.frameBuffer.length - keepLast
    if (excess <= 0) return 0
    const dropped = this.frameBuffer.splice(0, excess)
    for (const row of dropped) {
      const key = DaqControllerLayer05.frameKey(row.nodeId, row.tsMs)
      // 同键只可能有一行;但仍比对引用,防同毫秒重采覆盖后误删新行
      if (this.frameByKey.get(key) === row) this.frameByKey.delete(key)
      const bucket = this.frameByNode.get(row.nodeId)
      if (!bucket) continue
      const idx = bucket.indexOf(row)
      if (idx >= 0) bucket.splice(idx, 1)
      if (bucket.length === 0) this.frameByNode.delete(row.nodeId)
    }
    return dropped.length
  }

  /** 取走全部帧(刷盘用)并清空索引 */
  protected drainFrames(): DaqFrameRow[] {
    if (this.frameBuffer.length === 0) return []
    const batch = this.frameBuffer.splice(0, this.frameBuffer.length)
    this.frameByNode.clear()
    this.frameByKey.clear()
    return batch
  }

  /** 单行 → 对外记录(纯映射,不做任何扫描) */
  protected static toFrameRecord(r: DaqFrameRow): DaqFrameRecord {
    return {
      at: r.tsMs,
      kind: r.kind,
      points: r.kind === 'vector' ? DaqControllerLayer05.pointsFromMeta(r.meta) : undefined,
      metrics: r.metrics,
      meta: r.meta,
      deviceBindingId: r.deviceBindingId ?? null,
      lineId: r.lineId ?? null,
      productId: r.productId ?? null,
      recipeId: r.recipeId ?? null,
      runId: r.runId ?? null,
    }
  }

  /** (nodeId, tsMs) 精确命中未刷盘帧;O(1) */
  protected bufferedFrameAt(id: string, tsMs: number): DaqFrameRow | undefined {
    return this.frameByKey.get(DaqControllerLayer05.frameKey(id, tsMs))
  }

  /** 向量点列从 meta.points 还原(与 TSDB adapter 同规则:非数组/空/越界/非数值 → undefined) */
  protected static pointsFromMeta(meta: Record<string, unknown>): number[] | undefined {
    const p = meta.points
    if (!Array.isArray(p) || p.length === 0 || p.length > 4096) return undefined
    return p.every(x => Number.isFinite(Number(x))) ? p.map(Number) : undefined
  }

  /** 节点帧历史(v2:向量/图像元数据;像素按需经 frameContent 从对象存储取) */
  async frames(id: string, opts: { fromMs?: number, toMs?: number, kind?: 'vector' | 'image', limit?: number }) {
    this.ensureLoop()
    await tsdbReady
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    const rows = await getTsdb().queryFrames(id, opts)
    // 未刷盘的帧补进结果集:同 (nodeId, tsMs) 以落库行为准(去重),按 at 降序
    const seen = new Set(rows.map(r => r.at))
    const toMs = opts.toMs ?? Date.now()
    const fromMs = opts.fromMs ?? 0
    // 只扫本节点的桶(而非整条缓冲),再按范围/类型过滤;映射用纯函数,无二次扫描
    const pending = (this.frameByNode.get(id) ?? [])
      .filter(r => (opts.kind == null || r.kind === opts.kind)
        && r.tsMs >= fromMs && r.tsMs <= toMs
        && !seen.has(r.tsMs))
      .sort((a, b) => b.tsMs - a.tsMs)
      .map(DaqControllerLayer05.toFrameRecord)
    return [...rows, ...pending].slice(0, Math.min(Math.max(opts.limit ?? 100, 1), 1000))
  }

  /** 帧内容(图像主图/缩略图;从对象存储读取后由 REST 流式返回) */
  async frameContent(id: string, tsMs: number, thumb: boolean): Promise<{ data: Buffer, mime: string }> {
    this.ensureLoop()
    await tsdbReady
    const node = this.repo.byId(id)
    if (!node) throw Object.assign(new Error(`数采节点不存在: ${id}`), { status: 404 })
    // 读穿透:先查内存攒批缓冲(帧刚 ingest、尚未刷盘时命中),未命中再查 TSDB
    const buffered = this.bufferedFrameAt(id, tsMs)
    const rows = buffered
      ? [DaqControllerLayer05.toFrameRecord(buffered)]
      : await getTsdb().queryFrames(id, { fromMs: tsMs - 1, toMs: tsMs + 1, limit: 5 })
    if (rows.length === 0) rows.push(...await getTsdb().queryFrames(id, { fromMs: tsMs - 1, toMs: tsMs + 1, limit: 5 }))
    const row = rows.find(r => r.at === tsMs)
    if (!row || row.kind !== 'image') throw Object.assign(new Error(`帧不存在: ${id}@${tsMs}`), { status: 404 })
    const key = (thumb ? row.meta.thumbKey : row.meta.objectKey) as string | undefined
    if (!key) throw Object.assign(new Error(`帧对象缺失: ${id}@${tsMs}`), { status: 404 })
    const data = await getObjectStore().get(String(key))
    return { data, mime: typeof row.meta.mime === 'string' ? row.meta.mime : 'image/png' }
  }
}
