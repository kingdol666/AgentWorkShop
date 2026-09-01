/**
 * IndustrialContext —— Agent 工业语义上下文服务(**数据驱动,零硬编码**)。
 *
 * 语义来源优先级(逐层覆盖,全部为用户可编辑数据):
 *   节点 semantics(节点级备注)> 模板 semantics(模板编辑)> 结构化字段自动描述
 *   (量程/单位/预警带/采样周期由节点与模板元数据合成)。
 * 上下文 = 节点语义卡 × 产线工况 × 关联设备 —— 只描述「该 Agent 实际绑定的节点」。
 */

import { getAgentNodeBindingRepo } from './node-bindings.repo'
import { getDcwController } from '../dcw/dcw-controller'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getActiveLineRun } from '../dcw/line-run'
import { findDcwTemplate } from '../dcw/dcw-templates'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'
import { getDeviceTwinRepo } from '../assets/device-twin.repo'
import { getRecipeRollBackManager } from '../dcw/recipe-rollback-manager'

/** 从属设备描述(名称/状态/实时遥测;数据驱动) */
function describeTwin(bindId: string | null | undefined): string | null {
  if (!bindId) return null
  const t = getDeviceTwinRepo().findById(bindId)
  if (!t) return null
  return `${t.name}(id=${t.id},state=${t.state},telemetry=${JSON.stringify(t.telemetry)})`
}

/** 数控节点语义卡:模板 semantics(或节点覆盖)× 实时数据合成 */
function dcwSemanticCard(nodeId: string, mode: string): string | null {
  const node = getDcwController().byId(nodeId)
  if (!node) return null
  const tpl = findDcwTemplate(node.templateKey)
  const sem = (node.semantics ?? tpl?.semantics ?? '').trim()
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId) : undefined
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const param = recipe?.params.find(p => p.nodeId === nodeId)
  const twinDesc = describeTwin(node.deviceBindingId)
  const step = Math.max(10 ** -node.decimals, (node.max - node.min) * 0.02)

  const lines = [
    `#### ◆ ${node.name} [id=${nodeId}]`,
    `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},精度 ${node.decimals} 位小数`,
  ]
  if (sem) lines.push(`- 工艺语义: ${sem}`)
  lines.push(`- 安全量程: [${node.min}, ${node.max}] ${node.unit}(硬联锁,越界即拒)`)
  if (param && (param.min != null || param.max != null)) {
    lines.push(`- 活动配方「${recipe!.name}」工艺窗口: [${param.min ?? '-∞'}, ${param.max ?? '+∞'}] ${node.unit}(软联锁,配方目标值 ${param.value}${node.unit ?? ''})`)
  }
  else if (run) {
    lines.push(`- 活动配方「${run.recipeName}」未对本节点设窗口(全局量程生效)`)
  }
  lines.push(`- 当前设定: ${node.value != null ? `${node.value}${node.unit}` : '未下发'},状态 ${node.state},所属产线「${line?.name ?? '未分配'}」`)
  if (twinDesc) lines.push(`- 从属设备: ${twinDesc};你的写入经 PLC 下发后反映到该设备的物理行为`)
  lines.push(`- 操作守则: 单次调幅建议 ≤${Number(step.toFixed(node.decimals))}${node.unit}(量程 2%);下发后等待工艺响应再评估;目标值必须落在窗口内;驱动 ${node.driver};${mode === 'manual' ? '**手动确认模式**,每次下发会请求用户批准,请在下发前说明理由' : '自动模式,直接执行'}`)
  return lines.join('\n')
}

/** 数采节点语义卡 */
function daqSemanticCard(nodeId: string, mode: string): string | null {
  const node = getDaqNodeRepo().byId(nodeId)
  if (!node) return null
  const tpl = findDaqTemplate(node.templateKey)
  const sem = (node.semantics ?? tpl?.semantics ?? '').trim()
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId) : undefined
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const win = recipe?.daqWindows?.find(w => w.nodeId === nodeId)
  const twinDesc = describeTwin(node.deviceBindingId)
  const fresh = node.lastAt ? Math.round((Date.now() - Date.parse(node.lastAt)) / 1000) : null

  const lines = [
    `#### ◇ ${node.name} [id=${nodeId}]`,
    `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},正常量程 [${node.min}, ${node.max}] ${node.unit}`,
  ]
  if (sem) lines.push(`- 采集语义: ${sem}`)
  if (node.warnLow != null || node.warnHigh != null) {
    lines.push(`- 预警带: [${node.warnLow ?? '-∞'}, ${node.warnHigh ?? '+∞'}] ${node.unit}(出带=warn,越量程=alarm)`)
  }
  if (win) lines.push(`- 活动配方「${recipe!.name}」监控窗口: [${win.min ?? '-∞'}, ${win.max ?? '+∞'}] ${node.unit}(实时值越限 → 节点标红 + 孪生告警)`)
  lines.push(`- 实时值: ${node.value != null ? `${node.value}${node.unit}` : '暂无数据'}${fresh != null ? `( ${fresh}s 前更新)` : ''},状态 ${node.state},采样 ${node.effectiveInterval(1000)}ms,驱动 ${node.driver},所属产线「${line?.name ?? '未分配'}」`)
  if (twinDesc) lines.push(`- 从属设备: ${twinDesc};量测的是该设备的真实过程量`)
  lines.push(`- 数据获取: daq_query(node_id='${nodeId}');${mode === 'manual' ? '手动确认模式' : '查询自动执行'}`)
  return lines.join('\n')
}

/** 工具:my_industrial_nodes 的语义卡视图 */
export function nodeSemanticCards(agentId: string): { text: string, stale: number } {
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  const cards: string[] = []
  let stale = 0
  for (const b of bindings) {
    const card = b.kind === 'dcw' ? dcwSemanticCard(b.nodeId, b.mode) : daqSemanticCard(b.nodeId, b.mode)
    if (card) cards.push(card)
    else stale++
  }
  return { text: cards.join('\n\n'), stale }
}

/** 产线工况简报(注入每次回合 prompt;只描述 Agent 绑定节点所在的产线) */
export function buildIndustrialContext(agentId: string): string {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const dcwIds = bindings.filter(b => b.kind === 'dcw').map(b => b.nodeId)
  const daqIds = bindings.filter(b => b.kind === 'daq').map(b => b.nodeId)
  if (dcwIds.length === 0 && daqIds.length === 0) return ''

  const lineIds = [...new Set([
    ...dcwIds.map(id => getDcwController().byId(id)?.lineId ?? ''),
    ...daqIds.map(id => getDaqNodeRepo().byId(id)?.lineId ?? ''),
  ])].filter(Boolean)

  const sections: string[] = []
  for (const lineId of lineIds) {
    const line = getDcwLineRepo().byId(lineId)
    if (!line) continue
    const run = getActiveLineRun(lineId)
    const lines: string[] = [`### 产线「${line.name}」(id=${lineId},光晕色 ${line.color})`]
    if (run) {
      const elapsedMin = Math.round((Date.now() - Date.parse(run.startedAt)) / 60_000)
      lines.push(`- 工况:**运行中**,批次 ${run.runId.slice(0, 8)},产品「${run.productName}」× 配方「${run.recipeName}」,已运行 ${elapsedMin} 分钟,已采集 ${run.taggedSamples} 打标样本`)
      const recipe = getDcwController().listRecipes().find(r => r.id === run.recipeId)
      if (recipe) {
        const params = recipe.params
          .map((p) => {
            const n = getDcwController().byId(p.nodeId)
            const win = (p.min != null || p.max != null) ? ` 窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'}${n?.unit ?? ''}` : ''
            return `${n?.name ?? p.nodeId}=${p.value}${n?.unit ?? ''}${win}`
          })
          .join(';')
        lines.push(`- 配方工艺参数: ${params}`)
        const wins = (recipe.daqWindows ?? [])
          .map((w) => {
            const n = getDaqNodeRepo().byId(w.nodeId)
            return `${n?.name ?? w.nodeId} ∈ [${w.min ?? '-∞'}, ${w.max ?? '+∞'}]${n?.unit ?? ''}`
          })
          .join(';')
        if (wins) lines.push(`- 数采监控窗口(越限即报警): ${wins}`)
      }
    }
    else {
      lines.push('- 工况:**停线**(无活动批次;写入仅受节点全局量程约束,数采暂停)')
    }
    const twinNames = new Set<string>()
    for (const id of [...dcwIds, ...daqIds]) {
      const bindId = getDcwController().byId(id)?.deviceBindingId ?? getDaqNodeRepo().byId(id)?.deviceBindingId ?? null
      const desc = describeTwin(bindId)
      if (desc) twinNames.add(desc)
    }
    if (twinNames.size > 0) lines.push(`- 关联设备孪生: ${Array.from(twinNames).join(' | ')}`)
    // 当前报警透出(只报本 Agent 绑定的数采节点):越限即报警是工况里最需要
    // Agent 优先感知的事实 —— 不注入的话,Agent 只能靠 daq_query 事后发现
    const alarms = daqIds
      .map(id => getDaqNodeRepo().byId(id))
      .filter(n => n && n.lineId === lineId && n.state === 'alarm')
    if (alarms.length > 0) {
      lines.push(`- **当前报警**: ${alarms.map(n => `${n.name} 实时 ${n.value ?? '?'}${n.unit} 处于报警态(越量程或越配方监控窗口)`)},应优先判读(设定-响应滞后 vs 真实异常)并处置`)
    }
    sections.push(lines.join('\n'))
  }
  if (sections.length === 0) return ''
  return `## 产线工况简报(实时;每次回合自动注入)\n${sections.join('\n\n')}`
}

/**
 * 工业调控作业环(prompt 层纪律注入;有工业绑定才注入,零硬编码)。
 * 与节点语义卡(my_industrial_nodes 结果)互补:语义卡在工具调用后可见,
 * 作业环保证 Agent 在**任何回合开头**就知道调控方法论。
 * 七步闭环(v2.1):观察 → 理解 → 假设 → 设定 → 判定 → 回退/保持 → 复盘;
 * 每次下发自动开优化记录、判定入册、回退可审计 —— 闭环由系统记账,Agent 负责判断质量。
 */
export function industrialLoopGuide(agentId: string): string {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  if (bindings.length === 0) return ''
  const hasDcw = bindings.some(b => b.kind === 'dcw')
  const hasManual = bindings.some(b => b.kind === 'dcw' && b.mode === 'manual')
  const steps: string[] = [
    '1. 观察:daq_query 获取绑定节点的真实时序数据(支持按产品/配方/时间窗过滤),结合返回的工况判读理解当前状态。',
    '2. 理解:my_industrial_nodes 读取节点语义卡 —— 物理量含义/单位/安全量程/活动配方工艺窗口/单次调幅步进,以及调控闭环状态(进行中的优化记录/上次良好值/最近判定)。',
  ]
  if (hasDcw) {
    steps.push(
      '3. 假设:调参前先声明假设(写入 dcw_control 的 hypothesis 参数)—— 目标值 + 预期效果 + 观察计划;目标必须落在「安全量程 ∩ 活动配方工艺窗口」内,优先小步幅(≤量程 2%)、单向逼近。',
      '4. 设定:dcw_control 下发(自动开优化记录);等待工艺响应(热惯性/传动惯量),勿连续大幅调整。',
      '5. 判定:daq_query 复测窗口数据后,dcw_judge 落判定 —— keep(已验证经验)/ rollback(判应回退)/ uncertain(证据不足)。未判定前再下发,旧记录会被标记 superseded;判定必须引用具体数值与时间窗证据。',
      '6. 回退/保持:判 rollback 后用 dcw_rollback(record_id) 执行回退(判定不自动改 PLC),回退后 daq_query 复测确认恢复;回退冷却期内禁止同向重写。收敛异常时分析根因或上报,而非盲目加码。',
      '7. 复盘:dcw_journal 查看该节点参数变更史与判定结论;keep 的记录是已验证经验,rollback 的记录写进结论修正下次假设 —— 禁止重复已失败的调参方向。',
    )
  }
  else {
    steps.push('3. 判读:你是量测侧 —— 数据越过配方监控窗口会触发节点报警与孪生告警;判读时区分「同线数控设定-响应滞后」与「真实过程异常」,结论引用具体数值与时间窗。')
  }
  if (hasManual) {
    steps.push('8. 权限边界:手动确认模式的节点,下发前必须说明理由并等待用户批准(用户备注会随结果返回,请响应其关切);自动模式节点直接执行,但同样受联锁约束;其判定回退会推请用户确认。')
  }
  steps.push(`${steps.length + 1}. 数值口径:工具返回的采集/设定值均为经标定钩子处理后的真实物理量纲;引用数值时带上单位与时间,便于人工复核。`)
  const history = recentOptimizationNotes(agentId)
  return `## 工业调控作业环(你的节点操作方法论,每回合生效)\n${steps.join('\n')}${history}`
}

/** 经验注入:该 Agent 绑定数控节点的最近优化记录结论(keep/rollback 统计),跨任务积累 */
function recentOptimizationNotes(agentId: string): string {
  try {
    const rb = getRecipeRollBackManager()
    const dcwIds = getAgentNodeBindingRepo().byAgent(agentId).filter(b => b.kind === 'dcw').map(b => b.nodeId)
    if (dcwIds.length === 0) return ''
    const lines: string[] = []
    for (const nodeId of dcwIds.slice(0, 3)) {
      const records = rb.records({ nodeId, limit: 20 })
      if (records.length === 0) continue
      const keep = records.filter(r => r.judge?.verdict === 'keep').length
      const roll = records.filter(r => r.judge?.verdict === 'rollback' || r.status === 'rolled-back').length
      const last = records.find(r => r.judge)
      lines.push(`- ${records[0]!.nodeName}:近 ${records.length} 次调控(keep ${keep}/rollback ${roll})${last?.judge ? `,最近判定 ${last.judge.verdict}(${last.judge.reason.slice(0, 60)})` : ''}`)
    }
    if (lines.length === 0) return ''
    return `\n\n## 优化经验台账(你绑定节点的近期调控结论;避免重复已失败方向)\n${lines.join('\n')}`
  }
  catch {
    return ''
  }
}
