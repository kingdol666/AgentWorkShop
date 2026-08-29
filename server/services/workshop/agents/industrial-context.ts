/**
 * IndustrialContext —— Agent 工业语义上下文服务(节点语义卡 × 产线工况简报)。
 *
 * 设计目标:Agent 不止能读写节点,还要**理解**节点 —— 物理意义、在工艺链中的
 * 角色、与绑定设备的从属关系、当前工况(活动配方/窗口/告警/数据新鲜度),
 * 以及"怎么做"(操作守则:每次调幅幅度、稳定性观察、越窗联锁、HITL 流程)。
 *
 * 三面注入(omp prompt 链集成):
 *   1. contextBrief()   —— 产线工况简报:注入每次回合的 prompt(轻量,~15 行)
 *   2. nodeSemanticCards() —— 节点语义卡(重量级):my_industrial_nodes 返回
 *   3. daq_query 结果附带工况解释 —— 数据 → 语义(距窗口/目标偏差/建议)
 */

import { getAgentNodeBindingRepo } from './node-bindings.repo'
import { getDcwController } from '../dcw/dcw-controller'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getActiveLineRun } from '../dcw/line-run'
import { findDcwTemplate } from '../dcw/dcw-templates'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { findDaqTemplate } from '../daq/daq-templates'
import { getDeviceTwinRepo } from '../assets/device-twin.repo'

/** 数控模板的工艺角色描述(控制量如何影响产线) */
const DCW_PROCESS_ROLE: Record<string, string> = {
  'temp-sp': '烘箱/熔体温度设定:升高使热塑温度上升(成膜更均匀但能耗高、过热降解风险),降低则偏冷易厚度不均。调整后需等待热惯性(数十秒级)再评估效果。',
  'speed-sp': '产线速度设定:升速提高产能但缩短物料受热时间(温度补偿需联动),降速利于精细工艺。速度变化会同步影响张力与厚度分布。',
  'tension-sp': '膜张力设定:张力过大易断膜/拉伸变形,过小则跑偏起皱。调整需平缓(每次 ≤5%),并与速度联动观察。',
  'pressure-sp': '熔体压力设定:反映挤出/泵送负荷,压力偏高提示阻力大或温度偏低,偏低可能是料位不足。调整需小幅步进。',
}

/** 数采模板的物理含义与判读方法 */
const DAQ_SEMANTICS: Record<string, string> = {
  'temp-tc': '熔体/箱体温度:热工艺核心被控量,热惯性大(变化平缓)。判读:与设定值偏差 ±2℃ 内为稳态;持续单边漂移 = 加热/散热失衡;骤升骤降多为扰动或传感器异常。',
  'pressure-tx': '熔体压力:挤出负荷的「血压计」。判读:与温度负相关(温度升→熔体黏度降→压力降);压力突升常见于滤网堵塞或出料受阻。',
  'tension-cell': '膜张力:成膜质量直接指标。判读:张力波动与速度/温度设定强耦合,评估张力前先确认速度稳定。',
  'line-encoder': '产线速度:产能直接观测量。判读:实际速度对设定值的跟随滞后反映传动惯量;速度波动会传导至张力与厚度。',
  'vision-cam': '视觉检测:表面缺陷计数/尺寸判定,为质量闭环提供反馈。',
  'power-meter': '电参采集:能耗与设备健康指标;电流异常升高常先于机械故障。',
}

/** 从绑定清单推断 Agent 的产线工况上下文(全量:产线/设备/配方/窗口/实时快照) */
export function buildIndustrialContext(agentId: string): string {
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const dcwIds = bindings.filter(b => b.kind === 'dcw').map(b => b.nodeId)
  const daqIds = bindings.filter(b => b.kind === 'daq').map(b => b.nodeId)
  if (dcwIds.length === 0 && daqIds.length === 0) return ''

  const sections: string[] = []

  // ---- 产线工况(按 Agent 绑定节点的产线分组) ----
  const lineIds = [...new Set([
    ...dcwIds.map(id => getDcwController().byId(id)?.lineId ?? ''),
    ...daqIds.map(id => getDaqNodeRepo().byId(id)?.lineId ?? ''),
  ])].filter(Boolean)

  for (const lineId of lineIds) {
    const line = getDcwLineRepo().byId(lineId)
    if (!line) continue
    const run = getActiveLineRun(lineId)
    const lines: string[] = []
    lines.push(`### 产线「${line.name}」(id=${lineId}, 光晕色 ${line.color})`)
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
    // 该产线上 Agent 绑定节点所附属的设备(虚拟孪生实体)
    const twinNames = new Set<string>()
    for (const id of [...dcwIds, ...daqIds]) {
      const n = getDcwController().byId(id) ?? undefined
      const bindId = n?.deviceBindingId ?? getDaqNodeRepo().byId(id)?.deviceBindingId ?? null
      if (bindId) {
        const t = getDeviceTwinRepo().findById(bindId)
        if (t) twinNames.add(`${t.name}(state=${t.state},telemetry=${JSON.stringify(t.telemetry)})`)
      }
    }
    if (twinNames.size > 0) lines.push(`- 关联设备孪生: ${Array.from(twinNames).join(' | ')}`)
    sections.push(lines.join('\n'))
  }

  if (sections.length === 0) return ''
  return `## 产线工况简报(实时;每次回合自动注入)\n${sections.join('\n\n')}`
}

/** 单个数控节点的完整语义卡(物理意义 + 工艺角色 + 从属设备 + 操作守则) */
function dcwSemanticCard(nodeId: string, mode: string): string | null {
  const node = getDcwController().byId(nodeId)
  if (!node) return null
  const tpl = findDcwTemplate(node.templateKey)
  const role = DCW_PROCESS_ROLE[node.templateKey] ?? '工艺设定量:按模板语义与量程谨慎调整。'
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId) : undefined
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const param = recipe?.params.find(p => p.nodeId === nodeId)
  const bindId = node.deviceBindingId
  const twin = bindId ? getDeviceTwinRepo().findById(bindId) : undefined
  const dec = node.decimals
  const step = Math.max(10 ** -dec, (node.max - node.min) * 0.02)
  const lines = [
    `#### ◆ ${node.name} [id=${nodeId}]`,
    `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},精度 ${dec} 位小数`,
    `- 工艺角色: ${role}`,
    `- 安全量程: [${node.min}, ${node.max}] ${node.unit}(硬联锁,越界即拒)`,
  ]
  if (param && (param.min != null || param.max != null)) {
    lines.push(`- 活动配方「${recipe!.name}」工艺窗口: [${param.min ?? '-∞'}, ${param.max ?? '+∞'}] ${node.unit}(软联锁,目标值 ${param.value}${node.unit ?? ''})`)
  }
  else if (run) {
    lines.push(`- 活动配方「${run.recipeName}」未对本节点设窗口(全局量程生效)`)
  }
  lines.push(`- 当前设定: ${node.value != null ? `${node.value}${node.unit}` : '未下发'},状态 ${node.state},所属产线「${line?.name ?? '未分配'}」`)
  if (twin) lines.push(`- 从属设备: ${twin.name}(孪生 id=${twin.id},state=${twin.state};你的写入经 PLC 后会反映到该设备的物理行为)`)
  lines.push(`- 操作守则: 单次调幅建议 ≤${Number(step.toFixed(dec))}${node.unit}(量程 2%);下发后等待工艺响应(热惯性/传动惯量)再评估;目标值必须落在窗口内;${mode === 'manual' ? '本节点为**手动确认模式**,每次下发会请求用户批准,请在下发前说明理由' : '本节点为自动模式,直接执行'}`)
  return lines.join('\n')
}

/** 单个数采节点的完整语义卡 */
function daqSemanticCard(nodeId: string, mode: string): string | null {
  const node = getDaqNodeRepo().byId(nodeId)
  if (!node) return null
  const tpl = findDaqTemplate(node.templateKey)
  const sem = DAQ_SEMANTICS[node.templateKey] ?? '过程量测:结合量程与工艺上下文判读。'
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId) : undefined
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const win = recipe?.daqWindows?.find(w => w.nodeId === nodeId)
  const bindId = node.deviceBindingId
  const twin = bindId ? getDeviceTwinRepo().findById(bindId) : undefined
  const fresh = node.lastAt ? Math.round((Date.now() - Date.parse(node.lastAt)) / 1000) : null
  const lines = [
    `#### ◇ ${node.name} [id=${nodeId}]`,
    `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},正常量程 [${node.min}, ${node.max}] ${node.unit}`,
    `- 判读方法: ${sem}`,
  ]
  if (node.warnLow != null || node.warnHigh != null) {
    lines.push(`- 预警带: [${node.warnLow ?? '-∞'}, ${node.warnHigh ?? '+∞'}] ${node.unit}(出带=warn,越量程=alarm)`)
  }
  if (win) lines.push(`- 活动配方「${recipe!.name}」监控窗口: [${win.min ?? '-∞'}, ${win.max ?? '+∞'}] ${node.unit}(实时值越限 → 节点标红 + 孪生告警)`)
  lines.push(`- 实时值: ${node.value != null ? `${node.value}${node.unit}` : '暂无数据'}${fresh != null ? `( ${fresh}s 前更新)` : ''},状态 ${node.state},采样 ${node.effectiveInterval(1000)}ms,所属产线「${line?.name ?? '未分配'}」`)
  if (twin) lines.push(`- 从属设备: ${twin.name}(量测的是该设备的真实过程量,经 PLC 寄存器读取)`)
  lines.push(`- 数据获取: daq_query(node_id='${nodeId}');${mode === 'manual' ? '本节点查询为手动确认模式' : '查询自动执行'}`)
  return lines.join('\n')
}

/** 工具:my_industrial_nodes 的语义卡视图(替代旧单行摘要) */
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
