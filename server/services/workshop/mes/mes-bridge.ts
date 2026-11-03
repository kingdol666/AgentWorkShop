/**
 * MES 历史 → 平台 TSDB 桥(H1,2026-11-03)。
 *
 * 现状边界(修复前):mes_fetch/mes_export 把 MES 历史落到 CSV 数据集与导出目录,
 * AML 数据集构建只吃 TSDB(`fetchNodeSeries`),所以"MES 数据 → 数据集 → 训练 →
 * 优化闭环"被切断。本模块把 MES 历史按**采集同一套打标语义**写进 daq_samples /
 * daq_frames:
 *   - scalar → daq_samples(逐点数值,state='ok',按批次三元组打标);
 *   - vector → daq_frames(kind=vector,meta.points 存全点列,指标 avg/min/max);
 *   - image  → 对象存储(daqObjectKey 同款键)+ daq_frames(kind=image,元数据/指纹);
 *   - table/event 无 TSDB 列模型 → 明确跳过并计数(不静默丢)。
 *
 * 语义纪律:
 *  - **幂等**:(nodeId, tsMs) 是 TSDB 主键,重复桥接不产生重复行;已在库的时间戳
 *    以 duplicates 计数跳过(首写胜出,不静默覆盖历史值);
 *  - **批次打标**:显式 run_id 或产线活动批次;批次窗口外的行只打 line 标
 *    (不冒充批次数据,防训练集串味);无批次上下文时回包明确提示;
 *  - **开关**:全局 AW_MES_BRIDGE=0 或节点 driverConfig.bridge='false' 关闭;
 *  - **护栏**:窗口 ≤7 天、单次 ≤5000 行、向量元素/图像载荷内存硬顶(与 mes_fetch 同口径);
 *  - 数据目录写操作留痕由调用方(Agent 工具/REST)记 ops。
 *
 * 设计意图:桥接的是**外部历史数据**而非设备写入,不需要 HITL;但它是数据面写,
 * 只允许对调用者已授权的 mes-rest 点位执行(授权在 tool/REST 层完成,本模块只收
 * 节点清单)。
 */
import { createHash } from 'node:crypto'
import { AppError } from '../../../utils/errors'
import type { DcwHistoryFormat, DcwHistoryRow } from '../dcw/drivers/shared'
import { historyFormatOf } from '../dcw/drivers/mes-rest'
import { mesRequestHookCode, runMesRequestHook } from './mes-hook'
import { daqObjectKey } from '../daq/objectstore/objectstore-port'
import type { DaqFrameRow, DaqSampleRow, TsdbPort } from '../daq/storage/tsdb-port'

// ============================================================
// 护栏常量(与 mes-controller 同口径;不在本模块重复定义业务上限的"另一套")
// ============================================================

/** 历史窗口上限:7 天(与 mes_fetch 一致) */
export const MES_BRIDGE_WINDOW_MAX_MS = 7 * 24 * 3_600_000
/** 单次桥接行数硬上限(与 mes_fetch 一致) */
export const MES_BRIDGE_MAX_ROWS = 5000
/** 向量元素总量硬顶(防一次桥接把进程内存打爆) */
const VECTOR_ELEMENT_CAP = 2_000_000
/** 图像 base64 字符总量硬顶(≈16MB 原始字节) */
const IMAGE_BASE64_CAP = 16_000_000
/** 单帧图像原始字节上限(与 mes-hook 文件上限同量级) */
const IMAGE_BYTES_MAX = 8_000_000
/** 写库分批(标量/帧共用;避免单条 SQL 参数过多) */
const WRITE_CHUNK = 500

// ============================================================
// 类型
// ============================================================

export interface MesBridgeNode {
  id: string
  name: string
  driver: string
  lineId: string
  unit: string
  min: number
  max: number
  enabled?: boolean
  driverConfig: Record<string, unknown>
}

export interface MesBridgeRun {
  runId: string
  lineId: string
  productId?: string | null
  recipeId?: string | null
  startedAt: string
  endedAt?: string | null
}

/** 历史行回调入参(桥接不需要分页细节,内部缓冲后统一去重/写库) */
export type MesBridgeDriver = {
  fetchHistory?: (input: {
    driverConfig: Record<string, unknown>
    fromIso: string
    toIso: string
    maxRows: number
    onRows: (rows: DcwHistoryRow[]) => Promise<void> | void
  }) => Promise<{ rows: number, complete: boolean } | undefined>
}

export type MesBridgeTsdb = Pick<TsdbPort, 'writeSamples' | 'writeFrames' | 'query' | 'queryFrames'> & Partial<Pick<TsdbPort, 'queryTaggedPage'>>

export interface MesBridgeDeps {
  nodes?: (ids: string[]) => MesBridgeNode[] | Promise<MesBridgeNode[]>
  /** 驱动查找(缺省异步 import 注册表;注入假驱动便于单测) */
  resolveDriver?: (kind: string) => MesBridgeDriver | Promise<MesBridgeDriver>
  tsdb?: () => MesBridgeTsdb | Promise<MesBridgeTsdb>
  objectStore?: () => { put(key: string, data: Buffer, mime?: string): Promise<void> } | Promise<{ put(key: string, data: Buffer, mime?: string): Promise<void> }>
  runById?: (id: string) => MesBridgeRun | undefined
  activeRun?: (lineId?: string) => MesBridgeRun | null
  now?: () => number
}

export interface MesBridgeArgs {
  nodeIds: string[]
  fromIso: string
  toIso: string
  maxRows?: number
  /** 目标批次:必须与节点同线;缺省 = 该产线活动批次 */
  runId?: string
  /** 允许桥接的形态(缺省 scalar/vector/image) */
  include?: DcwHistoryFormat[]
  /** 向量重采样目标点数(2–4096;缺省保留原维度) */
  resampleTo?: number
  /** requestHook 透传参数(与 mes_fetch 的 param 同义) */
  param?: unknown
  /** 试运行:完整取数/统计,不写库也不落对象存储 */
  dryRun?: boolean
}

export interface MesBridgeNodeResult {
  nodeId: string
  nodeName: string
  format: DcwHistoryFormat
  /** 实际是否写入(dryRun=false 且无错误) */
  written: boolean
  fetched: number
  /** 新写入行数 */
  inserted: number
  /** 时间戳已存在而跳过的行数(幂等) */
  duplicates: number
  /** 批次窗口外、只打线标的数据行数 */
  outsideRunWindow: number
  /** 载荷非法/空行/超限而跳过的行数 */
  skipped: number
  truncated: boolean
  tags: { lineId: string, runId: string | null, productId: string | null, recipeId: string | null } | null
  error?: string
}

export interface MesBridgeOutcome {
  ok: boolean
  isError?: boolean
  text: string
  totals: { nodes: number, nodesOk: number, fetched: number, inserted: number, duplicates: number, skipped: number }
  nodes: MesBridgeNodeResult[]
}

// ============================================================
// 小工具
// ============================================================

/** 桥接开关:全局 env 关闭优先;节点 driverConfig.bridge='false'/'0'/false 关闭 */
export function mesBridgeEnabled(cfg: Record<string, unknown> | undefined): boolean {
  if (process.env.AW_MES_BRIDGE === '0') return false
  const v = cfg?.bridge
  return !(v === false || v === 'false' || v === 0 || v === '0')
}

const numOf = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** 线性重采样(与 daq frames resample 处理器同算法) */
export function resamplePoints(src: number[], n: number): number[] {
  if (src.length === n || src.length === 0) return src
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const pos = (i * (src.length - 1)) / (n - 1)
    const lo = Math.floor(pos)
    const hi = Math.min(src.length - 1, lo + 1)
    const f = pos - lo
    out.push(src[lo]! * (1 - f) + src[hi]! * f)
  }
  return out
}

function pointsStats(points: number[]): { avg: number, min: number, max: number } {
  if (points.length === 0) return { avg: 0, min: 0, max: 0 }
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const p of points) {
    if (p < min) min = p
    if (p > max) max = p
    sum += p
  }
  return { avg: sum / points.length, min, max }
}

/** 行伴随字段 → 有界可读摘要(数字进 metrics,字符串截断进 meta) */
function recordBrief(record: unknown): { metrics: Record<string, number>, summary: Record<string, unknown> } {
  const metrics: Record<string, number> = {}
  const summary: Record<string, unknown> = {}
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return { metrics, summary }
  let n = 0
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (n >= 32) break
    if (typeof v === 'number' && Number.isFinite(v)) {
      metrics[String(k)] = Math.round(v * 1e6) / 1e6
      n++
      continue
    }
    if (typeof v === 'string') {
      if (v.length <= 200) {
        summary[String(k)] = v
        n++
      }
      continue
    }
    if (typeof v === 'boolean') {
      summary[String(k)] = v
      n++
    }
  }
  return { metrics, summary }
}

function imageExtOf(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('bmp')) return '.bmp'
  if (mime.includes('tiff')) return '.tiff'
  return '.png'
}

/** 图像尺寸(仅解析常见头部;解析失败返回 0,不阻断归档) */
export function imageDimsOf(buf: Buffer, mime: string): { width: number, height: number } {
  try {
    if ((mime.includes('png') || buf[0] === 0x89) && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (mime.includes('jpeg') || mime.includes('jpg') || (buf[0] === 0xFF && buf[1] === 0xD8)) {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xFF) {
          off++
          continue
        }
        const marker = buf[off + 1]!
        // SOF0..SOF15(排除 DHT/JPG/DAC)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        }
        const len = buf.readUInt16BE(off + 2)
        if (!Number.isFinite(len) || len < 2) break
        off += 2 + len
      }
    }
  }
  catch { /* 损坏头部 → 未知尺寸 */ }
  return { width: 0, height: 0 }
}

function stripDataUri(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, '')
}

// ============================================================
// requestHook 覆盖(与 mes-controller 的 historyMap 合并逻辑同源)
// ============================================================

async function effectiveConfig(node: MesBridgeNode, param: unknown): Promise<Record<string, unknown>> {
  const cfg = { ...node.driverConfig }
  const hookCode = mesRequestHookCode(cfg)
  if (!hookCode) return cfg
  const overrides = await runMesRequestHook(hookCode, param, { nodeId: node.id })
  if (overrides.path === undefined && overrides.query === undefined && overrides.headers === undefined) return cfg
  try {
    const map = JSON.parse(String(cfg.historyMap ?? '{}')) as Record<string, unknown>
    if (overrides.path !== undefined) map.path = overrides.path
    const baseQuery = (map.query !== null && typeof map.query === 'object' && !Array.isArray(map.query) ? map.query : {}) as Record<string, unknown>
    map.query = { ...baseQuery, ...(overrides.query ?? {}) }
    const baseHeaders = (map.headers !== null && typeof map.headers === 'object' && !Array.isArray(map.headers) ? map.headers : {}) as Record<string, unknown>
    if (overrides.headers !== undefined) map.headers = { ...baseHeaders, ...overrides.headers }
    cfg.historyMap = JSON.stringify(map)
  }
  catch (err) {
    throw new AppError(422, 'MES_HOOK_FAILED', `requestHook 覆盖合并失败(historyMap 非法 JSON):${err instanceof Error ? err.message : String(err)}`)
  }
  return cfg
}

// ============================================================
// 默认依赖(动态 import,保持本模块可被 tsx 单测直跑)
// ============================================================

function defaultDeps(): Required<MesBridgeDeps> {
  return {
    nodes: async (ids) => {
      const { getDcwNodeRepo } = await import('../dcw/dcw-node.repo')
      const wanted = new Set(ids)
      return getDcwNodeRepo().all()
        .filter(n => wanted.has(n.id))
        .map(n => ({
          id: n.id,
          name: n.name,
          driver: n.driver,
          lineId: n.lineId ?? '',
          unit: n.unit ?? '',
          min: n.min,
          max: n.max,
          enabled: n.enabled,
          driverConfig: (n.driverConfig ?? {}) as Record<string, unknown>,
        }))
    },
    resolveDriver: async (kind) => {
      const { resolveDcwDriver } = await import('../dcw/drivers')
      return resolveDcwDriver(kind as never) as MesBridgeDriver
    },
    tsdb: async () => {
      const { getTsdb, tsdbReady } = await import('../daq/storage')
      await tsdbReady
      return getTsdb()
    },
    objectStore: async () => {
      const { getObjectStore } = await import('../daq/objectstore')
      return getObjectStore()
    },
    runById: () => undefined,
    activeRun: () => null,
    now: () => Date.now(),
  }
}

/** 延迟解析批次(默认实现走真实仓储;注入依赖优先) */
async function resolveRunOf(node: MesBridgeNode, runId: string | undefined, deps: Partial<MesBridgeDeps>): Promise<{ run: MesBridgeRun | null, error?: string }> {
  if (runId) {
    let run = deps.runById?.(runId)
    if (!run) {
      try {
        const { getDcwRecipeRepo } = await import('../dcw/dcw-recipe.repo')
        const r = getDcwRecipeRepo().runById(runId)
        if (r) {
          run = {
            runId: r.id,
            lineId: r.lineId,
            productId: r.productId,
            recipeId: r.recipeId,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          }
        }
      }
      catch { /* 仓储不可用 → 按不存在处理 */ }
    }
    if (!run) return { run: null, error: `批次 ${runId} 不存在(仅可引用已落库批次;可先开线或传活动批次 id)` }
    if (run.lineId !== node.lineId) return { run: null, error: `批次 ${runId} 归属产线 ${run.lineId},与节点产线 ${node.lineId || '未分配'} 不一致` }
    return { run }
  }
  let active = deps.activeRun?.(node.lineId) ?? null
  if (!active) {
    try {
      const { getActiveLineRun } = await import('../dcw/line-run')
      const r = getActiveLineRun(node.lineId)
      if (r) {
        active = {
          runId: r.runId,
          lineId: r.lineId,
          productId: r.productId,
          recipeId: r.recipeId,
          startedAt: r.startedAt,
          endedAt: null,
        }
      }
    }
    catch { /* 无活动批次 */ }
  }
  return { run: active }
}

// ============================================================
// 主流程
// ============================================================

interface BufferedRows {
  rows: DcwHistoryRow[]
  truncated: boolean
  elementCapHit: boolean
  imageCapHit: boolean
}

async function fetchRowsOf(
  driver: MesBridgeDriver,
  cfg: Record<string, unknown>,
  fromIso: string,
  toIso: string,
  maxRows: number,
): Promise<BufferedRows> {
  if (typeof driver.fetchHistory !== 'function') {
    throw new AppError(400, 'BAD_REQUEST', '驱动未提供历史原语(fetchHistory),无法桥接')
  }
  const out: BufferedRows = { rows: [], truncated: false, elementCapHit: false, imageCapHit: false }
  let elements = 0
  let imageChars = 0
  await driver.fetchHistory({
    driverConfig: cfg,
    fromIso,
    toIso,
    maxRows,
    onRows: (batch) => {
      for (const r of batch ?? []) {
        if (out.rows.length >= maxRows) {
          out.truncated = true
          break
        }
        if (Array.isArray(r.values)) {
          elements += r.values.length
          if (elements > VECTOR_ELEMENT_CAP) {
            out.elementCapHit = true
            out.truncated = true
            break
          }
        }
        if (typeof r.data === 'string') {
          imageChars += r.data.length
          if (imageChars > IMAGE_BASE64_CAP) {
            out.imageCapHit = true
            out.truncated = true
            break
          }
        }
        out.rows.push(r)
      }
    },
  })
  return out
}

/** 已存在的时间戳集合(标量:逗号分页;帧:单次上限 1000,剩余靠主键幂等) */
async function existingScalarTs(tsdb: MesBridgeTsdb, nodeId: string, fromMs: number, toMs: number): Promise<Set<number>> {
  const seen = new Set<number>()
  if (typeof tsdb.queryTaggedPage === 'function') {
    let afterTs: number | undefined
    for (let page = 0; page < 40; page++) {
      const r = await tsdb.queryTaggedPage(nodeId, { afterTs, fromMs, toMs, limit: 5000, withState: false })
      for (const p of r.points) seen.add(p.at)
      if (r.done || r.nextCursor == null) break
      afterTs = r.nextCursor
    }
    return seen
  }
  const pts = await tsdb.query(nodeId, { fromMs, toMs, limit: 5000 })
  for (const p of pts) seen.add(p.at)
  return seen
}

async function existingFrameTs(tsdb: MesBridgeTsdb, nodeId: string, fromMs: number, toMs: number): Promise<Set<number>> {
  const rows = await tsdb.queryFrames(nodeId, { fromMs, toMs, limit: 1000 })
  return new Set(rows.map(r => r.at))
}

/**
 * 桥接一个 MES 点位的历史到 TSDB(内部函数;公开入口见 bridgeMesHistory)。
 */
async function bridgeNode(
  node: MesBridgeNode,
  args: MesBridgeArgs,
  deps: Required<MesBridgeDeps>,
  fromMs: number,
  toMs: number,
  maxRows: number,
): Promise<MesBridgeNodeResult> {
  const cfg = node.driverConfig
  const format = historyFormatOf(cfg)
  const base: MesBridgeNodeResult = {
    nodeId: node.id,
    nodeName: node.name,
    format,
    written: false,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    outsideRunWindow: 0,
    skipped: 0,
    truncated: false,
    tags: null,
  }
  if (node.driver !== 'mes-rest') {
    return { ...base, error: `节点驱动为 ${node.driver},不是 mes-rest(桥接只适用于 MES REST 点位)` }
  }
  if (node.enabled === false) return { ...base, error: '节点已停用,拒绝桥接' }
  if (!mesBridgeEnabled(cfg)) return { ...base, error: '该节点已关闭桥接(driverConfig.bridge=false 或 AW_MES_BRIDGE=0)' }
  const include = args.include ?? ['scalar', 'vector', 'image']
  if (!include.includes(format)) {
    return { ...base, error: `历史格式 ${format} 不在本次 include 内(表/事件记录无 TSDB 列模型,请用 mes_export 导出)` }
  }
  if (!cfg.historyMap) return { ...base, error: '节点未配置 historyMap(历史映射),无法桥接' }

  // 批次解析(打标语义)
  const { run, error: runErr } = await resolveRunOf(node, args.runId, deps)
  if (runErr) return { ...base, error: runErr }
  const lineId = String(node.lineId ?? '').trim()
  if (!lineId) return { ...base, error: '节点未分配产线:TSDB 打标要求 lineId,无法桥接(请先把节点归属到产线)' }
  const runStart = run ? Date.parse(run.startedAt) : NaN
  const runEnd = run?.endedAt ? Date.parse(run.endedAt) : (run ? deps.now() : NaN)
  base.tags = {
    lineId,
    runId: run?.runId ?? null,
    productId: run?.productId ?? null,
    recipeId: run?.recipeId ?? null,
  }
  const tagFor = (tsMs: number): { lineId: string, productId: string | null, recipeId: string | null, runId: string | null, inRun: boolean } => {
    const inRun = !!run && Number.isFinite(runStart) && Number.isFinite(runEnd) && tsMs >= runStart && tsMs <= runEnd
    return inRun
      ? { lineId, productId: run!.productId ?? null, recipeId: run!.recipeId ?? null, runId: run!.runId, inRun }
      : { lineId, productId: null, recipeId: null, runId: null, inRun }
  }

  // 取数(requestHook 覆盖生效)
  const effCfg = await effectiveConfig(node, args.param)
  const driver = await deps.resolveDriver(node.driver)
  const buffered = await fetchRowsOf(driver, effCfg, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), maxRows)
  base.fetched = buffered.rows.length
  base.truncated = buffered.truncated
  const tsdb = await deps.tsdb()
  const seen = format === 'scalar'
    ? await existingScalarTs(tsdb, node.id, fromMs, toMs)
    : format === 'image' || format === 'vector'
      ? await existingFrameTs(tsdb, node.id, fromMs, toMs)
      : new Set<number>()

  const samples: DaqSampleRow[] = []
  const frames: DaqFrameRow[] = []
  const resampleTo = numOf(args.resampleTo)
  const resampleN = resampleTo !== undefined && resampleTo >= 2 && resampleTo <= 4096 ? Math.round(resampleTo) : undefined

  for (const row of buffered.rows) {
    const tsMs = Date.parse(String(row.ts ?? ''))
    if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs > toMs) {
      base.skipped++
      continue
    }
    const tag = tagFor(tsMs)
    if (!tag.inRun && run) base.outsideRunWindow++
    if (seen.has(tsMs)) {
      base.duplicates++
      continue
    }
    seen.add(tsMs)

    if (format === 'scalar') {
      const v = numOf(row.value)
      if (v === undefined) {
        base.skipped++
        continue
      }
      samples.push({
        nodeId: node.id, tsMs, value: v, state: 'ok',
        lineId: tag.lineId, productId: tag.productId, recipeId: tag.recipeId, runId: tag.runId,
      })
      continue
    }

    if (format === 'vector') {
      const raw = (row.values ?? []).map(Number).filter(finite)
      if (raw.length === 0) {
        base.skipped++
        continue
      }
      const points = resampleN && raw.length !== resampleN ? resamplePoints(raw, resampleN) : raw
      const st = pointsStats(points)
      const brief = recordBrief(row.record)
      frames.push({
        nodeId: node.id,
        tsMs,
        kind: 'vector',
        templateKey: 'mes-bridge',
        lineId: tag.lineId,
        productId: tag.productId,
        recipeId: tag.recipeId,
        runId: tag.runId,
        points: points.length,
        meta: { points, source: 'mes', ...(Object.keys(brief.summary).length > 0 ? { record: brief.summary } : {}) },
        metrics: {
          ...brief.metrics,
          avg: Math.round(st.avg * 1e6) / 1e6,
          min: Math.round(st.min * 1e6) / 1e6,
          max: Math.round(st.max * 1e6) / 1e6,
        },
      })
      continue
    }

    if (format === 'image') {
      if (typeof row.data !== 'string' || row.data.trim() === '') {
        base.skipped++
        continue
      }
      const clean = stripDataUri(row.data)
      let buf: Buffer
      try {
        buf = Buffer.from(clean, 'base64')
      }
      catch {
        base.skipped++
        continue
      }
      if (buf.length === 0 || buf.length > IMAGE_BYTES_MAX) {
        base.skipped++
        continue
      }
      const mime = typeof row.mime === 'string' && row.mime.includes('/') ? row.mime : 'image/png'
      const key = daqObjectKey(node.id, tsMs, imageExtOf(mime))
      if (!args.dryRun) {
        const os = await deps.objectStore()
        await os.put(key, buf, mime)
      }
      const dims = imageDimsOf(buf, mime)
      const sha256 = createHash('sha256').update(buf).digest('hex')
      const brief = recordBrief(row.record)
      frames.push({
        nodeId: node.id,
        tsMs,
        kind: 'image',
        templateKey: 'mes-bridge',
        lineId: tag.lineId,
        productId: tag.productId,
        recipeId: tag.recipeId,
        runId: tag.runId,
        points: 0,
        meta: {
          objectKey: key,
          mime,
          width: dims.width,
          height: dims.height,
          sha256,
          size: buf.length,
          source: 'mes',
          ...(Object.keys(brief.summary).length > 0 ? { record: brief.summary } : {}),
        },
        metrics: brief.metrics,
      })
      continue
    }
  }

  if (!args.dryRun) {
    for (let i = 0; i < samples.length; i += WRITE_CHUNK) {
      await tsdb.writeSamples(samples.slice(i, i + WRITE_CHUNK))
    }
    for (let i = 0; i < frames.length; i += WRITE_CHUNK) {
      await tsdb.writeFrames(frames.slice(i, i + WRITE_CHUNK))
    }
  }
  base.inserted = samples.length + frames.length
  base.written = !args.dryRun
  return base
}

/**
 * 桥接入口:校验参数 → 逐节点取数/去重/写 TSDB → 汇总。
 * 返回文本摘要(Agent 工具直接消费)+ 结构化结果(测试/REST 消费)。
 */
export async function bridgeMesHistory(args: MesBridgeArgs, deps: Partial<MesBridgeDeps> = {}): Promise<MesBridgeOutcome> {
  const ids = [...new Set((Array.isArray(args.nodeIds) ? args.nodeIds : []).map(x => String(x ?? '').trim()).filter(Boolean))]
  const fail = (text: string): MesBridgeOutcome => ({
    ok: false,
    isError: true,
    text,
    totals: { nodes: ids.length, nodesOk: 0, fetched: 0, inserted: 0, duplicates: 0, skipped: 0 },
    nodes: [],
  })
  if (process.env.AW_MES_BRIDGE === '0') return fail('MES 桥接已被全局关闭(AW_MES_BRIDGE=0)。')
  if (ids.length === 0) return fail('nodeIds 必填:目标 mes-rest 点位 id 数组(至少 1 个)。')
  const fromMs = Date.parse(String(args.fromIso ?? ''))
  const toMs = Date.parse(String(args.toIso ?? ''))
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return fail('fromIso/toIso 必须是合法 ISO 时间戳。')
  if (fromMs >= toMs) return fail(`时间窗无效:from(${args.fromIso}) 必须早于 to(${args.toIso})。`)
  if (toMs - fromMs > MES_BRIDGE_WINDOW_MAX_MS) {
    return fail(`时间窗被拒:窗口 ${(toMs - fromMs) / 3_600_000 / 24} 天超过上限 7 天。请拆成 ≤7 天的分段分批桥接。`)
  }
  const maxRows = args.maxRows == null || String(args.maxRows).trim() === '' ? MES_BRIDGE_MAX_ROWS : Math.round(Number(args.maxRows))
  if (!Number.isFinite(maxRows) || maxRows < 1) return fail('maxRows 必须为 ≥1 的整数。')
  if (maxRows > MES_BRIDGE_MAX_ROWS) return fail(`maxRows=${maxRows} 被拒:单次桥接上限 ${MES_BRIDGE_MAX_ROWS} 行。请缩小时间窗或分批桥接。`)
  if (args.include && args.include.length > 0) {
    const allowed: DcwHistoryFormat[] = ['scalar', 'vector', 'image']
    const bad = args.include.filter(f => !allowed.includes(f))
    if (bad.length > 0) return fail(`include 含不支持的形态:${bad.join(', ')}(可桥接:scalar/vector/image;table/event 请用 mes_export)`)
  }

  const d = { ...defaultDeps(), ...deps }
  const nodes = await d.nodes(ids)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const missing = ids.filter(id => !byId.has(id))
  if (missing.length > 0) return fail(`点位不存在:${missing.join(', ')}(mes_catalog 可查可用点位)`)

  const results: MesBridgeNodeResult[] = []
  for (const id of ids) {
    const node = byId.get(id)!
    try {
      results.push(await bridgeNode(node, args, d, fromMs, toMs, maxRows))
    }
    catch (err) {
      results.push({
        nodeId: node.id,
        nodeName: node.name,
        format: historyFormatOf(node.driverConfig),
        written: false,
        fetched: 0,
        inserted: 0,
        duplicates: 0,
        outsideRunWindow: 0,
        skipped: 0,
        truncated: false,
        tags: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const totals = {
    nodes: results.length,
    nodesOk: results.filter(r => !r.error).length,
    fetched: results.reduce((a, r) => a + r.fetched, 0),
    inserted: results.reduce((a, r) => a + r.inserted, 0),
    duplicates: results.reduce((a, r) => a + r.duplicates, 0),
    skipped: results.reduce((a, r) => a + r.skipped, 0),
  }
  const ok = totals.nodesOk > 0 && totals.nodesOk === totals.nodes
  const lines = results.map((r) => {
    if (r.error) return `- ${r.nodeName}(${r.nodeId}) [${r.format}]:失败 —— ${r.error}`
    const tag = r.tags ? `打标 线=${r.tags.lineId}${r.tags.runId ? ` 批次=${r.tags.runId}` : ' (无批次)'}` : '未打标'
    return `- ${r.nodeName}(${r.nodeId}) [${r.format}]:取 ${r.fetched} 行 → 写入 ${r.inserted}${r.duplicates > 0 ? `,已存在跳过 ${r.duplicates}` : ''}${r.skipped > 0 ? `,无效跳过 ${r.skipped}` : ''}${r.outsideRunWindow > 0 ? `,批次窗外 ${r.outsideRunWindow}(只打线标)` : ''}${r.truncated ? '(截断)' : ''};${tag}`
  })
  const warn = results.some(r => !r.error && r.tags && !r.tags.runId)
    ? '\n注意:未解析到批次(run)上下文 —— 数据只打 line 标,AML 数据集按 runId 取数不会命中;请先开线或显式传 runId。'
    : ''
  const text = [
    `MES 历史桥接${args.dryRun ? '(试运行,未写库)' : '完成'}:${totals.nodesOk}/${totals.nodes} 个点位成功,取 ${totals.fetched} 行,写入 ${totals.inserted} 行${totals.duplicates > 0 ? `,幂等跳过 ${totals.duplicates} 行` : ''}${totals.skipped > 0 ? `,无效跳过 ${totals.skipped} 行` : ''}。`,
    ...lines,
    warn,
    args.dryRun ? '试运行未写库;确认统计后去掉 dryRun 再执行。' : '后续:数据集构建可直接把该点位加入 nodes(role=target/feature/control);桥接数据与数采数据同表同打标语义。',
  ].join('\n')

  return { ok, isError: !ok, text, totals, nodes: results }
}

/**
 * 图像帧归档(H5):把已取回的 MES 图像帧写入对象存储 + daq_frames,
 * 使 CCD/表检类数据与 DAQ 图像帧走**同一检索面**(frames API / frameContent)。
 *
 * 幂等:同 (nodeId, tsMs) 已有帧则跳过;对象键与 DAQ 帧同构(daqObjectKey),
 * 共享对象存储 GC 的按日清理。返回归档/跳过计数,不抛(归档失败逐帧计数)。
 */
export async function archiveMesImageRows(
  node: MesBridgeNode,
  rows: Array<{ ts: string, data: string, mime?: string, record?: unknown }>,
  deps: Partial<MesBridgeDeps> = {},
): Promise<{ archived: number, skipped: number, failed: number }> {
  if (rows.length === 0) return { archived: 0, skipped: 0, failed: 0 }
  const d = { ...defaultDeps(), ...deps }
  const lineId = String(node.lineId ?? '').trim()
  if (!lineId) return { archived: 0, skipped: rows.length, failed: 0 }
  const { run } = await resolveRunOf(node, undefined, deps)
  const runStart = run ? Date.parse(run.startedAt) : NaN
  const runEnd = run?.endedAt ? Date.parse(run.endedAt) : (run ? d.now() : NaN)
  const tsdb = await d.tsdb()
  const os = await d.objectStore()
  let archived = 0
  let skipped = 0
  let failed = 0
  for (const row of rows) {
    try {
      const tsMs = Date.parse(String(row.ts ?? ''))
      if (!Number.isFinite(tsMs) || typeof row.data !== 'string' || row.data.trim() === '') {
        skipped++
        continue
      }
      const existing = await tsdb.queryFrames(node.id, { fromMs: tsMs - 1, toMs: tsMs + 1, limit: 5 })
      if (existing.some(r => r.at === tsMs)) {
        skipped++
        continue
      }
      const buf = Buffer.from(stripDataUri(row.data), 'base64')
      if (buf.length === 0 || buf.length > IMAGE_BYTES_MAX) {
        skipped++
        continue
      }
      const mime = typeof row.mime === 'string' && row.mime.includes('/') ? row.mime : 'image/png'
      const key = daqObjectKey(node.id, tsMs, imageExtOf(mime))
      await os.put(key, buf, mime)
      const dims = imageDimsOf(buf, mime)
      const brief = recordBrief(row.record)
      const inRun = !!run && Number.isFinite(runStart) && Number.isFinite(runEnd) && tsMs >= runStart && tsMs <= runEnd
      await tsdb.writeFrames([{
        nodeId: node.id,
        tsMs,
        kind: 'image',
        templateKey: 'mes-bridge',
        lineId,
        productId: inRun ? run!.productId ?? null : null,
        recipeId: inRun ? run!.recipeId ?? null : null,
        runId: inRun ? run!.runId : null,
        points: 0,
        meta: {
          objectKey: key,
          mime,
          width: dims.width,
          height: dims.height,
          sha256: createHash('sha256').update(buf).digest('hex'),
          size: buf.length,
          source: 'mes',
          ...(Object.keys(brief.summary).length > 0 ? { record: brief.summary } : {}),
        },
        metrics: brief.metrics,
      }])
      archived++
    }
    catch {
      failed++
    }
  }
  return { archived, skipped, failed }
}
