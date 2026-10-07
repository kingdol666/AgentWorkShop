/**
 * daq_export —— 绑定数采节点的**全量原始时序**导出(CSV + 节点映射 manifest.json)。
 *
 * 与 daq_query(文本统计面)/diag-bridge 快照(5s 降采样单 CSV)互补:本工具把
 * Agent 自选节点的**逐样本完整时序**分页拉全,落盘到数据目录
 * `<dataDir>/daq-exports/<exportId>/`,并附 manifest.json(节点映射/单位量程/
 * 语义描述/产线-产品-配方-批次上下文/报警统计),供:
 *   - diag-bridge 的 diag_run(export_id=…)上传 IDD 做深度根因诊断;
 *   - Channel 下 worker(harness agent)直接按目录绝对路径读全量数据做分析。
 * 导出核心 exportDaqDataset 不依赖仓储单例(readPoints/nodeOf 注入),单测可全内存构造。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { getTsdb } from '../../daq/storage/index'
import { findDaqTemplate } from '../../daq/daq-templates'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getActiveLineRun } from '../../dcw/line-run'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { settingOf } from '../../settings'

const PAGE_LIMIT = 5000 // 与 tsdb 适配器单查硬上限一致(满页即续拉)
const MAX_PAGES_PER_NODE = 400 // 单节点上限 200 万点(超限截断并在 manifest 标注)
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 与 MES 取数同款 7 天窗护栏
const MAX_TOTAL_ROWS = 4_000_000 // 单次导出总行数护栏(磁盘与上传体量)
const MAX_FRAMES_PER_NODE = 200 // 帧节点单次导出帧数上限(图像原文件体量大)
const RETAIN_EXPORTS = 50 // 数据目录保留策略:只留最近 50 个导出(全量时序体量大,防无限增长)

export interface ExportNodeMeta {
  id: string
  name: string
  unit: string
  lineId: string
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  intervalMs?: number | null
  decimals?: number
  semantics?: string
  /** 信号形态(vector/image=帧节点:导出帧文件而非标量 CSV;缺省 scalar) */
  signalKind?: 'scalar' | 'vector' | 'image'
}

export interface ExportLineContext {
  lineId: string
  lineName: string
  description?: string
  runId?: string
  productId?: string
  productName?: string
  recipeId?: string
  recipeName?: string
  recipeVersion?: number
  daqWindows?: Array<{ nodeId: string, min?: number | null, max?: number | null }>
}

export interface DaqExportResult {
  exportId: string
  dir: string
  manifest: Record<string, unknown>
  files: Array<{ nodeId: string, file: string, rows: number }>
  totalRows: number
  truncated: string[]
  /** merge 模式产物:多节点按秒对齐的多参数宽表 CSV(绝对路径) */
  mergedFile?: string
}

/** merge 模式:多节点样本按秒取整就近对齐为多参数宽表(列名=节点名),供 IDD 等 CSV 分析服务直接消费 */
function writeMergedCsv(dir: string, files: DaqExportResult['files'], nodeOf: (id: string) => ExportNodeMeta | undefined): string | null {
  if (files.length === 0) return null
  const series = files.map((f) => {
    const raw = readFileSync(join(dir, f.file), 'utf8').trim().split(/\r?\n/).slice(1)
    const pts = raw.map((l) => {
      const cols = l.split(',')
      return { sec: Math.round(Number(cols[1]) / 1000), v: Number(cols[2]) }
    }).filter(p => Number.isFinite(p.sec) && Number.isFinite(p.v))
    const name = (nodeOf(f.nodeId)?.name ?? f.nodeId).replace(/[",\r\n]/g, ' ').trim() || f.nodeId
    return { id: f.nodeId, name, pts }
  })
  const base = series.reduce((a, b) => (b.pts.length > a.pts.length ? b : a), series[0]!)
  if (!base || base.pts.length === 0) return null
  const lookups = series.map((s) => {
    const m = new Map<number, number>()
    for (const p of s.pts) if (!m.has(p.sec)) m.set(p.sec, p.v)
    return m
  })
  const rows: string[] = [csvCell('time') + ',' + series.map(s => csvCell(`${s.name}(${s.id})`)).join(',')]
  for (const p of base.pts) {
    const vals = lookups.map((m) => {
      const v = m.get(p.sec) ?? m.get(p.sec - 1) ?? m.get(p.sec + 1)
      return v === undefined ? '' : fmtNum(v)
    })
    rows.push([csvCell(new Date(p.sec * 1000).toISOString()), ...vals.map(csvCell)].join(','))
  }
  const out = join(dir, 'merged.csv')
  writeFileSync(out, rows.join('\r\n'), 'utf8')
  return out
}

/** 数值格式化(6 位小数去尾零;非有限值 → 空串) */
function fmtNum(v: number | undefined | null): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  return String(Math.round(v * 1e6) / 1e6)
}

/** CSV 单元格转义 */
function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 节点 id → 安全文件名(路径穿越防护;id 本身已由白名单校验,这里兜底) */
function safeFileId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'node'
}

/** 帧记录(导出注入面:与 tsdb.queryFrames 返回形状一致) */
export interface ExportFrameRow {
  at: number
  kind: 'vector' | 'image'
  points?: number[]
  meta?: Record<string, unknown>
  metrics?: Record<string, number>
}

/** mime → 文件扩展名(未知 mime 兜底 bin) */
function mimeExt(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('bmp')) return 'bmp'
  if (mime.includes('gif')) return 'gif'
  return 'bin'
}

/**
 * 帧节点导出:向量 → 单 CSV 长表(ts_iso,ts_ms,point_index,value);
 * 图像 → frames/<nodeId>/ 下逐帧原文件(对象存储取回)+ 清单行。
 * 返回 manifest 节点条目;readFrameContent 失败按丢帧计数不阻断。
 */
async function exportFrames(
  dir: string,
  meta: ExportNodeMeta,
  frames: ExportFrameRow[],
  readFrameContent: (nodeId: string, at: number) => Promise<{ data: Buffer, mime: string } | null>,
  truncated: boolean,
): Promise<Record<string, unknown>> {
  const id = meta.id
  if (meta.signalKind === 'vector') {
    const rows: string[] = ['ts_iso,ts_ms,point_index,value']
    let n = 0
    for (const f of frames) {
      const pts = f.points ?? []
      for (let i = 0; i < pts.length; i++) {
        rows.push([new Date(f.at).toISOString(), f.at, i, fmtNum(pts[i])].map(csvCell).join(','))
      }
      n += 1
    }
    const fileRel = `frames/${safeFileId(id)}.csv`
    writeFileSync(join(dir, fileRel), rows.join('\r\n'), 'utf8')
    const metricEntries = frames.flatMap(f => Object.entries(f.metrics ?? {}))
    const metricSummary: Record<string, number> = {}
    for (const [k, v] of metricEntries) if (Number.isFinite(v)) metricSummary[k] = v
    return {
      id, name: meta.name, kind: 'vector', line_id: meta.lineId,
      semantics: meta.semantics || '', unit: meta.unit,
      file: fileRel, frames: n, points: rows.length - 1,
      value_range_observed: null, state_summary: {},
      metrics_summary: metricSummary,
      ...(truncated ? { truncated: true } : {}),
    }
  }
  // image:逐帧取回对象存储原文件落盘
  const nodeDirRel = `frames/${safeFileId(id)}`
  const nodeDir = join(dir, nodeDirRel)
  mkdirSync(nodeDir, { recursive: true })
  let saved = 0
  const files: string[] = []
  let mimeSeen = ''
  for (const f of frames) {
    try {
      const content = await readFrameContent(id, f.at)
      if (!content || content.data.length === 0) continue
      const ext = mimeExt(content.mime)
      const rel = `${nodeDirRel}/${f.at}.${ext}`
      writeFileSync(join(dir, rel), content.data)
      files.push(rel)
      mimeSeen = mimeSeen || content.mime
      saved += 1
    }
    catch { /* 单帧取回失败不阻断导出 */ }
  }
  const metricSummary: Record<string, number> = {}
  for (const f of frames) for (const [k, v] of Object.entries(f.metrics ?? {})) if (Number.isFinite(v)) metricSummary[k] = v
  return {
    id, name: meta.name, kind: 'image', line_id: meta.lineId,
    semantics: meta.semantics || '', unit: meta.unit,
    dir: nodeDirRel, frames: frames.length, saved,
    mime: mimeSeen || 'image/png',
    files: files.slice(0, 8),
    metrics_summary: metricSummary,
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * 导出核心:逐节点分页拉全原始时序 → 每节点一份 CSV + manifest.json。
 * readPoints/nodeOf 由调用方注入(tsdb 取数与节点元数据),本函数只管取数、落盘与清单。
 * 帧节点(signalKind=vector/image)走 readFrames/readFrameContent 导出帧文件。
 */
export async function exportDaqDataset(opts: {
  targets: string[]
  nodeOf: (id: string) => ExportNodeMeta | undefined
  readPoints: (nodeId: string, win: { fromMs: number, toMs: number, limit: number }) => Promise<Array<{ at: number, value?: number, state?: string }>>
  fromMs: number
  toMs: number
  title?: string
  note?: string
  lines?: ExportLineContext[]
  rootDir: string
  now?: () => number
  /** merge 模式:额外产出多节点按秒对齐的宽表 merged.csv */
  merge?: boolean
  /** 帧节点取数(vector/image 元数据行)与图像内容取回;缺省=帧节点按零样本跳过 */
  readFrames?: (nodeId: string, win: { fromMs: number, toMs: number, limit: number }) => Promise<ExportFrameRow[]>
  readFrameContent?: (nodeId: string, at: number) => Promise<{ data: Buffer, mime: string } | null>
  /** 上限覆盖(单测用;缺省 400 页/节点、400 万行总量) */
  caps?: { pagesPerNode?: number, totalRows?: number, framesPerNode?: number }
}): Promise<DaqExportResult> {
  const { targets, nodeOf, readPoints, fromMs, toMs, title, note, lines, rootDir } = opts
  const maxPages = opts.caps?.pagesPerNode ?? MAX_PAGES_PER_NODE
  const maxTotal = opts.caps?.totalRows ?? MAX_TOTAL_ROWS
  const maxFrames = opts.caps?.framesPerNode ?? MAX_FRAMES_PER_NODE
  const now = opts.now ?? Date.now
  const exportId = `daqexp-${new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
  const dir = join(rootDir, exportId)
  const nodesDir = join(dir, 'nodes')
  mkdirSync(nodesDir, { recursive: true })
  if (opts.readFrames) mkdirSync(join(dir, 'frames'), { recursive: true })

  const files: DaqExportResult['files'] = []
  const truncated: string[] = []
  const nodeMetas: Array<Record<string, unknown>> = []
  let totalRows = 0

  for (const id of targets) {
    const meta = nodeOf(id)
    if (!meta) continue
    // 帧节点(vector/image):导出帧文件而非标量 CSV —— 标量管线的 readPoints 查不到
    // 帧(帧只入 daq_frames),按标量导出会得到零行假象
    if (meta.signalKind === 'vector' || meta.signalKind === 'image') {
      if (!opts.readFrames) {
        nodeMetas.push({ id: meta.id, name: meta.name, kind: meta.signalKind, line_id: meta.lineId, semantics: meta.semantics || '', file: '', frames: 0, note: '未提供帧取数器(readFrames),帧节点跳过' })
        continue
      }
      const frames = await opts.readFrames(id, { fromMs, toMs, limit: maxFrames })
      // 时序契约:升序导出(适配器 queryFrames 为 DESC 最新在前,与 tsdb.query 同病)
      frames.sort((a, b) => a.at - b.at)
      const hitFrameCap = frames.length >= maxFrames
      if (hitFrameCap) truncated.push(id)
      const entry = await exportFrames(dir, meta, frames, opts.readFrameContent ?? (async () => null), hitFrameCap)
      nodeMetas.push(entry)
      totalRows += meta.signalKind === 'vector' ? (entry.points as number ?? 0) : (entry.saved as number ?? 0)
      continue
    }
    // 分页拉全:单查上限 PAGE_LIMIT,满页则以本页最大 ts+1 续拉(适配器无游标)
    const byAt = new Map<number, { at: number, value?: number, state?: string }>()
    let cursor = fromMs
    let pages = 0
    let hitCap = false
    while (cursor <= toMs) {
      if (++pages > maxPages || totalRows >= maxTotal) {
        hitCap = true
        break
      }
      const page = await readPoints(id, { fromMs: cursor, toMs, limit: PAGE_LIMIT })
      if (!Array.isArray(page) || page.length === 0) break
      let lastAt = cursor - 1
      for (const p of page) {
        if (!p || typeof p.at !== 'number' || p.at < cursor || p.at > toMs) continue
        if (typeof p.value === 'number' || p.state) byAt.set(p.at, { at: p.at, value: p.value, state: p.state })
        if (p.at > lastAt) lastAt = p.at
      }
      totalRows += byAt.size // 近似累计(护栏用;精确总量在下方重算)
      if (page.length < PAGE_LIMIT || lastAt >= toMs) break
      if (lastAt < cursor) break // 适配器未按 fromMs 过滤的防御:避免死循环
      cursor = lastAt + 1
    }
    const points = [...byAt.values()].sort((a, b) => a.at - b.at)
    if (hitCap) truncated.push(id)

    const fileRel = `nodes/${safeFileId(id)}.csv`
    const rowsCsv = ['ts_iso,ts_ms,value,state']
    const stateCount: Record<string, number> = {}
    let minV = Number.POSITIVE_INFINITY
    let maxV = Number.NEGATIVE_INFINITY
    for (const p of points) {
      const state = p.state || 'ok'
      stateCount[state] = (stateCount[state] ?? 0) + 1
      if (typeof p.value === 'number' && Number.isFinite(p.value)) {
        if (p.value < minV) minV = p.value
        if (p.value > maxV) maxV = p.value
      }
      rowsCsv.push([new Date(p.at).toISOString(), p.at, fmtNum(p.value), state].map(csvCell).join(','))
    }
    writeFileSync(join(dir, fileRel), rowsCsv.join('\r\n'), 'utf8')
    files.push({ nodeId: id, file: fileRel, rows: points.length })
    nodeMetas.push({
      id: meta.id,
      name: meta.name,
      unit: meta.unit,
      line_id: meta.lineId,
      range: { min: meta.min ?? null, max: meta.max ?? null },
      warn: { low: meta.warnLow ?? null, high: meta.warnHigh ?? null },
      interval_ms: meta.intervalMs ?? null,
      decimals: meta.decimals ?? null,
      semantics: meta.semantics || '',
      file: fileRel,
      rows: points.length,
      value_range_observed: points.length ? { min: Number(minV.toFixed(4)), max: Number(maxV.toFixed(4)) } : null,
      state_summary: stateCount,
    })
  }

  const exactRows = files.reduce((s, f) => s + f.rows, 0)
  const manifest: Record<string, unknown> = {
    schema: 'aw.daq-export/1',
    export_id: exportId,
    created_at: new Date(now()).toISOString(),
    title: title || '',
    note: note || '',
    window: { from_ms: fromMs, to_ms: toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    lines: lines ?? [],
    nodes: nodeMetas,
    totals: { files: files.length, rows: exactRows },
    truncated_nodes: truncated,
    usage: 'nodes/ 下每标量节点一份全量原始时序 CSV(ts_iso,ts_ms,value,state;无降采样);帧节点(vector/image)在 frames/ 下:向量=单 CSV 长表(ts_iso,ts_ms,point_index,value),图像=逐帧原文件 frames/<node_id>/<ts>.<ext>。请结合本清单的节点语义/量程/产线-配方上下文做分析;深度根因诊断请用 diag-bridge 的 diag_run(export_id=本 export_id)。',
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  // 保留策略:超出 RETAIN_EXPORTS 的最旧导出目录直接清理(mes-artifacts 同款思路)
  try {
    const siblings = readdirSync(rootDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('daqexp-'))
      .map(e => e.name)
      .sort()
    for (const old of siblings.slice(0, Math.max(0, siblings.length - RETAIN_EXPORTS))) {
      rmSync(join(rootDir, old), { recursive: true, force: true })
    }
  }
  catch { /* 清理失败不阻断导出 */ }
  const mergedFile = opts.merge ? writeMergedCsv(dir, files, nodeOf) : undefined
  return { exportId, dir, manifest, files, totalRows: exactRows, truncated, mergedFile: mergedFile ?? undefined }
}

/**
 * 工具:daq_export —— 导出绑定数采节点全量原始时序到数据目录(CSV + manifest.json)。
 * 权限边界与 daq_query 一致:只能收窄到自己的绑定(node_ids/line_id 越权即拒)。
 */
export async function toolDaqExport(agentId: string, args: {
  node_ids?: string | string[]
  line_id?: string
  from_ms?: number | string
  to_ms?: number | string
  last_minutes?: number | string
  title?: string
  note?: string
  /** merge 模式:额外产出多节点按秒对齐的宽表 merged.csv(IDD 等 CSV 分析服务可直接消费) */
  merge?: boolean | string
}): Promise<{ text: string, isError?: boolean }> {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId).filter(b => b.kind === 'daq')
  if (bindings.length === 0) {
    return { text: '你尚未绑定任何数采节点,无权导出采集数据。请在数字孪生界面绑定数采节点。', isError: true }
  }
  const allowed = new Set(bindings.map(b => b.nodeId))
  // 目标解析:node_ids(可多个)> line_id 过滤 > 全部绑定
  let targets = bindings.map(b => b.nodeId)
  const wantedRaw = args.node_ids
  if (wantedRaw != null && String(wantedRaw).trim() !== '') {
    const wanted = (Array.isArray(wantedRaw) ? wantedRaw : String(wantedRaw).split(/[,\s;]+/))
      .map(s => s.trim()).filter(Boolean)
    if (wanted.length > 0) {
      const illegal = wanted.filter(id => !allowed.has(id))
      if (illegal.length > 0) {
        return { text: `无权导出节点:${illegal.join(', ')}。你有权访问的数采节点:${[...allowed].join(', ')}。`, isError: true }
      }
      targets = wanted
    }
  }
  const lineFilter = String(args.line_id ?? '').trim()
  if (lineFilter) {
    const onLine = targets.filter(id => getDaqNodeRepo().byId(id)?.lineId === lineFilter)
    if (onLine.length === 0) {
      return { text: `你绑定的数采节点中没有归属产线 ${lineFilter} 的,无法导出。`, isError: true }
    }
    targets = onLine
  }
  targets = [...new Set(targets)].filter(id => getDaqNodeRepo().byId(id))

  // 时间窗:from/to 优先,否则 last_minutes(缺省 60);护栏 ≤7 天
  const toMs = Number(args.to_ms) > 0 ? Number(args.to_ms) : Date.now()
  const fromMs = Number(args.from_ms) > 0
    ? Number(args.from_ms)
    : toMs - (Number(args.last_minutes) > 0 ? Number(args.last_minutes) : 60) * 60_000
  if (fromMs >= toMs) return { text: 'from_ms 必须小于 to_ms。', isError: true }
  if (toMs - fromMs > MAX_WINDOW_MS) {
    return { text: `时间窗超限(最大 7 天):请缩小窗口(当前 ${(Math.round((toMs - fromMs) / 3600_000) / 10).toFixed(1)} 小时)。`, isError: true }
  }

  // 节点元数据(语义 = 节点级备注 > 模板语义)与产线上下文(产线/产品/配方/批次/监控窗)
  const nodeOf = (id: string): ExportNodeMeta | undefined => {
    const n = getDaqNodeRepo().byId(id)
    if (!n) return undefined
    const tpl = findDaqTemplate(n.templateKey)
    return {
      id: n.id,
      name: n.name,
      unit: n.unit,
      lineId: n.lineId ?? '',
      min: n.min,
      max: n.max,
      warnLow: n.warnLow,
      warnHigh: n.warnHigh,
      intervalMs: n.intervalMs ?? null,
      decimals: n.decimals,
      semantics: n.semantics || tpl?.semantics || tpl?.ch || '',
      signalKind: tpl?.signalKind === 'vector' || tpl?.signalKind === 'image' ? tpl.signalKind : 'scalar',
    }
  }
  const lineIds = [...new Set(targets.map(id => getDaqNodeRepo().byId(id)?.lineId ?? '').filter(Boolean))]
  const lines: ExportLineContext[] = []
  for (const lid of lineIds) {
    const line = getDcwLineRepo().byId(lid)
    const run = getActiveLineRun(lid)
    const recipe = run?.recipeId ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
    lines.push({
      lineId: lid,
      lineName: line?.name ?? lid,
      description: (line as { description?: string } | null)?.description ?? '',
      runId: run?.runId,
      productId: run?.productId,
      productName: run?.productName,
      recipeId: recipe?.id,
      recipeName: recipe?.name,
      recipeVersion: recipe?.version,
      daqWindows: (recipe?.daqWindows ?? []).map(w => ({ nodeId: w.nodeId, min: w.min ?? null, max: w.max ?? null })),
    })
  }

  let result: DaqExportResult
  try {
    result = await exportDaqDataset({
      targets,
      nodeOf,
      readPoints: (nodeId, win) => getTsdb().query(nodeId, win),
      fromMs,
      toMs,
      title: args.title ? String(args.title) : '',
      note: args.note ? String(args.note) : '',
      lines,
      rootDir: join(ensureDataDir(), 'daq-exports'),
      merge: args.merge === true || args.merge === 'true',
      // 帧节点(vector/image):元数据经 tsdb.queryFrames,图像原文件经对象存储(frameContent)
      readFrames: (nodeId, win) => getTsdb().queryFrames(nodeId, win),
      readFrameContent: async (nodeId, at) => {
        const { getDaqController } = await import('../../daq/daq-controller')
        return getDaqController().frameContent(nodeId, at, false)
      },
    })
  }
  catch (err) {
    return { text: `导出失败: ${err instanceof Error ? err.message : String(err)}`, isError: true }
  }

  const perNode = result.files.map(f => `${f.nodeId}(${f.rows} 行)`).join(', ')
  // manifest 声明为 Record<string, unknown>(跨进程产物契约);消费侧按写入形状收窄
  const manifestNodes = (result.manifest.nodes ?? []) as Array<{ id: string, kind?: string, frames: number, file?: string, saved?: number }>
  const frameNodes = manifestNodes.filter(n => n.kind === 'vector' || n.kind === 'image')
  const frameNote = frameNodes.length > 0
    ? `\n- 帧节点: ${frameNodes.map(n => `${n.id}[${n.kind}] ${n.frames} 帧${n.kind === 'image' ? `(已存 ${n.saved} 个原文件 → frames/${String(n.id).replace(/[^A-Za-z0-9_-]+/g, '_')}/)` : `(→ ${n.file})`}`).join(', ')}`
    : ''
  const truncNote = result.truncated.length > 0
    ? `\n⚠ 以下节点超出单节点 200 万点上限已截断:${result.truncated.join(', ')}(如需完整数据请拆小时间窗分批导出)`
    : ''
  const mergeNote = result.mergedFile
    ? `\n- merged.csv(merge 模式): ${result.mergedFile} —— 多节点按秒对齐的多参数宽表,可直接作为 IDD sentinel_screen/watch 的 data_path(time_col=time)`
    : ''
  // IDD 交换目录免疫提示:配置了 exchange_dir 时直接给出可用的 data_path 落点,
  // 避免 Agent 把导出目录(平台数据区,在 IDD 沙箱外)当哨兵输入而首试被拒
  const exchangeDir = String(settingOf('plugins.idd-closedloop-bridge.exchange_dir') ?? '').trim()
  const exchangeNote = exchangeDir
    ? `\n- IDD 交换目录已配置: ${exchangeDir} —— 哨兵分析前把${result.mergedFile ? ' merged.csv' : ' 各 nodes/<node_id>.csv'}复制到该目录下,再以 <交换目录>/<文件名> 作为 data_path(平台导出目录在 IDD 允许根外,直接传会被路径沙箱拒绝)。`
    : ''
  return {
    text: `已导出 ${result.files.length} 个标量节点 + ${frameNodes.length} 个帧节点的数据(标量无降采样):
- export_id: ${result.exportId}
- 目录: ${result.dir}
- 文件: manifest.json(节点映射/单位量程/语义描述/产线-产品-配方-批次上下文/报警统计)+ nodes/<node_id>.csv(逐样本时序,列 ts_iso,ts_ms,value,state)${frameNote}${mergeNote}${exchangeNote}
- 明细: ${perNode};共 ${result.totalRows} 行/帧;窗口 ${new Date(fromMs).toISOString()} ~ ${new Date(toMs).toISOString()}${truncNote}

下一步:
1. 深度根因诊断:调用 diag_run(export_id="${result.exportId}", scene=<场景名>, question=<诊断问题>)——会把 manifest 与全部 CSV 上传诊断服务做多文件分析;mode=async 提交即返(缺省),mode=sync 同步等待结果。
2. 哨兵筛查:把${result.mergedFile ? ' merged.csv 或' : ''} nodes/<node_id>.csv 的绝对路径交给 sentinel_baseline/sentinel_screen/sentinel_watch(注意数据须位于 IDD 允许根内${exchangeDir ? ';已配置的交换目录见上方' : ';可在 idd-closedloop-bridge 插件 settings 配置 exchange_dir'})。
3. 图像/向量帧离线分析:frames/ 下图像原文件(PNG)与向量长表 CSV 直接交给 IDD/worker,manifest.nodes 里带各帧节点的语义与 metrics_summary。
4. 交由其他 worker 离线分析:直接把目录绝对路径(${result.dir})交给对方,manifest.json 内含全部映射与语义说明。`,
  }
}
