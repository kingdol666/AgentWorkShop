# 求解器集成使用验收报告(2026-10-23 第三轮)

问题:"求解器是否能够集成使用?具体的使用逻辑和流程是什么?"

## 结论

**可以。求解器已通过四个等价入口(REST / Agent 工具 / MCP / UI)完成端到端集成验证:从建线建模到治理下发 HITL 批准、设备真实写入与回读核验,全旅程 104/104 断言通过;使用逻辑与流程固化为 `docs/audit/2026-10-23-solver-usage-flow.md`,每一步都有对应测试钉住。**

| 套件 | 结果 | 证据 |
|---|---|---|
| 全旅程集成 E2E(隔离实例) | **104/104** | `integration-live.log` / `integration-report.json` |
| 其中:治理下发全链(W0-W9) | **10/10** | 建卡→审批→D13→写入→回读→审计 |
| 其中:MCP 桥(M1-M4) | **4/4** | initialize/tools/list/optimizer_solve optimal |
| UI 运行/建议读面 | **11/11** | `optimizer-ui-report.json` |

## 集成使用逻辑(一段话版)

数据底盘(产线/配方/数采批次)→ 建模发布(规格含 `controlNodeId` → lineage 数据集 → 资格 → 训练 → 模型)→ Profile 发布 + Agent 绑定(**授权面=绑定面**)→ 求解(三入口等价;ProblemIR→OSQP→平台独立复算→建议 verified)→ 互校(crosscheck pass→dual)→ 申请下发(D11 防伪建卡)→ **HITL 人批准(D13 八项重验,失败零写收敛)**→ DCW 整批写入+回读核验(acks)→ executed + 审计。求解全程零设备写入;唯一写入路径是人批准。

## 本轮实测的关键证据

| 断言 | 实测 |
|---|---|
| W1 互校 | `verdict=pass, maxDev=0`(Worker vs typed predictor,≤1e-6) |
| W5 幂等 | 同配方在飞卡二次建卡 → 409 `DISPATCH_RECIPE_IN_FLIGHT` |
| W6 卡面 | 审批面精确返回当前卡,`to` 值与建议首步工程值完全相等(36.9566…) |
| W7 批准 | `execution.acks={verified:1, unverified:0, failed:0, total:1}` |
| W8 写入 | 设备 `readValue=37` = 首步 36.9566 经节点 decimals=1 `toFixed` 量化(测试容差 0.5 为保守值,约 10 倍于分辨率半步;未写入时 |50−36.96|≫0.5 必失败,不掩盖) |
| W9 审计 | ops 日志 `optimizer.dispatch.request` + `optimizer.dispatch.execute` 双落 |
| M3/M4 MCP | `tools/list` 含 optimizer_* 五件套;`tools/call optimizer_solve` → `optimal` |
| U1.12 UI | 浏览器点击「求解一次」→ 运行行 `optimal` + `已验证推荐` 徽章 |
| V2 价值 | 闭环首步驱动真实轨迹,中位质量误差改善 99.7%,MV 恒在工艺窗口 |

## 复现

```bash
AW_KEEP_ALIVE=1 npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-optimizer-live.mjs  # 104/104 + 保留实例
python scripts/ui/optimizer-ui-playwright.py                                                  # 11/11
```

## 说明

- W8 首轮失败为断言容差错(以浮点噪声级校 Quantized 写入);已按节点分辨率校准,属测试修正非产品改动。
- 与上一轮(412 单测/205 UI)互补:上一轮证明"求解器本身正确",本轮证明"系统里用得起来、且写入受治理"。
