# 工况文档 → 模拟 PLC → 通道作业 → 闭环控制 → 割接演练 验收报告

> 日期：2026-11-16  
> 环境：隔离 `AW_MODE=home` + 全新 `AW_HOME=D:/tmp/aw-doc-real-20261115/home`；平台 `:3997`；
> 模拟器独立影子树 `:4050`（未连接共享 4010）；执行模型 omp + `ustc/deepseek-flash`。  
> 被测产物：本轮提交 `28cc6f6c`（基于 `main@d506103d`）的 onboarding 脚本/服务端修复 + 证据报告。
> 边界：**全部设备为五协议模拟器**；割接演练只验证协议端点/寄存器配置切换与治理零改动，
> **不是物理 HIL，不是真实 PLC/产线验收**。Mimosa 未完成完整覆盖前不宣称安全通过。

---

## 0. 结论

**系统设计能够把“工况开发文档 → 模拟 PLC 节点 → 平台连接节点 → 绑定/Channel/工况上下文 →
数采 → 下发控制 → 闭环调优 → 端点割接”串成一条可执行链路。** 本轮在隔离模拟环境中真实跑通：

- 6 个模拟设备 / 19 个信号 / **五协议**（Modbus TCP、Modbus RTU、MQTT、OPC UA、HTTP），
  含 HTTP **48 点 vector 帧**（`vector-response.json`）；
- 平台自动建 1 线、5 DCW + 9 DAQ、1 产品、1 配方；V1–V6 **25/25**；
- 自动锻造 `production_line_integrated` Channel（4 成员），创建时写入工况上下文；
- 一键 onboard + smoke **7/7**；
- 闭环 **8/8**：保压 62→64→66 MPa，克重 32.342→32.483→32.650 g，最终 32.626 g
  （目标 32.50±0.35），2/2 HITL + 设备回读；另有无授权写 403 负例；
- Channel 级写控任务：HITL 批准后设备回读 **52 MPa**，克重 31.21→31.37 g，飞边无恶化；
- 虚拟→真实割接演练 **12/12**：停线→替换 5 个 driverConfig 到第二端点→开新批次→
  V1/V3（3/3 DCW，HITL 批量写）→治理/绑定/插件零改动→切回原端点恢复数采。

**但**：这不是“物理真实产线已验证”。文档→蓝图仍是助手/工程师按 skill 提炼（不是自动 P&ID 视觉解析）；
omp 冷启动下新频道种子任务自动派发出现 >3.5min 滞留；割接必须停/开批次同步步长基线。
这些是落地前必须补齐的工程项。

---

## 1. 系统设计与需求映射

| 用户需求 | 系统机制 | 本轮实测 | 判定 |
|---|---|---|---|
| 根据工况开发文档建模拟 PLC 节点 | `aw-plc-sim-twin` + `sim-twin.mjs` 模式 B | 6 设备/19 信号/五协议；tick 活性 6/6；HTTP vector 48 点 | **满足（文档需助手提炼 blueprint）** |
| 创建平台连接节点 | `provision-line.mjs` + export driverConfig | 14 平台节点全部由 export 生成；无手抄寄存器 | **满足** |
| 节点绑定/产线/配方 | `provision-line` + `forge-channel` | 5 DCW、9 DAQ、配方 5 参数、批次 | **满足** |
| Channel 自动创建 + 工况上下文 | 模板实例化 + `channelMode` + 创建时 `scenarioPrompt` | 新频道 integrated、4 成员、context 1744 字符 | **满足（本轮修复 generic/上下文/线授权）** |
| 数据获取 | 五协议 DAQ + TSDB + 批次打标 | V1 9/9；Channel 任务读到 105 原始点 | **满足** |
| 实时参数下发 | 5 DCW + 四层限界 + 60s + HITL | V2 5/5 越界拒；V3 5/5 回读；Channel 写 52MPa | **满足（模拟）** |
| 闭环控制 | recipe_propose → HITL → 下发 → 回读 → 复测 | 2 步闭环 8/8；克重进入目标窗口 | **满足（模拟）** |
| 虚拟连接带动真实场景 | 协议驱动 + driverConfig 端点/寄存器替换 | 双向切换 12/12；治理/绑定/插件零改动 | **架构满足；物理 HIL 未验证** |
| 自动本体/工况理解 | 模板 + prompt/scene；IDD ontology（上一轮） | 本轮只做结构化上下文注入，未做自动本体发现 | **部分** |
| 数据/经验/物理多维驱动 RSI | RSI/AML/ProcessModel（既有） | 本轮未跑 RSI 训练/晋升；仅闭环调参 | **既有能力，本轮未复测** |

---

## 2. 环境与起点

- 平台：`:3997`，`health.json` 实测 `workshop=ready`、`daq.degraded=false`。
- 模拟器：`D:/tmp/aw-doc-real-20261115/sim-shadow`，`:4050`。
  - **端口偏差**：PRD 原写 4060，但 bench 影子端口映射 `18830+(port-4010)*1000` 在 4060 溢出
    TCP 上限；实际用 4050。影子树独立、未连接共享 4010。
- 工况文档：`work-condition-doc.md`（WC-INJ-2026-1115）；拓扑图 `line-topology.svg`；
  蓝图 `blueprint.json`。
- 文档/蓝图提炼：助手按 skill 纪律提炼（量程/单位/精度/SP-PV/动力学显式），非 PDF/P&ID OCR。
- 一致性修正：`surface-scan`(OPC UA) = 平均壁厚标量；48 点厚度轮廓 vector 在
  `quality-gate`(HTTP)，文档/蓝图/拓扑已统一；所有 PV 均有 base/tau/noise/follows
  （vector 用 code 实现，同时保留 dynamics 元数据）。

---

## 3. 分阶段模拟结果

### 3.1 模拟 PLC 孪生（sim-twin）

- `sim-twin.log`：**7 PASS / 0 FAIL**；6 设备、19 信号；tick 活性 6/6；
- `GET /api/nodes/:id/export` 返回 driverConfig（端口/寄存器/topic/OPC nodeId/HTTP path）；
- `vector-response.json`：HTTP vector 端点 48 点（首点 0.5130）；
- 平台侧未手抄寄存器，provision 直接消费 export。

### 3.2 产线/节点/配方供给

- `provision-line.log`：**33 PASS / 0 FAIL**（复用幂等口径；首次创建 20/20，节点/配方已存在时对齐 33 项）；
- 线 `ln-0eb8f9fa`；产品 `pd-d02dc5ca`；配方 `rc-605df683`（5 参数）；
- 5 DCW：保压压力/保压时间/料温/冷却流量/复检保压；stepLimit 2/0.5/3/1/2；
- 9 DAQ：熔体压力/制品克重/模温/缺陷率/视觉置信度/平均壁厚/飞边/节拍/厚度轮廓；
- 量程/单位/精度/语义均来自文档；`semantics` 通过本轮修复的 provision-line 传递。

### 3.3 Channel 自动创建与上下文

- `forge-v3.log`：**15 PASS / 0 FAIL**；新 Channel `e9fbb32b…` 创建即
  `production_line_integrated`，4 成员，9 条绑定，插件未配置项显式关闭；
- 创建时 `scenarioPrompt` 直接携带工况上下文（目标 32.50±0.35、飞边/缺陷/模温、安全单步/HITL）；
- 线域授权修复并验证：`线域授权[61837060]` + `users=1(owner+members)`；
  旧实现从 agent DTO 取 `userId` 恒空转，已改为 owner + 群成员 userIds；
- **残余**：新频道种子任务自动派发在 omp 冷启动下仍 >3.5min `SUBMITTED`（v3 `402a74b9`），
  最终被 D1 兜底 **CANCELED**，未自动开工；scheduler supervision 停在 `WAITING_FOR_RESULT`。
  直接向频道发消息的任务可执行（见 §3.7）。这是编排可靠性缺口，不是 Channel/绑定失败。

### 3.4 接入验收 V1–V6

`verify-line-4.log`：**25 PASS / 0 FAIL**。

- V1：9/9 DAQ 有真实样本/帧；V2：5/5 越界量程拒绝；V3：5/5 合法写回读一致；
- V4：配方在册，5 参数逐项一致；
- V5：绑线、4 成员、插件隔离（`plugins: []` → 断言 enabled=0）；
- V6：先断言受保护线 `ln-d7e0a2a2` 存在，再比较其 journal 基线；日志
  `受保护线存在=true 本线锚点=67 受保护线新增=0 基线=0`。

### 3.5 一键 onboard + smoke

`onboard-smoke.log`：**7 PASS / 0 FAIL**；smoke `SM-冒烟步` 经 HITL 批准 → recipe_propose →
设备证实（1/1）；治理窗 60s/228s 自动等待重试后成功。

### 3.6 闭环控制

`closed-loop-results.json`：**8/8 PASS**。

| 步 | 保压压力 | 克重 | 写控证据 |
|---|---|---|---|
| 基线 | 62 MPa | 32.313 g | — |
| 1 | 64 MPa | 32.342→32.483 g | `wh-2e64891d` / `rr-017dbbf2` / HITL `ap-08ca5edf` |
| 2 | 66 MPa | 32.483→32.650 g | `wh-b8123b0f` / `rr-99d69371` / HITL `ap-4d0ef3bd` |
| 最终 | 66 MPa | **32.626 g**（32.15–32.85） | — |

说明：50→62 来自此前多轮 smoke/闭环；本轮实际验证 62→66，不是单次 50→66。
另有无授权负例：新建无 grant 用户写 DCW → **403 `LINE_FORBIDDEN`**（
`unauthorized-write.json` 保存 email/status/body）。

### 3.7 Channel 级写控任务

向 Channel lead 发消息（不是后台直调）：

- Agent 按频道上下文复述目标 32.50±0.35 与安全边界；
- `recipe_propose` +2 MPa → HITL `ap-0118a324` 批准；
- 设备回读 **52 MPa**（`wh-bc2efd06`）；克重 31.21→31.37 g；飞边 0.17–0.19%；
- Lead 明确说明：trial 下发未写配方版本，换批/重启回落 50MPa，固化需 `recipe_update`。

### 3.8 虚拟→真实割接演练

`cutover-results.json`：**12/12 PASS**（T9 仅边界声明，不计入断言）。

1. 停线 → 只替换 5 个节点 driverConfig 到 `inj-main-b`（37544）；
2. 治理配置零改动：min/max/step/unit/decimals/hold/line/semantics 全一致；
3. 绑定 18→18、插件 0→0 不变；
4. 第二端点开新批次，新样本克重 31.22g；
5. V3：3/3 DCW 经 **HITL 批量写**（51 / 3.5 / 206）并回读一致，`rr-662d3dd1`；
6. 切回原端点、重开批次，数采恢复。

**重要发现**：旧批次未停时直接换端点，步长基线仍来自旧配方/批次（曾把 52MPa 判成 -14MPa）；
正确割接必须停线→换端点→开新批次（或同步配方基线）。

---

## 4. 设计评价

### 强项

1. **技能边界清楚**：sim-twin 只写模拟器，provision 只读配置/写平台，forge 只做频道编排；
   driverConfig 从 export 取，杜绝手抄寄存器。
2. **协议抽象成立**：同一平台 DAQ/DCW 驱动接五协议；割接只改 endpoint/寄存器，治理面零改动。
3. **治理单点收敛**：写入走 DCW 四层限界 + 60s + HITL + 审计；V2/V3/Channel 写控/割接均有证据。
4. **可观测/可证据**：样本、批次标签、写记录、HITL、结果库都能回读。
5. **闭环链路可用**：Agent 按上下文小步调参，PV 响应方向正确，最终进入窗口。

### 缺口/风险

| 优先级 | 缺口 | 说明 |
|---|---|---|
| P0 | 物理 HIL / 真实 PLC | 全部模拟；真实 ACK/回读/步限/急停/量程未验证。 |
| P1 | 种子任务自动派发延迟 | 新频道 seed task >3.5min SUBMITTED；omp supervision 停在 WAITING。建议缩短监督硬超时/先注入任务简报/不阻塞消息消费。 |
| P1 | 割接运行态基线 | 换端点必须停/开批次或同步配方基线；应写入 skill 阶段 7 硬步骤。 |
| P1 | 文档→蓝图自动化 | 当前是助手提炼 blueprint；无 P&ID/表格自动解析/配图 OCR。 |
| P1 | 物理动力学保真 | 一阶滞后+线性增益为教学灰箱；不能据此下生产结论。 |
| P2 | 自动本体/RSI | 本轮只注入结构化上下文；IDD ontology/RSI 训练/晋升未在本轮复测。 |
| P2 | RAG/IDD 深度集成 | 上一轮已验证检索/结果库；本轮未重复。 |

---

## 5. 门禁（本轮落盘）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `pnpm lint` | PASS（RSI 21 文件 0 设备写） | `gates/lint.log` |
| `pnpm typecheck` | PASS | `gates/typecheck.log` |
| `pnpm test:unit` | **1787/1787** | `gates/unit.log` |
| `pnpm build` | PASS | `gates/build.log` |
| `docs:check` | 87/0 | `gates/docs.log` |
| `test:mcp` | 14/14 | `gates/mcp.log` |
| plugin lifecycle | 22/22 | `gates/plugin.log` |
| skills | 167/167 | `gates/skills.log` |
| 本轮 onboarding | sim-twin 7/7、provision 33/33、forge 15/15、verify 25/25、onboard 7/7、closed-loop 8/8、cutover 12/12 | 同目录日志/JSON |

Mimosa：本轮未重新完成完整扫描；上一轮 deep scan `inconclusive`（47 findings、改动文件
0 命中）。**不宣称安全通过。**

---

## 6. 最终判定

- **可以做**：在模拟五协议产线上，从工况文档/蓝图生成模拟 PLC、接入平台、建线/节点/配方、
  锻造带上下文 integrated Channel、完成数采/越界拒绝/合法写回环/HITL 闭环调参，并通过
  端点/寄存器替换做可逆割接演练。
- **不能宣称**：真实产线 HIL 通过；物理动力学保真；新频道种子任务在 omp 冷启动下无人工
  介入即可自动开工；上传任意文档全自动解析成 blueprint。
- **落地建议**：先在仿真环境做工艺预演和治理演练；物理上线前按 aw-line-onboarding 阶段 7
  做真实预检、只读浸泡、三方对照和首验；把“停线→换端点→开新批次”固化为割接硬步骤；
  把“创建频道时一次写入 scenarioPrompt”保留为默认路径，避免运行时重装。

---

## 7. 证据索引

| 证据 | 路径 |
|---|---|
| 工况文档/拓扑/蓝图 | `docs/audit/evidence/2026-11-15-doc-to-simulated-plc/work-condition-doc.md`、`line-topology.svg`、`blueprint.json` |
| 供给/频道/验收配置 | 同目录 `provision.json`、`forge.json`、`forge-v3.json`、`verify.json`、`onboard.json` |
| sim-twin | 同目录 `sim-twin.log`、`vector-response.json` |
| V1–V6 | 同目录 `verify-line-4.log` |
| onboard+smoke | 同目录 `onboard-smoke.log` |
| 闭环 | 同目录 `closed-loop-results.json`、`closed-loop-3.log` |
| 未授权写负例 | 同目录 `unauthorized-write.json` |
| 割接 | 同目录 `cutover-results.json`、`cutover-6.log` |
| Channel 写控 | 同目录 `channel-write-task.md` |
| 门禁 | 同目录 `gates/*.log` |
| 健康 | 同目录 `health.json` |
