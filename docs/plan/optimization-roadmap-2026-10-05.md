# 优化路线图(2026-10-05 定稿)—— 四架构师方案综合 · 已确认决策版

> 决策记录(用户确认):W1+W2+W3 先行 → castfilm 紧跟 W3 → W5 紧随连做;W4(驱动 v2/资产模型)按期滚动。
> 方案来源:4 个架构师 Agent 独立读码设计,全部结论带 file:line 证据;总工作量一期约 18.5~20 人日,W4 滚动另计(38~52 人日)。

## Phase 1 · 治理正确性(1.5 人日)—— P0
**1.1 排队根预算挤爆(实测缺陷)**
- 改 `scheduler-loop/tick.ts:47-51`:expiredRoots 判定加谓词 —— `state==='SUBMITTED' && snapshot.activeRootId && task.id!==snapshot.activeRootId` 跳过(未入场根不计时);snapshot 已带 activeRootId 零新查询
- 改 `task-engine/lifecycle.ts:95-137` reassign(FAILED→ASSIGNED):补 `refreshDeadline(taskId, now+root_timeout_ms)`(断重试秒死环)
- 边界已验:人工取消/HITL 豁免/root_queue_enabled=false 回退均不受影响;active 根自身有收口故队列必然推进
**1.2 reopen API**
- `POST /api/workshop/tasks/:id/reopen`:仅根任务、仅 FAILED/CANCELED(COMPLETED 409);复制 title/desc/parts/mode,rootQueueSeq 排队尾,新预算;history 首条 `{reopenOf,originCloseReason}` + description 头部 `[reopen:<id8>]`;同源在途 reopen → 409
**验收(9 条)**:排队根在前序超时后仍能执行/不被误杀/重试不秒死/active 根超时原语义/HITL 豁免保留/排队取消/回退模式/reopen 三例/判重回归

## Phase 2 · 可靠性+审计闭环(4.5~5 人日)—— 六项可并行
| # | 项 | 改动点 | 验收断言 |
|---|---|---|---|
| 2.1 | samples 500→404(0.5d) | `daq-controller/views.ts:81` 改抛 AppError;`utils/response.ts` 兜底映射 error.status | 不存在 id → 404 NOT_FOUND |
| 2.2 | 插件驱动进目录(1d) | `plugin-driver-registry.ts:89-106` mergedCatalog 对无 meta 插件驱动兜底条目(plugin:true) | /daq drivers 含插件 kind |
| 2.3 | 工具结果事件(1.5d) | `omp-agent/event-mapping.ts:137` 增 tool_execution_end → status 帧(isError+摘要) | 事件流 start→end 帧对 |
| 2.4 | HITL 未读升级(1d) | `tool-approvals.ts:92-99` 50%/85% TTL 提醒 timer → notifyUser;超时仍 fail-closed | 不应答产生升级通知行,到期拒绝+历史落单 |
| 2.5 | MCP 桥空面拒绝(0.5d) | `aw-mcp-bridge.mjs:44-46` 首拉空/失败 throw(-32603) | 掐断 agent-tools/list → -32603 而非空 tools |
| 2.6 | 16K 全局截断(0.5d) | `host-tool-bridge/dispatch.ts` 统一出口 + export/diag opt-out | 40KB 桩结果 → 落库≤上限+尾注 |
依赖:2.6 先行(2.3 复用其出口)。

## Phase 3 · AML 孪生闭环打通(1 天)—— 双断点同修
**3.1 发现面配方展开**:改 `agents/industrial/twin-tools.ts:227-245` boundSceneNodes —— recipe 绑定→listRecipes→params[].nodeId 展开为 dcw/writable 节点(照抄 industrial-context.ts:127-141 先例),量程=node∩配方工艺窗,maxStep 沿用 2% 缺省
**3.2 绑定快照同改(隐藏第二断点,不改必继续崩)**:`aml/twin/binding-snapshot.ts:233-254` liveBindingSources 把 recipe 行展开为参数 dcw 项(mode 继承,nodeId 去重),消除 normalizedBinding(:299) BINDING_KIND_INVALID
**3.3 控制值服务端化**:snapshot.controlValues 由 dcw.value/配方值填充(twin-tools.ts:390),消除基线自报
**验收**:daq+recipe 绑定 hybrid 频道 → discover(controls≥1)→compile(无 SCENE_NO_CONTROLS)→freeze→snapshot→mpc 出 recommendation;仅 daq 绑定仍无 controls(不放大可见面);legacy dcw 直绑存量不变;grant-guard 撤权即时拒

## Phase 4 · castfilm 孪生 provider 插件(2~3 天)—— 真值对拍能力
- 抽 `plc-node-simulator/src/server/engine/plant-model.ts` 纯函数(CastFilmTruth/steadyState/gridSearchOptimum)成 `twin-castfilm` 项目插件,按 twin-thermal-demo 模板走 `ctx.twin.registerPhysicsProvider/registerScenePack`(provider-loader.ts:21-22)
- gridSearchOptimum 最优窗口 = 现成 ground truth,做孪生 vs 真值对拍验收
- 注意 manifest.sceneId 一致 + providerHash 谱系;真值无 UQ → rollout 用 ensemble 补
- 回归:providerForScene 谱系校验不受影响;injection/thermal 解析不变

## Phase 5 · 开发者体验+语义质量(9.5 人日)—— 紧随连做
| # | 项 | 天 | 要点 |
|---|---|---|---|
| 5.1 | 线程化最小版 | 2 | a2a metadata `x-aw-thread-root`(零迁移);poll 按根折叠 `[线程 n 条]` |
| 5.2 | 记忆治理最小版 | 3 | 度量先行(recall hit/miss,90 天零召回清单);shared 域 cosine>0.92 近邻并入 sourceAgents;矛盾→contested 标记(不做 LLM 自动合并) |
| 5.3 | schema 严格化 | 3 | catalog 生成器分两步:顶层 additionalProperties:false → 嵌套 required;每步三引擎冒烟 |
| 5.4 | value/readValue 语义 | 0.5 | dcw 读写工具 description 补"设定值 vs 实测反馈"(随 5.3 同次再生) |
| 5.5 | replaces 声明 | 1 | 覆盖内置须 manifest 显式 replaces,未声明拒绝注册 |
依赖:5.3→5.4 同次再生;5.2 度量面可先行。

## Phase 6+ · 平台化滚动(W4,另行排期)
- **驱动 v2**:P1 质量位/源时间戳+conformance 骨架(6-8d,里程碑:bad/uncertain 可视化,无静默假数据)→ P2 OPC UA readBatch+MonitoredItems 缓存化+modbus 合并读(8-10d,里程碑:会话级读取)→ P3 subscribe 原语+断链回退(8-12d,里程碑:断网不断流)
- **资产模型**:A1 目录核+一键导入+资产树(6-8d,里程碑:一键生成资产树)→ A2 物模型核+applyControl 模板化(6-8d,里程碑:改模板限值全继承生效)→ A3 scene 模型驱动角色(4-6d,里程碑:scene 证据显示模板来源)
- 耦合:V2-P1 与 A1 可并行先行;不做清单:EtherCAT 主站/OPC UA Server/视频常驻管线/Node 自研时序引擎/三面存储重写

## 总账
一期(Phase1-5)≈ 18.5~20 人日,交付:P0 缺陷清零、审计闭环(工具调用全程可观测)、AML 寻优端到端可演示、真值对拍能力、消息/记忆/schema 语义质量升级。
W4 滚动 38~52 人日,六期各自可演示,全程增量无迁移。
