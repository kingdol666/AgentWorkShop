# 多专家设计审查整改验收报告(P0×2 + P1×11)

- 日期:2026-10-28
- 输入审查:`docs/audit/2026-10-28-multiexpert-design-review.md`(P0×2 已亲验 / P1×11 / P2×28)
- 验收规范与实施计划:`docs/plans/2026-10-28-multiexpert-remediation-plan.md`(AE-1…AE-20)
- 本报告结论:**P0×2 + P1×11 全部落地并由可复跑测试锁定;全量门禁与回归套件全绿;真实场景(Qwen3.5-9B + omp,worker 身份)17/17 通过。28 项 P2 未纳入本轮(清单见第六节),不声称"全部修复"。**

---

## 一、总览

| 维度 | 结果 | 证据 |
|---|---|---|
| lint | **0 error** | `logs/logs-ralph-lint-it4.log`(exit 0) |
| typecheck | **0 error** | `logs/logs-ralph-typecheck-it3.log`(exit 0) |
| 单测 | **739 / 739 PASS**(基线 712 + 新增 27) | `logs/logs-ralph-unit-it2.log` |
| 生产构建 | PASS | `.omc/logs-ralph-build1.log`(Build complete) |
| 真实场景(Qwen3.5-9B + omp) | **17 / 17 PASS** | `report.json`、`task.json`、`prompt-injection.json`、`logs/logs-ralph-real-it3.log` |
| API 实时端到端 | **61 / 61 PASS** | `logs/logs-ralph-apilive4.log` |
| 产线治理 E2E | **44 / 44 PASS** | `logs/logs-ralph-e2eline.log` |
| MCP 契约 | 14 / 14 PASS | `logs/logs-ralph-mcp.log` |
| 插件生命周期 | 22 / 22 PASS | `logs/logs-ralph-plugin.log` |
| SDK 出口面 | PASS | `logs/logs-ralph-sdk.log` |
| Skills 规范 | 124 / 124 PASS | `logs/logs-ralph-skills.log` |
| 本体离线 E2E | 57 / 57 PASS | `logs/logs-ralph-ontology2.log` |
| Twin provider 单测 | PASS | `logs/logs-ralph-twin.log` |
| 安全验收 29 项 | 未在本轮复跑(见 §5.3) | 上一轮:`docs/audit/evidence/2026-10-28-security-hardening/report.json` |

---

## 二、P0 修复与验收

### P0-1 Modbus 字节序(静默错数据)

**缺陷**:`little` 分支实际解出 **BADC**(注释写 DCBA、UI 标 CDAB、写侧 encodeWords 又是第三种)→ 真实 DCBA/CDAB 设备静默读成 `~1e-41` 量级错值,参与告警与训练集。

**修复**:
- `server/services/workshop/daq/drivers/modbus-tcp.ts:159` — `decodeRegisters` 三序重写:big=ABCD、wordSwap=CDAB、little=**DCBA**(每字字节反转 + 字序反转)。
- `server/services/workshop/dcw/drivers/shared.ts:224` — `encodeWords` 的 `little` 同步为 DCBA,写/读严格互逆。
- `shared/daq-protocol.ts:299`、`shared/dcw-protocol/catalog.ts:125` — 标签改为 `little=小端(DC BA / 全字节反转)`、`wordSwap=字交换(CD AB / 仅换字序)`。

**验收(AE-1)**:`tests/multiexpert-p0.test.ts` 5 条
- 12.5f 在 ABCD/CDAB/DCBA 三种寄存器布局下均解出 12.5;
- 旧缺陷回归:DCBA 寄存器走 `little` 得到 12.5,不再落入 `1e-41`;
- encode→decode 在三序 × {float32,int32,uint32} 六个值上 0 误差互逆;int16 不受序影响。

> 兼容性说明:`little` 的语义被显式纠正(此前事实上的 BADC 是非标准行为)。存量节点若按旧行为标定过需复核一次;写后回读仍自洽。

### P0-2 掩码凭据回写(凭据损坏 / 节点永久 offline)

**缺陷**:视图脱敏把口令替换为 `******`;前端整包 PATCH 回写时后端直接 merge → 真实口令被字面量覆盖。

**修复**:
- `shared/daq-protocol.ts:541` — 新增 `MASKED_SECRET` + `stripMaskedSecrets()`(入口单点剔除敏感键的掩码值,新明文照常写入)。
- `server/services/workshop/daq/daq-controller/crud.ts:44/64`、`server/services/workshop/dcw/dcw-controller/crud.ts:41/90` — create 与 patch 全部经此过滤。

**验收(AE-2)**:`tests/multiexpert-p0.test.ts` 第 5 条 —— 脱敏→整包回写后掩码键被丢弃、真实值不变;新明文正常生效;非敏感键即使值恰为 `******` 不误伤。DAQ/DCW 两条路径同源。

---

## 三、P1 修复与验收(AE-3…AE-14)

### A-P1-1 帧指标告警持续态

- 修复:`server/services/workshop/daq/daq-runtime.ts:168-176` —— 帧分支只做"活性"(offline→ok),`warn/alarm` 的进入与恢复由 `ingestFrame` 的指标边沿语义独占。
- 验收:`tests/multiexpert-p1-daq.test.ts` "A-P1-1" —— 越限后连续 3 帧保持 `alarm`,恢复后回 `ok`(旧实现第 1 帧后就被抹回 ok)。

### A-P1-2 停线补种被乱序游标吞掉

- 修复:`server/services/workshop/daq/daq-controller/push.ts:26` 新增纯函数 `retainedSeedPlan`(补种时间戳 = **补种时刻**),`checkPushLiveness` 改用之。
- 验收:同文件 "A-P1-2" 两条 —— 计划返回 `atMs=now`(非缓存到达时刻);运行时对旧到达时刻判 `late`、对补种时刻判 `ok` 并入库(复现旧缺陷的丢弃语义)。

### A-P1-3 外部 ingest 绕过 sink 管线

- 修复:`server/services/workshop/daq/daq-controller/ingest.ts:23` 新增 `processExternalFrame`(委托 `processFrameSample`);`server/api/workshop/daq/[id]/ingest.post.ts:147-190` 图像/向量帧统一走该入口 —— 模板 sink(thumbnail/derive-metric/qualityGate)、对象存储、sha256/size 全部服务端生成。
- 验收:同文件 "A-P1-3" 两条 —— 图像帧生成 `thumbKey` 且 sha256 为 64 hex、size 与载荷一致、缩略图可读回;向量帧的 `derive-metric` 指标出现(请求只给原始点列)。

### B-P1-1 系统兜底回退是陈旧决策

- 修复:`server/services/workshop/dcw/recipe-rollback-manager/sweep.ts:31-50` —— `captureMetrics` 返回后重验:`status==='open'`、`judge==null`、`openRecordOf(node)==本记录`;任一不满足只补记 `windowAgg`,**零写入**。
- 验收:`tests/multiexpert-p1-write.test.ts` 三条 —— 人工判 `uncertain` 后零回退且判词不被覆盖;新 open 记录接管后旧记录不行动;无干扰时仍正常自动回退(反向断言防"修死")。

### B-P1-2 配方频控"查-做-记"跨 await

- 修复:`server/services/workshop/dcw/recipe-op-anchor.ts:59` 新增 `beginRecipeOp/endRecipeOp`(在飞占位,同步原子);`dcw-controller/recipes.ts` 把节拍判定改为"判定+占位同一同步段"(`claimTrialCadence`),整批写入包在 try/finally 里。
- 验收:同文件 "B-P1-2" 两条 —— 并发两次 agent 下发恰一次成功、另一次 `WRITE_FREQUENT` 且文案含"在飞占位";并发两次 trial 只放行一次;释放后可再次下发。

### B-P1-3 委派路径可无 confirm/无审计摘 HITL

- 修复:`server/services/workshop/agents/node-delegation.ts` —— 缺省 mode 改 **manual**(不继承 lead 的 auto);`mode=auto` 且目标当前非 auto 时必须 `confirm === true`,否则 `DELEGATION_MODE_CONFIRM_REQUIRED`;`applyDelegation` 对 auto 授予写 `binding.mode` 审计。`team-delegation.ts` / `tasks.ts` / `host-tools.json` 同步 confirm 参数与说明。
- 验收:同文件 "B-P1-3" —— 无 confirm 拒绝且零绑定;缺省全 manual;confirm 后落库 auto 且审计可查。另更新 `tests/node-delegation.test.ts` 以锁定新不变式(旧断言正是被修复的漏洞)。

### B-P1-4 recipe_update 审批期定义比对

- 修复:`server/services/workshop/agents/industrial/ops-tools.ts:763` —— 进入 HITL 前记录 `version + 目标参数值` 指纹;批准并完成 grant/context 复核后再读库比对,变化即拒绝(不静默并入已变定义)。
- 验收:同文件 "B-P1-4" —— 审批窗口内并发编辑另一参数,批准后返回"定义已被其他操作修改…重新提交",版本与参数均未固化本次批准。

### C-P1-1 停机窗口消息黑洞

- 修复:`server/services/workshop/runtime/mailbox.ts:59` `enqueue()` 返回 boolean(闭箱 = false,不落库);`channel-runtime.ts:79` 只把受理成功的收件人计入 `delivered`;`manager/runtime-wiring.ts:240` `stopAndDetach` 在**第一个 await 之前**同步立墓碑 + 摘 `agentIndex` + 摘频道成员 + 清作用域,完成后解除墓碑;`ensureAgentRuntime` 对墓碑直接返回 undefined。
- 验收:`tests/multiexpert-p1-runtime.test.ts` 两条 —— 闭箱 enqueue=false 且不落库;停机窗口 route 返回 `[]`,开箱后正常送达。

### C-P1-2 人类调用作用域失败路径永久卡死

- 修复:`agent-runtime/message.ts` 新增回合落定回调 `onInvocationSettled`(无论是否回执都触发);`manager/state.ts` 统一 `activeScopeOf/setInvocationScope/clearInvocationScope` 并委托 `permission-scope.ts:settleInvocationScope`;`chat.ts`/`a2a.ts` 投递失败即撤销作用域;`stopAndDetach` 同步清除。
- 验收:同文件第三条 —— 同调用清除、不同调用保留、无 deliveryId 兜底清除、未知 agent 安全返回。运行时侧由回调接线(`runtime-wiring.ts:118`)保证失败回合也会收口。

### C-P1-3 停滞看门狗"工具活性"对 omp 恒空

- 修复:`host-tool-bridge/dispatch.ts:42` 在**全引擎唯一分发入口** `noteToolActivity()`(omp 原生/pi/11 引擎 MCP 桥/REST 同源);`manager/state.ts` 的 `toolActivityOf` 取 REST 回程与注册表的并集。导出 `toolActivityAt/resetToolActivity` 供观测与测试。
- 验收:同文件第四条 —— 只调用 `dispatchHostTool`(不经 `invokeHostTool`)即刷新活性,按 agent 隔离。

### D-P1-1 Timescale 适配器缺 state/ingested_at 与分页

- 修复:`daq/storage/timescale.adapter.ts:231` raw 查询补 `state, ingested_at` 并按 sqlite 同口径映射;新增 `queryTaggedPage`(游标严格 `> afterTs`、`limit`、`done/nextCursor`)。
- 验收:`tests/multiexpert-p1-storage.test.ts` 四条 —— 与 sqlite **同输入逐字段等价**(queryTagged 与 page × limit 1/2/10);`ingested_at=NULL` 的存量行不注入 `ingestedAt`;无连接池安全返回空页。

### D-P1-2 owner-FK 老库迁移丢列

- 修复:`db/database/migrations.ts:239` `migrateDropOwnerFks` 的重建列清单补齐 channels 的 `scenario_prompt/llm_json/visibility/join_policy/approval_policy/chat_enabled/version/line_id` 共 8 列(共 17 列),并重建索引。
- 验收:同文件两条 —— 构造带 `users` 外键的旧库(17 列含数据)升级后:外键消失、**列集与升级前逐列相等**、`scenario_prompt/llm_json/line_id/version/config_json` 等业务值全部保留、索引重建;二次初始化幂等。

---

## 四、真实场景作业(Qwen3.5-9B + omp,worker 身份)

脚本:`scripts/e2e-multiexpert-remediation-real.mjs`(隔离实例 3411 + `.output` 生产构建 + 本机 LM Studio `qwen3.5-9b-32k` + 真实 omp 子进程)。
场景:一条产线(DAQ 测温 + DCW 温度设定 + 产品/配方,开跑,数采网关启动)→ 建 AgentChannel(lead + **worker**)→ worker 绑 DAQ(auto)/DCW(manual)→ 给 worker 直接下发任务。

| 断言 | 结果 |
|---|---|
| R1/R1b/R1c/R1d 实例就绪、admin、产线开跑、数采网关启动 | PASS |
| R2 AgentChannel 创建(lead + worker 成员) | PASS |
| R2b worker 绑定落库(daq=auto / dcw=manual) | PASS |
| R3 **运行时提示词注入**:执行模式卡(manual)+ DCW 语义卡(名称/安全量程/单步 ≤4C/**手动确认模式**)+ DAQ 语义卡 | PASS |
| R4 工具注入面携带 worker 绑定节点(`recipe_trial` 描述含 dcw id) | PASS |
| R5 worker 任务 COMPLETED | PASS |
| R5b 工具链 `my_industrial_nodes → daq_query → recipe_trial`(交付物含样本数/均值+回执) | PASS |
| R6/R6b/R6c 手动模式挂 HITL、卡面展示 hypothesis、下发获**设备证实** | PASS |
| R7 节点实际值 → 56;trial 不写配方版本;账本新增锚点;数采查询端点可读真实样本 | PASS |

关键证据(`report.json` / `task.json` / `prompt-injection.json`):
- worker 交付物:`daq_query` 4 桶 / 49 原始样本 / 均值 107.04C;`recipe_trial` "试验已整批下发并全部设备证实(1/1,批次 rr-…)温度设定→56C [证实✓]";
- 审批卡:`配方试验候选(整批 1 参数):温度设定 60→56C | 假设:基于数采集证据…`;
- 提示词注入文本含:`### ⚙ 频道执行模式:manual`、`#### ◆ 温度设定 [id=dw-…]`、`安全量程: [0, 100] C(硬联锁,越界即拒)`、`单次调幅硬上限 ≤4C`、`**手动确认模式**`。
- `complete_task` 未被模型调用:平台按交付物隐式收口为 COMPLETED(`completedExplicitly=false`,已在证据中标注)。

---

## 五、设计完整性评估与产线可上线裁定

### 5.1 逐项成立性(以代码锚点为准)

| 能力 | 成立性 | 机制与锚点 | 边界/风险 |
|---|---|---|---|
| **数采镜像**(物理信号 → 平台观测) | **成立** | 节点=边缘运行时:`daq-controller/state.ts` 采样 → 模板域(量程/单位/标定) → sink 管线(`daq/frames.ts`:resample/derive-metric/zones/thumbnail/quality-gate) → 队列(`bus/queue-port`)→ TSDB(`storage/tsdb-port`:sqlite/Timescale 双后端)+ WS/AEP(`ingest.ts` broadcast `daq.reading/daq.frame`);轮询/被动订阅/外部 ingest **三路同源**(本轮修复 A-P1-3);乱序/未来时间戳防御(本轮 A-P1-2/S12) | "镜像"是**观测镜像**,不是物理机理孪生;mock 驱动无物理耦合。协议:modbus-tcp/rtu、opcua、mqtt、http、mes-rest(+插件);**无 S7**;标定**仅线性** |
| **数控(DCW)** | **成立** | 写咽喉 `dcw-controller/actuation.ts:28` `executeWrite` → 驱动写入 + 回读 → `verifyRecipeWrite`(写后独立读补验)→ ACK 分级(`readback-verified/transport-ack/unverified/failed`);四层限界 `param-limits.ts:158`(量程∩参数∩产品∩配方)+ 单步上限 + 写保持窗 + 60s 频控 + 在飞占位(本轮 B-P1-2);账本 `dcw/journal` + 优化记录 + 回退防回旋 | 真机写依赖驱动实现与设备寄存器约定;**回读一致性**决定 ACK 等级;多进程写锁仍按单进程约束 |
| **AgentChannel 创建** | **成立** | `POST /api/workshop/channels`(含 lead)+ `POST /channels/:id/agents`(成员);频道 profile 载执行模式、场景 prompt、LLM、工具面(`/tools` all|selected);行绑定 `/channels/:id/line`(只读扩权) | 成员 token 不再随列表回显(S3);轮换端点一次性给全量 |
| **worker 绑定节点 + 运行时提示词注入** | **成立** | 绑定仓储 `agents/node-bindings.repo.ts`(kind=daq|dcw|recipe,mode/provenance);运行时每回合拼 prompt:`prompt-builder.ts:94` 注入 `buildIndustrialContext`(产线工况简报)+ `nodeSemanticCards`(`industrial-context.ts:117`:执行模式卡 + 逐节点语义卡:量程/窗口/单步/当前值/操作守则);工具描述按 agent 绑定增强(`host-tool-bridge/per-agent.ts`),执行面 `dispatch` 的 grant-guard 同源 | 语义质量取决于节点/模板 semantics 的填写;空语义会显式标注"待补" |
| **取数** | **成立** | `daq_query` → `eda/data-query`(产线/打标过滤、桶降采样、≤2/用户并发、TTL 缓存)→ TSDB;本轮真实场景 worker 取到 4 桶/49 样本 | 大批量导出走 `daq_export`(有上限与授权);线内默认只读 |
| **HITL 下发** | **成立** | 权限门 `recipe-gate.ts`(recipe 绑定 ∨ 节点覆盖集,运行门,二级认证)→ 审批卡 `hitlDispatchGate`(卡面带参数对照与 hypothesis)→ 人工批准 → `revalidateApprovedAction`(绑定/grant/上下文/定义指纹,本轮 B-P1-4)→ 写咽喉 → ACK → 审计/通知 | 审批人看到的 `from` 取配方基线(不是节点实时值)——**已在档待修**;真实场景中卡面 60→56 与设备实际一致 |

### 5.2 上线裁定

**结论:可进入"受控试点",不可直接上生产。**

- 已在真实 harness(omp)+ 真实模型(Qwen3.5-9B)下跑通"Channel→worker 绑定→提示词注入→取数→HITL→设备证实→审计"全链,本轮 17/17。
- 但**设备侧仍是内置 mock**:DAQ 数值由 mock 生成、DCW 写入由 mock 回显/独立读补验,**没有物理工艺响应耦合**。软件链正确 ≠ 现场闭环正确。
- 上线硬门(全部满足才可试点生产):
  1. **协议匹配**:现场 PLC/仪表协议在支持列表内(modbus-tcp/rtu、opcua、mqtt、http、mes-rest);S7 需另做驱动。
  2. **寄存器/字节序标定**:按设备手册逐点核对 dataType/byteOrder/scale/offset(本轮 P0-1 后 little=DCBA);上线前用已知值做一次写读比对。
  3. **回读通道**:优先 `readback-verified`;无独立读通道的写点必须人工确认 ACK 等级可接受。
  4. **限界与单步**:节点量程/配方窗口/产品限值/单步上限按工艺规程配置,并做一次"越界必拒"演练。
  5. **HITL 演练**:手动模式一条真实写请求,验证卡面信息、批准人身份、拒绝附言回流。
  6. **回退演练**:`recipe_rollback(dispatch=true)` 在试点线演练一次,确认账本/优化记录闭合。
  7. **安全开关**:`AW_BENCH_MODE` 不得设置;MQTT broker 必须鉴权且只绑内网;匿名 broker 禁止。
  8. **审计留存**:`ops_log`/`dcw journal`/审批历史可导出并保存 ≥ 一个批次周期。
- 建议节奏:只读观察 24–72h → 单点人工写 → 单参数闭环 + 回退演练 → 单参数 auto。

### 5.3 关于安全验收 29 项

上一轮 `security-acceptance`(S1–S16)在**同源代码**上 29/29 通过,证据在 `docs/audit/evidence/2026-10-28-security-hardening/report.json`;本轮未修改 S1–S16 的判定逻辑(S2 相关 DAQ 分权、S15 编码范围在改动文件中被保留并被单测覆盖)。该套件需要一套专门的 `scenario.json/admin.json` 场景工件(未入库),本轮未复跑,不冒充"已复跑"。

---

## 六、P2 遗留(28 项,本轮不做)

按审查报告"随版本"处理。未纳入本轮的理由:不阻断生产上线,且多数需要独立设计(TSDB 断连回灌、时钟回拨、配方删除级联、双入口 502、ROOT_QUEUED 滞留、schema.sql 42 表漂移等)。逐项清单以审查报告第 41 行为准;本轮已顺带覆盖的相关项:

- D-P1-1 的 `queryTaggedPage` 同时消除"500k 截断取最旧段"在训练/导出路径上的退化(P2 相关)。
- B-P1-1 的 await 后重验同时覆盖"回退写回坏值"的并发面(P2 相关)。
- B-P1-3 的单一入口收敛同时覆盖 C-P2-7(lead 授 auto 无门槛)。

---

## 七、复跑方式

```bash
npm run lint
npm run typecheck
npm run test:unit                      # 739
npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit \
  tests/multiexpert-p0.test.ts tests/multiexpert-p1-daq.test.ts \
  tests/multiexpert-p1-write.test.ts tests/multiexpert-p1-runtime.test.ts \
  tests/multiexpert-p1-storage.test.ts
npm run test:api-live                  # 需 3001 实例
npm run test:e2e-line                  # 自起隔离实例(3997)
npm run test:mcp && npm run test:plugin-lifecycle && npm run test:sdk-surface && npm run test:skills
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-ontology.mjs
node scripts/e2e-multiexpert-remediation-real.mjs   # 真实 omp + 本机 Qwen3.5(需 LM Studio 1234)
```
