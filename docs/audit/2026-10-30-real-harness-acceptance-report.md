# 真实 harness 全链路功能验收报告（2026-10-30）

> **事后审计更正（2026-10-31）**：下方原始验收摘要中的 R2.1 与 R4.2 解释不受原始证据支持，原“24/24”只表示 runner 的 24 条断言均返回 pass，不代表每条断言的判据有效。原始记录显示 R2 task 为 `CANCELED`，交付数字与 DAQ 查询结果不匹配；R4.2 的记录为 PV=199.45℃、SP=200.5℃。因此 R2 查询成功不计，R4.2 只作为一次模拟器观测保留。R3/R4 写入路径仍是单次、脚本批准的仿真演示，不代表人工审批效果或工艺优化收益。请以本更正、原始 JSON 及 `docs/audit/reports/2026-10-31-latest-experiment-review/report.md` 为准。

> 原执行配置：LM Studio `qwen3.5-9b-64k`，OMP harness；模拟器预检为 already-up，未由该轮启动。以下内容保留为审计历史，凡与上述更正冲突之处均已标注或作废。

## 一、结论矩阵(五能力 × HITL × 真实性)

| 能力 | 断言 | 结论 | 关键证据(本轮实测值) |
| --- | --- | --- | --- |
| 数采 | R2.1 LLM 任务真实抓数 | ❌ 不计 | task=`CANCELED`;交付值 `[37,120,260,120,260,195,53,195]` 与真值 204.35℃ 不符。runner 从完整 history 抽取任意数值，判据无效；查询成功未验证 |
| 数控(治理写) | R4.1 调优真实下发 | ✅ | 模型 `optimization_explore` → 设备寄存器 SP 198→**200.5**(=基线+2.5,精确落点) |
| 数控(工艺响应) | R4.2 PV 观测 | ⚠️ 有限记录 | 原始 JSON: PV=199.45℃, SP=200.5℃(差 1.05℃);单次样本,不支持过程改善或收敛结论 |
| 数控(HITL) | R3.1–R3.3 审批链 | ✅ | manual 绑定下:审批卡 `ap-d0e53cb2` 挂起,**批准前 SP=195 不变** → REST 批准 → **SP=198(=195+3)** → 任务收口 |
| 治理台账 | R4.3/R4.4 | ✅ | `dcw_journal` 含 Agent 归因;优化记录 R4 期间新开窗(R4 前 0 → R4 后 2) |
| AML | R5.1 训练面 | ✅ | `chtpl-aml-training-default` 频道 `aml_model_find` 可查询(空清单合法) |
| 求解器 | R5.2/R5.3 | ✅ | 优化频道 `optimizer_capabilities` 可用;`optimizer_solve` 无合格 Profile 被资格门拒(负向断言) |
| 本体 | R6.1/R6.2 | ✅ | `my_industrial_nodes` 注入工艺描述("加热区1设定"+℃ 量纲);`line_context` 产线语义可读(绑定谱系扩权) |
| 环境与工具面 | R0.1–R1.4 | ✅ | 隔离实例 3423(全新 home 首注册 admin)+隔离模拟器 4038;aml_optimization 频道;10 工具收窄面全在册 |

## 二、佐证套件(本轮复跑)

| 套件 | 结果 | 证据 |
| --- | --- | --- |
| 本体离线服务层 `e2e-ontology.mjs` | **57/57,0 失败** | 终行 ONTOLOGY E2E: 57/57 passed |
| 绑定方式×真实协议 `e2e-binding-modes-real.mjs` | **PASS(19/19)** | `docs/audit/evidence/2026-10-29-binding-modes/report.json`(本轮刷新) |
| MES 镜像数采+真模型抓数 `e2e-mes-mirror-real.mjs` | **PASS(17/17)**(含 Q1 真模型抓数/Q2 可读结论) | `docs/audit/evidence/2026-10-29-mes-mirror/report.json`(本轮刷新) |

## 三、过程中抓到并修复的环境/工程事实(对系统设计的含义)

1. **开放工具面会撑爆 9B+64k**:81 工具注入 ≈78k tokens(`OMP_LLM_ERROR n_keep:77925>=n_ctx:65536`)。
   收窄到 10 工具后模型正常出活。**对大上下文小模型,Channel 工具面宽度是上下文预算的一等公民**——
   建议后续把「工具面 token 预算」做进注入层的显式告警。
2. **冷库引导**:安全批后 register 默认关闭,`needsSetup=true` 时首注册仍开放——隔离实例自举走
   setup-status→register 路径(与 bench pipeline 同款)。
3. **9B 非确定性**:同一任务文一轮通过一轮跑偏(幻觉 `recipe_id` 参数)。验收用「指令显式到参数级 +
   至多两次派发」容差,不降低真实性断言(设备侧落点照旧硬判)。
4. HITL 挂起→批准的写拦截与生效:设备双时点对照(批准前 195/批准后 198)证明**审批是真实闸门**,
   不是回包样式。

## 四、未覆盖面(如实声明)

- `optimizer_solve` **正向**求解(需 AML 训练→资格门→Profile 绑定全链):由 `e2e-optimizer-live.mjs`
  (104 断言,含 Channel×求解器×Twin×HITL×MCP)覆盖,本轮未重跑。
- AML 全训练链(数据集→作业→门禁→自动投用):由 `e2e-model-loop-live.mjs`(54 断言)覆盖,本轮未重跑。
- 本体真机 UI 六 tab 与求解器集成:由 `e2e-ontology-live.mjs`(87 断言)覆盖,本轮以离线 57/57 + 语义注入断言替代。
- Mimosa 安全扫描未完成,不宣称安全;本报告只裁决功能面。

## 五、一句话结论

**本次 OMP/Qwen 模拟运行记录了一次脚本批准前后的设定值变化，以及一次后续受限探索写入；R2 数采断言已判定为无效，PV 观测不构成优化结果。runner 的 24/24 仅为原始断言计数，不能作为整体成功结论。**
