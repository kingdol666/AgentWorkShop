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
function dcwSemanticCard(nodeId: string, mode: string): string | null {
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
  const stepText = stepProfile.stepLimit == null ? '未配置(探索阶段禁止无界写入)' : `${Number(stepProfile.stepLimit.toFixed(node.decimals))}${node.unit}(来源:${stepProfile.stepLimitSource})`
  const route = isMes
    ? '写入经 MES 集成下发(REST API;多字段接口由 writeHook 只组装本节点声明的字段,writeCheckHook 二次校验回执)'
    : `写入经驱动 ${node.driver} 下发 PLC(寄存器/换算封装在驱动配置内,你只面对工程量)`

  const lines = [
    `#### ◆ ${node.name} [id=${nodeId}]${isMes ? '[MES 集成点位]' : ''}`,
    `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},精度 ${node.decimals} 位小数`,
  ]
  if (sem) lines.push(`- 工艺语义: ${sem}${nodeSem ? '' : tplSem ? '(来自模板)' : '(来自 MES 点位描述)'}`)
  else lines.push(`- 工艺语义: (待补)该节点未填写工艺语义 —— 物理量 ${tpl?.ch ?? node.templateKey};请让用户在模板/节点语义中补充物理机理与调参守则后再做大幅调整`)
  lines.push(`- 安全量程: [${node.min}, ${node.max}] ${node.unit}(硬联锁,越界即拒)`)
  if (param && (param.min != null || param.max != null)) {
    lines.push(`- 活动配方「${recipe!.name}」工艺窗口: [${param.min ?? '-∞'}, ${param.max ?? '+∞'}] ${node.unit}(软联锁,配方目标值 ${param.value}${node.unit ?? ''})`)
  }
  else if (run) {
    lines.push(`- 活动配方「${run.recipeName}」未对本节点设窗口(全局量程生效)`)
  }
  lines.push(`- 当前设定: ${node.value != null ? `${node.value}${node.unit}` : '未下发'},状态 ${node.state},所属产线「${line?.name ?? '未分配'}」`)
  if (twinDesc) lines.push(`- 从属设备: ${twinDesc};你的写入经 PLC 下发后反映到该设备的物理行为`)
  lines.push(`- 下发链路: ${route};参数写入与下发一律走你绑定的配方(recipe_update 保存版本 / recipe_apply 整批下发 / recipe_trial 候选试验),四层限界(量程∩参数∩产品∩配方)与单步上限在配方面照常生效`)
  lines.push(`- 操作守则: 单次调幅硬上限 ≤${stepText};下发后等待工艺响应再评估;目标值必须落在窗口内;${mode === 'manual' ? '**手动确认模式**,每次下发会请求用户批准,请在下发前说明理由' : mode === 'recipe' ? '经配方绑定操作:绑定 manual 时逐动作人工批准,auto 直接执行(配方未在运行时不可操作)' : '自动模式,直接执行'}`)
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
  const twinDesc = describeTwins(node).join(' | ') || null
  const fresh = node.lastAt ? Math.round((Date.now() - Date.parse(node.lastAt)) / 1000) : null

  const lines = [
    `#### ◇ ${node.name} [id=${nodeId}]`,
    `- 物理量: ${tpl?.ch ?? node.templateKey},单位 ${node.unit},正常量程 [${node.min}, ${node.max}] ${node.unit}`,
  ]
  if (sem) lines.push(`- 采集语义: ${sem}`)
  else lines.push(`- 采集语义: (待补)该节点未填写采集语义 —— 物理量 ${tpl?.ch ?? node.templateKey};请让用户在模板/节点语义中补充测点含义与判读方法`)
  if (node.warnLow != null || node.warnHigh != null) {
    lines.push(`- 预警带: [${node.warnLow ?? '-∞'}, ${node.warnHigh ?? '+∞'}] ${node.unit}(出带=warn,越量程=alarm)`)
  }
  if (win) lines.push(`- 活动配方「${recipe!.name}」监控窗口: [${win.min ?? '-∞'}, ${win.max ?? '+∞'}] ${node.unit}(实时值越限 → 节点标红 + 孪生告警)`)
  lines.push(`- 实时值: ${node.value != null ? `${node.value}${node.unit}` : '暂无数据'}${fresh != null ? `( ${fresh}s 前更新)` : ''},状态 ${node.state},采样 ${node.effectiveInterval(1000)}ms,驱动 ${node.driver},所属产线「${line?.name ?? '未分配'}」`)
  if (twinDesc) lines.push(`- 从属设备: ${twinDesc};量测的是该设备的真实过程量`)
  lines.push(`- 数据获取: daq_query(node_id='${nodeId}');${mode === 'manual' ? '手动确认模式' : '查询自动执行'}`)
  return lines.join('\n')
}

/** 工具:my_industrial_nodes 的语义卡视图(绑定节点 dcw/daq 全集 ∪ 绑定配方的参数节点) */
export function nodeSemanticCards(agentId: string): { text: string, stale: number } {
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  const cards: string[] = []
  let stale = 0
  const seen = new Set<string>()
  for (const b of bindings) {
    const card = b.kind === 'dcw' ? dcwSemanticCard(b.nodeId, b.mode) : b.kind === 'daq' ? daqSemanticCard(b.nodeId, b.mode) : null
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
      const card = dcwSemanticCard(p.nodeId, 'recipe')
      if (card) cards.push(`${card}\n(来源:绑定配方「${recipe.name}」的参数)`)
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
export function recipeOperationFace(agentId: string): string {
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
      `#### ▣ 配方「${recipe.name}」[id=${recipe.id}] v${recipe.version ?? 1}`,
      `- 运行状态: ${run ? `**执行中**(批次 ${run.id.slice(0, 8)},可操作)——参数写入/下发/试验/回退均已放行` : '**未运行**(运行门:未在执行的配方不可操作;请由用户开跑后再操作)'}`,
      `- 绑定模式: ${b.mode === 'manual' ? '**manual** —— 你的每次参数写入/下发/试验/回退都会挂起等人工批准;reason 必填且要给出判断依据(数采/MES 证据),审批卡会向人类展示' : '**auto** —— 免人工批准直接执行,但仍受四层限界与运行门约束'}`,
      `- 二级认证: ${access?.requireAuth ? `已开启(授权清单 ${access.authorizedAgentIds?.length ?? 0} 人;你在清单内才能操作)` : '未开启(绑定即可操作)'}`,
      recipe.description ? `- 配方说明: ${recipe.description.slice(0, 160)}` : null,
    ].filter(Boolean) as string[]
    const rows = recipe.params.map((p) => {
      const node = getDcwController().byId(p.nodeId)
      const pv = paramViews.get(p.nodeId)
      const desc = pv?.desc ?? node?.semantics ?? ''
      const win = (p.min != null || p.max != null) ? `,窗口 ${p.min ?? '-∞'}~${p.max ?? '+∞'}${node?.unit ?? ''}` : ''
      return `  - ${node?.name ?? p.nodeId}:目标 ${p.value}${node?.unit ?? ''}${win} | 参数键 ${pv?.key ?? '-'}${desc ? ` | ${desc.slice(0, 80)}` : ''}`
    })
    sections.push([...head, '- 参数对照(目标值/窗口/参数键/描述):', ...rows].join('\n'))
  }
  if (sections.length === 0) return ''
  return `### 你绑定的配方(操作面;动作入口 recipe_update/recipe_apply/recipe_trial/recipe_rollback)\n${sections.join('\n\n')}`
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

/** 产线工况简报(注入每次回合 prompt;只描述 Agent 绑定节点/绑定配方所在的产线) */
export function buildIndustrialContext(agentId: string): string {
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
    const lines: string[] = [`### 产线「${line.name}」(id=${lineId},光晕色 ${line.color})`]
    // 场景描述(产线本体说明:工艺场景/规格/闭环目标 —— 用户在建线/编辑产线时填写,
    // 是场景语义最丰富的一手描述;不注入则 Agent 对这条产线是干什么的毫无概念)
    if (line.description?.trim()) lines.push(`- 场景说明: ${line.description.trim().slice(0, 260)}`)
    if (run) {
      const elapsedMin = Math.round((Date.now() - Date.parse(run.startedAt)) / 60_000)
      lines.push(`- 工况:**运行中**,批次 ${run.runId.slice(0, 8)},产品「${run.productName}」× 配方「${run.recipeName}」,已运行 ${elapsedMin} 分钟,已采集 ${run.taggedSamples} 打标样本`)
      const recipe = getDcwController().listRecipes().find(r => r.id === run.recipeId)
      const product = recipe ? getDcwProductRepo().byId(recipe.productId) : undefined
      if (product?.description?.trim()) lines.push(`- 产品说明(${product.name}): ${product.description.trim().slice(0, 160)}`)
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
      for (const desc of [
        ...describeTwins(getDcwController().byId(id) ?? {}),
        ...describeTwins(getDaqNodeRepo().byId(id) ?? {}),
      ]) {
        if (desc) twinNames.add(desc)
      }
    }
    if (twinNames.size > 0) lines.push(`- 关联设备孪生: ${Array.from(twinNames).join(' | ')}`)
    // 当前报警透出(只报本 Agent 绑定的数采节点):越限即报警是工况里最需要
    // Agent 优先感知的事实 —— 不注入的话,Agent 只能靠 daq_query 事后发现
    // 类型谓词(不收窄就无法在下游安全读 n.name/n.value/n.unit):
    // `!!n && ...` 与原 `n && ...` 的真值判定完全一致,只补返回类型标注。
    const alarms = daqIds
      .map(id => getDaqNodeRepo().byId(id))
      .filter((n): n is DaqNode => !!n && n.lineId === lineId && n.state === 'alarm')
    if (alarms.length > 0) {
      lines.push(`- **当前报警**: ${alarms.map(n => `${n.name} 实时 ${n.value ?? '?'}${n.unit} 处于报警态(越量程或越配方监控窗口)`)},应优先判读(设定-响应滞后 vs 真实异常)并处置`)
    }
    // MES REST 点位段:本产线 mes-rest 节点 ≤30 条全量简列(>30 给前 30 + 检索指引);
    // 只列语义面(名称/单位/量程/能力/desc),取数走 mes_fetch(原文不进 prompt)
    try {
      const mesEntries = getDcwNodeRepo().all()
        .filter(n => n.lineId === lineId && n.driver === MES_REST_DRIVER_KIND)
        .map(mesCatalogEntryOf)
      if (mesEntries.length > 0) {
        const MES_BRIEF_MAX = 30
        const capOf = (e: { readable: boolean, writable: boolean, historyable: boolean, format: string, hooked: boolean }): string => {
          const hist = e.historyable ? (e.format !== 'scalar' ? '史·' + e.format : '史') : null
          return [e.readable ? '读' : null, e.writable ? '写' : null, hist, e.hooked ? '钩' : null].filter(Boolean).join('/') || '-'
        }
        const shown = mesEntries.slice(0, MES_BRIEF_MAX)
          .map(e => `  ${e.name}|${e.unit || '-'}|${e.min}~${e.max}|${capOf(e)}|${e.desc.slice(0, 40)}`)
        const rest = mesEntries.length - shown.length
        lines.push(`- MES REST 点位(${mesEntries.length} 条,名称|单位|量程|读写与格式能力(史·vector=检测向量,史·image=图像帧,钩=取数后自动下沉处理)|描述):\n${shown.join('\n')}${rest > 0 ? `\n  (其余 ${rest} 条未列出,用 mes_catalog 检索)` : ''}`)
      }
    }
    catch { /* MES 面未就绪(单测/降级)不阻断简报 */ }
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
  // 权限模型 v2:写面收敛到 recipe(节点直写工具已摘除);hasDcw 仅剩存量兼容绑定
  const hasRecipe = bindings.some(b => b.kind === 'recipe')
  const hasManualRecipe = bindings.some(b => b.kind === 'recipe' && b.mode === 'manual')
  const steps: string[] = [
    '1. 观察:daq_query / mes_fetch 获取绑定产线的真实时序数据(数采/检测/MES 多源;支持按产品/配方/时间窗过滤),结合返回的工况判读理解当前状态。',
    '2. 理解:my_industrial_nodes 与 line_context 读取语义卡 —— 物理量含义/单位/安全量程/活动配方工艺窗口/单次调幅步进,以及调控闭环状态(进行中的优化记录/上次良好值/最近判定)。',
  ]
  if (hasRecipe) {
    steps.push(
      '3. 假设:调参前先声明假设与理由 —— 目标值 + 预期效果 + 判断依据(数采/MES 证据);目标必须落在「安全量程 ∩ 活动配方工艺窗口」内,优先小步幅(≤量程 2%)、单向逼近。理由必填且会被人类在审批卡上看到。',
      '4. 设定:对绑定的配方操作 —— recipe_trial(候选整批试验,不写版本)或 recipe_update(写入新版本)+ recipe_apply(整批下发);治理联锁(量程∩参数∩产品∩配方 + 步长 + 限速)在配方面照常生效,底层数控节点(PLC/MES)由配置层承接,无需关心差异。运行中的批次一次只改本配方绑定的参数;等待工艺响应,勿连续大幅调整。',
      '5. 判定:daq_query / mes_fetch 复测窗口数据后,dcw_judge 落判定 —— keep(已验证经验)/ rollback(判应回退)/ uncertain(证据不足)。判定必须引用具体数值与时间窗证据。',
      '6. 回退/保持:判 rollback 后用 recipe_rollback(dispatch=true, reason=…) 统一回退(定义回退+参数整批恢复),回退后复测确认;回退冷却期内禁止同向重写。收敛异常时分析根因或上报,而非盲目加码。',
      '7. 复盘:recipe_versions / dcw_journal 查看变更史与判定结论;keep 的记录是已验证经验,rollback 的记录写进结论修正下次假设 —— 禁止重复已失败的调参方向。',
    )
  }
  else {
    steps.push('3. 判读:你是量测侧 —— 数据越过配方监控窗口会触发节点报警与孪生告警;判读时区分「同线数控设定-响应滞后」与「真实过程异常」,结论引用具体数值与时间窗。')
  }
  if (hasManualRecipe) {
    steps.push('8. 权限边界:你绑定的配方为 manual 模式 —— 每次参数写入/下发/试验/回退前必须给出理由并等待人类批准(批准附言会随结果返回,请响应其关切;审批 30 分钟窗内无人裁决=默认拒绝);经显式确认切到 auto 的配方免批,但同样受联锁与运行门约束(配方未在执行时一律不可操作)。')
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
