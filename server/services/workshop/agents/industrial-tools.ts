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
import { nodeSemanticCards } from './industrial-context'
import { getDcwController } from '../dcw/dcw-controller'
import { getActiveLineRun } from '../dcw/line-run'
import { findDcwTemplate } from '../dcw/dcw-templates'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'

export async function toolMyIndustrialNodes(agentId: string): Promise<{ text: string }> {
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  if (bindings.length === 0) {
    return { text: '你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。' }
  }
  const cards = nodeSemanticCards(agentId)
  if (cards.stale > 0) repo.removeAgentNodeStale(agentId, bindings.filter((b) => {
    const has = b.kind === 'dcw' ? !!getDcwController().byId(b.nodeId) : !!getDaqNodeRepo().byId(b.nodeId)
    return !has
  }).map(b => b.id))
  if (!cards.text) return { text: '绑定的节点均已不存在(可能被删除),请重新绑定。' }
  const staleNote = cards.stale > 0
    ? `
(另有 ${cards.stale} 条失效绑定已自动清理)`
    : ''
  return {
    text: `${cards.text}${staleNote}

---
通用规则:
1. 一个 Agent 可绑定多个节点;先读本清单理解每个节点的物理意义与操作守则,再动手。
2. 数控下发 dcw_control(node_id, value):目标值必须落在「安全量程 ∩ 活动配方工艺窗口」;单次调幅建议按语义卡的步进指引。
3. 数据获取 daq_query(不传 node_id = 全部数采节点),支持按产线/产品/配方/时间检索;解读数据时结合语义卡的判读方法。
4. 改动设定后等待工艺响应(热惯性/传动惯量)再评估,避免连续大幅调整。`,
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
    // 失败文案带自我纠正线索:当前保持原值 + 建议动作(缩小步进/稍后重试)
    const keptHint = `当前设定值保持 ${node.value ?? '原值'}${node.unit} 未被改动`
    const retryHint = /忙|busy/i.test(outcome.message) ? '链路忙属瞬时状态,可稍后重试' : '可缩小步进幅度后重试'
    return { text: `下发失败:${outcome.message}(节点 ${node.name},物理量 ${tpl?.ch ?? node.templateKey},安全量程 ${node.min}~${node.max}${node.unit};${keptHint};${retryHint})`, isError: true }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const retryHint = /忙|busy/i.test(msg) ? '链路忙属瞬时状态,可稍后重试' : '设定值必须落在安全量程与活动配方工艺窗口内'
    return { text: `下发被拒绝:${msg}(节点 ${node.name},物理量 ${tpl?.ch ?? node.templateKey};${retryHint})`, isError: true }
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
  // line_id 过滤(工具契约声明了该参数):按节点归属产线收敛目标集;
  // 权限仍以绑定为先 —— line_id 只能缩小范围,不能放大
  const lineFilter = args.line_id ? String(args.line_id).trim() : ''
  const lineOf = (id: string): string => getDaqNodeRepo().byId(id)?.lineId ?? ''
  if (lineFilter && wanted && lineOf(wanted) !== lineFilter) {
    return {
      text: `节点 ${wanted} 不属于产线 ${lineFilter}(实际归属:${lineOf(wanted) || '未分配'}),line_id 与 node_id 过滤冲突。`,
      isError: true,
    }
  }
  let targets = wanted ? [wanted] : daqBindings.map(b => b.nodeId)
  if (lineFilter && !wanted) {
    const onLine = targets.filter(id => lineOf(id) === lineFilter)
    if (onLine.length === 0) {
      return {
        text: `你绑定的数采节点中没有归属产线 ${lineFilter} 的(各节点归属:${daqBindings.map(b => `${b.nodeId}=${lineOf(b.nodeId) || '未分配'}`).join('; ')})。`,
      }
    }
    targets = onLine
  }

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
  const prov = (args.product_id || args.recipe_id || lineFilter)
    ? `\n(过滤条件:${lineFilter ? ` 产线 ${lineFilter}` : ''}${args.product_id ? ` 产品 ${args.product_id}` : ''}${args.recipe_id ? ` 配方 ${args.recipe_id}` : ''}${(args.product_id || args.recipe_id) ? ' —— 产品/配方过滤基于活动批次窗口内逐样本打标' : ''})`
    : ''
  return { text: `数采数据查询结果(${targets.length} 个节点):\n\n${sections.join('\n\n')}${prov}\n\n数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。` }
}
