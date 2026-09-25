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

/**
 * 数采目标集解析(工具共用鉴权面):Agent 绑定(kind=daq)为权限边界 ——
 * node_id/line_id 只能缩小范围,不能放大(越权节点一律拒绝)。
 */
export function daqTargetsOf(agentId: string, nodeIdArg: unknown, lineIdArg: unknown):
  { targets: string[], daqBindings: ReturnType<ReturnType<typeof getAgentNodeBindingRepo>['byAgent']> }
  | { error: { text: string, isError: true } } {
  const repo = getAgentNodeBindingRepo()
  const daqBindings = repo.byAgent(agentId).filter(b => b.kind === 'daq')
  if (daqBindings.length === 0) {
    return { error: { text: '你尚未绑定任何数采节点,无权查询采集数据。请在数字孪生界面绑定数采节点。', isError: true } }
  }
  const wanted = nodeIdArg ? String(nodeIdArg) : ''
  if (wanted && !daqBindings.some(b => b.nodeId === wanted)) {
    return { error: { text: `无权查询节点 ${wanted}。你有权访问的数采节点:${daqBindings.map(b => b.nodeId).join(', ')}`, isError: true } }
  }
  const lineFilter = lineIdArg ? String(lineIdArg).trim() : ''
  const lineOf = (id: string): string => getDaqNodeRepo().byId(id)?.lineId ?? ''
  if (lineFilter && wanted && lineOf(wanted) !== lineFilter) {
    return { error: { text: `节点 ${wanted} 不属于产线 ${lineFilter}(实际归属:${lineOf(wanted) || '未分配'}),line_id 与 node_id 过滤冲突。`, isError: true } }
  }
  let targets = wanted ? [wanted] : daqBindings.map(b => b.nodeId)
  if (lineFilter && !wanted) {
    const onLine = targets.filter(id => lineOf(id) === lineFilter)
    if (onLine.length === 0) {
      return { error: { text: `你绑定的数采节点中没有归属产线 ${lineFilter} 的(各节点归属:${daqBindings.map(b => `${b.nodeId}=${lineOf(b.nodeId) || '未分配'}`).join('; ')})。`, isError: true } }
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
}): Promise<{ text: string, isError?: boolean }> {
  const auth = daqTargetsOf(agentId, args.node_id, args.line_id)
  if ('error' in auth) return auth.error
  const { targets } = auth
  const lineFilter = args.line_id ? String(args.line_id).trim() : ''

  const toMs = Number(args.to_ms) || Date.now()
  const fromMs = Number(args.from_ms) || toMs - (Number(args.last_minutes) || 30) * 60_000
  // 时间间隔参数(bucket_ms 降采样桶宽):缺省与下限来自 daq.query.*(live 配置,热重载)
  const qCfg = daqRuntimeSettings().query
  const rawBucket = Number(args.bucket_ms)
  const bucketMs = Number.isFinite(rawBucket) && rawBucket > 0
    ? Math.max(qCfg.minBucketMs, Math.min(3_600_000, Math.round(rawBucket)))
    : qCfg.defaultBucketMs
  const limit = Math.min(Number(args.limit) || 500, 2000)

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

  const sections: string[] = []
  /** 实际生效的过滤口径(逐节点累计,用于文末 provenance 与表头) */
  const applied: Array<{ nodeId: string, lineId: string, runId?: string, recipeId?: string, source: 'explicit' | 'active-run' | 'none' }> = []
  for (const nodeId of targets) {
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) continue
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
        const series = await tsdb.queryTagged({
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
        points = await tsdb.query(nodeId, { fromMs, toMs, bucketMs, limit })
      }
      const scopeTag = scopeRun.source === 'explicit'
        ? `批次过滤(显式)${scopeRun.runId ? ` run=${scopeRun.runId}` : ''}${scopeRun.recipeId ? ` 配方=${scopeRun.recipeId}` : ''}${scopeRun.productId ? ` 产品=${scopeRun.productId}` : ''}`
        : scopeRun.source === 'active-run'
          ? `当前活动批次 run=${scopeRun.runId ?? ''} 配方「${(scopeRun.recipeId && getDcwController().listRecipes().find(r => r.id === scopeRun.recipeId)?.name) || scopeRun.recipeId}」(${scopeRun.recipeId})(可直接把 run_id/recipe_id 回传给 daq_query 或 aml_dataset_build)`
          : wantAll
            ? '全量窗口(scope=all,不做配方过滤)'
            : '未过滤(该产线当前未开跑 → 无活动批次可限定)'
      const head = `■ ${node.name}(${ch})单位 ${node.unit},正常量程 ${node.min}~${node.max}${node.unit},当前状态 ${node.state},时间窗 ${new Date(fromMs).toISOString().slice(0, 16)} ~ ${new Date(toMs).toISOString().slice(0, 16)}${bucketMs ? `(降采样 ${bucketMs}ms)` : ''}\n  ${scopeTag}`
      // 工况判读容器(具体判读在 values 计算后追加)
      const readout: string[] = []
      if (points.length === 0) {
        sections.push(`${head}\n  窗口内无数据(产线未运行或过滤条件不匹配;仅产线运行中的样本被持久化打标)`)
        continue
      }
      const values = points.map(p => p.value ?? p.avg ?? 0).filter(Number.isFinite)
      const latest = values[values.length - 1]!
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
      const tail = points.slice(-12).map(p => `${new Date(p.at).toISOString().slice(11, 19)}=${p.value != null ? p.value : `avg ${Number((p.avg ?? 0).toFixed(2))}`}`)
      sections.push(
        `${head}\n  样本 ${values.length} 点 | 最新 ${latest}${node.unit} | 均值 ${Number(avg.toFixed(3))} | 最小 ${Math.min(...values)} | 最大 ${Math.max(...values)}\n  最近序列: ${tail.join('; ')}${readout.length > 0 ? `\n  工况判读: ${readout.join(' | ')}` : ''}`,
      )
    }
    catch (err) {
      sections.push(`■ ${node.name}:查询失败 ${err instanceof Error ? err.message : String(err)}`)
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
    provLines.push(`—— 未过滤节点(所在产线未开跑,无活动批次可限定):${unscoped.map(a => a.nodeId).join(', ')}`)
  }
  const prov = provLines.length > 0 ? `\n(过滤条件:${provLines.join(' ')})` : ''
  return { text: `数采数据查询结果(${targets.length} 个节点):\n\n${sections.join('\n\n')}${prov}\n\n数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。` }
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
}): Promise<{ text: string, isError?: boolean }> {
  const auth = daqTargetsOf(agentId, args.node_id, args.line_id)
  if ('error' in auth) return auth.error
  const { targets } = auth
  const kind = args.kind === 'vector' || args.kind === 'image' ? args.kind : undefined
  const toMs = Number(args.to_ms) || Date.now()
  const fromMs = Number(args.from_ms) || toMs - (Number(args.last_minutes) || 30) * 60_000
  const limit = Math.min(Number(args.limit) || 20, 100)
  const { getTsdb, tsdbReady } = await import('../../daq/storage')
  await tsdbReady
  const tsdb = getTsdb()

  const sections: string[] = []
  for (const nodeId of targets) {
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) continue
    const tpl = findDaqTemplate(node.templateKey)
    const signalKind = tpl?.signalKind ?? 'scalar'
    if (signalKind === 'scalar') {
      sections.push(`■ ${node.name}:单点标量节点(模板 ${node.templateKey}),无帧数据 —— 请用 daq_query 查时序数值。`)
      continue
    }
    try {
      const frames = await tsdb.queryFrames(nodeId, { fromMs, toMs, kind, limit })
      if (frames.length === 0) {
        sections.push(`■ ${node.name}(${tpl?.ch ?? node.templateKey}):窗口内无帧(产线未运行或过滤条件不匹配;仅产线运行中的帧被持久化)`)
        continue
      }
      const head = `■ ${node.name}(${tpl?.ch ?? node.templateKey})形态 ${signalKind},帧数 ${frames.length},时间窗 ${new Date(fromMs).toISOString().slice(0, 16)} ~ ${new Date(toMs).toISOString().slice(0, 16)}`
      const lines = frames.slice(0, 10).map((f) => {
        const at = new Date(f.at).toISOString().slice(11, 19)
        if (f.kind === 'vector') {
          const pts = f.points ?? []
          const preview = pts.slice(0, 16).map(p => Number(p.toFixed(3))).join(',')
          return `  ${at} 轮廓 ${pts.length} 点[${preview}${pts.length > 16 ? ',…' : ''}] 指标 {${Object.entries(f.metrics).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(', ')}}`
        }
        const width = f.meta.width ?? '?'
        const height = f.meta.height ?? '?'
        return `  ${at} 图像 ${width}x${height} ${f.meta.mime ?? 'image/png'} 对象=${String(f.meta.objectKey ?? '-').slice(-24)} 指标 {${Object.entries(f.metrics).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(', ')}}(像素不入上下文;前端画廊可看)`
      })
      sections.push(`${head}\n${lines.join('\n')}${frames.length > 10 ? `\n  (仅展示最近 10 帧)` : ''}`)
    }
    catch (err) {
      sections.push(`■ ${node.name}:帧查询失败 ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { text: `数采帧查询结果(${targets.length} 个节点):\n\n${sections.join('\n\n')}\n\n向量=多点工程量轮廓(完整点列前端可查);图像=像素在对象存储,指标供判读(brightness 过低=曝光不足/遮挡)。` }
}
