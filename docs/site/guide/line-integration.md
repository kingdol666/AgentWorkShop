# 产线集成：从蓝图到受治理作业

> 本页描述当前主干的产线集成路径。它可以在隔离模拟环境中跑通协议栈、数据获取、经验复用和受治理单步下发；它**不等同于物理 HIL 或生产线投用批准**。

## 适用边界

产线集成把以下对象接成一条可审计链路：

```text
工况文档 → 人工审签 blueprint → PLC 模拟孪生 → export driverConfig
         → 产线/DAQ/DCW/产品/配方 → integrated Channel
         → line_context / DAQ / 记忆经验 → recipe_propose + HITL
         → 设备回读 / DAQ 响应 / journal
```

- 文档到 blueprint 仍需要助手或工程师提炼、澄清和审签；平台不会把任意 PDF、P&ID 或扫描件自动变成可投用配置。
- 推荐先用 `aw-plc-sim-twin` 做虚拟预演，再用 `aw-line-onboarding` 接入平台。
- 模拟协议栈能证明配置、驱动、治理和数据管线的行为；它不能证明真实 PLC 的电气安全、急停、寄存器量纲或工艺物理保真。
- 当前主干的专项证据见 [`docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md)（模拟器验收，不是物理 HIL）。

## Channel 模式与 Session

### Channel 模式

- `generic` 是纯协作频道；它可以聊天、使用被授予的通用工具，但不会因为填写了 `lineId` 就自动获得工业上下文或经验作用域。
- `production_line_integrated` 是产线作业频道；它要求明确的产线绑定，才能使用 `line_context`、产线 DAQ 只读面、工业记忆/经验作用域和受治理写控路径。
- 写权限仍由节点绑定、配方绑定、产线 grant、control policy 和服务端工具 gate 共同决定；频道模式不会提升任何已有权限。

### Product-bound Session

集成 Session 创建时应传入产品：

```http
POST /api/workshop/channels/<channelId>/sessions
Content-Type: application/json

{"productId":"pd-...","title":"批次分析 A","memoryPolicy":"session"}
```

服务端会冻结并验证 line/product/recipe/node/agent binding 快照以及 revision/hash。之后 Channel 的可变选择器不能把该 Session 引到另一条线、另一产品或另一配方。`generic` Session 不会因为传入 `productId` 获得产线工具权限。

## 数据与工具顺序

动手前先读上下文，再按数据形态选择工具：

1. `line_context`：确认产线状态、活动批次、产品、配方目标、PLC 当前回读、窗口和可见节点。
2. `search_memory`：查询当前会话、频道共享记忆和受信任的经验线索；需要跨频道时使用 `search_other_teams_memory`。
3. `daq_query`：查询标量历史/实时样本，默认按活动批次过滤，并返回统计、单位、语义和滞后。
4. `daq_frames`：查询 vector/image 帧；不要把帧节点误当作标量 `daq_query`。
5. `recipe_propose`：提交结构化配方候选；该工具始终创建人工审批卡，不得绕过它调用直写。
6. HITL：`recipe_propose` 必须由有资格的人审批/拒绝；其他写动作按有效产线、Channel、绑定模式及适用的全局 recipe-dispatch 设置决定是否需审批。`line_start` / `line_stop` 始终需要 HITL。
7. 回读与复测：核对设备回读、写 journal 和下发后的 DAQ 响应，再决定是否继续。

越界、节点/配方不属于当前 scope、无授权或没有合适回读时，正确结果是拒绝或 `inconclusive`，不是把链路受理当作设备生效。

## 记忆与经验复用

| 层 | 用途 | 可见性 |
|---|---|---|
| `session` | 当前 Session 的上下文与任务历史 | 当前会话 |
| `private` | Agent 自己的个人记忆 | 当前 Agent/频道授权面 |
| `shared` | Channel 团队记忆与任务编年史 | 当前 Channel |
| `line` | 绑定产线的经验 | 同 owner 的 integrated Channel；需 active/validated |
| `product` | 产品作用域经验 | 需要可信 product-bound Session；本轮未以正向证据覆盖 |
| `global` | 经过治理的全局经验 | 仅按服务端策略暴露 |

- 自动记忆注入是有限的线索层；长条目可能被 `memory.inject_total` 截断。需要完整数字时，Agent 应用 `search_memory` 主动取全文。
- `candidate` 经验不会作为已验证经验跨 Channel 泄露；晋级需要独立任务证据和人工/治理门。
- “只读”默认表示不改变设备；如果连 Channel 记忆也不能写，任务必须明确禁止 `save_memory`。
- 经验是可复用研究结果，不是物理事实；本次设备回读和当前 DAQ 证据拥有最终否决权。

## 向量帧契约

模拟器和平台模板可能使用不同的点数：模拟端点返回 raw points，平台 sink 可以按模板 `resample` 归一化后入库。当前示例中模拟器 raw 是 48 点，而 `thickness-scan` 模板归一化为 64 点。

交接记录必须同时写明：

- raw 点数与来源端点；
- normalized 点数与模板/sink 配置；
- 轴、点位标签、插值方式和单位；
- Agent 查询使用的实际帧长。

如果点位必须与真实设备逐点对齐，应把模板和 `driverConfig.resamplePoints` 配成明确的合同值，并在验收中断言帧长；不能只凭节点名称或旧语义描述判断。

## 模拟验收与真实割接

隔离模拟验收至少使用：`AW_MODE=home`、全新 `AW_HOME`、独立平台端口、独立 simulator shadow、`simulated=true` 测试线。V2/V3 会产生越界尝试和合法写入，`onboard.mjs --smoke` 可能自动裁决测试 HITL，因此只能对隔离测试线执行。

真实割接不是直接 PATCH 后继续写：

```text
停线 → 保存治理/绑定快照 → 替换 driverConfig endpoint/register
     → 开启新批次（或同步新的 recipe baseline）→ 只读/最小步复验
     → 通过 V1/V3 与三方回读 → 需要时切回原端点并重新开批次
```

旧批次仍活动时换端点，步长和配方基线可能来自旧设备；这是拒绝继续写入的正确保护。真实上线还需要授权维护窗口、只读浸泡、设备/平台/镜像三方对照、急停和物理安全验收。

## 验收证据

建议保留：

- simulator tick 与每个设备的 export；
- provision/forge/verify 的 JSON 与日志；
- DAQ samples/frames（含 line/product/recipe/run 标签）；
- HITL 审批、DCW readback、journal anchor、越界拒绝；
- Channel 消息、记忆检索和跨频道复用结果；
- 报告中的 simulated / physical HIL / production 三种判定分栏。

“测试通过”只表示实际执行的断言通过；外部 IDD/RAG 超时、Mimosa `inconclusive`、产品级经验未覆盖和 seed task 冷启动延迟必须单独列出。

## 相关技能

- [`aw-plc-sim-twin`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-plc-sim-twin)：生成五协议模拟孪生与 export。
- [`aw-protocol-onboarding`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-protocol-onboarding)：协议/异构数据能力匹配和镜像采集。
- [`aw-line-onboarding`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-line-onboarding)：供给、Channel 锻造和 V1–V6。
- [`aw-doc-to-project`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-doc-to-project)：人审蓝图、Channel 编组和 Project 验收。
- [`aw-system-acceptance`](https://github.com/kingdol666/AgentWorkShop/tree/main/skills/aw-system-acceptance)：全系统门禁与边界裁决。
