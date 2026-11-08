# 上线前终验报告（2026-11-08 · 全 PR 合并后）

> 前置：生产审计 → 阶段 0/1 优化 PR 全部合并 → 重建 → 重启 :4001 到新 main 后执行本终验。

## 一、已合并的优化 PR（本批次）

| PR | 内容 | 验收 |
|---|---|---|
| #97 | **P0-1** one-shot 家族 6 引擎构造崩溃修复 + restore 逐 channel 兜底 + **全 14 引擎构造契约测试** | 契约 16/16 · unit 1252/1250/0 |
| #98 | **P0-2** 产线节点禁静默默认 mock 驱动 + Project leaderHarness 去默认 | 契约 3/3 · unit 1255/1253/0 |
| #99 | activate 装配 deadline(30s) + 引擎装配失败指标 | typecheck ✔ · unit 全绿 |
| #100 | settings watcher 监听生效配置目录 + CLI 文案诚实化 | typecheck ✔ · unit 全绿 |
| #101 | 生产部署 runbook（上线清单/env pin/轮换/升级/恢复演练/故障速查） | 文档 |

**未在本批次实施（如实）**：P4 迁移前置快照、P6 成果提交窗口重构。理由：两者改状态机/启动早期路径，需配套 live 回归窗口；已在 runbook 与计划中列为下一步，其中 P6 的影响在本报告 §四 有实测规避方式。

## 二、终验 A：产线场景（全新行业域 + 第三种协议 MQTT）

**文档**：[BRG-5 轴承装配线工况说明](inputs/bearing-line.md)（5 点位，MQTT，振动 ≤45 dB(A)，两期推进）

| 阶段 | 结果 |
|---|---|
| 模拟 PLC 协议（MQTT 孪生） | `sim-twin 2/2`（brg5-cell 5 信号，tick 活性 ✓）——补齐 Modbus/OPC UA/MQTT 三协议全栈 |
| 连接与供给 | `10/10`（线 ln-7bda9583 + 1 写控 + 3 数采 + 配方 + 开批 + 总控） |
| 频道锻造 | 诊断 5/5 + 调优 7/7 |
| **产线验收 verify-line** | **12/12 全绿**（含 MQTT 特异面，见下） |

**MQTT 协议特异发现（已按 skill 正确处理）**
1. **写控无回读能力** → 首次 V3 失败（readback 缺失）；按 skill 用 `ackMode:"transport-ack"` + `observeDaqId`（独立数采观测）后通过：`ack=transport-ack DAQ观测=10.503`
2. **单设备多 SP 在 MQTT 下合并为一个 cmd topic**（`aw/twin/brg5-cell/set` + `jsonKey=setpoint`）→ export 只导出 1 个 SP；本次以单 SP 规避，多 SP MQTT 设备需按 topic 细化配置（已记录为模拟器/schema 限制）
3. 私有 broker 端口必须显式 `MQTT_BROKER_PORT`（否则撞共享 18830）

## 三、终验 B：Project 通用开发场景（记账软件）

**项目**：`be5fbcb1`（记账软件开发）— **58/58 断言全绿，状态 completed**

| 期 | 内容 | 真实产物 |
|---|---|---|
| W1 需求规格 | 需求频道，实例 lead 收口 | [SPEC.md](artifacts/ledger-app/SPEC.md)（三功能 + 数据格式 + 验收口径） |
| W2 源码实现 | 开发频道 | [ledger.py](artifacts/ledger-app/ledger.py)（**真实可执行**：`python ledger.py summary` 输出 balance） |
| W3 自动化测试 | 测试频道 | [test_ledger.py](artifacts/ledger-app/test_ledger.py) + [TEST-REPORT.md](artifacts/ledger-app/TEST-REPORT.md)（**真实执行 PASS**） |

治理链全绿：三频道依赖链 W1→W2→W3（technical 路由）、plan 审批、每期 L1 技术评审 + L2 签核 → approved、项目 completed + 5 类审计事件齐备、三交付物 approved、产物 4 件齐备。

**P2 负面用例实证**：`POST /projects` 缺 `leaderHarness` → **400**（去默认生效，不再静默 mock）。

**如实口径**：编排骨架为 mock leader；**源码由驱动经真实文件写入产生**（非 LLM 自主编码），并由真实 `python` 执行验证——本验证明的是「Project 通用开发任务链 + 交付物 + 验收」能跑通，不是「LLM 能自主写代码」。

## 四、本轮暴露并规避的问题

| 问题 | 处置 |
|---|---|
| mock lead 会拆子任务，root 收口需先取消+supersede（既有引擎约束） | 驱动内置收口链（cancel → 自派替代 → supersede → 收替代 → 收 root），两期均通过 |
| （审计指控5）实例释放后 lead 无法提交成果 | 本验走 owner REST 提交（integrator 路径）+ 独立 admin L1/L2；P6 计划根治 |
| 实例重启后旧 channel 残留 idle lead 行 | 不影响验收（新项目独立频道） |

## 五、结论

- **产线域**：三协议（Modbus TCP / OPC UA / MQTT）全部打通，V1-V6 验收全绿
- **通用业务域**：Project 依赖链 + 真实可运行交付物 + 双账号验收链全绿
- **上线阻断项 P0-1/P0-2 已修复并有契约测试闸门**；P1 的 activate/watcher 已修，runbook 落地
- **剩余待办（不阻断本次验收）**：P4 迁移快照、P6 成果提交窗口、插件宿主版本回滚、限流（代理层）

**判定：本批次可上线（CONDITIONAL-GO 的阶段 0 已闭环）**；P4/P6 与阶段 2 项按 runbook 与计划继续收敛。
