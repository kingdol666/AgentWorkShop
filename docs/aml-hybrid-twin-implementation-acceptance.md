# AML Hybrid Twin Core Integration 验收记录

- 日期：2026-09-25
- 范围：Core AML Integration；真实 governed DCW/Canary/bounded-auto 未启用
- 首个场景：PLC 模拟器 `injection-line`
- 控制模式：recommendation-only
- 真实 DCW 写入次数：0

## 已实现

- Hybrid Twin Channel 默认模板：`chtpl-hybrid-twin-mpc-default`
- Channel profile：`legacy` / `hybrid_twin`
- SceneContract、PhysicsModelManifest、TwinSnapshot、ObjectiveProfile、VirtualTrial
- 注塑低阶灰箱物理模型
- 物理主干 + PyTorch 有界残差训练协议
- UQ/OOD 与全轨迹硬约束门禁
- safe_small_step / precise_search 服务端策略
- VirtualTrial 与 RecommendationCertificate
- SQLite Hybrid Twin 元数据表和本地 `aml/twins/` 工件
- AgentTeam Twin/MPC 工具按 Hybrid Channel profile 注入
- 持续校准去重和 cooldown 登记
- 训练作业 scene/objective/job-kind lineage

## 验收命令

```text
npm run typecheck
npm run build
npx eslint <本次 AML/Twin 文件集合>
python -m py_compile server/services/workshop/aml/python/amlkit.py server/services/workshop/aml/python/train-hybrid-example.py
npx tsx scripts/acceptance-aml-db.ts
npx tsx scripts/acceptance-aml-hybrid-twin.ts
python scripts/acceptance-hybrid-python.py
node scripts/acceptance-aml-hybrid-live.mjs
```

结果：全部通过。

## Core Hybrid Twin 验收结果

- 训练数据不足：模型状态为 `safe_small_step`
- 模型门禁通过：模式切换为 `precise_search`
- 不安全 VirtualTrial：硬约束拒绝
- 过期 TwinSnapshot：`SNAPSHOT_STALE` 拒绝
- VirtualTrial：`candidateExecuted=false`
- RecommendationCertificate：仅在门禁和收益通过时生成
- 持续校准：首个请求接受，重复请求在 cooldown 内去重拒绝
- 数据库：Hybrid Twin 核心表和默认 Channel 模板存在

## 真实 PLC 模拟器 + AgentTeam 验收

模拟器环境：

```text
HTTP/WS: http://127.0.0.1:4010
MQTT broker: 127.0.0.1:18830
Preset: injection-line
```

闭环报告：

```text
bench/results/20260925043641-1sdc-optloop/
```

结果：

- AgentTeam 任务：`COMPLETED`
- part-weight：`32.60 g`
- 目标：`32.5 ± 0.35 g`
- flash-rate：`0.094%`
- sink-mark：`1.023%`
- 其它守卫：通过
- 最终 hold-pressure：`70.5 bar`
- 录制：timeline、worker stream、setpoints、quality 全部生成
- 真实 DCW 写入：仅发生在 PLC 模拟器链路，未连接真实现场

## 边界和未启用项

以下属于 Governed Control Extension，不在本次 Core AML DoD 内启用：

- WriteGrant 实际消费
- 真实生产 DCW governed write
- Canary
- bounded-auto
- Safe BO
- BOPET/FEM/CAE

Computer Use UI 交互测试曾尝试启动，但当前本机 Computer Use runtime 返回 `系统找不到指定的路径`，因此本次使用真实 PLC simulator HTTP/WS、AgentTeam API 和独立验收脚本完成等价可审计验证；未把 Computer Use 失败伪报为通过。
