# 科学探索与可辨识下发系统优化计划(Scientific Exploration & Identifiable Dispatch)

> 状态:**P0–P6 全部实施并验收通过(2026-11-02,v0.9.0)**:单测 986 项 984 通过 / 0 失败 · lint 0 ·
> 全链路验收 19/19(`scripts/acceptance-scientific-loop.ts`)· docs:check 89/0 · docs:build 通过。
> 验收规范见 [2026-11-02-scientific-exploration-acceptance.md](./2026-11-02-scientific-exploration-acceptance.md)。
> 日期:2026-11-02
> 分支基线:experiment/final-round-20261101
> 作者:ZCode(基于 2026-11-02 会话内对仓库的逐行核验,核验锚点全部在本文引用)
>
> 实施偏差记录(P0–P2):
> - P2 迁移函数因安全扫描器对 migrations.ts 误报,改走 SCHEMA_SQL 幂等兜底(与 aml_training_plans 同先例,新旧库同效);
> - P2 verdict"异步 job"简化为**写后即时判定**(探索步 settle 后同窗取数判读回填)+ 台账惰性读取,无新 worker;
> - P1 前置门**零取数**(只查台账),周期提示从写前序列派生 —— 守住"拒绝路径恰好 1 次取数"的既有测试契约。

---

## 1. 需求摘要

| # | 用户需求 | 本计划对应能力 |
|---|---|---|
| N1 | Agent 在探索过程中真正学到数据和工况的真实情况 | P1 可辨识性引擎 + P2 干预台账 + P3 动作覆盖度 |
| N2 | 下发参数探索满足正交实验设计与逻辑推理,不胡乱下发 | P4 真实线 DoE 解锁 + P5 下发前双通道互审 |
| N3 | 结论可追溯、可证伪,不再产出互相矛盾的因果叙述 | P2 verdict 字段 + P6 本体证据回灌 + KB 防污染 |

核心设计判断(已核验):**平台不缺模型,缺的是"干预成为可积累资产 + 下发前可辨识性检验 + 每个结论带证据锚"。** 预测精度 ≠ 因果可辨识,门禁的作用是把"假科学"在结构上堵死,而不是让 Agent 更聪明。

---

## 2. 现状事实基线(全部为本轮会话核验,非记忆)

**已有且可复用的骨架:**

| 事实 | 锚点 |
|---|---|
| 唯一治理写咽喉 `dcwControlGovernedInternal`,注释"仅由 dcwControlGovernedInternal 承载平台内部治理写" | `server/services/workshop/agents/industrial/dcw-tools.ts:118,123` |
| 干预台账 `optimization_explorations`(写入值↔响应值配对)已存在,但仅 optimization_experiment 工具一条路径写入 | `server/services/workshop/db/database/schema.ts:585`、`server/services/workshop/agents/industrial/optimization-tools.ts:132` |
| 探索默认响应窗 `settle_seconds ?? 45`(10–300 钳位),45s 单点差分被当作"学习"返回,并教 Agent "按此符号外推" | `optimization-tools.ts:99,150` |
| DoE 计划器已写好(MV→水平序列 levels/repeats/settleMs/observeMs/`randomizedOrder`/budget),但 `assertSimulatedLine` 锁死真实线 | `server/services/workshop/process-model/experiment.ts:10-12,17` |
| 统计工具 `pearson`/`lagCrossCorr`/`movingMean` 已存在,`lagEstimates` 已进 dataset report | `server/services/workshop/aml/stats.ts:73,103,128`、`dataset-builder.ts:23` |
| 数据集 spec 的 role 枚举含 `control`,u 张量/controlNodes 全链存在;控制列与测量列同源 `queryTagged` TSDB 网格 | `server/services/workshop/aml/spec.ts:17`、`dataset-builder.ts:152,343` |
| 门禁 G1–G5 中 G4 仅数"行数/批次数",无动作覆盖度检验 | `server/services/workshop/aml/gates.ts:107-118` |
| 门禁阈值集中在 settings,可扩展 | `server/services/workshop/settings.ts:335-365` |
| 孪生 UQ/OOD(ensemble 覆盖率/输入距离/分歧度)已存在 | `server/services/workshop/aml/twin/uq-ood.ts` |
| writePolicy 契约(minNodeIntervalSec≥60/maxActionsPerRun/maxDeltaPerAction)已存在 | `server/services/workshop/aml/twin/contracts.ts:184`、`physics-runtime.ts:161` |
| 模型前向"末拍控制列替换为本拍控制"(动作条件化推理已在) | `server/services/workshop/aml/twin/model-backed-provider.ts:175-186` |
| 本体"边+证据+追踪"表结构已建好(relations/evidence/rule_traces) | `schema.ts:1074,1105,1168` |
| 全仓无任何可辨识性/MDE/最小可检测效应逻辑(grep 属实) | 缺口 |

**事故参照**(数字来自用户实例数据,本轮会话给出口径,P0 回放复测):SP 2.6→2.4 与"作业后半段"完全共线;振荡主导周期 4.71 min;探索窗 45–47s;两个 Agent 得出"无影响"与"完全逆转"两个矛盾结论;一条无证据锚的因果叙述污染了 KB。

**关键缺陷链(本计划要打断的):**
`45s 单点差分` → `optimization-tools.ts:150 教 Agent 按符号外推` → `台账无 verdict/criterion 字段` → `G4 不查动作覆盖` → `模型学不到动作维度也无人发现` → `无证据锚的因果叙述进 KB`。

---

## 3. 目标数据流(实施后)

```
                    ┌────────────────────────────────────────────┐
                    │  P4 DoE 计划(真实线,正交阶梯+随机化+预算前置)   │
                    └──────────────┬─────────────────────────────┘
                                   ▼
   下发意图 ──▶ P5 双通道互审(代理模型 Δ vs 机理/本体边;冲突→拒/转HITL)
                                   ▼
                    dcwControlGovernedInternal(唯一写咽喉,不变)
                                   ▼
              P2 intervention_events 台账(所有路径一行:意图/实写/回读)
                                   ▼
              P1 verdict 评估 job(settle 后算效应量±CI/MDE/相位覆盖)
                    │                          │
                    ▼                          ▼
   P3 AML 动作覆盖度(G6 门+模型动作敏感度)   P6 ontology_evidence 回灌(support/refute)
                    │                          │
                    ▼                          ▼
        代理模型动作维度可验证               因果断言可查询/可证伪
                    └──────────► 审批卡科学载荷(效应量/CI/MDE/覆盖度/证据边)
```

---

## 4. 分阶段实施

### P0 事故回放基线(0.5–1 人日,无生产代码改动)

**目标:** 把"这次事故会被门禁挡住"变成可重复执行的验收,先于一切实现。

**改动点:**
- 新建 `scripts/e2e-identifiability-replay.mjs`:从运行实例导出事故时间窗(写前 06:19–06:54 + 干预段)帧数据为夹具(fixture JSON 含 ts/node/value 序列),入库到隔离实例;
- 夹具同时包含一份**合成正交对照**(同噪声水平的 4 水平阶梯信号),用于校准门禁不误报。

**依赖:** 用户指定运行实例(AW_HOME/端口)导出帧库;若帧已随实例清场,退化为纯合成夹具 + 事故参数(周期 4.71 min、ΔSP=0.2 bar)重构。

**验收标准:**
- A0-1 回放脚本在隔离实例跑通,输出事故窗的节点级摘要(均值/方差/主导周期);
- A0-2 合成对照夹具随仓库入库(`bench/` 或 `scripts/fixtures/`),后续每个阶段的验收都跑同一脚本。

---

### P1 可辨识性引擎 `identifiability.ts` + 三处门禁挂钩(2 人日)★地基

**目标:** 把"效应是否可辨识"变成机器判定:输出 `IDENTIFIABLE / UNDERPOWERED / CONFOUNDED` + 效应量±CI + MDE + 建议试验设计。

**改动点:**
1. 新建 `server/services/workshop/aml/identifiability.ts`(纯函数,复用 `stats.ts:73,103,128` 与 `clean.ts`):
   - 主导周期检测:自相关(用 `lagCrossCorr` 对自身序列)峰值 lag × beatMs;
   - 相位覆盖:干预前后窗在主导周期相位轴上的覆盖直方图 + 重叠系数;
   - 效应量与 CI:干预前后窗均值差 + Welch 置信区间(纯 JS,无新依赖);
   - MDE:由预窗方差、窗长、显著性水平反解;
   - 共线诊断:控制列 vs 时间/run 序号的 `pearson` 相关 + 水平数统计;
   - 输出 `IdentifiabilityVerdict { verdict, effect, ci, mde, dominantPeriodMs, suggestedWindowMs, suggestedLevels, phaseCoverage, collinearity, reasons[] }`(全部机器可读,reasons 供 Agent 与人读)。
2. 新建 Agent 工具 `daq_identifiability`(挂进现有 industrial 工具注册,与 `aml_dataset_stats` 同层):入参 node/target 窗口,出参 verdict;
3. 门禁挂钩第一处:`optimization-tools.ts` 探索工具前置——发起前跑可辨识性检查,上一干预 `UNDERPOWERED` 未收口时拒绝新干预并给出建议窗;
4. 门禁挂钩第二处:**改造 `optimization-tools.ts:150` 的"按此符号外推"文案**——只有 verdict=IDENTIFIABLE 才允许方向性外推措辞;UNDERPOWERED 时改为"效应不可辨识:MDE=X,本次步幅/窗长不足以分辨,建议窗长≥3×主导周期≈Y min、水平数≥N"。

**验收标准:**
- A1-1 单测:合成信号(正弦周期 T + 阶跃)窗长 < 3T → `UNDERPOWERED` 且 `suggestedWindowMs ≥ 3T`;≥3 水平正交阶梯 → `IDENTIFIABLE`,CI 覆盖注入效应真值;
- A1-2 单测:SP 与时间序号 pearson |r|>0.9 → `CONFOUNDED`,reasons 指出共线;
- A1-3 e2e:P0 事故夹具回放 → 输出"效应不可辨识 + MDE≈0.003 mm + 建议窗长≈14.1 min"(数值落在事故参数量级内);
- A1-4 `daq_identifiability` 工具经 omp 真实 Agent 调用返回结构化 verdict(对齐 `tool-verify` 惯例)。

**风险与缓解:**
- 误报挡住合法微调 → 第一版仅在探索前置**强制**、在 dataset 门禁**告警**(settings 开关 `gates.identifiabilityEnforce`),P0 回放全绿后切强制;
- 纯 JS 统计的边界(小样本 CI)→ 单测覆盖 n<30 退化路径,输出 reason 而非崩溃。

---

### P2 全路径干预台账 `intervention_events`(2 人日)★地基

**目标:** 每一次治理下发(exploration / recipe_trial / HITL 手动 / auto)在唯一咽喉处落一行结构化记录,带可判定字段;verdict 由异步 job 回填。**"从经验学习"的前提。**

**改动点:**
1. `schema.ts` 新表(附 migrations.ts 幂等迁移,范式参照 `migrations.ts:477`):
   `intervention_events(id, ts, line_id, node_id, from_value, to_value, actual_value, path, agent_id, channel_id, approval_id, hypothesis, criterion_json, pre_window_ms, settle_ms, verdict, effect, ci_low, ci_high, mde, confounders_json, evidence_json, created_at)`;
   `criterion_json` = `{metric, op, threshold, mde}` 机器可读判据,**不是散文**;
2. 写咽喉挂钩:`dcw-tools.ts:118 dcwControlGovernedInternal` 成功受理后插入一行(单点覆盖全部路径;`optimization_explorations` 旧链路保留不动,避免破坏现有回流与 `eda/ocap.ts:95-100` 弱关联);
3. verdict 评估 job:settle 窗结束后调 P1 引擎回填 verdict/effect/CI/MDE;受现有试验节拍门(`AW_TRIAL_INTERVAL_MS`)同款节拍约束,不阻塞探索步本身——只有发起新干预时才要求上一干预已收口(与 P1 挂钩点 3 协同);
4. 查询工具 `intervention_history`(per line/node,含 verdict 过滤),并把 `optimization-tools.ts:162 optimizationExplorationsOf` 的 prompt 组装源升级为台账摘要(带 verdict),Agent 复盘时读结构化证据而非 45s 单点差分。

**验收标准:**
- A2-1 e2e:同一条线分别经 exploration / recipe_trial / HITL 手动三条路径各下发一次,`intervention_events` 恰好 3 行,`path` 字段正确;
- A2-2 写入失败(治理拒绝)不产生行(或产生 `verdict=rejected` 行,二选一,实施时定死并在测试断言);
- A2-3 verdict job 在 settle 后 N 秒内回填,`effect/ci/mde` 非空;
- A2-4 Agent 经工具查询台账能拿到"最近 5 次干预 + verdict"的结构化文本。

**风险与缓解:**
- 长 settle 拖慢探索节奏 → verdict 异步化(见上),节拍门只在"连续干预"场景生效;
- 台账写失败不能阻断产线写 → 插入失败降级为 audit_log 记录 + 返回文本警告(沿 `optimization-tools.ts:135-137` 现有模式,不吞)。

---

### P3 AML 动作覆盖度:让"识别器"可验证(1.5 人日)

**目标:** 回答"这个模型在动作维度到底学到了什么"——数据集、门禁、模型三层都可见。

**改动点:**
1. `dataset-builder.ts`:对每个 role=control 列(`:343 ctrlIds`)计算 `actionCoverage { distinctLevels(容差聚类), stepCount, betweenWithinVarianceRatio, collinearityWithTime, saturationRatio, levelPhaseMatrix }`,进 `AmlDatasetReport`(manifest v2 可选字段,不破坏 v1 读取);
2. `gates.ts` 新增 **G6 动作覆盖门**(阈值进 `settings.ts:335` gates 段:`minControlLevels=3`、`maxCollinearity=0.9`):新数据集/新模型采纳时强制,存量模型标记 `actionCoverage=unknown` 不追溯误杀;
3. 模型元数据:训练产物登记时附加"动作敏感度"(对 u 列的扰动前向差分,复用 `model-backed-provider.ts:175` 同口径的末拍替换),让"模型对 SP 有无响应"变成一个数;
4. `aml_dataset_stats` 工具输出 actionCoverage(表格已有该工具通道)。

**验收标准:**
- A3-1 单测:事故同款数据(SP 2 水平且与时间共线)→ G6 FAIL,reasons 指出水平数与共线;4 水平阶梯数据 → PASS;
- A3-2 单测:动作敏感度对注入了已知 SP→target 增益的合成数据集,恢复出的敏感度与真值相对误差 < 20%;
- A3-3 存量模型回归:现有全部单测不红,G6 只对新数据集生效(settings 可关)。

---

### P4 真实线 DoE 解锁:正交化探索的机制化(2 人日)

**目标:** 把 `process_model_experiments` 从"仅仿真线"解锁为治理分档:仿真线 auto,真实线 HITL+预算+可辨识性前置。正交化(levels/repeats/`randomizedOrder`/ABAB 相位错开)由计划器机制保证,不靠 Agent 自觉。

**改动点:**
1. `process-model/experiment.ts:17 assertSimulatedLine` → `resolveExperimentTier(lineId)`:simulated → auto;真实线 → 要求(a)P1 引擎对计划矩阵的**前置核算**(suggestedWindowMs×levels×repeats = 总产线时长,**创建时就算给用户看**),与 (b)HITL 批准计划单卡(不是逐步卡,防审批疲劳);
2. 执行器:计划步映射到 `dcwControlGovernedInternal`(写咽喉不变),步间尊重 `writePolicy.minNodeIntervalSec`(`contracts.ts:184`)与试验节拍门;`abortOnAlarm` 既有语义保留;
3. 计划完成 → 每步在 `intervention_events` 有行且 verdict 汇总进计划状态(与 P2 联动);
4. 预算字段 `budget.maxDurationMs` 超限自动 FAILED(不静默续跑)。

**验收标准:**
- A4-1 现有仿真线测试不红(`assertSimulatedLine` 行为对 sim 线完全不变);
- A4-2 e2e(隔离真实线):创建 4 水平×2 轮 SP 阶梯计划 → 返回 HITL 卡,卡内含"预计总时长 ≈ 4 水平 × 3×周期 × 2 轮"的成本核算;批准后按 randomizedOrder 执行,台账逐步落行;
- A4-3 计划中途告警 → abortOnAlarm 触发,剩余步不执行,状态 FAILED 有因;
- A4-4 预算超限 → FAILED + 超限原因,无静默。

**风险与缓解:**
- 真实产线时长成本 → 成本在创建时前置展示 + HITL 单卡批准(用户明确知情后才花产线时间);
- 与试验节拍门叠加导致执行过慢 → 节拍取二者较宽者并在计划预览中写明。

---

### P5 下发前双通道互审 + 审批卡科学载荷(1.5 人日)

**目标:** "科学性"从散文变成载荷。下发前:代理模型、机理/本体、可辨识性三方互审;审批卡自动填效应量±CI/MDE/覆盖度/支撑证据边/可证伪方式。

**改动点:**
1. 互审器(新文件 `server/services/workshop/aml/twin/cross-check.ts`):对拟下发 ΔSP,
   - 通道 A:模型前向(`model-backed-provider.ts:175` 同口径)预测 Δtarget ± UQ(`uq-ood.ts` 已有的 ensemble std/OOD);
   - 通道 B:本体 relation 断言(schema.ts:1074/1105,含"无耦合路径"断言)与机理场景约束;
   - 判定:A 称有效应而 B 断言无路径(或反向)→ auto 模式拒,manual 模式卡上明示冲突并要求审批理由;UQ `accepted=false`(既有 rejectCode)→ 同规则;
2. 审批卡载荷扩展:`approval_requests`(schema.ts:274)payload 增加科学段 `{effectEstimate, ci, mde, actionCoverage, evidenceEdges[], falsificationMethod}`,前端审批页(/dcw/line 卡片)渲染;
3. 无耦合场景的正道输出:互审通过但 P1 判 UNDERPOWERED → 卡片写明"当前步幅不构成可分辨干预,建议换目标量/换执行器/加窗"。

**验收标准:**
- A5-1 单测:通道 A/B 冲突 → auto 拒且结构化 reason;一致 → 放行;
- A5-2 事故场景回放:吹压 SP 提案在 auto 模式被拒,理由含"本体无耦合路径断言 + 本次步幅 UNDERPOWERED";
- A5-3 e2e:HITL 卡渲染含科学载荷五字段(对齐 demo 轮截图验收惯例);
- A5-4 UQ/OOD 既有测试不红。

---

### P6 本体证据回灌 + KB 因果断言防污染(1 人日)

**目标:** 每个因果结论带可证伪证据锚;负结果("无耦合")成为一等事实。

**改动点:**
1. verdict 回灌:P2 verdict job 落库后,向 `ontology_evidence`(schema.ts:1105)追加证据行(support/refute 计数、指向 intervention_event id);`ontology_rule_traces`(schema.ts:1168)串起"规则→证据→台账"链;
2. KB 写入门:Agent 向 KB 写因果断言时,要求携带 `intervention_event` 或 `ontology_evidence` 引用;无引用 → 强制标记 `anecdotal` 并在检索结果中降权(事故中"变厚由瓶坯/熔体温度驱动"这类无锚叙述属于此类);
3. "无耦合路径"断言模板:identifiability 引擎的 CONFOUNDED/无效应结论可一键固化为本体边(带置信度与 MDE),供 P5 通道 B 查询。

**验收标准:**
- A6-1 e2e:一次带 verdict 的干预 → ontology_evidence 自动追加,counts 正确;
- A6-2 Agent 写无引用因果断言 → 被标 anecdotal,检索降权可验证;
- A6-3 事故重演:两条矛盾结论中,后写者必须面对先前的 evidence 行(冲突可见)。

---

## 5. 依赖与排程

```
P0 ──▶ P1 ──▶ P2 ──▶ P6
        │      │
        ▼      ▼
        P3     P4 ──▶ P5
(P3 与 P2 可并行;P5 依赖 P1+P4;P6 依赖 P2)
```

| 阶段 | 工作量 | 独立可交付 |
|---|---|---|
| P0 | 0.5–1 人日 | ✅(纯夹具) |
| P1 | 2 人日 | ✅(引擎+工具+探索前置门) |
| P2 | 2 人日 | ✅(台账+verdict) |
| P3 | 1.5 人日 | ✅(与 P2 并行) |
| P4 | 2 人日 | ✅(依赖 P1) |
| P5 | 1.5 人日 | 依赖 P1+P4 |
| P6 | 1 人日 | 依赖 P2 |
| **合计** | **≈9–11 人日** | P0+P1+P2 为最小地基(≈4.5–5 人日) |

实施纪律:每阶段独立分支+验收脚本入库(沿 `scripts/acceptance-*.ts` / `scripts/e2e-*.mjs` 惯例);单测全量基线当前 918/0,每阶段合入前不得红;git status 显示本分支已有大量未提交改动,**实施前先清点基线、新文件为主、共享文件最小化修改**。

## 6. 总体验证矩阵

| 层 | 内容 |
|---|---|
| 单元 | identifiability 数学(合成信号/小样本/共线)、actionCoverage 聚类、互审判定、G6 阈值边界 |
| 集成 | 写咽喉挂钩×3 路径、verdict job、ontology_evidence 回灌 |
| e2e | P0 事故夹具回放贯穿各阶段(A1-3/A5-2 复跑同一脚本)、真实线 DoE 全流程、现有 44 断言 line 套件不红 |
| 观测 | verdict 分布与拦截计数进 audit_log;台账统计页(轻量,可后置) |

## 7. 主要风险登记

| 风险 | 缓解 |
|---|---|
| 真实线试验花产线时间(4 水平×3×周期×2轮 ≈ 3h 量级) | P4 成本创建时前置展示 + HITL 单卡知情批准 |
| 门禁误报挡合法微调 | 影子模式先行(settings 开关),P0 回放全绿后切强制;G6 只对新数据集生效 |
| 长窗 verdict 拖慢探索 | verdict 异步;仅连续干预时要求收口 |
| .omc/gitignore 与并行会话冲突 | 本计划落 docs/plans/(仓库惯例、git 跟踪);实施前清点未提交基线 |
| TSDB 长窗查询负载 | 沿用 beatMs≥1000 下限与 `queryTaggedPage` 分页,不新增裸查 |
| v1 manifest 兼容 | actionCoverage 只进 v2 可选字段 |

## 8. 明确非目标

- 不改训练算法本身(G1–G5 语义不变,G6 是新增不是替换);
- 不放开无人值守(HITL 全程保留,目标是让审批"看得见科学依据",不是减少人);
- 不做本体自动因果发现(本体只做证据回灌与查询,因果只来自干预数据);
- 不动量程/步长/频控等安全护栏(本计划加的是"科学护栏",不替换"安全护栏")。

## 9. ADR(决策记录)

- **Decision:** 干预台账走"新表 intervention_events + 唯一写咽喉挂钩",DoE 走"治理分档解锁"而非重写;可辨识性引擎为独立纯函数库。
- **Drivers:** 写咽喉唯一(dcw-tools.ts:118)使单点挂钩覆盖全路径;optimization_explorations 列窄且 channel-scoped,扩展会破坏既有回流(eda/ocap.ts:95 弱关联);DoE 计划器 levels/randomizedOrder 已存在,只缺治理解锁。
- **Alternatives considered:** ①扩展 optimization_explorations 加列 —— 否,迁移面大且语义混载(optimizer 专属 vs 全路径);②给每个下发工具各自落账 —— 否,违反"写咽喉"架构事实,必然漏路径;③只加 AML 训练+本体检索不动台账 —— 否,已被事故证伪(预测器给自信的错误结论,检索给不可追溯的文本)。
- **Consequences:** 新表 +1;探索节奏在连续干预场景变慢(这是特性不是缺陷);G6 使部分存量模型不可参与新采纳。
- **Follow-ups:** 观测统计页;identifiability 阈值经 P0 回放校准后固化进 settings 默认值;孪生策略评估闭环(P5 通道 A 的离线批量版,本期只做单点互审)。
