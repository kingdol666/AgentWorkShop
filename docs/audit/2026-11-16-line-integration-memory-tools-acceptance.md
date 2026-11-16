# 产线集成专项验收：数据获取 / 参数下发 / 记忆复用 / 工具选择

> 日期：2026-11-16 01:08–01:25  
> 环境：隔离 `AW_MODE=home`，`AW_HOME=D:/tmp/aw-doc-real-20261115/home`；平台 `:3997`；
> 模拟器独立影子树 `:4050`（未连共享 `:4010`）；执行模型 omp + `ustc/deepseek-flash`。  
> 代码：`main@9ab6b110`（本轮未改代码，只做实测与证据归档）。  
> 边界：**全部为模拟五协议产线**；本轮只做“够用级”经验复用与单步下发，
> 不做严格闭环、不做物理 HIL、不宣称真实产线验收。

---

## 0. 结论

本轮针对“产线集成功能”做了 6 组真实作业，结论如下：

| 能力 | 判定 | 关键证据 |
|---|---|---|
| 数据获取（DAQ） | **通过** | 9/9 节点有实时样本/帧；Agent `daq_query` 与直连库一致（克重 32.619 vs 32.621，熔体压力 60.801 vs 60.756） |
| 参数下发（DCW） | **通过** | Agent 自主选 `recipe_propose` 而非直写；62→63MPa，HITL `ap-eac80792` 批准，回读 63，批次 `rr-086cd32a`，journal `anc-dbe63519` |
| 越界保护 | **通过** | 写 999MPa → `400 NODE_RANGE_EXCEEDED`（节点量程 45~85） |
| Channel 记忆复用 | **通过** | 自动注入命中首步增益；`search_memory` 取回两条完整结论；任务取消历史可召回 |
| 跨频道结果复用 | **通过** | 频道 B 的 lead 用 `search_other_teams_memory` 取回频道 A 的两条实测结论 |
| 结果沉淀 | **通过** | Agent 在只读取数后把 62MPa 运行点写入 Channel 公共记忆，随后被跨频道检索到 |
| 工具选择 | **通过** | 只读任务选 `line_context + search_memory + daq_query`；向量帧选 `daq_frames`；写控选 `recipe_propose`；未越权直写 |
| 产线/产品上下文 | **通过** | `line_context` 返回产品 `pd-d02dc5ca`、配方 `rc-605df683`、活动批次、逐参数窗口与 PLC 当前值 |
| 产品级经验（product scope） | **未实测** | 本 home 无 product-bound session、无 validated product-scope 经验；line 域候选经验按设计不可见 |

**总判定：满足“不需要很严格闭环，但经验/研究结果与 Channel 记忆可复用、数据能取、参数能按对的方式下发”的当前要求。**
不满足/未证明的是：物理 HIL、生产级写入、严格多步闭环、产品级经验复用、任意文档全自动接入。

---

## 1. 环境与被测对象

- 平台 `:3997`，`/api/health`：`workshop=ready`、`daq.degraded=false`、`tsdbOnline=true`、`mqttOnline=true`。
- 模拟器 `:4050`：6 设备 / 19 信号 / 五协议（Modbus TCP、Modbus RTU、MQTT、OPC UA、HTTP）。
- 产线：`ln-0eb8f9fa`「精密注塑克重闭环验证线-20261115」，运行中，活动批次 `rr-7f2322ea`。
- 产品：`pd-d02dc5ca`「PP 家电面板」；配方：`rc-605df683`「注塑克重基线配方」v1（5 参数）。
- 频道 A：`4a8b542b-d014-4aa5-bdea-bbeefc001ced`（`production_line_integrated`，4 成员，lead `88165f86`）。
- 频道 B：`144bca76-fb62-4255-b45e-965a124bcf2d`（同线、同 owner，lead `05a13691`）。
- 9 个 DAQ：熔体压力、制品克重、模温、缺陷率、视觉置信度、平均壁厚、飞边、节拍、厚度轮廓。
- 5 个 DCW：保压压力、保压时间、料温、冷却流量、复检保压压力。

---

## 2. 数据获取

### 2.1 直连 API（9/9）

`daq-direct.json`：9 个节点在 5 分钟窗口内均有实时数据；8 个标量节点有 `samples`，
厚度轮廓节点有 `frames`。代表性值：

| 节点 | 驱动 | 最新值/帧 | 说明 |
|---|---|---|---|
| 熔体压力PV `dn-1698f09b` | Modbus TCP | 60.76 MPa | 活动批次内 |
| 制品克重PV `dn-49f96bc3` | Modbus TCP | 32.62 g | 目标 32.50±0.35 |
| 模具温度PV `dn-2281ff0b` | Modbus RTU | 55.7 ℃ | 窗口内 |
| 缺陷率PV `dn-35bfdda0` | MQTT | 0.395 % | ≤0.5% |
| 视觉置信度PV `dn-1d9fa9f8` | MQTT | 95.9 % | — |
| 平均壁厚PV `dn-df394b13` | OPC UA | 0.5209 mm | — |
| 飞边PV `dn-ad6789f1` | HTTP | 0.259 % | ≤0.4% |
| 节拍PV `dn-ceecf902` | HTTP | 22.51 s | — |
| 厚度轮廓PV `dn-1408dbc3` | HTTP | 64 点 vector 帧 | 原始仿真 48 点，平台模板归一化 64 点，见 §6.1 |

### 2.2 Agent 取数（`daq_query`）

频道 A lead 收到“取最近 5 分钟克重/熔体压力”的只读任务后，自主调用
`line_context + search_memory + daq_query`，回报：

- 制品克重：均值 **32.619 g**，最小 32.606，最大 32.624，最新 32.624，原始样本 **89**；
- 熔体压力：均值 **60.801 MPa**，最小 60.743，最大 60.825，原始样本 **90**；
- 与直连 API 同时窗结果一致（32.621 / 60.756 量级），库内滞后 0~2s。

该任务**没有触发任何 DCW 写入**：journal 在 01:09–01:12 无新增锚点。

### 2.3 向量帧工具选择（`daq_frames`）

频道 A lead 在“厚度轮廓是向量帧，请用正确工具取 1 帧”的任务中：
- 明确选择 `daq_frames`（而非标量 `daq_query`）；
- 取到 01:21:08 帧，**实际 64 点**，首点 0.527 mm、末点 0.510 mm，avg=0.5196、max=0.5320；
- 主动指出“任务/语义写 48 点，但平台帧是 64 点”，未按 48 点虚报。
  该发现属实，见 §6.1。

### 2.4 下发后的数据响应（轻量闭环证据）

01:18:45 保压压力 62→63MPa 后：

| 时间窗 | 熔体压力均值 | 制品克重均值 |
|---|---|---|
| 01:15–01:18（写前） | 60.80 MPa | 32.62 g |
| 01:19–01:20（写后） | **61.73 MPa** | **32.71 g** |

说明 DAQ 能观察到下发后的物理响应，链路方向正确；本轮只做单步，不据此宣称闭环达标。

---

## 3. 参数下发

### 3.1 Agent 自主选择的路径

任务：只做一次最小步长写控。Agent 的选择与结果：

1. `line_context` 确认：保压压力SP 配方目标 50MPa、**PLC 当前 62MPa**、窗口 45~85MPa、单步上限 2MPa；
2. 选择 `recipe_propose`（不是 `dcw_write` 直写），提交单参数方案
   「保压压力SP +1MPa 最小步长写控验证（62→63MPa）」；
3. `basis` 引用本轮实测（克重 32.62g、熔体压力 60.81MPa、跟随约 98%）；
   `exp_ref` 引用频道共享记忆「保压压力增益系数 +2MPa→+0.16g（0.08 g/MPa）」；
4. HITL 审批单 `ap-eac80792` 进入 pending，人工批准（`choice=0`）后下发；
5. 结果：批次 `rr-086cd32a`，ACK `readback-verified` 1/1，**设备回读 63MPa**；
   journal `anc-dbe63519`：`dw-aed0ca16 62→63, source=agent, actor=lead, approvalId=ap-eac80792`。

### 3.2 越界保护

对同一节点写 `999`：

```json
{"code":"NODE_RANGE_EXCEEDED","message":"设定值 999MPa 超出上限 节点工艺安全量程 的 85MPa ……"}
```

HTTP 400，未产生写入锚点。说明“量程 ∩ 配方窗口 ∩ 单步限幅”的治理层仍在生效。

### 3.3 本轮未做的写控

- 未做 `recipe_update` 固化（62MPa 仍是 trial；换批/重启回落 50MPa，Agent 已在回复中主动提示）；
- 未做多步闭环、未做回退演练、未做真实 PLC 写入。

---

## 4. Channel 记忆与结果复用

### 4.1 频道内自动注入（不调工具）

任务要求“不要调用任何工具，仅根据本回合自动注入的记忆回答”。Agent 的回复：

- 首步 +2MPa：完整给出 31.21→31.37g、+0.16g、0.08 g/MPa、runId、时间；
- 62MPa 运行点：只看到标题/摘要，明确回答“关键数值/斜率/时间上下文中未提供”，**没有编造**。

结论：L0/L1 自动注入能把“线索级”结论带进 harness；受 `memory.inject_total=500` token 预算影响，
较长条目会被截断。需要完整数值时应由 Agent 调 `search_memory`（L2），这与当前设计一致。

### 4.2 显式 `search_memory`（频道内）

同一频道内检索“保压压力 增益 克重”，命中两条团队记忆：
1. 「注塑克重基线配方保压压力增益系数(+2MPa→+0.16g)」；
2. 「62MPa 运行点实测与未固化风险」（Agent 01:11 自己沉淀的新结果）。

### 4.3 任务结果复用（episodic）

检索“克重闭环首轮巡检 取消”，Agent 返回：
- 任务 `f0b24783` 终态 **CANCELED**；
- 事件 `lead.cancel` / `root.canceled`，原因“调度回合被中止（external cancel），任务自动收口”；
- 当时进度 0%，未产出结论；需要继续时重新派发。

说明“任务结果/失败原因”也进入了 Channel 记忆并可被后续作业复用，而不是只存成功结论。

### 4.4 跨频道复用（`search_other_teams_memory`）

频道 B lead 检索“保压压力 增益 克重”，命中频道 A 的两条实质结论：
- +2MPa 首步：50→52MPa、31.21→31.37g、+0.16g、0.08 g/MPa、runId `rr-d57e6325`；
- 62MPa 运行点：32.62g、+10MPa→+1.25g、斜率 0.125 g/MPa、trial 未固化风险。

同时，频道 B 的 `search_memory(scope="line")` 返回**未命中**：本频道 line 域只有 1 条
`candidate`、`outcome=negative` 的候选经验，按设计 `candidate` 不进入跨频道结果集。
这是一个**正确的负例**：经验必须先经评审/证据门晋级，才可跨频道复用。

### 4.5 结果写回

01:11:14，频道 A lead 在只读取数后调用 `save_memory`，写入
「62MPa 运行点实测与未固化风险」：32.606~32.624g、熔体压力 60.74~60.83MPa、飞边 0.26%、
缺陷率 0.39~0.40%、模温 55.5℃、节拍 22.5s，以及 +10MPa→+1.25g 的对照结论。
该条随后被频道 B 跨频道检索到，证明“作业结果→Channel 记忆→其他 harness 复用”闭环成立。

### 4.6 产品级经验（product scope）边界

- `line_context` 能返回产品 `pd-d02dc5ca`、配方、活动批次与参数窗口，Agent 已用于判断；
- `search_memory(scope="product")` 的代码路径存在，但本 home：
  - 没有 product-bound session（`channel_product_bindings` 为空）；
  - 没有 validated 的 product-scope 经验；
  - 因此本轮**没有正向实测**产品级经验复用。
- 若要把“产品研究结果”作为一等上下文复用，需要：建立 product-bound session → 产出经验 →
  合并 ≥2 个独立任务证据 → 人工晋级 validated；当前环境不具备这些数据。

---

## 5. 工具选择评测

| 任务 | Agent 实际选择 | 结果 |
|---|---|---|
| 产线态势 + 记忆 + 取数 | `line_context` → `search_memory` → `daq_query`（另 `recipe_versions`、`save_memory`） | 全部取到真实内容；无设备写入 |
| 禁止调工具，只凭注入记忆 | 未调用工具 | 首步结论完整；62MPa 条目如实说“上下文没有数值” |
| 向量帧取数 | `daq_frames`（未误用 `daq_query`） | 取到 64 点帧，并指出 48/64 口径差异 |
| 参数下发 | `recipe_propose`（未用直写） | HITL 批准后 62→63，回读 63 |
| 历史任务结果 | `search_memory` | 召回 CANCELED 任务及取消原因 |
| 跨频道结果 | `search_other_teams_memory` | 取回频道 A 两条结论；line 候选经验正确不可见 |

**评价**：在本轮产线集成场景里，Agent 能按上下文选对工具，且在被明确要求“不要调工具”时遵守指令；
在“只读”任务中没有发生设备写入。唯一需要说明的是：Agent 把“只读”理解为“不写设备”，
仍按系统提示把可复用结论写入了 Channel 记忆；如果验收要求“零持久化”，任务措辞需显式禁止 `save_memory`。

---

## 6. 发现与建议

### 6.1 P2：向量帧点数口径不一致（48 vs 64）

- 模拟器原始 HTTP 返回 `points.length=48`（`sim-vector-config.json` 的 hook code 明确 `length: 48`）；
- 平台节点 `templateRef=daq-thickness-scan` 命中内置模板 `thickness-scan`，其 sink 处理器为
  `resample n=64`，因此入库/查询帧为 **64 点**（`vector-frame-direct.json` 三条帧均 64 点）；
- 但节点 `semantics` 与工况文档写的是“48 点 vector”，导致 Agent 在验收时发现口径冲突。

**影响**：数据本身没丢（48→64 线性重采样），但语义/文档与平台实际帧长不一致，做轮廓特征、
点位标签或与设备原始点位对齐时会错位。  
**建议**：二选一——把节点语义改为“64 点（原始 48 点，平台归一化）”，或把模板
`vector.points`/`sink.resample.n`/`driverConfig.resamplePoints` 配成 48。修改后在 `verify-line` 增加
“帧长与语义一致”断言。

### 6.2 P3：自动注入的记忆是“线索级”，长条目会截断

`memory.inject_total=500` token 下，第二条 62MPa 记忆只保留标题/摘要；Agent 如实回答“没有数值”。
这对“指导作业”够用（Agent 可再调 `search_memory`），但如果希望首回合就带全关键数值：
- 在保存记忆时把关键数字放进标题/首句；
- 或适度提高 `inject_total`/`primer_tokens`；
- 或在任务提示中明确“先 search_memory 再回答”。

### 6.3 P3：“只读”语义需在任务里写清

本轮“只读”任务中 Agent 仍写入了 Channel 记忆（这是系统提示鼓励的行为）。
建议验收任务统一写：“不下发参数、不改设备；允许/禁止记忆沉淀”二选一，避免口径争议。

### 6.4 既有 P1：seed task 冷启动

上一轮已记录的“新频道 seed task 在 omp 冷启动下 >3.5min `SUBMITTED`，最终被 D1 CANCELED”
本轮未复测；本次全部通过**直接向频道 lead 发消息**执行，未依赖 seed task 自动派发。
该编排缺口仍在，属于产线集成之外的可靠性问题。

---

## 7. 最终判定

- **可以用于**：模拟五协议产线上的数据获取、只读诊断、Channel/跨频道经验复用、
  上下文驱动的工具选择、HITL 治理下的单步参数下发与回读验证。
- **不能宣称**：物理 HIL/真实 PLC 验收；严格多步闭环；产品级经验复用已验证；
  任意文档全自动接入；无人值守自动派发无延迟。
- **落地建议**：先修正向量帧语义口径；把“任务结果必须沉淀到 Channel 记忆（含关键数值）”
  作为作业纪律；需要产品级复用时建立 product-bound session 并走经验晋级门；
  物理上线前仍按 `aw-line-onboarding` 阶段 7 做真实预检与只读浸泡。

---

## 8. 证据索引

| 证据 | 文件 |
|---|---|
| 平台健康 | `docs/audit/evidence/2026-11-16-line-integration-memory-tools/platform-health*.json` |
| DAQ 直连 9 节点 | `daq-direct.json` |
| 向量帧原始/平台帧 | `sim-vector-config.json`、`vector-frame-direct.json` |
| 频道 A/B 消息全文 | `messages-channel-a-final.json`、`messages-channel-b-final.json` |
| Channel 记忆 | `memories-channel-a.json`、`memories-channel-b.json`、`experience-stats-channel-a.json` |
| HITL | `hitl-history-final.json`、`hitl-history.json` |
| DCW journal / 回读 | `journal-final.json`、`readback-dw-aed0ca16.json` |
| 越界拒绝 | `negative-range.json` |
| 下发后 DAQ 响应 | `daq-post-write-part-weight.json`、`daq-post-write-melt-pressure.json` |
| 产线/节点聚合快照 | `dcw-aggregate.json`、`channels.json` |
