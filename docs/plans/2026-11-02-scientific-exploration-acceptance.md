# 科学探索闭环 · 验收规范(Scientific Exploration Acceptance Spec)

> 对应计划:[2026-11-02-scientific-exploration-plan.md](./2026-11-02-scientific-exploration-plan.md)(P0–P6)
> 版本:2026-11-02 · 基线分支 `experiment/final-round-20261101`
> 判定口径:**每条标准都有可执行断言**(单测文件/命令/期望值),不采信自报。

## 0. 验收层级

| 层 | 手段 | 通过门槛 |
|---|---|---|
| L1 单元 | `npm run test:unit`(tsx --test tests/*.test.ts) | 0 fail;新增用例全过 |
| L2 服务链路 | 专项验收脚本 `scripts/acceptance-scientific-loop.ts` | 全部断言 PASS 且退出码 0 |
| L3 回归 | lint + 既有 943 用例 | eslint 0 error;既有用例 0 回归 |
| L4 文档 | `npm run docs:build` + 文档一致性脚本 | 构建成功;工具数/设置数/机制描述与代码一致 |
| L5 安全 | Mimosa 扫描 + 人工复核高危 | 0 高危(或已修复并有说明) |

## 1. 验收标准(A 系列)

### P0 事故回放(已验收)

| ID | 断言 | 执行 |
|---|---|---|
| A0-1 | 事故夹具(SP 2.6→2.4、4.71min 振荡、47s 窗、35min 预窗)结构正确 | `tests/identifiability.test.ts` → 夹具形状用例 |
| A0-2 | 引擎对夹具输出 `UNDERPOWERED`,建议窗 ≈ 14.1min(±12s) | 同上 → A1-3 用例 |

### P1 可辨识性引擎(已验收)

| ID | 断言 | 执行 |
|---|---|---|
| A1-1 | 响应窗 <3×主导周期 → UNDERPOWERED 且建议窗=3×周期;充分窗+真阶跃 → IDENTIFIABLE 且 CI 覆盖真值 | `tests/identifiability.test.ts` |
| A1-2 | 控制量与时间 \|r\|>0.9 → CONFOUNDED | 同上 |
| A1-3 | 负结果语义:窗口充分+CI 含 0 → IDENTIFIABLE(!significant),不得判 UNDERPOWERED | 同上 |
| A1-4 | 判据 MDE 罩不住关心效应 → UNDERPOWERED;罩得住不降级 | 同上 |

### P2 干预台账(已验收)

| ID | 断言 | 执行 |
|---|---|---|
| A2-1 | 写咽喉 `recordDcwWriteOps` 成功路径落一行(ack/readback/path/channel 归因);同值 10s 去重不重复落行 | `tests/intervention-ledger.test.ts` |
| A2-2 | verdict 回填/时间窗语义:未收口拦截、建议窗内拦截、收口/过期放行 | 同上 |
| A2-3 | pending/unassessed 不登记本体证据 | `tests/ontology-learning-p6.test.ts` |

### P3 动作覆盖度(本次实施)

| ID | 断言 | 执行 |
|---|---|---|
| A3-1 | 事故同款(2 水平纯阶梯)→ G6 FAIL,reasons 同时含"仅 N 个水平"与"纯阶梯/不可分";ABAB 3 档 → PASS;v1 数据集 → unknown 放行;无控制列 → 不适用放行 | `tests/action-coverage-g6.test.ts` |
| A3-2 | ARX 阶跃仿真增益与解析真值一致(误差 <1e-6,验收线 20%);无耦合→false;未收敛→不判;归一化换算正确 | 同上 |
| A3-3 | 水平×相位矩阵与连续段判据:3 档单调斜坡(每档一段)→ FAIL | 同上 |

### P4 真实线 DoE(本次实施)

| ID | 断言 | 执行 |
|---|---|---|
| A4-1 | 仿真线建计划即 `planned`(既有行为不变);真实线 `awaiting_approval` | `tests/experiment-plan-p4.test.ts` |
| A4-2 | 创建时成本核算含 `3×主导周期` 与真实线 60s 写入间隔下限;未批准执行被拒;批准后 planned | 同上 |
| A4-3 | 步序按 repeats×levels 展开,随机化种子由计划 id 派生(可复现),跨控制量打散;`randomizedOrder=false` 按原序;每步 hypothesis 带 `[pexp:<id>]` | 同上 |
| A4-4 | 告警中止/步数预算/时长预算/写入被拒 → failed 且原因如实,剩余步不执行 | 同上 |
| A4-5 | 每步执行后跑引擎判读并回填台账;有已发布本体时回灌证据(端到端) | `scripts/acceptance-scientific-loop.ts` |

### P5 双通道互审(本次实施)

| ID | 断言 | 执行 |
|---|---|---|
| A5-1 | 冲突矩阵三值:模型有效应 & 本体明确无路径 → 拒;模型无效应 & 本体有路径 → 拒;unknown 不拦;未收敛不参与 | `tests/cross-check-p5.test.ts` |
| A5-2 | UQ 拒收 → auto 拒 / manual 需人审;欠功效/混杂仅告警 | 同上 |
| A5-3 | 科学载荷字段齐全(模型效应/本体路径/可辨识性/MDE/动作覆盖/证据边/可证伪方式)且与审批卡人读行同源 | 同上 |
| A5-4 | 审批载荷经 `requestManualApproval → approvals.request(payload)` 透传 | 同上 |

### P6 本体学习闭环(本次实施)

| ID | 断言 | 执行 |
|---|---|---|
| A6-1 | 有判定干预 → `ontology_evidence` 追加,负结论计 refute、正结论计 support;重复回灌幂等;无本体/未收口不登记 | `tests/ontology-learning-p6.test.ts` |
| A6-2 | 无证据锚因果断言 → anecdotal(中英双语);带 `intv-*/ont-*` 引用不标;非因果不触发 | 同上 |
| A6-3 | 通道 B 三值:有 influences/actuates 边 → true;已发布本体无边 → false;无本体 → null;语义绑定 entity_key 可命中 | 同上 |

### 端到端:正交探索 → 学习 → 本体 → 互审(本次实施)

| ID | 断言 | 执行 |
|---|---|---|
| E2E-1 | 真实线计划:创建→成本→批准→执行,步序正交且台账逐步落行 | `scripts/acceptance-scientific-loop.ts` |
| E2E-2 | 每步判定回填;负结论步骤在本体证据账本计 refute | 同上 |
| E2E-3 | 通道 B 用回灌后的证据得出"明确无耦合"(false),与模型"有效应"冲突 → 自动模式拒绝 | 同上 |
| E2E-4 | 生成正交数据集的 G6 判定通过;事故型数据集 G6 失败 | 同上 |

## 2. 回归红线(不得破坏)

1. 既有单测 943 条 0 失败(允许因新功能新增断言而更新计数,不允许放松语义);
2. `optimization_explore` 拒绝路径恰好 1 次取数、批准路径 2 次(取数经济契约);
3. 仿真线试验计划行为与旧版逐字节一致(G2.11 兼容);
4. `AW_IDENT_GATE=0` 可回退科学门禁;**G6 只对新(v2)数据集生效**;
5. 写咽喉拒绝路径不进干预台账(仍走 `dcw.write.rejected` 审计)。

## 3. 非目标(明确不做)

- 不改训练算法与 G1–G5 语义;
- 不放开无人值守(HITL 全程保留);
- 不做本体自动改版(证据只追加,版本仍走 draft→approve→publish);
- 不在本轮实现 KB 检索侧降权(本轮回溯到"入库审批卡标注 anecdotal + 审计留痕")。
