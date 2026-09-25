# AML 混合孪生 MPC 与 AgentTeam 集成实施计划

- **计划状态**：已根据用户确认的默认 Judge/Taste 定案；经独立审查补齐 P0/P1 约束后，作为实现主计划。真实 governed write 仍须 SafetyCase 通过后才能启用
- **日期**：2026-09-25（实施验收更新）
- **项目**：`D:\codes\ABO\AgentWorkShop`
- **范围**：只增强 AML、Hybrid Twin、MPC、AgentTeam Channel 集成和其必要的受治理 DCW 接口；不重写普通 AgentTeam、不修改无关工业场景、不替换现有 PLC 协议栈
- **首个 Golden Path**：注塑场景先验证完整安全闭环；BOPET/双轴拉伸和 CAE/FEM 作为第二阶段高物理复杂度场景
- **默认训练栈**：PyTorch + autograd + ONNX Runtime；不同时引入 TensorFlow
- **默认上线策略**：recommendation-only → HITL 小步验证 → Canary → bounded-auto
- **默认节流策略**：正常 governed action 在首次 `DISPATCHING` 时开始计时；节点级和产线级锁均 `>=60s`，再叠加 Channel/任务动作预算；ACK 丢失也锁住后续写入直到 reconcile 完成
- **默认模型纪律**：模型不可变；禁止 `candidate → production` 直跳；所有 Twin 模型必须经过 Shadow 与 Recommendation-only 证据

---

## 0. 目标和不可变边界

### 0.1 最终目标

把当前 AgentWorkShop 的 AML 数据建模能力升级为：

```text
一个通用 Hybrid Twin MPC Channel 模板
→ 用户实例化不同工艺场景
→ 传入场景提示词和 SceneContract
→ 绑定 DAQ/DCW 节点
→ AgentTeam 按角色读取数据、建立物理模型、校准参数、训练残差模型
→ 运行 TwinSnapshot 和 VirtualTrial
→ 以物理模型为主、数据模型为修正进行 MPC/Safe BO
→ Shadow 观察和模型门禁
→ RecommendationCertificate + 一次性 WriteGrant
→ DCW 受治理写入
→ ACK/Readback/Settling/DAQ 验证
→ 新数据触发下一版模型校准
```

### 0.2 不做的事情

本计划不做以下事情：

- 不推倒重写现有 AML 数据集、训练作业和模型注册基础设施；
- 不给所有 Channel 和所有 Agent 默认注入训练工具；
- 不让 LLM 直接决定 PLC 安全边界；
- 不让 Agent 直接绕过 Twin Gate 调用真实 DCW；
- 不让新模型原地覆盖 production 权重；
- 不把纯 AML 预测模型宣传为完整 MPC；
- 不把纯 PINN 作为所有场景的默认模型；
- 不要求所有场景都使用 FEM；
- 不把 FEM/CAE 放入实时 PLC 控制内循环；
- 既有 Channel 和未迁移的普通 Channel 默认使用 `legacy` profile 保持兼容；`hybrid_twin` Channel 强制使用 capability-scoped profile；普通 Channel 只有显式迁移到 `scoped` 才改变工具集合；
- 不在 Twin 功能尚未通过故障注入和安全验收前启用真实 bounded-auto。

### 0.3 兼容性原则

所有增强必须采用“新增、扩展、可回滚”的方式：

1. 现有 AML 数据模型保留，新增字段允许为空；
2. 新 Twin 功能通过 `toolProfile=hybrid_twin` 和拆分后的 Feature Flags 开启；
3. 普通 AML 预测模型仍可沿用当前 `candidate/shadow/production` 流程，但 Twin-controlled 模型使用更严格生命周期；
4. 新 API 不修改旧 API 的必填参数；
5. 数据库迁移只做 additive migration，不删除旧字段；
6. 训练环境新增依赖必须锁定版本，并支持回退到现有 AML 基础环境；
7. 每个阶段都必须有明确的回滚路径和旧行为回归测试。

---

## 1. 当前代码基线和已知缺口

### 1.1 可以直接复用的基础

| 基础能力 | 当前位置 | 复用方式 |
|---|---|---|
| AML 数据集 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\aml\dataset-builder.ts` | 扩展 Scene/Binding/物理变量，而不是重写取数主流程 |
| AML 作业 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\aml\job-orchestrator\` | 增加 hybrid/calibration 作业类型和工件契约 |
| AML Python 桥 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\aml\python\amlkit.py` | 增加 physics manifest、snapshot、hybrid artifact 接口 |
| 模型注册 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\aml\model-registry.ts` | 保留旧模型，新增 Twin lineage/capability/eligibility |
| Agent AML 工具 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\agents\industrial\aml-*.ts` | 保留旧工具，增加 Twin 工具并按 capability 注入 |
| Channel 模板 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\runtime\manager\channel-templates.ts` | 增加实例参数、Prompt 渲染、自动绑定和返回 Agent 映射 |
| Agent 工具目录 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\agents\host-tool-bridge\catalog.ts` | 引入 Channel `toolProfile/capabilityProfile` |
| 工具分发 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\agents\host-tool-bridge\dispatch.ts` | 注入后再次服务端鉴权，防止工具名直调绕过目录 |
| 节点绑定 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\agents\node-bindings.repo.ts` | 保留现有绑定，新增 BindingSnapshot 和 bindingEpoch |
| DCW 写入 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\dcw\dcw-controller\write.ts` | 作为 governed write 唯一拦截点 |
| Channel/Team 种子 | `D:\codes\ABO\AgentWorkShop\server\services\workshop\db\aml-team-seeds.ts`、`database\seed.ts` | 新增 Hybrid Twin 默认模板，保留旧 AML Team |

### 1.2 必须明确修复的现有集成断点

1. 当前没有默认 `Hybrid Twin MPC Channel Template`；
2. Channel 实例化目前主要只支持名称覆盖，不能传入 scene/objective/bindings/tool profile；
3. AML 工具目前属于基础 host tools，普通 Agent 可能看到 AML 训练工具；
4. Channel 实例化不会自动绑定 DAQ/DCW 节点；
5. `aml_job_submit` 通过 Agent 调用时没有完整传递 `channelId/taskId/sceneId/objectiveId`；
6. 当前绑定记录主要是 `agentId/nodeId/kind/mode`，没有场景、Channel、产线和版本快照；
7. 当前模型主要是历史窗口 → ONNX 下一步预测，不是物理主干 + 数据残差；
8. 当前没有 TwinSnapshot、VirtualTrial、ObjectiveProfile、WriteGrant；
9. 当前 G1-G5 主要是数据模型门禁，不是 Twin Gate；
10. 当前 Twin 模式不能允许 `candidate → production` 直跳；
11. 当前 DCW 节流和工艺 settling 尚未形成持久化的节点级 + 产线级策略；
12. 当前没有自动数据漂移触发的持续校准流程。

---

## 2. 总体架构决策（ADR）

### ADR-001：保留 AML，新增 Twin/Physics/Trial/MPC 层

**Decision**：不重写 AML；在其上增加以下子域：

```text
Scene Contract
Physics Runtime
Calibration
Hybrid Training
Uncertainty/OOD
Twin Snapshot
Virtual Trial
MPC/Safe BO
Twin Gate/WriteGrant
```

**Drivers**：复用已验证的数据集、训练作业、模型注册和 Agent 工具，降低回归风险。

**Alternatives rejected**：另建一套独立 Twin 平台。会造成数据、权限、审计和模型资产双份维护。

**Consequence**：必须定义清楚“旧 AML 模型”和“Twin Model”的能力边界，不能将旧 `mpc_surrogate` 直接等同于 MPC。

### ADR-002：默认使用 PyTorch，不同时引入 TensorFlow

**Decision**：第一阶段使用当前已有 PyTorch、autograd、ONNX Runtime。

**Drivers**：现有 `amlkit.export_torch_onnx`、`torch` 依赖、PINN/残差需要自动微分。

**Alternatives rejected**：第一阶段同时支持 TensorFlow。会增加环境、导出、评测和运维分叉。

**Consequence**：保留未来 `backend` 扩展字段，但第一版实现只接受 `pytorch`。

### ADR-003：物理主干 + 有界神经残差

**Decision**：默认模型为灰箱状态空间/ODE/工艺方程主干，神经网络只学习受限残差。

```text
x(k+1) = F_phys(x(k), u(k), d(k); θ) + B_r · Rφ(z(k))
y(k)   = H_phys(x(k); θ) + Rψ(z(k))
```

**Drivers**：比纯黑盒 AML 更能表达因果和边界；比纯 PINN 更容易校准和服务化。

**Alternatives rejected**：纯黑盒模型直接控制、所有场景纯 PINN、所有场景全 FEM。

**Consequence**：需要物理参数先验、残差幅值上限、物理门禁和数据门禁。

### ADR-004：一个 TwinModel + 多个 ObjectiveProfile

**Decision**：场景工艺动态和优化目标分离。

```text
TwinModel = 工艺/设备动态
ObjectiveProfile = 质量、能耗、产量等优化目标
```

**Drivers**：避免不同目标复制整套物理模型，支持同一场景多种优化任务。

**Consequence**：VirtualTrial 和 MPC 必须绑定 `objectiveId`，但模型版本不应仅因目标权重改变而复制。

### ADR-005：默认 recommendation-only，按 Channel 逐步授权

**Decision**：新 Hybrid Twin Channel 默认只生成建议；经过 Shadow、HITL 和 Canary 后才能进入 bounded-auto。

**Drivers**：降低真实 DCW 风险，保持 Agent 只能建议、确定性服务才能执行。

**Consequence**：`writeGrantEligible` 必须和 `recommendationEligible` 分开。

### ADR-006：节点级 + 产线级 + 任务级 DCW 节流

**Decision**：正常 governed action 在首次 `DISPATCHING` 时开始计时；同一节点和同一产线最小动作间隔均 >=60 秒；ACK 丢失或状态未知时继续锁定直到 reconcile 完成；settling 单独定义。

**Drivers**：防止不同节点交错写入绕过节流；防止把节流误认为工艺已经稳定。

**Consequence**：节流状态必须持久化，重启和多实例不能丢失。

---

## 3. 核心领域对象和版本契约

所有对象必须有 `schemaVersion`、`createdAt`、`createdBy`、`sourceHash/artifactHash`（适用时）、`status` 和兼容性策略。

所有对象必须有以下公共元数据；这些字段进入 payloadJson 和 hash/signature 的覆盖范围，并在迁移中直接落库或由完整 payloadJson 还原：

```yaml
schemaVersion: 1
createdAt:
createdBy:
sourceHash:
artifactHash:
status:
```

`schemaVersion`、`createdAt`、`createdBy` 缺一不可；schema 迁移必须保留旧版本读取器和明确的兼容策略。

### 3.1 `SceneContract`

表达一个可建模场景：

```yaml
schemaVersion: 1
createdAt:
createdBy:
sceneId:
sceneVersion:
lineId:
productId:
recipeId:
assets: []
phases: []
controls: []
states: []
disturbances: []
observations: []
guards: []
constraints: []
physicsProfileId:
objectiveProfileIds: []
writePolicy:
  minNodeIntervalSec: 60
  minLineActionIntervalSec: 60
  maxActionsPerRun: 3
  maxDeltaPerAction: {}
```

每个变量必须包含：

```text
id
nodeId（有现场节点时）
role
physicalMeaning
unit
range
samplingPeriod
phaseScope
```

角色至少支持：

```text
control
state
feature
disturbance
observation
target
guard
```

### 3.2 `NodeBindingSnapshot`

不能只依赖当前 JSON 绑定状态。每个数据集、模型和试验都要保存当时的绑定快照：

```yaml
schemaVersion: 1
createdAt:
createdBy:
snapshotId:
channelId:
bindingEpoch:
sceneId:
sceneVersion:
bindings:
  - agentId:
    agentRole:
    nodeId:
    kind: daq|dcw
    mode: auto|manual
    controlPolicy: recommendation_only|hitl_governed|bounded_auto
    lineId:
    physicalMeaning:
    unit:
    min:
    max:
    samplePeriodMs:
snapshotHash:
```

### 3.3 `PhysicsModelManifest`

```yaml
schemaVersion: 1
createdAt:
createdBy:
physicsModelId:
version:
sceneId:
backend: pytorch
stateVariables: []
controlVariables: []
disturbanceVariables: []
equations: []
parameters: []
parameterPriors: []
initialConditions: []
boundaryConditions: []
constraints: []
solver:
sourceHash:
artifactHash:
```

物理模型必须可执行、可测试、可解释；Agent 生成的候选物理代码必须先通过静态检查、单位检查、数值稳定性和回归测试。

### 3.4 `TwinSnapshot`

```yaml
schemaVersion: 1
createdAt:
createdBy:
snapshotId:
sceneId:
sceneVersion:
lineId:
productId:
recipeId:
phase:
capturedAt:
daqWatermark:
sourceSequence:
controlValues: {}
stateEstimate: {}
disturbances: {}
dataQuality: {}
estimatorVersion:
bindingSnapshotHash:
physicsModelVersion:
residualModelVersion:
snapshotHash:
```

过期、重复、乱序、阶段不明确或质量不足的 Snapshot 不得生成 WriteGrant。

### 3.5 `HybridModelManifest`

```yaml
schemaVersion: 1
createdAt:
createdBy:
modelId:
modelVersion:
sceneId:
sceneVersion:
physicsModelId:
physicsModelVersion:
residualModelId:
datasetId:
calibrationId:
objectiveCompatibility: []
modelCapabilities:
  simulate: false
  calibrate: false
  optimize: false
  # 只能由对应工件存在且门禁通过后服务端推导为 true
runtimeEligibility:
  evaluated: false
  recommendationEligible: false
  writeGrantEligible: false
```

### 3.6 `ObjectiveProfile`

```yaml
schemaVersion: 1
createdAt:
createdBy:
objectiveId:
twinModelId:
targets: []
weights: {}
controlCosts: {}
constraints: []
horizonSteps:
trustRegion:
```

### 3.7 `VirtualTrial` / `TrialResult`

必须区分：

```yaml
candidateExecuted: false
```

字段至少包括：

```text
schemaVersion: 1
createdAt
createdBy
trialId
snapshotId
modelId
objectiveId
candidateControlTrajectory
predictedTrajectory
uncertainty
outOfDistribution
constraintResults
baselineComparison
candidateExecuted
provenance
```

### 3.8 `SafetyCase`

`SafetyCase` 是进入 `WRITE_ELIGIBLE`、Canary 或 `bounded_auto` 的独立前置交付物，不由 Agent 自己声明通过。

```yaml
schemaVersion: 1
createdAt:
createdBy:
safetyCaseId:
sceneId:
sceneVersion:
lineId:
hazopOrFmeaReport:
safeStates: []
plcHardLimits: []
sisIndependence:
manualStopProcedure:
manualTakeoverSlaSec:
credentialIsolation:
networkIsolation:
faultInjectionReport:
approvedBy:
secondApprover:
approvedAt:
expiresAt:
status: DRAFT|REVIEW|APPROVED|EXPIRED|REVOKED
```

没有 `status=APPROVED` 的 SafetyCase：

```text
不得 WRITE_ELIGIBLE
不得 Canary
不得 bounded_auto
```

### 3.9 `AcceptanceProfile`

每个场景使用版本化、可计算的 AcceptanceProfile；Prompt 只能说明规则，不能修改阈值。

```yaml
profileId:
version:
model:
physics:
uncertainty:
ood:
trial:
shadow:
safety:
writePolicy:
```

---

### 3.10 `RecommendationCertificate`

`RecommendationCertificate` 是确定性服务在 Twin Gate 通过后生成的不可变证书；它必须能够在重启后独立验证“这条建议对应哪个 Snapshot、模型、配方、目标和控制轨迹”。

```yaml
schemaVersion: 1
createdAt:
createdBy:
recommendationId:
trialId:
snapshotId:
snapshotHash:
sceneId:
sceneVersion:
sceneContractHash:
lineId:
recipeVersion:
recipeHash:
objectiveId:
objectiveHash:
modelVersion:
modelHash:
candidateControlTrajectory:
baselineComparison:
constraintDigest:
uncertainty:
outOfDistribution:
candidateExecuted: false
status: ISSUED|EXPIRED|REVOKED
issuedAt:
expiresAt:
certificateHash:
signingKeyId:
signatureAlgorithm: HMAC-SHA256
signature:
```

`RecommendationCertificate` 的 `candidateExecuted` 必须为 `false` 才能由本平台生成 recommendation-only 建议；真实执行结果由 `control_actions` 单独记录，不能回写覆盖证书。

### 3.11 `WriteGrant`

`RecommendationCertificate` 是确定性服务确认候选可以被建议；`WriteGrant` 是确定性服务在审批和策略门通过后签发的一次性真实写入凭证。两者不能合并。Agent 只能提交 `TwinWriteGrantRequest`，不能签发、修改或伪造 Grant。

以下是唯一 canonical `WriteGrant` schema；SQL、API、工件和测试都必须以此为准。一个 Action 使用一个覆盖多个节点的 group Grant：

```yaml
schemaVersion: 1
createdAt:
createdBy:
grantId:
actionId:
grantRole: PRIMARY|ROLLBACK
parentGrantId:
recommendationId:
trialId:
agentId:
channelId:
taskId:
teamId:
lineId:
nodeIds: []
bindingEpoch:
sceneId:
sceneVersion:
sceneContractHash:
recipeVersion:
recipeHash:
objectiveId:
objectiveHash:
snapshotHash:
modelVersion:
modelHash:
approvedControlVector:
knownGoodControlVector:
rollbackControlVector:
currentValueHash:
maxDelta:
constraintsDigest:
policyVersion:
minNodeIntervalSec: 60
grantStatus: ISSUED|CLAIMED|CONSUMED|REVOKED|EXPIRED
nonce:
commandId:
signingKeyId:
signatureAlgorithm: HMAC-SHA256
signature:
grantPayloadHash:
payloadJson:
approvalId:
issuedAt:
expiresAt:
claimedAt:
consumedAt:
```

约束：

```text
UNIQUE(nonce)
UNIQUE(commandId)
Grant 只能由服务端确定性签发；
签名覆盖 canonical payloadJson 的 SHA-256；数据库 `payload_hash` 即 canonical `grantPayloadHash`；重启时先校验 schemaVersion、payload_hash 和 signature，再重建 Grant 状态；
CONSUMED 表示该 Grant 已不可再次发送，状态不确定时只能用同一 commandId reconcile；
PRODUCTION 不自动等于 writeGrantEligible。
```

---

## 4. AgentTeam/Channel 集成设计

### 4.1 新增唯一默认模板

在 `server/services/workshop/db/database/seed.ts` 新增：

```text
chtpl-hybrid-twin-mpc-default
```

模板提供：

```text
通用场景提示词模板
角色组合
toolProfile=hybrid_twin
能力矩阵
模型生命周期策略
默认写入策略
```

保留现有 `team-aml-shadow`，但不强制所有 Channel 使用它。

### 4.2 实例化参数

扩展：

```text
server/api/workshop/channel-templates/[id]/instantiate.post.ts
server/services/workshop/runtime/manager/channel-templates.ts
```

增加：

```text
scene
promptVariables
objectiveId
toolProfile
capabilityProfile
bindings
```

实例化服务必须：

1. 校验所有必填变量；
2. 校验 scene/line/product/recipe 一致性；
3. 创建 Channel 和 Agent 实例；
4. 返回模板成员到实例成员的映射；
5. 渲染并固化场景 Prompt；
6. 创建 NodeBindingSnapshot；
7. 批量绑定节点；
8. 记录 `channel_scene` 关系；
9. 默认不授予真实 governed write。

失败时必须事务性回滚：

```text
Channel、Agent、绑定、场景元数据不能出现半创建状态。
```

### 4.3 CapabilityProfile

最小角色矩阵：

| 角色 | 允许能力 |
|---|---|
| `twin_lead` | 调度、查看证据、申请晋级，不直接写 DCW |
| `scene_worker` | 节点语义、SceneContract |
| `data_worker` | DAQ、数据集和质量分析 |
| `physics_worker` | 物理模型候选和验证 |
| `training_worker` | 训练作业、日志和工件 |
| `calibration_worker` | 参数校准和残差数据集 |
| `evaluator` | 数据门、物理门、UQ/OOD、回归 |
| `mpc_worker` | VirtualTrial、MPC 候选和证书草案 |
| `runtime_worker` | ACK、readback、settling、有效 Grant 消费 |
| `safety_worker` | Twin Gate、Grant、回滚和审计 |

工具必须同时在 catalog 和 dispatch 层校验。

### 4.4 AML 作业上下文

扩展 `toolAmlJobSubmit` 和 `submitJob`，至少透传：

```text
agentId
channelId
taskId
sceneId
sceneVersion
objectiveId
physicsModelId
physicsModelVersion
twinSnapshotId
```

---

## 5. Hybrid AML 训练协议

### 5.1 作业类型

现有 `purpose` 保留，同时新增内部 job kind：

```text
supervised
physics_calibration
hybrid_residual
uncertainty_calibration
```

旧 `mpc_surrogate` 继续兼容，不能自动赋予 Twin 写入资格。

### 5.2 `amlkit` 扩展

在：

```text
D:\codes\ABO\AgentWorkShop\server\services\workshop\aml\python\amlkit.py
```

增加：

```python
load_physics_manifest(job_or_path)
load_twin_snapshot(job_or_path)
load_objective_profile(job_or_path)
report_physics_metrics(metrics)
report_uncertainty(metrics)
export_hybrid_model(physics_model, residual_model, manifest)
```

训练工件至少包含：

```text
physics_manifest.json
physics_parameters.json
model.pt
model.onnx
normalization.json
metrics.json
physics_gates.json
uncertainty.json
provenance.json
```

`model.pt` 用于：

- 继续训练；
- 可微分 rollout；
- VirtualTrial；
- MPC 优化。

`model.onnx` 用于：

- Node/服务端快速推理；
- Shadow 预测；
- 非梯度运行时。

### 5.3 训练顺序

必须按顺序执行：

```text
A. 物理参数校准
B. 冻结物理主干，训练有界残差
C. 受约束联合微调
D. Deep Ensemble/Conformal 不确定度校准
```

禁止一开始让全部物理参数和神经网络自由漂移。

### 5.4 默认损失

```text
L_total =
  λ_data · L_data
+ λ_phys · L_phys
+ λ_boundary · L_boundary
+ λ_initial · L_initial
+ λ_rollout · L_rollout
+ λ_prior · L_parameter_prior
+ λ_reg · L_residual_regularization
```

---

## 6. 模型治理和 Twin Gate

### 6.1 模型状态

普通 AML 模型保留旧流程；`modelKind=hybrid_twin` 使用：

```text
DRAFT
→ EVALUATED
→ SHADOW
→ RECOMMENDATION_ONLY
→ WRITE_ELIGIBLE
→ PRODUCTION
→ REVOKED/EXPIRED/RETIRED
```

Twin 模型禁止：

```text
candidate → production
```

### 6.2 Twin Gate 组别

#### G0 身份和谱系门

必须存在并一致：

```text
sceneId/sceneVersion
lineId/productId/recipeId
objectiveId
datasetId
physicsModelVersion
residualModelVersion
channelId/taskId
bindingSnapshotHash
source/artifact/environment digest
```

#### G1 数据质量门

沿用现有 AML 门，同时检查：

```text
时间水位
序列连续性
单位
量程
阶段
配方隔离
真实/模拟来源标记
```

#### G2 物理有效性门

检查：

```text
方程残差
守恒误差
边界条件
初始条件
参数先验范围
数值稳定性
残差幅值上限
物理求解失败率
```

#### G3 数据模型门

保留：

```text
G1 单步 NRMSE <= 0.10（默认，可按场景覆盖）
G2 滚动 NRMSE <= 0.25（默认，可按场景覆盖）
G3 泛化差 <= 20%
G4 rows >= 500 且 runs >= 3
G5 工件完整并可推理
```

必须按 run/time/phase 进行留出验证，不允许只做随机窗口切分。

#### G4 UQ/OOD 门

必须输出预测区间、模型分歧和 OOD 分数。默认要求：

```text
校准集覆盖率达到 AcceptanceProfile 规定值
明显 OOD fixture 的拒绝率 100%
OOD 或不确定度超限时降级为 recommendation-only
```

#### G5 VirtualTrial 门

检查整条候选轨迹，而不是只检查终点：

```text
控制上下限
控制变化率
输出守卫量
物理约束
不确定度
OOD
基线收益
candidateExecuted=false
```

#### G6 Shadow/投产门

默认初始要求：

```text
至少 10 个独立生产样本或批次
覆盖至少 3 个代表性工况
连续 Shadow 无硬约束违规
预测覆盖率达到目标
无重大 OOD 漏报
无错误回读和跨线错绑
```

具体阈值必须落在 `AcceptanceProfile`，不能写死在 Agent 提示词中。

### 6.3 `runtimeEligibility` 与 `modelCapabilities` 分离

必须继续保持：

```yaml
modelCapabilities:
  simulate: false
  calibrate: false
  optimize: false
  # 由工件存在和对应门禁通过后，服务端推导为 true
runtimeEligibility:
  evaluated: true
  recommendationEligible: true
  writeGrantEligible: false
```

“模型能预测”不等于“模型允许写入”。

---

## 7. VirtualTrial、MPC 和受治理写入

### 7.1 新增 Twin 工具

只向 `hybrid_twin` Channel 和对应角色注入：

```text
twin_scene_read
twin_snapshot_create
twin_physics_validate
twin_trial_run
twin_trial_compare
twin_ood_check
twin_uncertainty_report
mpc_optimize
recommendation_create
twin_write_grant_request（仅提交请求；Grant 只能由确定性服务签发）
```

训练工具仍只给 `training_worker/calibration_worker`。

### 7.2 `twin_trial_run`

流程：

1. 读取并冻结 TwinSnapshot；
2. 校验模型、配方、场景、绑定快照一致；
3. 在隔离副本运行物理模型；
4. 运行残差模型；
5. 计算预测轨迹、不确定度和 OOD；
6. 检查所有硬约束；
7. 保存 TrialResult；
8. 明确 `candidateExecuted=false`；
9. 不接触 PLC/DCW 写入口。

### 7.3 MPC 分层

第一版：

```text
LTV-MPC/小规模约束优化
```

后续：

```text
灰箱 NMPC
Robust/Tubed MPC
Chance-constrained MPC
```

Safe BO 作为慢周期工作点搜索，不替代每次 MPC 动作。

### 7.4 WriteGrant

`RecommendationCertificate` 通过 Twin Gate 后，由服务端生成一次性 WriteGrant。

本计划选择“一个 Action 对应一个覆盖多个节点的 group Grant”模型：`nodeIds` 和 `approvedControlVector` 使用 JSON 映射，`control_action_nodes` 记录每个节点的 ACK/readback。部分成功时不创建子 Action；原 Action 保持 `ROLLBACK_REQUESTED/ROLLBACK_DISPATCHING`，并签发 `grant_role=ROLLBACK`、`parent_grant_id` 指向原 Grant、携带 `knownGoodControlVector/rollbackControlVector` 的新 Grant，写入原 Action 的 `rollback_grant_id`。回滚只补偿已经成功应用的节点，使用同一 Action 的产线锁、幂等 commandId 和完整审计链。

DCW Gateway 必须拒绝：

```text
无 Grant
Grant 过期
Grant 重放
节点/产线/场景/配方不一致
Snapshot 过期
模型版本不一致
控制值超过批准向量或 maxDelta
bindingEpoch 变化
DAQ 不新鲜
模型已经 revoked/retired
```

### 7.5 动作状态机

本节只给出控制链路摘要；唯一可执行的 Action/Grant 状态转移、reconcile 路径、终态和重启恢复规则以 §9.3.5 为准，不得另行实现第二套状态机。

```text
PROPOSED
→ TRIAL_PASSED
→ APPROVAL_PENDING
→ APPROVED
→ GRANT_ISSUED
→ CLAIMED
→ DISPATCHING
→ TRANSPORT_ACKED
→ DEVICE_ACKED
→ READBACK_VERIFIED
→ OBSERVING
→ SETTLED
→ KEPT
```

异常/恢复路径：

```text
RECONCILIATION_REQUIRED
→ READBACK_VERIFIED / ROLLBACK_REQUESTED / ABORTED / UNKNOWN_FINAL
ROLLBACK_REQUESTED
→ ROLLBACK_DISPATCHING
→ ROLLBACK_VERIFIED（终态）
ROLLBACK_DISPATCHING 超时 → SAFE_STOP（终态）
```

ACK 丢失、回读不一致、DAQ 陈旧、部分写入、settling 超时都不能进入 `KEPT`；`UNCERTAIN` 和 `RECONCILIATION_REQUIRED` 阶段禁止生成下一动作。


---

## 8. 持续校准和自动迭代

### 8.1 触发条件

以下任一事件可生成候选更新任务：

```text
新增完整 run 达到阈值
预测误差持续超阈值
数据分布漂移
OOD 比例升高
物理残差结构性升高
配方版本改变
设备维修/传感器更换
人工触发重校准
```

### 8.2 更新策略

```text
小偏差 → 只校准 θ
中等偏差 → 更新 residual model
大偏差 → 新建 Scene/Twin version
```

### 8.3 自动迭代边界

允许：

```text
自动生成 DatasetSnapshot
自动提交校准/训练候选
自动评测和进入 Shadow
自动生成晋级建议
```

禁止：

```text
自动覆盖 production
自动绕过 Shadow
自动绕过 Twin Gate
自动在 OOD 状态下写入
```

---

## 9. 文件和数据库落盘设计

### 9.1 本地目录

```text
aml/
  scenes/<sceneId>/<sceneVersion>/
  datasets/<datasetId>/
  jobs/<jobId>/
  models/<modelId>/
  physics-models/<physicsModelId>/<version>/
  twins/<twinId>/<version>/
  calibrations/<calibrationId>/
  trials/<trialId>/
```

每个 Twin 版本至少保存：

```text
scene-contract.json
binding-snapshot.json
physics-manifest.json
physics/physics.py
physics/parameters.json
residual/model.pt
residual/model.onnx
normalization.json
uncertainty.json
ood.json
metrics.json
gates.json
provenance.json
lineage.json
REGISTERED
```

### 9.2 SQLite 表

保留现有：

```text
aml_datasets
aml_jobs
aml_experiments
aml_models
```

新增或扩展：

```text
scene_versions
node_binding_snapshots
physics_models
calibration_runs
twin_models
twin_snapshots
objective_profiles
virtual_trials
recommendation_certificates
write_grants
drift_events
```

必须有迁移版本和索引；生产模型/试验/Grant 不允许物理删除，采用 retired/revoked/expired 标记和引用保护。

---

## 9.3 安全与持久化实现合同（P0，覆盖实现细节）

### 9.3.1 Feature Flags 分离

不得用一个开关同时打开训练和真实写入。至少拆分：

```text
AML_TWIN_CHANNEL_ENABLED
AML_TWIN_TRAINING_ENABLED
AML_TWIN_TRIAL_ENABLED
AML_TWIN_MPC_ENABLED
AML_TWIN_GOVERNED_WRITE_ENABLED
AML_TWIN_BOUNDED_AUTO_ENABLED
AML_TOOL_SCOPING_MODE=legacy|scoped
```

默认值：

```text
AML_TWIN_CHANNEL_ENABLED=false
AML_TWIN_TRAINING_ENABLED=false
AML_TWIN_TRIAL_ENABLED=false
AML_TWIN_MPC_ENABLED=false
AML_TWIN_GOVERNED_WRITE_ENABLED=false
AML_TWIN_BOUNDED_AUTO_ENABLED=false
AML_TOOL_SCOPING_MODE=legacy
```

既有 Channel 继续使用 `legacy` profile；新建或显式迁移的 Hybrid Twin Channel 使用 `scoped` profile。工具目录和 dispatch 都必须检查 profile。

### 9.3.2 Channel 实例化使用 Saga，而不是跨存储伪事务

当前 Channel/Agent 在 SQLite、节点绑定在 JSON、工件在文件系统，不能声称一个 SQLite transaction 覆盖全部副作用。采用可恢复 Saga：

```text
PRECHECK
→ DB_PREPARED
→ CHANNEL_CREATED
→ AGENTS_CREATED
→ BINDINGS_APPLYING
→ SNAPSHOT_COMMITTED
→ RUNTIME_ENABLED
→ COMMITTED
```

失败路径：

```text
COMPENSATING
→ 删除/标记未完成 Channel
→ 回滚 JSON 绑定
→ 删除未注册工件
→ 停止 Scheduler
→ FAILED
```

每次请求带 `requestId/provisioningId`；只有 `COMMITTED` 后才注入 Hybrid 工具和启动 Lead。服务重启时扫描 `PREPARED/APPLYING/COMPENSATING` 并继续补偿或恢复。

### 9.3.3 Legacy binding 与 governed control path 分离

不修改现有枚举：

```text
AgentNodeBindingMode = auto|manual
```

`governed_twin` 不是新的 legacy binding mode，而是 Channel/Model 的控制路径：

```text
controlPolicy = recommendation_only|hitl_governed|bounded_auto
```

### 9.3.4 WriteGrant 签发、签名、领取和重验

Agent 只能提交 `TwinWriteGrantRequest`；确定性服务必须重新验证 RecommendationCertificate、SafetyCase、Channel policy、模型状态、Snapshot freshness 和当前节点状态后，才签发 canonical Grant。Grant 使用服务端 HMAC-SHA256（`signingKeyId` 对应的密钥不进入 Agent、训练进程或 CAE sidecar）。

领取使用唯一索引和条件更新，SQL 不得引用 schema 中不存在的字段：

```sql
UPDATE write_grants
SET grant_status='CLAIMED', claimed_at=?
WHERE grant_id=?
  AND grant_status='ISSUED'
  AND expires_at>?;
```

受影响行数不是 1 时拒绝。`nonce` 和 `command_id` 的唯一索引负责防重放。首次发送前，在同一 SQLite 事务内将 Grant 置为 `CONSUMED`，并将 Action 置为 `DISPATCHING`；如果随后进程崩溃，恢复逻辑必须用同一 `commandId` reconcile，禁止签发或发送第二个 Grant。

DCW Gateway 在首次发送前和任何 reconcile 前重新校验：

```text
bindingEpoch
sceneContractHash
recipeHash
model state/hash
line phase
DAQ watermark/freshness
node enabled
current value
approved vector/maxDelta
node/line throttle
```

### 9.3.5 Action/Grant 联合状态机和重启恢复

`control_actions.state` 是唯一的动作状态来源；Grant 状态是其写入凭证子状态。两者映射必须遵守下表：

| Action 状态 | Grant 状态 | 事件/条件 | 下一步 |
|---|---|---|---|
| `APPROVED` | 不存在 | 证书和 SafetyCase 复核通过 | 签发 Grant |
| `GRANT_ISSUED` | `ISSUED` | Action 等待领取 | `CLAIMED` 或 `ABORTED` |
| `CLAIMED` | `CLAIMED` | 条件更新成功 | `DISPATCHING` |
| `DISPATCHING` | `CONSUMED` | 传输层确认成功 | `TRANSPORT_ACKED` |
| `DISPATCHING` | `CONSUMED` | 超时/网络中断/结果不明 | `RECONCILIATION_REQUIRED` |
| `TRANSPORT_ACKED` | `CONSUMED` | 设备 ACK 成功 | `DEVICE_ACKED` |
| `TRANSPORT_ACKED` | `CONSUMED` | 设备 ACK 超时/失败 | `RECONCILIATION_REQUIRED` |
| `DEVICE_ACKED` | `CONSUMED` | 回读一致 | `READBACK_VERIFIED` |
| `DEVICE_ACKED` | `CONSUMED` | 回读超时/不一致 | `RECONCILIATION_REQUIRED` |
| `READBACK_VERIFIED` | `CONSUMED` | 回读确认后开始工艺观察 | `OBSERVING` |
| `OBSERVING` | `CONSUMED` | 观察窗口满足 settling 条件 | `SETTLED` |
| `OBSERVING` | `CONSUMED` | settling 超时/DAQ 不新鲜 | `RECONCILIATION_REQUIRED` |
| `SETTLED` | `CONSUMED` | 质量结果满足目标 | `KEPT` |
| `RECONCILIATION_REQUIRED` | `CONSUMED` | 同一 commandId 查询到已应用且回读一致 | `READBACK_VERIFIED` 或 `ROLLBACK_REQUESTED` |
| `RECONCILIATION_REQUIRED` | `CONSUMED` | 查询到未应用且设备安全 | `ABORTED` |
| `RECONCILIATION_REQUIRED` | `CONSUMED` | 无法确认、部分应用或回读冲突 | `ROLLBACK_REQUESTED` 或 `SAFE_STOP` |
| `RECONCILIATION_REQUIRED` | `CONSUMED` | reconcile deadline 超时 | `UNKNOWN_FINAL`（终态） |
| `ROLLBACK_REQUESTED` | `ISSUED` | rollback Grant 已签发，且 `rollback_grant_id/parent_grant_id/action_id/line_id/nodeIds/vector` 一致 | `ROLLBACK_REQUESTED`（等待领取） |
| `ROLLBACK_REQUESTED` | `CLAIMED` | expectedState + stateVersion 条件领取成功 | `ROLLBACK_DISPATCHING` |
| `ROLLBACK_REQUESTED` | `EXPIRED/REVOKED` | rollback Grant 过期/撤销 | `SAFE_STOP`（终态） |
| `ROLLBACK_DISPATCHING` | `CONSUMED` | 已成功补偿节点的回读一致 | `ROLLBACK_VERIFIED`（终态） |
| `ROLLBACK_DISPATCHING` | `CONSUMED` | 回滚超时/回读不一致 | `SAFE_STOP`（终态） |
| 任意 in-flight | 任意 | 绑定/模型/配方变化或 Grant 撤销 | `UNCERTAIN`→`RECONCILIATION_REQUIRED` |

终态集合严格为：

```text
KEPT
ABORTED
ROLLBACK_VERIFIED
SAFE_STOP
UNKNOWN_FINAL（reconcile 超时，必须人工接管）
```

`UNCERTAIN`、`RECONCILIATION_REQUIRED` 不是终态；它们禁止新动作，直到成功 reconcile、回滚或进入 `UNKNOWN_FINAL`/`SAFE_STOP`；实现时不得出现其他拼写变体。每个 Action 必须恰好一个终态；服务重启后扫描所有非终态 Action，恢复为 `RECONCILIATION_REQUIRED`，不得自动重发。`UNKNOWN_FINAL` 和 `SAFE_STOP` 一旦进入，必须在同一个数据库事务中把 Action 写入终态并把对应产线的 `line_action_locks.lock_mode` 置为 `FROZEN`，`locked_until_ms` 失效；确定性 Gateway 永久拒绝新 governed action；

实现必须等价于以下原子序列：

```sql
BEGIN IMMEDIATE;
UPDATE control_actions SET state=?, state_version=state_version+1, terminal_at=?
WHERE action_id=? AND state=? AND state_version=?;
UPDATE line_action_locks SET lock_mode='FROZEN', locked_until_ms=NULL, freeze_reason=?, unlock_required=1, lease_version=lease_version+1, updated_at=? WHERE line_id=?;
INSERT INTO action_events(action_id,event_seq,from_state,to_state,event_type,at,payload_json) VALUES(?,?,?,?,?,?,?);
COMMIT;
```

任何一步失败都回滚整个事务；第一条 UPDATE 的受影响行数必须恰好为 1。所有状态迁移（包括 CLAIMED/CONSUMED、ACK、超时和 reconcile）都必须携带 expectedState + expectedStateVersion，并以同样的条件更新和事件序号原子提交；冻结锁只能由双人审批的 `line_unlock` 流程清除。只有完成现场接管、设备状态确认、遗留动作关闭、Safety/Operations 双人复核后，才能由专门的 unlock 流程清除该产线冻结锁，不能修改历史 Action 终态。

新增持久化实体：

```text
control_actions
control_action_nodes
action_events
action_reconciliations
```

一条产线最多一个 in-flight governed Action；Action 的状态迁移必须通过条件更新和事件序列号写入。

### 9.3.6 60 秒策略的 canonical 计时语义

正常 Agent/AML governed action 在首次 `DISPATCHING` 时开始节点级和产线级计时；ACK 丢失、结果不明或回读失败仍锁住后续自动写入，直到 reconcile 完成。`recipe`、普通 `rollback` 和 Agent 重试不得绕过该策略；紧急停止只能由 PLC/SIS/人工安全路径执行。该策略不等同于工艺 settling 时间。

```yaml
minNodeIntervalSec: 60
minLineActionIntervalSec: 60
oneInFlightActionPerLine: true
maxActionsPerRun: 3
uncertainBlocksNewWrites: true
countFrom: first_dispatching
```

节流状态必须落库，多实例使用条件更新/唯一约束竞争；重启后不能丢失。

### 9.3.7 训练/物理代码沙箱

Agent 生成的 `train.py/physics.py` 只能在训练作业沙箱执行：

```text
无 PLC/DCW 凭据
无现场网络路由
默认无外网
禁止 subprocess/shell
只能读 dataset/manifest
只能写 job workspace/artifacts
CPU/内存/磁盘/墙钟限制
可取消、可强杀
依赖来自锁定环境
工件必须 hash
```

CAE/FEM sidecar 还必须有输入白名单、网格/时间步/资源上限、进程强杀、无 PLC 凭据和无出站网络。若当前沙箱不能满足这些条件，只允许内置 PhysicsModelProvider 和受控训练模板，不允许任意 Agent 物理代码上线。

### 9.3.8 模型注册表强制规则

在 `model-registry.ts` 和仓储/API 三层执行：

```text
modelKind=legacy_aml：保持旧流程
modelKind=hybrid_twin：
  DRAFT → EVALUATED → SHADOW → RECOMMENDATION_ONLY
  → WRITE_ELIGIBLE → PRODUCTION
```

`hybrid_twin` 永远拒绝 `candidate → production` 直跳。`PRODUCTION` 也不自动等于 `writeGrantEligible=true`，仍需 SafetyCase、ChannelPolicy、TwinGate 和证书。

### 9.3.9 工件原子落盘和完整 provenance

write-eligible 所需 provenance 必须包含：

```yaml
sourceCommit:
sourceHash:
datasetHash:
sceneContractHash:
bindingSnapshotHash:
recipeHash:
objectiveHash:
acceptanceProfileHash:
environmentLockHash:
pythonVersion:
nodeVersion:
solverVersion:
seeds:
artifactDigests:
```

先写临时目录并 fsync，再原子 rename；元数据仅在所有必需工件和 digest 校验通过后登记。失败只保留 job 失败记录，不产生可引用的模型。

## 9.4 第一版 MPC、UQ/OOD 和持续校准的可执行合同

### 9.4.1 第一版 MPC

本次 AML 核心集成只实现注塑单目标质量跟踪的固定版本，求解器固定为 `scipy==1.14.1` 的 SLSQP；任何替换都必须新建 solver 版本并通过新的回归基线。MPC sidecar 使用独立 Python 进程，无 PLC 凭据、无现场网络路由、无出站网络。

请求 schema：

```yaml
snapshotId:
twinModelId:
objectiveId:
horizonSteps:
beatMs:
initialControl: {}
controlBounds: {}
rateBounds: {}
outputGuards: []
trustRegion: {}
solverTimeoutMs: 500
randomSeed: 42
```

接口：

```text
mpc_optimize(request) -> result
```

结果必须包含：

```yaml
status: OPTIMAL|FEASIBLE|NO_FEASIBLE_CANDIDATE|TIMEOUT|ERROR
candidateTrajectory: []
objectiveValue:
baselineValue:
constraintResults: []
solverStatus:
solverRuntimeMs:
fallbackUsed: false
candidateExecuted: false
rejectCode:
```

任何 NaN/Inf、solver timeout、sidecar crash、约束评估异常或无可行解都返回拒绝状态，不得生成 RecommendationCertificate；fallback 只能返回 recommendation-only 草案，不能签发 WriteGrant。

### 9.4.2 第一版 UQ/OOD

固定为：

```text
Deep Ensemble=3 个成员
校准集=独立 run，不参与训练
Coverage=按 target/phase 计算
OOD=标准化输入距离 + ensemble disagreement
标准化输入距离=shrinkage Mahalanobis；阈值=校准集 99.5% 分位且不超过 16.0
ensemble disagreement=归一化预测的 p95 std；阈值=0.15
calibration stale=超过 604800s；TwinSnapshot freshness window=60000ms
```

拒绝码固定为：

```text
UQ_COVERAGE_LOW
OOD_DISTANCE_HIGH
ENSEMBLE_DISAGREEMENT_HIGH
CALIBRATION_STALE
SNAPSHOT_STALE
```

`AcceptanceProfile` 必须记录 calibrationSetHash、calibrationMinRows、confidenceLevel、coverageTarget、coverageBy、falseSafeRateMax、fixtureSetId、fixtureMinCount、fixtureRejectCountRequired、oodDistanceMethod、oodDistanceThreshold、ensembleDisagreementThreshold、calibrationStaleAfterSec、snapshotFreshnessMaxMs 和 rejectCode。coverage 按 target/phase 分层；任一分层样本不足、candidate_count=0、分母为 0、NaN/Inf、solver failure、calibration 过期或 Snapshot 超过 freshness window 都直接拒绝；门禁只允许 `candidate_count>=minWriteEligibleCandidateCount` 且所有分层满足 `minCalibrationRowsByStratum` 时评估通过。

### 9.4.3 持续校准调度

使用现有 `scheduled_tasks`/事件体系，新增 `twin-calibration-worker`，而不是让 Agent 永久轮询。每个场景策略包含：

```yaml
minNewRuns:
minNewRows:
cooldownSec:
maxConcurrentRuns: 1
dedupKey:
shadowRequired: true
approvalRequired: true
```

同一 `sceneId+lineId+recipeId+policyVersion` 在冷却期间只允许一个运行；失败按 AML 作业重试规则处理；新候选失败时保留旧 production。

## 9.5 数据库迁移和对象矩阵

接入现有顺序迁移机制：

```text
server/services/workshop/db/database/open.ts
server/services/workshop/db/database/migrations.ts
```

每个 migration 必须记录：

```text
migrationId
order
preflight
backup/restore
foreign_key_check
backfill
forward-fix/rollback
```

新增/扩展对象至少包括：

```text
channel_scene
scene_versions
node_binding_snapshots
physics_models
calibration_runs
twin_models
twin_snapshots
objective_profiles
acceptance_profiles
virtual_trials
recommendation_certificates
safety_cases
write_grants
control_actions
control_action_nodes
action_events
action_reconciliations
line_action_locks
drift_events
twin_update_policies
twin_update_runs
```

旧 `aml_models` 回填规则：

```yaml
modelKind: legacy_aml
writeGrantEligible: false
sceneId: null
physicsModelId: null
residualModelId: null
```

绑定 JSON 与 SQLite 快照不做假原子事务，使用 9.3.2 的 Saga；Snapshot hash 是跨存储一致性的提交锚点。

关键安全表的最小 schema/约束合同如下（实际 SQLite DDL 必须在 migration 中逐项落地）：

```text
recommendation_certificates
  recommendation_id TEXT PRIMARY KEY
  schema_version INTEGER NOT NULL
  created_at TEXT NOT NULL
  created_by TEXT NOT NULL
  trial_id TEXT NOT NULL REFERENCES virtual_trials(trial_id)
  snapshot_id TEXT NOT NULL REFERENCES twin_snapshots(snapshot_id)
  snapshot_hash TEXT NOT NULL
  scene_id TEXT NOT NULL
  scene_version TEXT NOT NULL
  line_id TEXT NOT NULL
  scene_contract_hash TEXT NOT NULL
  recipe_version TEXT NOT NULL
  recipe_hash TEXT NOT NULL
  objective_id TEXT NOT NULL
  objective_hash TEXT NOT NULL
  model_version TEXT NOT NULL
  model_hash TEXT NOT NULL
  baseline_comparison_json TEXT NOT NULL
  candidate_control_trajectory_json TEXT NOT NULL
  constraint_digest TEXT NOT NULL
  uncertainty_json TEXT NOT NULL
  ood_json TEXT NOT NULL
  status TEXT NOT NULL CHECK (status IN ('ISSUED','EXPIRED','REVOKED'))
  candidate_executed INTEGER NOT NULL DEFAULT 0 CHECK (candidate_executed=0)
  certificate_hash TEXT NOT NULL UNIQUE
  signing_key_id TEXT NOT NULL
  signature_algorithm TEXT NOT NULL
  signature TEXT NOT NULL
  payload_json TEXT NOT NULL
  issued_at TEXT NOT NULL
  expires_at TEXT NOT NULL

write_grants
  grant_id TEXT PRIMARY KEY
  schema_version INTEGER NOT NULL
  created_at TEXT NOT NULL
  created_by TEXT NOT NULL
  action_id TEXT NOT NULL REFERENCES control_actions(action_id)
  grant_role TEXT NOT NULL CHECK (grant_role IN ('PRIMARY','ROLLBACK'))
  parent_grant_id TEXT REFERENCES write_grants(grant_id)
  agent_id TEXT NOT NULL
  channel_id TEXT NOT NULL
  task_id TEXT
  team_id TEXT
  line_id TEXT NOT NULL
  node_ids_json TEXT NOT NULL
  binding_epoch TEXT NOT NULL
  scene_id TEXT NOT NULL
  scene_version TEXT NOT NULL
  scene_contract_hash TEXT NOT NULL
  recipe_version TEXT NOT NULL
  recipe_hash TEXT NOT NULL
  objective_id TEXT NOT NULL
  objective_hash TEXT NOT NULL
  trial_id TEXT NOT NULL REFERENCES virtual_trials(trial_id)
  recommendation_id TEXT NOT NULL REFERENCES recommendation_certificates(recommendation_id)
  snapshot_hash TEXT NOT NULL
  model_version TEXT NOT NULL
  model_hash TEXT NOT NULL
  approved_control_vector_json TEXT NOT NULL
  known_good_control_vector_json TEXT
  rollback_control_vector_json TEXT
  current_value_hash TEXT NOT NULL
  max_delta_json TEXT NOT NULL
  constraints_digest TEXT NOT NULL
  policy_version TEXT NOT NULL
  min_node_interval_sec INTEGER NOT NULL
  approval_id TEXT NOT NULL
  grant_status TEXT NOT NULL CHECK (grant_status IN ('ISSUED','CLAIMED','CONSUMED','REVOKED','EXPIRED'))
  nonce TEXT NOT NULL UNIQUE
  command_id TEXT NOT NULL UNIQUE
  payload_json TEXT NOT NULL
  payload_hash TEXT NOT NULL
  signature_algorithm TEXT NOT NULL
  signature TEXT NOT NULL
  signing_key_id TEXT NOT NULL
  issued_at TEXT NOT NULL
  expires_at TEXT NOT NULL
  claimed_at TEXT
  consumed_at TEXT

control_actions
  action_id TEXT PRIMARY KEY
  channel_id TEXT NOT NULL
  task_id TEXT
  line_id TEXT NOT NULL
  trial_id TEXT NOT NULL REFERENCES virtual_trials(trial_id)
  recommendation_id TEXT NOT NULL REFERENCES recommendation_certificates(recommendation_id)
  grant_id TEXT UNIQUE REFERENCES write_grants(grant_id)
  rollback_grant_id TEXT UNIQUE REFERENCES write_grants(grant_id)
  command_id TEXT NOT NULL UNIQUE
  state TEXT NOT NULL CHECK (state IN ('PROPOSED','TRIAL_PASSED','APPROVAL_PENDING','APPROVED','GRANT_ISSUED','CLAIMED','DISPATCHING','TRANSPORT_ACKED','DEVICE_ACKED','READBACK_VERIFIED','OBSERVING','SETTLED','RECONCILIATION_REQUIRED','ROLLBACK_REQUESTED','ROLLBACK_DISPATCHING','KEPT','ABORTED','ROLLBACK_VERIFIED','SAFE_STOP','UNKNOWN_FINAL','UNCERTAIN'))
  state_version INTEGER NOT NULL DEFAULT 0
  reason_code TEXT
  terminal_at TEXT
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL

control_action_nodes
  action_id TEXT NOT NULL REFERENCES control_actions(action_id)
  node_id TEXT NOT NULL
  approved_value REAL NOT NULL
  readback_value REAL
  node_state TEXT NOT NULL
  PRIMARY KEY (action_id, node_id)

action_events
  action_id TEXT NOT NULL REFERENCES control_actions(action_id)
  event_seq INTEGER NOT NULL
  from_state TEXT
  to_state TEXT NOT NULL
  event_type TEXT NOT NULL
  command_id TEXT
  at TEXT NOT NULL
  payload_json TEXT NOT NULL
  PRIMARY KEY (action_id, event_seq)

action_reconciliations
  reconciliation_id TEXT PRIMARY KEY
  action_id TEXT NOT NULL REFERENCES control_actions(action_id)
  attempt_seq INTEGER NOT NULL
  grant_id TEXT NOT NULL REFERENCES write_grants(grant_id)
  grant_role TEXT NOT NULL CHECK (grant_role IN ('PRIMARY','ROLLBACK'))
  command_id TEXT NOT NULL
  result TEXT NOT NULL
  readback_json TEXT
  timeout_at TEXT
  resolved_at TEXT
  UNIQUE(action_id, command_id)

line_action_locks
  line_id TEXT PRIMARY KEY
  action_id TEXT NOT NULL REFERENCES control_actions(action_id)
  lock_mode TEXT NOT NULL CHECK (lock_mode IN ('ACTIVE','FROZEN'))
  locked_until_ms INTEGER
  freeze_reason TEXT
  unlock_required INTEGER NOT NULL DEFAULT 0
  unlocked_by TEXT
  unlocked_at TEXT
  lease_version INTEGER NOT NULL DEFAULT 0
  updated_at TEXT NOT NULL

safety_cases
  safety_case_id TEXT PRIMARY KEY
  schema_version INTEGER NOT NULL
  created_at TEXT NOT NULL
  created_by TEXT NOT NULL
  scene_id TEXT NOT NULL
  scene_version TEXT NOT NULL
  line_id TEXT NOT NULL
  status TEXT NOT NULL CHECK (status IN ('DRAFT','REVIEW','APPROVED','EXPIRED','REVOKED'))
  approved_by TEXT
  second_approver TEXT
  approved_at TEXT
  expires_at TEXT
  artifact_ref TEXT NOT NULL
  artifact_hash TEXT NOT NULL
  payload_json TEXT NOT NULL
  payload_hash TEXT NOT NULL UNIQUE

twin_update_runs
  update_run_id TEXT PRIMARY KEY
  request_id TEXT NOT NULL UNIQUE
  dedup_key TEXT NOT NULL
  scene_id TEXT NOT NULL
  line_id TEXT NOT NULL
  recipe_id TEXT NOT NULL
  state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','COOLDOWN'))
  cooldown_until TEXT
  started_at TEXT
  ended_at TEXT
  error TEXT
```

追加索引/约束：

```sql
CREATE UNIQUE INDEX uq_inflight_action_per_line
  ON control_actions(line_id)
  WHERE state IN ('PROPOSED','TRIAL_PASSED','APPROVAL_PENDING','APPROVED','GRANT_ISSUED','CLAIMED','DISPATCHING','TRANSPORT_ACKED','DEVICE_ACKED','READBACK_VERIFIED','OBSERVING','SETTLED','RECONCILIATION_REQUIRED','ROLLBACK_REQUESTED','ROLLBACK_DISPATCHING','UNCERTAIN');

CREATE UNIQUE INDEX uq_active_twin_update_dedup
  ON twin_update_runs(dedup_key)
  WHERE state IN ('QUEUED','RUNNING','COOLDOWN');
```

`write_grants.nonce`、`write_grants.command_id`、`control_actions.command_id` 和 `twin_update_runs.request_id` 必须有唯一约束；`twin_update_runs.dedup_key` 只用于活动运行/冷却窗口判断，成功或失败后允许下一次 request_id 重建；生产/试验/Grant 采用引用保护和状态撤销，不做物理删除。

## 9.6 实现文件矩阵

### 必做修改

```text
server/services/workshop/db/database/schema.ts
server/services/workshop/db/database/migrations.ts
server/services/workshop/db/database/seed.ts
server/services/workshop/runtime/manager/channel-templates.ts
server/api/workshop/channel-templates/[id]/instantiate.post.ts
server/services/workshop/agents/host-tool-bridge/catalog.ts
server/services/workshop/agents/host-tool-bridge/dispatch.ts
server/services/workshop/agents/industrial/aml-job-tools.ts
server/services/workshop/aml/job-orchestrator/submit.ts
server/services/workshop/aml/model-registry.ts
server/services/workshop/dcw/dcw-controller/write.ts
server/services/workshop/aml/python/amlkit.py
server/services/workshop/aml/python/requirements.txt
```

### 必做新增

```text
server/services/workshop/aml/twin/contracts.ts
server/services/workshop/aml/twin/scene-registry.ts
server/services/workshop/aml/twin/binding-snapshot.ts
server/services/workshop/aml/twin/snapshot-service.ts
server/services/workshop/aml/twin/physics-runtime.ts
server/services/workshop/aml/twin/hybrid-registry.ts
server/services/workshop/aml/twin/trial-service.ts
server/services/workshop/aml/twin/uq-ood.ts
server/services/workshop/aml/twin/acceptance.ts
server/services/workshop/aml/twin/safety-case.ts
server/services/workshop/aml/twin/write-grant.ts
server/services/workshop/aml/twin/action-state.ts
server/services/workshop/aml/twin/calibration-scheduler.ts
server/services/workshop/aml/twin/mpc-sidecar.ts
```

### 必做 API/工具

```text
server/api/workshop/aml/twin/scenes/*
server/api/workshop/aml/twin/snapshots/*
server/api/workshop/aml/twin/trials/*
server/api/workshop/aml/twin/models/*
server/api/workshop/aml/twin/write-grants/*
server/api/workshop/aml/twin/actions/*
```

工具 schema：

```text
twin_scene_read
twin_snapshot_create
twin_physics_validate
twin_trial_run
twin_trial_compare
twin_ood_check
twin_uncertainty_report
mpc_optimize
recommendation_create
twin_write_grant_request
```

其中 `twin_write_grant_request` 只提交请求，不能签发 Grant。

### 测试文件

```text
server/services/workshop/aml/twin/*.test.ts
server/services/workshop/aml/__tests__/hybrid-*.test.ts
scripts/e2e-aml-twin.mjs
scripts/e2e-aml-tool-profile.mjs
scripts/e2e-aml-write-grant.mjs
scripts/e2e-aml-fault-injection.mjs
```

## 9.7 计划范围边界

本文件包含完整路线，但验收分成两个明确层级：

### Core AML Integration DoD（本次必做）

```text
SceneContract
→ BindingSnapshot/TwinSnapshot
→ Physics Runtime
→ Hybrid AML/PyTorch 训练
→ 固定 UQ/OOD
→ VirtualTrial
→ 固定 LTV-MPC recommendation-only
→ 完整模型谱系、本地工件和元数据
```

### Governed Control Extension DoD（后续独立启用，计划包含但不阻塞 Core AML MVP）

```text
SafetyCase
→ RecommendationCertificate
→ WriteGrant
→ DCW Gateway
→ 动作状态机
→ HITL 小步写入
→ Canary
→ bounded-auto
```

真实 governed DCW 的接口、Grant、状态机和拒绝测试可以在本计划中实现并默认关闭；只有 `SafetyCase=APPROVED`、双人审批、故障注入和独立安全评审全部完成后才能单独启用。

### Future Scene/CAE Extension（不计入 Core AML MVP）

```text
Safe BO
Robust/NMPC
BOPET/FEM/CAE
ROM
跨多场景自动建模
```

## 9.8 统一 Phase Gate 模板

每个 Phase 必须由 Owner 实施、由 Approver 评审，并同时具备 Entry/Deliverables/Exit/Evidence/No-Go/Rollback/FeatureFlags。下面是本计划实际采用的 Gate 矩阵：

| Phase | Owner / Approver | Entry | Exit + Evidence | No-Go | Rollback | FeatureFlags |
|---|---|---|---|---|---|---|
| 0 契约/开关 | AML Platform / Architecture + Security | 旧 AML e2e 通过 | schema、迁移 dry-run、tool-profile e2e、Saga report | schema 迁移失败、工具越权 | 关闭全部 Twin flags，保留 legacy | channel/training/trial/mpc/write 全 false |
| 1 Snapshot | Twin Runtime / Data Owner | Phase 0 committed；节点语义已确认 | snapshot replay、freshness/sequence tests、hash lineage | 过期/乱序/跨配方快照可进入 trial | 删除 candidate snapshot，回到 legacy AML | channel + trial |
| 2 Physics | Physics Runtime / Process Owner | SceneContract 和数据集 immutable | 物理 replay、单位/稳定性/参数先验报告 | solver failure、参数越界、单位失败 | 保留旧 physics/AML baseline | training false；trial false |
| 3 Hybrid AML | AML Training / AML + Safety | physics baseline、sandbox healthy、留出 run 存在 | 三模型对比、physics/data/UQ/OOD gates、artifact digest | 残差越界、泄漏、coverage/OOD 失败 | 仅 candidate/shadow，旧 production 不动 | training true；trial false |
| 4 VirtualTrial | Twin Runtime / Process Owner | hybrid artifact validated；snapshot fresh | trial replay、全轨迹约束、candidateExecuted=false | 任一硬约束/非有限值/跨版本 | 禁止 recommendation certificate，保留 shadow | trial true |
| 5 MPC recommendation | MPC Sidecar / Safety + Process Owner | Phase 4 pass；固定 solver lock | request/result contract、solver regression、baseline comparison | timeout、no feasible、现场网络可达 | 回退为静态建议/不生成证书 | mpc true；write false |
| 6 Governed Control | DCW Runtime / Security + Safety | 独立 SafetyCase review started；Core AML complete | Grant replay/TOCTOU/fault injection/legacy regression | 任一 P0 故障、Grant schema 不一致 | 关闭 governed/write flags，recommendation-only | governed_write false until approved |
| 7 HITL/Canary | Operations / Safety + Process Owner | SafetyCase approved；shadow evidence 达标 | controlled action report、ACK/readback/settling、rollback evidence | 接管 SLA、回读、节流或回滚失败 | immediate recommendation-only，旧 model active | bounded_auto false by default |
| 8 Continuous/Scene | MLOps / Product + Process Owner | Core AML stable；scheduler policy approved | dedup/cooldown/shadow promotion report；新场景 contract | 并发重训、漂移误触发、跨场景复用 | 停止 update worker，保留旧 production | calibration worker only |

缺少 `evidence/no_go/rollback` 的阶段不能标记完成。

---

## 10. 分阶段实施计划

### Phase 0：安全开关、契约和上下文（P0）

**Owner**：AML 平台 + Agent Runtime + 安全负责人

**入口**：当前 AML/Channel/Binding/DAq/DCW 测试通过。

**工作内容**：

- 增加 `toolProfile`/`capabilityProfile`：Hybrid Twin Channel 使用 scoped；既有 legacy Channel 保持兼容；显式迁移到 scoped 的普通 Channel 才移除训练工具；
- 新增 `chtpl-hybrid-twin-mpc-default`；
- 实例化 API 增加 scene/promptVariables/objective/bindings；
- 返回模板 Agent → 实例 Agent 映射；
- 补齐 `channelId/taskId/sceneId/objectiveId` 作业上下文；
- 增加 SceneContract、BindingSnapshot、ModelManifest 类型和 schema；
- 增加拆分 Feature Flags，默认关闭真实 governed write；
- 增加 Hybrid Training Sandbox Contract，默认无 PLC 凭据、无现场网络、禁止 shell/subprocess；
- 增加 SafetyCase schema，但未批准前只能 recommendation-only；
- 为 DCW governed mode 预留拒绝入口，不改变 legacy mode。

**退出条件**：

- Hybrid Twin Channel 仅按角色看到 capability-scoped AML/Twin 工具；既有 legacy Channel 的工具集合不变；显式迁移到 scoped 的普通 Channel 不看到训练工具；
- Hybrid Twin Channel 能实例化但默认不写 PLC；
- 每次 AML 作业能追溯 Channel/Task/Scene/Objective；
- Schema 失败会在实例化前拒绝；
- 旧 AML e2e 不回归。

**证据**：

```text
Channel template e2e
Tool profile allow/deny e2e
Agent instance binding e2e
AML job lineage e2e
```

**回滚**：关闭 Feature Flag，保留旧 Channel/AML 路径。

### Phase 1：SceneContract、BindingSnapshot 和 TwinSnapshot（P0）

**Owner**：AML/Twin Runtime + 数据工程

**工作内容**：

- 实现 SceneContract schema/version/migration；
- 实现 NodeBindingSnapshot 和 hash；
- 从 DAQ 当前窗口生成 TwinSnapshot；
- 增加 freshness、watermark、sequence、phase、quality 检查；
- 保存快照元数据和本地 JSON 工件；
- Scene/Recipe/Node binding 强绑定。

**退出条件**：

- 同一 Snapshot 可复现；
- 过期、乱序、缺失、跨配方快照被拒绝；
- 快照可反查 Channel/Task/Model/Binding。

**禁止事项**：

- 不接入真实自动 DCW；
- 不让 Agent 自己伪造 Snapshot。

### Phase 2：Physics Runtime 和参数校准（P1）

**Owner**：物理建模 + AML Python Runtime

**工作内容**：

- 定义 `PhysicsModelProvider` 接口；
- 实现注塑第一版低阶状态空间/ODE 模板；
- 实现 `initialize/step/simulate/estimateState/evaluateConstraints`；
- 实现物理参数有界校准；
- 记录物理模型源码、参数、单位和 hash；
- Agent 只能提交候选物理模型，不能直接发布。

**退出条件**：

- 物理模型可离线 replay；
- 参数在先验范围内；
- 数值稳定性和单位测试通过；
- 物理模型单独基线报告完成。

### Phase 3：Hybrid AML/PyTorch 残差和 UQ（P1）

**Owner**：AML Training + Calibration + Evaluation

**工作内容**：

- 扩展 AML job kind：`physics_calibration/hybrid_residual/uncertainty_calibration`；
- 扩展 `amlkit` 读取 physics manifest/snapshot/objective；
- 实现 A/B/C/D 四阶段训练；
- 输出 `model.pt` + `model.onnx` + physics/residual/uncertainty 工件；
- 通过 Deep Ensemble + Conformal/OOD 生成不确定度；
- 扩展 G0-G4 Twin Gate；
- 与纯 AML 模型比较。

**退出条件**：

- 纯物理、纯 AML、混合模型均有可复现实验；
- 混合模型在留出 run 上达到 AcceptanceProfile；
- 物理硬约束违反率为 0（write-eligible 候选）；
- OOD fixture 拒绝率为 100%；
- 训练代码、权重、环境和数据集可复现。

### Phase 4：VirtualTrial 和 ObjectiveProfile（P1）

**Owner**：Twin Runtime + MPC

**工作内容**：

- 实现 `twin_snapshot_create`；
- 实现 `twin_trial_run/compare`；
- 明确 passive shadow 与 counterfactual trial；
- 增加 `candidateExecuted=false`；
- 实现 ObjectiveProfile；
- 全轨迹检查硬约束、信任域、UQ/OOD；
- 试验结果持久化。

**退出条件**：

- VirtualTrial 不触碰任何 PLC/DCW；
- 候选可重复运行；
- 所有约束判定可审计；
- 多个目标可共享同一个 TwinModel。

### Phase 5：LTV-MPC 和 RecommendationCertificate（P1）

**Owner**：MPC + Safety

**工作内容**：

- 在 Python 数值侧车实现第一版 LTV-MPC/小规模有界优化；
- 控制上下限、变化率、输出守卫、动作预算和不确定度约束；
- 生成 CandidateTrajectory；
- 生成 RecommendationCertificate；
- 不直接调用 DCW。

**退出条件**：

- 优化器只返回证书草案，不写现场；
- 所有候选都有 baseline comparison；
- 全轨迹硬约束通过率达到 100%；
- OOD/UQ 超限自动降级或拒绝。

### Phase 6：Governed Control Extension——Twin Gate、WriteGrant 和动作状态机（P0）

**Owner**：DCW Runtime + Security/Safety

**工作内容**：

- 实现一次性、短时、绑定 hash 的 WriteGrant；
- 在 governed `dcw_control` 路径强制校验；
- 增加 action state machine；
- 持久化节点级/产线级节流和 in-flight action；
- 分离 transport ACK/device ACK/readback/DAQ settling；
- 处理 ACK 丢失、回读不一致、部分写入、网络中断、回滚失败；
- 增加 bindingEpoch 和 grant replay protection；
- Twin controlled mode 下禁止 candidate 直达 production；
- 在 `model-registry.ts`、repository transition 和 promotion API 三层强制 modelKind 状态转移；
- SafetyCase 未 APPROVED 时不允许 WRITE_ELIGIBLE/Canary/bounded-auto。

**退出条件**：

- 无 Twin 证据的 governed write 拒绝率 100%；
- 过期/重放/跨节点/跨线/跨配方 Grant 拒绝率 100%；
- ACK/readback/settling 不完整不会进入 KEPT；
- 写入节流违规次数为 0；
- 旧 legacy DCW 流程回归通过。

**回滚**：`AML_TWIN_GOVERNED_WRITE_ENABLED=false` 且 `AML_TWIN_BOUNDED_AUTO_ENABLED=false`，所有建议回到 recommendation-only。

### Phase 7：Governed Control Extension——Shadow、HITL、Canary 和有限自动化（P0）

**Owner**：运维/工艺 Owner + Safety + AML

**工作内容**：

```text
offline replay
→ passive shadow
→ counterfactual trial
→ recommendation-only
→ HITL 小步写入
→ Canary
→ bounded-auto
```

默认 Shadow 门：

```text
至少 10 个独立生产样本或批次
覆盖至少 3 个代表性工况
无硬约束违规
预测区间覆盖率达标
无重大 OOD 漏报
无错误 readback
```

**退出条件**：

- 生产模型不可变；
- 新模型失败自动保留旧模型；
- bounded-auto 仅限明确 Channel policy；
- 首次上线、模型切换、异常和越界强制 HITL。

### Phase 8：后续扩展——数据触发持续校准和多场景模板化（P2）

**Owner**：MLOps + Scene Platform

**工作内容**：

- 新 run 数量、漂移、误差、维修、配方变化触发校准；
- 自动生成 DatasetSnapshot 和候选模型；
- 自动进入 Shadow，不能自动覆盖 production；
- 将注塑实现抽象为通用 Scene/Physics/Objective 插件；
- 接入 BOPET/双轴拉伸 CAE/FEM sidecar；
- 高保真 FEM 用于离线复核和 ROM/代理数据生成。

**退出条件**：

- 新场景只需新增 SceneContract/PhysicsProvider/ObjectiveProfile；
- 核心 AML/AgentTeam 代码不复制；
- 跨场景访问和模型复用被拒绝；
- 自动校准失败不影响当前 production。

---

## 11. AcceptanceProfile 默认值

所有场景的阈值必须由 `AcceptanceProfile` 覆盖，不能通过 Agent Prompt 隐式决定。默认值如下：

```yaml
profileId: aml-hybrid-twin-default-v1
model:
  oneStepTestNrmseMax: 0.10
  rolloutTestNrmseMax: 0.25
  valTestGapMax: 0.20
  minRows: 500
  minRuns: 3
physics:
  hardConstraintViolationRateMax: 0
  parameterPriorViolationRateMax: 0
  solverFailureRateMax: 0
uncertainty:
  calibrationMinRows: 300
  confidenceLevel: 0.95
  coverageTarget: 0.90
  coverageBy: [target, phase]
  falseSafeRateMax: 0
  calibrationSetHashRequired: true
  oodFixtureSetId: aml-hybrid-twin-ood-v1
  oodFixtureMinCount: 20
  oodFixtureRejectCountRequired: 20
  oodDistanceMethod: mahalanobis_shrinkage
  oodDistanceThresholdQuantile: 0.995
  oodDistanceThresholdMax: 16.0
  ensembleDisagreementMethod: normalized_p95_std
  ensembleDisagreementThreshold: 0.15
  calibrationStaleAfterSec: 604800
  snapshotFreshnessMaxMs: 60000
  snapshotStaleRejectCode: SNAPSHOT_STALE
  uqRejectCodes: [UQ_COVERAGE_LOW, OOD_DISTANCE_HIGH, ENSEMBLE_DISAGREEMENT_HIGH, CALIBRATION_STALE, SNAPSHOT_STALE]
trial:
  minWriteEligibleCandidateCount: 10
  minTrialCount: 10
  minCalibrationRowsByStratum: 30
  zeroDenominatorPolicy: reject
  writeEligibleCandidateCountDenominator: candidate_count
  hardViolationCountMax: 0
  hardViolationRateMax: 0
  trajectoryViolationPolicy: reject_entire_candidate
  nonFiniteOrSolverFailure: reject_candidate
  candidateExecutedRequired: false
shadow:
  minIndependentRuns: 10
  minOperatingRegimes: 3
safety:
  safetyCaseRequired: true
  twoPersonApprovalRequired: true
  faultInjectionRequired: true
write:
  minNodeIntervalSec: 60
  minLineActionIntervalSec: 60
  countFrom: first_dispatching
  maxActionsPerRun: 3
  grantTtlSec: 120
```

“满足硬约束的候选”仍必须通过 UQ、OOD、权限、审批、快照新鲜度和 Grant 门；只有违反硬约束的候选 write-eligible 通过率必须为 0。

---

## 12. 测试和验证计划

### 12.1 单元测试

- SceneContract schema、版本和迁移；
- Prompt 变量缺失拒绝；
- BindingSnapshot hash；
- TwinSnapshot freshness/watermark/phase；
- 物理模型单位和参数边界；
- residual amplitude bound；
- UQ/OOD 阈值；
- ObjectiveProfile 目标函数；
- WriteGrant 签名/绑定/TTL/nonce；
- 状态机合法转移；
- 节流窗口和动作预算。

### 12.2 集成测试

- 普通 Channel 不显示 AML 训练工具；
- Hybrid Twin Channel 按角色显示正确工具；
- 工具直接绕过 catalog 时 dispatch 拒绝；
- Channel 实例化自动生成正确 Agent 映射；
- 批量节点绑定只绑定实例 ID；
- AML 作业正确写入 Channel/Task/Scene/Objective；
- Dataset/Job/Model/Trial 谱系完整；
- physics_calibration/hybrid_residual 作业工件完整；
- VirtualTrial 不影响 PLC/DCW；
- legacy AML 预测不回归。

### 12.3 E2E 和故障注入

必须覆盖：

```text
创建 Channel
→ 绑定注塑场景节点
→ 拉取 DAQ 数据
→ 训练物理参数
→ 训练残差
→ 运行 VirtualTrial
→ LTV-MPC
→ Shadow
→ Recommendation
→ HITL
→ WriteGrant
→ DCW
→ ACK
→ Readback
→ Settling
→ Keep
```

故障注入：

- ACK 丢失；
- transport accepted 但 device 未应用；
- readback 不一致；
- DAQ 陈旧；
- 时间戳倒退/乱序；
- 多节点部分成功；
- 网络中断；
- 回滚失败；
- Grant 重放；
- Grant 跨节点/跨线；
- 模型被撤销；
- OOD 输入；
- 绑定解除；
- 服务重启；
- 队列并发；
- 60 秒节流违规尝试。

### 12.4 不变式

必须持续满足：

```text
普通 Channel 的行为不变
没有有效 Twin 证据不能 governed write
没有完整 readback/settling 不能 KEPT
production 模型不可原地覆盖
旧模型在新模型失败时继续可用
不同 scene/line/recipe 不可交叉复用
```

---

## 13. 风险与回滚

| 风险 | 预防 | 回滚 |
|---|---|---|
| 工具泄漏给普通 Agent | catalog + dispatch 双重 capability 校验 | 关闭 `AML_TWIN_CHANNEL_ENABLED`、`AML_TWIN_TRAINING_ENABLED`、`AML_TWIN_TRIAL_ENABLED`、`AML_TWIN_MPC_ENABLED` 和 `AML_TWIN_GOVERNED_WRITE_ENABLED`；`AML_TWIN_BOUNDED_AUTO_ENABLED` 保持 false |
| Channel 半实例化 | 事务/补偿删除和幂等 requestId | 删除未完成实例记录 |
| 物理模型错误 | 人工审批、回归、物理门禁、参数先验 | 保留旧 Twin/旧 production |
| 残差掩盖错误方程 | 残差上限、物理残差监控、结构变更升级场景版本 | 禁止 write-eligible |
| 新模型恶化 | shadow、Canary、自动撤销 | 恢复旧模型 |
| Grant 重放 | nonce/commandId/one-time consume | 撤销绑定 epoch |
| 多节点频繁动作 | 产线锁、动作预算、持久化节流 | recommendation-only |
| 依赖安装失败 | 独立 hybrid env、锁文件、旧 AML env 不变 | 回退普通 AML |
| 服务重启丢状态 | 状态和节流持久化 | 重启后统一进入 UNCERTAIN |
| 数据漂移误触发 | 最小样本量、冷却时间、人工确认 | 保持当前 production |

---

## 14. 实施顺序和提交边界

为避免引入新问题，按以下不重叠边界实施：

1. **Commit Group A：契约和类型**
   - SceneContract/Manifest/Trial/Grant 类型；
   - schema/version/migration；
   - 不改变运行路径。
2. **Commit Group B：Channel 模板和 capability profile**
   - 默认模板、实例参数、Prompt 渲染、工具过滤；
   - 普通 Channel 回归。
3. **Commit Group C：BindingSnapshot/TwinSnapshot/谱系**
   - 数据和作业上下文；
   - 不接真实 governed write。
4. **Commit Group D：Physics Runtime 和 hybrid training**
   - PyTorch 物理校准、残差、UQ/OOD；
   - 只输出 candidate/shadow。
5. **Commit Group E：VirtualTrial/MPC**
   - 隔离仿真、目标函数、候选轨迹和 RecommendationCertificate；
   - 不接 DCW。
6. **Commit Group F：Twin Gate/WriteGrant/动作状态机**
   - 只在 feature flag 下启用；
   - 故障注入通过后才能进入下一组。
7. **Commit Group G：持续校准/多场景扩展**
   - 先完成注塑，后扩展 BOPET/CAE；
   - 不改变普通 AML。

每个提交组必须独立通过：

```text
类型检查
单元测试
相关 AML e2e
普通 Channel 回归
文档/迁移检查
```

---

## 15. 完成定义（Definition of Done）

### 15.1 Core AML Integration DoD（本次必做）

只有同时满足以下条件，才可以宣称 Core AML Hybrid Twin 集成完成：

- 用户可用一个默认 Channel 模板实例化注塑或其他自定义场景；
- 实例化时可传入场景参数、提示词、目标和节点绑定；
- Hybrid Twin Team 按角色获得最小权限工具；既有 legacy Channel 行为不回归；
- DAQ 数据集、训练作业、模型、试验可以完整反查 Channel/Task/Scene/Objective；
- 物理模型、参数集、残差模型和 UQ 工件可复现；
- 纯物理、纯 AML、混合模型有对比证据；
- VirtualTrial 与真实 DCW 完全隔离；
- MPC 候选满足全轨迹硬约束；
- OOD/UQ 超限自动拒绝或降级；
- hybrid_twin candidate 不能直达 production；
- 本地工件、数据库元数据、schema、迁移和 provenance 完整；
- 旧 AML、普通 AgentTeam、PLC/DAQ/DCW 回归通过。

### 15.2 Governed Control Extension DoD（独立启用）

只有同时满足以下条件，才可以启用 governed DCW：

- 独立 `SafetyCase=status=APPROVED`，包含双人审批和故障注入证据；
- governed DCW 必须具备有效、签名、一次性 WriteGrant；
- Grant/Action 状态机在 ACK 丢失、回读不一致、重启、部分写入、回滚失败时闭合；
- ACK/readback/settling 不完整不能进入 KEPT；
- 节点级、产线级和任务级 60 秒动作策略没有违规，canonical 计时点为首次 DISPATCHING；
- 新模型失败时旧 production 保持可用；
- WRITE_ELIGIBLE/Canary/bounded-auto 全部有对应 policy 和审批证据。

### 15.3 Future Scene/CAE Extension DoD

Safe BO、Robust/NMPC、BOPET/FEM/CAE、ROM 和跨多场景自动建模单独立项，不作为 Core AML MVP 或 Governed Control Extension 的完成条件。

## 16. 当前下一步

下一轮实现应该从 **Phase 0 / Commit Group A** 开始，先只做 Core AML Integration 的契约、权限和谱系：

```text
SceneContract
PhysicsModelManifest
NodeBindingSnapshot
TwinSnapshot
HybridModelManifest
ObjectiveProfile
TrialResult
RecommendationCertificate
WriteGrant
```

并补齐：

```text
toolProfile/capabilityProfile
Channel 实例化参数
AML 作业上下文
Feature Flag
```

这一轮不训练新模型、不启动 PLC、不写 DCW；先把契约、权限、谱系、Sandbox 和回滚边界做正确，再进入物理模型和训练实现。任意 Agent 物理代码在 Sandbox 契约落地前不得执行。

---

## 17. 用户确认的默认 Judge/Taste

本计划按以下默认值执行，无需重新讨论：

```text
1. 试点场景：注塑优先，BOPET/CAE 第二阶段
2. 控制模式：新 Channel 默认 recommendation-only，可按 Channel 升级
3. DCW 节流：节点级 + 产线级 + 任务动作预算
4. HITL：初期每次真实写入人工确认；稳定后首次/异常/模型切换强制人工
5. 模型晋级：禁止 candidate 直达 production
6. Team：Lead 常驻，其余角色按任务按需创建
7. 优化目标：先做单目标质量跟踪
8. 框架：PyTorch first，ONNX Runtime inference
```

---

## 18. 计划执行纪律

- 修改前先读取并保留工作区现有 dirty changes；
- 不执行 `git reset --hard`、不删除无关文件、不改 PLC 模拟器无关逻辑；
- 每个阶段先加测试，再改实现，再跑回归；
- 任何涉及真实 DCW 的代码必须先由安全审查和故障注入验证；
- 任何模型权重和训练代码都必须带数据、场景、环境和源码指纹；
- 不把 Agent 自然语言承诺当作安全证明；
- 失败默认 fail-closed，恢复默认进入 `UNCERTAIN` 或 `recommendation-only`；
- 若当前实现与本计划冲突，以服务端确定性门禁、本计划的 P0 安全边界和旧行为兼容为准。


## 19. 实施验收记录（2026-09-25）

本次已落地 Core AML Integration 的第一可运行切片，并保持真实 DCW 为 0 写入：

- 新增 Hybrid Twin 领域契约：SceneContract、PhysicsModelManifest、TwinSnapshot、ObjectiveProfile、VirtualTrial、RecommendationCertificate；
- 新增注塑低阶灰箱物理 Provider：物理状态演化、全轨迹约束和小步参数候选；
- 新增 snapshot freshness/watermark/hash；
- 新增 3-member ensemble 聚合、UQ/OOD 拒绝逻辑；
- 新增模型门禁：未达标时 `safe_small_step`，达标后才进入 `precise_search` recommendation-only；
- 新增 VirtualTrial、Recommendation-only 证书和本地 `aml/twins/**` 工件；
- 新增 SQLite Hybrid Twin 元数据表和 Channel profile 表；
- 新增 Hybrid Twin Channel 默认模板和实例化时 profile/scene/objective 参数；
- 新增 Twin/MPC host tools，并在 dispatch 层拒绝非 Hybrid Channel；
- 扩展 AML 作业 lineage：scene/version/objective/job kind/physics manifest/snapshot/objective profile 写入 budget_json；
- 扩展 PyTorch `amlkit` 和 `train-hybrid-example.py`，物理主干+有界残差工件协议；
- 增加 `scripts/acceptance-aml-hybrid-twin.ts` 验收脚本。

已验证：

```text
npm run typecheck                         PASS
npx eslint <本次 AML/Twin 文件集合>        PASS
python -m py_compile <AML Python 文件>     PASS
npx tsx scripts/acceptance-aml-hybrid-twin.ts PASS
node scripts/acceptance-aml-hybrid-live.mjs PASS（Channel 实例化、TwinSnapshot、safe_small_step MPC、0 DCW）
```

验收脚本验证：

```text
训练不足 → safe_small_step
训练/数据/UQ/OOD 门禁通过 → precise_search
候选 VirtualTrial → candidateExecuted=false
不安全候选 → 硬约束拒绝
过期 TwinSnapshot → SNAPSHOT_STALE 拒绝
Recommendation-only → 0 次真实 DCW 写入
```

本记录不表示 Governed Control Extension 已获得真实投产资格；WriteGrant/真实 DCW 仍保持默认关闭，必须在独立 SafetyCase、故障注入和双人审批完成后另行启用。
