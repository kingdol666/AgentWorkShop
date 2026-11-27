# 产线作业文档（无产线 / 有产线双场景）

> 轮次：2026-11-26 最终演示与发版验收  
> 实例：隔离 home `D:/tmp/aw-final-demo-20261126/home`，`AW_MODE=home`，端口 `3090`  
> 模型：LM Link 远程设备 `ZhangHaoZheng` 的 `google/gemma-4-12b`（默认执行模型）；必要时用同一远程设备的 Qwen 做模型热切换验证。**不启动本机模型。**  
> 纪律：模拟孪生只用于协议/治理预演，不是物理 HIL；未执行项如实标注 NOT_RUN。

## 1 作业目标

1. 先做**无产线**协作：Channel → 角色创建 → AgentPrefab 绑定 → harness(oMP) → session 实例化 → Leader 统一调配 worker → 运行期改 model/Prefab 并热重载。
2. 再做**有产线**集成：产线/产品/配方/DAQ/DCW 节点 → Channel 绑线 → 产品集 → session → runtime 绑定节点/配方 → 运行期改会话产品/配方/节点绑定并热重载 → HITL 参数下发 → 设备回读。
3. 闭环参数优化与“根据参数自动学习”：`optimization_explore` 真实写入 → 等待响应窗 → 可辨识性判读 → 干预台账 → 经验反射（candidate）→ 人工晋升/合并 → 工具检索注入。
4. 全程串行，不并发跑模型；单任务保持简单。

## 2 角色与职责

| 角色 | 位置 | 职责 | 治理 |
| --- | --- | --- | --- |
| HITL（人类操作者） | Web UI | 创建/绑定/审批/晋升经验/改运行元数据 | owner/admin |
| 协作组长（lead） | Channel 成员 | 接收任务、拆解、派发 worker、汇总回执 | 只读 + 调度工具 |
| 协作工人（worker） | Channel 成员 | 执行简单文本任务 | 只做被派发任务 |
| 工艺工程师（worker） | 产线 Channel 成员 | 读 DAQ、提配方试验/探索步 | 配方/DCW 绑定 manual |
| 数据分析员（worker） | 产线 Channel 成员 | 只读数采、分析响应 | DAQ 只读绑定 |

## 3 无产线场景（A）

### 3.1 对象

- Workspace：默认工作区（REST 创建频道自动挂载，console 可见）。
- Channel：`A-无产线协作`，`channelMode=generic`。
- 成员：`协作组长`（lead，omp + 远程 Gemma4）、`协作工人`（worker，omp + 远程 Gemma4）。
- AgentPrefab：`远程Gemma4工人`，profile `local / google/gemma-4-12b`，发布不可变 revision。
- Session：`A 无产线会话`，克隆 lead/worker，克隆 id 即 runtime object id。

### 3.2 作业步骤

1. HITL 在 UI 创建 Workspace/Channel（或 REST 创建后 UI 可见）。
2. 创建 Prefab → 发布 r1 → 绑定给 worker。
3. 创建 session；记录 lead/worker clone id。
4. HITL 给 lead 发任务：「把『只回复 NO_LINE_OK』派给协作工人并汇总」。
5. 断言：lead 回执、worker 回执、task 行（parent/assignee）存在。
6. 运行期把 worker 的 model 改为同一 LM Link 的远程 Qwen；下一回合只回复 `QWEN_HOT_OK`；再改回远程 Gemma4 并同时把 Prefab 换成 r2；下一回合只回复 `GEMMA_BACK_OK`。
7. 断言：runtime revision 递增、`effectiveAt=next_turn`、服务端热切换日志、omp JSONL `model_change`、原 session/其他成员不变。

## 4 有产线场景（B）

### 4.1 产线与点位

| 对象 | 值 |
| --- | --- |
| 产线 | `注塑闭环演示线`（模拟孪生，`controlMode=manual`） |
| 熔体温度 SP | DCW，150–200 ℃，stepLimit 5，holdIntervalMs 120000 |
| 熔体温度 PV | DAQ，150–185 ℃，warnLow 158，warnHigh 178，intervalMs 2000 |
| 保压压力 SP | DCW，20–80 MPa，stepLimit 3，holdIntervalMs 120000 |
| 保压压力 PV | DAQ，20–80 MPa，intervalMs 2000 |
| 产品 A / B | 标准件 A / 高强件 B，同属该产线 |
| 配方 A | 熔体温度 180 ℃、保压压力 42 MPa |
| 配方 B | 熔体温度 175 ℃、保压压力 48 MPa |

### 4.2 治理档位

- 产线：`manual`（所有写入需人工批准）。
- Channel：`production_line_integrated`，`executionMode=manual`，`controlPolicy=hitl_governed`。
- 绑定：DAQ 只读；配方/Dcw 首绑 `manual`。
- 配方下发：默认 60s 频控；单步不超过节点/配方 stepLimit；四层限界生效。

### 4.3 作业步骤

1. 创建产线、DCW/DAQ、产品、配方（driverConfig 只取自模拟器 `export`，不手抄寄存器）。
2. 启动数采总控；等待 PV 样本入窗。
3. 用 `aml_optimization` 模板实例化产线 Channel（绑线），把成员 harness 改为 omp + 远程 Gemma4。
4. 绑定产品集 `[A,B]`；创建 session（产品 A，memoryPolicy=shared）。
5. 给 runtime 绑定 DAQ `熔体温度PV` + 配方 A（manual）。
6. **运行期元数据修改**：
   - 加绑 `保压压力PV`（DAQ）→ 下一回合工具可见面生效；再解绑。
   - 新增配方 A2 → 会话范围 PATCH 纳入 A2 → 指纹变化触发下一回合热切换。
   - 会话产品 A→B（配方 B）→ 指纹热切换；再重置回创建快照。
7. **HITL 参数下发**：以 worker 身份调用 `dcw_control`（或 `recipe_trial`），产生 `dcw-approval` 卡；HITL 在浏览器审批；断言 `readback-verified` 且 DAQ PV 跟随。
8. **闭环优化 + 自动学习**：以 worker 身份调用 `optimization_explore`（控制 `熔体温度SP`，目标 `熔体温度PV`，步长 ≤5，settle 45–60s）→ HITL 审批 → 写入 → 响应窗 → 判读 → `intervention_events` 新行 → 经验 candidate。做两次独立探索；HITL 合并/晋升后验证 `search_memory` 命中。
9. 断言：经验 `scope_kind=line`、`outcome/verdict` 与台账一致；晋升前自动注入不命中，晋升并部署后命中；本体证据（若已发布本体）回灌幂等。

## 5 安全与回退

- 模拟孪生端点：`http://127.0.0.1:4034`，Modbus TCP `127.0.0.1:37532`；割接真实设备只替换 driverConfig 端点，语义/限界/绑定不变。
- 任何真实写入前必须停线、保存绑定/治理快照、开新批次或同步配方基线。
- 回退：配方→节点→产线逆序删除；经验回退用 `retired`，不物理删除审计行。
- 不把软件 PASS 当安全认证；不把模拟孪生当物理 HIL。

## 6 验收判据

| # | 判据 |
| --- | --- |
| A1 | Channel/角色/Prefab/omp/session 全部落库，clone id 可枚举 |
| A2 | Leader 真实派发 worker，worker 回执，task 行有 parent/assignee |
| A3 | 运行期 model 热切换与 Prefab 热切换在下一回合生效，其他成员不变 |
| B1 | 产线/节点/产品/配方/绑线/产品集/session 全部落库 |
| B2 | runtime 绑定摘要显示 effective 节点/配方；新增/移除节点与配方改版热重载 |
| B3 | 会话产品 A→B→重置，指纹热切换，不新建会话 |
| B4 | HITL 审批后写入回读一致，PV 跟随 |
| B5 | `optimization_explore` 产生干预台账与经验；人工晋升后可检索注入 |
| C1 | 全门禁绿；发布/推送/同步完成 |
