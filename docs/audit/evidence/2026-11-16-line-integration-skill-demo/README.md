# 证据索引：2026-11-16 产线文档 → Skill → 受治理控制优化（模拟）

对应报告：`docs/audit/2026-11-16-line-integration-skill-demo-acceptance.md`

环境：隔离 `AW_MODE=home` + 全新 `AW_HOME`，平台 `:3998`，独立影子模拟器 `:4052`，
五协议模拟器（Modbus TCP/RTU、MQTT、OPC UA、HTTP）。**全部设备为模拟协议栈，不是物理 HIL。**

| 文件 | 内容 |
|---|---|
| `blueprint-4052.json` | 本次模拟孪生蓝图（仅把 `simPort` 改为 4052，信号/动力学来自工况文档） |
| `onboard.json` | 平台接入配置；14 个节点的 `driverConfig` 全部来自模拟器 export |
| `sim-twin.log` | 模拟孪生生成：6 设备 / 19 信号 / tick 6/6（7 PASS） |
| `onboard.log` | 一键接入：供给 20/20、锻造 15/15、V1–V6 25/25、smoke 7/7 |
| `health-final.json` | 验收时平台健康快照 |
| `daq-coverage.json` | 五协议 DAQ 节点在窗口内的样本数与最近值 |
| `samples-dn-ae0a3103.json` | 制品克重 PV 分桶样本（avg/min/max/cnt） |
| `samples-dn-2d350de0.json` | 熔体压力 PV 分桶样本 |
| `vector-frames.json` | 厚度轮廓向量帧：raw 48 → 平台 normalized 64 点 |
| `dcw-reads.json` | 验收时 DCW 回读（54/3.5/208/15；HTTP 复检点不可读） |
| `journal-line.json` | 本次产线 journal 锚点（52→54、54→56 均带 approvalId/runId） |
| `journal-protected.json` | 受保护线 `ln-d7e0a2a2` journal：基线 1 条、无新增 |
| `hitl-history.json` | HITL 审批历史快照 |
| `control-step2.json` | 第二步 54→56 MPa 的提案/审批/回读/克重响应 |
| `channel-summary.json` | Channel 模式（production_line_integrated）与成员 |
| `task-summary.json` | 种子任务与 lead 子任务状态（WAITING / WORKING） |
| `bindings.json` / `recipe.json` | 绑定矩阵与配方定义快照 |
| `gates/*.log` | 本轮 build/lint/typecheck/docs/readme/skills/unit/MCP/plugin/SDK/twin/VitePress 门禁输出 |
| `vendored-rerun/` | 模拟器改为仓库内目录 + pnpm workspace 后的完整复跑：平台 :3999、模拟器 :4054、supply 20/20、forge 15/15、V1–V6 25/25、smoke 7/7（52→54，`rr-87a89bae`） |

边界：模拟器证据，不是物理 HIL；克重未在两步内进入目标窗；seed task 未自主收口；
Mimosa 未完成完整扫描，不宣称安全通过；本轮未发布 npm/GitHub Release。
