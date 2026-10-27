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
import { getDcwNodeRepo } from '../dcw/dcw-node.repo'
import { getDcwLineRepo } from '../dcw/dcw-line.repo'
import { getDcwProductRepo } from '../dcw/dcw-product.repo'
import { getActiveLineRun } from '../dcw/line-run'
import { findDcwTemplate } from '../dcw/dcw-templates'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import type { DaqNode } from '../daq/daq-node'
import { findDaqTemplate } from '../daq/daq-templates'
import { getDeviceTwinRepo } from '../assets/device-twin.repo'
import { getRecipeRollBackManager } from '../dcw/recipe-rollback-manager'
import { limitsBreakdownOf } from '../dcw/param-limits'
import { MES_REST_DRIVER_KIND, mesCatalogEntryOf } from '../mes/mes-controller'
import { getDcwParamRepo } from '../dcw/param-map.repo'
import { promptLocaleOf, tr, type PromptLocale } from './prompt-i18n'

/** 从属设备描述(名称/状态/实时遥测;数据驱动) */
function describeTwin(bindId: string | null | undefined): string | null {
  if (!bindId) return null
  const t = getDeviceTwinRepo().findById(bindId)
  if (!t) return null
  return `${t.name}(id=${t.id},state=${t.state},telemetry=${JSON.stringify(t.telemetry)})`
}

/** 多对多绑定:节点全部绑定设备的描述(deviceIds 权威;legacy 别名兜底) */
function describeTwins(node: { deviceIds?: string[], deviceBindingId?: string | null }): string[] {
  const ids = node.deviceIds?.length ? node.deviceIds : (node.deviceBindingId ? [node.deviceBindingId] : [])
  return ids.map(id => describeTwin(id)).filter((x): x is string => Boolean(x))
}

/** 数控节点语义卡:模板 semantics(或节点覆盖)× 实时数据合成 */
function dcwSemanticCard(nodeId: string, mode: string, locale: PromptLocale = 'zh'): string | null {
  const node = getDcwController().byId(nodeId)
  if (!node) return null
  const tpl = findDcwTemplate(node.templateKey)
  const isMes = node.driver === MES_REST_DRIVER_KIND
  // 语义三层合并:节点 semantics > 模板 semantics > mes-rest 的 driverConfig.desc;
  // 全空时给结构化兜底行(诚实标注"待补",不装作有语义)
  const nodeSem = (node.semantics ?? '').trim()
  const tplSem = (tpl?.semantics ?? '').trim()
  const mesDesc = isMes ? String((node.driverConfig as Record<string, unknown>)?.desc ?? '').trim() : ''
  const sem = nodeSem || tplSem || mesDesc
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId) : undefined
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const param = recipe?.params.find(p => p.nodeId === nodeId)
  const twinDesc = describeTwins(node).join(' | ') || null
  const stepProfile = limitsBreakdownOf(node)
  const stepText = stepProfile.stepLimit == null
    ? tr(locale, '未配置(探索阶段禁止无界写入)', 'not configured (unbounded writes are forbidden during exploration)')
    : `${Number(stepProfile.stepLimit.toFixed(node.decimals))}${node.unit}(${tr(locale, '来源:', 'source:')}${stepProfile.stepLimitSource})`
  const route = isMes
    ? tr(locale, '写入经 MES 集成下发(REST API;多字段接口由 writeHook 只组装本节点声明的字段,writeCheckHook 二次校验回执)', 'Writes are dispatched through the MES integration (REST API; multi-field endpoints are assembled by writeHook for this node only, with writeCheckHook verifying the acknowledgement)')
    : tr(locale, `写入经驱动 ${node.driver} 下发 PLC(寄存器/换算封装在驱动配置内,你只面对工程量)`, `Writes go through driver ${node.driver} to the PLC (register scaling is encapsulated in the driver config; you only deal in engineering units)`)

  const lines = [
    `#### ◆ ${node.name} [id=${nodeId}]${isMes ? tr(locale, '[MES 集成点位]', '[MES integration point]') : ''}`,
    tr(locale, `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},精度 ${node.decimals} 位小数`, `- Physical quantity: ${tpl?.ch ?? node.templateKey}, unit ${node.unit}, precision ${node.decimals} decimals`),
  ]
  if (sem) lines.push(tr(locale, `- 工艺语义: ${sem}${nodeSem ? '' : tplSem ? '(来自模板)' : '(来自 MES 点位描述)'}`, `- Process semantics: ${sem}${nodeSem ? '' : tplSem ? ' (from template)' : ' (from MES point description)'}`))
  else lines.push(tr(locale, `- 工艺语义: (待补)该节点未填写工艺语义 —— 物理量 ${tpl?.ch ?? node.templateKey};请让用户在模板/节点语义中补充物理机理与调参守则后再做大幅调整`, `- Process semantics: (missing) no semantics configured for this node — physical quantity ${tpl?.ch ?? node.templateKey}; ask the user to add the physical mechanism and tuning rules before large adjustments`))
  lines.push(tr(locale, `- 安全量程: [${node.min}, ${node.max}] ${node.unit}(硬联锁,越界即拒)`, `- Safe range: [${node.min}, ${node.max}] ${node.unit} (hard interlock; out-of-range writes are rejected)`))
  if (param && (param.min != null || param.max != null)) {
    lines.push(tr(locale, `- 活动配方「${recipe!.name}」工艺窗口: [${param.min ?? '-∞'}, ${param.max ?? '+∞'}] ${node.unit}(软联锁,配方目标值 ${param.value}${node.unit ?? ''})`, `- Active recipe "${recipe!.name}" process window: [${param.min ?? '-∞'}, ${param.max ?? '+∞'}] ${node.unit} (soft interlock; recipe target ${param.value}${node.unit ?? ''})`))
  }
  else if (run) {
    lines.push(tr(locale, `- 活动配方「${run.recipeName}」未对本节点设窗口(全局量程生效)`, `- Active recipe "${run.recipeName}" has no window for this node (global range applies)`))
  }
  lines.push(tr(locale, `- 当前设定: ${node.value != null ? `${node.value}${node.unit}` : '未下发'},状态 ${node.state},所属产线「${line?.name ?? '未分配'}」`, `- Current setpoint: ${node.value != null ? `${node.value}${node.unit}` : 'not dispatched'}, state ${node.state}, line "${line?.name ?? 'unassigned'}"`))
  if (twinDesc) lines.push(tr(locale, `- 从属设备: ${twinDesc};你的写入经 PLC 下发后反映到该设备的物理行为`, `- Bound device: ${twinDesc}; your writes reach the PLC and affect this device's physical behavior`))
  lines.push(tr(locale, `- 下发链路: ${route};参数写入与下发一律走你绑定的配方(recipe_update 保存版本 / recipe_apply 整批下发 / recipe_trial 候选试验),四层限界(量程∩参数∩产品∩配方)与单步上限在配方面照常生效`, `- Dispatch path: ${route}; all parameter writes go through your bound recipe (recipe_update saves a version / recipe_apply dispatches the batch / recipe_trial runs a candidate). The four-layer limits (range ∩ parameter ∩ product ∩ recipe) and per-step cap still apply`))
  lines.push(tr(locale, `- 操作守则: 单次调幅硬上限 ≤${stepText};下发后等待工艺响应再评估;目标值必须落在窗口内;${mode === 'manual' ? '**手动确认模式**,每次下发会请求用户批准,请在下发前说明理由' : mode === 'recipe' ? '经配方绑定操作:绑定 manual 时逐动作人工批准,auto 直接执行(配方未在运行时不可操作)' : '自动模式,直接执行'}`, `- Operating rules: hard per-step cap <= ${stepText}; wait for the process response before re-evaluating; targets must stay inside the window; ${mode === 'manual' ? '**manual approval mode**: every dispatch asks the user, so state your rationale first' : mode === 'recipe' ? 'recipe-bound operation: manual mode approves each action, auto executes directly (no operation while the recipe is not running)' : 'automatic mode, execute directly'}`))
  return lines.join('\n')
}

/** 数采节点语义卡 */
function daqSemanticCard(nodeId: string, mode: string, locale: PromptLocale = 'zh'): string | null {
  const node = getDaqNodeRepo().byId(nodeId)
  if (!node) return null
  const tpl = findDaqTemplate(node.templateKey)
  const sem = (node.semantics ?? tpl?.semantics ?? '').trim()
  const line = node.lineId ? getDcwLineRepo().byId(node.lineId) : undefined
  const run = node.lineId ? getActiveLineRun(node.lineId) : null
  const recipe = run ? getDcwController().listRecipes().find(r => r.id === run.recipeId) : undefined
  const win = recipe?.daqWindows?.find(w => w.nodeId === nodeId)
  const twinDesc = describeTwins(node).join(' | ') || null
  const fresh = node.lastAt ? Math.round((Date.now() - Date.parse(node.lastAt)) / 1000) : null

  const lines = [
    `#### ◇ ${node.name} [id=${nodeId}]`,
    tr(locale, `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},正常量程 [${node.min}, ${node.max}] ${node.unit}`, `- Physical quantity: ${tpl?.ch ?? node.templateKey}, unit ${node.unit}, normal range [${node.min}, ${node.max}] ${node.unit}`),
  ]
  if (sem) lines.push(tr(locale, `- 采集语义: ${sem}`, `- Measurement semantics: ${sem}`))
  else lines.push(tr(locale, `- 采集语义: (待补)该节点未填写采集语义 —— 物理量 ${tpl?.ch ?? node.templateKey};请让用户在模板/节点语义中补充测点含义与判读方法`, `- Measurement semantics: (missing) no semantics configured — physical quantity ${tpl?.ch ?? node.templateKey}; ask the user to add the point meaning and interpretation method`))
  if (node.warnLow != null || node.warnHigh != null) {
    lines.push(tr(locale, `- 预警带: [${node.warnLow ?? '-∞'}, ${node.warnHigh ?? '+∞'}] ${node.unit}(出带=warn,越量程=alarm)`, `- Warning band: [${node.warnLow ?? '-∞'}, ${node.warnHigh ?? '+∞'}] ${node.unit} (outside band = warn, outside range = alarm)`))
  }
  if (win) lines.push(tr(locale, `- 活动配方「${recipe!.name}」监控窗口: [${win.min ?? '-∞'}, ${win.max ?? '+∞'}] ${node.unit}(实时值越限 → 节点标红 + 孪生告警)`, `- Active recipe "${recipe!.name}" monitoring window: [${win.min ?? '-∞'}, ${win.max ?? '+∞'}] ${node.unit} (out-of-window = node red + twin alarm)`))
  lines.push(tr(locale, `- 实时值: ${node.value != null ? `${node.value}${node.unit}` : '暂无数据'}${fresh != null ? `( ${fresh}s 前更新)` : ''},状态 ${node.state},采样 ${node.effectiveInterval(1000)}ms,驱动 ${node.driver},所属产线「${line?.name ?? '未分配'}」`, `- Live value: ${node.value != null ? `${node.value}${node.unit}` : 'no data'}${fresh != null ? ` (updated ${fresh}s ago)` : ''}, state ${node.state}, sampling ${node.effectiveInterval(1000)}ms, driver ${node.driver}, line "${line?.name ?? 'unassigned'}"`))
  if (twinDesc) lines.push(tr(locale, `- 从属设备: ${twinDesc};量测的是该设备的真实过程量`, `- Bound device: ${twinDesc}; this point measures the device's real process variable`))
  lines.push(tr(locale, `- 数据获取: daq_query(node_id='${nodeId}');${mode === 'manual' ? '手动确认模式' : '查询自动执行'}`, `- Data access: daq_query(node_id='${nodeId}'); ${mode === 'manual' ? 'manual approval mode' : 'queries run automatically'}`))
  return lines.join('\n')
}

/** 工具:my_industrial_nodes 的语义卡视图(绑定节点 dcw/daq 全集 ∪ 绑定配方的参数节点) */
export function nodeSemanticCards(agentId: string, localeInput?: PromptLocale): { text: string, stale: number } {
  const locale = localeInput ?? promptLocaleOf(agentId)
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  const cards: string[] = []
  let stale = 0
  const seen = new Set<string>()
  for (const b of bindings) {
    const card = b.kind === 'dcw' ? dcwSemanticCard(b.nodeId, b.mode, locale) : b.kind === 'daq' ? daqSemanticCard(b.nodeId, b.mode, locale) : null
    if (card) {
      cards.push(card)
      seen.add(b.nodeId)
    }
    else stale++
  }
  // 权限模型 v2:recipe 绑定的 Agent 也应看到配方参数节点的语义卡(否则"知道要改
  // 配方却不知道参数是什么物理量");来源标注「经绑定配方」,模式按配方绑定呈现
  const recipeBindings = bindings.filter(b => b.kind === 'recipe')
  const allRecipes = getDcwController().listRecipes()
  for (const rb of recipeBindings) {
    const recipe = allRecipes.find(r => r.id === rb.nodeId)
    if (!recipe) continue
    for (const p of recipe.params) {
      if (seen.has(p.nodeId)) continue
      seen.add(p.nodeId)
      const card = dcwSemanticCard(p.nodeId, 'recipe', locale)
      if (card) cards.push(`${card}\n${tr(locale, `(来源:绑定配方「${recipe.name}」的参数)`, `(source: parameter of bound recipe "${recipe.name}")`)}`)
      else stale++
    }
  }
  return { text: cards.join('\n\n'), stale }
}

/**
 * 配方操作面段(v2 权限模型:让"绑定配方的 Agent"一眼看到怎么做)。
 * 每个绑定配方:名称/描述/版本/运行状态/绑定模式(manual=逐动作 HITL;auto=免批)/
 * 二级认证状态 + 参数对照表(参数 key|描述|执行节点|目标值|窗口)。
 */
export function recipeOperationFace(agentId: string, localeInput?: PromptLocale): string {
  const locale = localeInput ?? promptLocaleOf(agentId)
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId).filter(b => b.kind === 'recipe')
  if (bindings.length === 0) return ''
  const allRecipes = getDcwController().listRecipes()
  const paramViews = new Map(getDcwParamRepoSafe().map(v => [v.nodeId, v]))
  const sections: string[] = []
  for (const b of bindings) {
    const recipe = allRecipes.find(r => r.id === b.nodeId)
    if (!recipe) continue
    const run = getDcwController().listRuns().find(r => r.recipeId === recipe.id && !r.endedAt)
    const access = recipe.access
    const head = [
      tr(locale, `#### ▣ 配方「${recipe.name}」[id=${recipe.id}] v${recipe.version ?? 1}`, `#### ▣ Recipe "${recipe.name}" [id=${recipe.id}] v${recipe.version ?? 1}`),
      tr(locale, `- 运行状态: ${run ? `**执行中**(批次 ${run.id.slice(0, 8)},可操作)——参数写入/下发/试验/回退均已放行` : '**未运行**(运行门:未在执行的配方不可操作;请由用户开跑后再操作)'}`, `- Run state: ${run ? `**running** (batch ${run.id.slice(0, 8)}, operable) — parameter writes/dispatch/trials/rollback are allowed` : '**not running** (run gate: a recipe that is not executing cannot be operated; ask the user to start the line)'}`),
      tr(locale, `- 绑定模式: ${b.mode === 'manual' ? '**manual** —— 你的每次参数写入/下发/试验/回退都会挂起等人工批准;reason 必填且要给出判断依据(数采/MES 证据),审批卡会向人类展示' : '**auto** —— 免人工批准直接执行,但仍受四层限界与运行门约束'}`, `- Binding mode: ${b.mode === 'manual' ? '**manual** — every parameter write/dispatch/trial/rollback waits for human approval; reason is required and must cite evidence; the approval card shows it to the human' : '**auto** — executes without human approval, still bounded by the four-layer limits and run gate'}`),
      tr(locale, `- 二级认证: ${access?.requireAuth ? `已开启(授权清单 ${access.authorizedAgentIds?.length ?? 0} 人;你在清单内才能操作)` : '未开启(绑定即可操作)'}`, `- Secondary auth: ${access?.requireAuth ? `enabled (${access.authorizedAgentIds?.length ?? 0} authorized agents; you must be on the list)` : 'disabled (binding is sufficient)'}`),
      recipe.description ? tr(locale, `- 配方说明: ${recipe.description.slice(0, 160)}`, `- Recipe description: ${recipe.description.slice(0, 160)}`) : null,
    ].filter(Boolean) as string[]
    const rows = recipe.params.map((p) => {
      const node = getDcwController().byId(p.nodeId)
      const pv = paramViews.get(p.nodeId)
      const desc = pv?.desc ?? node?.semantics ?? ''
      const win = (p.min != null || p.max != null) ? tr(locale, `,窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'}${node?.unit ?? ''}`, `, window ${p.min ?? '-∞'}~${p.max ?? '+∞'}${node?.unit ?? ''}`) : ''
      return tr(locale, `  - ${node?.name ?? p.nodeId}:目标 ${p.value}${node?.unit ?? ''}${win} | 参数键 ${pv?.key ?? '-'}${desc ? ` | ${desc.slice(0, 80)}` : ''}`, `  - ${node?.name ?? p.nodeId}: target ${p.value}${node?.unit ?? ''}${win} | key ${pv?.key ?? '-'}${desc ? ` | ${desc.slice(0, 80)}` : ''}`)
    })
    sections.push([...head, tr(locale, '- 参数对照(目标值/窗口/参数键/描述):', '- Parameters (target/window/key/description):'), ...rows].join('\n'))
  }
  if (sections.length === 0) return ''
  return tr(locale, `### 你绑定的配方(操作面;动作入口 recipe_update/recipe_apply/recipe_trial/recipe_rollback)\n${sections.join('\n\n')}`, `### Your bound recipes (operation surface; entry points recipe_update/recipe_apply/recipe_trial/recipe_rollback)\n${sections.join('\n\n')}`)
}

/** 参数面视图(参数面未就绪时返回空,不阻断语义卡) */
function getDcwParamRepoSafe(): Array<{ nodeId: string, key: string, desc?: string }> {
  try {
    return getDcwParamRepo().listViews()
  }
  catch {
    return []
  }
}

/** MES 点位能力标签(纯函数;zh=读/写/史/钩,en=R/W/H/HK) */
export function mesCapabilityLabel(
  e: { readable: boolean, writable: boolean, historyable: boolean, format: string, hooked: boolean },
  locale: PromptLocale = 'zh',
): string {
  const hist = e.historyable ? (e.format !== 'scalar' ? tr(locale, `史·${e.format}`, `H·${e.format}`) : tr(locale, '史', 'H')) : null
  return [e.readable ? tr(locale, '读', 'R') : null, e.writable ? tr(locale, '写', 'W') : null, hist, e.hooked ? tr(locale, '钩', 'HK') : null].filter(Boolean).join('/') || '-'
}

/** 产线工况简报(注入每次回合 prompt;只描述 Agent 绑定节点/绑定配方所在的产线) */
export function buildIndustrialContext(agentId: string, localeInput?: PromptLocale): string {
  const locale = localeInput ?? promptLocaleOf(agentId)
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const dcwIds = bindings.filter(b => b.kind === 'dcw').map(b => b.nodeId)
  const daqIds = bindings.filter(b => b.kind === 'daq').map(b => b.nodeId)
  // recipe 绑定(v2 权限模型)也带来产线场景面 —— 否则只绑配方的 Agent 拿不到工况简报
  const recipeLineIds = bindings.filter(b => b.kind === 'recipe').map((b) => {
    try {
      return getDcwController().listRecipes().find(r => r.id === b.nodeId)?.lineId ?? ''
    }
    catch {
      return ''
    }
  })
  if (dcwIds.length === 0 && daqIds.length === 0 && recipeLineIds.every(x => !x)) return ''

  const lineIds = [...new Set([
    ...dcwIds.map(id => getDcwController().byId(id)?.lineId ?? ''),
    ...daqIds.map(id => getDaqNodeRepo().byId(id)?.lineId ?? ''),
    ...recipeLineIds,
  ])].filter(Boolean)

  const sections: string[] = []
  for (const lineId of lineIds) {
    const line = getDcwLineRepo().byId(lineId)
    if (!line) continue
    const run = getActiveLineRun(lineId)
    const lines: string[] = [tr(locale, `### 产线「${line.name}」(id=${lineId},光晕色 ${line.color})`, `### Line "${line.name}" (id=${lineId}, halo color ${line.color})`)]
    // 场景描述(产线本体说明:工艺场景/规格/闭环目标 —— 用户在建线/编辑产线时填写,
    // 是场景语义最丰富的一手描述;不注入则 Agent 对这条产线是干什么的毫无概念)
    if (line.description?.trim()) lines.push(tr(locale, `- 场景说明: ${line.description.trim().slice(0, 260)}`, `- Scenario description: ${line.description.trim().slice(0, 260)}`))
    if (run) {
      const elapsedMin = Math.round((Date.now() - Date.parse(run.startedAt)) / 60_000)
      lines.push(tr(locale, `- 工况:**运行中**,批次 ${run.runId.slice(0, 8)},产品「${run.productName}」× 配方「${run.recipeName}」,已运行 ${elapsedMin} 分钟,已采集 ${run.taggedSamples} 打标样本`, `- Condition: **running**, batch ${run.runId.slice(0, 8)}, product "${run.productName}" x recipe "${run.recipeName}", ${elapsedMin} min elapsed, ${run.taggedSamples} tagged samples`))
      const recipe = getDcwController().listRecipes().find(r => r.id === run.recipeId)
      const product = recipe ? getDcwProductRepo().byId(recipe.productId) : undefined
      if (product?.description?.trim()) lines.push(tr(locale, `- 产品说明(${product.name}): ${product.description.trim().slice(0, 160)}`, `- Product description (${product.name}): ${product.description.trim().slice(0, 160)}`))
      if (recipe) {
        const params = recipe.params
          .map((p) => {
            const n = getDcwController().byId(p.nodeId)
            const win = (p.min != null || p.max != null) ? tr(locale, ` 窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'}${n?.unit ?? ''}`, ` window ${p.min ?? '-∞'}~${p.max ?? '+∞'}${n?.unit ?? ''}`) : ''
            return `${n?.name ?? p.nodeId}=${p.value}${n?.unit ?? ''}${win}`
          })
          .join(';')
        lines.push(tr(locale, `- 配方工艺参数: ${params}`, `- Recipe process parameters: ${params}`))
        const wins = (recipe.daqWindows ?? [])
          .map((w) => {
            const n = getDaqNodeRepo().byId(w.nodeId)
            return `${n?.name ?? w.nodeId} ∈ [${w.min ?? '-∞'}, ${w.max ?? '+∞'}]${n?.unit ?? ''}`
          })
          .join(';')
        if (wins) lines.push(tr(locale, `- 数采监控窗口(越限即报警): ${wins}`, `- DAQ monitoring windows (out-of-window alarms): ${wins}`))
      }
    }
    else {
      lines.push(tr(locale, '- 工况:**停线**(无活动批次;写入仅受节点全局量程约束,数采暂停)', '- Condition: **line stopped** (no active batch; writes are bounded only by global node range, DAQ paused)'))
    }
    const twinNames = new Set<string>()
    for (const id of [...dcwIds, ...daqIds]) {
      for (const desc of [
        ...describeTwins(getDcwController().byId(id) ?? {}),
        ...describeTwins(getDaqNodeRepo().byId(id) ?? {}),
      ]) {
        if (desc) twinNames.add(desc)
      }
    }
    if (twinNames.size > 0) lines.push(tr(locale, `- 关联设备孪生: ${Array.from(twinNames).join(' | ')}`, `- Associated device twins: ${Array.from(twinNames).join(' | ')}`))
    // 当前报警透出(只报本 Agent 绑定的数采节点):越限即报警是工况里最需要
    // Agent 优先感知的事实 —— 不注入的话,Agent 只能靠 daq_query 事后发现
    // 类型谓词(不收窄就无法在下游安全读 n.name/n.value/n.unit):
    // `!!n && ...` 与原 `n && ...` 的真值判定完全一致,只补返回类型标注。
    const alarms = daqIds
      .map(id => getDaqNodeRepo().byId(id))
      .filter((n): n is DaqNode => !!n && n.lineId === lineId && n.state === 'alarm')
    if (alarms.length > 0) {
      lines.push(tr(locale, `- **当前报警**: ${alarms.map(n => `${n.name} 实时 ${n.value ?? '?'}${n.unit} 处于报警态(越量程或越配方监控窗口)`)},应优先判读(设定-响应滞后 vs 真实异常)并处置`, `- **Active alarms**: ${alarms.map(n => `${n.name} live ${n.value ?? '?'}${n.unit} is in alarm (out of range or out of recipe window)`)}, prioritize diagnosis (setpoint-response lag vs real fault) and act`))
    }
    // MES REST 点位段:本产线 mes-rest 节点 ≤30 条全量简列(>30 给前 30 + 检索指引);
    // 只列语义面(名称/单位/量程/能力/desc),取数走 mes_fetch(原文不进 prompt)
    try {
      const mesEntries = getDcwNodeRepo().all()
        .filter(n => n.lineId === lineId && n.driver === MES_REST_DRIVER_KIND)
        .map(mesCatalogEntryOf)
      if (mesEntries.length > 0) {
        const MES_BRIEF_MAX = 30
        const shown = mesEntries.slice(0, MES_BRIEF_MAX)
          .map(e => `  ${e.name}|${e.unit || '-'}|${e.min}~${e.max}|${mesCapabilityLabel(e, locale)}|${e.desc.slice(0, 40)}`)
        const rest = mesEntries.length - shown.length
        lines.push(tr(locale, `- MES REST 点位(${mesEntries.length} 条,名称|单位|量程|读写与格式能力(史·vector=检测向量,史·image=图像帧,钩=取数后自动下沉处理)|描述):\n${shown.join('\n')}${rest > 0 ? `\n  (其余 ${rest} 条未列出,用 mes_catalog 检索)` : ''}`, `- MES REST points (${mesEntries.length}; name|unit|range|capabilities (H·vector=inspection vector, H·image=image frame, HK=post-fetch sink)|description):\n${shown.join('\n')}${rest > 0 ? `\n  (${rest} more not listed; use mes_catalog to search)` : ''}`))
      }
    }
    catch { /* MES 面未就绪(单测/降级)不阻断简报 */ }
    sections.push(lines.join('\n'))
  }
  if (sections.length === 0) return ''
  return tr(locale, `## 产线工况简报(实时;每次回合自动注入)\n${sections.join('\n\n')}`, `## Line condition brief (live; injected every turn)\n${sections.join('\n\n')}`)
}

/**
 * 工业调控作业环(prompt 层纪律注入;有工业绑定才注入,零硬编码)。
 * 与节点语义卡(my_industrial_nodes 结果)互补:语义卡在工具调用后可见,
 * 作业环保证 Agent 在**任何回合开头**就知道调控方法论。
 * 七步闭环(v2.1):观察 → 理解 → 假设 → 设定 → 判定 → 回退/保持 → 复盘;
 * 每次下发自动开优化记录、判定入册、回退可审计 —— 闭环由系统记账,Agent 负责判断质量。
 */
export function industrialLoopGuide(agentId: string, localeInput?: PromptLocale): string {
  const locale = localeInput ?? promptLocaleOf(agentId)
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  if (bindings.length === 0) return ''
  // 权限模型 v2:写面收敛到 recipe(节点直写工具已摘除);hasDcw 仅剩存量兼容绑定
  const hasRecipe = bindings.some(b => b.kind === 'recipe')
  const hasManualRecipe = bindings.some(b => b.kind === 'recipe' && b.mode === 'manual')
  const steps: string[] = [
    tr(locale, '1. 观察:daq_query / mes_fetch 获取绑定产线的真实时序数据(数采/检测/MES 多源;支持按产品/配方/时间窗过滤),结合返回的工况判读理解当前状态。', '1. Observe: use daq_query / mes_fetch to obtain real time-series from the bound line (DAQ/inspection/MES; filterable by product/recipe/time window), and read the returned condition summary to understand the current state.'),
    tr(locale, '2. 理解:my_industrial_nodes 与 line_context 读取语义卡 —— 物理量含义/单位/安全量程/活动配方工艺窗口/单次调幅步进,以及调控闭环状态(进行中的优化记录/上次良好值/最近判定)。', '2. Understand: read semantic cards via my_industrial_nodes and line_context — physical meaning/unit/safe range/active recipe window/per-step cap, plus loop state (open optimization record/last good value/latest verdict).'),
  ]
  if (hasRecipe) {
    steps.push(
      tr(locale, '3. 假设:调参前先声明假设与理由 —— 目标值 + 预期效果 + 判断依据(数采/MES 证据);目标必须落在「安全量程 ∩ 活动配方工艺窗口」内,优先小步幅(≤量程 2%)、单向逼近。理由必填且会被人类在审批卡上看到。', '3. Hypothesize: before tuning, state the hypothesis and rationale — target + expected effect + evidence (DAQ/MES); the target must lie inside "safe range ∩ active recipe window", prefer small monotonic steps (<=2% of range). The rationale is required and shown to the human on the approval card.'),
      tr(locale, '4. 设定:对绑定的配方操作 —— recipe_trial(候选整批试验,不写版本)或 recipe_update(写入新版本)+ recipe_apply(整批下发);治理联锁(量程∩参数∩产品∩配方 + 步长 + 限速)在配方面照常生效,底层数控节点(PLC/MES)由配置层承接,无需关心差异。运行中的批次一次只改本配方绑定的参数;等待工艺响应,勿连续大幅调整。', '4. Set: operate on the bound recipe — recipe_trial (candidate batch without version) or recipe_update (new version) + recipe_apply (dispatch batch); governance interlocks (range ∩ parameter ∩ product ∩ recipe + step + rate) still apply on the recipe face, and PLC/MES differences are absorbed by config. Change only parameters bound to this recipe at a time, and wait for the process response before further large adjustments.'),
      tr(locale, '5. 判定:daq_query / mes_fetch 复测窗口数据后落判定 —— keep(达标/有进步:无动作或 recipe_update 固化候选值)/ rollback(劣化)/ uncertain(证据不足,继续观察)。判定必须引用具体数值与时间窗证据。注意:判定直接以复测数据对照你的假设陈述,不要调用 dcw_judge —— 那是旧直写时代的优化记录面(opt-* 记录),配方面链路(批次 rr-*)不产生该记录,调用必报「不存在」。', '5. Decide: re-measure with daq_query / mes_fetch, then record keep (target met/improved: no action or recipe_update to persist the candidate) / rollback (degraded) / uncertain (insufficient evidence; keep observing). Cite concrete numbers and time windows. Do NOT call dcw_judge — that is the legacy direct-write optimization ledger (opt-* records); the recipe path (rr-* batches) does not create those records and the call will always report "not found".'),
      tr(locale, '6. 回退/保持:判 rollback 后用 recipe_rollback(dispatch=true, reason=…) 统一回退(定义回退+参数整批恢复),回退后复测确认;回退冷却期内禁止同向重写。增益趋零/杠杆失效时,如实汇报实测增益并上报请求决策(换杠杆/调目标/接受当前点),而非盲目加码。', '6. Roll back / hold: after rollback, use recipe_rollback(dispatch=true, reason=…) to restore the definition and parameters together, then re-measure; same-direction rewrites are forbidden during the cooldown. If gain approaches zero or the lever fails, report measured gain and escalate for a decision (change lever/target/accept current point) instead of blindly pushing harder.'),
      tr(locale, '7. 复盘:recipe_versions / dcw_journal 查看变更史与写历史;达标候选值用 recipe_update 固化为新版本(带 reason),rollback 的结论写进共享记忆修正下次假设 —— 禁止重复已失败的调参方向。', '7. Review: inspect change/write history via recipe_versions / dcw_journal; persist a good candidate with recipe_update (with reason), and write rollback conclusions into shared memory to correct the next hypothesis — never repeat a failed direction.'),
    )
  }
  else {
    steps.push(tr(locale, '3. 判读:你是量测侧 —— 数据越过配方监控窗口会触发节点报警与孪生告警;判读时区分「同线数控设定-响应滞后」与「真实过程异常」,结论引用具体数值与时间窗。', '3. Interpret: you are on the measurement side — data leaving the recipe window triggers node and twin alarms; distinguish "same-line setpoint/response lag" from a real process fault, citing concrete numbers and time windows.'))
  }
  if (hasManualRecipe) {
    steps.push(tr(locale, '8. 权限边界:你绑定的配方为 manual 模式 —— 每次参数写入/下发/试验/回退前必须给出理由并等待人类批准(批准附言会随结果返回,请响应其关切;审批 30 分钟窗内无人裁决=默认拒绝);经显式确认切到 auto 的配方免批,但同样受联锁与运行门约束(配方未在执行时一律不可操作)。', '8. Permission boundary: your recipe is in manual mode — every parameter write/dispatch/trial/rollback requires a rationale and human approval (the approval comment is returned with the result; address it; no decision within 30 minutes = default deny). Recipes explicitly switched to auto skip approval but still obey interlocks and the run gate (no operation while the recipe is not executing).'))
  }
  steps.push(tr(locale, `${steps.length + 1}. 数值口径:工具返回的采集/设定值均为经标定钩子处理后的真实物理量纲;引用数值时带上单位与时间,便于人工复核。`, `${steps.length + 1}. Units: all sampled/setpoint values returned by tools are real engineering units after calibration hooks; cite units and timestamps so a human can verify.`))
  const history = recentOptimizationNotes(agentId, locale)
  return tr(locale, `## 工业调控作业环(你的节点操作方法论,每回合生效)\n${steps.join('\n')}${history}`, `## Industrial control loop (your node operating method, active every turn)\n${steps.join('\n')}${history}`)
}

/** 经验注入:该 Agent 绑定数控节点的最近优化记录结论(keep/rollback 统计),跨任务积累 */
function recentOptimizationNotes(agentId: string, locale: PromptLocale = 'zh'): string {
  try {
    const rb = getRecipeRollBackManager()
    const bindings = getAgentNodeBindingRepo().byAgent(agentId)
    const dcwNodes = bindings.filter(b => b.kind === 'dcw').map(b => b.nodeId)
    const recipes = bindings.filter(b => b.kind === 'recipe').map((b) => {
      const r = getDcwController().listRecipes().find(x => x.id === b.nodeId)
      return { recipeId: b.nodeId, name: r?.name ?? b.nodeId, paramNodeIds: (r?.params ?? []).map(p => p.nodeId) }
    })
    if (dcwNodes.length === 0 && recipes.length === 0) return ''
    const lines = optimizationNoteLines({
      dcwNodes,
      recipes,
      recordsOf: filter => rb.records({ ...filter, limit: 20 }),
    }, locale)
    if (lines.length === 0) return ''
    return tr(locale, `\n\n## 优化经验台账(你绑定节点的近期调控结论;避免重复已失败方向)\n${lines.join('\n')}`, `\n\n## Optimization experience ledger (recent verdicts for your bound nodes; avoid repeating failed directions)\n${lines.join('\n')}`)
  }
  catch {
    return ''
  }
}

export interface OptimizationNoteSource {
  /** 直接绑定的数控节点 id(旧链路 dcw-*) */
  dcwNodes: string[]
  /** 配方绑定(recipe 链路 rr-*;OptimizationRecord.recipeId 匹配;无匹配退参数节点维度) */
  recipes: Array<{ recipeId: string, name: string, paramNodeIds?: string[] }>
  recordsOf: (filter: { nodeId?: string, recipeId?: string }) => Array<{
    nodeName: string
    status: string
    judge?: { verdict: string, reason: string } | null
  }>
}

/**
 * 纯装配(便于单测):dcw 节点按 nodeId、配方按 recipeId 聚合近期判定。
 * 配方无记录时如实提示一行 —— 避免模型把「空」误判成查询失败而反复重试。
 */
export function optimizationNoteLines(src: OptimizationNoteSource, locale: PromptLocale = 'zh'): string[] {
  const lines: string[] = []
  for (const nodeId of src.dcwNodes.slice(0, 3)) {
    const records = src.recordsOf({ nodeId })
    if (records.length === 0) continue
    const keep = records.filter(r => r.judge?.verdict === 'keep').length
    const roll = records.filter(r => r.judge?.verdict === 'rollback' || r.status === 'rolled-back').length
    const last = records.find(r => r.judge)
    lines.push(tr(locale, `- ${records[0]!.nodeName}:近 ${records.length} 次调控(keep ${keep}/rollback ${roll})${last?.judge ? `,最近判定 ${last.judge.verdict}(${last.judge.reason.slice(0, 60)})` : ''}`, `- ${records[0]!.nodeName}: last ${records.length} tunings (keep ${keep}/rollback ${roll})${last?.judge ? `, latest verdict ${last.judge.verdict}(${last.judge.reason.slice(0, 60)})` : ''}`))
  }
  for (const { recipeId, name, paramNodeIds } of src.recipes.slice(0, 3)) {
    let records = src.recordsOf({ recipeId })
    // 无 recipeId 匹配 → 退参数节点维度(旧 dcw 链路记录仍可复用)
    if (records.length === 0 && paramNodeIds?.length) {
      const byNode = paramNodeIds.flatMap(nodeId => src.recordsOf({ nodeId }))
      const seen = new Set<string>()
      records = byNode.filter((r) => {
        const key = `${r.nodeName}|${r.status}|${r.judge?.reason ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 20)
    }
    if (records.length === 0) {
      lines.push(tr(locale, `- ${name}:暂无历史调控记录(该配方尚无可复用的调参结论)`, `- ${name}: no tuning history yet (no reusable conclusion for this recipe)`))
      continue
    }
    const keep = records.filter(r => r.judge?.verdict === 'keep').length
    const roll = records.filter(r => r.judge?.verdict === 'rollback' || r.status === 'rolled-back').length
    const last = records.find(r => r.judge)
    lines.push(tr(locale, `- ${name}(配方):近 ${records.length} 次调控(keep ${keep}/rollback ${roll})${last?.judge ? `,最近判定 ${last.judge.verdict}(${last.judge.reason.slice(0, 60)})` : ''}`, `- ${name}(recipe): last ${records.length} tunings (keep ${keep}/rollback ${roll})${last?.judge ? `, latest verdict ${last.judge.verdict}(${last.judge.reason.slice(0, 60)})` : ''}`))
  }
  return lines
}
