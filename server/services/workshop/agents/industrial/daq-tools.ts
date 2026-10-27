/**
 * 数采查询与帧检索(daq_query / daq_frames)
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import { daqRuntimeSettings } from '../../settings'
import { findDaqTemplate } from '../../daq/daq-templates'
import { getActiveLineRun } from '../../dcw/line-run'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { channelBoundLineId } from './ops-tools'
import { queryLatest, queryTaggedLatest } from '../../daq/storage/latest-window'

/**
 * 数采目标集解析(工具共用鉴权面):
 *   ① Agent 绑定(kind=daq);② v28 频道绑线只读扩权 —— 频道绑定产线下的数采节点
 *   并入读取集(与 ops_log/line_context 的绑线只读扩权同族;本函数仅服务只读查询面)。
 * node_id/line_id 只能缩小范围,不能放大(越权节点一律拒绝)。
 */
export function daqTargetsOf(agentId: string, nodeIdArg: unknown, lineIdArg: unknown):
  { targets: string[], daqBindings: ReturnType<ReturnType<typeof getAgentNodeBindingRepo>['byAgent']> }
  | { error: { text: string, isError: true } } {
  const repo = getAgentNodeBindingRepo()
  const daqBindings = repo.byAgent(agentId).filter(b => b.kind === 'daq')
  // v28:频道绑线的数采节点并入可见集(只读)
  const boundLine = channelBoundLineId(agentId)
  const boundLineNodes = boundLine
    ? getDaqNodeRepo().all().filter(n => n.lineId === boundLine).map(n => n.id)
    : []
  const readable = new Set([...daqBindings.map(b => b.nodeId), ...boundLineNodes])
  if (readable.size === 0) {
    return { error: { text: '你尚未绑定任何数采节点,频道也未绑定产线,无权查询采集数据。请在数字孪生界面绑定数采节点,或将频道绑定到目标产线(绑线后可只读查询该线数采数据)。', isError: true } }
  }
  const wanted = nodeIdArg ? String(nodeIdArg) : ''
  if (wanted && !readable.has(wanted)) {
    return { error: { text: `无权查询节点 ${wanted}。你有权访问的数采节点:${[...readable].join(', ')}`, isError: true } }
  }
  const lineFilter = lineIdArg ? String(lineIdArg).trim() : ''
  const lineOf = (id: string): string => getDaqNodeRepo().byId(id)?.lineId ?? ''
  if (lineFilter && wanted && lineOf(wanted) !== lineFilter) {
    return { error: { text: `节点 ${wanted} 不属于产线 ${lineFilter}(实际归属:${lineOf(wanted) || '未分配'}),line_id 与 node_id 过滤冲突。`, isError: true } }
  }
  let targets = wanted ? [wanted] : [...readable]
  if (lineFilter && !wanted) {
    const onLine = targets.filter(id => lineOf(id) === lineFilter)
    if (onLine.length === 0) {
      return { error: { text: `你有权访问的数采节点中没有归属产线 ${lineFilter} 的(各节点归属:${[...readable].map(id => `${id}=${lineOf(id) || '未分配'}`).join('; ')})。`, isError: true } }
    }
    targets = onLine
  }
  return { targets, daqBindings }
}

/**
 * 工具:daq_query —— 数采数据检索(产线/产品/配方/批次/时间/节点;结果带物理语义)
 *
 * **默认作用域 = 当前活动批次**:调用方未显式给 `product_id`/`recipe_id`/`run_id`,
 * 且该节点所属产线有活动批次(LineRun)时,自动按活动 `recipe_id` 过滤,并在结果头
 * 打印 `批次 run/配方`。理由:样本在入库时逐条打标当轮配方,不默认识别"当前跑什么",
 * Agent 很容易把上一轮配方的样本混进本轮判读(实测:不传过滤 10 点/均值 246.99,
 * 只取当前配方 3 点/均值 247.99,差异足以改变 keep/rollback 结论)。
 * 需要跨配方对比或历史复盘时显式传 `scope: 'all'`(或直接给 product_id/recipe_id/run_id)。
 */
export async function toolDaqQuery(agentId: string, args: {
  node_id?: string
  line_id?: string
  product_id?: string
  recipe_id?: string
  run_id?: string
  scope?: string
  last_minutes?: number | string
  from_ms?: number | string
  to_ms?: number | string
  bucket_ms?: number | string
  limit?: number | string
  agg?: string
}): Promise<{ text: string, isError?: boolean }> {
  const auth = daqTargetsOf(agentId, args.node_id, args.line_id)
  if ('error' in auth) return auth.error
  const { targets } = auth
  const lineFilter = args.line_id ? String(args.line_id).trim() : ''

  // 参数校验:显式传入的非法值必须报错,不能静默回退(否则 Agent 以为按自己的窗口/条数查了)
  const provided = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== ''
  if (provided(args.to_ms) && (!Number.isFinite(Number(args.to_ms)) || Number(args.to_ms) <= 0)) {
    return { text: `to_ms 必须是正的 epoch 毫秒(收到 ${String(args.to_ms)})。`, isError: true }
  }
  if (provided(args.from_ms) && (!Number.isFinite(Number(args.from_ms)) || Number(args.from_ms) <= 0)) {
    return { text: `from_ms 必须是正的 epoch 毫秒(收到 ${String(args.from_ms)})。`, isError: true }
  }
  if (provided(args.last_minutes) && (!Number.isFinite(Number(args.last_minutes)) || Number(args.last_minutes) <= 0)) {
    return { text: `last_minutes 必须大于 0(收到 ${String(args.last_minutes)})。`, isError: true }
  }
  const toMs = provided(args.to_ms) ? Number(args.to_ms) : Date.now()
  const fromMs = provided(args.from_ms)
    ? Number(args.from_ms)
    : toMs - (provided(args.last_minutes) ? Number(args.last_minutes) : 30) * 60_000
  if (fromMs >= toMs) {
    return { text: `时间窗非法:from_ms(${fromMs})必须小于 to_ms(${toMs})。`, isError: true }
  }
  // 聚合口径:avg(缺省)/min/max 作用于降采样桶;最新值始终取库内最后一条原始样本
  const aggRaw = String(args.agg ?? '').trim().toLowerCase()
  if (aggRaw && !['avg', 'min', 'max'].includes(aggRaw)) {
    return { text: `agg 只能是 avg|min|max(收到 ${String(args.agg)})。`, isError: true }
  }
  const agg = (aggRaw || 'avg') as 'avg' | 'min' | 'max'
  // 时间间隔参数(bucket_ms 降采样桶宽):缺省与下限来自 daq.query.*(live 配置,热重载)
  const qCfg = daqRuntimeSettings().query
  if (provided(args.bucket_ms) && (!Number.isFinite(Number(args.bucket_ms)) || Number(args.bucket_ms) < 0)) {
    return { text: `bucket_ms 必须是非负数字(0=使用默认桶宽,收到 ${String(args.bucket_ms)})。`, isError: true }
  }
  const rawBucket = provided(args.bucket_ms) ? Number(args.bucket_ms) : NaN
  const bucketMs = Number.isFinite(rawBucket) && rawBucket > 0
    ? Math.max(qCfg.minBucketMs, Math.min(3_600_000, Math.round(rawBucket)))
    : qCfg.defaultBucketMs
  if (provided(args.limit) && (!Number.isFinite(Number(args.limit)) || Number(args.limit) <= 0)) {
    return { text: `limit 必须是正整数(收到 ${String(args.limit)})。`, isError: true }
  }
  const limit = Math.min(Math.max(Math.round(Number(args.limit)) || 500, 1), 2000)

  // 显式过滤优先级:recipe_id / run_id / product_id(任一给出即完全按调用方口径)
  const explicitProduct = args.product_id ? String(args.product_id) : ''
  const explicitRecipe = args.recipe_id ? String(args.recipe_id) : ''
  const explicitRun = args.run_id ? String(args.run_id) : ''
  const explicitScoped = Boolean(explicitProduct || explicitRecipe || explicitRun)
  /** scope=all:显式要求不过滤(跨配方/历史复盘),仅在无显式 id 时生效 */
  const wantAll = !explicitScoped && String(args.scope ?? '').trim().toLowerCase() === 'all'

  const { getTsdb, tsdbReady } = await import('../../daq/storage')
  await tsdbReady
  const tsdb = getTsdb()
  // 各节点库内最新样本(用于「库内滞后」;查询本身走 tail 取窗口末尾,末元素才是最新)
  let latestMap = new Map<string, { tsMs: number, value: number }>()
  try {
    latestMap = await tsdb.latest()
  }
  catch { /* 新鲜度指标可选,读不到不影响查询 */ }

  const sections: string[] = []
  let okNodes = 0
  let failedNodes = 0
  /** 实际生效的过滤口径(逐节点累计,用于文末 provenance 与表头) */
  const applied: Array<{ nodeId: string, lineId: string, runId?: string, recipeId?: string, source: 'explicit' | 'active-run' | 'none' }> = []
  for (const nodeId of targets) {
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) {
      sections.push(`■ 节点 ${nodeId}:不存在或已删除,无法查询`)
      failedNodes++
      continue
    }
    const tpl = findDaqTemplate(node.templateKey)
    const ch = tpl?.ch ?? node.templateKey
    // 默认口径:该节点所属产线的**活动批次**(未开跑 → 不过滤,保持原有语义)
    const nodeLine = node.lineId || ''
    const activeRun = !explicitScoped && !wantAll && nodeLine ? getActiveLineRun(nodeLine) : null
    const scopeRun = explicitScoped
      ? { runId: explicitRun || undefined, recipeId: explicitRecipe || undefined, productId: explicitProduct || undefined, source: 'explicit' as const }
      : activeRun
        ? { runId: activeRun.runId, recipeId: activeRun.recipeId, productId: activeRun.productId, source: 'active-run' as const }
        : { runId: undefined, recipeId: undefined, productId: undefined, source: 'none' as const }
    applied.push({ nodeId, lineId: nodeLine, runId: scopeRun.runId, recipeId: scopeRun.recipeId, source: scopeRun.source })
    try {
      let points: Array<{ at: number, value?: number, avg?: number, min?: number, max?: number, cnt?: number }>
      // 是否有可用的打标过滤:显式 id、或活动批次(配方/批次 id 齐备)
      const useTagged = Boolean(scopeRun.recipeId || scopeRun.runId || scopeRun.productId)
      if (useTagged) {
        const series = await queryTaggedLatest(tsdb, {
          lineId: nodeLine || undefined,
          productId: scopeRun.productId,
          recipeId: scopeRun.recipeId,
          runId: scopeRun.runId,
          nodeIds: [nodeId],
          fromMs,
          toMs,
          bucketMs,
          limit,
        })
        points = series.get(nodeId) ?? []
      }
      else {
        points = await queryLatest(tsdb, nodeId, { fromMs, toMs, bucketMs, limit })
      }
      const scopeTag = scopeRun.source === 'explicit'
        ? `批次过滤(显式)${scopeRun.runId ? ` run=${scopeRun.runId}` : ''}${scopeRun.recipeId ? ` 配方=${scopeRun.recipeId}` : ''}${scopeRun.productId ? ` 产品=${scopeRun.productId}` : ''}`
        : scopeRun.source === 'active-run'
          ? `当前活动批次 run=${scopeRun.runId ?? ''} 配方「${(scopeRun.recipeId && getDcwController().listRecipes().find(r => r.id === scopeRun.recipeId)?.name) || scopeRun.recipeId}」(${scopeRun.recipeId})(可直接把 run_id/recipe_id 回传给 daq_query 或 aml_dataset_build)`
          : wantAll
            ? '全量窗口(scope=all,不做配方过滤)'
            : '未过滤(该产线当前未开跑 → 无活动批次可限定)'
      const head = `■ ${node.name}(${ch})单位 ${node.unit},正常量程 ${node.min}~${node.max}${node.unit},当前状态 ${node.state},时间窗 ${new Date(fromMs).toISOString().slice(0, 16)} ~ ${new Date(toMs).toISOString().slice(0, 16)}(降采样 ${bucketMs}ms,聚合 ${agg})\n  ${scopeTag}`
      // 工况判读容器(具体判读在 values 计算后追加)
      const readout: string[] = []
      if (points.length === 0) {
        sections.push(`${head}\n  窗口内无数据(产线未运行或过滤条件不匹配;仅产线运行中的样本被持久化打标)`)
        okNodes++
        continue
      }
      // 聚合口径:桶上取 avg/min/max;原始点直接取值
      const pick = (p: { value?: number, avg?: number, min?: number, max?: number }): number => {
        if (agg === 'min') return p.min ?? p.value ?? p.avg ?? Number.NaN
        if (agg === 'max') return p.max ?? p.value ?? p.avg ?? Number.NaN
        return p.value ?? p.avg ?? Number.NaN
      }
      const values = points.map(pick).filter(Number.isFinite)
      if (values.length === 0) {
        sections.push(`${head}\n  窗口内有桶但无可解析数值(数据异常)`)
        failedNodes++
        continue
      }
      // tail 取数保证 points 末元素 = 窗口内最新;最新值取末点(不是全局最新,窗口外不算)
      const latest = values[values.length - 1]!
      const lastAt = points[points.length - 1]!.at
      const dbLatest = latestMap.get(nodeId)
      const dbAgeS = dbLatest == null ? null : Math.max(0, Math.round((Date.now() - dbLatest.tsMs) / 1000))
      // 工况判读:最新值相对活动配方监控窗口/同线数控设定的位置(数据 → 语义)
      const latestRaw = latest
      const rw = node.lineId ? getActiveLineRun(node.lineId) : null
      const recipeR = rw ? getDcwController().listRecipes().find(r => r.id === rw.recipeId) : undefined
      const rwin = recipeR?.daqWindows?.find(w2 => w2.nodeId === nodeId)
      if (rw && rwin) {
        const inWin = (rwin.min == null || latestRaw >= rwin.min) && (rwin.max == null || latestRaw <= rwin.max)
        readout.push(`活动配方「${rw.recipeName}」监控窗口 [${rwin.min ?? '-∞'}, ${rwin.max ?? '+∞'}]:当前 ${latestRaw}${node.unit} ${inWin ? '窗口内(正常)' : '**越限(该节点应已报警)**'}`)
      }
      {
        const dcwAll = getDcwController().listViews().filter(d => d.lineId === node.lineId && d.value != null)
        if (dcwAll.length > 0) {
          readout.push(`同产线数控设定: ${dcwAll.map(d => `${d.name}=${d.value}${d.unit}`).join(';')}(判读时考虑设定↔实际量的耦合与滞后)`)
        }
      }
      const avg = values.reduce((a, b) => a + b, 0) / values.length
      const tail = points.slice(-12).map((p) => {
        const v = pick(p)
        const at = new Date(p.at).toISOString().slice(11, 19)
        if (!bucketMs) return `${at}=${Number(v.toFixed(3))}`
        return `${at}=${agg} ${Number(v.toFixed(2))}${p.cnt != null ? `(n=${p.cnt})` : ''}`
      })
      // 数据面声明:数值来自时序库(daq_samples),最新样本时间/滞后可核验 ——
      // Agent 不必(也不应)假设"刚发生的写入立刻可读",滞后秒数就是它的证据。
      readout.push(`数据源=时序库(库内样本);窗口末样本 ${new Date(lastAt).toISOString().slice(11, 19)}${dbAgeS != null ? `,库内最新 ${new Date(dbLatest!.tsMs).toISOString().slice(11, 19)}(滞后 ${dbAgeS}s)` : ''}`)
      sections.push(
        `${head}\n  样本 ${values.length} 点 | 最新 ${latest}${node.unit} | 均值 ${Number(avg.toFixed(3))} | 最小 ${Math.min(...values)} | 最大 ${Math.max(...values)}\n  最近序列: ${tail.join('; ')}${readout.length > 0 ? `\n  工况判读: ${readout.join(' | ')}` : ''}`,
      )
      okNodes++
    }
    catch (err) {
      sections.push(`■ ${node.name}:查询失败 ${err instanceof Error ? err.message : String(err)}`)
      failedNodes++
    }
  }
  // 文末口径声明:逐节点列出**实际生效**的过滤来源(显式 / 活动批次 / 未过滤),
  // 便于审计"这条结论用的是哪个批次的数据",也避免"以为默认过滤了其实没有"。
  const scopedNodes = applied.filter(a => a.source !== 'none')
  const unscoped = applied.filter(a => a.source === 'none')
  const provLines: string[] = []
  if (lineFilter) provLines.push(`产线 ${lineFilter}`)
  if (explicitProduct) provLines.push(`产品 ${explicitProduct}`)
  if (explicitRecipe) provLines.push(`配方 ${explicitRecipe}`)
  if (explicitRun) provLines.push(`批次 ${explicitRun}`)
  if (explicitScoped) provLines.push('—— 显式过滤值优先,逐样本打标精确切批')
  else if (wantAll) provLines.push('—— scope=all:不做配方过滤,窗口内跨配方样本全部返回')
  else if (scopedNodes.length > 0) {
    const ids = [...new Set(scopedNodes.map(a => `${a.recipeId ?? '-'}${a.runId ? `@${a.runId}` : ''}`))]
    provLines.push(`—— 默认作用域:仅当前活动批次 ${ids.join(', ')}(逐样本打标;跨配方对比请传 scope=all)`)
  }
  if (unscoped.length > 0) {
    provLines.push(`—— 未过滤节点(所在产线未开跑,无活动批次可限定):${unscoped.map(a => a.nodeId).join(', ')};含未开线时段样本(按节点所属产线打标,product/recipe/run 为空)`)
  }
  const prov = provLines.length > 0 ? `\n(过滤条件:${provLines.join(' ')})` : ''
  const head = failedNodes > 0
    ? `数采数据查询结果(${targets.length} 个节点,成功 ${okNodes} / 失败 ${failedNodes}):`
    : `数采数据查询结果(${targets.length} 个节点):`
  return {
    text: `${head}\n\n${sections.join('\n\n')}${prov}\n\n数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。`,
    ...(failedNodes > 0 ? { isError: true } : {}),
  }
}
/** 工具:daq_frames —— 多形态帧检索(v2:测厚/扫描仪多点轮廓与 CCD 图像元数据)。
 *  向量返回点列摘要(≤16 点预览 + 派生指标);图像返回对象引用与内容 URL(像素不入 LLM)。 */
export async function toolDaqFrames(agentId: string, args: {
  node_id?: string
  line_id?: string
  kind?: string
  last_minutes?: number | string
  from_ms?: number | string
  to_ms?: number | string
  limit?: number | string
  include_points?: boolean | string
  point_limit?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  const auth = daqTargetsOf(agentId, args.node_id, args.line_id)
  if ('error' in auth) return auth.error
  const { targets } = auth
  if (args.kind != null && String(args.kind).trim() !== '' && args.kind !== 'vector' && args.kind !== 'image') {
    return { text: `kind 只能是 vector 或 image(收到 ${String(args.kind)})。`, isError: true }
  }
  const kind = args.kind === 'vector' || args.kind === 'image' ? args.kind : undefined
  const provided = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== ''
  if (provided(args.to_ms) && (!Number.isFinite(Number(args.to_ms)) || Number(args.to_ms) <= 0)) {
    return { text: `to_ms 必须是正的 epoch 毫秒(收到 ${String(args.to_ms)})。`, isError: true }
  }
  if (provided(args.from_ms) && (!Number.isFinite(Number(args.from_ms)) || Number(args.from_ms) <= 0)) {
    return { text: `from_ms 必须是正的 epoch 毫秒(收到 ${String(args.from_ms)})。`, isError: true }
  }
  if (provided(args.last_minutes) && (!Number.isFinite(Number(args.last_minutes)) || Number(args.last_minutes) <= 0)) {
    return { text: `last_minutes 必须大于 0(收到 ${String(args.last_minutes)})。`, isError: true }
  }
  const toMs = provided(args.to_ms) ? Number(args.to_ms) : Date.now()
  const fromMs = provided(args.from_ms)
    ? Number(args.from_ms)
    : toMs - (provided(args.last_minutes) ? Number(args.last_minutes) : 30) * 60_000
  if (fromMs >= toMs) {
    return { text: `时间窗非法:from_ms(${fromMs})必须小于 to_ms(${toMs})。`, isError: true }
  }
  if (provided(args.limit) && (!Number.isFinite(Number(args.limit)) || Number(args.limit) <= 0)) {
    return { text: `limit 必须是正整数(收到 ${String(args.limit)})。`, isError: true }
  }
  const limit = Math.min(Math.max(Math.round(Number(args.limit)) || 20, 1), 100)
  const includePoints = args.include_points === true || args.include_points === 'true'
  const pointLimitRaw = Number(args.point_limit)
  const pointLimit = includePoints
    ? Math.min(Math.max(Math.round(Number.isFinite(pointLimitRaw) && pointLimitRaw > 0 ? pointLimitRaw : 128), 1), 1024)
    : 16
  const { getTsdb, tsdbReady } = await import('../../daq/storage')
  await tsdbReady
  const tsdb = getTsdb()

  const sections: string[] = []
  let okNodes = 0
  let failedNodes = 0
  for (const nodeId of targets) {
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) {
      sections.push(`■ 节点 ${nodeId}:不存在或已删除,无法查询`)
      failedNodes++
      continue
    }
    const tpl = findDaqTemplate(node.templateKey)
    const signalKind = tpl?.signalKind ?? 'scalar'
    if (signalKind === 'scalar') {
      sections.push(`■ ${node.name}:单点标量节点(模板 ${node.templateKey}),无帧数据 —— 请用 daq_query 查时序数值。`)
      okNodes++
      continue
    }
    try {
      const frames = await tsdb.queryFrames(nodeId, { fromMs, toMs, kind, limit })
      if (frames.length === 0) {
        sections.push(`■ ${node.name}(${tpl?.ch ?? node.templateKey}):窗口内无帧(产线未运行或过滤条件不匹配;仅产线运行中的帧被持久化)`)
        okNodes++
        continue
      }
      const vmeta = tpl?.vector
      const base = vmeta?.pointIndexBase === 0 ? 0 : 1
      const labelOf = (i: number): string => {
        const labels = vmeta?.labels
        if (Array.isArray(labels) && labels[i]) return labels[i]!
        const prefix = vmeta?.pointLabelPrefix
        return prefix ? `${prefix}${i + base}` : `#${i + base}`
      }
      const layout = vmeta
        ? ` | 单位 ${node.unit};量程 ${vmeta.min}~${vmeta.max}${vmeta.axis ? `;轴 ${vmeta.axis}` : ''};点位 ${vmeta.points} 个(${labelOf(0)}…${labelOf(Math.max(0, vmeta.points - 1))})${vmeta.pointUnit ? `,点单位 ${vmeta.pointUnit}` : ''}`
        : ` | 单位 ${node.unit};量程 ${node.min}~${node.max}`
      const head = `■ ${node.name}(${tpl?.ch ?? node.templateKey})形态 ${signalKind},帧数 ${frames.length},时间窗 ${new Date(fromMs).toISOString().slice(0, 16)} ~ ${new Date(toMs).toISOString().slice(0, 16)}${layout}${tpl?.semantics ? `\n  物理意义: ${tpl.semantics}` : ''}`
      const lines = frames.slice(0, 10).map((f) => {
        const at = new Date(f.at).toISOString().slice(11, 19)
        if (f.kind === 'vector') {
          const pts = f.points ?? []
          const shown = pts.slice(0, pointLimit).map((p, i) => `${labelOf(i)}=${Number(p.toFixed(3))}`).join(',')
          return `  ${at} 轮廓 ${pts.length} 点[${shown}${pts.length > pointLimit ? `,…(另有 ${pts.length - pointLimit} 点,调大 point_limit≤1024 或 daq_export)` : ''}] 指标 {${Object.entries(f.metrics).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(', ')}}`
        }
        const width = f.meta.width ?? '?'
        const height = f.meta.height ?? '?'
        return `  ${at} 图像 ${width}x${height} ${f.meta.mime ?? 'image/png'} 对象=${String(f.meta.objectKey ?? '-').slice(-24)} 指标 {${Object.entries(f.metrics).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ')}}(像素不入上下文;前端画廊可看)`
      })
      sections.push(`${head}\n${lines.join('\n')}${frames.length > 10 ? `\n  (仅展示最近 10 帧)` : ''}`)
      okNodes++
    }
    catch (err) {
      sections.push(`■ ${node.name}:帧查询失败 ${err instanceof Error ? err.message : String(err)}`)
      failedNodes++
    }
  }
  const head = failedNodes > 0
    ? `数采帧查询结果(${targets.length} 个节点,成功 ${okNodes} / 失败 ${failedNodes}):`
    : `数采帧查询结果(${targets.length} 个节点):`
  return {
    text: `${head}\n\n${sections.join('\n\n')}\n\n向量=多点工程量轮廓(完整点列前端可查);图像=像素在对象存储,指标供判读(brightness 过低=曝光不足/遮挡)。`,
    ...(failedNodes > 0 ? { isError: true } : {}),
  }
}
