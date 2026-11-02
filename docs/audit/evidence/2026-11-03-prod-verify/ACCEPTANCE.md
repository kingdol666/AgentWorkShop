# 生产就绪复验 · 实机作业演示(2026-11-03)

> 目的:在**不改动系统代码**的前提下,复跑上一轮全部改动的验证,并从**产线文档**出发做一次完整实机作业:
> 文档 → 节点供给 → Channel 作业 → 数采/数控 → DoE 推理优化下发 → 数据与本体持续学习。
>
> 设备层边界:**PLC 模拟器孪生**(modbus-tcp / modbus-rtu / opcua / mqtt / http 五协议真实驱动),
> 不是物理产线;平台侧治理、写咽喉、判读、台账、证据链均为真实运行。

## 0. 环境

| 项 | 值 |
|---|---|
| 平台 | 隔离实例 `AW_HOME=D:/tmp/aw-verify-1103`,端口 3970,由当前工作树 `npm run build` 产物启动(v0.9.2) |
| 治理档 | 生产档(未设 `AW_BENCH_MODE`):60s 在线写间隔、单步限幅、四层写入限界全开(单步限幅作用于 manual/agent 写;**配方整包下发按设计豁免步限**) |
| 孪生 | 仓库内 `plc-node-simulator`,6 设备 / 13 信号 / 5 协议;动力学严格取 FL-7 手册 §5 |
| 产线文档 | `docs/protocol/2026-11-02-filling-line-FL7-protocol-manual.md`(94 行,厂家合同:端点/点位/量程/配方/判据/割接) |
| 目标 | J1 灌装量入带 `|PV−500| ≤ 4 mL`(即 496–504) |

## 1. 静态门禁(全绿)

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run test:unit` | 994 项 / **992 通过 / 0 失败 / 2 跳过** | `unit-tests.log` |
| `npm run lint` | 0 | `lint.log` |
| `npm run typecheck` | 通过 | `typecheck.log` |
| `npm run docs:check` | 89 / 0 | `docs-check.log` |
| `npm run test:skills` | 146 / 0 | `skills.log` |
| `npm run build` | 通过(Total size 23.8 MB / gzip 5.83 MB) | `build.log` |
| `npm run test:e2e-scientific` | **21 / 0**(基准模式 `AW_BENCH_MODE=1`;验证平台链路与治理语义,不作生产治理档证据) | `fullchain.log` |

## 2. 产线文档 → 节点(A:可接入)

| 验收 | 结果 | 证据 |
|---|---|---|
| A1 文档提取 13 点位 / 5 协议 / 量程与步长 | 13 点(4 DCW + 9 DAQ) | `fl7-provision-config.json` |
| A2 逐驱动连通预检 | **13 / 13 PASS**(modbus-tcp×4 / modbus-rtu×1 / opcua×3 / mqtt×4 / http×1) | `test-connection.log` |
| A3 供给建线 + 建点 + 配方 + 开线 | **32 / 32 PASS**(幂等复跑,reused=true;同一脚本首跑观测 19 项检查全过,未单独归档) | `provision-line.log` |
| A4 接入验收 verify-line V1–V6 | **21 / 21 PASS** | `verify-line.log` |
| A5 数采真实落库 | 9/9 节点有样本;向量点归档 **100 帧 / 每帧 64 点**(16 原始点经模板 resample) | `verify-line.log`、`vector-frames.json` |

产线/资源:`ln-73d9e4b2`(4#灌装产线 FL-7-1103 验证)· 配方 `rc-32f18402` · 批次 `rr-1bbf3dda`。

## 3. 数采 / 数控(B:控得住)

| 验收 | 结果 |
|---|---|
| B1 配方整包下发(4 参数) | 4/4 `readback-verified`(36 / 2.6 / 28 / 1.8 bar 基线) |
| B2 越界写拒绝 | 4/4 节点 `max+10%` 被拒(节点安全量程层) |
| B3 合法写回读 | 4/4 一致(S3 `4.14→4.30` 回读 4.30;S2 `36→38` 回读 38;S4 `28→29` 回读 29;S1 MQTT transport-ack + P9 确认点观测 1.80) |
| B4 取数/写控/批次打标 | 样本带 `run/product/recipe` 三元组;任务交付中按批次过滤读取 |

## 4. Channel 作业(C:有人管)

| 验收 | 结果 |
|---|---|
| C1 频道实例化 | `25c8edcf-78f5-4bab-bad2-baba8290b4b6`,4 成员(生产主管/数据分析师/知识调优/工艺工程师),绑定产线 + 5 条节点/配方授权 |
| C2 宽任务(判读+工况对照) | 代理执行 166 事件后被监督器中止,任务停留 WORKING(见缺陷 P4),人工取消收口 |
| C3 快照式任务(数据判读) | **COMPLETED 100%**,交付:均值 **503.28 mL**、min 502.98、max 503.63、极差 0.65、样本滞后 1s、**判定入带**;时间窗 01:32–01:37、批次 `rr-1bbf3dda`、活动配方一致 |

## 5. 推理优化下发闭环(D:控得好)

### 5.1 DoE(真实线,HITL 单卡)

| 验收 | 结果 |
|---|---|
| D1 真实线计划待批准 | `awaiting_approval`(tier=`real_hitl`) |
| D2 成本前置核算 | 3 步 × 61s ≈ 0.05h(含真实线 60s 下限) |
| D3 未批准执行被拒 | `EXPERIMENT_APPROVAL_REQUIRED` |
| D4 随机化执行 | **done 3/3,201s**;水平 2.6 / 2.7 / 2.8 bar(步限 0.2 内) |
| D5 判读回填台账 | 3 行:`underpowered`, `identifiable_effect`, `identifiable_effect`;效应 −0.032 / −0.398 / +1.095 mL(MDE 2.00 / 0.39 / 0.56) |
| D6 判定回灌本体证据 | **3 条**(`dw-e12e28de->dn-969587e0`,observed×2 + observed_weak×1) |
| D7 增益估计 | 全步中位数 **3.98 mL/bar**(报告 JSON);仅取两步可辨识效应的均值 **4.73**(推导值,非日志);手册真值 6.0 |

**步限联锁实证(负结果)**:首次计划水平 `2.6/2.8/3.0`,随机首步 `2.6→3.0` 变化 0.4 bar 被拒
(执行响应返回,未落盘);为留证又建同型计划复现,`4.14→2.8` 变化 **1.34 bar** 被拒,
错误文案已归档(`step-limit-guard.json`):「本次变化 1.3399999999999999bar 超过单步限制 0.2bar」。
计划判 failed、0 步执行 —— 安全联锁正确;但也暴露计划创建期未预检步限可达性(缺陷 P2)。

### 5.2 由实测增益反算并下发

| 验收 | 结果 |
|---|---|
| D8 目标 SP 在工艺窗内 | **4.14 bar**(≤ 手册工艺建议 4.2) |
| D9 配方版本化更新 + 整包下发 | v4;4/4 `readback-verified` |
| D10 灌装量入带 | **503.23 mL ∈ [496, 504]**(稳态末 6 桶均值,`final-state.json`;验收脚本 30s 观测点 497.5 为过渡值,同样在带内;基线 494.3 → +8.93 mL) |

## 6. 持续学习(E:越用越准)

| 验收 | 结果 |
|---|---|
| E1 本体建模与发布 | `ont-fl7-1103` v1(实体 2 / 关系 1 / 绑定 2),compile + publish 通过 |
| E2 干预判定回灌本体证据 | 3 条 `source_type=intervention`,source_ref = 干预 id(可追溯、幂等) |
| E3 Agent 消费台账 | 代理工具轨迹读取 `intervention_history`,按台账而非单点差分复盘 |
| E4 数据→模型训练链 | 全链验收 21/21:F1 打标取数 / F2 v2 数据集+G6 动作覆盖 / F3 G6 正反例 / F4 ARX 训练+注册(nrmse 0.0017)/ F5 阶跃增益 0.976 vs 真值 1 / F6 DoE+HITL+判读+证据 / F7 模型×本体互审阻断 |

## 7. 本轮发现的问题(未改代码,如实立案)

| ID | 级别 | 问题 | 影响 |
|---|---|---|---|
| P1 | **提交阻断(由本提交消除)** | 提交树 `e21a4824` 的 `schema.ts` 缺少 `intervention_events` 建表 DDL;该表只在工作树中 | 干净检出运行写控/DoE 会因缺表失败。本提交把 DDL 与 2026-11-01 未提交修复一并入库;复验跑的是工作树,提交后 `git show HEAD` 已含建表 |
| P2 | P1 | DoE 计划创建期只校验量程/归属,不校验**步限可达性**;真实线 3 水平跨度大于单步限幅时,首步才被拒 | 浪费一次批准与产线窗口;建议创建期按 `stepLimit` 校验相邻水平或自动分段爬坡(复现证据 `step-limit-guard.json`) |
| P3 | P2 | 向量 DAQ 节点一次解析失败后,后续帧成功入库仍**不清 `lastError`**(实测 100 帧正常入库、`lastError` 仍保留旧的“帧点列非法”);`state=warn` 则是模板 `thickness-scan` 的 avg 警告带(0.47–0.57)对 0.999 的正确判定,不是缺陷 | 健康面误导(数据实际正常);`ingestFrame` 缺 `lastError`/遥测回写(见 `vector-frames.json`) |
| P4 | P1 | Agent 回合被监督器中止(`supervise external cancel`)后,任务停留在 `WORKING`,无自动失败/重试;本轮在 deadline 前人工取消 | 需人工取消;长任务闭环率受损 |
| P5 | 说明 | 0.1 bar 小步 DoE 的增益估计 3.98 vs 真值 6.0(欠功效步被计入中位数) | 引擎已把该步判为 `underpowered`;消费方应过滤非可辨识步;最终仍在带内但偏上沿 |

## 8. 判定

- **采集 → 下发 → 判读 → 台账 → 证据**:五段全链在真实平台 + 真实协议驱动 + 生产治理档下跑通(21/21 接入验收、DoE 3/3、证据 3 条、入带)。
- **从抓到 → 控住 → 控得好**:基线 494.3 mL(带外)→ 实测增益反算 → 配方 v4 整包下发 → 503.3 mL(带内)。
- **可上线性**:**受控试点 GO**;**无人值守 NO-GO** —— 需先修 P2/P3/P4,并把设备层从孪生割接到物理 PLC(六步割接见手册 §7)。
- 本轮的“不改代码”指**复验期间未修改任何产品源码**;演示运行的是工作树(含 2026-11-01 未提交的 R-1/R-2/P3-4 修复),不是 `v0.9.2` 标签。这些修复与 DDL 随本提交(`d935004f`)入库,**main 从此自洽**。
- **发布标签遗留**:已推送的 `v0.9.2` 标签仍指向旧提交 `e21a4824`(该提交的源码缺 `intervention_events` 建表)。标签是已发布的不可变标记,本轮不做 force-move;下一次发布(建议 `v0.9.3`)应从 main 切标签。npm 上的 `agentworkshop@0.9.2` 产物由含 DDL 的工作树构建,不受影响。

## 9. 复现

```bash
# 1) 构建 + 隔离实例
npm run build
AW_MODE=home AW_HOME=D:/tmp/aw-verify-1103 NUXT_SESSION_PASSWORD=... PORT=3970 node .output/server/index.mjs
# 2) 孪生(6 设备 5 协议)
node scripts/onboarding/sim-twin.mjs --blueprint docs/audit/evidence/2026-11-03-prod-verify/fl7-twin-blueprint.json --sim-port 4055
# 3) 接入(文档 → 节点)
AW_BASE=http://127.0.0.1:3970 node scripts/onboarding/test-connection.mjs <conn-tests.json>
AW_BASE=http://127.0.0.1:3970 node scripts/onboarding/provision-line.mjs <provision-config.json>
AW_BASE=http://127.0.0.1:3970 node scripts/onboarding/verify-line.mjs <verify-line.json>
# 4) 作业与优化:见 fl7-optimization.log / channel-and-plans.json
```
