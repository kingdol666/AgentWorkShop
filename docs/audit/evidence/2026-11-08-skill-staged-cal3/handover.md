# Gate C · 交接声明 —— CAL-3 四期递进优化（2026-11-08）

> **审查修订版 v2**：初版验收（72/72）被独立审查代理 **REJECTED**（裁决见 [reviewer-verdict-REJECTED.md](reviewer-verdict-REJECTED.md)，指控全部成立）。本版为按审查意见修复后的修正口径；修复过程见文末「审查发现与修复对照」。

## 输入文档（本轮全新撰写）
- [产线工况说明](inputs/连续退火炉工况说明.md)：3# 连续退火炉 CAL-3，9 点位，四期推进要求（分析→HITL→训练→自主优化）
- [协议接口文档](inputs/协议接口文档.md)：加热炉主控 Modbus TCP（HR/IR 寄存器映射）+ 在线质量仪 OPC UA（ns=2 节点映射）

## 三门 ask 记录（如实）
| 门 | 状态 | 说明 |
| --- | --- | --- |
| Gate A 意图澄清 | 采用默认并记录 | ①质量仪按卷出值→采样周期（实现 2000ms，文档建议 5s——**偏差已披露**）②decimals 0.1 ③四期全纳入本期 ④组一个 Project 串四期依赖链 ⑤炉温/带速首绑 manual；控制频道 lead 持写控（项目内治理写收敛面），优化频道 dcw 切 auto（`confirm:true` 走过安全闸） |
| Gate B 蓝图审签 | 采用默认并记录 | 五清单：节点表 9 点/双协议；模拟方案影子 :4036；频道清单 4 个；Project 四期链；治理档位逐期放宽 |
| Gate C 投用裁决 | 本声明 | 全部为模拟孪生测试线，**未投用**；投用由产线负责人裁决（附复核清单） |

## 落袋 id
| 资源 | id |
| --- | --- |
| 孪生设备 | `cal3-furnace`（modbus-tcp :37562，6 信号）· `cal3-qm`（opcua :37544，3 信号）——影子树 `D:\codes\ABO\plc-node-simulator-twin-4036` |
| 产线 | `ln-30b8559a`（3#连续退火炉-DOC2PROJ） |
| 写控（SP） | `dw-89a663be` 一区温度SP（700~850℃，step 10）· `dw-5d362ec7` 二区温度SP（同）· `dw-93f4c44d` 带速SP（60~120，step 5） |
| 数采（PV） | `dn-a52fee22`/`dn-1ae3ed4f`/`dn-a241f628`（Modbus，2s）；`dn-5bf0fbec` 抗拉强度（300~600MPa）· `dn-76587308` 延伸率 · `dn-86eac63d` 表面缺陷数（OPC UA） |
| 配方 | `rc-b786aaac` CAL-3 基线（780/800/90），**`opIntervalMs=300000`（文档「两次调整 ≥5min」已配置为平台强制频控）** |
| 频道 | `7d34db4b` 诊断（line-doctor）· `2dc67884` 控制（tuning/hitl）· `d24f1cfa` 训练（aml_training）· `c2b1bdbf` 优化（aml_optimization 探索） |
| 自定义数采模板 | `ct-25a8246b` / `ct-8165d12b` / `ct-d6666942` |

## 四期能力面（工具面实测，tool-surfaces.json）
| 期 | profile | 工具数 | 写面工具 | 治理 |
| --- | --- | --- | --- | --- |
| W1 分析 | line-doctor | 43 | **无** | 物理零写；结论=真实统计（Pearson r 实算） |
| W2 控制 | legacy(tuning) | 96 | recipe_trial/update/apply | 绑定 manual→HITL 逐动作 + 项目 write_intent；**opIntervalMs=300000 平台强制** |
| W3 训练 | aml_training | 102 | 无 | 数据集构建（**本轮零设备写：只做 run close，不做 line.start**） |
| W4 自主优化 | aml_optimization | 86 | 仅 optimization_explore | 有界步长+可辨识性闸，无审批产生（队列/审批数/台账三面佐证）；**距上次调整 ≥300s 由驱动显式执行** |

## 无缝衔接（虚拟 → 真实）
- **机制**：`driverConfig`（端点）与治理字段（min/max/stepLimit/holdIntervalMs）分开存储，绑定/配方引用节点 id。
- **本轮 diff 证据**（[cutover-diff.json](cutover-diff.json)）：before=供给期快照、after=现值，9 节点中 6 个 Modbus 节点 **仅 driverConfig 变化（port 37542→37562）、治理字段零改动**（程序化断言 governanceViolations=0）；3 个 OPC UA 节点未动（如实）。
- **局限（审查指出，必须知道）**：模拟器**自动分配寄存器**（holding 40001+i×2）与 OPC UA NodeId（`cal3-qm.*-pv`），**与协议文档的 HR 40100/IR 30100、`CAL3-QM.*` 不一致** → 真机割接不是只换端口，必须按文档寄存器表/NodeId 逐点 PATCH driverConfig 的 register/registerType/endpoint。「无缝」指治理面（限界/绑定/配方/审批链）零改动，**不是免配置**。
- 生产割接仍按六步（预检→只读浸泡≥30min→单点三方对照→PATCH→verify 重跑→割接清单+投用裁决）。

## 回退路径（按 id 逆序）
1. 项目已 completed；历史同名 Project 保留审计
2. 删四频道 → 删配方 rc-b786aaac → 删节点 dw×3/dn×6 → 删线 ln-30b8559a
3. 杀 :4036 影子进程树 + 删 `D:\codes\ABO\plc-node-simulator-twin-4036`
4. 删自定义模板 ×3；`dcw.rollback_stale_ms` 已恢复默认 1800000

## 投用复核清单
- [ ] Gate A/B 默认选择追认（本声明表）
- [ ] 工艺约束复核：炉温 ≤10℃/步、带速 ≤5m/min/步已入节点；**两次调整 ≥5min 已入配方 opIntervalMs（平台强制，本轮实测生效）**；二区≥一区、出口<650 禁提速两条**平台未内建**，需人工规程或后续规则扩展
- [ ] driverConfig 指向孪生——直连真机前按割接六步 + 寄存器表逐点 PATCH
- [ ] 优化频道 dcw 绑定 auto 档位需产线负责人接受；否则切回 manual（W4 亦挂 HITL）
- [ ] W4 当前为「探索档有界激励」（模型绑定前阶段）；模型化自主需 W3 数据集→训练→模型绑定后自动升级（平台 modelBackedToolPolicy）
- [ ] 同一 admin 拥有并批准 write_intent（owner 职责内）；L1/L2 由独立账号 B 完成

## 审查发现与修复对照（REJECTED → 修正）
| # | 审查发现 | 修复 |
| --- | --- | --- |
| 1 | W3 的 line.start 实际下发 780/800/90（设备写），0.3s 内回退 W2 治理值 | W3 改为只做 run close（账务）；新增断言「设备值保持治理值」；治理值靠保写心跳维持 |
| 2 | 数据集非「治理后」：W2 批次被丢、窗口早于治理写 | 窗口覆盖治理时刻；治理后数据在场断言（治理后窗均值）；去重熔断时 force 重建 |
| 3 | ≥300s 未实现（60s 在线闸/实测 ~120s 节拍/W2→W4 仅 138s） | 配方 `opIntervalMs=300000` 平台强制 + W4 前显式等待 ≥300s（日志可查）+ 初版交接「节拍同值」错误声明撤回 |
| 4 | W1 分析空壳（结论硬编码、conclusions 空） | W1 改为真实统计：daq 序列 Pearson r + 均值/σ 实算入结论与台账 |
| 5 | W4「自主」叙述过度（无模型/goal 空/方向硬编码/判读 unassessed） | 口径改为「探索档有界激励（模型绑定前阶段，非模型驱动）」；settle 60s；无审批改三面佐证（队列+审批数+台账）；Δ 精确断言 |
| 6 | invoke() 不查 HTTP 状态（401/500 静默通过） | invoke 校验 res.ok + content-type，失败即 isError |
| 7 | finish() 早退仍写"全绿"假象 | 增加 expected/complete 标志，早退记 complete=false 且退出码 1 |
| 8 | 卡片批准可能命中陈旧卡 | 时间窗过滤（发起时刻起）；nodeId 形态按动作区分（recipe: 前缀 vs 节点 id） |
| 9 | W2-t4 ±3 容差把回退值当生效 | 收紧为 =目标±1.0 且低于试验前 |
| 10 | 残留 `dcw.rollback_stale_ms=60000` 未恢复 | 已 PATCH 回 1800000（盘面核verified） |
| 11 | 割接证据不足（无 before/diff） | cutover-diff.json：before/after 逐字段 diff，程序化断言治理零改动 |
| 12 | tool-surfaces 手写不完整 | 如实标注「手写枚举，非生成器」；W2 写面按 PROJECT_GATED_WRITE_TOOL_NAMES 全集口径注释 |

**未修复/已知残留**（如实）：①W4 仍非模型驱动（模型化自主需训练→绑定模型，平台 modelBackedToolPolicy 会自动启用 trial/bayes——本轮未走到）；②W3 执行者是基础频道 lead（AML 档位频道级、实例不继承的平台缺口）；③质量仪采样 2000ms vs 文档 5s；④二区≥一区等工艺规则未内建。
