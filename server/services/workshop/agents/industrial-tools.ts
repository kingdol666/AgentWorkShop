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
import { agentBadgeLabel } from './agent-badge'
import { getDcwController } from '../dcw/dcw-controller'
import { getActiveLineRun } from '../dcw/line-run'
import { findDcwTemplate } from '../dcw/dcw-templates'
import { daqRuntimeSettings } from '../settings'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'
import { getRecipeRollBackManager } from '../dcw/recipe-rollback-manager'
import { getOps, recordOps } from '../ops/ops'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getDcwProductRepo } from '../dcw/dcw-product.repo'
import { getDcwRecipeRepo } from '../dcw/dcw-recipe.repo'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAmlRuntime } from '../aml/runtime'
import { parseDatasetSpec } from '../aml/spec'
import { buildDataset, type AmlDatasetReport } from '../aml/dataset-builder'
import { cancelJob, jobLogsTail, runtimeStatus, submitJob } from '../aml/job-orchestrator'
import { transitionModel } from '../aml/model-registry'
import { predictProduction, readIoSpecFor } from '../aml/predictor'
import { alignToGrid } from '../aml/clean'
import type { AmlDatasetRow, AmlJobRow } from '../aml/aml.repo'

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
  // 调控闭环洞察:每个数控节点的 open 优化记录 / lastGood / 最近判定(Agent 驱动的状态面)
  const rb = getRecipeRollBackManager()
  const insights: string[] = []
  for (const b of bindings.filter(x => x.kind === 'dcw')) {
    try {
      const ins = rb.nodeInsight(b.nodeId)
      const parts: string[] = []
      if (ins.openRecord)
        parts.push(`进行中优化 ${ins.openRecord.id}: ${ins.openRecord.params[0]?.from ?? '?'}→${ins.openRecord.params[0]?.to}(setAt ${ins.openRecord.setAt.slice(11, 19)},policy=${ins.openRecord.policy})`)
      if (ins.lastGood != null)
        parts.push(`上次良好值 ${ins.lastGood}`)
      for (const j of ins.recentJudges.slice(0, 1))
        parts.push(`最近判定 ${j.verdict}(${j.by}):${j.reason.slice(0, 60)}`)
      if (parts.length > 0)
        insights.push(`- ${b.nodeId}: ${parts.join(';')}`)
    }
    catch { /* 节点刚被删等情况忽略 */ }
  }
  const insightBlock = insights.length > 0 ? `\n\n调控闭环状态:\n${insights.join('\n')}` : ''
  return {
    text: `${cards.text}${staleNote}${insightBlock}

---
通用规则:
1. 一个 Agent 可绑定多个节点;先读本清单理解每个节点的物理意义与操作守则,再动手。
2. 数控下发 dcw_control(node_id, value):目标值必须落在「安全量程 ∩ 活动配方工艺窗口」;单次调幅建议按语义卡的步进指引。下发前/后用 dcw_read(node_id) 读 PLC 当前值取证复核(被动观测免审批)。
3. 数据获取 daq_query(不传 node_id = 全部数采节点),支持按产线/产品/配方/时间检索;解读数据时结合语义卡的判读方法。
4. 改动设定后等待工艺响应(热惯性/传动惯量)再评估,避免连续大幅调整。
5. 调控闭环:每次下发自动开一条优化记录(open);观察数采后用 dcw_judge 落判定(keep/rollback/uncertain);
   判 rollback 后用 dcw_rollback 执行回退;dcw_journal 可查节点参数变更史。未判定前再下发,旧记录会被标记 superseded。
   若节点被他人的 open 记录阻塞(对方已消失),超时(30 分钟)后你可接管:dcw_judge 会带接管标记入册。
6. 自查面:line_context 看你控制的产线/产品/配方全景(动手前必读,确认归属);
   ops_log 查你负责产线的运维日志(谁/何时做了什么,来源区分 Agent/用户/系统;
   参数 line_id/node_id/kind/actor_kind/minutes/limit/mine);recipe_log 查配方下发与回退事件;
   recipe_versions 查配方参数版本史(谁改的/为什么/参数 diff)。
7. 配方操控闭环(在线优化框架):验证过参数更优 → recipe_update 保存进配方(记录你的名字与原因,
   生成新版本);发现优化有问题 → recipe_rollback 回退到稳定版本(version)或已知良好批次
   (to_last_good=true);运行中 PLC 当前值用 dcw_control 下发,配方定义供后续批次生效。`,
  }
}

/** 工具:dcw_control —— 数控下发(鉴权 → 停线守卫 → 手动审批 → 安全联锁 → 回读语义结果)。
 *  调控闭环:下发自动开优化记录;args.hypothesis 声明本次假设(入册),args.task_id 关联任务。 */
export async function toolDcwControl(agentId: string, args: { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string }): Promise<{ text: string, isError?: boolean }> {
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
  // 停用/解绑守卫:停用节点拒绝下发(与手动/配方同源语义,给出恢复路径)
  if (!node.enabled) {
    return { text: `节点「${node.name}」已停用(控制已暂停),无法下发。请先让用户在产线/数采界面恢复该节点的控制,或改派其他节点。`, isError: true }
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
    const meta = {
      source: 'agent' as const,
      actor: agentId,
      // 人话操作者:「Channel名/成员名」——/logs 来源=Agent 与用户/系统操作可区分追溯
      actorName: agentBadgeLabel(agentId),
      taskId: args.task_id ? String(args.task_id) : undefined,
      hypothesis: args.hypothesis ? String(args.hypothesis) : '',
    }
    const outcome = await getDcwController().write(nodeId, value, null, meta)
    const run = node.lineId ? getActiveLineRun(node.lineId) : null
    const winTxt = run
      ? `当前活动配方「${run.recipeName}」`
      : '当前无活动配方(全局量程约束)'
    if (outcome.ok) {
      // 调控闭环回包:记录 id + 上一稳定锚 + 策略提示(安全网信息,Agent 据此规划判定)
      const rb = getRecipeRollBackManager()
      const stable = rb.journal({ nodeId, limit: 10 }).find(a => a.prevValue != null && a.prevValue !== a.newValue)
      const policyHint = binding.mode === 'manual'
        ? '本节点为手动确认模式:判定回退将推请用户确认'
        : '本节点为自动模式:越配方监控窗将触发系统自动回退'
      const loopTxt = [
        outcome.recordId ? `优化记录 ${outcome.recordId} 已开窗(观察数采后 dcw_judge 落判定)` : null,
        stable ? `上一稳定锚:${stable.prevValue}${node.unit}(可 dcw_rollback 回退)` : null,
        policyHint,
      ].filter(Boolean).join(';')
      return {
        text: `下发成功:${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit} → PLC 原始值 ${outcome.raw ?? '-'};回读 ${outcome.readback != null ? `${outcome.readback}${node.unit}` : '不支持'}一致。${winTxt}。${outcome.message}\n[调控闭环] ${loopTxt}`,
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

/** 工具:dcw_read —— 读取数控节点的 PLC 当前值(读写集成的读半边;被动观测免审批)。
 *  返回 PLC 实时读数(标定解码后的物理量)与当前设定值对照,供下发前取证/下发后复核。 */
export async function toolDcwRead(agentId: string, args: { node_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const nodeId = String(args.node_id ?? '').trim()
  const repo = getAgentNodeBindingRepo()
  const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  if (!binding) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权读取节点 ${nodeId || '(空)'}。你有权读取的数控节点:${mine.map(b => b.nodeId).join(', ')}。`
        : '你尚未绑定任何数控节点,无权读取控制通道数据。请在数字孪生界面绑定数控节点。',
      isError: true,
    }
  }
  const node = getDcwController().byId(nodeId)
  if (!node) {
    repo.removeAgentNode(agentId, nodeId, 'dcw')
    return { text: `数控节点 ${nodeId} 已不存在(可能被删除),原绑定已自动清理,请重新绑定。`, isError: true }
  }
  const tpl = findDcwTemplate(node.templateKey)
  try {
    const read = await getDcwController().readNow(nodeId)
    if (!read.ok && read.value == null && !node.readValue) {
      return { text: `读取失败:${read.message}(节点 ${node.name},驱动 ${node.driver} 可能不支持读取;可改用 daq_query 查关联数采通道)`, isError: true }
    }
    const setTxt = node.value != null ? `${node.value}${node.unit}` : '从未下发'
    const readTxt = read.value != null
      ? `${Number(read.value.toFixed(node.decimals))}${node.unit}`
      : (node.readValue != null ? `${node.readValue}${node.unit}(最近一次)` : '无读数')
    const devTxt = read.value != null && node.value != null
      ? (Math.abs(read.value - node.value) < writeToleranceOf(node)
          ? '读数与设定一致(设定已生效)'
          : '读数与设定存在偏差(可能工艺在响应或被本地修改)')
      : '设定与读数暂不可对照'
    return {
      text: `读取成功:${node.name}(${tpl?.ch ?? node.templateKey})\n  PLC 读数(ACT): ${readTxt} @ ${read.at.slice(11, 19)}\n  当前设定(SET): ${setTxt}\n  对照: ${devTxt}${read.raw != null ? `\n  原始值(raw): ${Number(read.raw.toFixed(4))}` : ''}`,
    }
  }
  catch (err) {
    return { text: `读取被拒绝:${err instanceof Error ? err.message : String(err)}(节点 ${node.name})`, isError: true }
  }
}

/** 读/设定偏差对照容差(与服务端回读死区同口径) */
function writeToleranceOf(node: { decimals: number, min: number, max: number }): number {
  return Math.max(0.5 * 10 ** -node.decimals, (node.max - node.min) * 0.005)
}

/**
 * 数采目标集解析(工具共用鉴权面):Agent 绑定(kind=daq)为权限边界 ——
 * node_id/line_id 只能缩小范围,不能放大(越权节点一律拒绝)。
 */
function daqTargetsOf(agentId: string, nodeIdArg: unknown, lineIdArg: unknown):
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

/**
 * 写向工具的统一鉴权闸门(绑定必查)。
 *
 * 背景:dcw_control / dcw_read 各自抄了一份 `repo.find(agentId, nodeId, 'dcw')` 判定,
 * 而 dcw_rollback / dcw_judge 的「接管孤儿记录」分支忘了这一步 —— 任何 agent(哪怕
 * 零绑定)都能借 record_id 或超时接管,驱动真实 PLC 执行回退。这是权限模型里的
 * **默认放行**,与 node-bindings.repo 自述的「未绑定节点一律拒绝」直接冲突。
 * 收敛为单一入口后,新增写向工具不会再漏。
 *
 * @returns 命中返回绑定对象;未命中返回可直接回给模型的拒绝文本(isError)
 */
function requireDcwBinding(agentId: string, nodeId: string, action: string): { binding: AgentNodeBinding } | { error: { text: string, isError: true } } {
  const repo = getAgentNodeBindingRepo()
  const binding = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  if (binding) return { binding }
  const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
  return {
    error: {
      text: mine.length
        ? `无权${action}节点 ${nodeId || '(空)'}。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}(可用 my_industrial_nodes 查看物理含义)。`
        : `你尚未绑定任何数控节点,无权${action}。请在数字孪生界面绑定数控节点。`,
      isError: true,
    },
  }
}

/** 工具:dcw_judge —— 对自己的优化记录落判定(keep/rollback/uncertain)。
 *  判定与执行分离:rollback 判定只入册,执行必须再调 dcw_rollback。
 *  鉴权:记录所属节点必须仍在你的 dcw 绑定内 —— 接管孤儿记录同样受此约束。 */
export async function toolDcwJudge(agentId: string, args: { record_id?: string, verdict?: string, reason?: string }): Promise<{ text: string, isError?: boolean }> {
  const recordId = String(args.record_id ?? '').trim()
  const verdict = String(args.verdict ?? '').trim() as 'keep' | 'rollback' | 'uncertain'
  const reason = String(args.reason ?? '').trim()
  if (!recordId)
    return { text: 'record_id 必填(优化记录 id,dcw_control 下发成功后会返回)。', isError: true }
  if (!['keep', 'rollback', 'uncertain'].includes(verdict))
    return { text: 'verdict 必须为 keep / rollback / uncertain。', isError: true }
  if (!reason)
    return { text: 'reason 必填:判定必须引用数采证据(建议先 daq_query 取窗口数据再判定)。', isError: true }
  const rb = getRecipeRollBackManager()
  const record = rb.recordById(recordId)
  if (!record)
    return { text: `优化记录 ${recordId} 不存在。`, isError: true }
  const takeover = record.agentId !== agentId && rb.isStale(record)
  if (record.agentId !== agentId && !takeover)
    return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),Agent 仅可判定自己的记录;他人记录请请用户在界面判定。`, isError: true }
  // 接管是「时间」判定,不是「权限」判定 —— 权限必须单独查绑定(早先漏了这一步)
  const auth = requireDcwBinding(agentId, record.nodeId, '判定该记录')
  if ('error' in auth) return auth.error
  try {
    const finalReason = takeover ? `[接管孤儿记录,原属主 ${record.agentId ?? '?'} 超时未判定] ${reason}` : reason
    const updated = rb.judge(recordId, verdict, finalReason, 'agent', agentId, { takeover, actorName: agentBadgeLabel(agentId) })
    const next = verdict === 'rollback'
      ? '判定已入册;请立即用 dcw_rollback(record_id) 执行回退(判定不自动改 PLC)。'
      : verdict === 'keep'
        ? `已定档为已验证经验${updated.recipeId ? '(配方已标记 lastGood)' : ''}。`
        : '记录保持 open,继续观察或等下次设定关闭。'
    return { text: `判定已入册:记录 ${recordId} → ${verdict}(${reason})。${next}` }
  }
  catch (err) {
    return { text: `判定失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:dcw_rollback —— 执行回退(自己的记录直接执行;他人记录需用户在界面执行)。
 *  鉴权:节点必须绑定给该 agent(record_id 路径先解析出 record.nodeId);
 *  manual 模式绑定与 dcw_control 同源 —— 回退也会改 PLC,必须推请用户确认。
 *  args: record_id(回退该记录到其 from 值)或 node_id(单步撤销到最近稳定锚);to = 指定目标锚。 */
export async function toolDcwRollback(agentId: string, args: { record_id?: string, node_id?: string, to?: string }): Promise<{ text: string, isError?: boolean }> {
  const rb = getRecipeRollBackManager()
  const recordId = String(args.record_id ?? '').trim()
  const nodeId = String(args.node_id ?? '').trim()
  const to = String(args.to ?? '').trim() || undefined
  if (!recordId && !nodeId)
    return { text: 'record_id 或 node_id 至少提供一个。', isError: true }
  try {
    // 归属解析:record_id 路径的节点来自记录本身,node_id 路径直接用入参
    const record = recordId ? rb.recordById(recordId) : undefined
    if (recordId && !record)
      return { text: `优化记录 ${recordId} 不存在。`, isError: true }
    const targetNodeId = record?.nodeId ?? nodeId
    if (record) {
      const takeover = record.agentId !== agentId && rb.isStale(record)
      if (record.agentId !== agentId && !takeover)
        return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),回退他人记录请请用户在数采中心/产线详情执行;若原属主已消失(超时未判定),可先 dcw_judge 接管后再回退。`, isError: true }
    }
    // 授权闸门(早先整段缺失 → 任意 agent 可回退任意节点)
    const auth = requireDcwBinding(agentId, targetNodeId, '回退')
    if ('error' in auth) return auth.error
    // manual 模式:回退是真实 PLC 写入,与 dcw_control 同源推请用户批准
    if (auth.binding.mode === 'manual') {
      const node = getDcwController().byId(targetNodeId)
      const approvals = getToolApprovals()
      if (approvals.hasPendingFor(agentId, targetNodeId))
        return { text: '你对该节点已有一条待审批指令,请等待用户处理后再发新的回退请求(避免审批堆积)。', isError: true }
      const detail = `${node?.name ?? targetNodeId} 回退到${record ? `记录 ${recordId} 的 from 值` : '最近稳定锚'}${to ? `(${to})` : ''}`
      const ap = await approvals.request(agentId, targetNodeId, 'dcw', detail)
      if (!ap.approved) {
        return { text: `回退未执行:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : '拒绝了本次回退'}。用户备注:${ap.comment || '(无)'}` }
      }
      // 审批期间绑定可能已被解除:批准时二次校验(与 dcw_control 同口径)
      if (!getAgentNodeBindingRepo().find(agentId, targetNodeId, 'dcw'))
        return { text: '回退未执行:审批通过时你的该节点绑定已被解除(权限在批准时失效)。', isError: true }
    }
    if (record) {
      const fresh = await rb.rollbackRecord(recordId, agentId, 'agent', undefined, { actorName: agentBadgeLabel(agentId) })
      return { text: `回退已执行:记录 ${recordId} 标记 rolled-back;下发恢复值 ${fresh?.params[0]?.to}${'(以回读为准)'};新回退记录 ${fresh?.id} 已入册。请 daq_query 复测确认恢复。` }
    }
    const fresh = await rb.rollbackNode(targetNodeId, agentId, 'agent', to, { actorName: agentBadgeLabel(agentId) })
    return { text: `节点单步回退已执行:恢复到最近稳定锚值;新回退记录 ${fresh?.id} 已入册。请 daq_query 复测确认恢复。` }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `回退被拒绝:${msg}(回退经与下发相同的安全门控;冷却期内禁止重复回退)`, isError: true }
  }
}

/** 工具:dcw_journal —— 参数变更史/优化记录查询(在册审计;谁/何时/从多少到多少/判定) */
export async function toolDcwJournal(agentId: string, args: { node_id?: string, recipe_id?: string, limit?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const rb = getRecipeRollBackManager()
  const nodeId = String(args.node_id ?? '').trim()
  const recipeId = String(args.recipe_id ?? '').trim()
  const limit = Math.min(Number(args.limit) || 20, 100)
  const repo = getAgentNodeBindingRepo()
  const bound = new Set(repo.byAgent(agentId).map(b => b.nodeId))
  if (nodeId && !bound.has(nodeId))
    return { text: `无权查询节点 ${nodeId} 的账本(仅可查自己绑定的节点)。`, isError: true }
  const records = rb.records({ nodeId: nodeId || undefined, recipeId: recipeId || undefined, limit })
  if (records.length === 0)
    return { text: '窗口内无优化记录(该节点/配方尚无 Agent 调控历史)。' }
  const lines = records.map((r) => {
    const p = r.params[0]
    const judge = r.judge ? `${r.judge.verdict}(${r.judge.by}:${r.judge.reason.slice(0, 50)})` : '未判定'
    const closed = r.closedAt ? `,关闭于 ${r.closedAt.slice(11, 19)}(${r.closedBy})` : ',进行中'
    return `- ${r.id} [${r.status}] ${r.nodeName}: ${p?.from ?? '?'} → ${p?.to},设定 ${r.setAt.slice(11, 19)},判定 ${judge}${closed}${r.hypothesis ? `\n  假设: ${r.hypothesis.slice(0, 80)}` : ''}`
  })
  const anchors = nodeId ? rb.journal({ nodeId, limit }) : []
  const anchorLines = anchors.slice(0, 10).map(a => `- ${a.at.slice(11, 19)} [${a.source}/${a.actor}] ${a.prevValue ?? '?'} → ${a.newValue}`)
  return {
    text: `优化记录(${records.length} 条,含参数/判定/窗口):\n${lines.join('\n')}${nodeId ? `\n\n参数变更锚(最近 ${anchorLines.length} 条):\n${anchorLines.join('\n')}` : ''}\n\n判定与执行分离:rollback 判定后需 dcw_rollback 执行;回退同样入册可审计。`,
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
}): Promise<{ text: string, isError?: boolean }> {
  const auth = daqTargetsOf(agentId, args.node_id, args.line_id)
  if ('error' in auth) return auth.error
  const { targets } = auth
  const kind = args.kind === 'vector' || args.kind === 'image' ? args.kind : undefined
  const toMs = Number(args.to_ms) || Date.now()
  const fromMs = Number(args.from_ms) || toMs - (Number(args.last_minutes) || 30) * 60_000
  const limit = Math.min(Number(args.limit) || 20, 100)
  const { getTsdb, tsdbReady } = await import('../daq/storage')
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

// ================================================================
// 运维日志 / Recipe 变更史查询(Agent 自查面:负责产线 scoped)
// ================================================================

/** Agent 负责范围 = 绑定节点的全集(节点 id 集 + 这些节点所属产线集);无绑定 = 无范围 */
function agentOpsScope(agentId: string): { lineIds: string[], nodeIds: Set<string> } | null {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  if (bindings.length === 0) return null
  const lineIds = new Set<string>()
  const nodeIds = new Set<string>()
  for (const b of bindings) {
    nodeIds.add(b.nodeId)
    try {
      const n = b.kind === 'dcw' ? getDcwController().byId(b.nodeId) : getDaqNodeRepo().byId(b.nodeId)
      if (n?.lineId) lineIds.add(n.lineId)
    }
    catch { /* 节点刚被删等情况忽略 */ }
  }
  return { lineIds: [...lineIds], nodeIds }
}

/** 配方参数的节点失效态(数据一致性展示/Agent 提示共用):null=正常 */
function nodeRefStatus(nodeId: string, lineId: string): { code: 'deleted' | 'disabled' | 'unbound', label: string } | null {
  const node = getDcwController().byId(nodeId)
  if (!node) return { code: 'deleted', label: '已删除' }
  if (!node.enabled) return { code: 'disabled', label: '已停用' }
  if (node.lineId !== lineId) return { code: 'unbound', label: '已取消绑定' }
  return null
}

const OPS_ACTOR_LABEL: Record<string, string> = { agent: 'Agent', user: '用户', system: '系统' }

function fmtAuditAt(iso: string): string {
  return iso.length >= 19 ? iso.slice(5, 19).replace('T', ' ') : iso
}

/** 工具:ops_log —— 负责产线的运维/审计日志查询(全部下发/判定/回退/配方/产线事件)。
 *  权限:仅自己绑定节点所覆盖的产线;node_id 须为绑定节点。来源(actor_kind)区分 Agent/用户/系统。 */
export async function toolOpsLog(agentId: string, args: {
  line_id?: string
  node_id?: string
  kind?: string
  actor_kind?: string
  minutes?: number | string
  limit?: number | string
  mine?: boolean | string
}): Promise<{ text: string, isError?: boolean }> {
  const audit = getOps()?.audit
  if (!audit) return { text: '审计仓储未装配(服务未就绪),请稍后重试。', isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,无日志可查(日志权限跟随节点绑定)。', isError: true }
  const nodeId = String(args.node_id ?? '').trim()
  const lineId = String(args.line_id ?? '').trim()
  if (nodeId && !scope.nodeIds.has(nodeId))
    return { text: `无权查询节点 ${nodeId} 的日志(仅可查自己绑定的节点;用 my_industrial_nodes 查看绑定)。`, isError: true }
  if (lineId && !scope.lineIds.includes(lineId))
    return { text: `无权查询产线 ${lineId} 的日志(你的负责产线:${scope.lineIds.join(', ') || '(绑定节点均未分配产线)'})。`, isError: true }
  const kind = String(args.kind ?? '').trim() || undefined
  const actorKind = String(args.actor_kind ?? '').trim() || undefined
  const mine = args.mine === true || args.mine === 'true'
  const minutes = Number(args.minutes) || 1440
  const limit = Math.min(Number(args.limit) || 20, 100)
  const from = new Date(Date.now() - minutes * 60_000).toISOString()

  const lines = lineId ? [lineId] : scope.lineIds
  const byId = new Map<string, Record<string, unknown>>()
  for (const lid of lines) {
    for (const r of audit.query({ lineId: lid, kind, actorKind, actor: mine ? agentId : undefined, from, limit }))
      byId.set(String(r.id), r)
  }
  let rows = [...byId.values()]
  if (nodeId) rows = rows.filter(r => r.targetId === nodeId)
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  rows = rows.slice(0, limit)
  if (rows.length === 0) return { text: `窗口(近 ${minutes} 分钟)内无匹配日志。可调大 minutes,或放宽 kind/actor_kind/node_id 过滤。` }

  const body = rows.map((r) => {
    const src = OPS_ACTOR_LABEL[String(r.actorKind)] ?? String(r.actorKind)
    return `- [${fmtAuditAt(String(r.at))}] 来源=${src} 操作者=${String(r.actorName) || String(r.actor)} | ${String(r.action)} | ${String(r.summary)}`
  })
  const scopeNote = lineId ? `产线 ${lineId}` : `负责产线 ${scope.lineIds.length} 条`
  return {
    text: `运维日志(${scopeNote},近 ${minutes} 分钟,${rows.length} 条,新→旧):\n${body.join('\n')}\n\n说明:来源=Agent 的操作者格式为「Channel名/成员名」;需要节点级参数值变更史用 dcw_journal,配方下发/回退专门视图用 recipe_log。`,
  }
}

/** 工具:recipe_log —— 负责产线的配方下发与回退历史(recipe.apply + 优化开窗/判定/回退)。
 *  Agent 据此知道 Recipe 层面发生过哪些下发变更、谁做的、是否已回退。 */
export async function toolRecipeLog(agentId: string, args: {
  line_id?: string
  recipe_id?: string
  minutes?: number | string
  limit?: number | string
}): Promise<{ text: string, isError?: boolean }> {
  const audit = getOps()?.audit
  if (!audit) return { text: '审计仓储未装配(服务未就绪),请稍后重试。', isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,无 Recipe 历史可查(权限跟随节点绑定)。', isError: true }
  const lineId = String(args.line_id ?? '').trim()
  if (lineId && !scope.lineIds.includes(lineId))
    return { text: `无权查询产线 ${lineId} 的 Recipe 历史(你的负责产线:${scope.lineIds.join(', ') || '(无)'})。`, isError: true }
  const recipeId = String(args.recipe_id ?? '').trim() || undefined
  const minutes = Number(args.minutes) || 1440
  const limit = Math.min(Number(args.limit) || 20, 100)
  const from = new Date(Date.now() - minutes * 60_000).toISOString()

  const lines = lineId ? [lineId] : scope.lineIds
  const byId = new Map<string, Record<string, unknown>>()
  for (const lid of lines) {
    for (const kind of ['recipe', 'rollback']) {
      for (const r of audit.query({ lineId: lid, kind, recipeId, from, limit }))
        byId.set(String(r.id), r)
    }
  }
  const rows = [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
  if (rows.length === 0) return { text: `窗口(近 ${minutes} 分钟)内无配方下发/回退记录。可调大 minutes 或换 line_id。` }

  const body = rows.map((r) => {
    const src = OPS_ACTOR_LABEL[String(r.actorKind)] ?? String(r.actorKind)
    const action = String(r.action)
    const tag = action === 'recipe.apply'
      ? '配方下发'
      : action === 'optimization.open'
        ? '优化开窗'
        : action === 'optimization.judge'
          ? '优化判定'
          : action === 'optimization.rollback'
            ? '回退执行'
            : action
    return `- [${fmtAuditAt(String(r.at))}] ${tag} 来源=${src} 操作者=${String(r.actorName) || String(r.actor)} | ${String(r.summary)}${r.recipeId ? `(配方 ${String(r.recipeId).slice(0, 8)})` : ''}`
  })
  return {
    text: `Recipe 变更史(${lineId ? `产线 ${lineId}` : `负责产线 ${scope.lineIds.length} 条`},近 ${minutes} 分钟,${rows.length} 条,新→旧):\n${body.join('\n')}\n\n说明:配方下发=整批参数写命令;优化开窗=单次设定变更(含 Agent 假设);回退执行=已恢复基线值。节点级参数值逐笔历史用 dcw_journal(node_id)。`,
  }
}

// ================================================================
// 产线上下文 + Recipe 版本管理(Agent 操控闭环:知道改什么 → 保存 → 可回退)
// ================================================================

/** 工具:line_context —— 我控制的产线/产品/Recipe 全景(归属认知 + 完整参数面)。
 *  逐产线输出:产线名/运行态、活动批次(产品/配方/版本/参数)、我的节点绑定、
 *  配方目标 vs PLC 当前值对照、lastGood 批次。 */
export async function toolLineContext(agentId: string, args: { line_id?: string } = {}): Promise<{ text: string, isError?: boolean }> {
  const scope = agentOpsScope(agentId)
  if (!scope) return { text: '你尚未绑定任何工业节点,暂无产线上下文(请先在数字孪生界面绑定节点)。' }
  const wanted = String(args.line_id ?? '').trim()
  const lineIds = wanted ? [wanted] : scope.lineIds
  if (wanted && !scope.lineIds.includes(wanted)) {
    return { text: `产线 ${wanted} 不在你的负责范围(你绑定节点覆盖的产线:${scope.lineIds.join(', ') || '无'})。`, isError: true }
  }
  if (lineIds.length === 0) return { text: '你绑定的节点均未分配产线(未挂线的节点没有产线/产品/配方上下文)。' }

  const sections: string[] = []
  for (const lid of lineIds) {
    const line = getDcwLineRepo().byId(lid)
    const run = getActiveLineRun(lid)
    const recipe = run?.recipeId ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
    const parts: string[] = []
    parts.push(`■ 产线 ${line?.name ?? lid}(${lid})· 状态:${run ? '运行中' : '待机/停线'}`)
    if (run) {
      parts.push(`  活动批次 ${run.runId.slice(0, 8)} · 产品「${run.productName}」(${run.productId}) · 开跑 ${run.startedAt.slice(11, 19)} · 已打标 ${run.taggedSamples} 样本`)
    }
    const myDcw = getAgentNodeBindingRepo().byAgent(agentId)
      .filter(b => b.kind === 'dcw')
      .map(b => getDcwController().byId(b.nodeId))
      .filter(n => n?.lineId === lid)
    const myDaq = getAgentNodeBindingRepo().byAgent(agentId)
      .filter(b => b.kind === 'daq')
      .map(b => getDaqNodeRepo().byId(b.nodeId))
      .filter(n => n?.lineId === lid)
    parts.push(`  我绑定的节点:数控 [${myDcw.map(n => n!.name).join(', ') || '无'}];数采 [${myDaq.map(n => n!.name).join(', ') || '无'}]`)
    if (recipe) {
      parts.push(`  配方「${recipe.name}」(${recipe.id}) v${recipe.version ?? 1}${recipe.description ? ` — ${recipe.description}` : ''}`)
      for (const p of recipe.params) {
        const node = getDcwController().byId(p.nodeId)
        const mine = myDcw.some(n => n!.id === p.nodeId)
        const stale = nodeRefStatus(p.nodeId, recipe.lineId)
        const staleTag = stale ? ` [${stale.label},参数不下发]` : ''
        const cur = node?.value != null ? node.value : '?'
        const win = p.min != null || p.max != null ? `(窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'})` : ''
        parts.push(`    · ${node?.name ?? p.nodeId} = ${p.value}${node?.unit ?? ''}${win} | PLC 当前 ${cur}${node?.unit ?? ''}${mine ? ' [我负责]' : ''}${staleTag}`)
      }
      const good = recipe.lastGoodRunId ? getDcwRecipeRepo().runById(recipe.lastGoodRunId) : undefined
      parts.push(`  已知良好批次:${good ? `${good.id.slice(0, 8)}(${good.startedAt.slice(0, 19).replace('T', ' ')})` : '未标记'};当前参数版本 v${recipe.version ?? 1}`)
    }
    else {
      // 无活动批次:列出该产线的配方定义(产线未开跑也有配方上下文)
      const lineRecipes = getDcwController().listRecipes().filter(r => r.lineId === lid).slice(0, 3)
      if (lineRecipes.length === 0) {
        parts.push('  当前无活动配方(产线未开跑;该产线也暂无配方定义)')
      }
      else {
        parts.push(`  当前无活动批次;产线已有 ${lineRecipes.length} 个配方定义(开跑时绑定):`)
        for (const r of lineRecipes) {
          const product = r.productId ? getDcwProductRepo().byId(r.productId) : undefined
          const pp = r.params.map((p) => {
            const node = getDcwController().byId(p.nodeId)
            const cur = node?.value != null ? node.value : '?'
            const stale = nodeRefStatus(p.nodeId, r.lineId)
            const tag = stale ? `[${stale.label},参数不下发]` : ''
            return `${node?.name ?? p.nodeId}=${p.value}${node?.unit ?? ''}(PLC 当前 ${cur})${tag}`
          }).join(', ')
          parts.push(`    · 配方「${r.name}」(${r.id}) v${r.version ?? 1} · 产品「${product?.name ?? r.productId}」: ${pp}${r.lastGoodRunId ? ` [良好批次 ${r.lastGoodRunId.slice(0, 8)}]` : ''}`)
        }
      }
    }
    sections.push(parts.join('\n'))
  }
  return {
    text: `你控制的产线全景(${sections.length} 条):\n\n${sections.join('\n\n')}\n\n说明:配方目标=开跑批次冻结的工艺窗口;PLC 当前值=实时读数。把验证过的最佳参数固化到配方用 recipe_update;回退配方到稳定版本用 recipe_rollback;逐节点参数变更史用 dcw_journal;配方版本史用 recipe_versions。`,
  }
}

/** 工具:recipe_versions —— 配方参数版本史(谁/何时/为什么改了什么;旧→新)。
 *  每条含 by(user/agent/system)、操作者人话名、变更描述、参数 diff。 */
export async function toolRecipeVersions(agentId: string, args: { recipe_id?: string, limit?: number | string }): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方的 id)。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope || !recipe.lineId || !scope.lineIds.includes(recipe.lineId)) {
    return { text: `无权查看配方 ${recipeId} 的版本史(该配方不在你负责的产线上)。`, isError: true }
  }
  const rows = getDcwController().recipeVersions(recipeId)
  const limit = Math.min(Number(args.limit) || 20, 50)
  const shown = rows.slice(-limit)
  const srcLabel: Record<string, string> = { user: '用户', agent: 'Agent', system: '系统' }
  const lines = shown.map((v, i) => {
    const prev = shown[i - 1]
    let diff = '初始版本'
    if (prev) {
      const nodeName = (id: string): string => {
        const n = getDcwController().byId(id)
        return n ? n.name : `${id}(已删除)`
      }
      const changed = v.params
        .map(p => ({ p, old: prev.params.find(x => x.nodeId === p.nodeId) }))
        .filter(({ p, old }) => !old || old.value !== p.value)
        .map(({ p, old }) => `${nodeName(p.nodeId)} ${old?.value ?? '新增'}→${p.value}`)
      const removed = prev.params.filter(o => !v.params.some(x => x.nodeId === o.nodeId)).map(o => `${nodeName(o.nodeId)} 移除`)
      const all = [...changed, ...removed]
      diff = all.length > 0 ? `变更:${all.join(';')}` : '参数未变'
    }
    const src = v.by ? (srcLabel[v.by] ?? v.by) : '—'
    return `- v${v.version} [${v.at.slice(0, 19).replace('T', ' ')}] 来源=${src} 操作者=${v.actorName ?? '—'}${v.description ? ` | ${v.description}` : ''}\n    ${diff}`
  })
  return {
    text: `配方「${recipe.name}」版本史(当前 v${recipe.version ?? 1},共 ${rows.length} 条,旧→新):\n${lines.join('\n')}\n\n回退用 recipe_rollback(recipe_id + version 或 to_last_good=true);保存新参数用 recipe_update。`,
  }
}

/** 工具:recipe_update —— 把验证过的最佳参数保存进配方(生成新版本,带归因与原因)。
 *  只改配方定义(下一批次生效);不改运行中 PLC 当前值(那用 dcw_control 逐节点下发)。 */
export async function toolRecipeUpdate(agentId: string, args: {
  recipe_id?: string
  params?: Array<{ node_id?: string, value?: number | string, min?: number | string, max?: number | string }>
  reason?: string
  task_id?: string
}): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方的 id)。', isError: true }
  if (!reason) return { text: 'reason 必填:保存参数必须说明依据(如数采证据/判定结论),便于版本史追溯。', isError: true }
  const list = (args.params ?? []).filter(p => p && String(p.node_id ?? '').trim() && Number.isFinite(Number(p.value)))
  if (list.length === 0) return { text: 'params 至少提供一条 {node_id, value}(value 必须为数字)。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const repo = getAgentNodeBindingRepo()
  for (const p of list) {
    const nodeId = String(p.node_id).trim()
    const node = getDcwController().byId(nodeId)
    if (!node) return { text: `节点 ${nodeId} 已删除,不能作为配方参数保存。请改用仍在线的节点。`, isError: true }
    if (node.lineId !== recipe.lineId) return { text: `节点「${node.name}」已取消绑定(不在配方「${recipe.name}」所在产线),不可混入。`, isError: true }
    if (!node.enabled) return { text: `节点「${node.name}」已停用,参数保存被拒。请先让用户恢复节点控制,或保存到其他节点。`, isError: true }
    if (!repo.find(agentId, nodeId, 'dcw')) {
      return { text: `无权修改节点「${node.name}」的配方参数(仅可改自己绑定 dcw 的节点)。`, isError: true }
    }
  }
  // 部分合并:只更新提供的节点,其余参数保持不变;
  // 基线中的失效参数(节点已删除/已解绑/已改挂)自动剪除并如实告知 —— 否则整次保存会被归一化拒绝
  const dropped: string[] = []
  const merged = recipe.params
    .filter((p) => {
      const node = getDcwController().byId(p.nodeId)
      if (!node || node.lineId !== recipe.lineId) {
        dropped.push(node?.name ?? p.nodeId)
        return false
      }
      return true
    })
    .map((p) => {
      const patch = list.find(x => String(x.node_id).trim() === p.nodeId)
      if (!patch) return { nodeId: p.nodeId, templateRef: p.templateRef, value: p.value, min: p.min, max: p.max }
      const out: { nodeId: string, templateRef?: string, value: number, min?: number, max?: number } = { nodeId: p.nodeId, templateRef: p.templateRef, value: Number(patch.value) }
      if (p.min != null) out.min = p.min
      if (patch.min != null && Number.isFinite(Number(patch.min))) out.min = Number(patch.min)
      if (p.max != null) out.max = p.max
      if (patch.max != null && Number.isFinite(Number(patch.max))) out.max = Number(patch.max)
      return out
    })
  const extra = list.filter(p => !recipe.params.some(x => x.nodeId === String(p.node_id).trim()))
  for (const p of extra) merged.push({ nodeId: String(p.node_id).trim(), value: Number(p.value) })
  try {
    const updated = getDcwController().updateRecipe(recipeId, { params: merged }, {
      by: 'agent',
      actorName: agentBadgeLabel(agentId),
      actor: agentId,
      description: reason,
    })
    const changedNodes = list.map((p) => {
      const node = getDcwController().byId(String(p.node_id).trim())
      const before = recipe.params.find(x => x.nodeId === String(p.node_id).trim())?.value
      return `${node?.name ?? p.node_id} ${before ?? '?'}→${Number(p.value)}`
    }).join(';')
    const droppedNote = dropped.length > 0 ? `\n注意:已自动剔除失效参数(${dropped.join('、')}:节点已删除或改挂其他产线),这些参数不再属于本配方。` : ''
    return {
      text: `已保存为 v${updated.version ?? 1}:「${updated.name}」参数 ${changedNodes};原因:${reason}。${droppedNote}\n注意:配方定义已更新,运行中批次仍按开跑时冻结的参数生产,新参数从下次开跑/一键下发生效;要把新值写入运行中的 PLC,用 dcw_control 逐节点下发(走安全联锁)。回退用 recipe_rollback。`,
    }
  }
  catch (err) {
    return { text: `保存失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:recipe_rollback —— 回退配方参数到稳定版本(指定历史版本或已知良好批次快照)。
 *  生成新版本(非破坏,历史保留);不改运行中 PLC 当前值。 */
export async function toolRecipeRollback(agentId: string, args: {
  recipe_id?: string
  version?: number | string
  to_last_good?: boolean | string
  reason?: string
}): Promise<{ text: string, isError?: boolean }> {
  const recipeId = String(args.recipe_id ?? '').trim()
  const reason = String(args.reason ?? '').trim()
  const toLastGood = args.to_last_good === true || args.to_last_good === 'true'
  const version = Number(args.version)
  if (!recipeId) return { text: 'recipe_id 必填。', isError: true }
  if (!reason) return { text: 'reason 必填:回退必须说明原因(如优化翻车/越限),便于版本史追溯。', isError: true }
  if (!toLastGood && !Number.isFinite(version)) return { text: '需提供 version(历史版本号)或 to_last_good=true。', isError: true }
  const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  const scope = agentOpsScope(agentId)
  if (!scope || !recipe.lineId || !scope.lineIds.includes(recipe.lineId)) {
    return { text: `无权回退配方 ${recipeId}(该配方不在你负责的产线上)。`, isError: true }
  }
  if (!toLastGood && Number.isFinite(version) && version >= (recipe.version ?? 1)) {
    return { text: `不能回退到 v${version}(当前已是 v${recipe.version ?? 1};回退目标是更早的版本)。`, isError: true }
  }
  try {
    const updated = getDcwController().revertRecipe(recipeId, {
      version: toLastGood ? undefined : version,
      toLastGood,
    }, {
      by: 'agent',
      actorName: agentBadgeLabel(agentId),
      actor: agentId,
      description: reason,
    })
    return {
      text: `回退完成:配方「${updated.name}」已生成 v${updated.version ?? 1},参数恢复为目标版本(${toLastGood ? '已知良好批次冻结' : `v${version}`});原因:${reason}。\n运行中批次不受影响(仍按开跑冻结参数);新参数下次开跑生效。版本史用 recipe_versions 复核。`,
    }
  }
  catch (err) {
    return { text: `回退失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

// ================================================================
// AML 自动建模工具族(aml_*):数据集 → 训练作业 → 实验谱系 → 模型晋升 → 影子参考
// 权限模型:数据集构建节点级鉴权(daq 绑定,只缩不放)+ 归属产线一致;晋升走 HITL 人工审批;
// 作业提交/取消按 agentId 归因( submitJob 内部已记 ops,工具层不重复记提交动作)。
// ================================================================

/** recordOps 的 AML 分类(与 job-orchestrator/model-registry 的 kind='aml' 同源;仓储联合类型暂未列 'aml',此处收口断言) */
const AML_AUDIT_KIND = 'aml' as unknown as 'system'

function amlErr(text: string): { text: string, isError: true } {
  return { text, isError: true }
}

/** 数值展示(4 位有效小数;空值统一 '-') */
function fmtAmlNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '-'
  return String(Number(v.toFixed(digits)))
}

function amlNodeName(nodeId: string): string {
  return getDaqNodeRepo().byId(nodeId)?.name ?? nodeId
}

function amlNodeUnit(nodeId: string): string {
  const n = getDaqNodeRepo().byId(nodeId)
  return n?.unit ?? findDaqTemplate(n?.templateKey ?? '')?.unit ?? ''
}

/** 数据集构建报告惰性读(report.json 与 manifest 同目录) */
function amlReportOf(dataset: AmlDatasetRow): AmlDatasetReport | null {
  try {
    return JSON.parse(readFileSync(join(dataset.path, 'report.json'), 'utf8')) as AmlDatasetReport
  }
  catch {
    return null
  }
}

/** 门禁报告 → 逐项文本(解析失败降级为原始串) */
function amlGatesLines(gatesJson: string | null): string {
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
function amlJobCard(job: AmlJobRow): string {
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
  const { getTsdb, tsdbReady } = await import('../daq/storage')
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
  const { getTsdb, tsdbReady } = await import('../daq/storage')
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
