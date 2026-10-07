# 多专家评审 + recipe 级下发间隔卡控落地报告(2026-10-07)

> 需求:①多专家分析当前数采/数控功能集成是否合理、能否完成数据获取分析作业;②recipe 级参数下发时间卡控(每配方可配下发间隔,默认 1 分钟,锚=审批时刻,未批准不计时,应急豁免),优化配方参数控制逻辑;③确保 Agent 取数与参数下发不受损;④评估系统设计是否优秀。
> 方法:三专家并行读码评审(数采链路 / 数控 recipe 链路 / 卡控方案设计)→ 按方案实现 → 单测 + 全量回归 + build 重启 + 端到端实测。

---

## 一、专家评审结论

### 专家 A:数采(DAQ)链路 —— **合格(偏优)**
- 分层清晰:单一 `DaqDriver` 接口 + 运行时/网关九层拆分 + TsdbPort 双适配器(Timescale/SQLite 降级);新协议=实现接口+注册登记(`drivers/registry.ts:41`)。
- **模拟与真实驱动同路径**(`daq-controller/state.ts:148`),不存在模拟快捷通道;批次逐样本打标(line/product/recipe/run)。
- Agent 取数面成熟:`daq_query` 默认按活动批次过滤 + `scope=all` 显式放开 + 逐节点 provenance(`daq-tools.ts:104,175`),天然防混批;`daq_export` 补全量原始导出+manifest。
- 判决:**Agent 可以完成数据获取+分析作业**。附使用条件:必须先开 LineRun(否则静默零采集,运维 SOP 要管);极值分析走 `daq_export`(`daq_query` 默认 15s 桶统计会低估极值)。
- 待修(后续轮):MQTT 陈值不做新鲜度检查(设备停发仍复制旧值入库,`drivers/mqtt.ts:139`);导出 CSV 缺 run_id/recipe_id 列。

### 专家 B:数控(DCW/recipe)链路 —— 分层合理,频控存在体系性缺口
- 下发链路四路共用咽喉点(write.ts),预检谓词与执行断言零漂移、失败逐参数透明回显——设计亮点。
- **现有卡控清单**:节点级 60s 写间隔(键=node.lastWriteAt,不审批感知)、按线 trial 节拍(默认 5min,锚=上次 trial 完成时刻)、stepLimit、四层量程、写入保持窗、HITL 绑定门。
- **关键缺口(需求正中)**:①不存在"按 recipe 配置的下发间隔";②审批与计时完全解耦(人工刚批准可能撞上节拍窗 → 批准后 429;挂卡期间照计时);③recipe_apply 整批与 rollback-dispatch 完全无频控;④无应急豁免语义。

### 专家 C:实现方案(略——已按其 file:line 级方案落地,下节)

## 二、落地实现:recipe 级下发操作间隔卡控

**语义(按需求)**:每个 recipe 可配 `opIntervalMs`(缺省 **60000ms**;0=显式禁用;上限 24h)。Agent 下发族操作(recipe_trial / recipe_apply / recipe_propose / recipe_rollback-dispatch)两次**已批准**下发之间必须 ≥ 该间隔;**计时锚 = 上一次 HITL 审批批准时刻**(未批准的提案——挂起/拒绝/超时——不计时、不落锚);按 recipeId 全局键控(多 Agent 共享,防轮番绕频控);锚持久化落盘(重启不清零)。

| 改动 | 位置 |
|---|---|
| `opIntervalMs` 字段(RecipeView/RecipeInput)+ 归一(0~86400000 整数,非法 400)+ 读取器(老配方=60000 零迁移);**治理配置原地改,不增版本不入参数史** | `shared/dcw-protocol/recipe.ts`、`dcw-recipe.repo.ts` |
| 新建锚模块:Map+落盘 `dcw-recipe-op-anchors.json`(cap 200/24h GC);`assertRecipeOpInterval`(429,报错含已过秒数/剩余秒数/emergency 指引)+ `assertRecipeOpIntervalForExecution`(竞态变体文案) | `server/services/workshop/dcw/recipe-op-anchor.ts`(新) |
| **审批锚捕获单点**:`ToolApprovalService.decide()` 批准且 nodeId=`recipe:<id>`/`recipe-propose:<id>` 且非 update → 落锚(at=decidedAt)。两个裁决 UI 入口必经此处 | `agents/tool-approvals.ts` |
| 执行兜底:`applyRecipe` 扩参 `{agentDispatch, agentApprovalId, emergency}`——仅 Agent 路径受查;**approvalId 自豁免**(自己刚获批的不卡自己;不同 id 且锚新鲜=有更新已批单抢先 → 429 竞态拦截);成功后落 `agent-executed` 锚(封 auto 绑定无审批连发);`rollbackRecipeAndDispatch` 透传 | `dcw-controller/recipes.ts` |
| 提案早拒(主防线):四工具在挂审批卡**之前**查频控,被拒不建卡,报错含剩余秒数+`emergency=true` 指引;`recipe_update` 不卡(只写定义不触产线) | `ops-tools.ts`(trial/apply/rollback)、`recipe-propose-tools.ts` |
| **应急豁免**:工具 args `emergency` → 仅跳过频控,**审批照挂**(fail-closed,超时=拒绝);卡片 title/detail 标注【应急】/【应急豁免频控】+ payload.emergency=true,前端审批卡红徽标;ops_log 前缀【应急】+detail 标记。不豁免四层限界/步长/试验节拍/运行门 | 全链 + `RecipeGateApprovalCard.vue` + `host-tools.json`(×2 副本) |
| **人工/系统豁免**:REST apply/开跑/基准恢复不带 agentDispatch 标记,不查不锚(应急纠偏时人必须能立即动手;节点级 60s/保持窗/四层限界照常) | 路径结构保证 |

## 三、测试与端到端实证

**单测** `tests/recipe-op-interval.test.ts` 8/8:默认值兼容/归一化/治理配置不增版本/批准落锚·拒绝不落/update 不计锚/提案早拒不建卡/emergency 豁免频控但审批照挂且标注/执行兜底竞态(异 id 429·同 id 自豁免)/过期与 0 禁用放行。
**全量回归** 181/182(唯一失败 `tool-profile-observer.test.ts` 为既有失败,干净 main 复现,`#imports` 为 nitro 构建期符号,与本轮无关)。

**端到端(生产重启后,注塑二线 rc-d749500f × 频道工艺工程师实例,11/11)**:
1. PATCH `opIntervalMs=90000` 生效且版本不变(v8→v8);非法值 -5 → 400 ✅
2. 开线后 Agent 合法提案 → 建卡 → 人工批准 → **真实整批下发**(保压 66→68bar,批次 rr-f1da5…)✅
3. 窗内立即连发 → **早拒**:"下发操作间隔卡控生效:距现在仅 0s(审批 ap-eda569bd)…要求 ≥90s,请等待约 90s…可用 emergency=true 豁免" 且**未建卡** ✅
4. `emergency=true` → 豁免频控建卡,卡片标注【应急豁免频控】;人工拒绝即不下发(审批不豁免)✅
5. 等待 92s 后普通提案恢复放行建卡 ✅
6. 人工 REST apply 窗内可执行(管理操作豁免)✅
7. Agent `daq_query` 取数正常(数据分析师实例,21 点真实采样,最新 1599.7kN)✅
8. 锚持久化文件落盘 ✅

## 四、系统设计总评(回答"是否设计的优秀")

**总评:优秀偏上,可放心用于"Agent 获取真实产线数据 + 受控参数下发"的作业任务。**
- 数采链路:六协议同路径生产、批次语义逐样本打标、防混批口径、全量导出——达到完成度标准(专家 A:合格偏优)。
- 数控链路:四层限界+审批门+审计留痕是扎实的治理底座;本轮补上最后一块拼图(按配方、审批锚定、应急可豁免的频控)后,频控体系完整覆盖"节点物理防震荡(60s)+ 产线试验节拍(5min)+ **配方治理间隔(可配,审批锚定)**"三层。
- 已知短板(记录在案,不阻塞使用):MQTT 陈值新鲜度、daq 导出无批次列、采集与 LineRun 强耦合的静默停采、`tool-profile-observer` 既有测试坏——建议进后续轮次。

## 五、产物清单

- 代码:`shared/dcw-protocol/recipe.ts`、`server/services/workshop/dcw/dcw-recipe.repo.ts`、**新** `server/services/workshop/dcw/recipe-op-anchor.ts`、`server/utils/errors.ts`、`server/services/workshop/agents/tool-approvals.ts`、`server/services/workshop/dcw/dcw-controller/recipes.ts`、`server/services/workshop/agents/industrial/ops-tools.ts`、`recipe-propose-tools.ts`、`app/components/dcw/RecipeGateApprovalCard.vue`、`.AgentWorkShop/prompts/host-tools.json`
- 测试:**新** `tests/recipe-op-interval.test.ts`(8 断言组)
- 文档:`skills/aw-line-onboarding/SKILL.md` + `.agents/` 镜像(治理红线新增频控条目)
- E2E 脚本:`tmp-e2e/op-interval-e2e.mjs`
