# 核心架构与代码审查 + 2026-10-27 加固计划执行报告

日期:2026-10-27
范围:`docs/plans/2026-10-27-daq-dcw-hardening-plan.md` 七项缺口;AgentTeam / 本体 / 求解器 / AML 集成;DAQ/DCW/存储/优化闭环/安全边界。
方法:逐文件静态核查 + 定向单测 + 本地探针(不触真实设备/MES);风险等级按“可利用性与影响面”划分。所有结论附 `file:line`,环境相关项单独标注。

---

## 0. 结论摘要

1. **计划本身可行**:七项缺口全部在源码中复现属实;修复方式确实可以增量落地,不需要改动五层 dispatch、时序库、绑定 v2、fail-loud 驱动占位等骨架。
2. **本轮已落地**:F1(MES 运行时凭据仓)、F2A(配方经验台账)、F3(团队委派 grant 复核)、F4(HTTP 驱动增强 + 统一 SSRF)、F5A(常注入面 i18n)、F5B(host-tools 英文增量目录,14 个高频工业工具)、F7(未开线打标 + 导出护栏设置化);并顺手修复了审查中发现的 5 个高价值缺陷(P0-1 钩子试运行越权、P0-2 产品/配方编辑越权、P1-1 优化器授权空操作、P1-3 HTTP 假回读证实、P1-8 导出计数重复)。
3. **按计划分期、本轮未做**:F2B(配方链路开优化记录,计划本身要求单独评审)、F6(S7 驱动,nodes7 可选依赖 + 实机 PLC 验证不可得)。F5B 只覆盖 14 个高频工具而非全部 104 个,未覆盖工具回退中文。
4. **AgentTeam 确实做到了“按 Agent 绑模型 + 动态注入工具 + 执行期元数据校验”**,但有三处结构性落差:
   - 模型绑定技术上按 `channel_agents` 实例生效,但**没有 per-Agent 模型 UI**,实际运维是“频道级默认模型 + 原始 JSON 覆盖”;
   - 工具注入是**按 Agent 解析绑定面**的,但 `optimizer_profile_propose`、`line_start/stop`、`recipe_propose`、插件工具等存在“注入面/执行面不一致”;
   - 执行期 `tool-verify` 确实用 `agentId` 从数据库重新解析绑定面并逐引用校验,不是信任 prompt;但 REST 面有一批 DCW 读/配置端点只校验登录,构成与 Agent 路径不对称的授权缺口。
5. **本体/求解器/AML 的意义是清晰的**,但“Agent 建骨架、人类可视化管理”的闭环只完成了一半:
   - AML 的孪生场景/物理 spec 有真正的“从绑定节点自动生成骨架”工具;
   - 本体只有空白/克隆草稿,**没有从绑定节点生成实体-关系-规则骨架**;
   - ProcessModelSpec(求解器的前置模型定义)没有 Agent 工具、没有自动生成、UI 也不能发布,是当前“Agent 为主”链条上最大的手工瓶颈;
   - 前端本体页只能看/校验/编译/发布/走审批,**不能编辑实体/关系/规则/绑定/证据**;优化器页缺 crosscheck/dispatch/采纳等关键动作;AML 页缺训练提交与训练计划。

---

## 1. 计划可行性核验(逐项)

| # | 计划结论 | 本轮核查 | 处理 |
|---|---|---|---|
| F1 | `mes.secret` 未注册 schema,只有 env 生效 | 属实:`dcw/drivers/mes-rest.ts` 原 `resolveMesSecret` 仅 env + 试探性 `settingOf`;`shared/config/schema.json` 无 `mes.*` | 已实现运行时凭据仓 + admin REST + env>仓>settings 解析 |
| F2A | 经验台账只认 `kind==='dcw'`,配方流恒空 | 属实:`industrial-context.ts` 原 `recentOptimizationNotes` 只取 dcw 绑定 | 已实现 recipeId 聚合 + 无匹配退参数节点维度 + 无记录如实提示 |
| F3 | `team_grant_nodes/revoke` 在 `GRANT_EXEMPT` | 属实;且这两个工具不在 `INDUSTRIAL_TOOL_NAMES`,原 guard 根本不会拦 | 已从豁免移除、补 workspace 面 guard 调用、补 `node_ids` 解析 |
| F4 | DAQ/DCW http 驱动薄 | 属实:DAQ 恒 GET/5s;DCW 无 secret/SSRF | 已实现 method/body/timeout/auth/secretRef/SSRF |
| F5 | 注入面全中文 | 属实:per-agent 后缀与 industrial-context 为中文;host-tools 约 20 个英文 | 已实现 zh/en 注入 + 英文增量目录(14 高频工具) |
| F6 | S7 纯桩 | 属实:`s7-stub.ts` + registry `PlannedProtocolStub` + catalog `planned` | 本轮未做(见 §5) |
| F7 | 未开线样本四列全 null;导出 200 万点截断 | 属实:`ingest.ts` 原 `lineRun?.lineId`;`MAX_PAGES_PER_NODE=400` | 已实现节点线打标 + 设置化护栏 |
| F2B | 配方面不产生 `rr-*` 优化记录 | 属实:`writeRecipeParams` 以 `source:'recipe'` 写入,`afterWrite` 只为 `agent/rollback` 开记录 | 本轮未做(计划要求单独评审) |

补充事实(计划未列但影响判断):
- `host-tools.json` 中 `daq_export`/`daq_frames` 已经是英文,计划“104 个仅 ~20 英文”偏保守。
- `team_grant_nodes` 原先不在 `INDUSTRIAL_TOOL_NAMES`,所以只从 `GRANT_EXEMPT` 删除不会有任何效果 —— 必须同时在 dispatch 的 workspace 分支调用 guard(本轮已补)。

---

## 2. 核心代码与架构审查

### 2.1 五 plane 对照

设计记录:`docs/audit/2026-10-22-design-validation-report.md:11` 定义 interaction / governance / execution / data / intelligence 五 plane。实现侧模块划分与五 plane 大体对应:
- interaction:`app/` + `runtime/manager` + `agents/`
- governance:`permissions`、`hitl`、`ops/audit`、`approval-gate`
- execution:`agents/host-tool-bridge`、`dcw/dcw-controller`、`dcw/drivers`
- data:`daq/daq-controller`、`daq/bus`、`daq/storage`、`eda`
- intelligence:`aml`、`optimization`、`process-model`、`ontology`

**判断:模块布局成立,但治理不是 plane-wide 不变量**。治理闸只完整覆盖 Agent/MCP 工具路径(`agents/host-tool-bridge/dispatch.ts:112-260`:token → 发起者 scope → channel 工具门 → twin/optimizer 写门 → grant 复核 → 引用校验 → handler);REST 是一套并行的、部分未设防的表面(见 §2.3 P1-9)。

### 2.2 做得好的部分(不是客套,是可复用的骨架)

1. **单一写咽喉点**:所有 DCW 写都经 `dcw-controller/write.ts`,四层限界(节点量程 ∩ 配方参数 ∩ 产品参数 ∩ 配方窗口)+ 步长 + 限速在同一处解析;`param-limits.ts:54-79` 是限界的事实源。
2. **fail-closed 的引用校验**:`tool-verify.ts:321-415` 用 `agentId` 从 DB 取绑定面,逐参数校验 node/line/recipe/dataset/job/model/plan/scene 谱系;异常直接拒绝。它不是“相信模型传的 id”,这点很关键。
3. **HITL 与执行分离**:审批卡只存展示证据,批准时服务端从 DB 重建 payload 并做 8 项复核(`optimization/dispatch.service.ts:119-202`),拒绝 body 注入证据。
4. **驱动占位 fail-loud**:未实现协议返回明确的 `DRIVER_NOT_IMPLEMENTED`,不静默 mock。
5. **计划性降级**:TSDB/对象存储不可达时有本地/内存降级路径,采集主链不被基础设施拖死(但有 §2.3 P1-4 的就绪态缺陷)。

### 2.3 风险清单(按严重度)

> 标注“已修”的项属于本轮顺手修复;其余为遗留,建议按 P0→P1 排期。

#### P0

**P0-1 MES 钩子试运行端点任意登录用户可执行任意 JS(已修)**
- 原:`server/api/workshop/dcw/mes-hook-test.post.ts:20` 仅 `resolveUser`;`mes/mes-hook.ts:282-317` 把用户代码拼进模块并用 `process.execPath` 子进程执行,子进程继承完整 `process.env`;`node_id` 还直接拼产物目录。
- 影响:普通 `user` 即可读环境变量中的 LLM/MES 凭据、读写数据目录;`node_id` 可路径穿越。
- 修复:`requireRole(event,['admin'])` + `node_id` 白名单化。仍建议后续把钩子子进程改为最小环境(`cleanEnv`)。

**P0-2 任意登录用户可改产品限界/删产品/改配方(已修)**
- 原:`dcw/products/[id].patch.ts:12`、`[id].delete.ts:11`、`dcw/recipes/[id]/index.patch.ts:12` 仅 `resolveUser`。
- 影响:产品 `paramLimits` 是四层写的联锁之一,清空后后续写只受节点/参数/配方三层约束;配方 `access.requireAuth` 也可被关闭。
- 修复:三条路由补 `requireLineMode(..., 'operate')`(产品换线时同时校验目标线)。

#### P1

**P1-1 优化器/Process-Model 授权是空操作(已修)**
- 原:`optimization/access.ts:119-167` 用 `try { lineMode(...) } catch { deny }`,但 `lineMode` 返回三态、从不抛异常 → spec/dataset/eligibility/experiment/train 五类资源实际不校验。
- 修复:`requireLineAccess` 读取三态,读类要求 ≥readonly、写/发布要求 operate。

**P1-2 DAQ ingest 接受未来时间戳,随后静默丢样本(未修)**
- `api/workshop/daq/[id]/ingest.post.ts:109-117` 接受 ±1h;`daq-runtime.ts:157-162` 以 `lastIngestAt` 做 late-drop。一次 `at=now+50min` 的合法 ingest 会让真实样本被丢弃最长 50 分钟;文档宣称的回填(-5min)也会被 late-drop。
- 建议:未来时间戳拒绝或钳到 now;回填样本绕过水位线但单独打标。

**P1-3 HTTP DCW 假回读证实(已修)**
- 原:`dcw/drivers/http.ts` 只要响应里有数值就 `ack:'readback-verified'`,不比对设定值;`actuation.ts` 还会把这个回显当作节点确认值,hold 心跳继续重发错误值。
- 修复:改用 `readbackAck` 与 `input.tolerance` 比对;不一致返回 `ok:false, ack:'unverified'`。单测覆盖 `{value:0}` 回显场景。

**P1-4 TSDB 就绪门是空操作(未修)**
- `daq/storage/index.ts:23-48` 的 `tsdbReady` 恒 `Promise.resolve()`;`timescale.adapter.ts:128-130`/`sqlite.adapter.ts:125-127` 在连接未就绪时写路径直接 return,`tsdb-twin.ts` 仍计 stored。启动/切换后端时首槽数据会被报“已存”但实际丢失。
- 建议:写路径在 adapter 未就绪时抛错或返回 dropped,`tsdbReady` 真正等待 init。

**P1-5 Timescale 适配器契约分歧(未修)**
- `tsdb-port.ts:100-107` 的 `queryTaggedPage` 可选;SQLite 实现且返回 `state`,`timescale.adapter.ts:185-241` 不返回 `state`、无分页。后果:AML 清洗 `if (p.state && p.state !== 'ok')` 对 Timescale 恒真通过(alarm/warn 样本进入训练);>500k 点被静默截断。
- 建议:两适配器统一返回 state 并实现分页;无分页时显式报错而不是截断。

**P1-6 最新窗口契约错配(未修)**
- `sqlite.adapter.ts:180-185`/`timescale.adapter.ts:177-181` 都是 `ORDER BY ts_ms ASC LIMIT`;`api/workshop/daq/[id]/samples.get.ts:23-28` 在 `from` 缺省时从 0 开始;UI 只传 `to` + `limit:400` → 画的是最旧 400 桶,且每次刷新窗口不前进。Agent `daq_query` 的 `latest` 也取自这段最旧序列的尾部。
- 说明:此前 MQTT 轮次给 `views.ts samples()` 引入了 `queryLatest`,但该 UI REST 端点未走它,属于“修了一半”。
- 建议:该端点缺省 `from` 时走 `queryLatest`;或至少从 `to` 反推窗口。

**P1-7 AML/Twin 门禁指标可被训练代码写(未修)**
- `aml/python/amlkit.py:86-97` 的 `save_metrics(extra)` 保留训练代码写入的顶层键;`aml/gates.ts:45-76` 的 `artifactKind`/`rolloutImprovement` 与 Twin Gate 的 `metrics.hybrid/uncertainty/physics` 都可被 agent 提交的 `code` 预先写入;`twin/trial-service.ts:115-126` 在缺少 UQ 证据时默认 `calibrationFresh:true, coverage:1`(fail-open)。
- 影响:“平台权威门禁,不是 agent 自报”的声明在实现上不成立。
- 建议:门禁只读平台 evaluator 产出的命名空间(如 `metrics.platform.*`),训练代码写入的键一律剥离;UQ 缺失应 fail-closed。

**P1-8 导出总行护栏重复计数(已修)**
- 原:`daq-export.ts:276-299` 每页 `totalRows += byAt.size` 把累计值重复累加,4M 护栏在约 20 万行就触发;提示文案还写成“单节点 200 万点”。
- 修复:按 `nodeBaseRows + byAt.size` 赋值;文案改为实际护栏名。

**P1-9 DCW REST 读/配置面绕过产线授权(未修,系统性)**
- 仅 `resolveUser`、无 line/role 的端点包括:节点读值与参数台账、全局写日志、优化记录与 `series`(可读任意线 DAQ 时序)、配方/版本列表、任意批次关闭、MES 产物下载、全产线告警、`infra/reconnect`、各 `test-driver`/`test` 探针、全局 DAQ/DCW 模板增删改。
- 影响:认证用户可读任意线数据、触发真实 PLC 读、探测内网、修改其他线共享模板。
- 建议:建立统一 `requireDaqRead/requireDcwOperate` 包装;模板与 infra 归 admin;探针按目标线 operate。

**P1-10 DAQ 节点 PATCH 可跨线迁移(未修)**
- `api/workshop/daq/[id].patch.ts:19` 只校验当前线;`crud.ts:98-102` 接受任意目标 `lineId`。DCW 的 PATCH 已校验目标线,DAQ 没有。
- 影响:操作员可把自己线的节点改挂到别的线,并用其驱动配置污染别的线批次数据。
- 建议:照抄 DCW 的 old+target 双线校验。

**P1-11 默认 MQTT 总线信任 broker 载荷(未修)**
- `daq/bus/mqtt.adapter.ts:82-91` 直接 `JSON.parse` 后强转 `DaqSampleEnvelope`,不校验 topic↔nodeId;`docker-compose.yml:15-18` 默认 no-auth 且暴露 1883；恶意 `at` 可触发 late-drop,非法时间在 Timescale 可炸整批。
- 建议:schema 校验 + topic/node 绑定 + 时间戳钳位 + 默认 broker 加认证/仅本机绑定。

**P1-12 磁盘对象存储允许 `..` 键(未修,条件性)**
- `objectstore/disk.adapter.ts:19-33` 正则允许 `..`;`frames.ts:119-135` 直接读 `objectKey`。在 P1-11 可注入 frame 元数据时,可读任意文件。
- 建议:拒绝含 `..`/绝对路径的 key,`resolve` 后前缀校验。

#### P2 摘要(详见代码位置)

- 多指标报警:一条规则恢复会把节点置 `ok`,另一条仍在 alarm 不会重新 raise(`daq-controller/ingest.ts:152-177`)。
- 帧列表:DB(降序)与 pending(降序)直接拼接后 slice,新帧可能被丢;flush 窗口内 content 404(`frames.ts:98-116`,`tsdb-twin.ts:49-72`)。
- 自动回退链上限是“终身”而非“每次链”(`recipe-rollback.repo.ts:303-306`)。
- 系统 sweep 会覆盖人类/Agent 的判定(`recipe-rollback-manager/judge.ts:23-31`,`sweep.ts:56-66`)。
- `optimization_explorations` 的 `controlAfter` 直接用目标值,未携带 ack/readback(`optimization-tools.ts:96-129`)。
- `lineStart` 先激活窗口后下发参数,失败会留下空参数活动批;并发 start 可双开(`lines.ts:112-123`)。
- `lineStop` 先清窗口后 closeRun,run 行被 cap 淘汰时 404 且跳过收尾(`lines.ts:129-154`)。
- `stopAll` 不停外部 ingest(`tsdb-twin.ts:17-22`)。
- MinIO 适配器忽略 https(`minio.adapter.ts:31` 硬编码 `useSSL:false`)。
- 凭据脱敏只覆盖顶层键,`driverConfig.headersJSON`/hook 代码未脱敏;`/api/system/settings` 对 editor 回传 MQTT/对象存储密钥。
- A2A 面:`message/send` 信任 metadata 中的 `x-aw-permission-scope` 并安装为目标 Agent 的调用 scope;`tasks/send` 允许同频道任意 Agent token 以目标 Agent 身份建任务;`in_reply_to` 无归属校验。(`runtime/manager/a2a.ts:27-39`,`api/workshop/a2a/[agentId]/rpc/index.post.ts:266-273,352-398`)
- `get_queue_overview` 描述为 lead-only 但 handler 只查成员(`tasks.ts:471-472`)。
- `line_start/stop`、`recipe_propose` 未纳入 profile 写守卫,训练/优化频道仍会注入。
- 插件工具在所有 profile/写门之前分发,观察面“物理零写”白名单不约束插件写工具。
- `omp` 的 `config.toolNames` 声明未使用;`effort` 对 omp 实际未传。

### 2.4 架构判断

- **DAO/DCW 的“一个写咽喉 + 一个读工具面”是正确设计**,值得保留;问题不在主链,而在主链之外的 REST 旁路与验证器的 fail-open 默认值。
- **治理与执行耦合点过多**:grant guard、tool-verify、twin/optimizer gate、permission-scope 各管一段,语义重叠但没有统一“资源-动作-上下文”策略引擎。当前可维护,但新增工具时容易漏挂。
- **全球单例(globalThis)是刻意设计**,对 HMR 友好,但测试隔离与嵌入式多实例受限;短期不必改,需在文档中明确“单进程单 DAQ 控制器”的部署边界。
- **DAQ 并非真正独立**:`sweep()` 依赖 DCW 的 `hasAnyActiveRun`,无 DCW 线运行态时不会采样;host-port 抽象存在,但默认实现仍把 DCW 拉进来。边缘只跑 DAQ 的部署不成立。
- **存储适配器契约需要一次收敛**:state、分页、latest 语义三处分歧已经产生真实后果(训练数据清洗、UI 历史、导出截断)。

---

## 3. AgentTeam:模型绑定、工具注入、元数据校验

### 3.1 每个 Agent 绑不同模型 —— 机制存在,产品面不完整

**存储三层**(均为 JSON):
- `channels.llm_json`:频道级默认 provider/model/effort(`db/database/schema.ts:15`,`db/channel.repo.ts:14,41-42`)
- `agents.config_json`:全局 Agent 模板配置(`schema.ts:22-30`,`db/agent.repo.ts:11,55,62`)
- `channel_agents.config_json`:频道内 Agent 实例配置,挂载时从模板复制并可覆盖(`schema.ts:32-39`,`db/channel-agent.repo.ts:49,53,66,80`;挂载合并见 `runtime/manager/admin-agents.ts:31-47`)

**运行时优先级**:实例 config > 频道 `llm_json` > 引擎/全局默认(`runtime/manager/runtime-wiring.ts:58-67`)。registry 随后强制写入身份字段,配置不能伪造 `agentId/channelId/role/token`(`agents/registry.ts:136-176,256`)。

**结论**:
- 技术上**可以**让不同 Agent 用不同模型:直接写 `channel_agents.config_json` 的 `provider/model/effort` 即可,`runtime-wiring` 会按实例下发给 harness。
- 但**没有 per-Agent 模型 UI/端点**:当前 UI 只有频道默认模型选择器(`ChannelSettingsModal.vue:45-111`)与 Agent 模板原始 JSON 文本域(`AgentTemplateEditModal.vue:104-109`);成员编辑只暴露 `systemPromptPrefix`(`EditMemberModal.vue:44-50`)。`PATCH .../agents/:agentId/model` 是 3D 形象资产,不是 LLM(`model.patch.ts:2-5,29-38`)。
- 频道设置里的 `harness` 选择**未持久化**:打开时重置为 `omp`,PATCH 也不发送(`ChannelSettingsModal.vue:107,158-160`),服务端 schema 无 harness 字段。
- harness 语义不一致:`omp` 只发 `set_model`(`omp-agent/client.ts:73-87`)且 `effort` 从未作为参数传给进程;`codex` 只发 model,provider 来自 `CODEX_HOME`;`opencode` 要求 `provider/model` 形式,否则 provider 被写成 `opencode`;`pi` 默认 zhipu/glm 且只认 `thinking` 不认 `effort`。

**建议**:补一个 per-Agent 模型字段与 UI(或至少模板 JSON 的校验提示);把 `effort` 真正映射到各 harness;频道 harness 要么持久化,要么从 UI 移除。

### 3.2 工具提示词是否动态注入 —— 是,且按 Agent 解析绑定面

统一入口:`hostToolsForAgent(agentId, role, channelId)`(`agents/host-tool-bridge/per-agent.ts:96`)。
注入链:
1. `hostToolsForRole` → `scopeHostToolsForRole`:角色过滤(worker 去掉 lead-only)、频道 AML profile(训练/优化/观察/legacy/hybrid)、写守卫、频道插件开关、频道逐工具策略(`catalog.ts:165-289`)。
2. per-agent:无优化器绑定则移除 `optimizer_solve/status/cancel/plan_get`;有绑定则在描述里列 bindingId(`per-agent.ts:100-106,139-149`)。
3. per-agent 资源描述:`daq_query/daq_frames/daq_export` 追加本 Agent 直接绑定 + 频道绑线只读节点;`recipe_*` 追加已绑定配方;`mes_*` 追加配方参数面 MES 点位(`per-agent.ts:20-22,47-86,107-136`),大列表按 `description-budget` 确定性折叠。
4. 各 harness:omp `set_host_tools`(`omp-agent/client.ts:89-91`)、pi 写 `aw-tools-<agentId>.json` 并 `registerTool`(`pi-agent.ts:44-81`,`harness/pi-aw-tools.mjs:11-49`)、codex `[mcp_servers.aw]`(`codex-agent/client.ts:113-160`)、dsh/opencode/claude/one-shot 各自 MCP 注入;MCP 桥 `tools/list` 走 `GET /api/workshop/agent-tools/list?agentId=...` + `x-aw-agent-token`(`harness/aw-mcp-bridge.mjs:48-72`)。
5. 服务端 `tools/list` 从 DB `channel_agents` 解析 role/channel,不信任桥传的身份(`runtime/manager/host-tools.ts:228-233`)。

**这是真正的 per-Agent 动态注入**,不是一份全局 prompt 复制。

**不一致点(需要修)**:
- `optimizer_profile_propose` 不在 `OPTIMIZER_TOOL_NAMES`/`OPTIMIZER_REQUIRES_BINDING`,无绑定 Agent 也会看到,但执行必拒。
- `line_start/stop`、`recipe_propose` 未纳入 profile 写守卫,训练/优化频道仍注入。
- `twin_gate_evaluate` 在优化面注入但 dispatch 拒绝;`optimization_explore` 在 hybrid 注入但只允许优化面。
- 插件工具在所有 profile/写门之后追加(`catalog.ts:254-272`),dispatch 又在 AML 门前处理插件(`dispatch.ts:133-169`)→ 插件写工具可绕过“物理零写”白名单。
- `get_queue_overview` 描述 lead-only,handler 只查成员。

### 3.3 执行期是否把 Agent 元数据注入工具层做 verify —— 是,但仅 Agent/MCP 路径

**身份传递**:
- 进程内 `BaseAgentImpl.bridgeCtx.identity = {agentId, channelId, role, name}`,每次 `dispatchHostTool` 带上(`agents/base-agent.ts:73-115`)。
- MCP/REST 桥只传 `agentId + token`;服务端从 `channel_agents` 反查 channel/role(`manager/host-tools.ts:97-103,130-145`),token 与 `agentId` 必须匹配(`api/workshop/agent-tools/invoke.post.ts:47-52`,`list.get.ts:36-41`)。

**执行期闸序(Agent 路径)**:
1. token/agent 绑定 + enabled(`host-tools.ts:97-103`;`dispatch.ts:116-126` 的人机 scope)
2. 人类发起会话的 scope(`canManageChannel/canUseHighRiskTools`,`runtime/permission-scope.ts:18-73`)
3. 频道逐工具策略(`tools/policy.ts:109-145`)
4. 插件开关/角色/治理(`dispatch.ts:137-168`,`plugin-governance.ts:53-115`)
5. AML/twin profile 门 + optimizer 绑定门 + 直写门(`dispatch.ts:172-250`,`optimizer-gate.ts:23-84`)
6. 工业 grant 复核(按当前 owner 的产线授权;`grant-guard.ts:239-289`)
7. `tool-verify` 统一预检(参数形状 + 引用归属/谱系;`tool-verify.ts:321-415`)
8. handler 内部再校验(如 line_start 的 lead + 绑线、model promote 的 HITL)

**结论**:执行期确实用 Agent 元数据做 verify,而且 `tool-verify` 不是“看 prompt 里写了什么”,是从 DB 重新解析绑定面。问题在于:
- **REST 旁路**(P1-9)没有这套闸;
- `grant-guard` 的 team 委派直到本轮才真正接入;
- A2A metadata 可被同频道 Agent 用来覆盖目标 Agent 的调用 scope(P2 清单);
- 用户经 REST 代 Agent 调用时,审计只记 agentId,不记人类发起者(`host-tools.ts:199-217`)。

---

## 4. 本体 / 求解器 / AML:意义、AgentTeam 集成、人机协作

### 4.1 本体(Ontology)

**是什么**:控制侧语义/知识层,把工业对象(产线/设备/传感器/执行器/过程变量/质量变量/模型/任务/工况)与真实平台对象绑定,产出四类工件:
- `processModel`:特征候选、延迟先验、单调性
- `problemIr`:模板、MV/CV 边界、软正则
- `sceneContract`:变量/约束/推断关系
- `controlGuard`:可执行运行时 guard
证据等级 `candidate_influence < observed_correlation < validated_control`;硬约束必须 `validated_control`,发布还要求 `approved_for_control`;只允许收紧、不允许放宽(`ontology/compiler.ts:115-239`)。

**存在意义**:把“工艺知识”从 prompt/人脑变成**可编译、可审计、可版本化的控制约束**,并在求解器下发前提供 guard 和谱系漂移检查。它不是第二套控制权:guard 只能收紧现有边界。

**AgentTeam 集成**:
- 工具族:`ontology_scene_inspect/node_neighbors/rule_explain/compile_preview/version_compare` 只读;`draft_create/update/validate/autofix/publish_propose` 写草稿/提议发布(`agents/industrial/ontology-tools.ts`,`host-tool-bridge/tools/industrial.ts:101-110`)。
- 执行期:发布版本被 `evaluateOntologyGuardsForNodes` 在优化下发前求值,阻断返回 `ONTOLOGY_GUARD_BLOCKED`(`optimization/dispatch.service.ts:346-353`);Profile 可冻结 `ontologyRefs`,下发前校验内容 hash 漂移(`ontology.service.ts:774-794`)。
- 尚未接通:`artifacts.problemIr` 没有并入求解器 `ProblemIR`(solver 只用 ProcessModelSpec 的 effectiveDomain);`deriveTrainingPriors` 无消费者;twin 没有消费 sceneContract。README 已如实标注这个边界。

**前端人机协作**:
- `/ontology`(`app/pages/ontology/index.vue`)支持:列表/我的草稿、新建(空白/克隆 API 支持但 UI 只传 id/line)、校验、autofix、编译预览、发布、规则生命周期按钮、审批请求/裁决、绑定表、版本对比计数、retire。
- **不能**编辑实体/关系/规则/绑定/证据;这些只有 `PATCH /drafts/:id` 与 Agent 工具。审批 UX 是“一键请求 + 同一用户立即批准”,多管理员部署下会被服务端自审保护拒绝。

### 4.2 求解器(Optimizer)

**是什么**:在冻结的过程模型上做约束设定值优化。链路:
`ProcessModelSpec`(谱系/变量映射/时序/trainer)→ `OptimizationProfile`(模型引用/问题模板/求解器/问题配置,冻结 problemIrHash)→ `OptimizerBinding`(workspace/channel/agent/profile/能力/模式)→ `ProblemIR` → solve → 独立 crosscheck → recommendation → HITL 审批卡 → `applyRecipe(trial=false)`。

**真实求解器只有两个**:
- `linear_mpc_quadratic@1` → Python worker 的 OSQP 稠密 QP MPC(`optimization/python/problems.py:13-150,178-239`)
- `steady_response@1` → SciPy SLSQP 有界优化(`problems.py:242-335`)
- `mpc_optimize` 是启发式候选,不是 QP;`twin_bayes_optimize` 是 AML/twin 面的代理模型 UCB 搜索,不进 optimizer worker。

**存在意义**:把“调参”从经验试错变成可复现的约束优化:模型谱系可审计、问题结构有 hash、求解结果独立复核、下发前多重漂移与限界校验、人工审批。即使 solver 只给 recommendation,它也提供了“为什么建议这个值”的可追溯证据。

**AgentTeam 集成**:
- 只有 `aml_optimization`/`hybrid_twin` 注入 optimizer 工具;`solve/status/cancel/plan_get` 还要求 per-agent 绑定(`per-agent.ts:98-105`,`optimizer-gate.ts:23-48`)。
- 绑定以 `channel_agents.id` 为键,不是模板 id(`db/database/schema.ts:920-940`,`binding.service.ts:40-60`)。
- 模型采纳:`optimizer_profile_propose` 由 Agent 起草新 Profile 版本 → HITL → 发布并重绑(`profile-adopt.service.ts:70-260`)。
- 求解资格(样本量/激励/共线/延迟可观测/动作证据/rollout 改善)在 `process-model/eligibility.ts:91-253`;不合格明确返回缺口。

**前端**:
- `/optimizer` 有 Spec 表单、数据集构建、训练提交、资格评估、Profile 注册/发布、Binding 创建/撤销、Runs 列表与 solve。
- **缺**:capabilities 环境面板、spec 发布按钮、crosscheck、recommendation 详情、dispatch 到配方、cancel/status 轮询、profile 采纳卡、版本历史/retire。且 binding/runs 列表调用全局端点,非 admin 会被 403,页面实际只有 admin 可用。

### 4.3 AML(Auto Modeling Lab)

**是什么**:两层:
1. 数据/模型训练面:带批次标签的时序 → 数据集快照(manifest/spec/report/sha256)→ 训练作业(内置 TS trainer 或用户 Python/hybrid residual)→ G1-G5 平台门禁 → 实验/模型注册 → candidate/shadow/production/retired 阶段。
2. Hybrid twin 面:SceneContract / PhysicsModelManifest / TwinSnapshot / ObjectiveProfile / VirtualTrial / RecommendationCertificate;grey-box 物理 + 有界残差,provider 注册,虚拟试跑只给建议。

**存在意义**:提供**平台权威的模型质量门**与**可回放的虚拟试验**,让优化器用的模型不是“Agent 说自己好”,而是有数据集 lineage、训练门禁、UQ/OOD/物理证据、阶段晋升与审计的工件。

**AgentTeam 集成**:
- 训练频道模板 `chtpl-aml-training-default`(22 工具,无产线写、无 MPC)与优化频道 `chtpl-aml-optimization-default`(`db/database/seed.ts:99-120`);工具面由 `AML_TRAINING_TOOL_NAMES`/`AML_OPTIMIZATION_TOOL_NAMES` 互斥注入(`catalog.ts:37-47,197-226`),dispatch 再按 profile 拒绝(`dispatch.ts:172-221`)。
- 工具:数据集构建/统计、作业提交/状态/日志/取消、leaderboard、模型查找/引用/标注/晋升、训练计划、场景发现/编译/冻结、物理 spec 起草/校验/编译、快照/试跑/MPC/Bayes/gate。
- 模型晋升:Agent 路径 lead-only + HITL(`aml-job-tools.ts:217-261`);hybrid twin 不允许 candidate→production 跳级。

**前端**:
- `/aml` 有运行环境、数据集(创建/统计/清洗/滞后/删除)、作业(列表/取消/重试/删除,无提交表单)、实验 leaderboard、模型阶段/备注/删除/两击晋升、预测台。
- **缺**:训练作业提交 UI、训练计划 UI、模型 label/description 编辑(只有 note)、模型→优化器 Profile 采纳 UI、频道模型绑定(twin-profile.patch 无前端调用)、场景/物理 spec/试跑/MPC/Bayes UI。
- 人类 REST 晋升是两击直达,Agent 晋升才走 HITL —— 两种路径的治理强度不一致。

### 4.4 “Agent 为主、人类为辅”的现状

**已经真正自动生成的**:
- `twin_scene_discover`/`twin_scene_compile`:从 Agent 绑定的 DAQ/DCW/配方参数生成 SceneContract 草稿(角色推断 + 证据);`twin_scene_freeze` 需要人类确认 token,冻结后不可变(`twin-tools.ts:228-321`)。
- `twin_physics_spec_draft`:从场景生成每个状态的一阶松弛方程骨架(可校准 τ/gain,identity observation,约束来自场景)(`aml/twin/physics-spec-draft.ts:1-19,111-185`)。
- `aml_dataset_build`:校验节点在 Agent 绑定面内、同线、产品/配方/批次谱系,构建数据集并返回清洗/滞后摘要(`aml-dataset-tools.ts:133-273`)。
- 优化器模型采纳:Agent 起草 Profile 新版本 + HITL 发布(`profile-adopt.service.ts:70-260`)。

**仍然必须人类/API 手工的**:
- **本体骨架**:`ontology_draft_create` 只给空白或克隆,没有从绑定节点生成实体/关系/规则/绑定;Agent 要手写整个 JSON。
- **ProcessModelSpec**:没有 Agent 工具、没有从绑定/本体自动生成、UI 不能发布 —— 这是“从数据到求解器”的最大手工瓶颈。
- **OptimizationProfile 首次创建**:REST/UI only;Agent 只能对已有 Profile 提议采纳。
- **Profile 的 ontologyRefs**:没有 UI/工具自动填充,不传就没有本体谱系 pin。
- **AML 训练代码/训练 spec**:`aml_job_submit` 需要显式 code 或 hybrid_residual;训练计划需要预先固定的 trainingSpec,而固定它的 REST `PATCH` 没有 UI/Agent 工具。
- **AML 数据集节点/角色与时间窗**:必须显式选择;UI 表单缺 runIds/from/to。

**结论**:Agent-first 在 twin/AML 面成立,在本体与 ProcessModelSpec 面不成立;人类可视化在“看/审/批”面成立,在“编辑实体/规则/绑定/证据”“发布 ProcessModelSpec”“提交训练作业”“配置训练计划”面不成立。

---

## 5. 本轮改动清单

### 新增
- `server/services/workshop/mes/mes-secrets.repo.ts`:运行时凭据仓(原子写、无明文回传、ref 白名单)。
- `server/api/workshop/mes/secrets/{index.get,index.put,[ref].delete}.ts`:admin-only 凭据管理。
- `server/services/workshop/net/ssrf.ts`:统一出站 URL 防护(协议白名单 + 私网/环回 + allowPrivateHost)。
- `server/services/workshop/net/secret-auth.ts`:通用凭据解析、`{{SECRET:REF}}` 头/体插值、认证头、超时钳位。
- `server/services/workshop/daq/export-limits.ts`:导出护栏设置化(缺省 400 页/168h,硬上限 2000/8760)。
- `server/services/workshop/daq/daq-controller/tsdb-row.ts`:TSDB 行装配纯函数(未开线按节点线打标)。
- `server/services/workshop/agents/prompt-i18n.ts`:locale 归一/解析(agent config > channel llm_json > env > zh)、`tr` 双语。
- `.AgentWorkShop/prompts/host-tools.en.json`:14 个高频工业工具的英文增量目录。
- `docs/audit/2026-10-27-core-architecture-review.md`:本报告。

### 修改
- `dcw/drivers/mes-rest.ts`:secret 解析顺序 env > 仓 > settings;SSRF 改用统一模块。
- `agents/industrial-context.ts`:配方经验台账、locale 参数、en 文案、语义卡/配方操作面双语。
- `agents/industrial/grant-guard.ts` + `host-tool-bridge/dispatch.ts`:团队委派 grant 复核、node_ids/grant_node_ids 解析、写族标注;`dispatch_task` 携带授权时同样复核。
- `daq/drivers/http.ts` + `dcw/drivers/http.ts`:method/body/timeout/auth/secretRef/SSRF;DCW 回读严格比对。**SSRF 兼容语义**:存量配置无 `allowPrivateHost` 字段 → 沿用旧行为(允许私网),显式 `false` 才拒绝;MES 仍保持未配置即拒绝。
- `shared/daq-protocol.ts` + `shared/dcw-protocol/catalog.ts`:驱动表单字段。

> 升级提示:HTTP DAQ/DCW 节点若使用内网地址,建议在驱动配置里显式选择 `allowPrivateHost=true`;不配置虽可继续工作,但会失去 SSRF 防护标记。
- `daq/daq-controller/ingest.ts` + `agents/industrial/daq-tools.ts`:未开线打标与 provenance。
- `agents/industrial/daq-export.ts` + `eda/data-export.ts` + `shared/config/schema.json` + `app/config/schema.ts` + i18n locales:导出护栏设置化与文案。
- `prompts/loader.ts` + `host-tool-bridge/{catalog,per-agent}.ts`:英文增量目录加载与 locale 透传。
- `optimization/access.ts`:修复 lineMode 三态授权空操作。
- `api/workshop/dcw/mes-hook-test.post.ts`:admin-only + node_id 白名单。
- `api/workshop/dcw/products/*` + `api/workshop/dcw/recipes/[id]/index.patch.ts`:operate 授权。

### 新增单测
`tests/mes-secrets.test.ts`、`tests/optimization-notes.test.ts`、`tests/team-grant-guard.test.ts`、`tests/http-drivers.test.ts`、`tests/export-limits.test.ts`、`tests/prompt-i18n.test.ts`、`tests/host-tools-en.test.ts`。

---

## 6. 本轮未做与原因

| 项 | 原因 | 建议 |
|---|---|---|
| F2B 配方链路优化记录 | 计划本身标注“建议单独评审”;需要定义 apply→open→rollback/judge 的语义与环形 cap 兼容,牵动回退管理器和配方运行门 | 单独立项,先定义 record 粒度(每次 apply 一条 vs 每节点一条)与判定来源 |
| F6 S7 驱动 | 需要 `nodes7` 可选依赖 + snap7/PLCSIM fixture + 实机 PLC 验证;当前环境不具备,不能诚实标生产级 | 按计划走插件模式或等实机;先在目录中保留 `planned` |
| F5B 全量 104 工具 | 机械工作量大;本轮覆盖 14 个高频工业工具 + 已有英文的 daq_export/daq_frames | 按计划分批补 `ml_*`/`twin_*`/`ont_*`/`team_*` |
| 审查 P1/P2 遗留 | 超出本轮加固计划范围;部分需要产品决策(如 REST 授权矩阵、A2A metadata 契约、存储契约收敛) | 见 §2.3,按 P0→P1 排期 |

---

## 7. 验证基线

- 新增单测全部通过(见 §5);全量 `npm run test:unit` 结果见执行记录。
- `npm run typecheck` 通过。
- 受影响既有套件:`tests/mes-rest-driver.test.ts`(SSRF 重构回归)、`tests/daq-export*.test.ts`(护栏/分页)、`tests/team-grant-guard`、`tests/prompt-i18n`。
- 未跑真实 PLC/MES/IDD;涉及设备的结论均为代码级核查,已在风险条目中标注“环境相关”。

---

## 8. 给决策者的三句话

1. **系统主链是可靠的**:绑定/审批/写咽喉/读工具面/引用校验这套骨架值得继续投入。
2. **当前最大的风险不在模型能力,而在治理覆盖不均**:REST 旁路、A2A metadata、可伪造的 AML 门禁指标,都会绕开你已经建好的五层闸。
3. **“Agent 为主、人类为辅”已经能在 twin/AML 跑通,但要推广到本体与求解器,必须先补三件事:本体骨架生成器、ProcessModelSpec 的 Agent 工具/自动生成、以及前端编辑/发布/训练计划的可视化。**
