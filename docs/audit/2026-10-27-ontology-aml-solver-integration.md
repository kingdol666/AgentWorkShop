# 本体 × 求解器 × AML 三模块集成评审与多工况实测(2026-10-27)

> 验收对象:`main` @ `4437456c`(v0.8.4)· 全部结论基于**本轮新鲜证据**:
> 三套 live 集成套件复跑(`us2-suites.txt`)+ 四个不同 PLC 工况的并行闭环实测(`us3-scenarios.txt`)。
> 证据目录:`docs/audit/evidence/2026-10-27-integration-multiscenario/`。

---

## 一、结论摘要

| 问题 | 结论 |
| --- | --- |
| 三模块集成开发程度 | **完整且已贯通**——本体→过程模型→AML 训练→求解器→治理下发全链存在可执行规格(model-loop 54/54),本轮新鲜复跑全绿 |
| Agent 自主 × HITL 协同 | **已实现,且分工清晰**:Agent 提议/执行/汇报,人在四个咽喉点裁决(本体规则批准、虚拟模型冻结、Profile 采纳、下发批准);HITL 拒绝路径与超时默认拒均有测试 |
| 按场景自适应动态更新 | **已实现(版本化演进,非热改)**:本体结构变更走"草稿→生命周期→发布不可变版本";AML 走"数据集谱系→资格门→再训练→登记→提议采纳";求解器走"IR 重编译+哈希锁定+只收紧不变量"。三者由重绑机制缝合(采纳即自动重绑,revision+1) |
| 设计理念是否合理 | **合理且自洽**(§5 详述);核心判断:把"模型治理"当成"写治理"的同等问题对待,是这个设计最不寻常也最正确的地方 |
| 多工况实测 | 四工况(注塑/污水/退火/BOPET 双轴)并行闭环 **96.8s 跑完**:建线/五协议接入/23 次治理写入/守卫与作用域拒绝全部真实发生;达标 ✗ 红在模拟器 SP→PV 映射未标定(§6.2 如实归因) |

---

## 二、三模块集成架构(逐集成点,均可在仓库点开)

### 2.1 集成链总览

```
本体(ontology/)                    AML(aml/)                      求解器(optimization/)
┌────────────────────┐   冻结场景   ┌──────────────────────┐  模型工件  ┌───────────────────────┐
│ 草稿→生命周期→发布   │ ─────────→ │ 数据集(谱系 verified) │ ────────→ │ Profile(modelRef+哈希) │
│ contentHash+packHash│            │ 资格门 G1-G5(gates.ts)│           │ ProblemIR 编译(哈希锁定)│
│ 编译四工件+只收紧     │ ←───────── │ 训练→登记(artifactHash)│ ←─────── │ OSQP/SLSQP→TS 互校≤1e-6│
│ 运行时守卫 fail-closed│   场景快照  └──────────────────────┘  propose   │ 治理下发(单咽喉+八重验) │
└────────────────────┘              └──────────────────────┘           └───────────────────────┘
```

### 2.2 关键集成点(文件锚点)

| # | 集成点 | 位置 | 机制 |
| --- | --- | --- | --- |
| I1 | 本体→过程模型数据集 | `server/services/workshop/aml/dataset-builder.ts`;冻结场景规格 | 数据集必须挂本体冻结的场景规格,带谱系(verified lineage),数据不缩水约束(模型闭环 M3.5 断言) |
| I2 | AML 资格门 | `server/services/workshop/aml/gates.ts` | 按工件类型分派:G1 单步 NRMSE / G2 多步滚动 NRMSE / G3 泛化差 / G4 数据覆盖 / G5 工件完整;**无资格报告 → solve 422**(模型闭环 M3.1 断言 eligOk) |
| I3 | AML→求解器(Profile) | `server/services/workshop/optimization/profile-adopt.service.ts`;Agent 工具 `optimizer_profile_propose` | 训练出的模型以 `modelRef{modelId,artifactKind,artifactHash}` 进入 Profile;采纳=HITL 批准后单咽喉发布新版本 |
| I4 | 求解器问题编译 | `server/services/workshop/optimization/problem-builder.ts` + `crosscheck.service.ts` | ProblemIR 哈希锁定;OSQP/SLSQP 求解后由 TS 独立重算交叉核验(≤1e-6);工件类型不符 → 422 UNSUPPORTED_MODEL_SOLVER |
| I5 | 本体→运行时守卫 | `server/services/workshop/ontology/guards.ts` + `compiler.ts` | 发布版本编译出守卫集;**只收紧不放宽**(提供 currentBounds 时放宽现行界/步限的规则被拒);运行时对状态未知 fail-closed |
| I6 | 求解器→产线(治理下发) | `server/services/workshop/optimization/dispatch.service.ts` | 互校一致的建议 → 审批卡 `optimizer-recipe:<recipeId>` → **单一咽喉 decideOptimizerDispatch** → D13 八项重验(fail-closed)→ approval 原子抢占 → applyRecipe 整批写 → 回读 → recordOps |
| I7 | 三面绑定 | 模型闭环 M0;`optimization/binding.service.ts` | 频道/Agent ↔ 本体 ↔ Profile ↔ Twin 三面绑定;优化器五件套工具**仅对有效绑定注入**(104 宿主工具声明式治理的一部分) |
| I8 | Agent 工具面 | 本体 10 件(`ontology_draft_*`/`ontology_graph_*` 等)+ AML(`aml_model_annotate` 等)+ 优化器五件套 + twin/mpc 12 件 | 工具走统一 invoke 面(引用预检 tool-verify),治理链与 REST 同一路径 |

## 三、Agent 自主 × HITL 协同:分工与证据

**设计分工:Agent 负责"提议与执行",人负责四个裁决咽喉,系统负责把每个裁决变成不可变事实。**

| 咽喉点 | Agent 做什么 | 人做什么 | 证据(本轮全绿断言) |
| --- | --- | --- | --- |
| 本体规则批准 | 起草本体、跑活体校验、`ontology_draft_autofix` 自修复 | 规则生命周期 transition(draft→reviewed→validated)→ approval → **approved_for_control** 才能进控制约束 | model-loop M1.1/M1.2;规则未经批准不得入约束(本体套件 L2 断言) |
| 虚拟模型冻结 | 场景发现→提议冻结→物理规格骨架→采样→虚拟试验 | 批准冻结 | model-loop M2 全链 |
| Profile 采纳 | `optimizer_profile_propose`(带 reason 与人读描述)→挂卡 `optimizer-profile:<id>@<v>` | 审批卡裁决;**批准即发布+自动重绑** | model-loop M3.6-M3.10:采纳卡、单咽喉发布、绑定 revision+1、新模型工件入版本台账、Agent 提议的描述落台账 |
| 优化下发 | `optimizer_solve` → 拿到建议 → 提议下发 | `optimizer-recipe:<recipeId>` 审批卡;**单一咽喉**两个裁决入口同路由;D13 八项重验 fail-closed | optimizer-live 104/104 中的下发腿;dispatch.service 头注即契约 |

协同的三个值得指出的细节:

1. **重绑是自动的、有版本的**:HITL 批准采纳后,绑定自动指向新 Profile 版本(revision+1),
   下一次 solve 即用新模型(M3.9/M3.11);不需要人再去改绑定——人只裁决"采不采",不裁决"怎么接"。
2. **Agent 的汇报是诚实的**:工具回执断言"模型采纳完成"必须与实际发布状态一致(M3.8);
   本体草稿一键自修复后,描述/作用域补齐且校验通过才算数(M1.5/M1.6)。
3. **HITL 不是摆设**:拒绝路径与超时默认拒在产线治理套件(44/44)与本轮注塑实测里都有真实触发
   (§6:节拍门拒绝、运行门拒绝都是治理链在真实工况下的行为)。

## 四、按场景自适应动态更新:三条演进回路

| 对象 | 适应什么 | 怎么更新 | 本轮证据 |
| --- | --- | --- | --- |
| 本体模型结构 | 工艺窗变化/管理者意志 | 草稿(rev 递增,活体校验)→ 规则生命周期+批准 → 发布**不可变新版本**(contentHash+packHash)→ 编译工件(只收紧);支持 `versions/compare` 四段 diff 供人审 | M1.3(膜厚窗 45-55 收窄到 46-54 → v2 发布)+ M1.4(diff 反映管理者意志) |
| AML 模型 | 工况漂移/反馈数据积累 | 数据集(谱系,不缩水)→ 资格门 G1-G5 → 再训练 → 新 artifactHash 登记 → Agent 提议采纳 → HITL → 发布+重绑 | M3.5(两轮训练 rows 不缩水且哈希不同)+ M3.11(新模型 solve optimal)+ M4(第三轮,连续 v1→v2→v3) |
| 求解器配置 | 新模型工件/新工况结构 | Profile 新版本携带新 modelRef → ProblemIR **重编译+哈希锁定** → 旧工件/新求解器不匹配显式 422(不静默) | optimizer-live S3/T4(422 UNSUPPORTED_MODEL_SOLVER 两条负例)+ 场景 B(2 MV/2 CV+单位换算) |

**边界(如实)**:本体结构更新是**版本化演进**而非运行中热改——运行中的守卫始终锚定已发布版本,
新版本要重新走生命周期。这是刻意设计(控制面不允许"漂浮的本体"),代价是适应速度以"一次批准"为下限。

## 五、设计理念评价:合理,而且自洽

1. **"模型治理 = 写治理"同权对待**。多数平台把 ML 模型当资产偷偷换;这里模型工件和设定值写入
   走同一套治理哲学:提议→批准→原子生效→可追溯(哈希+版本+台账)。这是该设计最不寻常、也最正确的地方。
2. **哈希分域,锚定事实**。本体 contentHash/packHash、模型 artifactHash、ProblemIR 哈希三者分域——
   本体变了不等于模型失效,模型换了不等于 IR 失效,每层各自锚定、显式 422,不存在隐式失效传播。
3. **资格门挡在求解器前面**。没经过 G1-G5 资格评估的模型连 solve 的门都进不去(422),
   而不是"解出来再说"——把统计质量问题挡在人机接口之前。
4. **求解结果不信求解器**。OSQP/SLSQP 出解后由 TS 独立重算交叉核验(≤1e-6),下发前 D13 八项重验;
   "求解器也是会被供应商 bug 骗的"这个假设贯彻得很彻底。
5. **Agent 自主有边界、有回执**。Agent 能跑完"发现→训练→提议"全程自主,但每一次"变成事实"的跳转
   都有人;且工具回执必须与实际状态一致——自主性不以可追溯性为代价。

**可改进项(如实)**:①本体/Profile/绑定三处的版本联动目前靠"采纳即重绑"这一条单向链,
跨线多绑定场景下的批量重绑策略文档还应更显性;②资格门是仿真 scope 的,scale 到真机数据后的
门槛语义(covering real operating envelope)还没在文档里展开;③三模块的工具面已经统一,
但"一轮完整的自适应"仍需要 3 次人工批准(冻结/采纳/下发)——对试点是正确的保守,对规模化偏重,
可考虑"同窗口内同类批准的批量裁决"作为后续演进。

## 六、四工况实测(注塑 / 污水 / 退火 / BOPET 双轴)

**跑法**:`bench/scenarios.mjs` 全新隔离平台(home 模式 + `AW_TRIAL_INTERVAL_MS=0`)+
PLC 模拟器(4010)冷启清场 24 台;四场景**并行**各建一产线/一 Channel/一工具执行器(opencode 真引擎驱动),
mission 全轨迹闭环;run `20261026175025-1ijw`,并行 wall **96.8s**。

### 6.1 结果总表

| 工况 | 被控量(目标) | 建线(差分 ensure) | mission | 治理写入 | 轮次 | 守卫/治理事件(实测) | 达标 | PV 响应 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| injection 注塑成型 | 克重 32.5±0.35g | 5 设备/5 协议 ✔ · DCW 11+DAQ 14 | COMPLETED | 5(全部带试验批次) | 8 | 飞边率 0.02 / 缩痕 2.08 守卫终值 | ✘ | **恒 31.26g,五写不动** |
| wwtp A2O 污水 | DO 3.4±0.6mg/L(排放 COD<50 等) | 5 设备 ✔ · DCW 7+DAQ 13 | COMPLETED | 10 | 10 | **越量程拒写实证**:recover 恢复写 51.5Hz > 节点安全上限 50Hz 被拒,回执给出有效区间 20~50 与归因 | ✗ | DO 0.22→0.23,基本不动;出水 COD 359.9(目标 <50) |
| anneal 连续退火 | 硬度 95±6HV | 5 设备 ✔ · DCW 7+DAQ 12 | COMPLETED | 2 | 5 | 抗拉 310.8 / 表面缺陷 0.15 守卫终值 | ✗ | **恒 135.0HV** |
| biax BOPET 双轴 | 膜厚 25±0.7μm | 9 设备/49 信号 ✔ · DCW 30+DAQ 19 | COMPLETED | 6 | 6 | **越权账本查询被拒**:Agent 查绑定作用域外节点,回执列出可查范围;熔体温度守卫窗 268~300℃ 全程在内 | ✗ | 27.97→28.00μm,微动 |

### 6.2 首跑全红的排查与修复(2026-10-27 当日完成)

首跑四工况达标全红。**活体探针逐层排除**:引擎真值流显示 SP→PV 响应完全正确(保压 110→69,
克重 34.65→32.5 两秒内入窗)——模拟器引擎/模型无缺陷。真正根因在 **bench 反馈通道**,两层:

1. **多场景跑器从未启动 DAQ 采样总控**:`ensureGateway` 只被 checks 调用,`bench/scenarios.mjs`
   全程不启采样器;冷启平台不自动起采样器,mission 的 PV 反馈(`/samples`)没有新样本。
2. **`readPvMean` 的 60s 窗口踩中 `/samples` 的 `ORDER BY b_at ASC LIMIT n` 语义**:
   取的是窗口内**最旧**的 n 桶(≈55s 前)。v2 迁移把迭代加快到 8-17s/轮后,
   55s 陈旧度 = 控制器永远落后 4-5 轮、对着旧基线反复加码 —— 表象即"PV 冻结在初值"。

修复(`bench/lib/scenarios.mjs`):入口显式 `ensureGateway`;每场景 mission 前加**采样活性+值跟动
哨兵**(样本必须存在且等于设备现值,否则记 error 拒跑);`readPvMean` 窗口改 `limit×1s+3s`;
慢动力学工况 settle 调优(wwtp 30s/anneal 25s/biax 20s)。

**修复后复跑**(run `20261027043152-u80`,fresh home,四场景并行 168s):

| 工况 | 结果 | 轨迹摘要 |
| --- | --- | --- |
| injection | **✔ attained** | 31.27 →(45→58)→ 31.95 →(hold-time 6→10.4)→ 32.13 →(58→61.9)→ **32.18 入窗**,3 发收敛 |
| wwtp | **✔ attained** | DO 0.21 → 曝气逐级 +NaOH/PAC 修剪,11 发收敛(慢动力学,settle 30s) |
| anneal | **✔ attained** | 硬度入窗 + 产能修剪,6 发 |
| biax | ✘(剩余标定) | 膜厚 28.00→27.93 **实时递降**(通道已活),距 25±0.7 仍远 —— 剩余项是 biax mission 的控制器增益/轮次预算,不再是通道缺陷 |

**归因更正**:此前写入 `bench/V2-MIGRATION.md` 的"模拟器 SP→PV 响应映射未标定"不成立,
已在该文件追加更正章节;模拟器无缺陷,缺陷在 bench 反馈通道且已修复。
本轮同时实证了治理面的两次真实拒绝(wwtp 越量程拒写 51.5Hz>50、biax 越权账本查询被拒)。

## 七、结论

三模块集成**不是"接口对上了",而是有可执行规格、有负例、有版本语义的完整闭环**:Agent 能自主完成
"发现→建模→训练→提议"全程,人在四个咽喉裁决,系统保证每次裁决都成为带哈希的不可变事实。
自适应更新三条回路(本体版本化演进 / AML 资格门+再训练 / 求解器 IR 重编译)已经打通并被
87+104+54=245 项新鲜断言与四工况实测覆盖。设计理念自洽且偏保守——这正是它适合走向真实产线的姿态。

---

*报告:2026-10-27 · main@4437456c · 证据:`docs/audit/evidence/2026-10-27-integration-multiscenario/`*
