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
import { daqRuntimeSettings } from '../settings'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'
import { getRecipeRollBackManager } from '../dcw/recipe-rollback-manager'

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
   若节点被他人的 open 记录阻塞(对方已消失),超时(30 分钟)后你可接管:dcw_judge 会带接管标记入册。`,
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

/** 工具:dcw_judge —— 对自己的优化记录落判定(keep/rollback/uncertain)。
 *  判定与执行分离:rollback 判定只入册,执行必须再调 dcw_rollback。 */
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
  try {
    const finalReason = takeover ? `[接管孤儿记录,原属主 ${record.agentId ?? '?'} 超时未判定] ${reason}` : reason
    const updated = rb.judge(recordId, verdict, finalReason, 'agent', agentId, { takeover })
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
 *  args: record_id(回退该记录到其 from 值)或 node_id(单步撤销到最近稳定锚);to = 指定目标锚。 */
export async function toolDcwRollback(agentId: string, args: { record_id?: string, node_id?: string, to?: string }): Promise<{ text: string, isError?: boolean }> {
  const rb = getRecipeRollBackManager()
  const recordId = String(args.record_id ?? '').trim()
  const nodeId = String(args.node_id ?? '').trim()
  const to = String(args.to ?? '').trim() || undefined
  if (!recordId && !nodeId)
    return { text: 'record_id 或 node_id 至少提供一个。', isError: true }
  try {
    if (recordId) {
      const record = rb.recordById(recordId)
      if (!record)
        return { text: `优化记录 ${recordId} 不存在。`, isError: true }
      const takeover = record.agentId !== agentId && rb.isStale(record)
      if (record.agentId !== agentId && !takeover)
        return { text: `记录 ${recordId} 不是你发起的优化(发起者:${record.agentId ?? '用户'}),回退他人记录请请用户在数采中心/产线详情执行;若原属主已消失(超时未判定),可先 dcw_judge 接管后再回退。`, isError: true }
      const fresh = await rb.rollbackRecord(recordId, agentId, 'agent')
      return { text: `回退已执行:记录 ${recordId} 标记 rolled-back;下发恢复值 ${fresh?.params[0]?.to}${'(以回读为准)'};新回退记录 ${fresh?.id} 已入册。请 daq_query 复测确认恢复。` }
    }
    const fresh = await rb.rollbackNode(nodeId, agentId, 'agent', to)
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
