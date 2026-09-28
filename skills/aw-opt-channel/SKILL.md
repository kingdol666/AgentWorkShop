---
name: aw-opt-channel
description: AgentWorkShop 场景优化闭环 Channel 创建 skill。当需要创建带 AML 孪生 profile 的优化频道、组建 lead/worker 剧组并绑定节点工具、跑 exploration 探索闭环、训练 AML 模型并经门禁绑定切到 aml 模式、直至 production 投用时使用。通过 aw 工业 MCP 服务执行,覆盖频道模板实例化到双模式闭环验收的标准化流程。
---

# AgentWorkShop 场景优化闭环 Channel 创建

从零建一个能跑闭环寻优的频道:频道(带 aml_optimization profile)→ 剧组(lead+worker)
→ 节点授权 → exploration 探索 → (可选)训练模型 → 门禁 → 绑定切 aml 模式 → production 投用。

## 前置条件

- **MCP 集成开关已启用**:平台 Web「系统设置 → MCP 集成 → 启动 MCP 集成」打开(或 env `AW_MCP_ENABLED=true`);未启用时除 `aw_status` 外全部工具被拒。
- AgentWorkShop 实例运行、aw MCP 已挂载、已鉴权(`aw_status` → `aw_login`,确认 `mcpEnabled=true`)。
- 产线与节点已就绪。没有就先走 `aw-node-bind` skill——闭环的前提是被控对象在平台上存在。
- 明确优化目标(PV 目标带/守卫约束)与控制策略(recommendation_only / hitl_governed / bounded_auto)。

## 工作流程

### 0. 连接检查

`aw_status` → `aw_login`。记录 base/port 与 `mcpEnabled=true`。

### 1. 创建优化频道(二选一)

**A. 模板路径(推荐,自带场景纪律与工具面)**

1. `aw_channel_template_list` 找内置模板 `chtpl-aml-optimization-default`(工艺优化通道)。
2. `aw_channel_template_instantiate { id, name, toolProfile: 'aml_optimization',
   controlPolicy: 'hitl_governed', optimizationMode: 'exploration', scene?, objective? }`
   → { channelId, leadAgentId }。模板自带 lead 时调度循环即启动,可直接提交任务。
   ⚠️ 模板自带 lead(+优化执行器成员)——**不要再对模板实例出的频道跑 `aw_team_provision`**,
   deploy 会 409「channel 已存在 lead」;worker 实例 id 用
   `aw_request { method:'GET', path:'/api/workshop/channels/<id>/agents' }` 取 `role==='worker'`。

**B. 手工路径(需要自定义剧组时;与 A 二选一)**

1. `aw_channel_create { name, scenarioPrompt }` → channelId。
2. `aw_team_provision { channelId, lead: {name, harness:'omp', config}, worker: {name, harness:'omp', config} }`
   → 返回 leadInstanceId / workerInstanceId(频道内实例 id)。

### 2. 节点授权

对产线每个 DCW/DAQ 节点:`aw_agent_tool_bind { agentId: <workerInstanceId>, nodeId, kind, mode: 'auto' }`。
节点清单从 `aw_dcw_snapshot` 取;agentId 必须是实例 id(模板 id 会被 400 拒)。

### 3. 探索门控验证(负向校验,必做)

exploration 模式且未绑模型时,孪生寻优工具必须 fail-closed:

`aw_agent_tool_invoke { agentId, tool: 'mpc_optimize', args: {...} }` 应被拒,返回
「当前为探索模式:Channel 尚未绑定 AML 模型…」(EXPLORATION_MODE_NO_MODEL 类)。
**报错才是对的**——这是双模式门控生效的证据。

### 4. 探索闭环(exploration)

- 下任务:`aw_task_create { channelId, title, parts:[{text: 任务书}], mode: 'goal',
  modeConfig: { goalCriteria: '<PV>连续两轮复测在带内,守卫全满足,dcw_judge 已提交' } }`。
- 任务书纪律:读数归因→机理决策→受治理写入(dcw_control,配方窗内)→等物理响应→复测→判定;
  禁止臆造数字;长等待是工艺要求。
- 旁观与核数:`aw_agent_tool_invoke { tool: 'daq_query' }` 看实测;
  `aw_request { method:'GET', path:'/api/workshop/dcw/optimizations?lineId=<id>' }` 看探索留痕。
- 收口:worker 提交 dcw_judge;必要时人工复核 `aw_optimization_judge { id, verdict, reason }`
  (rollback 走双人复核审批)。
- **保存最佳配方(每个优化目标一份,务必带目标描述)**:
  1. `aw_recipe_create { productId, name: '<目标>最佳配方', description: '<优化目标+关键设定点+收敛日期>',
     params: [<收敛后的各节点设定>] }` —— description 是配方的元字段,按目标写清
     (如「目标:膜厚 50±2μm;线速 99 m/min、模口 0.97mm、螺杆 150rpm;2026-09-27 探索收敛」)。
     已有配方则用 `aw_recipe_update { id, description, params }`(params 变更自动版本化)。
  2. `aw_recipe_mark_good { id, runId }` 把收敛批标记为已知良好批次(lastGoodRunId)。
  3. 换目标再优化时重复上述三步——不同目标应得到**不同 description 的不同配方**;
     用 `aw_recipe_list { productId }` 核对每条配方的 description 与 params 对得上目标。

### 5. 升级 AML 模式(可选,证据齐全才做)

1. 训练通道:`aw_channel_template_instantiate { id: 'chtpl-aml-training-default', ... }`
   (或 hybrid_twin 通道),按其流程做场景发现/编译/冻结与数据集构建。
2. 数据集:`aw_request { method:'POST', path:'/api/workshop/aml/datasets',
   body: { lineId, productId, recipeId, nodes:[{nodeId, role: 'control'|'target'|'feature'}] } }`。
3. 训练:`aw_request { method:'POST', path:'/api/workshop/aml/jobs',
   body: { datasetId, jobKind: 'hybrid_residual', physicsSpec? } }`,轮询
   `GET /api/workshop/aml/jobs/:id` 到完成。
4. 投用影子:`aw_model_promote { id, toStage: 'shadow' }`; trial 验证 +
   `aw_agent_tool_invoke { tool: 'twin_gate_evaluate' }` 过门禁(谱系一致/UQ/OOD/物理判据)。
5. 绑定切换:`aw_twin_profile_patch { channelId, boundModelId: '<模型id>' }` ——
   绑定即自动 exploration→aml;谱系不一致或缺门禁会 409(fail-closed,如实报告,勿绕过)。
   解绑(boundModelId=null)自动回落 exploration。
6. 生产投用:`aw_model_promote { id, toStage: 'production' }`(ONNX 深检)。
   controlPolicy 升 bounded_auto 属高危变更,必须用户明确授权后才做。

### 6. 验收

- `aw_twin_profile_get { channelId }`:mode 与 boundModelId 符合预期。
- 复测 PV 在目标带内(`daq_query` / `aw_daq_samples`,点序新→旧)。
- 每轮决策有留痕(optimization_explorations / dcw journal)。
- 任务 `aw_task_list` 到 COMPLETED 且 goalCriteria 满足。

## 治理红线

- 写入只经治理链(四层限界+HITL+优化留痕),绝不要求 worker 直写 PLC。
- 模型未过门禁不绑定;绑定失败 409 是保护,不是障碍。
- hitl_governed 下审批等待(最长 180s)是正常流程,勿催促或重试轰炸。
- bounded_auto 需要用户明确授权;默认 hitl_governed。

## 验收清单

- [ ] 频道 toolProfile=aml_optimization,初始 mode=exploration
- [ ] exploration 下孪生工具 fail-closed 验证通过
- [ ] worker 全节点绑定 dcw+daq
- [ ] 探索轮次有优化留痕与判定
- [ ] (若 AML)门禁通过后才绑定,profile 显示 mode=aml
- [ ] (若 production)ONNX 深检通过,复测在带内
