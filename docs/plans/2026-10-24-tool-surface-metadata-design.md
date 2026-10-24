# 工具面元数据驱动注入与 MCP 全量集成 · 可执行计划 v2

- 日期:2026-10-24(v2,经 omc-plan 共识模式:Planner→Architect→Critic 串行评审)
- 状态:**approved / implemented(WP1–WP9)**;Wave 3(WP10–WP12)按需未做。实施与验收见 `docs/audit/2026-10-24-tool-surface-implementation.md`(444 单测 / 34 MCP live / 33 实机多 Agent / build 全绿;6 处实施偏差已披露)。
- 前置文档:本文件取代同日 v1 设计稿;五席评审纪要见 §2 与 git 历史中的 v1
- 执行约束:每 WP 独立提交粒度、独立验收命令、独立回滚开关;共享文件触碰顺序已排死(§4)

---

## §1 RALPLAN-DR Summary

**Principles(原则,全部为已验证代码事实的推论)**
1. **注入面不是安全边界**:manifest/描述/enum 只是注入优化,服务端每次调用实时重算归属面才是闸门(tool-verify.ts:57 明示不缓存)。
2. **单一事实源**:引用校验规则声明在工具定义上(注册时强制声明),校验在执行时实时——绝不双源漂移、绝不缓存授权判定。
3. **不造新面**:面 B(stdio 桥)就是 per-agent 权威面;一切新入口复用 `/agent-tools/list|invoke` 同链同鉴权。
4. **最小爆炸半径**:分级降级(写拒/读降级)、retrofit 分步(存量零变化)、每个行为翻转带 env 回滚开关。
5. **命令级可判定验收**:每个 WP 有确定命令+期望断言;全量回归门 G0 必须保持绿。

**Decision Drivers(前三)**
1. P0 安全缺陷最快清零(kb_agent 提权参数/ingest 投毒通道/token 无轮换)。
2. 存量零回归:现网基线=test:unit 全绿+test:mcp-live 34/34+工具面单测 49/49,任何 WP 不得打破。
3. 外部 harness 经 MCP 可用工具全集且与原生同治理(面 B 已达成,守住并补缺陷)。

**Viable Options**
- **Option A 单轨顺序**:按 Wave1→2→3 依序实施,不做轨间门禁。Pros:最简单,单实现者串行无协调成本。Cons:P0 与能力项无优先级约束,若中途暂停可能 P0 未清而能力项已动。
- **Option B 安全轨优先+门禁(采纳)**:WP1–4(P0)全部验收绿之前禁止启动 WP5+;轨内按爆炸半径升序;共享文件触碰顺序排死(host-tools.ts 仅按 WP3→WP4→WP7 顺序,tool-verify.ts 仅 WP5 触碰,per-agent.ts 仅 WP6 触碰);每 WP 带回滚开关。Pros:P0 清零被结构性保证;回滚面清晰。Cons:比 A 多一条门禁检查(成本≈0,单实现者串行)。
- **Option C 最小集(WP1–3+WP5 即停)**:已否决。理由:不满足目标"最佳原生+MCP 注入执行"——插件治理盲区(WP8)、读侧 token 缺失(WP10)、描述膨胀(WP6)留存,外部集成价值打折;而 C 省下的 WP 多为低风险纯收益,不做反而留存风险。

**Invalidation rationale**:C 被 Drivers 3 直接否决;A 被 Driver 1 否决(无结构性 P0 保证)。

---

## §2 现状事实基线(2026-10-24 锚点复核,行号为当日工作树实测)

| # | 事实 | 锚点 |
|---|---|---|
| F1 | per-agent 注入主干已存在:角色/档位/插件三层减法+绑定面拼描述 | agents/host-tool-bridge/catalog.ts:161-270;agents/host-tool-bridge/per-agent.ts:91-125 |
| F2 | 执行五层复核单口,工业族过 grant-guard+tool-verify | host-tools.ts:81-161;dispatch.ts:247-256 |
| F3 | tool-verify 引用面每次实时重算,不缓存 | tool-verify.ts:57 |
| F4 | VERIFY_SPECS 48 条手工表;未登记工业工具静默跳过预检 | tool-verify.ts:235-295;**:326** `if (!spec) return null` |
| F5 | 三张 MCP 面:面A HTTP 25 静态(64 会话上限);面B 桥=91 host+插件全量 per-agent、10s 轮询 list_changed;面C 38 个 aw_* 静态+aw_agent_tool_invoke 透传 | workshop.ts:25;mcp/aw-mcp-server.mjs:554;server/harness/aw-mcp-bridge.mjs:27,65,77 |
| F6 | channelToolGate 故障 fail-open(降级 mode='all');与 tool-verify fail-closed 相反 | policy.ts:21,99,74-77 |
| F7 | 插件工具不经 grant/verify/HITL;kb_agent permission 参数调用方透传、缺省 bypassPermissions | dispatch.ts:135-162;rag-bridge/index.mjs:289 |
| F8 | token 无轮换(patch schema 零 token 字段)、明文落盘 tmpdir、仪表盘明文回显、比较用 `!==`;**token 校验共四路调用点**:host-tools.ts:85(内存比较)、channel-agent.repo.ts:88 findByToken(SQL 精确匹配,经 resolveAgentByToken 供 invoke.post.ts:48 与 list.get.ts:22)、面A requireCaller→manager.findByToken(workshop-server.ts:74-81)、host-tools.ts:275 | channel-agent.repo.ts:54,61,88;agents/[id].patch.ts;admin-channel.ts:376;host-tools.ts:85,164,275;workshop-server.ts:74-81 |
| F9 | ingest 兜底仅 resolveUser(不查 lineMode,实测 :77-78)、`at` ±7 天回填(:91)、标量不过 transform/量程(:150-153) | ingest.post.ts:77-78,91,150-153;对照口径 samples.get.ts:16 |
| F10 | 读侧无 token API(用户会话 query 按产线权限≠Agent 绑定面);协作面工具(跨频道消息/记忆)不经 grant/verify | query.get.ts:19;dispatch.ts:277-312 |
| F11 | OmpPluginTool 为插件工具接口定义(无 references/riskClass 字段);registerPluginTool 在同文件后部 | plugin-tools.ts:26-38(接口),99(注册表) |

## §3 回归门 G0(每 WP 验收前必跑,全绿才准继续)

```
npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/aw-mcp-server.test.ts tests/tool-registry-policy.test.ts tests/tool-verify.test.ts tests/tool-face-authz.test.ts tests/high-risk-tool-scope.test.ts tests/host-tools-quality.test.ts tests/tool-profile-observer.test.ts tests/tool-approvals-choice.test.ts   # 69/69
npm run test:unit        # 全量单测 0 fail
npm run test:mcp-live    # 34/34
npm run build            # exit 0
```

## §4 工作包(WP1–WP12,按执行顺序)

### 安全轨 Wave 1(P0 清零,WP5 启动的门禁)

**WP1 铲除 kb_agent 调用方可控权限**(F7)
- 改动:`server/plugins-builtin/rag-bridge/index.mjs` 删除 `permission`/`harness` 两个入参(schema :289 与 handler 取值处 :302-305),转发 body 固定写死 `permission:'default'`(标准审批档,不再缺省 bypassPermissions)、不再携带 harness;调用方仍传这两参→忽略+audit warn。
- 验收:`tests/kb-agent-permission.test.ts`:①schema 无 permission/harness 字段;②handler 构造的 body 恒含 `permission:'default'` 且调用方传 `bypassPermissions` 不出现在 body;③audit 出现 warn;④集成冒烟:对真 rag-knowledge 后端提交一次 sync query 成功(证明后端接受 'default' 档;若后端枚举拒绝,改取后端标准非 bypass 档常量并回填本计划后再出门禁)。G0 绿。
- 回滚:插件文件单文件还原即回滚(无 schema 迁移)。

**WP2 ingest 兜底鉴权+回填窗收紧**(F9)
- 改动:`server/api/workshop/daq/[id]/ingest.post.ts` ①兜底路径(未配 AW_DAQ_INGEST_TOKEN,实测 :77-78)补 requireLineMode(operate,对齐 samples.get.ts:16 口径);②`at` 回填窗默认 ±1h(:91),env `AW_DAQ_INGEST_BACKFILL_MS` 可调(上限仍 7 天);③抽 `resolveIngestAuth(event)` 纯函数便于单测。**发布说明必须写明:纯 PLC 无用户会话部署若依赖兜底路径,升级后需配置 token 或会话,否则推送 403。**
- 验收:`tests/daq-ingest-auth.test.ts`:未配置 token+无 lineMode→401/403;operate 会话→放行;`at` 超窗→422;`npm run test:api-live` 追加 2 断言(普通注册用户推送→403;operate→200)。
- 回滚:env `AW_DAQ_INGEST_BACKFILL_MS=604800000` 恢复旧宽窗(见 R3:超 1h 配置启动时 audit warn);鉴权部分不可回滚(P0 定位即目的)。

**WP3 token 生命周期——校验收敛单点**(F8,Architect R1 修正)
- 改动:①repo 层新增统一判定 `isTokenValid(row, token)`=`timingSafeEqual`(定长归一,异长度不抛)+ grace 判定,`findByToken` 查询加 grace 分支(当前 token 或 grace 未过期的旧 token 均命中);**四路调用点全部改走该单点**:host-tools.ts:85、resolveAgentByToken(host-tools.ts:164,背后 repo findByToken)、面A requireCaller(workshop-server.ts:74-81 经 manager.findByToken)、host-tools.ts:275。②`channel-agent.repo.ts` 加 `rotateToken(agentId)`(新 randomUUID,旧 token 记 grace_until=now+`AW_TOKEN_GRACE_MS` 缺省 60s);`server/api/workshop/agents/[id]/rotate-token.post.ts` 新端点(属主/admin,audit action=`agent.token.rotate`)。③`admin-channel.ts:376` 与 `helpers.ts instanceToAgentInfo` 改回 `tokenTail`(后 4 位),全量仅 rotate/reveal 一次性返回+audit。omp/codex 重连由既有 ensureClient 覆盖;面A 旧会话下一请求宽限内 200、宽限外 401(与 WP9 不冻结语义自洽)。
- 验收:`tests/agent-token-rotation.test.ts`:rotate 后旧 token **桥 invoke 200、桥 tools/list 200、面A Bearer 200**(三路宽限断言),`AW_TOKEN_GRACE_MS` 过期后三路均 401;tokenTail 长度=4 且不含全量;`timingSafeEqual` 异长度不抛;api-live 追加 1 断言(reveal 落 audit)。
- 回滚:grace 窗 env 调大;tokenTail 为纯响应字段收缩,前端一次性显示组件随 WP3 一并交付。

**WP4 token 来源调用全量 audit**(F10 协作面外传通道最小收敛)
- 改动:`invokeHostTool`(host-tools.ts)对经桥/HTTP token 路径(`input.token!==undefined` 可判定)的**协作面工具**(send_cross_channel_message/save_memory/poll_messages 族)调用写 audit_log(action=`tool.call.collaboration`,level=info)——不改变可达性(桥主循环依赖 poll_messages,host-tools.ts:204-213,不可断),只补溯源。
- 验收:`tests/collab-token-audit.test.ts`:token 路径调 poll_messages→audit 有记录;进程内路径不重复记录。
- 回滚:env `AW_COLLAB_AUDIT=0` 关闭。

**WP4b kb_agent 入库动作接 HITL 审批**(F7 投毒链闭合点,Architect R2 提进门禁;Critic M1 重定位后的正确机制)
- 机制前提(Critic M1 勘误):diag-bridge v2.1 **已无服务端自动入库**——`server/plugins-builtin/diag-bridge/host/diagnosis.mjs:79-82` 明示入库由 Agent 调 rag-bridge kb_agent 完成,plugin.mjs:227/321-323 与 sweep.mjs:46 只发放文字指引。**真实写库发起处 = rag-bridge kb_agent handler**(`server/plugins-builtin/rag-bridge/index.mjs:300-335`,转发 prompt 到后端 `/api/kb/agent/chat`),审批强制点落在这里。
- 改动:①kb_agent schema 增 `action: 'query'|'ingest'`(缺省 query;描述写明入库/经验沉淀必须 action=ingest);②handler:action=ingest→先经 `tool-approvals.ts` request 挂 HITL 审批单(载全量 prompt+mode+调用方可选转抄的 source 元数据如 diag_run_id),批准后才提交后端,拒绝返回 isError+audit;action=query 直通不受影响;③防绕过:action 缺省但 prompt 命中入库意图启发词(入库/沉淀/经验/ingest;词表不可能穷尽全部语言措辞,属**辅助防线而非完备防线**,残余风险由审计抽查+WP8② kb_agent 声明 riskClass=write 根治)→拒绝并提示改用 action=ingest(保守误拒优于漏放);④谱系:source 为调用方转抄(diag 回执携带 run 引用),平台不强信 prompt,审批单+audit 记录全参可追溯。
- 验收:`tests/diag-kb-approval.test.ts`:action=ingest→产生待审批单;批准→后端收到提交(mock ragCall 断言 body);拒绝→不提交+audit 有记录;action=query 不产生审批单;入库意图 prompt 且 action 缺省→被拦截并提示;审批超时默认拒绝(复用 tool-approvals.ts:181-191 现行为)。
- 回滚:审批模式开关(manual→auto);启发词拦截 env `AW_KB_INGEST_GUARD=0` 关闭。门禁语义不变:关闭"kb 免审入库"。

**门禁:WP1–4b 五个新测试文件+G0 全绿后,方允许 WP5+。门禁判据=攻击面闭合(调用方可控提权+ingest 投毒通道+kb 免审入库+token 无轮换四项全部关闭),不是"部分 WP 绿"。**

### 能力轨 Wave 1(纯收益)

**WP5 references 声明化单源化**(F3/F4,本计划核心)
- 改动:①先跑对账脚本(新增 `scripts/tool-spec-audit.mjs`):列出 VERIFY_SPECS↔host-tools.json 差集(已知:dcw_control/param_control/dcw_rollback 空桩不在 json;exp_collect 底座注册)——对账结果作为迁移清单写入提交说明;②host-tools.json 工业工具逐个加 `references:[{param,kind,mode}]` 或 `noRefs:true`(48 条上收);`registerPluginTool`(plugin-tools.ts:26-38)加同形可选字段;③`syncToolRegistry` 校验:工业工具未声明→写族拒绝登记+读族告警 audit;④tool-verify 改读 def.references,**删除 VERIFY_SPECS**;env `AW_TOOL_VERIFY_LEGACY_SPECS=1` 保留旧表一个版本周期作回滚;⑤CI:新增单测断言 `INDUSTRIAL_TOOL_NAMES ⊆ 声明集`。
- 验收:`tests/tool-verify.test.ts` 219 断言不改一行全绿(行为等价证明);`tests/tool-references.test.ts` 新增:漏声明的模拟写族工具被 sync 拒绝、读族告警入 audit、`noRefs` 放行;`scripts/tool-spec-audit.mjs` 输出差集为空;**env `AW_TOOL_VERIFY_LEGACY_SPECS=1` 启动时写 audit warn+ops-log 呈现**(安全开关回归可见性,R3)。
- 回滚:legacy env 开关(带 boot-time audit warn);host-tools.json 为包内文件,git 还原即回滚。
- 命名映射(Architect R8):`references[].mode:read|write` 与 `noRefs` 语义对齐 MCP annotations 的 `readOnlyHint/destructiveHint`,字段注释写明映射关系,为 WP12 透传预留,避免二次迁移。

**WP6 描述预算+resources 工具+桥 ETag**(F1/F5)
- 改动:①`per-agent.ts:105-123` 绑定面拼接改确定性折叠函数 `foldBindings(text, budget=400)`:超预算截断为"绑定 N 节点(示例 3 个)…用 my_industrial_nodes 查询",**同绑定面输出逐字节稳定**(排序+稳定截断点);②新增工业工具 `industrial_resources`(kind 分页枚举绑定面,复用 agentToolResources 数据源,只读无引用参数);③桥 `tools/list` 响应带 ETag=工具面签名(aw-mcp-signature.mjs 已有),请求带 If-None-Match→304 空体。
- 验收:`tests/tool-description-budget.test.ts`:同一绑定面两次编译字符串全等;200 节点绑定折叠后每工具 description≤预算,**折叠产物必含 `my_industrial_nodes` 引导语**(R5);`tests/industrial-resources.test.ts`:分页/越界/kind 过滤;桥 304:扩展 `scripts/_audit/aw-mcp-live-e2e.mjs` 追加 2 断言(二次 list 带 ETag→304;签名变后→200)。
- 张力记录:预算 400 字 vs 工具选择质量——折叠迫使模型先调 my_industrial_nodes(多一跳),不折叠则大绑定面撑爆上下文+list_changed 风暴;裁决与依据入 ADR(R5)。
- 回滚:预算函数 env `AW_DESC_BUDGET=0`=不折叠(原行为);ETag 为纯增量,客户端不带 If-None-Match 行为不变。

### 能力轨 Wave 2(治理深化)

**WP7 channelToolGate 分级降级**(F6)
- 改动:`policy.ts` ①目录/策略读失败→返回最近已知快照(进程内缓存,staleness>5min 标记 stale)+audit warn;无快照→`mode='selected'`+空集(全拒);②调用方(dispatch)按工具族分级:工业写族/管理面 stale 或无快照→拒;读面/协作面→放行+响应头/结果带 `degraded:true`;③"未知工具放行"契约保留(policy.ts:78)。
- 验收:`tests/tool-registry-policy.test.ts` 新增 3 断言:模拟 DB 抛错→写族拒/读族 degraded 放行/未知工具不拦;快照 5min 过期→同拒绝路径;**env `AW_POLICY_DEGRADE=open` 启动时写 audit warn+ops-log 呈现**(R3)。
- 回滚:env `AW_POLICY_DEGRADE=open`(等价现 fail-open,灰度观察期用,boot-time audit warn)。

**WP8 插件治理四步 retrofit**(F7)
- 改动(顺序即爆炸半径升序;①的 `references/riskClass` 字段命名已按 R8 对齐 MCP annotations 语义):①`OmpPluginTool` 接口加可选 `references/riskClass`(plugin-tools.ts:26-38 接口定义处);②dispatch 插件分支:声明了 references 才走 verifyIndustrialToolCall,未声明保持现状(存量零变化);③插件 handler 结果写 audit(action=`plugin.tool.call`);④sync 插件未声明→告警不阻断(**前置勘察:registry.ts 插件登记失败路径实际行为,Architect R7 指出原"硬 fail 改 warn"无实证锚点,执行前先重勘再定改点**);⑤kb_agent 入库审批已由 WP4b 以 `action:'query'|'ingest'` 契约实现并前移进 Wave-1 门禁,此处仅保留 WP8①-④ 治理框架与该契约的集成回归(kb_agent 声明 riskClass=write 后统一走插件治理链)。
- 验收:`tests/plugin-governance.test.ts`:声明 references 的模拟插件越权引用被拒;未声明存量插件行为逐字节不变(现网 38 插件用例回归);diag→kb 入库产生待审批单。
- 回滚:每步独立提交;②③由 env `AW_PLUGIN_GOVERNANCE=0` 一键回旧。

**WP9 面 A 会话 TTL**(F5)
- 改动:`server/api/mcp/workshop.ts` 会话表加 lastSeen,空闲>30min 回收(惰性,新请求触发清扫);initialize 不冻结 token→agent 映射(每请求重解析)。
- 验收:`tests/mcp-workshop-sessions.test.ts`:构造 31min 空闲会话+新请求→会话数回落;token 轮换后旧会话请求 401。
- 回滚:env `AW_MCP_SESSION_TTL_MIN=0`=永不过期(现行为)。

### 能力轨 Wave 3(按需,P0 与 Wave1/2 全绿后)

**WP10 派生票+读 API**(F10)
- 改动:①`POST /api/workshop/agent-tickets`(agent token 鉴权)→短时票 TTL≤1h(env 可调),票面固化=读白名单[daq_query/daq_frames/daq_export]∩当前绑定面快照;②`GET|POST /api/workshop/agent-data/query|export` 持票→内部直调对应 host tool 同链(复用 faces 校验);**用票时三重复验:agent 仍启用、token 未轮换(rotate 即撤销该 agent 全部未到期票)、目标节点仍在当前绑定面内(绑定收窄后旧票对已移除节点失效)**(R4+Critic S1);export 加行数≤100 万/窗≤7d/每票日配额 10 次;成功读入 audit+并发闸≤2(复用 data-query.ts:60,132 模式)。
- 验收:`tests/agent-data-ticket.test.ts`:无票 401;过期票 401;白名单外工具名 403;export 超配额 429;成功读 audit 有记录。
- 回滚:不签发票=功能关闭;端点独立无存量耦合。

**WP11 ingest 批量+来源标记+量程校验**(F9)
- 改动:ingest 接受 JSONL 批量(≤50 节点×≤1000 点/请求);标量默认过 applyTransform+量程校验(节点可按 `skipValidation:true` 关闭);强制 `source:measured|synthetic` 字段随样本落库;`aml_dataset_build` 谱系带 source,synthetic 样本不计入 lineage_verified。
- 验收:`tests/daq-ingest-batch.test.ts`:批量入库条数/量程越限拒/synthetic 标记落库;`tests/optimizer-dataset-lineage.test.ts` 追加:synthetic 数据集 lineage_verified=false。
- 回滚:批量入口新参数,量程校验 per-node 开关,source 字段对旧写入方缺省 measured。

**WP12(条件项)HTTP MCP 薄适配器**
- 触发条件:出现真实外部 harness 需要 HTTP MCP 形态的用户请求。实现:stdio 桥同协议包一层 HTTP(复用 list/invoke 端点与双通道鉴权,invoke.post.ts:36-63 照抄),零新授权体系。无触发不实施。

## §5 总验收标准(执行完成的定义)

1. G0 四命令全绿,且全量单测新增 ≥5 个测试文件、0 fail。
2. WP1–4b(安全轨)全部验收断言通过——**门禁判据=攻击面闭合四项**:调用方可控提权(WP1)、ingest 投毒通道(WP2)、kb 免审入库(WP4b)、token 无轮换(WP3)全部关闭。P0 清零是"完成"的必要条件,允许 WP10–12 未做而不可允许 WP1–4b 未做。
3. WP5 行为等价:tool-verify 既有 219 断言零修改通过+差集对账为空。
4. MCP 面:面 B 工具数≥91+插件、`tools/call` 同链(test:mcp-live 34/34 保持+WP6 追加 2 断言);面 A/C 静态面不变(防 scope 蔓延)。
5. 文档:README 工具口径更新(91/38/25)+本文件状态翻 `approved/implemented`+审计报告落 docs/audit/2026-10-XX-tool-surface-implementation.md(含每 WP 验收输出)。

## §6 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| WP5 差集对账失误→工业工具被误拒 | 高 | legacy env 开关一个版本周期;对账脚本先行且差集=空是 WP5 验收硬条件 |
| WP3 rotate 打断在线桥会话 | 中 | 60s 宽限+桥既有重连;rotate 端点审计可追溯;grace env 可调 |
| WP7 改变故障期行为 | 中 | `AW_POLICY_DEGRADE=open` 灰度开关;先 audit 观察一周再撤开关 |
| WP8 触碰存量插件行为 | 中 | 四步各自独立提交;未声明=现状,38 插件用例回归锁行为 |
| 描述折叠改变签名→list_changed 抖动 | 低 | 折叠确定性是 WP6 验收硬条件(逐字节全等) |
| 安全 env 开关被配置回归静默打开(宽窗/降级/旧表) | 中(Architect R3) | 三个开关启动时 audit warn+ops-log 呈现,列入 WP2/WP5/WP7 验收断言 |
| host-tools 并行会话冲突 | 低 | 共享文件触碰顺序已排死(§4),单实现者串行天然规避 |

## §7 Pre-mortem(三场景)

1. **"WP5 上线后产线 Agent 全部工具被拒"**:根因=对账脚本漏了底座注册工具(exp_collect 类)。前置缓解:对账差集=空为验收硬条件+写族才拒、读族仅告警+legacy 开关 10 分钟回滚。
2. **"token rotate 后车间 3 台网关集体掉线"**:根因=网关未在 60s 内重连。缓解:grace env 调大至 300s;rotate 前置检查该 agent 活跃桥连接数并在响应中提示;audit 可定位掉线时间窗。
3. **"fail-closed 翻转遇 SQLite 抖动,操作员绕开 Agent 直接上机"**(影子操作路径比短暂降级更危险):缓解=读面降级可用+degraded 标志(不硬拒读);写面物理安全优先必须拒——分级正是为此设计。

## §8 测试计划

- **unit**:每 WP 一个新测试文件(§4 各验收);工具面既有 8 文件 69 断言+tool-verify 219 断言为行为等价基准。
- **integration**:`npm run test:api-live` 追加 ingest 鉴权 2 断言+token reveal 1 断言;`tool-registry-e2e.mjs`/`tool-face-batch-identity-e2e.mjs`(需隔离实例时跑)。
- **e2e**:`npm run test:mcp-live`(34+2 断言);WP8 后跑 `test:e2e-line`(44 断言)确认 HITL 链无回归;WP10/11 后跑 optimizer live(W 段治理链)。
- **observability**:audit_log 新 action 清单=`tool.call.collaboration`/`plugin.tool.call`/`agent.token.rotate`/`agent.ticket.issue`/`policy.degrade.warn`;ops-log 面板可过滤;每 WP 验收输出落 docs/audit/evidence/。

## §9 ADR

- **Decision**:采纳 Option B(安全轨优先+门禁),按 WP1–12 顺序实施;WP12 条件项。
- **Drivers**:见 §1。
- **Alternatives considered**:单轨顺序(A,缺 P0 结构性保证)、最小集(C,不达目标)、schema enum 收窄/manifest 缓存/第四张 MCP 面(v1 草案三项,被 2026-10-24 反方评审以代码证据否决:enum 毁 tool-verify 教学式软拒 tool-verify.ts:132-142 且 pi 会话静态不生效 pi-agent.ts:72-82;缓存失效键不完备——频道绑线 per-agent.ts:33-43/优化器绑定/档位均无版本号;第四面与既有通路重复——面C 已有 aw_agent_tool_invoke 透传 aw-mcp-server.mjs:554,桥双通道鉴权 invoke.post.ts:36-63,再造面=鉴权/治理/审计三重写)。
- **Why chosen**:P0 清零被门禁结构性保证;每 WP 独立验收+回滚开关使单实现者串行执行风险最小;不新增授权体系与协议面。
- **Consequences**:verify 规则从代码表迁到声明数据(一次迁移成本);故障期行为从静默放行变为分级降级(需灰度);新增 5 个 audit action(审计面变宽);token 校验收敛单点后 rotate 语义全局一致(四路调用点同源)。
- **记录的权衡张力(Architect R5 + Critic S1)**:①WP6 描述预算 400 字 vs 工具选择质量——折叠多一跳(my_industrial_nodes)换上下文安全与 list_changed 稳定;若未来实测工具选择质量下降,替代方案=tool search/延迟加载(服务端检索工具而非全量注入),列入评估。②WP10 票面"固化绑定面快照≤1h"与原则 2"绝不缓存授权判定"字面冲突——裁决:票面快照仅限**只读白名单∩绑定面**且 TTL≤1h,用票时三重复验(启用/未轮换/绑定面未收窄)实质保持实时性,配额+审计兜底;原则 2 所指"授权判定不缓存"针对写面与归属面,读票是带复验的限期凭证,不构成违例。③原则 3"同链同鉴权"与 WP10 票据鉴权措辞差异——票是 agent token 的短时派生,后端仍直调 host tool 同链,鉴权面收敛不分裂。
- **Follow-ups**:WP12 触发评估(HTTP MCP 对齐 OAuth 授权而非裸 token);MCP annotations 透传(references/riskClass→readOnlyHint/destructiveHint,字段映射已在 WP5/WP8 预留);elicitation/sampling 评估(把 tool-approvals HITL 映射为 MCP 原生交互);tool search 延迟加载评估;工具风险分级(riskClass)未来接入 Channel 策略 UI;绑定面版本号(若未来需要 manifest 缓存再议)。

## §10 Changelog(v1→v2,共识改进记录)

- v2 由 omc-plan 共识模式产出:Planner 初稿→Architect→Critic 串行评审后合并改进(见下方评审记录)。
- 相比 v1 的实质变化:①验收从"断言描述"升级为命令级(A 命令+期望);②工作包排序改为安全轨门禁制;③新增共享文件触碰顺序、pre-mortem、测试计划、ADR;④10 处锚点在 2026-10-24 工作树复核校正(tool-verify.ts:326/workshop.ts:25/aw-mcp-server.mjs:554 等)。

### Architect 轮(SOUND WITH CHANGES,R1–R8 已全部合入)
- R1(必改)WP3 重做:token 校验实为四路调用点(host-tools.ts:85/164、275、面A requireCaller),宽限双接受下沉 repo `isTokenValid`/findByToken 单点,验收补"桥 invoke+桥 list+面A Bearer 宽限内 200"三路断言——否则 rotate 后桥立即 401。
- R2(必改)门禁重定义:WP8⑤ 前移为 WP4b(diag→kb 接 HITL)进 Wave-1 门禁,门禁判据从"WP 验收绿"升级为"攻击面闭合四项"(§5.2)。
- R3(必改)三个安全 env 开关(BACKFILL_MS>1h/DEGRADE=open/LEGACY_SPECS=1)boot-time audit warn+ops-log,列入验收断言;§6 增对应风险行。
- R4(建议)WP10 用票时复验 agent enabled+token 未轮换,rotate 撤销未到期票。
- R5(建议)ADR 记录 WP6 预算张力;折叠产物必含 my_industrial_nodes 引导语升为验收断言;follow-up 增 tool search 评估。
- R6(必改)§2 锚点勘误:host-tools.ts:90→85;ingest 兜底→77-78、±7d→91;samples.get.ts:19→16;plugin-tools.ts:26-38 实为 OmpPluginTool 接口(新增 F11);F5 补 server/harness/ 前缀。
- R7(建议)WP8④ 原"registry.ts 硬 fail 改 warn"无实证锚点→改为前置勘察项。
- R8(建议)references/riskClass 与 MCP annotations 建立语义映射,W WP12 透传预留(WP5/WP8 已写明)。
- Architect 对用户核心关切的判断:per-agent 动态注入+同链治理优于 OpenAI function calling 静态全局 schema,优于/等于 Claude Code/Cursor 按项目注入;面 B 签名+list_changed 即业界通知机制;industrial_resources≈tool search 服务端实现。

### Critic 轮(第 1 次:REVISE → M1/M2 修复)
- 判定:REVISE,范围收窄——仅 WP4b 一节不合格(机制前提与代码事实不符:diag-bridge v2.1 已移除服务端自动入库,入库实为 Agent 居间调 kb_agent),其余 95% 维持;六项质量门五项 PASS(可测试验收实测 96%≥90%,锚点率 ≈85%≥80%)。
- M1(阻塞,已修):WP4b 重写——机制前提更正(diagnosis.mjs:79-82/plugin.mjs:227,321-323/sweep.mjs:46 为锚),审批强制点重定位到 rag-bridge kb_agent handler(index.mjs:300-335),新增 `action:'query'|'ingest'` 契约+HITL 审批单+入库意图启发拦截;验收断言在新强制点下重写仍可判定;门禁语义"关闭 kb 免审入库"不变。
- M2(轻量,已修):WP1 固定权限档现定值 `permission:'default'`,验收增集成冒烟(后端拒绝该档则取标准非 bypass 档回填后再出门禁)。
- S1/S2(不阻塞,已落):WP10 用票三重复验(增绑定面未收窄);ADR 补三项张力记录与 v1 否决理由代码锚点。
- 复审方式(Critic 自定):M1+M2 修复后 Critic 直接复审;若门禁语义改变需 Architect 确认——本次语义未变,故仅 Critic 复审。

### Critic 终局复审(第 2 次:**APPROVED WITH IMPROVEMENTS,共识达成**)
- M1 复核通过:四处新锚点全部实证,强制点 index.mjs:300-335 精确命中(:327 注释"重试会重复入库"反证此处即写库发起处);验收 6 断言全部命令级;门禁语义成立。
- M2 复核通过(含回填协议闭环);S1/S2 复核通过(ADR 张力裁决推理成立);§5.2 门禁四项语义自洽确认。
- 改进项 I1-I3(不阻塞,已合入):I1 WP1 handler 锚点 :313-315→:302-305;I2 WP4b③ 启发词补"辅助防线非完备防线"残余风险说明;I3 WP8⑤ 措辞与 WP4b 契约统一+per-agent.ts 全路径注法。
- 质量门终值:可测试验收 ≈96%,锚点率 ≈88%。**计划具备直接启动执行条件,待用户批准后按 WP1→WP12 顺序执行。**

