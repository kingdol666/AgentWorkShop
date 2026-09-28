# Agent 自动构建通用 Hybrid Twin MPC 计划

- **计划状态**：设计已定案，待实施确认
- **日期**：2026-09-25
- **项目**：`D:\codes\ABO\AgentWorkShop`
- **目标**：让用户只需提供真实工业场景描述并绑定 DAQ/DCW 节点，AgentTeam 就能自动完成场景理解、物理模型构建、真实数据校准、深度残差训练、UQ/OOD 评估、Twin Gate、Shadow 运行和在线 MPC 推荐/受治理控制。
- **默认策略**：声明式 PhysicsSpec 优先；不允许 Agent 默认直接生成并执行任意物理代码。只有声明式 DSL 无法表达的复杂场景，才允许生成隔离 Provider Plugin，并经过静态检查、Replay、人工批准后加载。

---

## 1. 最终产品定义

最终建设的不是一个“万能模型”，而是一个：

```text
通用场景建模编译器
+ 声明式物理模型运行时
+ Provider/ScenePack 插件 SDK
+ AML 校准/残差/UQ 编排
+ Hybrid Twin MPC
+ Shadow/HITL/安全控制生命周期
```

不同工业场景的物理规律由不同的 `PhysicsSpec` 或 Provider 实现；平台统一管理：

```text
场景协议
节点语义
数据集
物理参数
残差模型
不确定性
MPC 候选
模型生命周期
DCW/DAQ 安全边界
```

### 1.1 目标闭环

```text
用户场景提示词 + 节点绑定
        ↓
Scene Discovery
        ↓
Node Semantic Mapping
        ↓
SceneContract Draft
        ↓
物理模板选择 / PhysicsSpec 编译
        ↓
安全小步实验设计
        ↓
DAQ/DCW 数据采集
        ↓
物理参数校准
        ↓
有界神经残差训练
        ↓
UQ/OOD 校准
        ↓
Twin Gate
        ↓
Shadow 模型
        ↓
VirtualTrial + Hybrid MPC
        ↓
Recommendation-only
        ↓
HITL / SafetyCase
        ↓
Governed DCW
        ↓
DAQ 反馈与增量校准
```

---

## 2. 已有基础与主要缺口

### 2.1 已有可复用基础

| 基础能力 | 位置 | 当前状态 |
|---|---|---|
| SceneContract/TwinSnapshot/Trial | `server/services/workshop/aml/twin/contracts.ts`、`snapshot-service.ts`、`trial-service.ts` | 已有 |
| 注塑灰箱 Provider | `server/services/workshop/aml/twin/physics-runtime.ts` | 已有，可作为默认 Provider |
| Provider Registry/Generation/Lease | `server/services/workshop/aml/twin/provider-registry.ts` | 已有 |
| Twin Plugin SDK | `sdk/context.mjs`、`sdk/index.d.mts` | 已有 `ctx.twin` |
| 插件热加载 | `server/services/workshop/plugins/host/load.mjs`、`reload.mjs` | 已有 |
| Hybrid Channel Profile | `server/services/workshop/aml/twin/channel-profile.ts` | 已有 Provider lineage 扩展 |
| AML Dataset/Job/Model | `server/services/workshop/aml/` | 已有基础编排 |
| Twin Gate | `server/services/workshop/aml/twin/acceptance.ts`、`aml/gates.ts` | 已有基础门禁 |
| Agent Twin Tools | `server/services/workshop/agents/industrial/twin-tools.ts` | 已有，仍需通用化 |

### 2.2 必须补齐的能力

当前最关键的缺口不是再增加一个场景 Provider，而是：

1. **自动 SceneCompiler**：从用户提示词和节点语义自动生成场景契约；
2. **声明式 PhysicsSpec DSL**：让 Agent 用结构化方程描述物理过程；
3. **通用物理运行时**：把 PhysicsSpec 编译为安全 Provider；
4. **自动实验设计器**：模型不可用时自动生成安全小步探索；
5. **物理参数校准作业**：从真实 DAQ 数据估计物理参数；
6. **真正的 Hybrid Residual**：`y = y_phys + residual`，不能把残差网络当纯黑盒；
7. **UQ/OOD 自动校准**：由平台权威计算，不允许 Agent 伪造；
8. **MPC 模型运行时**：真实加载 ONNX/ROM/参数，而不是只根据 `modelReady` 切模式；
9. **Provider 与 Channel 强绑定**：不能让 Agent 在调用参数中随意切换 Provider；
10. **FEM/CFD/DEM/ROM SolverAdapter**：作为离线高保真和代理数据生成能力；
11. **模型自动增量更新**：真实数据达到触发条件时自动进入新一轮校准和评测。

---

## 3. 已确定的核心设计原则

### 3.1 声明式模型优先

Agent 默认生成 `PhysicsSpec`，不直接执行任意代码：

```text
用户提示词
  → 结构化变量
  → 方程 AST
  → 单位/维度检查
  → 单调性/边界检查
  → 物理 Provider 编译
```

PhysicsSpec 只能使用白名单算子：

```text
+, -, *, /, pow, exp, log
一阶/二阶惯性
延迟
饱和
死区
积分
质量守恒
能量守恒
反应速率
```

禁止：

```text
eval 任意字符串
import 任意模块
访问文件系统
访问网络
访问 PLC/DCW 凭据
启动未授权进程
```

### 3.2 SceneContract 分两阶段

Agent 可以自动生成：

```text
SceneContract Draft
```

但首次投入建模前必须冻结：

```text
SceneContract Approved/Frozen
```

默认规则：

- 只改变描述、非控制字段的兼容修订，可自动生成新 draft；
- 改变控制量、目标量、硬约束、单位、配方边界或 Provider 时，必须重新人工确认；
- SceneContract hash 变化必须重新构建 Dataset、重训和过 Twin Gate；
- 不允许旧模型直接绑定新 SceneContract。

### 3.3 物理优先、数据修正

统一模型形式：

```text
y_phys = PhysicsProvider(x, u, d; θ)
y_pred = y_phys + bounded_residual(x, u, d; φ)
```

训练目标：

```text
L = L_data
  + λphysics · L_physics
  + λbound · L_constraint
  + λmono · L_monotonicity
  + λresidual · L_residual_bound
  + λuq · L_uncertainty
```

数据模型不得覆盖物理主干，只能学习有界偏差。

### 3.4 模型上线必须 Shadow 优先

生命周期：

```text
DRAFT
  → VALIDATED
  → CANDIDATE
  → SHADOW
  → RECOMMENDATION_ONLY
  → HITL_GOVERNED
  → PRODUCTION
  → RETIRED
```

禁止：

```text
CANDIDATE → PRODUCTION
```

### 3.5 安全默认值

```text
模型未通过：safe_small_step
模型通过：precise_search，但仍 recommendation-only
DCW：至少 60 秒间隔
SET/ACT 不一致：阻止生产控制
Snapshot 过期/不完整：拒绝 Trial
UQ/OOD 失败：拒绝 RecommendationCertificate
Provider 热加载：不能替换正在运行的生产模型
```

---

## 4. 通用协议设计

### 4.1 NodeSemantic

服务端从 DAQ/DCW 节点、模板、绑定和历史数据整理：

```ts
interface NodeSemantic {
  nodeId: string
  kind: 'daq' | 'dcw'
  name: string
  physicalMeaning: string
  unit: string
  min?: number
  max?: number
  samplingPeriodMs?: number
  lineId?: string
  productId?: string
  recipeId?: string
  protocol: string
  readbackSupported?: boolean
  writable?: boolean
  semanticEvidence: Array<{
    source: 'node_description' | 'template' | 'recipe' | 'history' | 'agent_proposal'
    confidence: number
    text?: string
  }>
}
```

Agent 不能仅凭名称臆造物理含义；每个语义必须包含证据和置信度。

### 4.2 SceneContract v2

扩展当前 `SceneContract`：

```ts
interface SceneContractV2 extends SceneContract {
  status: 'draft' | 'approved' | 'frozen' | 'deprecated'
  contractHash: string
  nodeSemanticSnapshotHash: string
  providerId: string
  providerVersion: string
  providerHash: string
  variableEvidence: Record<string, {
    confidence: number
    sources: string[]
  }>
  inferredRelations: Array<{
    cause: string
    effect: string
    direction: 'positive' | 'negative' | 'unknown'
    confidence: number
    evidence: string
  }>
  approval?: {
    approvedBy: string
    approvedAt: string
    reason?: string
  }
}
```

### 4.3 PhysicsSpec v1

```ts
interface PhysicsSpec {
  specVersion: 'physics-spec.v1'
  modelId: string
  sceneId: string
  variables: VariableSpec[]
  parameters: ParameterPrior[]
  states: EquationSpec[]
  observations: EquationSpec[]
  constraints: ConstraintSpec[]
  monotonicity: MonotonicitySpec[]
  delays: DelaySpec[]
  sampling: SamplingSpec
  solver: {
    method: 'discrete_state_space' | 'ode' | 'pde_reduced' | 'rom'
    dtSec: number
    stabilityPolicy: 'reject_unstable' | 'warn_unstable'
  }
  provenance: {
    createdBy: string
    evidence: string[]
    sourceDocuments?: string[]
  }
}
```

示例：

```json
{
  "states": [
    {
      "lhs": "temperature_next",
      "rhs": {
        "op": "add",
        "args": [
          { "ref": "temperature" },
          {
            "op": "mul",
            "args": [
              { "param": "alpha" },
              {
                "op": "sub",
                "args": [
                  { "ref": "heater_setpoint" },
                  { "ref": "temperature" }
                ]
              }
            ]
          }
        ]
      }
    }
  ]
}
```

### 4.4 ModelLineage

每个模型都必须保存：

```text
sceneContractHash
nodeSemanticSnapshotHash
physicsSpecHash
providerId
providerVersion
providerHash
providerGeneration
datasetId
physicsCalibrationJobId
residualJobId
uqCalibrationJobId
objectiveProfileHash
acceptanceProfileHash
```

---

## 5. AgentTeam 自动建模流程

### 5.1 角色划分

| 角色 | 责任 |
|---|---|
| Scene Analyst | 读取用户任务、产线、产品、配方和节点语义 |
| Semantic Mapper | 归一化物理含义、单位、边界和控制方向 |
| Scene Compiler | 生成 SceneContract Draft 和证据链 |
| Physics Architect | 选择模型族、生成 PhysicsSpec 和参数先验 |
| Experiment Designer | 生成 safe_small_step 探索计划 |
| Data Engineer | 自动创建 control mirror、构建隔离数据集 |
| Physics Calibrator | 校准物理参数和延迟/增益 |
| Residual Trainer | 训练有界残差网络 |
| UQ Evaluator | 校准覆盖率、OOD、误差和不确定性 |
| MPC Engineer | Hybrid rollout、VirtualTrial、候选搜索 |
| Safety Lead | Gate、Readback、DCW 节流、HITL 和回退 |
| Team Lead | FIFO 调度、阶段迁移、人工确认请求和最终收口 |

### 5.2 新 Agent 工具

计划新增：

```text
twin_provider_catalog
twin_scene_discover
twin_scene_compile
twin_scene_validate
twin_physics_spec_create
twin_physics_spec_validate
twin_experiment_design
twin_control_mirror_create
twin_calibration_submit
twin_residual_submit
twin_uq_calibration_submit
twin_model_package
twin_model_compatibility_check
twin_shadow_start
twin_shadow_status
```

已有工具继续复用：

```text
twin_snapshot_create
twin_trial_run
twin_gate_evaluate
mpc_optimize
aml_dataset_build
aml_job_submit
aml_job_status
aml_model_promote
```

### 5.3 自动建模状态机

```text
SCENE_DISCOVERING
  → SCENE_DRAFTED
  → SCENE_APPROVAL_REQUIRED
  → SCENE_FROZEN
  → PHYSICS_SPEC_DRAFTED
  → PHYSICS_SPEC_VALIDATED
  → EXPERIMENT_PLANNED
  → DATA_COLLECTING
  → PHYSICS_CALIBRATING
  → RESIDUAL_TRAINING
  → UQ_CALIBRATING
  → MODEL_PACKAGED
  → TWIN_GATE_EVALUATING
  → SHADOW_RUNNING
  → RECOMMENDATION_READY
  → HITL_REQUIRED
  → ONLINE_ELIGIBLE
```

任一阶段失败必须进入：

```text
FAILED_SAFE
```

并保持：

```text
recommendation-only 或 safe_small_step
```

---

## 6. PhysicsSpec 编译与物理约束

### 6.1 编译器流水线

```text
PhysicsSpec JSON
  ↓
Schema 校验
  ↓
变量/单位检查
  ↓
表达式 AST 检查
  ↓
参数先验检查
  ↓
稳定性检查
  ↓
单调性检查
  ↓
约束可满足性检查
  ↓
GenericDeclarativeProvider
```

### 6.2 必须阻止的模型

- 单位不一致；
- 同一变量同时拥有冲突单位；
- 参数初值超出先验；
- 状态方程导致明显发散；
- 输出超出物理边界；
- 约束条件互相矛盾；
- 违反声明的正/负单调关系；
- `NaN/Inf`；
- 未声明的变量引用；
- 任意代码、文件、网络或进程调用。

### 6.3 模型族优先级

Agent 不应该每次从零生成物理代码，而应优先选择：

```text
GenericFirstOrderProvider
GenericStateSpaceProvider
GenericMassBalanceProvider
GenericHeatTransferProvider
GenericReactionKineticsProvider
GenericMotionProvider
RomProvider
FEM/CFD/DEM SolverAdapter
```

只有现有模型族无法表达时，才转入沙箱 Provider Plugin 路径。

---

## 7. 数据与训练流水线

### 7.1 自动生成 Control Mirror

当 Agent 绑定一个 DCW 节点为 control 时，系统自动创建只读 DAQ 镜像：

```text
DCW
  ↓
Control Mirror DAQ
  ↓
DAQ history
  ↓
Dataset control input
```

不再要求用户手工重复创建控制镜像节点。

### 7.2 三类 AML 作业

#### physics_calibration

输出：

```text
physics_parameters.json
calibration_metrics.json
parameter_covariance.json
```

#### hybrid_residual

输入：

```text
PhysicsSpec
校准参数
数据集
```

输出：

```text
residual_model.onnx
hybrid_manifest.json
```

#### uncertainty_calibration

输出：

```text
uq_calibration.json
coverage
OOD threshold
disagreement threshold
```

### 7.3 真正的 Hybrid 训练

```python
physics_next = provider.rollout(history, controls, calibrated_parameters)
residual = residual_model(history, controls)
prediction = physics_next + bounded(residual)
```

平台评估器必须验证：

```text
physics-only error
hybrid error
residual magnitude
constraint violation
one-step NRMSE
rollout NRMSE
validation/test gap
```

如果残差模型比物理模型更好，但违反单调性或边界，仍然拒绝。

---

## 8. MPC 运行时设计

当前 `mpc_optimize` 需要从“固定物理候选搜索”升级为：

```text
读取 Channel 固定 Provider
  ↓
读取 Frozen SceneContract
  ↓
读取当前 TwinSnapshot
  ↓
读取 active/shadow Hybrid Model
  ↓
Physics rollout
  ↓
ONNX residual rollout
  ↓
UQ/OOD
  ↓
全轨迹约束
  ↓
候选成本排序
  ↓
RecommendationCertificate
```

MPC 的候选模式：

```text
模型未就绪：safe_small_step
模型已通过：precise_search
UQ/OOD 失败：safe_small_step 或拒绝
硬约束失败：拒绝
Provider 版本不兼容：拒绝
Snapshot 过期：拒绝
```

生产模型绝不直接被热加载替换。

---

## 9. 插件与 Provider 热加载

已实现基础：

```text
Provider Registry
ctx.twin
Provider generation
lease/in-flight
DRAINING → RETIRED
```

目标运行语义：

```text
Plugin v1
  → Provider generation 1
  → Model A

Plugin v2 热加载
  → generation 2
  → 旧 Trial/Job 继续用 generation 1
  → 新 Trial/Job 使用 generation 2
  → 新模型重新过 Gate
  → 人工批准后替换 shadow
```

禁止：

```text
插件热加载直接替换 production
Plugin hash 变化后继续使用旧模型且不告警
Agent 通过参数强制切换 Provider
```

---

## 10. FEM/CFD/DEM/ROM 接入

高保真求解器只作为 sidecar：

```text
FEM/CFD/DEM
  ↓
离线样本/参数灵敏度
  ↓
ROM/ONNX
  ↓
Hybrid Twin MPC
```

SolverAdapter 必须：

- 独立进程或容器；
- 无 PLC 凭据；
- 默认禁止出站网络；
- 输入白名单；
- CPU/内存/磁盘/运行时限制；
- 可强制取消；
- 结果 hash；
- 不允许直接写 DCW。

---

## 11. 模型投入在线控制的门禁

模型必须同时满足：

```text
SceneContract = frozen
Provider = registered + healthy
Provider hash = lineage match
Dataset rows/runs 达标
Physics calibration 达标
Residual model 达标
One-step error 达标
Rollout error 达标
Validation/test gap 达标
UQ coverage 达标
OOD threshold 达标
VirtualTrial candidate 数量达标
全轨迹硬约束零违规
Shadow 观察期通过
PLC SET/ACT 一致
DAQ runtime 正常
DCW 60 秒节流正常
HITL/SafetyCase 已通过
```

任一失败：

```text
不进入 production
不签发 WriteGrant
回退 recommendation-only 或 safe_small_step
```

---

## 12. 实施阶段

### Phase 0：协议冻结

交付：

```text
SceneContract v2
NodeSemantic v1
PhysicsSpec v1
ModelLineage v1
ExperimentPlan v1
```

### Phase 1：场景自动发现和编译

实现：

```text
Node semantic catalog
节点角色分类
单位/量程/协议归一化
控制方向推断
延迟/相关性估计
SceneContract Draft
人工确认和冻结
```

### Phase 2：声明式 PhysicsSpec Runtime

实现：

```text
PhysicsSpec parser
safe expression AST
单位检查
稳定性检查
单调性约束
Generic provider compiler
```

### Phase 3：自动实验设计

实现：

```text
safe_small_step planner
control mirror 自动创建
响应等待计算
单变量纪律
DAQ 复测和回退
```

### Phase 4：Hybrid AML 编排

实现：

```text
physics_calibration job
hybrid_residual job
uncertainty_calibration job
artifact packaging
model lineage
```

### Phase 5：Hybrid MPC Runtime

实现：

```text
Physics + ONNX residual rollout
UQ/OOD 推理
全轨迹约束
precise_search
RecommendationCertificate
```

### Phase 6：Shadow 与在线模型管理

实现：

```text
shadow runner
prediction vs actual drift
自动触发重训
provider compatibility
SceneContract compatibility
```

### Phase 7：FEM/ROM Sidecar

先支持：

```text
离线求解 → ROM/ONNX
```

再支持：

```text
SolverJob → sidecar → 结果入库 → calibration/training
```

### Phase 8：多场景验收

至少验收：

1. 注塑默认 Provider；
2. 外部热过程 Provider；
3. 一个自动 PhysicsSpec 场景；
4. 一个纯历史数据辨识场景；
5. 一个 ROM/FEM 场景；
6. Provider 热加载中存在活动 Trial；
7. Provider 失败回滚；
8. SceneContract 不兼容拒绝；
9. 模型 hash 不一致拒绝在线控制。

---

## 13. 最终验收目标

用户创建一个新场景时，系统必须支持：

```text
1. 用户输入场景提示词；
2. 绑定该场景 DAQ/DCW 节点；
3. Agent 自动生成节点语义报告；
4. Agent 生成 SceneContract Draft；
5. 用户确认并冻结 SceneContract；
6. Agent 生成 PhysicsSpec；
7. 平台校验单位、稳定性、单调性和边界；
8. 系统自动设计 safe_small_step 探索；
9. 自动创建 Control Mirror；
10. 自动构建隔离数据集；
11. 自动执行物理参数校准；
12. 自动训练有界残差；
13. 自动校准 UQ/OOD；
14. 自动生成完整 ModelLineage；
15. Twin Gate 不通过时只继续探索；
16. Twin Gate 通过后自动进入 Shadow；
17. Shadow 通过后生成 recommendation-only MPC；
18. HITL/SafetyCase 通过后才能受治理写入；
19. 真实 DAQ 反馈触发后续增量训练；
20. Provider 热加载不影响正在运行的旧模型和 Trial。
```

---

## 14. 当前明确采用的默认判断

本设计不再要求用户为每个新场景手写 Provider 代码。

默认路径是：

```text
Agent → SceneContract Draft → PhysicsSpec → Generic Provider → AML 校准/残差 → Twin Gate → Shadow → MPC
```

只有以下情况才进入插件代码路径：

```text
PhysicsSpec DSL 无法表达复杂 PDE/外部求解器/特殊算法
```

此时：

```text
Agent 生成 Provider Plugin
  → 静态接口检查
  → 沙箱 Replay
  → health check
  → 人工批准
  → hot load generation
```

这套设计既保留了自动化，也避免 Agent 凭空生成不可审计的工业物理代码。
