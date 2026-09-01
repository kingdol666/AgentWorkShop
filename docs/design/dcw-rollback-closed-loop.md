# DCW 参数回退机制 + 赛博团队闭环优化控制 · 设计方案

> 2026-08-31 · 状态:**设计已归档,实施以 .omc/plans/2026-08-31-dcw-rollback-closed-loop.md 为准**
> (该计划补齐了本设计的三个缺口:StepRecord 步骤级记录 / metrics.after 指标快照 / Recipe 版本链+参数台账)
> 目标:让 AgentWorkShop 的 Agent 团队真正做「读节点 → 调参数 → 看效果 → 不行就回退」的闭环优化,
> 而不是只能单向写值、错了靠人肉从写历史里翻旧值。

---

## 0. 结论先行

**需要回退机制,而且它应该是闭环的裁判,不只是后悔药。**

现状的闭环断在「执行→验证」之间:Agent 通过 `dcw_control` 下发 183℃ 后,系统没有
「这次变更加上观察期、到期判定优劣、劣则自动回退」的机制——判读纪律(industrialLoopGuide 第 4 步
「复测确认收敛」)只是 prompt 层的道德劝告,Agent 不复测系统也不知道。

设计核心:**参数账本(ParameterJournal)+ 试验评估(Trial)+ 分级回退(RollbackService)**
三件事,全部挂在既有单点 `DcwController.write()` 与既有数采设施(daqWindows/打标/聚合)上,
不开旁路、不建新数据管道。

---

## 1. 现状盘点(设计依据)

### 1.1 已有的地基(可直接复用)

| 设施 | 位置 | 对回退的意义 |
|---|---|---|
| 写单点 `write()` | dcw-controller.ts | 量程/窗口/联锁/停线守卫全部在此,回退走同一点即自动继承全部安全语义 |
| 写历史 dcw-writes.json | dcw-recipe.repo.ts | 有 `{nodeId, eng, raw, ok, recipeRunId, at}` —— 但 **3000 条环形淘汰**,不可靠 |
| 保写心跳 holdIntervalMs | dcw-runtime.ts | 回退写回后心跳自动保持新(=旧)值,恢复语义免费 |
| 配方监控窗口 daqWindows | Recipe.daqWindows + daq ingestNode | 越限→alarm 既有通道,是 Trial 判定的现成判据 |
| 逐样本打标 + 五维查询 | line-run.ts + queryTagged | Trial 的 before/after 效果对比数据源,零新增 |
| Run.results | createRun/applyRecipe | 逐参数成功/失败快照,批次级回退的参数清单 |
| HITL 审批 ToolApprovals | tool-approvals.ts | 「建议回退」走同一审批面,复用批准/拒绝/备注 |
| 活动窗口持久化 | line-run.ts restore() | Trial 需要同样的崩溃恢复语义(对齐即可) |

### 1.2 三个必须补的缺口

1. **无回退锚点**:`createRun` 不快照 params(只存 recipeId 引用,配方事后可变);
   写历史环形淘汰;节点当前值虽可从 PLC 回读,但「上一个已知良好设定」没有一等记录。
2. **无评估闭环**:越限会报警,但「一次变更之后系统地观察并判定优劣」不存在;
   实验值会被保写心跳无限期保持——试错没有退出机制。
3. **变更无身份**:Agent 的 dcw_control 写历史里 `recipeRunId=null`,没有「这次优化动作」
   的分组;多 Agent 并发调同一节点会互踩,无法回答"当前设定是谁、为了什么改的"。

---

## 2. 总体架构:三层状态,三个组件

系统里的"状态"有三层,回退必须三层贯通:

```
意图层  Recipe(参数集+监控窗口)      ── 版本化:改参数前留旧版
实验层  RecipeRun/Trial(一次尝试)    ── 快照:开跑时冻结 params,开 Trial 观察
执行层  Node.value(节点当前设定值)   ── 账本:每次写前记 prevValue 锚点
```

```
┌─ A. ParameterJournal 参数账本(dcw-journal.ts,新)
│    write() 前自动记锚:nodeId/prevValue/newValue/source/actor/runId/trialId
├─ B. RollbackService(dcw-controller 内,新方法组)
│    节点级单步回退 / 批次级撤销 / 配方 lastGood 基准恢复 —— 全走 write() 单点
└─ C. TrialManager 试验评估(dcw-trial.ts,新)
     变更后自动开观察窗 → daqWindows+收敛判据 → KEEP / ROLLBACK / UNCERTAIN
```

---

## 3. 组件设计

### 3.1 A. ParameterJournal(参数账本)

**语义:撤销栈(undo stack),不是 git。** 工业参数回退要的是"回到上一个稳定点",
不是分支合并;不做 diff/merge,只做线性撤销 + 锚点标记。

```ts
// server/services/workshop/dcw/dcw-journal.ts → server/data/dcw-journal.json
interface JournalAnchor {
  id: string                    // anc-xxxxxxxx
  lineId: string
  nodeId: string
  prevValue: number             // 写前 node.value(物理量纲;首写 null = 无基线)
  newValue: number
  source: 'manual' | 'recipe' | 'agent'
  actor: string                 // userId 或 agentId
  runId?: string                // 配方批次关联
  trialId?: string              // Trial 关联(见 3.3)
  approvalId?: string           // HITL 关联(manual 绑定)
  note?: string                 // Agent 假设声明("提温 1℃ 预期产量+2%")
  at: string
}
```

- **挂接点**:`DcwController.write()` 成功路径内、encode 之前,若 `prevValue !== newValue`
  则记锚(该节点 5s 内已锚则跳过——保写心跳重下发不产生噪音锚)。
  单点挂接 = 手动 REST / 配方 apply / lineStart / Agent dcw_control 四路自动全覆盖。
- **零额外 PLC 成本**:prevValue 取写前已有的 `node.value`(上次写回读值),不新增回读。
- **追加式、无 cap**:每条 ~150B;一节点一天百次变更 ≈ 15KB/天。独立文件,不与 writes.json
  的 3000 条环形互相牵连。flushDebounced 落盘(对齐加固轮的写放大对策)。
- **崩溃恢复**:`restore()` 惰性重放(对齐 line-run.ts 语义)。

### 3.2 B. RollbackService(分级回退)

三个粒度,从细到粗,**全部经由 `this.write()`**——量程/窗口/联锁/停线守卫/HITL 自动继承:

| 粒度 | API | 行为 |
|---|---|---|
| 节点单步 | `POST /dcw/journal/node/:nodeId/rollback { to?: anchorId }` | 取该节点最近一个 `prevValue≠newValue` 的锚,把 prevValue 写回;省略 to = 逐步撤销栈顶 |
| 批次撤销 | `POST /dcw/runs/:id/rollback` | 对该 run 涉及的全部节点,恢复到 `run.startedAt` 之前各自的最近锚值(=「撤销这次实验」) |
| 基准恢复 | `POST /dcw/recipes/:id/rollback-good` | 重新 apply `lastGoodRecipeRunId` 时冻结的参数版本(见下) |

**配方版本化(补 createRun 缺口,轻量两笔)**:
- `createRun` 增加 `paramsSnapshot: RecipeParam[]` —— run 冻结"当时跑的是什么",配方后续怎么改都不影响审计与回放;
- `Recipe` 增加 `lastGoodRunId`(人工或 Trial 判 KEEP 时标记)+ `paramsHistory[]`(cap 20,活动批次外的参数修改自动存旧版)。

**防乒乓护栏(RollbackService 内建)**:
- 同节点回退后 **cooldown(默认 300s)** 内,拒绝同源(source=agent)同向再写,409 带剩余时间;
- 单条 Trial 链最多 **2 次自动回退**,第 3 次异常强制升级 HITL(自动回退治不了的抖动,人不该缺席);
- 回退本身也记锚(`source='rollback'`)——回退可以被再回退,且全程可审计。

### 3.3 C. TrialManager(试验观察评估器)

**语义:任何参数变更自动成为一次带观察期的试验,到期判定 KEEP / ROLLBACK / UNCERTAIN。**

```ts
// server/services/workshop/dcw/dcw-trial.ts → server/data/dcw-trials.json
interface Trial {
  id: string                  // tr-xxxxxxxx
  lineId: string
  nodeId: string              // 本期:单节点;多参数配方 apply = 每 run 一个聚合 Trial(下期)
  change: { from: number, to: number }
  hypothesis: string          // Agent 的假设声明(prompt 层要求填写,人工写=空)
  baseline: { agg: RunAgg }   // 变更前 10min 数采聚合(复用 runData 聚合口径)
  policy: 'auto_rollback' | 'approve_rollback' | 'observe_only'
  observeMs: number           // 观察窗:节点语义卡可配,缺省 300s;热惯性大节点建议 600s
  status: 'observing' | 'keep' | 'rollback' | 'failed'
  verdict?: { reason: string, evidence: string, at: string }
}
```

**判定流水(tick 复用 dcw/daq 既有节拍,不建新定时器族)**:

1. **FAIL → ROLLBACK**(任一命中):
   - 观察期内绑定数采通道**越配方监控窗**(既有 alarm 状态)累计 ≥ 3 次采样或持续 ≥ 30s;
   - 人工否决:HITL 备注驳回 / 用户在详情页点「终止并回退」。
2. **PASS → KEEP**(全部满足):
   - 观察窗内无越限;
   - 设备绑定通道实际值向目标收敛 ≥ 50% 步幅(复用 queryTagged 聚合,latest vs baseline.avg)。
3. **UNCERTAIN**:无越限但未收敛 → 延长观察一次(observeMs×2),再不定 → 保持现状 + 推荐人工复核
   (诚实缺省:不动比乱动安全)。

**ROLLBACK 执行策略按 policy**:
- `auto_rollback`(auto 绑定 + 配方 policy 允许):系统自动走 RollbackService,告警面板记一条「试验 tr-xx 自动回退(原因)」;
- `approve_rollback`(manual 绑定):推 HITL 审批「建议回退 183→182,证据:…」,批准即执行——**Agent 与人共用一个审批面**;
- `observe_only`:只记录判定,不动值(审计/学习用)。

**缺省策略**:节点绑定 mode=auto → auto_rollback;manual → approve_rollback;产线/preset 可覆盖。

---

## 4. Agent 侧:让团队真正会优化

### 4.1 工具面(三个变更)

| 工具 | 变更 | 价值 |
|---|---|---|
| `dcw_control` | 返回追加 `trialId / 观察窗 / 回退锚提示`("当前 183℃,上一稳定点 182℃;越窗将自动回退") | 写完即知道安全网在哪 |
| `dcw_journal(node_id?, limit?)` **新** | 查参数变更史(谁/何时/从→到/所属 Trial/判定结果) | Agent 能读历史,避免重复试错 |
| `dcw_rollback(node_id? \| trial_id?, to?)` **新** | Agent 自主回退自己的变更(auto);回退他人变更走 HITL | 团队具备"后悔权",失败动作自愈 |

### 4.2 调控作业环:五步 → 六步

现有(industrialLoopGuide):观察→理解→决策→执行与验证→权限边界。
升级为**假设驱动的实验环**:

```
1. 观察     daq_query 真实时序(不变)
2. 理解     my_industrial_nodes 语义卡(不变,新增「当前试验/观察期」段)
3. 假设     声明:目标值 + 预期效果 + 观察窗 —— 写入 Trial.hypothesis
4. 执行     dcw_control(返回 trialId 与安全网信息)
5. 复测     daq_query 对比 Trial 判定;ROLLBACK 时接受回退并修正假设,禁止立即同向重写(cooldown 由系统强制)
6. 定档     KEEP 的 Trial 引用为「已验证经验」;ROLLBACK 的写进结论,作为下次假设依据
```

第 3/6 步是把"优化"从撞运气变成**可积累的实验记录**:Trial 账本就是团队的实验日志,
后续 lead 派任务时可以把历史 Trial 结论注入 context(「该节点 184℃ 曾两次越窗回退」)。

### 4.3 lead/团队层

- 优化任务派发携带 `policy` 与 `observeMs`(任务描述或 preset 声明,经 contextPrefix 注入);
- lead supervise 收到的 worker 结论天然包含 Trial 判定(KEEP/ROLLBACK + 证据),可跨成员汇总。

---

## 5. 增强功能清单(按性价比排序)

| # | 功能 | 说明 | 量级 |
|---|---|---|---|
| 1 | **并发写互斥** | 节点 Trial observing 期间,第二个 Agent 的 dcw_control → 409 带「该节点正在试验中(tr-xx,由 agent-y 发起)」——防互踩,闭环的安全前提 | 小 |
| 2 | **Trial 可视化** | /dcw/[id] 顶部「当前试验」条(变更值/基线/倒计时/实时判定);孪生场景试验中节点 halo 呼吸;结束生成 before/after 对比卡(复用 runData) | 中 |
| 3 | **假设注入上下文** | lead 派优化任务时把该节点历史 Trial 结论(KEEP/ROLLBACK 统计)注入 worker context——团队经验积累 | 小 |
| 4 | **KPI 目标函数** | line/preset 声明质量目标(如 ±2%),Trial 判定从「窗口内」升级为「目标函数改善」——真优化而非不越限 | 中 |
| 5 | **参数边界自学习(远期)** | 从 Trial 账本统计每节点「安全步幅/有效方向/收敛时滞」,反哺语义卡步进指引与 observeMs 缺省 | 中 |
| 6 | **配方 A/B 对跑** | 同产线先后 apply 两个配方版本,Trial 判定自动对比——本期不做,账本已为其备好数据 | 大 |

---

## 6. 实施切分(每个里程碑独立可验证)

| 里程碑 | 内容 | 验证脚本 |
|---|---|---|
| **M1 账本+手动回退** | dcw-journal.ts(write 挂钩/落盘/恢复)+ RollbackService 三粒度 REST + /dcw/[id] 参数史与回退 UI | `_dbg-journal-audit.mjs`(mock:记锚/心跳不噪音/单步回退/批次撤销/护栏 cooldown) |
| **M2 Trial 评估** | dcw-trial.ts(开窗/判定/护栏/自动回退)+ 并发写互斥 + 详情页试验条 | `_dbg-trial-e2e.mjs`(越窗触发自动回退/收敛 KEEP/UNCERTAIN 延长/二次回退升级人工) |
| **M3 Agent 闭环** | dcw_journal/dcw_rollback 工具 + 作业环六步 + policy 传递 + HITL 建议回退 | `_dbg-opt-team-e2e.mjs`(omp 团队:假设→下发→越窗→HITL 批准回退→复测收敛,对齐 scenario 三段式) |

依赖关系:M1 → M2 → M3 严格递进;M1 完成即具备「人工回退」产品价值,M3 完成即赛博团队全闭环。

---

## 7. 明确不做(防蔓延)

- 不做参数 git 分支/merge(撤销栈语义已覆盖工业回退场景);
- 不做全节点全量快照(只锚变更节点,账本量级可控);
- 不做自动寻优/爬山算法(本期只做"带安全网的试错+判定",寻优策略是 Agent LLM 的职责);
- 不动 daq 采样与 TSDB 结构(判定全部走既有查询面)。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 自动回退在慢过程上误杀(热惯性未到就判失败) | observeMs 按节点可配 + UNCERTAIN 优先于 FAIL(只在明确越限时回退)+ 收敛判据只要求步幅 50% |
| 回退风暴(乒乓) | cooldown + 每链 2 次上限 + 第 3 次强制人工 |
| Trial 期间崩溃 | dcw-trials.json 落盘 + restore() 恢复观察窗(对齐 line-run.ts 模式) |
| 保写心跳与回退竞态 | 回退走 write() 单点,心跳保持的是"当前设定值"——回退后心跳自然保持旧值,无竞态 |
| Agent 滥用回退(洗掉别人变更) | 回退他人 Trial 必须 HITL;journal 全量记录 actor,审计可追 |
