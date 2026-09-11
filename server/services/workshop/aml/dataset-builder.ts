/**
 * AML 数据集构建器:按隔离三元组 (line, product, recipe) 从 TsdbPort 拉取批次打标数据 →
 * 逐节点清洗(state/量程/Hampel)→ beatMs 网格对齐(桶均值+短缺口插值)→ 按 run 滑窗 →
 * byRun 分层切分 → 归一化(train 统计)→ 快照落盘(spec/manifest/report/arrays + sha256)。
 *
 * 效率纪律:SQL 层不做降采样(需要 state 感知清洗,raw 点量 = 采样间隔×批长,可控);
 * 归一化统计只取 train 切分(防泄漏);快照 sha256 覆盖 spec+数据字节(防篡改)。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { broadcastSceneEvent } from '../scene-events'
import { getTsdb } from '../daq/storage'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { amlSettings } from '../settings'
import type { AmlDatasetSpec } from './spec'
import { cleanPoints, alignToGrid, type RawPoint } from './clean'
import { summarize, lagCrossCorr, type SeriesSummary, type LagEstimate, type RunProfile } from './stats'
import { getAmlRuntime } from './runtime'
import type { AmlDatasetRow } from './aml.repo'

export interface AmlManifest {
  version: 1
  spec: AmlDatasetSpec
  /** 节点顺序(= spec.nodes 顺序;x 历史/归一化按此序) */
  allNodes: string[]
  controlNodes: string[]
  targetNodes: string[]
  featureNodes: string[]
  shapes: { x: [number, number, number], u: [number, number, number], y: [number, number, number] }
  /** 连续存储切分段:[trainN, valN, testN];x.f32 = train|val|test 顺序拼接 */
  split: { train: number, val: number, test: number, trainRunIds: string[], valRunIds: string[], testRunIds: string[] }
  /** train 切分逐列统计(顺序 = 对应张量最后一维) */
  norm: {
    x: { mean: number[], std: number[] }
    u: { mean: number[], std: number[] }
    y: { mean: number[], std: number[] }
  }
  beatMs: number
}

export interface AmlDatasetReport {
  builtAt: string
  nodeSummaries: SeriesSummary[]
  lagEstimates: LagEstimate[]
  runProfiles: RunProfile[]
  cleaning: Record<string, { total: number, droppedState: number, droppedRange: number, droppedHampel: number, interpolated: number, missingRatio: number }>
  runsUsed: string[]
  runsDropped: { runId: string, reason: string }[]
  windowCount: { train: number, val: number, test: number }
}

export interface BuildDatasetResult {
  dataset: AmlDatasetRow
  report: AmlDatasetReport
}

// ---------- 工具 ----------

/** data/aml 目录现用体积(MB;60s 缓存,防频繁 du) */
let duCache: { at: number, mb: number } | null = null
export function amlDiskUsageMb(root: string, opts: { force?: boolean } = {}): number {
  if (!opts.force && duCache && Date.now() - duCache.at < 60_000) return duCache.mb
  let total = 0
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    }
    catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) continue
      if (st.isDirectory()) walk(p)
      else total += st.size
    }
  }
  try {
    walk(root)
  }
  catch { /* 目录不存在 = 0 */ }
  duCache = { at: Date.now(), mb: total / 1024 / 1024 }
  return duCache.mb
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function f32Bytes(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function meanStd(cols: number[][]): { mean: number[], std: number[] } {
  const mean = cols.map(c => (c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0))
  const std = cols.map((c, i) => {
    if (c.length < 2) return 1
    const m = mean[i] ?? 0
    const v = c.reduce((a, b) => a + (b - m) * (b - m), 0) / (c.length - 1)
    // 近常量特征(如训练期 SP 恒定)std 兜底 1.0(恒等缩放):1e-8 级兜底会让
    // 测试期偏离均值数百的输入爆炸成 1e9 级,模型输出天文数字(实测教训)
    return Math.sqrt(v) < 1.0 ? 1.0 : Math.sqrt(v)
  })
  return { mean, std }
}

// ---------- 主流程 ----------

export async function buildDataset(spec: AmlDatasetSpec, by: { id: string, kind: 'user' | 'agent' }): Promise<BuildDatasetResult> {
  const rt = getAmlRuntime()
  const settings = amlSettings()

  // 0. 磁盘配额护栏
  const usedMb = amlDiskUsageMb(rt.root)
  if (usedMb > settings.job.diskQuotaMb) {
    throw new AppError(429, 'AML_DISK_QUOTA', `AML 磁盘配额已用 ${usedMb.toFixed(0)}MB(上限 ${settings.job.diskQuotaMb}MB),请清理旧数据集/作业后重试`)
  }

  // 1. 批次解析:缺省 = 该配方全部已完结批次
  const allRuns = getDcwRecipeRepo().listRuns().filter(r => r.recipeId === spec.recipeId && !!r.endedAt)
  const runs = spec.runIds?.length
    ? allRuns.filter(r => spec.runIds!.includes(r.id))
    : allRuns
  if (runs.length === 0) {
    throw new AppError(422, 'AML_NO_RUNS', '该配方没有已完结的批次(run):先在产线开一批并跑完,或检查 recipeId')
  }
  for (const r of runs) {
    if (r.lineId !== spec.lineId || r.productId !== spec.productId) {
      throw new AppError(422, 'AML_RUN_MISMATCH', `批次 ${r.id} 归属 (${r.lineId}/${r.productId}) 与规格 (${spec.lineId}/${spec.productId}) 不一致`)
    }
  }

  // 2. 节点校验:存在 + 产线一致 + 量程解析(跨产线即拒绝,数据隔离硬约束)
  const nodeRepo = getDaqNodeRepo()
  const ranges = new Map<string, { min: number, max: number } | undefined>()
  for (const n of spec.nodes) {
    const node = nodeRepo.byId(n.nodeId)
    if (!node) throw new AppError(404, 'AML_NODE_MISSING', `数采节点 ${n.nodeId} 不存在`)
    if (node.lineId !== spec.lineId) {
      throw new AppError(403, 'AML_NODE_LINE_MISMATCH', `节点 ${n.nodeId} 属于产线 ${node.lineId},与规格产线 ${spec.lineId} 不一致(防跨产线取数)`)
    }
    const tpl = node.templateRef ? findDaqTemplate(node.templateRef) : undefined
    const min = node.min ?? tpl?.min
    const max = node.max ?? tpl?.max
    ranges.set(n.nodeId, min !== undefined && max !== undefined ? { min, max } : undefined)
  }

  // 3. 逐 run 拉数 + 清洗 + 对齐到公共网格
  const order = spec.nodes
  const beat = spec.beatMs
  const maxInterp = spec.cleaning?.maxInterpMs ?? beat * 3
  const maxDrop = spec.cleaning?.maxDropRatio ?? 0.3
  const tsdb = getTsdb()
  const cleaningReport: AmlDatasetReport['cleaning'] = {}
  const runProfiles: RunProfile[] = []
  const runsDropped: { runId: string, reason: string }[] = []
  const runMatrices = new Map<string, { at: number[], rows: Map<string, number[]> }>()

  for (const run of runs) {
    const fromMs = Date.parse(run.startedAt)
    const toMs = Date.parse(run.endedAt as string)
    let series: Map<string, { at: number, value: number }[]>
    try {
      const tagged = await tsdb.queryTagged({
        lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId, runId: run.id,
        nodeIds: order.map(n => n.nodeId), fromMs, toMs,
      })
      series = new Map()
      for (const [nodeId, points] of tagged) {
        const role = order.find(n => n.nodeId === nodeId)?.role ?? 'feature'
        const cleaned = cleanPoints(points as RawPoint[], { range: ranges.get(nodeId), hampelK: spec.cleaning?.hampelK ?? 5 })
        const aligned = alignToGrid(cleaned.values, { beatMs: beat, maxInterpMs: maxInterp })
        series.set(nodeId, aligned.grid)
        cleaningReport[nodeId] = {
          ...cleaned.counts,
          missingRatio: 0,
        }
        void role
      }
    }
    catch (err) {
      runsDropped.push({ runId: run.id, reason: `查询失败:${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    // 公共网格:[max(t0), min(t1)];逐节点最近邻对齐,网格点缺失计 NaN
    let g0 = -Infinity
    let g1 = Infinity
    for (const n of order) {
      const s = series.get(n.nodeId)
      if (!s || s.length === 0) continue
      const first = s[0]
      const last = s[s.length - 1]
      if (!first || !last) continue
      g0 = Math.max(g0, first.at)
      g1 = Math.min(g1, last.at)
    }
    const steps = g1 > g0 ? Math.floor((g1 - g0) / beat) + 1 : 0
    if (steps < spec.window.historySteps + spec.window.horizonSteps + 2) {
      runsDropped.push({ runId: run.id, reason: `有效网格 ${steps} 步不足一个窗口` })
      continue
    }
    const rows = new Map<string, number[]>()
    let missingTotal = 0
    for (const n of order) {
      const s = series.get(n.nodeId) ?? []
      const byTime = new Map(s.map(p => [p.at, p.value]))
      const col: number[] = []
      let miss = 0
      for (let i = 0; i < steps; i++) {
        const t = g0 + i * beat
        const v = byTime.get(t)
        if (v === undefined) {
          col.push(Number.NaN)
          miss++
        }
        else col.push(v)
      }
      missingTotal += miss
      rows.set(n.nodeId, col)
      const cr = cleaningReport[n.nodeId]
      if (cr) cr.missingRatio = steps ? miss / steps : 1
    }
    const missRatio = steps * order.length ? missingTotal / (steps * order.length) : 1
    if (missRatio > maxDrop) {
      runsDropped.push({ runId: run.id, reason: `网格缺失率 ${(missRatio * 100).toFixed(1)}% 超过上限 ${(maxDrop * 100).toFixed(0)}%` })
      continue
    }
    const targetCols = order.filter(n => n.role === 'target').map(n => n.nodeId)
    runProfiles.push({
      runId: run.id,
      steps,
      targetMeans: Object.fromEntries(targetCols.map((id) => {
        const c = rows.get(id)!.filter(Number.isFinite)
        return [id, c.length ? c.reduce((a, b) => a + b, 0) / c.length : 0]
      })),
    })
    runMatrices.set(run.id, { at: Array.from({ length: steps }, (_, i) => g0 + i * beat), rows })
  }
  if (runMatrices.size === 0) {
    throw new AppError(422, 'AML_NO_USABLE_RUNS', `没有可用的批次(共 ${runs.length} 个候选,全部被丢弃):${runsDropped.map(d => `${d.runId.slice(0, 8)}(${d.reason})`).join('; ')}`)
  }

  // 4. 滑窗(窗口不跨 run)+ byRun 切分
  const H = spec.window.historySteps
  const F = spec.window.horizonSteps
  const allIds = order.map(n => n.nodeId)
  const ctrlIds = order.filter(n => n.role === 'control').map(n => n.nodeId)
  const tgtIds = order.filter(n => n.role === 'target').map(n => n.nodeId)
  const nAll = allIds.length
  const nCtrl = Math.max(1, ctrlIds.length)
  const nTgt = tgtIds.length

  interface Win { x: Float32Array, u: Float32Array, y: Float32Array }
  const winsByRun = new Map<string, Win[]>()
  let winTotal = 0
  for (const [runId, m] of runMatrices) {
    const T = m.at.length
    const out: Win[] = []
    for (let t = H; t + F <= T; t++) {
      const x = new Float32Array(H * nAll)
      const u = new Float32Array(F * nCtrl)
      const y = new Float32Array(F * nTgt)
      let bad = false
      for (let i = 0; i < H && !bad; i++) {
        for (let j = 0; j < nAll; j++) {
          const id = allIds[j]
          const v = id ? m.rows.get(id)?.[t - H + i] : undefined
          if (v === undefined || !Number.isFinite(v)) {
            bad = true
            break
          }
          x[i * nAll + j] = v
        }
      }
      for (let i = 0; i < F && !bad; i++) {
        for (let j = 0; j < nCtrl; j++) {
          const cid = ctrlIds[j]
          const col = cid ? m.rows.get(cid) : undefined
          // 无 control 节点时占 0 维
          if (!col) {
            u[i * nCtrl + j] = 0
            continue
          }
          const v = col[t + i]
          if (v === undefined || !Number.isFinite(v)) {
            bad = true
            break
          }
          u[i * nCtrl + j] = v
        }
        for (let j = 0; j < nTgt; j++) {
          const tid = tgtIds[j]
          const v = tid ? m.rows.get(tid)?.[t + i] : undefined
          if (v === undefined || !Number.isFinite(v)) {
            bad = true
            break
          }
          y[i * nTgt + j] = v
        }
      }
      if (!bad) out.push({ x, u, y })
    }
    if (out.length > 0) winsByRun.set(runId, out)
    winTotal += out.length
  }
  if (winTotal > settings.dataset.maxRows) {
    throw new AppError(422, 'AML_DATASET_TOO_LARGE', `滑窗样本 ${winTotal} 超过上限 ${settings.dataset.maxRows}:建议加大 beatMs 或缩短时间窗`)
  }

  // byRun 分层切分(seeded 洗牌;test/val 按 run 数比例,train 保底)
  const runIds = [...winsByRun.keys()]
  const rnd = mulberry32(spec.split.seed)
  for (let i = runIds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const a = runIds[i]
    const b = runIds[j]
    if (a === undefined || b === undefined) continue
    ;[runIds[i], runIds[j]] = [b, a]
  }
  // 切分配额:ratio>0 时至少 1 个 run(防 3 批次×0.33 取整为 0 → test 切分为空);train 保底
  const nTest = spec.split.testRatio > 0
    ? Math.min(Math.max(1, Math.round(runIds.length * spec.split.testRatio)), Math.max(0, runIds.length - 1))
    : 0
  const nVal = spec.split.valRatio > 0
    ? Math.min(Math.max(1, Math.round(runIds.length * spec.split.valRatio)), Math.max(0, runIds.length - 1 - nTest))
    : 0
  const split = {
    train: 0, val: 0, test: 0,
    trainRunIds: runIds.slice(nTest + nVal),
    valRunIds: runIds.slice(nTest, nTest + nVal),
    testRunIds: runIds.slice(0, nTest),
  }
  const bucketsPart: Record<'train' | 'val' | 'test', Win[]> = { train: [], val: [], test: [] }
  for (const rid of split.testRunIds) bucketsPart.test.push(...winsByRun.get(rid)!)
  for (const rid of split.valRunIds) bucketsPart.val.push(...winsByRun.get(rid)!)
  for (const rid of split.trainRunIds) bucketsPart.train.push(...winsByRun.get(rid)!)
  split.train = bucketsPart.train.length
  split.val = bucketsPart.val.length
  split.test = bucketsPart.test.length

  // 5. 归一化统计(train only)→ 应用
  const statCols = (wins: Win[], pick: (w: Win, i: number, j: number) => number, dim: number): { mean: number[], std: number[] } => {
    const cols: number[][] = Array.from({ length: dim }, () => [])
    for (const w of wins) for (let i = 0; i < (dim === nAll ? H : F); i++) for (let j = 0; j < dim; j++) cols[j]?.push(pick(w, i, j))
    return meanStd(cols)
  }
  const normX = statCols(bucketsPart.train, (w, i, j) => w.x[i * nAll + j] ?? 0, nAll)
  const normU = statCols(bucketsPart.train, (w, i, j) => w.u[i * nCtrl + j] ?? 0, nCtrl)
  const normY = statCols(bucketsPart.train, (w, i, j) => w.y[i * nTgt + j] ?? 0, nTgt)
  for (const part of [bucketsPart.train, bucketsPart.val, bucketsPart.test]) {
    for (const w of part) {
      for (let k = 0; k < w.x.length; k++) w.x[k] = ((w.x[k] ?? 0) - (normX.mean[k % nAll] ?? 0)) / (normX.std[k % nAll] ?? 1)
      for (let k = 0; k < w.u.length; k++) w.u[k] = ((w.u[k] ?? 0) - (normU.mean[k % nCtrl] ?? 0)) / (normU.std[k % nCtrl] ?? 1)
      for (let k = 0; k < w.y.length; k++) w.y[k] = ((w.y[k] ?? 0) - (normY.mean[k % nTgt] ?? 0)) / (normY.std[k % nTgt] ?? 1)
    }
  }

  // 6. 落盘快照
  const dsId = `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dir = join(rt.datasetsDir, dsId)
  mkdirSync(join(dir, 'arrays'), { recursive: true })
  const writeSplitArray = (name: string, parts: Win[], pick: (w: Win) => Float32Array): number => {
    const total = parts.reduce((a, w) => a + pick(w).length, 0)
    const buf = new Float32Array(total)
    let off = 0
    for (const w of parts) {
      buf.set(pick(w), off)
      off += pick(w).length
    }
    writeFileSync(join(dir, 'arrays', name), f32Bytes(buf))
    return parts.length
  }
  writeSplitArray('x.f32', [...bucketsPart.train, ...bucketsPart.val, ...bucketsPart.test], w => w.x)
  writeSplitArray('u.f32', [...bucketsPart.train, ...bucketsPart.val, ...bucketsPart.test], w => w.u)
  writeSplitArray('y.f32', [...bucketsPart.train, ...bucketsPart.val, ...bucketsPart.test], w => w.y)

  const manifest: AmlManifest = {
    version: 1,
    spec,
    allNodes: allIds,
    controlNodes: ctrlIds,
    targetNodes: tgtIds,
    featureNodes: order.filter(n => n.role === 'feature').map(n => n.nodeId),
    shapes: {
      x: [split.train + split.val + split.test, H, nAll],
      u: [split.train + split.val + split.test, F, nCtrl],
      y: [split.train + split.val + split.test, F, nTgt],
    },
    split,
    norm: { x: normX, u: normU, y: normY },
    beatMs: beat,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  // spec.json:取数规格随实体落盘。元数据行里本来就有 spec_json,但那是**索引**;
  // 把规格同时写进实体目录,./aml 才是自描述、可整体拷贝的资产 ——
  // 拷到另一台机器(或 sqlite 丢了)时,仅凭 datasets/<id>/ 仍能还原"这份数据是怎么取的"。
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2))

  // 7. 统计报告(基于 train 网格序列)
  const nodeSummaries: SeriesSummary[] = []
  for (const n of order) {
    const col = bucketsPart.train.flatMap(() => [] as number[]) // 占位:直接取原始网格统计更准确
    void col
    const runId = split.trainRunIds[0]
    const gridCol = runId ? (runMatrices.get(runId)?.rows.get(n.nodeId) ?? []) : []
    const vals = gridCol.filter(Number.isFinite)
    const cr = cleaningReport[n.nodeId]
    nodeSummaries.push(summarize(
      n.nodeId, n.role, vals,
      cr ? cr.missingRatio : 0,
      cr ? (cr.droppedState + cr.droppedRange + cr.droppedHampel) / Math.max(1, cr.total) : 0,
    ))
  }
  const lagEstimates: LagEstimate[] = []
  const firstTrainRun = split.trainRunIds[0] ? runMatrices.get(split.trainRunIds[0]) : undefined
  if (firstTrainRun) {
    for (const c of ctrlIds) {
      for (const t of tgtIds) {
        const est = lagCrossCorr(firstTrainRun.rows.get(c) ?? [], firstTrainRun.rows.get(t) ?? [], 20)
        lagEstimates.push({ controlId: c, targetId: t, lagSteps: est.lagSteps, corr: Number(est.corr.toFixed(3)) })
      }
    }
  }
  const report: AmlDatasetReport = {
    builtAt: new Date().toISOString(),
    nodeSummaries,
    lagEstimates,
    runProfiles: runProfiles.filter(rp => split.trainRunIds.includes(rp.runId) || split.valRunIds.includes(rp.runId) || split.testRunIds.includes(rp.runId)),
    cleaning: cleaningReport,
    runsUsed: [...runMatrices.keys()],
    runsDropped,
    windowCount: { train: split.train, val: split.val, test: split.test },
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2))

  // 8. sha256(spec + manifest + 数组字节内容)(防同尺寸篡改)
  const sha256 = hashDatasetDir(dir, JSON.stringify(spec))

  const now = new Date().toISOString()
  const firstAt = runMatrices.size ? Math.min(...[...runMatrices.values()].map(m => m.at[0] ?? 0)) : null
  const lastAt = runMatrices.size ? Math.max(...[...runMatrices.values()].map(m => m.at[m.at.length - 1] ?? 0)) : null
  const row: AmlDatasetRow = {
    id: dsId,
    lineId: spec.lineId,
    productId: spec.productId,
    recipeId: spec.recipeId,
    runIds: [...runMatrices.keys()],
    specJson: JSON.stringify(spec),
    sha256,
    rowCount: winTotal,
    fromMs: firstAt,
    toMs: lastAt,
    path: dir,
    createdBy: by.id,
    createdByKind: by.kind,
    note: spec.note ?? '',
    createdAt: now,
  }
  rt.repo.dataset.insert(row)
  // WS:数据集构建实时帧(带 lineId 享逐 peer 过滤)
  broadcastSceneEvent('aml.dataset', {
    op: 'built', datasetId: dsId, lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId,
    rowCount: row.rowCount, runs: row.runIds.length, createdBy: by.id, createdByKind: by.kind,
  })
  return { dataset: row, report }
}

/** 数据集行 → 解析后的 manifest(report.json 惰性读) */
export function loadManifest(dataset: AmlDatasetRow): AmlManifest {
  return JSON.parse(readFileSync(join(dataset.path, 'manifest.json'), 'utf8')) as AmlManifest
}

/** 数据集快照内容摘要:specJson + manifest + 三个数组逐字节流式哈希 */
export function hashDatasetDir(dir: string, specJson: string): string {
  const hash = createHash('sha256')
  hash.update(specJson)
  for (const f of ['manifest.json', 'arrays/x.f32', 'arrays/u.f32', 'arrays/y.f32']) {
    hash.update(f)
    const buf = readFileSync(join(dir, f))
    hash.update(buf)
  }
  return hash.digest('hex')
}
