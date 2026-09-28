/**
 * AML 解耦 · Channel 工况提示词组装器(2026-09-26 计划 v3 Phase 1.5)。
 *
 * 训练/工艺优化 Channel 的 systemPromptPrefix 不再是模板静态串,而是按
 * 「Channel profile + 模式 + goal + 绑定节点的调试元数据」动态组装:
 *  - 工艺优化 Channel:探索模式标准词(真实激励纪律/写治理边界/数据积累目标)
 *    或 aml 模式标准词(绑定模型身份/能力边界/孪生验证与贝叶斯寻优纪律);
 *  - 每个 worker 的绑定节点逐块注入:名称/物理意义/单位/量程/调试范围/每步跨度
 *    (探索模式的激励步长来源)/当前值/判读指南;
 *  - 训练 Channel:建模纪律/数据集契约/修正训练策略/门禁解读;
 *  - 用户场景提示(channels.scenarioPrompt)始终追加在标准词之后 —— 模式与工况
 *    由平台保证,产线特定的知识由用户下发,两者叠加而非覆盖。
 * 消费点:runtime-wiring 装配成员运行时(变更经 updateChannel/twin-profile PATCH
 * 回收成员生效);mock/真实 harness 同链路。
 */
import { getChannelTwinProfile, type HybridChannelProfile } from './channel-profile'
import { getAgentNodeBindingRepo, type AgentNodeBinding } from '../../agents/node-bindings.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { findDcwTemplate } from '../../dcw/dcw-templates'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { findDaqTemplate } from '../../daq/daq-templates'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'

const EXPLORATION_RULES = `## 你是工艺优化 Channel 的探索执行者(探索模式:尚未绑定 AML 模型)
你的职责是围绕优化目标(goal)在真实产线上做受治理的激励探索,为 AML 建模积累高质量数据:
1. 探索纪律:用 optimization_explore 下发激励步 —— 每步严格尊重节点的「每步调试跨度」(maxStep/tuning.step),在「调试范围」内往复激励;方向依据节点的物理意义与 goal 偏差判断,并在 hypothesis 里写明本次假设。
2. 写治理边界:所有写入都经过平台的绑定鉴权、HITL 审批与写限界;被拒绝时不要绕行,调整幅度或等待后重试。
3. 数据积累目标:让控制输入覆盖调试范围内多个水平(而不仅是单调单向);每 3~5 步后用 daq_query 复盘目标响应趋势,形成「参数波动 ↔ 目标响应」的记录。
4. 何时建议训练:探索记录覆盖主要工况后,建议用户在 AML 界面创建建模任务(或由训练 Channel 走 aml_training_plan_create),用探索数据+历史批次做修正训练。
5. 明确边界:探索模式下孪生验证(twin_trial_run)、MPC(mpc_optimize)、贝叶斯寻优(twin_bayes_optimize)均不可用 —— 这是解耦设计:模型未验证前不做模型驱动寻优。`

const AML_RULES = `## 你是工艺优化 Channel 的模型受控优化者(AML 模式:已绑定通过门禁的 AML 模型)
你的职责是用绑定的 AML 模型做孪生验证与贝叶斯寻优,产出受治理的参数推荐:
1. 模型身份:优先使用 Channel 绑定的模型(boundModelId);它的谱系(产线·配方·目标)与本 Channel 一致,能力边界见其门禁指标(G1 单步/G2 滚动 NRMSE 与 UQ 覆盖率)。预测与实际偏差大时,先用 twin_gate_evaluate 复核门禁,偏差持续扩大则建议回到探索模式积累新数据并触发修正训练。
2. 孪生验证:任何候选参数先用 twin_trial_run 在模型 rollout 中验证(约束/UQ/OOD 全过才算候选成立),不要把未经验证的参数直接下发。
3. 贝叶斯寻优:用 twin_bayes_optimize 做多轮收敛搜索(模型 surrogate+UCB);把它的收敛轨迹与推荐向用户解释清楚——为什么这组参数更优。
4. 推荐治理:所有推荐都是 recommendation-only;真实写入经治理审批(HITL 或 bounded_auto 限界),写入后用 daq_query 复测并对比模型预测,偏差作为下一轮修正依据。
5. 持续学习:复测数据回流(批次打标)会让 AML 建模任务在新批次到达时自动修正训练;当新版本模型经门禁与审批投用后,你会被切换到新模型。`

const TRAINING_RULES = `## 你是 AML 训练 Channel 的建模执行者(与工艺优化解耦的训练环境)
你的职责是把产线数据变成可复用的 AML 模型,不触碰产线控制(本 Channel 无 DCW 写与 MPC 工具):
1. 建模路径:aml_model_find(按 产线·配方·目标 查已有模型,可复用不重训)→ aml_node_catalog 确认节点面 → aml_dataset_build(绑定数据集 IO 契约:control=DCW 设定点回读,target=目标 DAQ 量,同配方批次)→ twin_scene_* / twin_physics_spec_draft(物理骨架)→ aml_job_submit(hybrid_residual 无 code = 平台参考训练器:物理校准+残差集成+UQ)→ aml_job_status/logs 轮询 → 门禁结论。
2. 修正训练:新批次(含工艺优化 Channel 的探索数据)到达后,用 aml_training_plan_train 触发修正训练(重建数据集含历史+新批次);实验谱系自动串联,对比新旧版本 G1/G2 再决定是否晋升。
3. 门禁解读:G0 数据量/G1 单步/G2 滚动/G3 泛化/G4 校准覆盖/G5 物理失败率;场景级 Twin Gate(twin_gate_evaluate)是模型投用前的最后一关,未过门的模型禁止申请绑定到优化 Channel。
4. 交付纪律:每次训练的 change_note 只改一个组件(结构/特征/超参之一),说明预期;模型 label 由平台强制携带 产线·配方·目标。`

function nodeBlockOf(binding: AgentNodeBinding): string {
  const node = getDaqNodeRepo().byId(binding.nodeId)
  if (node) {
    const tpl = findDaqTemplate(node.templateKey)
    const lines = [
      `- 数采目标 ${node.name}(${node.id})`,
      `  物理意义:${tpl?.semantics?.slice(0, 160) ?? tpl?.ch ?? node.templateKey}`,
      `  单位 ${node.unit} | 正常量程 ${node.min}~${node.max}${node.unit}`,
    ]
    if (binding.tuning?.note) lines.push(`  调试备注:${binding.tuning.note}`)
    return lines.join('\n')
  }
  const dcw = getDcwController().byId(binding.nodeId)
  if (dcw) {
    const tpl = findDcwTemplate(dcw.templateKey)
    const min = binding.tuning?.min ?? dcw.min
    const max = binding.tuning?.max ?? dcw.max
    const step = binding.tuning?.step
    const lines = [
      `- 数控执行 ${dcw.name}(${dcw.id})【${binding.mode === 'manual' ? '手动审批' : '自动限界'}】`,
      `  物理意义:${dcw.semantics || tpl?.semantics?.slice(0, 160) || tpl?.ch || dcw.templateKey}`,
      `  单位 ${dcw.unit} | 安全量程 ${dcw.min}~${dcw.max}${dcw.unit}`,
      `  调试范围 ${min}~${max}${dcw.unit} | 每步跨度 ${step ?? '(未定义,按量程 1/20)'}${dcw.unit}`,
      `  当前设定 ${dcw.value ?? '-'}${dcw.unit}${binding.tuning?.note ? `\n  调试备注:${binding.tuning.note}` : ''}`,
    ]
    return lines.join('\n')
  }
  return `- 节点 ${binding.nodeId}(${binding.kind})已失效(节点不存在,绑定将自动清理)`
}

function goalBlockOf(profile: HybridChannelProfile): string {
  const goal = profile.objective as { objectiveId?: string, targets?: Record<string, number>, weights?: Record<string, number> } | undefined
  if (!goal || Object.keys(goal).length === 0) return '- goal:(未设置 —— 请让用户在 Channel 设置中定义优化目标后再开始探索)'
  const targets = goal.targets ?? {}
  const weights = goal.weights ?? {}
  return `- goal ${goal.objectiveId ?? ''}: ${Object.entries(targets).map(([k, v]) => `${k}→${v}(权重 ${weights[k] ?? 1})`).join('; ')}`
}

function lineageBlockOf(profile: HybridChannelProfile): string {
  const lines: string[] = []
  if (profile.sceneId) lines.push(`- 场景:${profile.sceneId}@${profile.sceneVersion ?? '(draft)'}${profile.controlPolicy ? ` | 治理档位 ${profile.controlPolicy}` : ''}`)
  const scene = profile.sceneContract as { lineId?: string, productId?: string, recipeId?: string } | undefined
  if (scene?.lineId) {
    const lineName = getDcwLineRepo().byId(scene.lineId)?.name ?? scene.lineId
    lines.push(`- 产线:${lineName}(${scene.lineId})`)
  }
  if (scene?.recipeId) {
    const recipe = getDcwRecipeRepo().byId(scene.recipeId)
    lines.push(`- 配方:${recipe?.name ?? scene.recipeId}(${scene.recipeId})`)
  }
  if (profile.boundModelId) lines.push(`- 绑定模型:${profile.boundModelId}(经门禁校验后投用)`)
  return lines.join('\n')
}

/** 工艺优化 Channel 提示词(模式感知) */
export function buildOptimizationSystemPrompt(channelId: string, agentId: string, scenarioPrompt?: string): string | null {
  const profile = getChannelTwinProfile(channelId)
  if (profile.profile !== 'aml_optimization') return null
  const isAml = profile.optimizationMode === 'aml' && !!profile.boundModelId
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  if (bindings.length === 0) return null
  const nodeBlocks = bindings.map(nodeBlockOf).join('\n')
  const section = [
    isAml ? AML_RULES : EXPLORATION_RULES,
    `\n## 目标与谱系`,
    goalBlockOf(profile),
    lineageBlockOf(profile),
    `\n## 你绑定节点的工况(每块含物理意义/量程/调试范围/每步跨度;你的每次操作都在这些边界内)`,
    nodeBlocks,
    scenarioPrompt?.trim() ? `\n## 产线特定知识(用户下发,优先级最高)\n${scenarioPrompt.trim()}` : '',
  ].filter(Boolean).join('\n')
  return section
}

/** 训练 Channel 提示词 */
export function buildTrainingSystemPrompt(channelId: string, agentId: string, scenarioPrompt?: string): string | null {
  const profile = getChannelTwinProfile(channelId)
  if (profile.profile !== 'aml_training') return null
  const bindings = getAgentNodeBindingRepo().byAgent(agentId)
  const nodeBlocks = bindings.length > 0 ? bindings.map(nodeBlockOf).join('\n') : '(尚未绑定数采节点 —— 数据集构建要求所用节点均有 daq 绑定)'
  return [
    TRAINING_RULES,
    `\n## 谱系与可用节点`,
    lineageBlockOf(profile) || '- (未绑定场景;可对任意授权产线建模)',
    nodeBlocks,
    scenarioPrompt?.trim() ? `\n## 产线特定知识(用户下发,优先级最高)\n${scenarioPrompt.trim()}` : '',
  ].filter(Boolean).join('\n')
}

/** 统一入口:按 Channel profile 返回应注入的 systemPromptPrefix(非工业 Channel 返回 null) */
export function composeChannelSystemPrompt(channelId: string, agentId: string, scenarioPrompt?: string): string | null {
  const profile = getChannelTwinProfile(channelId)
  if (profile.profile === 'aml_optimization') return buildOptimizationSystemPrompt(channelId, agentId, scenarioPrompt)
  if (profile.profile === 'aml_training') return buildTrainingSystemPrompt(channelId, agentId, scenarioPrompt)
  return null
}
