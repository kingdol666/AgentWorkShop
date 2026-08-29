/**
 * IndustrialTools —— Agent 工业工具核心(daq_query / dcw_control)。
 *
 * 权限模型:Agent 只能操作「绑定」给它的节点(node-bindings.repo);
 * 数控下发的安全校验与手动写完全同源(节点全局量程 + 活动配方工艺窗口联锁
 * 在 DcwController.write 内),manual 模式额外经用户批准(可附备注)。
 * 所有工具结果都携带物理语义(参数含义/单位/量程/窗口/回读),让 AI 理解数值。
 */

import type { AgentNodeBinding } from './node-bindings.repo'
import { getAgentNodeBindingRepo } from './node-bindings.repo'
import { getToolApprovals } from './tool-approvals'
import { getDcwController } from '../dcw/dcw-controller'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getActiveLineRun } from '../dcw/line-run'
import { findDcwTemplate } from '../dcw/dcw-templates'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'

/** 数控节点的人类语义摘要(物理含义 + 量程 + 活动配方窗口 + 模式) */
function describeDcwNode(nodeId: string, mode: string): string | null {
  const node = getDcwController().byId(nodeId)
  if (!node) return null
  const tpl = findDcwTemplate(node.templateKey)
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const param = recipe?.params.find(p => p.nodeId === nodeId)
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId)?.name ?? '' : '未分配产线'
  const win = param && (param.min != null || param.max != null)
    ? `活动配方「${recipe!.name}」工艺窗口 ${param.min ?? '-∞'}~${param.max ?? '+∞'}${node.unit}`
    : `无配方窗口约束(全局量程生效)`
  return `- [数控] ${node.name}(${tpl?.ch ?? node.templateKey}):当前设定 ${node.value != null ? node.value : '未下发'}${node.unit},安全量程 ${node.min}~${node.max}${node.unit},${win},所属产线 ${line},控制模式 ${mode === 'manual' ? '手动确认(每次下发需用户批准)' : '自动'}`
}

/** 数采节点的人类语义摘要 */
function describeDaqNode(nodeId: string, mode: string): string | null {
  const node = getDaqNodeRepo().byId(nodeId)
  if (!node) return null
  const tpl = findDaqTemplate(node.templateKey)
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const win = recipe?.daqWindows?.find(w => w.nodeId === nodeId)
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId)?.name ?? '' : '未分配产线'
  const winTxt = win ? `活动配方「${recipe!.name}」监控窗口 ${win.min ?? '-∞'}~${win.max ?? '+∞'}${node.unit}(越限报警)` : '无配方监控窗口'
  return `- [数采] ${node.name}(${tpl?.ch ?? node.templateKey}):当前 ${node.value != null ? node.value : '无数据'}${node.unit},正常量程 ${node.min}~${node.max}${node.unit}(越限即报警),${winTxt},所属产线 ${line},数据模式 ${mode === 'manual' ? '手动确认' : '自动'}`
}

/** 工具:my_industrial_nodes —— 列出 Agent 持有的节点与物理意义/规则 */
export async function toolMyIndustrialNodes(agentId: string): Promise<{ text: string }> {
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  if (bindings.length === 0) {
    return { text: '你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。' }
  }
  const lines: string[] = []
  let staleCount = 0
  for (const b of bindings) {
    const d = b.kind === 'dcw' ? describeDcwNode(b.nodeId, b.mode) : describeDaqNode(b.nodeId, b.mode)
    if (d) lines.push(d)
    else {
      staleCount++
      repo.removeAgentNode(agentId, b.nodeId, b.kind) // 节点已删除 → 绑定失效,自清理
    }
  }
  if (lines.length === 0) return { text: '绑定的节点均已不存在(可能被删除),请重新绑定。' }
  const staleNote = staleCount > 0 ? `\n(另有 ${staleCount} 条失效绑定已自动清理)` : ''
  return {
    text: `你持有 ${lines.length} 个工业节点绑定:\n${lines.join('\n')}${staleNote}\n\n规则:一个 Agent 可绑定多个节点;数控下发用 dcw_control(node_id, value),设定值不得越出安全量程与活动配方工艺窗口(越窗将被联锁拒绝);数据查询用 daq_query(不传 node_id = 查询你全部数采节点),可按产线/产品/配方/时间检索。下发前请确认物理含义与窗口。`,
  }
}

/** 工具:dcw_control —— 数控下发(鉴权 → 停线守卫 → 手动审批 → 安全联锁 → 回读语义结果) */
export async function toolDcwControl(agentId: string, args: { node_id?: string, value?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const nodeId = String(args.node_id ?? '').trim()
  const value = Number(args.value)
  const repo = getAgentNodeBindingRepo()
  const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  if (!binding) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权操作节点 ${nodeId || '(空)'}。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}(可用 my_industrial_nodes 查看物理含义)。`
        : '你尚未绑定任何数控节点,无权下发控制指令。请在数字孪生界面绑定数控节点。',
      isError: true,
    }
  }
  if (!Number.isFinite(value)) {
    return { text: '设定值 value 必须为数字。', isError: true }
  }
  const node = getDcwController().byId(nodeId)
  if (!node) {
    // 节点已被删除 → 绑定失效自清理,提示重新绑定
    repo.removeAgentNode(agentId, nodeId, 'dcw')
    return { text: `数控节点 ${nodeId} 已不存在(可能被删除),原绑定已自动清理,请重新绑定。`, isError: true }
  }
  // 停线守卫:产线未开跑时手动写允许(调试),但提示当前无配方窗口约束
  const tpl = findDcwTemplate(node.templateKey)

  // 手动确认模式:挂起等待用户批准(备注会回给 Agent)
  // 同 Agent 同节点的挂起审批去重:防止审批面板堆积(前一条未决,拒绝新的)
  if (binding.mode === 'manual') {
    const approvals = getToolApprovals()
    if (approvals.hasPendingFor(agentId, nodeId)) {
      return { text: `你对该节点已有一条待审批的下发指令,请等待用户处理后再发新指令(避免审批堆积)。`, isError: true }
    }
    const run = node.lineId ? getActiveLineRun(node.lineId) : null
    const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
    const param = recipe?.params.find(p => p.nodeId === nodeId)
    const detail = `${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit}`
      + (param && (param.min != null || param.max != null) ? `,配方窗口 ${param.min ?? '-∞'}~${param.max ?? '+∞'}${node.unit}` : `,安全量程 ${node.min}~${node.max}${node.unit}`)
    const ap = await approvals.request(agentId, nodeId, 'dcw', detail)
    if (!ap.approved) {
      return { text: `指令未执行:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : `拒绝了本次下发`}。用户备注:${ap.comment || '(无)'}` }
    }
    // 审批期间节点可能被解绑/删除(权限在批准时失效):二次校验
    if (!repo.find(agentId, nodeId, 'dcw')) {
      return { text: '指令未执行:审批通过时你的该节点绑定已被解除(权限在批准时失效)。', isError: true }
    }
  }

  try {
    const outcome = await getDcwController().write(nodeId, value)
    const run = node.lineId ? getActiveLineRun(node.lineId) : null
    const winTxt = run
      ? `当前活动配方「${run.recipeName}」`
      : '当前无活动配方(全局量程约束)'
    if (outcome.ok) {
      return {
        text: `下发成功:${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit} → PLC 原始值 ${outcome.raw ?? '-'};回读 ${outcome.readback != null ? `${outcome.readback}${node.unit}` : '不支持'}一致。${winTxt}。${outcome.message}`,
      }
    }
    return { text: `下发失败:${outcome.message}(节点 ${node.name},物理量 ${tpl?.ch ?? node.templateKey},安全量程 ${node.min}~${node.max}${node.unit})`, isError: true }
  }
  catch (err) {
    return { text: `下发被拒绝:${err instanceof Error ? err.message : String(err)}(节点 ${node.name},物理量 ${tpl?.ch ?? node.templateKey};设定值必须落在安全量程与活动配方工艺窗口内)`, isError: true }
  }
}

/** 工具:daq_query —— 数采数据检索(产线/产品/配方/时间/节点;结果带物理语义) */
export async function toolDaqQuery(agentId: string, args: {
  node_id?: string
  line_id?: string
  product_id?: string
  recipe_id?: string
  last_minutes?: number | string
  from_ms?: number | string
  to_ms?: number | string
  bucket_ms?: number | string
  limit?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  const repo = getAgentNodeBindingRepo()
  const daqBindings = repo.byAgent(agentId).filter(b => b.kind === 'daq')
  if (daqBindings.length === 0) {
    return { text: '你尚未绑定任何数采节点,无权查询采集数据。请在数字孪生界面绑定数采节点。', isError: true }
  }
  const wanted = args.node_id ? String(args.node_id) : ''
  if (wanted && !daqBindings.some(b => b.nodeId === wanted)) {
    return { text: `无权查询节点 ${wanted}。你有权访问的数采节点:${daqBindings.map(b => b.nodeId).join(', ')}`, isError: true }
  }
  const targets = wanted ? [wanted] : daqBindings.map(b => b.nodeId)

  const toMs = Number(args.to_ms) || Date.now()
  const fromMs = Number(args.from_ms) || toMs - (Number(args.last_minutes) || 30) * 60_000
  const bucketMs = Number(args.bucket_ms) || undefined
  const limit = Math.min(Number(args.limit) || 500, 2000)
  const { getTsdb, tsdbReady } = await import('../daq/storage')
  await tsdbReady
  const tsdb = getTsdb()

  const sections: string[] = []
  for (const nodeId of targets) {
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) continue
    const tpl = findDaqTemplate(node.templateKey)
    const ch = tpl?.ch ?? node.templateKey
    try {
      let points: Array<{ at: number, value?: number, avg?: number, min?: number, max?: number, cnt?: number }>
      if (args.product_id || args.recipe_id) {
        const series = await tsdb.queryTagged({
          lineId: node.lineId || undefined,
          productId: args.product_id ? String(args.product_id) : undefined,
          recipeId: args.recipe_id ? String(args.recipe_id) : undefined,
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
      const head = `■ ${node.name}(${ch})单位 ${node.unit},正常量程 ${node.min}~${node.max}${node.unit},当前状态 ${node.state},时间窗 ${new Date(fromMs).toISOString().slice(0, 16)} ~ ${new Date(toMs).toISOString().slice(0, 16)}${bucketMs ? `(降采样 ${bucketMs}ms)` : ''}`
      if (points.length === 0) {
        sections.push(`${head}\n  窗口内无数据(产线未运行或过滤条件不匹配;仅产线运行中的样本被持久化打标)`)
        continue
      }
      const values = points.map(p => p.value ?? p.avg ?? 0).filter(Number.isFinite)
      const latest = values[values.length - 1]!
      const avg = values.reduce((a, b) => a + b, 0) / values.length
      const tail = points.slice(-12).map(p => `${new Date(p.at).toISOString().slice(11, 19)}=${p.value != null ? p.value : `avg ${Number((p.avg ?? 0).toFixed(2))}`}`)
      sections.push(
        `${head}\n  样本 ${values.length} 点 | 最新 ${latest}${node.unit} | 均值 ${Number(avg.toFixed(3))} | 最小 ${Math.min(...values)} | 最大 ${Math.max(...values)}\n  最近序列: ${tail.join('; ')}`,
      )
    }
    catch (err) {
      sections.push(`■ ${node.name}:查询失败 ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const prov = args.product_id || args.recipe_id
    ? `\n(已按${args.product_id ? ` 产品 ${args.product_id}` : ''}${args.recipe_id ? ` 配方 ${args.recipe_id}` : ''}过滤 —— 仅活动批次窗口内逐样本打标的数据)`
    : ''
  return { text: `数采数据查询结果(${targets.length} 个节点):\n\n${sections.join('\n\n')}${prov}\n\n数值均为经标定钩子处理后的真实物理量纲。` }
}
