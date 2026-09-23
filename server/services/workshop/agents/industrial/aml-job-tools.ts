/**
 * AML 作业与模型(aml_job_* / aml_leaderboard / aml_model_*)
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import { AML_AUDIT_KIND, amlErr, amlJobCard, amlNodeName, amlNodeUnit, fmtAmlNum } from './aml-dataset-tools'
import { agentBadgeLabel } from '../agent-badge'
import { alignToGrid } from '../../aml/clean'
import { cancelJob, jobLogsTail, runtimeStatus, submitJob } from '../../aml/job-orchestrator'
import { getActiveLineRun } from '../../dcw/line-run'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getAmlRuntime } from '../../aml/runtime'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwProductRepo } from '../../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { getToolApprovals } from '../tool-approvals'
import { predictProduction, readIoSpecFor } from '../../aml/predictor'
import { recordOps } from '../../ops/ops'
import { transitionModel } from '../../aml/model-registry'

/** 工具:aml_job_submit —— 提交训练作业(train.py 全文内联;归因 agentId;队列 FIFO) */
export async function toolAmlJobSubmit(agentId: string, args: {
  dataset_id?: string
  code?: string
  change_note?: string
  params?: Record<string, unknown>
  seed?: number | string
  purpose?: string
  parent_experiment_id?: string
}): Promise<{ text: string, isError?: boolean }> {
  const datasetId = String(args.dataset_id ?? '').trim()
  const code = typeof args.code === 'string' ? args.code : ''
  if (!datasetId) return amlErr('dataset_id 必填(aml_dataset_build 返回的 id)。')
  if (!code.trim()) return amlErr('code 必填:train.py 全文(单文件;契约见工具说明)。')
  if (code.length > 512_000) return amlErr(`code 过大(${Math.round(code.length / 1024)}KB),上限 500KB;精简训练代码(模型定义/训练循环拆薄)后重试。`)
  if (!/\bimport\s+amlkit\b/.test(code)) {
    return amlErr('code 必须 import amlkit(平台数据/进度/导出契约):amlkit.load_bundle(datasetPath) 取数、amlkit.report_progress(pct, note) 报进度、amlkit.export_torch_onnx(model, manifest) 导出。缺契约的作业必然失败。')
  }
  const purpose = args.purpose === 'quality_predict' ? 'quality_predict' : args.purpose === 'mpc_surrogate' ? 'mpc_surrogate' : undefined
  const changeNote = String(args.change_note ?? '').trim()
  if (!changeNote) return amlErr('change_note 必填:单组件改动纪律 —— 每次实验只改一个组件(网络结构/特征/超参之一),写清改了什么与预期,实验谱系靠它归因。')
  try {
    const job = submitJob({
      datasetId,
      purpose,
      changeNote,
      params: args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : undefined,
      seed: Number.isInteger(Number(args.seed)) ? Number(args.seed) : undefined,
      parentExperimentId: String(args.parent_experiment_id ?? '').trim() || undefined,
      code,
      agent: { id: agentId },
    })
    const st = await runtimeStatus()
    return {
      text: [
        `训练作业已提交:`,
        `  job_id: ${job.id}`,
        `  dataset: ${job.datasetId} | purpose=${job.purpose} | seed=${fmtAmlNum(Number(job.budget.seed ?? 42), 0)} | change_note: ${changeNote}`,
        `  队列: 排队 ${st.queued} 个(含本作业)/ 在跑 ${st.running} 个 | python ${st.python.ok ? (st.python.version ?? 'ok') : `不可用(${st.python.reason ?? '?'};作业会失败,请联系用户修复环境)`}`,
        `\n用 aml_job_status { job_id: "${job.id}" } 看状态/阶段/门禁,aml_job_logs { job_id: "${job.id}" } 看日志尾;训练完成后 aml_leaderboard 看谱系与门禁。`,
      ].join('\n'),
    }
  }
  catch (err) {
    return { text: `提交失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:aml_job_status —— 作业状态(单作业详情 / 缺省列最近 10 个) */
export async function toolAmlJobStatus(_agentId: string, args: { job_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const rt = getAmlRuntime()
  const jobId = String(args.job_id ?? '').trim()
  if (jobId) {
    const job = rt.repo.job.get(jobId)
    if (!job) return amlErr(`作业 ${jobId} 不存在(aml_job_status 不带参数可列出最近 10 个)。`)
    return { text: `${amlJobCard(job)}\n\n轮询建议:training 阶段 30~60s 查一次;终态(done/failed)后看门禁与错误,失败原因可 in aml_job_logs 定位。` }
  }
  const jobs = rt.repo.job.list({ limit: 10 })
  if (jobs.length === 0) {
    return { text: '尚无训练作业。路径:aml_node_catalog 确认节点 → aml_dataset_build 组数据集 → aml_job_submit 提交训练。' }
  }
  const rows = jobs.map(j => `- ${j.id} [${j.status}] ${j.stage || '-'} ${j.progress}% dataset=${j.datasetId}${j.error ? ` | 错误: ${j.error.slice(0, 100)}` : ''}`)
  return { text: `最近 ${jobs.length} 个作业(新→旧):\n${rows.join('\n')}\n\n传 job_id 查看单作业详情(指标/门禁逐项/错误)。` }
}

/** 工具:aml_job_logs —— 作业日志尾随(平台 ##AML 协议行 + 训练输出) */
export async function toolAmlJobLogs(_agentId: string, args: { job_id?: string, lines?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const jobId = String(args.job_id ?? '').trim()
  if (!jobId) return amlErr('job_id 必填(aml_job_status 不带参数可列出最近作业)。')
  const job = getAmlRuntime().repo.job.get(jobId)
  if (!job) return amlErr(`作业 ${jobId} 不存在。`)
  const n = Math.min(Math.max(Number(args.lines) || 80, 5), 400)
  const rows = jobLogsTail(jobId, n)
  if (rows.length === 0) {
    return { text: `作业 ${jobId} 暂无日志(${job.status === 'queued' ? '仍在排队,开跑后产生日志' : '日志未落盘或已被清理'});稍后重试或用 aml_job_status 看状态。` }
  }
  return { text: `作业 ${jobId} 日志尾(最近 ${rows.length} 行,时间正序;##AML 前缀行 = 平台协议事件):\n${rows.join('\n')}` }
}

/** 工具:aml_job_cancel —— 取消排队/运行中的作业(归因入册) */
export async function toolAmlJobCancel(agentId: string, args: { job_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const jobId = String(args.job_id ?? '').trim()
  if (!jobId) return amlErr('job_id 必填。')
  const rt = getAmlRuntime()
  const job = rt.repo.job.get(jobId)
  if (!job) return amlErr(`作业 ${jobId} 不存在。`)
  if (['done', 'failed', 'cancelled', 'timeout'].includes(job.status)) {
    return amlErr(`作业 ${jobId} 已是终态(${job.status}),无需取消;aml_job_status 复核。`)
  }
  const ok = cancelJob(jobId, { id: agentId, kind: 'agent' })
  if (!ok) return amlErr(`取消失败:作业 ${jobId} 不在排队/运行中(可能恰好结束);aml_job_status 复核。`)
  const dataset = rt.repo.dataset.get(job.datasetId)
  recordOps({
    actor: agentId,
    actorName: agentBadgeLabel(agentId),
    actorKind: 'agent',
    action: 'aml.job.cancel',
    kind: AML_AUDIT_KIND,
    summary: `取消训练作业 ${jobId}(原状态 ${job.status})`,
    targetKind: 'aml_job',
    targetId: jobId,
    lineId: dataset?.lineId,
    productId: dataset?.productId,
    recipeId: dataset?.recipeId,
  })
  return { text: `作业 ${jobId} 已取消(运行中的会终止进程树)。数据集 ${job.datasetId} 仍可复用;需要重训直接 aml_job_submit。` }
}

/** 工具:aml_leaderboard —— 数据集的实验谱系与门禁对照(标当前最优) */
export async function toolAmlLeaderboard(_agentId: string, args: { dataset_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const datasetId = String(args.dataset_id ?? '').trim()
  if (!datasetId) return amlErr('dataset_id 必填(aml_dataset_build 返回的 id)。')
  const rt = getAmlRuntime()
  const dataset = rt.repo.dataset.get(datasetId)
  if (!dataset) return amlErr(`数据集 ${datasetId} 不存在。`)
  const exps = rt.repo.experiment.listByDataset(datasetId, 50)
  if (exps.length === 0) {
    return { text: `数据集 ${datasetId}(${dataset.rowCount} 行)尚无实验:aml_job_submit 提交训练后,此处给出谱系与门禁对照。` }
  }
  const parsed = exps.map((e) => {
    let metrics: { oneStepTest?: { nrmse?: number }, rolloutTest?: { nrmse?: number } } = {}
    let gates: { passed?: boolean } = {}
    try {
      metrics = JSON.parse(e.metricsJson)
    }
    catch { /* 无指标 */ }
    try {
      gates = JSON.parse(e.gatesJson)
    }
    catch { /* 无门禁 */ }
    return { e, g1: metrics.oneStepTest?.nrmse ?? null, g2: metrics.rolloutTest?.nrmse ?? null, passed: gates.passed === true || e.status === 'gates_passed' }
  })
  const passers = parsed.filter(p => p.passed && p.g1 != null)
  const bestId = passers.length > 0 ? passers.reduce((a, b) => ((a.g1 ?? Infinity) <= (b.g1 ?? Infinity) ? a : b)).e.id : null
  const rows = parsed.map(p =>
    `- ${p.e.id} [${p.e.status}] ${p.e.changeNote ? `「${p.e.changeNote.slice(0, 60)}」` : '(无备注)'}${p.e.parentExperimentId ? ` ← 父 ${p.e.parentExperimentId}` : ''} | G1=${fmtAmlNum(p.g1)}${p.g2 != null ? ` G2=${fmtAmlNum(p.g2)}` : ''} | 门禁 ${p.passed ? '通过' : '未通过'}${p.e.id === bestId ? ' ★当前最优' : ''}`)
  const models = rt.repo.model.list({ limit: 100 }).filter(m => m.datasetId === datasetId)
  const modelLines = models.map(m => `- ${m.id} [${m.stage}] purpose=${m.purpose}(实验 ${m.experimentId})`)
  return {
    text: [
      `实验谱系(数据集 ${datasetId} · ${dataset.productId}/${dataset.recipeId} · ${exps.length} 条,新→旧):`,
      ...rows,
      modelLines.length > 0 ? `\n已登记模型(晋升对象;aml_leaderboard 最优 = 门禁通过且 G1 最小):` : null,
      ...modelLines,
      `\nG1=单步测试 NRMSE,G2=多步滚动 NRMSE(越小越好)。优化纪律:每次只改一个组件,change_note 写明;把最优模型推上生产用 aml_model_promote(lead 专属,需人工审批)。`,
    ].filter(x => x !== null).join('\n'),
  }
}

/** 工具:aml_model_promote —— 模型晋升 shadow/production(lead 专属;HITL 人工审批;流转入册由 transitionModel 内部完成) */
export async function toolAmlModelPromote(agentId: string, args: { model_id?: string, to_stage?: string }): Promise<{ text: string, isError?: boolean }> {
  // 治理硬守卫:晋升仅限 lead 实例(注入层过滤 + 分发层双重校验,HTTP 直调不可绕过)
  const roleRow = getAmlRuntime().db.prepare('SELECT role FROM channel_agents WHERE id = ? AND enabled = 1').get(agentId) as { role?: string } | undefined
  if (roleRow?.role !== 'lead') {
    return amlErr(`aml_model_promote 为 lead 专属工具:实例 ${agentId}(role=${roleRow?.role ?? '未知'})无权晋升模型。请由团队 lead 发起,晋升需人工 HITL 批准。`)
  }
  const modelId = String(args.model_id ?? '').trim()
  const toStage = String(args.to_stage ?? '').trim()
  if (!modelId) return amlErr('model_id 必填(aml_leaderboard 的「已登记模型」段可查)。')
  if (toStage !== 'shadow' && toStage !== 'production') return amlErr('to_stage 必须为 \'shadow\'(影子观测)或 \'production\'(生产生效)。')
  const rt = getAmlRuntime()
  const model = rt.repo.model.get(modelId)
  if (!model) return amlErr(`模型 ${modelId} 不存在。`)
  if (model.stage === toStage) return amlErr(`模型 ${modelId} 已是 ${toStage},无需流转。`)
  // production 预检:同组 (product, recipe, purpose) 旧生产将被退役
  let oldProdId: string | undefined
  if (toStage === 'production') {
    oldProdId = rt.repo.model
      .list({ stage: 'production', productId: model.productId, recipeId: model.recipeId, limit: 50 })
      .find(m => m.id !== modelId && m.purpose === model.purpose)?.id
  }
  // 同模型挂起审批去重(防审批面板堆积,与 dcw_control 同纪律)
  const approvals = getToolApprovals()
  if (approvals.hasPendingFor(agentId, modelId)) {
    return amlErr(`模型 ${modelId} 已有一条待审批的晋升请求,请等待用户处理后再发起新请求。`)
  }
  const detail = `AML 模型晋升:${modelId} ${model.stage} → ${toStage}(产品 ${model.productId} / 配方 ${model.recipeId} / purpose=${model.purpose}${oldProdId ? `;批准后原生产模型 ${oldProdId} 将自动退役` : ''})`
  const ap = await approvals.request(agentId, modelId, 'dcw', detail, { title: 'AML 模型晋升审批' })
  if (!ap.approved) {
    return { text: `人工未批准:模型 ${modelId} 保持 ${model.stage} 阶段。用户备注:${ap.comment || '(无)'}。可回炉重训(aml_job_submit)或换候选模型后再申请。` }
  }
  try {
    const r = transitionModel(modelId, toStage, agentBadgeLabel(agentId), 'agent')
    // 归属审计已由 transitionModel 内部 recordOps(aml.model.promote)完成,此处不重复记录
    return {
      text: `晋升完成:${modelId} ${r.from} → ${toStage}。${r.retiredId ? `原生产模型 ${r.retiredId} 已自动退役。` : ''}${toStage === 'shadow'
        ? '影子阶段:用 aml_model_reference 观测其预测与实际偏差,积累证据后再申请 production。'
        : '该模型已作为生产模型生效:aml_model_reference 的影子参考即来自它;调控 Agent 调参前请先查它。'}`,
    }
  }
  catch (err) {
    return { text: `晋升失败:${err instanceof Error ? err.message : String(err)}(审批已通过;若为并发竞态可刷新状态重试)。`, isError: true }
  }
}

/** 工具:aml_model_reference —— 生产模型影子参考:拉最近历史组装模型输入 → 预测未来目标轨迹(调参前先问影子模型) */
export async function toolAmlModelReference(agentId: string, args: {
  line_id?: string
  product_id?: string
  recipe_id?: string
  purpose?: string
  controls?: Record<string, number | string>
  steps?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  // 0. 绑定面:至少一个 daq 绑定;line_id 只缩不放
  const repo = getAgentNodeBindingRepo()
  const daqBindings = repo.byAgent(agentId).filter(b => b.kind === 'daq')
  if (daqBindings.length === 0) {
    return amlErr('你尚未绑定任何数采节点,无法组装影子参考所需的历史输入;请先绑定数采节点。')
  }
  const lineOf = (id: string): string => getDaqNodeRepo().byId(id)?.lineId ?? ''
  const scopeLines = [...new Set(daqBindings.map(b => lineOf(b.nodeId)).filter(Boolean))]
  const lineFilter = String(args.line_id ?? '').trim()
  if (lineFilter && !scopeLines.includes(lineFilter)) {
    return amlErr(`产线 ${lineFilter} 不在你的负责范围(你绑定节点覆盖:${scopeLines.join(', ') || '无'};绑定只缩不放)。`)
  }
  const purpose = args.purpose === 'quality_predict' ? 'quality_predict' : 'mpc_surrogate'

  // 1. 解析 (productId, recipeId):参数给全用参数;缺省回退到候选产线的唯一活动批次
  let productId = String(args.product_id ?? '').trim()
  let recipeId = String(args.recipe_id ?? '').trim()
  let resolveHow = '参数指定'
  if (!productId || !recipeId) {
    const candidateLines = lineFilter ? [lineFilter] : scopeLines
    const runs = candidateLines
      .map(lid => getActiveLineRun(lid))
      .filter((r): r is NonNullable<ReturnType<typeof getActiveLineRun>> => !!r && !!r.productId && !!r.recipeId)
    if (runs.length === 1) {
      const run = runs[0]!
      if (!productId) productId = run.productId
      if (!recipeId) recipeId = run.recipeId
      resolveHow = `产线 ${run.lineId} 唯一活动批次 ${run.runId.slice(0, 8)}(产品「${run.productName}」/配方「${run.recipeName}」)`
    }
    else if (runs.length === 0) {
      return { text: `无法确定产品/配方:${candidateLines.length > 0 ? `产线 ${candidateLines.join(', ')}` : '你绑定节点所属产线'}当前无活动批次,且 product_id/recipe_id 未给全。请开跑后重试,或显式传 product_id 与 recipe_id(line_context 可查)。`, isError: true }
    }
    else {
      return { text: `无法确定产品/配方:候选产线存在多个活动批次(${runs.map(r => `${r.lineId} → ${r.productName}/${r.recipeName}`).join('; ')})。请传 line_id 缩小范围,或显式传 product_id 与 recipe_id。`, isError: true }
    }
  }

  // 2. 生产模型(无则指引建模范式)
  const rt = getAmlRuntime()
  const model = rt.repo.model.productionOf(productId, recipeId, purpose)
  if (!model) {
    const cands = rt.repo.model.list({ productId, recipeId, limit: 20 })
    return { text: `尚无生产模型:(${productId}, ${recipeId}, ${purpose}) 下没有 stage=production 的模型。${cands.length > 0 ? `现有候选:${cands.map(m => `${m.id}(${m.stage})`).join(', ')} —— 请 lead 用 aml_model_promote 晋升(需人工审批)。` : '该三元组下还没有任何模型:aml_dataset_build → aml_job_submit 训练,门禁通过后申请晋升。在此之前调参请依据 dcw_journal 历史经验与 daq_query 证据。'}` }
  }
  // 3. 产线归属鉴权(绑定只缩不放;模型归属线经数据集追溯)
  const ds = rt.repo.dataset.get(model.datasetId)
  const modelLine = ds?.lineId ?? ''
  if (modelLine && !scopeLines.includes(modelLine)) {
    return amlErr(`模型 ${model.id} 归属产线 ${modelLine},不在你绑定节点覆盖的产线(${scopeLines.join(', ')})内;绑定只缩不放。`)
  }

  // 4. io 契约 → 拉最近历史 → 网格对齐 → 组 [H][nAll](原始物理量,顺序 = allNodes)
  const io = readIoSpecFor(model.id)
  const H = io.historySteps
  const beatMs = io.beatMs
  const now = Date.now()
  const fromMs = now - H * beatMs - 5 * beatMs
  const { getTsdb, tsdbReady } = await import('../../daq/storage')
  await tsdbReady
  const tsdb = getTsdb()
  const columns = new Map<string, number[]>()
  const shortage: string[] = []
  for (const nodeId of io.allNodes) {
    try {
      const pts = await tsdb.query(nodeId, { fromMs, toMs: now, limit: Math.min(Math.max(H * 10, 600), 5000) })
      const { grid } = alignToGrid(
        pts.map(p => ({ at: p.at, value: p.value ?? p.avg ?? 0 })).filter(p => Number.isFinite(p.value)),
        { beatMs, maxInterpMs: beatMs * 2 },
      )
      const tail = grid.slice(-H).map(g => g.value)
      if (tail.length < H) {
        shortage.push(`${amlNodeName(nodeId)}(${nodeId})仅 ${tail.length}/${H} 格点`)
        continue
      }
      columns.set(nodeId, tail)
    }
    catch (err) {
      shortage.push(`${amlNodeName(nodeId)}(${nodeId})查询失败:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (shortage.length > 0) {
    return { text: `历史数据不足,无法组装模型输入:${shortage.join(';')}。需要从 ${new Date(fromMs).toISOString().slice(0, 16)} 起连续约 ${(H * beatMs / 60_000).toFixed(0)} 分钟的运行数据(产线须在跑);等数据积累后重试,或缩短 steps/换更短 history 的模型。`, isError: true }
  }
  const history: number[][] = []
  for (let i = 0; i < H; i++) history.push(io.allNodes.map(n => columns.get(n)![i]!))

  // 5. 控制轨迹:controls 映射(节点 id → 值,常数外推 steps 行);缺省行持最后观测
  const steps = Math.max(1, Math.min(Number(args.steps) || io.horizonSteps, io.horizonSteps))
  const lastRow = history[history.length - 1]!
  const unknownKeys = args.controls ? Object.keys(args.controls).filter(k => !io.controlNodes.includes(k)) : []
  const controlRow = io.controlNodes.map((c) => {
    const provided = args.controls?.[c]
    const v = provided != null ? Number(provided) : Number.NaN
    return Number.isFinite(v) ? v : lastRow[io.allNodes.indexOf(c)]!
  })
  const controls: number[][] = Array.from({ length: steps }, () => [...controlRow])

  // 6. 预测 + 人话报告
  try {
    const r = await predictProduction(productId, recipeId, purpose, { history, controls, steps })
    const header = `步 | ${r.targetNodes.map(t => `${amlNodeName(t)}(${amlNodeUnit(t)})`).join(' | ')}`
    const forecastLines = r.forecast.map((row, i) =>
      `  ${i + 1}(+${fmtAmlNum(((i + 1) * r.beatMs) / 1000, 0)}s) | ${row.map(v => fmtAmlNum(v, 3)).join(' | ')}`)
    const ctrlTxt = io.controlNodes.length > 0
      ? io.controlNodes.map((c) => {
          const provided = args.controls?.[c]
          return `${amlNodeName(c)}=${Number.isFinite(Number(provided)) ? Number(provided) : `${fmtAmlNum(lastRow[io.allNodes.indexOf(c)], 3)}(持最后观测)`}${amlNodeUnit(c)}`
        }).join(', ')
      : '无控制节点'
    return {
      text: [
        `影子模型参考(调参前先问影子模型;预测≠承诺,真实下发仍走 dcw_control 安全联锁):`,
        `  模型 ${r.modelId}(stage=${r.stage},purpose=${purpose})| 三元组:产品 ${getDcwProductRepo().byId(productId)?.name ?? productId} / 配方 ${getDcwRecipeRepo().byId(recipeId)?.name ?? recipeId}(解析:${resolveHow})`,
        `  输入:最近 ${H} 拍 × ${io.allNodes.length} 节点(beat=${beatMs}ms),截至 ${new Date(now).toISOString().slice(11, 19)};控制轨迹(共 ${steps} 步):${ctrlTxt}${unknownKeys.length > 0 ? `(已忽略非控制节点的键:${unknownKeys.join(', ')})` : ''}`,
        `  预测(steps=${steps},每拍 ${beatMs / 1000}s):`,
        `    ${header}`,
        ...forecastLines,
        `  假设: ${r.assumptions}`,
        `\n用法:把候选设定值作为 controls 传入(键 = 控制节点 id)对比不同方案的预测轨迹;选定后 dcw_control 下发并 daq_query 复测。`,
      ].join('\n'),
    }
  }
  catch (err) {
    return { text: `预测失败:${err instanceof Error ? err.message : String(err)}(模型 ${model.id};若为工件缺失可重训同规格数据集)。`, isError: true }
  }
}
