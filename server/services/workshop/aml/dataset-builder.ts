/**
 * AML 数据集构建器:按隔离三元组 (line, product, recipe) 从 TsdbPort 拉取批次打标数据 →
 * 逐节点清洗(state/量程/Hampel)→ beatMs 网格对齐(桶均值+短缺口插值)→ 按 run 滑窗 →
 * byRun 分层切分 → 归一化(train 统计)→ 快照落盘(spec/manifest/report/arrays + sha256)。
 *
 * 效率纪律:SQL 层不做降采样(需要 state 感知清洗,raw 点量 = 采样间隔×批长,可控);
 * 归一化统计只取 train 切分(防泄漏);快照 sha256 覆盖 spec+数据字节(防篡改)。
 */
/* eslint-disable @stylistic/member-delimiter-style */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { broadcastSceneEvent } from '../scene-events'
import { getTsdb } from '../daq/storage'
import type { TsdbPoint, TsdbPort } from '../daq/storage/tsdb-port'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { amlSettings } from '../settings'
import type { AmlDatasetSpec } from './spec'
import { cleanPoints, alignToGrid } from './clean'
import { summarize, lagCrossCorr, type SeriesSummary, type LagEstimate, type RunProfile } from './stats'
import { getAmlRuntime } from './runtime'
import type { AmlDatasetRow } from './aml.repo'

export interface AmlManifest {
  version: 1 | 2
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
  // ===== manifest v2(新链路;v1 作业读不到这些字段) =====
  dataKind?: 'dynamic' | 'static'
  specHash?: string
  specVersion?: number
  recipeVersion?: number
  variables?: ProcessDatasetExtras['variables']
  artifacts?: { x: string, u: string, y: string, timestamps: string, mask: string, sidecar: string }
  provenance?: {
    lineId: string, productId: string, recipeId: string, recipeVersion: number, runIds: string[]
    recipeContentHash: string, evidenceSource: string, availabilityWatermark: number | null, capturedAt: string
  }
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

/** data/aml 目录现用体积(MB;60s 缓存,防频繁 du)。
 * 排除基础设施目录(.venv/tools/runtime):uv Python 环境一次安装即 ~936MB,若计入配额,
 * 用户数据只剩 ~1.1GB 可用(实测 2026-10-06:venv 占 46%,零用户数据时配额已近半耗尽)。 */
const QUOTA_EXCLUDED_DIRS = new Set(['.venv', 'tools', 'runtime'])
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
      if (dir === root && QUOTA_EXCLUDED_DIRS.has(e)) continue
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

interface PageQuery {
  lineId?: string
  productId?: string
  recipeId?: string
  runId?: string
  fromMs: number
  toMs: number
}

/**
 * 单节点取数(C7):优先逐节点分页接口(游标续读、无总量截断);
 * 后端未实现时退化为单节点 queryTagged(旧语义在 nodeIds 单元素时等价)。
 * 2026-10-29:分页路径**必须携带批次标签**(line/product/recipe/run 等值过滤)——
 * 此前分页只按时间窗取数,Timescale 部署上会把窗口内全部样本当目标批次,
 * 产品/配方隔离退化为时间窗推断(串味隐患);两条路径现在语义等价。
 */
export async function fetchNodeSeries(
  tsdb: Pick<TsdbPort, 'queryTagged' | 'queryTaggedPage'>,
  nodeId: string,
  q: PageQuery,
  pageLimit = 20_000,
): Promise<TsdbPoint[]> {
  if (typeof tsdb.queryTaggedPage === 'function') {
    const out: TsdbPoint[] = []
    let afterTs: number | undefined
    for (;;) {
      const page = await tsdb.queryTaggedPage(nodeId, {
        afterTs, fromMs: q.fromMs, toMs: q.toMs, limit: pageLimit, withState: true,
        lineId: q.lineId, productId: q.productId, recipeId: q.recipeId, runId: q.runId,
      })
      out.push(...page.points)
      if (page.done || page.nextCursor == null) break
      afterTs = page.nextCursor
    }
    return out
  }
  const tagged = await tsdb.queryTagged({
    lineId: q.lineId, productId: q.productId, recipeId: q.recipeId, runId: q.runId,
    nodeIds: [nodeId], fromMs: q.fromMs, toMs: q.toMs, limit: 500_000,
  })
  return tagged.get(nodeId) ?? []
}

// ---------- 主流程 ----------

export interface ProcessDatasetExtras {
  specRef: string
  specVersion: number
  trainerRef: string
  conditionId: string
  recipeVersion: number
  recipeContentHash: string
  evidenceSource: 'simulation' | 'real' | 'unassessed'
  variables: Array<{ id: string, nodeId: string, role: string, unit: string, modelUnit?: string, scale: number, offset: number, delayMs?: number }>
  availabilityWatermark: number | null
  /**
   * 数据谱系核验结果(D18;由 dataset.ts 按 confirmed context segment 逐 run 判定):
   * verified = 每 run 均有已确认且版本/内容 hash 匹配的段;unknown = 无段(不可证伪,保持 0)。
   * 有任一 unknown 或全量非 verified → lineage_verified=0(模型禁优化资格)。
   */
  runLineage?: { verified: string[], unknown: string[], excluded: Array<{ runId: string, reason: string }> }
}

export async function buildDataset(spec: AmlDatasetSpec, by: { id: string, kind: 'user' | 'agent' }, extras?: ProcessDatasetExtras): Promise<BuildDatasetResult> {
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
    // C7/A1:spec 的 fromMs/toMs 真正生效(旧实现只取 run 窗口,规格里的时间窗被忽略)
    const fromMs = Math.max(Date.parse(run.startedAt), spec.fromMs ?? Number.NEGATIVE_INFINITY)
    const toMs = Math.min(Date.parse(run.endedAt as string), spec.toMs ?? Number.POSITIVE_INFINITY)
    let series: Map<string, { at: number, value: number }[]>
    try {
      series = new Map()
      // 逐节点分页:queryTagged 的 limit 是 nodeIds 集合总量,多节点会被单点长序列截断;
      // 这里对每个节点独立翻页(新增接口),后端不支持时退化为单节点 queryTagged。
      for (const n of order) {
        const points = await fetchNodeSeries(tsdb, n.nodeId, {
          lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId, runId: run.id,
          fromMs, toMs,
        })
        const cleaned = cleanPoints(
          points.map(p => ({ at: p.at, value: Number(p.value ?? Number.NaN), state: p.state })),
          { range: ranges.get(n.nodeId), hampelK: spec.cleaning?.hampelK ?? 5 },
        )
        const aligned = alignToGrid(cleaned.values, { beatMs: beat, maxInterpMs: maxInterp })
        series.set(n.nodeId, aligned.grid)
        cleaningReport[n.nodeId] = {
          ...cleaned.counts,
          missingRatio: 0,
        }
      }
    }
    catch (err) {
      runsDropped.push({ runId: run.id, reason: `查询失败:${err instanceof Error ? err.message : String(err)}` })
      continue
    }

    // 公共网格:[max(t0), min(t1)];逐节点最近邻对齐,网格点缺失计 NaN。
    // 全节点查空(如该 run 采样缺失/时序库丢数)时 g0/g1 保持 ±Infinity,
    // 必须按丢弃处理 —— 否则 steps=Infinity 会把网格循环推到 RangeError(500)。
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
    const steps = Number.isFinite(g0) && Number.isFinite(g1) && g1 > g0 ? Math.floor((g1 - g0) / beat) + 1 : 0
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

  interface Win { x: Float32Array, u: Float32Array, y: Float32Array, at: number[], mask: Float32Array }
  // v2 链路:按变量声明把源单位换算到模型单位(训练/求解/有效域统一在模型单位上)。
  // 无 extras(v1 旧链)时恒等变换,字节级行为不变。
  // D23:v2 换算禁止兜底 —— extras 声明了变量但 scale/offset 缺失/非法 → fail-closed(防 train/serve skew)。
  const transformOf = new Map<string, { scale: number, offset: number }>()
  for (const variable of extras?.variables ?? []) {
    const scale = Number(variable.scale)
    const offset = Number(variable.offset)
    if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(offset)) {
      throw new AppError(422, 'UNIT_CONTRACT_INVALID',
        `变量 ${variable.nodeId} 的单位换算非法(scale=${String(variable.scale)},offset=${String(variable.offset)});禁止按 1/0 兜底`)
    }
    transformOf.set(variable.nodeId, { scale, offset })
  }
  const toModel = (nodeId: string | undefined, value: number): number => {
    if (!nodeId) return value
    const t = transformOf.get(nodeId)
    return t ? value * t.scale + t.offset : value
  }
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
          x[i * nAll + j] = toModel(id, v)
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
          u[i * nCtrl + j] = toModel(cid, v)
        }
        for (let j = 0; j < nTgt; j++) {
          const tid = tgtIds[j]
          const v = tid ? m.rows.get(tid)?.[t + i] : undefined
          if (v === undefined || !Number.isFinite(v)) {
            bad = true
            break
          }
          y[i * nTgt + j] = toModel(tid, v)
        }
      }
      if (!bad) {
        // 窗口级时间戳/质量掩码(manifest v2):历史 H + 未来 F 拍;接受窗口的点均为
        // 在 run 网格上有限的观测点(坏点已在 cleanPoints 阶段由 state/量程剔除)。
        const mask = new Float32Array(H + F)
        mask.fill(1)
        out.push({ x, u, y, at: m.at.slice(t - H, t + F), mask })
      }
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
  // 切分块契约(SW2.3/IO 冻结):当前口径 = 每 run 1 块(块界 = run 界,无内部 purge);
  // 单长 run 时间块切分在该契约上扩展,消费方(dataset-reader/trainer/互校)只认 blocks 元数据
  const blocksOf = (rids: string[], part: 'train' | 'val' | 'test') => rids.map(rid => ({
    blockId: `${rid}#0`, runId: rid, split: part, purgeBeforeSteps: 0, purgeAfterSteps: 0,
    uniqueSteps: winsByRun.get(rid)?.length ?? 0,
  }))
  ;(split as Record<string, unknown>).blocks = [
    ...blocksOf(split.trainRunIds, 'train'),
    ...blocksOf(split.valRunIds, 'val'),
    ...blocksOf(split.testRunIds, 'test'),
  ]

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

  // manifest v2(G2.9):仅新链路写;v1 保持原文件与 hash 算法不变。
  if (extras) {
    const all = [...bucketsPart.train, ...bucketsPart.val, ...bucketsPart.test]
    const perWindow = H + F
    const tsBuf = new Float64Array(all.length * perWindow)
    const maskBuf = new Float32Array(all.length * perWindow)
    all.forEach((w, idx) => {
      const base = idx * perWindow
      for (let i = 0; i < perWindow; i++) tsBuf[base + i] = w.at[i] ?? 0
      maskBuf.set(w.mask, base)
    })
    writeFileSync(join(dir, 'arrays', 'timestamps.f64'), Buffer.from(tsBuf.buffer))
    writeFileSync(join(dir, 'arrays', 'mask.f32'), f32Bytes(maskBuf))
    const sidecar = {
      delays: Object.fromEntries(extras.variables.map(v => [v.id, v.delayMs ?? 0])),
      units: extras.variables.map(v => ({ id: v.id, unit: v.unit, modelUnit: v.modelUnit ?? v.unit, scale: v.scale, offset: v.offset })),
      variableOrder: extras.variables.map(v => v.id),
      trainerRef: extras.trainerRef,
      conditionId: extras.conditionId,
      recipeContentHash: extras.recipeContentHash,
      evidenceSource: extras.evidenceSource,
      availabilityWatermark: extras.availabilityWatermark,
      splitRunIds: { train: split.trainRunIds, val: split.valRunIds, test: split.testRunIds },
    }
    writeFileSync(join(dir, 'arrays', 'sidecar.json'), JSON.stringify(sidecar, null, 2))
    const v2 = {
      ...manifest,
      version: 2,
      dataKind: extras.trainerRef === 'static_response@1' ? 'static' : 'dynamic',
      specHash: extras.specRef,
      specVersion: extras.specVersion,
      recipeVersion: extras.recipeVersion,
      variables: extras.variables,
      artifacts: {
        x: 'arrays/x.f32', u: 'arrays/u.f32', y: 'arrays/y.f32',
        timestamps: 'arrays/timestamps.f64', mask: 'arrays/mask.f32', sidecar: 'arrays/sidecar.json',
      },
      provenance: {
        lineId: spec.lineId, productId: spec.productId, recipeId: spec.recipeId,
        recipeVersion: extras.recipeVersion, runIds: [...runMatrices.keys()],
        recipeContentHash: extras.recipeContentHash, evidenceSource: extras.evidenceSource,
        availabilityWatermark: extras.availabilityWatermark, capturedAt: new Date().toISOString(),
        lineageVerified: extras.runLineage && extras.runLineage.unknown.length === 0 && extras.runLineage.excluded.length === 0 && extras.runLineage.verified.length > 0 ? 1 : 0,
        runLineage: extras.runLineage,
      },
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(v2, null, 2))
  }
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
    specRef: extras?.specRef ?? '',
    specVersion: extras?.specVersion ?? null,
    lineageVerified: extras?.runLineage
      ? (extras.runLineage.unknown.length === 0 && extras.runLineage.excluded.length === 0 && extras.runLineage.verified.length > 0 ? 1 : 0)
      : 0,
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

/** 数据集快照内容摘要:specJson + manifest + 三个数组逐字节流式哈希
 *  v2:额外覆盖 timestamps/mask/sidecar(A12:篡改 sidecar 必须使 hash 失败);
 *  v1 的文件清单与算法保持不变(旧 hash 兼容)。 */
export function hashDatasetDir(dir: string, specJson: string): string {
  const hash = createHash('sha256')
  hash.update(specJson)
  const files = ['manifest.json', 'arrays/x.f32', 'arrays/u.f32', 'arrays/y.f32']
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: number, artifacts?: Record<string, string> }
    if (manifest.version === 2 && manifest.artifacts) {
      for (const f of Object.values(manifest.artifacts)) if (!files.includes(f)) files.push(f)
    }
  }
  catch { /* manifest 缺失/不合法:由后续 readFileSync 抛错 */ }
  for (const f of files) {
    hash.update(f)
    const buf = readFileSync(join(dir, f))
    hash.update(buf)
  }
  return hash.digest('hex')
}
