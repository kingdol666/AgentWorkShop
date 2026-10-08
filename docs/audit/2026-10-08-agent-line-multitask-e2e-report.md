# Agent 集成产线 · 多协议多场景多任务端到端大考报告(2026-10-08)

> 目标:完整 e2e 验证 Agent 集成产线的全部作业能力 —— 多协议、多场景、多种任务目标。
> 全部套件在本机生产模式(3001)实机执行;最终一轮四套件全绿。

## 最终验收结果(同一环境连续执行)

| 套件 | 结果 | 覆盖 |
|---|---|---|
| 专项加固 e2e(`tmp-e2e/hardening-ack-gate.mjs`) | **34/34** | ACK 三级鉴定(mock 升级/断链 error/在线 unverified warn)、HITL 线级总闸拦截与解除、定向通知、hold 模式 |
| Agent 产线多任务 e2e(`tmp-e2e/agent-line-multitask-e2e.mjs`,新增) | **23/23** | 见下"六类任务" |
| 一键基准 PIPELINE(`benchmark-20261008135743`) | **93/93** | S0 预检+自愈 → S1 API 矩阵 53 断言 → S2 五协议族+MES 双模 → S3 治理负路径 → S4 闭环优化(HITL→下发→ACK 鉴定→三方核验)→ S5 微调(频控/回退)→ S6 诊断(870 样本,规格内 88.9%)→ S7 报告 |
| docs:check | **91/91** | 文档一致性 |

## 六类任务目标(Agent 工具桥直调,全程人工裁决模拟真实审批)

1. **T1 闭环优化作业**:`line_context` → `daq_query` 观测(镜像克重)→ `recipe_propose` 五要素提案 → HITL 批准(choice=0)→ **1/1 设备证实** → runId 回访锚 → 镜像复测。
2. **T2 产线微调作业**:`recipe_update` 固化新版本(审批)→ `recipe_apply` 整批下发(审批)→ **6/6 设备证实**(modbus×5 + mes-rest 直取混合)。
3. **T3 回退作业**:`recipe_versions` → `recipe_rollback(dispatch=true)` → 定义回退+PLC 整批恢复 **5/5 设备证实**。
4. **T4 数据分析作业**:`daq_export` 全窗宽表导出 + `ops_log` 审计自查(作业留痕全可读)+ `recipe_log` 变更史。
5. **T5 多协议读面**:Agent `daq_query` 绑定双通道 + REST 协议族矩阵 **modbus-tcp/rtu、opcua、mqtt、http 五族全在采**。
6. **T6 治理负路径**:未绑定配方被拒;**60s 下发间隔频控早拒**(挂卡之前,治理顺序正确);越界参数预检剔除(批准必被拒包不可达)。
7. **T7 收尾(自愈腿)**:`recipe_update`+`recipe_apply` 恢复基准锚(63bar)与参数面完整性(补回 mesDirect)→ **6/6 设备证实**。

## 本轮实测发现并修复的问题(全部有 timeline/审计留痕)

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 多任务 e2e 结构化提案批准被收敛为拒绝 | fail-closed 铁律:多方案批准未带 choice 按拒绝(设计正确) | e2e 裁决补 `choice:0` |
| 2 | 回合挂起等审批被"运行时停止"收敛 | 空闲巡检(~150s)卸载无任务 worker,连人一起把挂起审批按拒绝收敛(fail-closed 正确,但真人慢审批会被误伤) | e2e 模拟 Agent 按指引重提;**记 P2:空闲巡检应把 pending-HITL 回合视为活跃** |
| 3 | 回退后 mes_fetch"无权访问"、整批 6/6→5/5 | `rollback(to_last_good)` 把配方**整体替换为旧版参数集**,晚于该版本加入的 mesDirect 参数被剪除 | 多任务 T7 + PIPELINE S0 双自愈(补参数+锚复位,配方路下发);语义记录:回退是"整个版本回退"而非逐参数合并(既有设计,使用需知) |
| 4 | PIPELINE S4"提案批准并整批下发"失败(summary 空) | 提案在**挂卡之前**被 60s 间隔锚早拒(上一套件下发的锚),管线的重试只覆盖"有卡后被节拍拦"路径 | S4 无卡路径复用同一治理等待语义(`propPromiseSettled` 探针 + `请等待约?Xs` 解析) |
| 5 | S6 规格内占比一度跌至 30-53% | T3 大阶跃激励(45→63)扰动模拟器物理状态场,平衡点未再收敛(权重列出现 0 值采样) | 按既有手册重启 PLC 模拟器复位(seed 42);S6 回升至 88.9% 并随收敛继续上行 |
| 6 | hardening e2e 一次 respond 60s 超时 | 服务器瞬态停顿(模拟器重启后全节点重连风暴),复跑即过 | 无代码改动;确认属已知负载边界 |

## 遗留(已记录)

- **P2**:空闲巡检对 pending-HITL 回合的豁免(生产化真人审批场景);
- MES 模拟器取数窗口偶发空返回(复跑即过,已知瞬态);
- S6 规格内占比断言依赖工艺已收敛 —— 大阶跃激励类套件之后需要 settle 时间(已在 T7/S0 自愈中缓解)。

## 产物

- `docs/benchmarks/benchmark-20261008135743/`(93/93,report.md + benchmark.json + timeline.jsonl)
- `tmp-e2e/agent-line-multitask-e2e.mjs`(常驻回归资产,与 hardening/PIPELINE 构成三件套)
- 执行环境:v0.7.57 @ 3001 生产模式,PLC :4010 / MES :15060 实机模拟器
