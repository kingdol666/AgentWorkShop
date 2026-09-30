/**
 * MES 取数控制器(Agent 工具后端)—— mes-rest 点位目录 + 历史取数编排。
 *
 * 护栏全部**代码级**(不是提示词):绑线授权过滤、时间窗 ≤7 天、maxRows ≤5000、
 * 每 agent 每 60s ≤6 次 fetch;数据原文不进 prompt —— 文本只给 stats + ≤3 行采样,
 * 行级原文只落 CSV 数据集(mes-datasets)。
 *
 * 取数三模式:
 *   无 from/to                     → 当前值快照(driver.read 内联直读);
 *   from/to 且 maxRows ≤ 2000      → 同步 fetchHistory 内联返回(缓冲截断保护);
 *   其余(maxRows > 2000)         → createFetchJob 异步落 CSV,回 job_id/dataset_id。
 */
import { resolveDcwDriver } from '../dcw/drivers'
import type { MesHistoryDriver, MesDatasetStatsView, MesDatasetStore } from './mes-datasets'
import { getMesDatasets } from './mes-datasets'

/** mes-rest 驱动 kind(并行工作流收编进 DcwDriverKind 联合;此处按字符串经注册表解析,不 import 驱动实现) */
export const MES_REST_DRIVER_KIND = 'mes-rest'

// ============================================================
// 护栏常量(单一事实源;测试直接引用)
// ============================================================

/** 历史窗口上限:7 天 */
export const MES_WINDOW_MAX_MS = 7 * 24 * 3_600_000
/** 单次取数行数硬上限 */
export const MES_MAX_ROWS_CAP = 5000
/** 同步内联返回的行数上限(超过走异步数据集) */
export const MES_SYNC_INLINE_MAX_ROWS = 2000
/** 频次限流:窗口与次数(每 agent) */
export const MES_RATE_WINDOW_MS = 60_000
export const MES_RATE_MAX_CALLS = 6
/** max_rows 缺省值 */
export const MES_DEFAULT_MAX_ROWS = 500

// ============================================================
// 频次限流(进程内内存计数;Map<agentId, 时间戳[]>)
// ============================================================

const fetchCallStamps = new Map<string, number[]>()

/** 记一次 fetch 并判定是否放行(滑动 60s 窗 ≤6 次;超限不记账) */
export function mesFetchRateCheck(agentId: string, nowMs = Date.now()): boolean {
  const stamps = (fetchCallStamps.get(agentId) ?? []).filter(t => nowMs - t < MES_RATE_WINDOW_MS)
  if (stamps.length >= MES_RATE_MAX_CALLS) {
    fetchCallStamps.set(agentId, stamps)
    return false
  }
  stamps.push(nowMs)
  fetchCallStamps.set(agentId, stamps)
  return true
}

/** 清空限流账(测试用) */
export function mesFetchRateReset(): void {
  fetchCallStamps.clear()
}

// ============================================================
// 节点/依赖(结构化注入;缺省接真实服务,测试注入假件不联网)
// ============================================================

export interface MesNodeLike {
  id: string
  name: string
  driver: string
  lineId: string
  unit: string
  min: number
  max: number
  enabled: boolean
  driverConfig: Record<string, string | number | boolean>
}

export interface MesControllerDeps {
  /** 数据集服务(异步取数账本;缺省 getMesDatasets()) */
  store: Pick<MesDatasetStore, 'createFetchJob'>
  /** 全量 dcw 节点(缺省 dcw-node.repo) */
  nodes: () => MesNodeLike[] | Promise<MesNodeLike[]>
  /** 调用者可见节点(绑线过滤:dcw 绑定集;缺省 node-bindings.repo) */
  boundNodeIds: (agentId: string) => Set<string> | Promise<Set<string>>
  /** 驱动解析(缺省 dcw 注册表) */
  resolveDriver: (kind: string) => MesHistoryDriver
  nowMs: () => number
}

/** 缺省依赖:重模块(dcw 仓储/绑线仓储)经动态 import 引入,保持本模块可被 tsx 测试轻量直跑 */
function defaultDeps(): MesControllerDeps {
  return {
    store: new Proxy({} as Pick<MesDatasetStore, 'createFetchJob'>, {
      get: (_t, prop) => {
        const store = getMesDatasets() as unknown as Record<string | symbol, unknown>
        const v = store[prop]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(store) : v
      },
    }),
    nodes: async () => {
      const { getDcwNodeRepo } = await import('../dcw/dcw-node.repo')
      return getDcwNodeRepo().all()
    },
    boundNodeIds: async (agentId) => {
      const { getAgentNodeBindingRepo } = await import('../agents/node-bindings.repo')
      return new Set(getAgentNodeBindingRepo().byAgent(agentId).filter(b => b.kind === 'dcw').map(b => b.nodeId))
    },
    resolveDriver: kind => resolveDcwDriver(kind as Parameters<typeof resolveDcwDriver>[0]),
    nowMs: () => Date.now(),
  }
}

export type MesCatalogEntry = {
  id: string
  name: string
  lineId: string
  unit: string
  min: number
  max: number
  desc: string
  readable: boolean
  writable: boolean
  historyable: boolean
  enabled: boolean
}

/** 目录条目合成:desc/readMap/writeMap/historyMap 均来自 driverConfig(数据驱动,零硬编码) */
export function mesCatalogEntryOf(n: MesNodeLike): MesCatalogEntry {
  const cfg = n.driverConfig ?? {}
  return {
    id: n.id,
    name: n.name,
    lineId: n.lineId ?? '',
    unit: n.unit ?? '',
    min: n.min,
    max: n.max,
    desc: String(cfg.desc ?? ''),
    readable: Boolean(cfg.readMap),
    writable: Boolean(cfg.writeMap),
    historyable: Boolean(cfg.historyMap),
    enabled: Boolean(n.enabled),
  }
}

// ============================================================
// 控制器
// ============================================================

export type MesToolResult = { text: string, isError?: boolean }

export type MesFetchOutcome = MesToolResult & {
  mode?: 'snapshot' | 'inline' | 'async'
  data?: {
    job_ids?: string[]
    dataset_ids?: string[]
    stats?: Array<{ nodeId: string, stats: MesDatasetStatsView, truncated: boolean }>
  }
}

export interface MesFetchArgs {
  ids?: unknown
  from?: string
  to?: string
  max_rows?: number | string
}

export interface MesCatalogArgs { q?: string, line_id?: string, limit?: number | string }

export function createMesController(deps: Partial<MesControllerDeps> = {}) {
  const d: MesControllerDeps = { ...defaultDeps(), ...deps }

  // ---------- 目录 ----------

  /** mes-rest 点位目录(q 对 name/desc 子串过滤;line_id 精确过滤;limit 缺省 20) */
  async function catalog(args: MesCatalogArgs = {}): Promise<MesToolResult & { entries: MesCatalogEntry[], total: number }> {
    const all = await d.nodes()
    let mes = all.filter(n => n.driver === MES_REST_DRIVER_KIND).map(mesCatalogEntryOf)
    const total = mes.length
    const lineId = String(args.line_id ?? '').trim()
    if (lineId) mes = mes.filter(e => e.lineId === lineId)
    const q = String(args.q ?? '').trim().toLowerCase()
    if (q) mes = mes.filter(e => e.name.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q))
    const limit = Math.min(Math.max(Math.round(Number(args.limit)) || 20, 1), 100)
    const shown = mes.slice(0, limit)

    const cap = (e: MesCatalogEntry): string => {
      const ab = [e.readable ? '读' : null, e.writable ? '写' : null, e.historyable ? '史' : null].filter(Boolean)
      return ab.length > 0 ? ab.join('/') : '无能力位'
    }
    const body = shown.map(e =>
      `- ${e.name}(id=${e.id}) | 产线 ${e.lineId || '未分配'} | 单位 ${e.unit || '-'} | 量程 ${e.min}~${e.max} | 能力 ${cap(e)}${e.enabled ? '' : ' [停用]'}${e.desc ? ` | ${e.desc.slice(0, 80)}` : ''}`)
    const more = mes.length - shown.length
    const text = `MES REST 点位目录(共 ${total} 个${lineId ? `,产线 ${lineId}` : ''}${q ? `,关键字「${args.q}」` : ''};显示 ${shown.length} 条):\n${body.join('\n') || '(无匹配点位)'}${more > 0 ? `\n(另有 ${more} 条未显示,可收紧 q/line_id 或调大 limit≤100)` : ''}\n\n说明:能力 读=可读当前值,写=可写设定值,史=可取历史(fetchHistory);历史取数用 mes_fetch(ids=[点位id], from, to, max_rows),数据原文落 CSV 数据集,prompt 只回统计摘要。`
    return { text, entries: shown, total }
  }

  // ---------- 取数 ----------

  /** 归一 ids + 授权过滤(绑线路径:仅调用者 dcw 绑定的 mes-rest 节点) */
  async function resolveVisibleIds(agentId: string, rawIds: unknown): Promise<{ ok: true, nodes: MesNodeLike[] } | { ok: false, text: string, isError: true }> {
    const ids = Array.isArray(rawIds) ? [...new Set(rawIds.map(x => String(x ?? '').trim()).filter(Boolean))] : []
    if (ids.length === 0) return { ok: false, text: 'ids 必填:目标 mes-rest 点位 id 数组(catalog 输出的 id;至少 1 个)。', isError: true }
    const all = await d.nodes()
    const bound = await d.boundNodeIds(agentId)
    const mesById = new Map(all.filter(n => n.driver === MES_REST_DRIVER_KIND).map(n => [n.id, n]))
    const picked: MesNodeLike[] = []
    const missing: string[] = []
    const notAllowed: string[] = []
    for (const id of ids) {
      const n = mesById.get(id)
      if (!n) {
        missing.push(id)
        continue
      }
      if (!bound.has(id)) {
        notAllowed.push(id)
        continue
      }
      picked.push(n)
    }
    if (missing.length > 0 || notAllowed.length > 0) {
      const allowed = [...bound]
        .map(id => mesById.get(id))
        .filter((n): n is MesNodeLike => !!n && n.driver === MES_REST_DRIVER_KIND)
      const parts: string[] = []
      if (missing.length > 0) parts.push(`不存在或不是 mes-rest 点位:${missing.join(', ')}`)
      if (notAllowed.length > 0) parts.push(`无权访问(须为你绑定的数控节点):${notAllowed.join(', ')}`)
      return {
        ok: false,
        text: `取数被拒:${parts.join(';')}。你有权取数的 mes-rest 点位:${allowed.map(n => `${n.name}(${n.id})`).join(', ') || '(无)'}。`,
        isError: true,
      }
    }
    return { ok: true, nodes: picked }
  }

  /** 时间窗/行数护栏归一(代码级;返回错误文本或归一值) */
  function normalizeWindow(args: MesFetchArgs): { ok: true, from?: string, to?: string, maxRows: number } | { ok: false, text: string, isError?: true } {
    const from = String(args.from ?? '').trim()
    const to = String(args.to ?? '').trim()
    if ((from && !to) || (!from && to)) {
      return { ok: false, text: 'from/to 必须成对提供(历史取数),或都不传(当前值快照模式)。' }
    }
    if (from && to) {
      const fromMs = Date.parse(from)
      const toMs = Date.parse(to)
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { ok: false, text: 'from/to 必须是合法 ISO 时间戳。' }
      if (fromMs >= toMs) return { ok: false, text: `时间窗无效:from(${from}) 必须早于 to(${to})。` }
      if (toMs - fromMs > MES_WINDOW_MAX_MS) {
        return { ok: false, text: `时间窗被拒:窗口 ${(toMs - fromMs) / 3_600_000 / 24} 天超过上限 7 天。请拆成 ≤7 天的分段分批取数。`, isError: true }
      }
    }
    const maxRows = args.max_rows == null || args.max_rows === '' ? MES_DEFAULT_MAX_ROWS : Math.round(Number(args.max_rows))
    if (!Number.isFinite(maxRows) || maxRows < 1) return { ok: false, text: 'max_rows 必须为 ≥1 的整数。' }
    if (maxRows > MES_MAX_ROWS_CAP) {
      return { ok: false, text: `max_rows=${maxRows} 被拒:单次取数上限 ${MES_MAX_ROWS_CAP} 行。请缩小时间窗或分批取数。`, isError: true }
    }
    return { ok: true, from: from || undefined, to: to || undefined, maxRows }
  }

  /** 统计摘要(数值列;均值/采样标准差) */
  function statsOf(values: number[], firstTs: string | null, lastTs: string | null): MesDatasetStatsView {
    const n = values.length
    if (n === 0) return { count: 0, min: null, max: null, mean: null, stddev: null, firstTs: null, lastTs: null }
    const min = Math.min(...values)
    const max = Math.max(...values)
    const mean = values.reduce((a, b) => a + b, 0) / n
    const stddev = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
    return { count: n, min, max, mean, stddev, firstTs, lastTs }
  }

  const fmtN = (v: number | null | undefined, digits = 3): string =>
    v == null || !Number.isFinite(v) ? '-' : String(Number(v.toFixed(digits)))
  const shortTs = (iso: string | null): string => iso && iso.length >= 19 ? iso.slice(5, 19).replace('T', ' ') : (iso ?? '-')

  /** 同步取单节点历史(缓冲截断保护;原文不回传,只回 stats+采样) */
  async function inlineFetchNode(node: MesNodeLike, from: string, to: string, maxRows: number): Promise<{
    text: string
    stats: MesDatasetStatsView
    truncated: boolean
    sample: string[]
  }> {
    const driver = d.resolveDriver(node.driver)
    if (typeof driver.fetchHistory !== 'function') {
      return { text: `驱动 ${node.driver} 未提供历史原语(fetchHistory)`, stats: statsOf([], null, null), truncated: true, sample: [] }
    }
    const buf: Array<{ ts: string, value: number }> = []
    let truncated = false
    const result = await driver.fetchHistory({
      driverConfig: node.driverConfig as Record<string, unknown>,
      fromIso: from,
      toIso: to,
      maxRows,
      onRows: (batch) => {
        for (const r of batch ?? []) {
          if (buf.length >= maxRows) {
            truncated = true
            break
          }
          buf.push({ ts: String(r?.ts ?? ''), value: Number(r?.value) })
        }
      },
    })
    if (result && result.complete === false) truncated = true
    const values = buf.map(r => r.value).filter(v => Number.isFinite(v))
    const stats = statsOf(values, buf[0]?.ts ?? null, buf[buf.length - 1]?.ts ?? null)
    const sample: string[] = []
    if (buf.length > 0) {
      const idx = [...new Set([0, Math.floor((buf.length - 1) / 2), buf.length - 1])].slice(0, 3)
      for (const i of idx) sample.push(`${shortTs(buf[i]!.ts)},${fmtN(buf[i]!.value)}`)
    }
    const text = [
      `■ ${node.name}(id=${node.id})`,
      `  行数 ${stats.count}${truncated ? '(截断:达到 maxRows 上限)' : '(完整)'} | 首 ${shortTs(stats.firstTs)} ~ 末 ${shortTs(stats.lastTs)}`,
      `  统计:min ${fmtN(stats.min)} / max ${fmtN(stats.max)} / mean ${fmtN(stats.mean)} / stddev ${fmtN(stats.stddev)} ${node.unit}`,
      sample.length > 0 ? `  采样(≤3 行,ts,value): ${sample.join(' | ')}` : '  采样:无有效数值行',
    ].join('\n')
    return { text, stats, truncated, sample }
  }

  /**
   * 取数编排(护栏全代码级):
   * 授权过滤 → 窗口/行数归一 → 频次限流 → 快照 / 内联 / 异步三模式。
   */
  async function fetch(agentId: string, args: MesFetchArgs): Promise<MesFetchOutcome> {
    // ① 授权:ids 必须是调用者可见(绑线)的 mes-rest 节点
    const vis = await resolveVisibleIds(agentId, args.ids)
    if (!vis.ok) return { text: vis.text, isError: true }
    // ② 窗口/行数护栏
    const win = normalizeWindow(args)
    if (!win.ok) return { text: win.text, isError: true }
    // ③ 频次限流(每 agent 每 60s ≤6 次)
    if (!mesFetchRateCheck(agentId, d.nowMs())) {
      return { text: `取数过于频繁:每 60 秒最多 ${MES_RATE_MAX_CALLS} 次。请先消化已有结果,稍后再取。`, isError: true }
    }

    // 模式一:当前值快照(无 from/to)
    if (!win.from || !win.to) {
      const lines: string[] = []
      for (const node of vis.nodes) {
        const driver = d.resolveDriver(node.driver)
        try {
          if (typeof driver.read !== 'function') {
            lines.push(`- ${node.name}(${node.id}):驱动 ${node.driver} 不支持读取`)
            continue
          }
          const r = await driver.read({ domain: { min: node.min, max: node.max }, driverConfig: node.driverConfig })
          const at = new Date(d.nowMs()).toISOString()
          lines.push(r.ok && r.eng != null
            ? `- ${node.name}(${node.id}):${fmtN(r.eng)}${node.unit} @ ${shortTs(at)}`
            : `- ${node.name}(${node.id}):读取失败(${r.message.slice(0, 80)})`)
        }
        catch (err) {
          lines.push(`- ${node.name}(${node.id}):读取异常(${(err instanceof Error ? err.message : String(err)).slice(0, 80)})`)
        }
      }
      return {
        mode: 'snapshot',
        text: `MES 当前值快照(${vis.nodes.length} 个点位,内联直读):\n${lines.join('\n')}\n\n说明:当前值为直读快照;历史窗口用 mes_fetch 带 from/to(≤7 天,max_rows≤${MES_MAX_ROWS_CAP})。`,
      }
    }

    // 模式二:同步内联(行数 ≤ MES_SYNC_INLINE_MAX_ROWS)
    if (win.maxRows <= MES_SYNC_INLINE_MAX_ROWS) {
      const sections: string[] = []
      const statsOut: NonNullable<MesFetchOutcome['data']>['stats'] = []
      for (const node of vis.nodes) {
        try {
          const one = await inlineFetchNode(node, win.from, win.to, win.maxRows)
          sections.push(one.text)
          statsOut.push({ nodeId: node.id, stats: one.stats, truncated: one.truncated })
        }
        catch (err) {
          sections.push(`■ ${node.name}(id=${node.id})\n  取数失败:${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return {
        mode: 'inline',
        text: `MES 历史取数(内联同步,${vis.nodes.length} 个点位,窗口 ${shortTs(win.from)} ~ ${shortTs(win.to)}):\n${sections.join('\n')}\n\n说明:以上为统计摘要与 ≤3 行采样;MES 原文不进入对话。需要全量行数据请用更大 max_rows(> ${MES_SYNC_INLINE_MAX_ROWS})走异步数据集,再用 mes_dataset_read 读。`,
        data: { stats: statsOut },
      }
    }

    // 模式三:异步数据集(行数 > MES_SYNC_INLINE_MAX_ROWS;进程内异步,绝不进调度循环)
    const jobIds: string[] = []
    const datasetIds: string[] = []
    const lines: string[] = []
    for (const node of vis.nodes) {
      const { jobId, datasetId } = d.store.createFetchJob({
        nodeId: node.id,
        fromIso: win.from,
        toIso: win.to,
        maxRows: win.maxRows,
        agentId,
        lineId: node.lineId,
        nodeName: node.name,
        driverConfig: node.driverConfig as Record<string, unknown>,
      })
      jobIds.push(jobId)
      datasetIds.push(datasetId)
      lines.push(`- ${node.name}(${node.id}):job_id=${jobId} dataset_id=${datasetId} status=running`)
    }
    return {
      mode: 'async',
      text: `已创建 ${lines.length} 个异步取数作业(窗口 ${shortTs(win.from)} ~ ${shortTs(win.to)},max_rows=${win.maxRows}):\n${lines.join('\n')}\n\n勿轮询;未完成先做别的,用 mes_datasets 查状态,完成后 mes_dataset_read(dataset_id, mode=stats/rows) 读内容。`,
      data: { job_ids: jobIds, dataset_ids: datasetIds },
    }
  }

  return { catalog, fetch }
}

export type MesController = ReturnType<typeof createMesController>
