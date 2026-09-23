/**
 * AML 数据集与节点目录(aml_node_catalog / aml_dataset_*)
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlDatasetReport } from '../../aml/dataset-builder'
import type { AmlDatasetRow, AmlJobRow } from '../../aml/aml.repo'
import { agentBadgeLabel } from '../agent-badge'
import { buildDataset } from '../../aml/dataset-builder'
import { findDaqTemplate } from '../../daq/daq-templates'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getAmlRuntime } from '../../aml/runtime'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getDcwProductRepo } from '../../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { join } from 'node:path'
import { parseDatasetSpec } from '../../aml/spec'
import { readFileSync } from 'node:fs'
import { recordOps } from '../../ops/ops'

// ================================================================
// AML 自动建模工具族(aml_*):数据集 → 训练作业 → 实验谱系 → 模型晋升 → 影子参考
// 权限模型:数据集构建节点级鉴权(daq 绑定,只缩不放)+ 归属产线一致;晋升走 HITL 人工审批;
// 作业提交/取消按 agentId 归因( submitJob 内部已记 ops,工具层不重复记提交动作)。
// ================================================================

/** recordOps 的 AML 分类(与 job-orchestrator/model-registry 的 kind='aml' 同源;仓储联合类型暂未列 'aml',此处收口断言) */
export const AML_AUDIT_KIND = 'aml' as unknown as 'system'

export function amlErr(text: string): { text: string, isError: true } {
  return { text, isError: true }
}

/** 数值展示(4 位有效小数;空值统一 '-') */
export function fmtAmlNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '-'
  return String(Number(v.toFixed(digits)))
}

export function amlNodeName(nodeId: string): string {
  return getDaqNodeRepo().byId(nodeId)?.name ?? nodeId
}

export function amlNodeUnit(nodeId: string): string {
  const n = getDaqNodeRepo().byId(nodeId)
  return n?.unit ?? findDaqTemplate(n?.templateKey ?? '')?.unit ?? ''
}

/** 数据集构建报告惰性读(report.json 与 manifest 同目录) */
export function amlReportOf(dataset: AmlDatasetRow): AmlDatasetReport | null {
  try {
    return JSON.parse(readFileSync(join(dataset.path, 'report.json'), 'utf8')) as AmlDatasetReport
  }
  catch {
    return null
  }
}

/** 门禁报告 → 逐项文本(解析失败降级为原始串) */
export function amlGatesLines(gatesJson: string | null): string {
  if (!gatesJson) return ''
  try {
    const g = JSON.parse(gatesJson) as { checks?: Array<{ id: string, name: string, value: number | null, threshold: number | null, pass: boolean, detail: string }> }
    if (!g.checks?.length) return ''
    return g.checks
      .map(c => `    ${c.id} ${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`)
      .join('\n')
  }
  catch {
    return `    (门禁数据解析失败) ${gatesJson.slice(0, 120)}`
  }
}

/** 作业行 → 详情卡片(状态/阶段/进度/指标/门禁逐项/错误) */
export function amlJobCard(job: AmlJobRow): string {
  const gates = amlGatesLines(job.gatesJson)
  let metrics = ''
  try {
    const m = JSON.parse(job.metricsJson ?? '{}') as { oneStepVal?: { windows?: number, nrmse?: number } | null, oneStepTest?: { windows?: number, nrmse?: number } | null, rolloutTest?: { windows?: number, nrmse?: number, horizon?: number } | null }
    const parts: string[] = []
    if (m.oneStepVal) parts.push(`单步验证 NRMSE=${fmtAmlNum(m.oneStepVal.nrmse)}(${m.oneStepVal.windows ?? '?'} 窗)`)
    if (m.oneStepTest) parts.push(`单步测试 NRMSE=${fmtAmlNum(m.oneStepTest.nrmse)}(${m.oneStepTest.windows ?? '?'} 窗)`)
    if (m.rolloutTest) parts.push(`滚动测试 NRMSE=${fmtAmlNum(m.rolloutTest.nrmse)}(horizon=${m.rolloutTest.horizon ?? '?'})`)
    metrics = parts.join(' | ')
  }
  catch { /* 无指标 */ }
  return [
    `■ 作业 ${job.id}`,
    `  状态 ${job.status} | 阶段 ${job.stage || '-'} | 进度 ${job.progress}% | purpose=${job.purpose}`,
    `  dataset: ${job.datasetId} | 提交者: ${job.agentId || '-'} | 重试 ${job.retryCount}/2`,
    `  创建 ${job.createdAt.slice(0, 19).replace('T', ' ')}${job.startedAt ? ` | 开跑 ${job.startedAt.slice(0, 19).replace('T', ' ')}` : ''}${job.endedAt ? ` | 结束 ${job.endedAt.slice(0, 19).replace('T', ' ')}` : ''}`,
    metrics ? `  指标: ${metrics}` : null,
    gates ? `  门禁逐项:\n${gates}` : '  门禁: 未产出(作业未完成评估)',
    job.error ? `  错误: ${job.error}` : null,
  ].filter(x => x !== null).join('\n')
}

/** 工具:aml_node_catalog —— 我可用的 AML 建模节点(daq 绑定面;物理语义 + 近 24h 批次数据可用性) */
export async function toolAmlNodeCatalog(agentId: string): Promise<{ text: string }> {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId).filter(b => b.kind === 'daq')
  if (bindings.length === 0) {
    return { text: '你尚未绑定任何数采节点,AML 自动建模工具不可用(数据集构建要求所用节点均有你的 daq 绑定,绑定只缩不放)。请在数字孪生界面绑定数采节点后重试。' }
  }
  const { getTsdb, tsdbReady } = await import('../../daq/storage')
  await tsdbReady
  const tsdb = getTsdb()
  const from24h = Date.now() - 24 * 3_600_000
  const cards: string[] = []
  for (const b of bindings) {
    const node = getDaqNodeRepo().byId(b.nodeId)
    if (!node) continue
    const tpl = findDaqTemplate(node.templateKey)
    let dataTag = '近 24h 无批次数据(产线未运行?建模前先确认采集)'
    try {
      const pts = await tsdb.query(b.nodeId, { fromMs: from24h, toMs: Date.now(), limit: 1 })
      if (pts.length > 0) dataTag = '近 24h 有批次打标数据(可建模)'
    }
    catch { /* 时序库异常按无数据处理 */ }
    const lineTxt = node.lineId
      ? `${getDcwLineRepo().byId(node.lineId)?.name ?? node.lineId}(${node.lineId})`
      : '未分配产线(无批次打标,不能参与建模)'
    cards.push(
      `■ ${node.name} · node_id=${node.id}\n`
      + `  物理量 ${tpl?.ch ?? node.templateKey} | 单位 ${node.unit} | 正常量程 ${node.min}~${node.max}${node.unit}\n`
      + `  产线: ${lineTxt} | 数据: ${dataTag}${tpl?.semantics ? `\n  语义: ${tpl.semantics.slice(0, 160)}` : ''}`,
    )
  }
  return {
    text: `你可用的 AML 建模节点(${cards.length} 个 daq 绑定):\n\n${cards.join('\n\n')}\n\n---\n建模路径:aml_dataset_build(选 control/target 节点组数据集)→ aml_job_submit(提交训练代码)→ aml_job_status / aml_job_logs 轮询 → aml_leaderboard 看实验谱系 → aml_model_promote(lead 专属,人工审批)→ aml_model_reference(调参前查影子参考)。\nrole 语义:control=可控输入(未来轨迹已知)/ target=预测目标(必选 ≥1)/ feature=仅历史特征。`,
  }
}

/** 工具:aml_dataset_build —— 组建训练数据集(节点级鉴权:daq 绑定 + 归属产线一致;隔离三元组防配方串味) */
export async function toolAmlDatasetBuild(agentId: string, args: {
  line_id?: string
  product_id?: string
  recipe_id?: string
  nodes?: Array<{ node_id?: string, role?: string }>
  beat_ms?: number | string
  history_steps?: number | string
  horizon_steps?: number | string
  split_seed?: number | string
  val_ratio?: number | string
  test_ratio?: number | string
  purpose?: string
  note?: string
  run_ids?: string[]
  from_ms?: number | string
  to_ms?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  const lineId = String(args.line_id ?? '').trim()
  const productId = String(args.product_id ?? '').trim()
  const recipeId = String(args.recipe_id ?? '').trim()
  if (!lineId || !productId || !recipeId) {
    return amlErr('line_id / product_id / recipe_id 必填(隔离三元组,防配方串味;line_context 可查看当前批次的三个 id)。')
  }
  const beatMs = Number(args.beat_ms)
  const historySteps = Number(args.history_steps)
  const horizonSteps = Number(args.horizon_steps)
  if (!Number.isInteger(beatMs) || beatMs < 1000) return amlErr('beat_ms 必须为 ≥1000 的整数(数据对齐节拍,ms)。')
  if (!Number.isInteger(historySteps) || historySteps < 1 || historySteps > 2048) return amlErr('history_steps 必须为 1~2048 的整数(历史窗口步数)。')
  if (!Number.isInteger(horizonSteps) || horizonSteps < 1 || horizonSteps > 512) return amlErr('horizon_steps 必须为 1~512 的整数(预测步长)。')
  const nodes = (Array.isArray(args.nodes) ? args.nodes : [])
    .map(n => ({ nodeId: String(n?.node_id ?? '').trim(), role: String(n?.role ?? '').trim() }))
    .filter(n => n.nodeId)
  if (nodes.length < 2) return amlErr('nodes 至少 2 项({node_id, role}),且必须含 1 个 target(预测目标)。')
  if (nodes.some(n => !['control', 'feature', 'target'].includes(n.role))) return amlErr('nodes 的 role 必须为 control / feature / target。')
  if (!nodes.some(n => n.role === 'target')) return amlErr('nodes 必须含至少 1 个 target 节点(预测目标)。')
  // 鉴权:每个节点都要有该 Agent 的 daq 绑定,且归属参数给定的产线(绑定只缩不放)
  const repo = getAgentNodeBindingRepo()
  const daqBound = repo.byAgent(agentId).filter(b => b.kind === 'daq')
  for (const n of nodes) {
    if (!daqBound.some(b => b.nodeId === n.nodeId)) {
      return amlErr(`无权使用节点 ${n.nodeId}(无你的 daq 绑定;绑定只缩不放)。你有权访问的数采节点:${daqBound.map(b => b.nodeId).join(', ') || '(无)'},可先 aml_node_catalog 查看语义。`)
    }
    const nodeLine = getDaqNodeRepo().byId(n.nodeId)?.lineId ?? ''
    if (nodeLine !== lineId) {
      return amlErr(`节点 ${amlNodeName(n.nodeId)}(${n.nodeId})归属产线 ${nodeLine || '未分配'},与 line_id=${lineId} 不一致;数据集节点必须全部归属同一条产线(绑定只缩不放)。`)
    }
  }
  const purpose = args.purpose === 'quality_predict' ? 'quality_predict' : 'mpc_surrogate'
  try {
    const spec = parseDatasetSpec({
      lineId,
      productId,
      recipeId,
      runIds: Array.isArray(args.run_ids) ? args.run_ids.map(r => String(r)).filter(Boolean) : undefined,
      nodes: nodes.map(n => ({ nodeId: n.nodeId, role: n.role as 'control' | 'feature' | 'target' })),
      fromMs: Number(args.from_ms) || undefined,
      toMs: Number(args.to_ms) || undefined,
      beatMs,
      window: { historySteps, horizonSteps },
      split: {
        valRatio: Number.isFinite(Number(args.val_ratio)) ? Number(args.val_ratio) : 0.15,
        testRatio: Number.isFinite(Number(args.test_ratio)) ? Number(args.test_ratio) : 0.15,
        seed: Number.isFinite(Number(args.split_seed)) ? Math.trunc(Number(args.split_seed)) : 42,
      },
      purpose,
      note: args.note ? String(args.note) : undefined,
    })
    const { dataset, report } = await buildDataset(spec, { id: agentId, kind: 'agent' })
    recordOps({
      actor: agentId,
      actorName: agentBadgeLabel(agentId),
      actorKind: 'agent',
      action: 'aml.dataset.build',
      kind: AML_AUDIT_KIND,
      summary: `构建数据集 ${dataset.id}(行数 ${dataset.rowCount},批次 ${report.runsUsed.length},窗口 train/val/test ${report.windowCount.train}/${report.windowCount.val}/${report.windowCount.test})`,
      targetKind: 'aml_dataset',
      targetId: dataset.id,
      lineId: dataset.lineId,
      productId: dataset.productId,
      recipeId: dataset.recipeId,
    })
    const cleanLines = report.nodeSummaries.map((s) => {
      const c = report.cleaning[s.nodeId]
      return `- ${amlNodeName(s.nodeId)}(${s.nodeId},${s.role}):样本 ${fmtAmlNum(s.count, 0)},剔除率 ${(100 * s.cleanedRatio).toFixed(1)}%(状态 ${c?.droppedState ?? 0}/量程 ${c?.droppedRange ?? 0}/尖峰 ${c?.droppedHampel ?? 0}),插值 ${c?.interpolated ?? 0} 点,缺失率 ${(100 * s.missingRatio).toFixed(1)}%`
    })
    const lagLines = report.lagEstimates.map(l =>
      `- ${amlNodeName(l.controlId)} → ${amlNodeName(l.targetId)}:滞后 ${l.lagSteps} 拍(≈${fmtAmlNum((l.lagSteps * beatMs) / 1000, 1)}s),互相关 ${l.corr.toFixed(2)}`)
    const dropLines = report.runsDropped.map(d => `- ${d.runId}: ${d.reason}`)
    return {
      text: [
        `数据集构建完成:`,
        `  dataset_id: ${dataset.id}`,
        `  三元组: 产线 ${dataset.lineId} / 产品 ${getDcwProductRepo().byId(dataset.productId)?.name ?? dataset.productId} / 配方 ${getDcwRecipeRepo().byId(dataset.recipeId)?.name ?? dataset.recipeId}(purpose=${purpose},beat=${beatMs}ms,history=${historySteps},horizon=${horizonSteps})`,
        `  行数 ${dataset.rowCount} | 窗口 train ${report.windowCount.train} / val ${report.windowCount.val} / test ${report.windowCount.test} | 批次 ${report.runsUsed.length} 个参与构建`,
        cleanLines.length ? `\n逐节点清洗摘要:\n${cleanLines.join('\n')}` : null,
        lagLines.length ? `\n滞后估计(控制→目标,正 = 控制领先;训练/调参时参考):\n${lagLines.join('\n')}` : null,
        dropLines.length ? `\n丢弃批次(${dropLines.length}):\n${dropLines.join('\n')}` : null,
        `\n下一步:aml_dataset_stats { dataset_id: "${dataset.id}" } 看完整统计;确认后 aml_job_submit 提交训练(训练代码契约见该工具说明)。`,
      ].filter(x => x !== null).join('\n'),
    }
  }
  catch (err) {
    return { text: `数据集构建失败:${err instanceof Error ? err.message : String(err)}(常见原因:窗口内无批次打标数据/节点数据缺失率过高;可先 daq_query 确认目标时段数据)。`, isError: true }
  }
}

/** 工具:aml_dataset_stats —— 数据集完整统计报告(逐节点统计/滞后/run 轮廓/窗口计数) */
export async function toolAmlDatasetStats(_agentId: string, args: { dataset_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const datasetId = String(args.dataset_id ?? '').trim()
  if (!datasetId) return amlErr('dataset_id 必填(aml_dataset_build 返回的 id)。')
  const rt = getAmlRuntime()
  const dataset = rt.repo.dataset.get(datasetId)
  if (!dataset) return amlErr(`数据集 ${datasetId} 不存在(aml_node_catalog → aml_dataset_build 先建数据集)。`)
  const spec = (() => {
    try {
      return JSON.parse(dataset.specJson) as { window?: { historySteps?: number, horizonSteps?: number }, beatMs?: number, purpose?: string }
    }
    catch { return {} }
  })()
  const report = amlReportOf(dataset)
  if (!report) {
    return { text: `数据集 ${datasetId} 元数据:行数 ${dataset.rowCount},批次 ${dataset.runIds.length} 个,创建于 ${dataset.createdAt.slice(0, 19).replace('T', ' ')}(统计报告文件缺失,可能为旧版数据集)。` }
  }
  const beatMs = spec.beatMs ?? 1000
  const statLines = report.nodeSummaries.map(s =>
    `- ${amlNodeName(s.nodeId)}(${s.nodeId},${s.role}):n=${fmtAmlNum(s.count, 0)} 均值 ${fmtAmlNum(s.mean)} std ${fmtAmlNum(s.std)} | p05 ${fmtAmlNum(s.p05)} / p50 ${fmtAmlNum(s.p50)} / p95 ${fmtAmlNum(s.p95)} | 缺失率 ${(100 * s.missingRatio).toFixed(1)}% 清洗率 ${(100 * s.cleanedRatio).toFixed(1)}%`)
  const lagLines = report.lagEstimates.map(l =>
    `- ${amlNodeName(l.controlId)} → ${amlNodeName(l.targetId)}:滞后 ${l.lagSteps} 拍(≈${fmtAmlNum((l.lagSteps * beatMs) / 1000, 1)}s),互相关 ${l.corr.toFixed(2)}`)
  const profileLines = report.runProfiles.map(p =>
    `- ${p.runId.slice(0, 8)}: ${p.steps} 拍,目标均值 {${Object.entries(p.targetMeans).map(([k, v]) => `${amlNodeName(k)}=${fmtAmlNum(v, 3)}`).join(', ')}}`)
  return {
    text: [
      `数据集 ${datasetId} 统计报告(beat=${beatMs}ms,history=${spec.window?.historySteps ?? '?'} 拍,horizon=${spec.window?.horizonSteps ?? '?'} 拍,purpose=${spec.purpose ?? '-'})`,
      `  三元组: ${dataset.lineId} / ${dataset.productId} / ${dataset.recipeId} | 行数 ${dataset.rowCount} | 批次 ${dataset.runIds.length}(${report.runsUsed.length} 参与构建)| 创建 ${dataset.createdAt.slice(0, 19).replace('T', ' ')}`,
      statLines.length ? `\n逐节点统计(train 切分):\n${statLines.join('\n')}` : null,
      lagLines.length ? `\n控制→目标滞后(互相关峰值,正 = 控制领先):\n${lagLines.join('\n')}` : null,
      profileLines.length ? `\nrun 轮廓(逐批次目标均值,漂移检测):\n${profileLines.join('\n')}` : null,
      `\n窗口计数:train ${report.windowCount.train} / val ${report.windowCount.val} / test ${report.windowCount.test}(byRun 分层切分,防同批泄漏)`,
      report.runsDropped.length > 0 ? `丢弃批次:\n${report.runsDropped.map(d => `- ${d.runId}: ${d.reason}`).join('\n')}` : null,
      `\n下一步:aml_job_submit { dataset_id: "${datasetId}", code } 提交训练。`,
    ].filter(x => x !== null).join('\n'),
  }
}
