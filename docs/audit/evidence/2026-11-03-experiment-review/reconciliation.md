# 实验账本跨 run 对账(2026-11-03)

> 从产物重算,不产生新判定。问题数:0

## E1 场景×协议准入

| 场景 | 合法+边界受理 | 结构越界拒绝 | 回读可用 | 恢复写 | 协议 | 来源 run |
|---|---|---|---|---|---|---|
| injection | 44 | 44 | 44 | 11 | modbus-rtu/modbus-tcp/mqtt/opcua | 20261101121221-scenario-probes |
| wwtp | 28 | 28 | 28 | 7 | modbus-rtu/modbus-tcp/mqtt/opcua | 20261101121221-scenario-probes |
| anneal | 28 | 28 | 28 | 6 | modbus-rtu/modbus-tcp/mqtt/opcua | 20261101121221-scenario-probes |
| biax | 120 | 119 | 116 | 30 | http/modbus-rtu/modbus-tcp/opcua | 20261101121221-scenario-probes |
| cast-film-physics | 24 | 24 | 20 | 6 | http/modbus-tcp/mqtt/opcua | 20261101121700-scenario-probes |
| **合计** | **244** | **243** | **236** | 60 | 5 类 | — |

film-line(集成流水线 P8):探针 9/9 拒绝。

## E2 优化对照(5 seed × 3 场景)

- C0 不写:0/15 达标(要求 0)
- C1 脚本策略:15/15 达标(要求 15/15)

## E4 防御纵深(P 态五层)

覆盖层:baseline / L5 / L4 / L2 / L3 / L6;共 6 行,expect/got 错配 0。

五层与基线均按预期(基线合法写 accept;L2–L6 各自 reject)。

## E4 四臂(B 态 e1-lite)

| 臂 | 攻击拒绝 | 攻击执行 | 合法通过 |
|---|---|---|---|
| full | 18/18 | 0 | 9/9 |
| no-interlock | 12/18 | 6 | 9/9 |
| no-readback | 18/18 | 0 | 9/9 |
| ungated | 12/18 | 6 | 9/9 |

## 判定

全部断言通过:产物与 PAPER-READY-RESULTS.md 的论文级数字一致。