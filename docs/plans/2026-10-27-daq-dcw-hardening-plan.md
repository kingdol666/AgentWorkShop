# 数采/数控缺口修复计划(2026-10-27)

> 状态:**已执行(2026-10-27)**。F1/F2A/F3/F4/F5A/F5B(14 个高频工具)/F7 已落地并通过单测与类型检查;
> F2B(配方链路优化记录)与 F6(S7)按计划分期保留(前者要求单独评审,后者依赖 nodes7 + 实机 PLC)。
> 执行报告见 `docs/audit/2026-10-27-core-architecture-review.md`。
> 原则:**不破坏现有架构**——全部修复为增量式(新增文件 + 小幅修改既有函数),不动五层 dispatch、统一时序库、绑定 v2、fail-loud 驱动占位等骨架设计。

## 核查结论摘要

| # | 缺口 | 结论 | 证据 |
|---|---|---|---|
| 1 | S7 纯桩 | 属实(预留插槽从未实施) | s7-stub.ts:12-29;registry.ts:29;daq-protocol.ts:375-380 status='planned' |
| 2 | 注入面全中文无 i18n | 属实 | per-agent.ts:114-127 中文字面量;industrial-context.ts 全中文;host-tools.json 104 工具仅 ~20 个英文描述 |
| 3 | DAQ http 驱动薄 | 属实 | http.ts:20 恒 GET、5s 硬编码;daq-protocol.ts:366-374 仅 url/jsonPath/headersJSON |
| 4 | mes.secret 未注册 schema | 属实(TODO 在案) | mes-rest.ts:271-273;schema.json 无 mes.* 键;当前仅 env AW_MES_<REF>_TOKEN 生效 |
| 5 | team_grant_nodes 豁免 grant 复核 | 属实(低危,执行面仍拦) | grant-guard.ts:47-52;node-delegation.ts:71-95 只查静态绑定 |
| 6 | 优化经验台账对 v2 失效 | 属实 | industrial-context.ts:336 filter kind==='dcw';配方流(rr-*)不开记录 |
| 7 | 未开线样本无批次打标 + 导出 200 万点截断 | 属实(设计代价非 bug) | ingest.ts:63-74 lineRun null → 含 line_id 在内四列全 null;daq-export.ts:28 MAX_PAGES_PER_NODE=400 |

---

## F1. mes-secret 运行时凭据仓(P1,~0.5 天,风险低)

**目标**:让 `secretRef` 除 env 外有完整的运行时配置路径,兑现 mes-rest.ts:271 的 TODO。

**方案**(零明文原则不变,与 Mimosa 约束一致——凭据只存运行时数据目录,不进源码/示例/测试):

1. 新增 `server/services/workshop/mes/mes-secrets.repo.ts`:JSON 落盘 `server/data/mes-secrets.json`,结构 `{ [ref]: { value, updatedAt, updatedBy } }`;复用 daq-node.repo 的 loadJsonFile/saveJsonFile 模式。内存 API:`getSecret(ref)` / `setSecret(ref, value, by)` / `listRefs()`(只回 ref 名与 updatedAt,不回 value)/ `deleteSecret(ref)`。
2. REST 管理端点 `server/api/workshop/mes/secrets/*`(index.get 列 ref 名、index.put 写、`[ref].delete` 删;`requireRole('admin')`);写路径打 audit(`recordOps`),value 永不入日志。
3. `mes-rest.ts` `resolveMesSecret`(266-281)解析顺序改为:**env → 凭据仓 →(保留)settingOf 试探**。改动约 4 行。
4. 前端 MES 驱动表单 hint 补一句“凭据经 env 或 管理端配置”(不改表单结构)。

**测试**:单测(解析顺序 env 优先/仓回退/插值 `{{SECRET:REF}}` 未解析整头省略);e2e:authType=header + secretRef 从仓解析 → 200,ref 删除后 → 头省略。

## F2. 优化经验台账接入 v2 配方面(P1,分两阶段)

**目标**:配方绑定 Agent 的注入面不再恒空。

**阶段 A(纯读修复,~0.5 天,风险低)**——只改注入端 `industrial-context.ts:333-353`:
- `recentOptimizationNotes` 聚合面从 `kind==='dcw'` 扩为:daq/dcw 绑定照旧按 nodeId;**recipe 绑定 → 以 `binding.nodeId`(recipeId)匹配 `records` 中 `recipeId` 字段**(OptimizationRecord 已有该字段,closed-loop.ts:98),无匹配再退参数节点维度。
- 无记录时注入一行如实提示:`(该配方暂无历史调控记录)`——避免模型误判为查询失败。

**阶段 B(写路径开记录,~1.5 天,风险中,建议单独评审)**:
- `recipe_apply` 成功后 `rollbackManager.open(...)` 开 OptimizationRecord(setAt=下发时刻,params=配方参数 from→to,recipeId 必填);`recipe_rollback` / 下一次 apply / 停线对账时闭记录并写 judge(verdict 由回退 reason 与复测窗口聚合推导,复用现有 windowAgg 归属制)。
- 兼容性:records 环形 cap 2000 不变;`dcw_judge` 旧工具不动;作业环提示词(industrial-context.ts:316)同步改为指向新记录面。

**测试**:阶段 A 单测(recipe 绑定聚合匹配 recipeId);阶段 B e2e(apply → 记录 open → rollback → judge=rollback → 注入面出现历史)。

## F3. 补 team_grant_nodes 的 grant 复核(P1,~0.5 天,风险低)

**目标**:收掉“lead 被撤权后仍可建授权表”的结构性残留。

**方案**:
1. `grant-guard.ts:47-52` 从 GRANT_EXEMPT 移除 `team_grant_nodes` / `team_revoke_nodes`(保留 aml_activity / exp_collect,两者确属纯协作面)。
2. `resolveTargetLines`(69-80)为这两个工具补参数解析:`node_ids` → 逐 nodeId 经现有 `nodeIdLine` 助手映射产线。
3. 语义:`team_grant_nodes` 按**写族要求 operate**(建立的是含写面的授权);`team_revoke_nodes` 按**只读复核**(收权是收敛动作,不该因撤权者失权而失败)。
4. 存量兼容:无主 channel(owner NULL)豁免逻辑照旧生效。

**测试**:单测(admin 撤用户线授权 → lead 调 team_grant_nodes 被拒并列明细;revoke 不受影响);既有 team 委派 e2e 加负例。

## F4. DAQ/DCW http 驱动增强(P2,~1 天,风险低)

**目标**:接标准 REST 数据源不必绕道 mes-rest 或自写插件。**保持向后兼容**:存量 driverConfig(url/jsonPath/headersJSON)行为逐字节不变。

**DAQ 侧**(`shared/daq-protocol.ts:366-374` configFields + `daq/drivers/http.ts`):
- 新增 configFields:`method`(GET/POST,缺省 GET)、`bodyTemplate`(POST 时;`{{value}}` 不适用采集侧,支持静态 JSON 模板与 `{{SECRET:REF}}` 头插值)、`timeoutMs`(钳 1s–60s,缺省 5000)、`authType`/`authHeaderName`/`secretRef`(复用 F1 凭据仓 + mes-rest 的 applyAuth 语义,抽成共享小工具 `server/services/workshop/mes/secret-auth.ts` 供两侧使用)。
- http.ts 实现对应分支;test() 感知新字段。
- SSRF 对齐(可选但建议):复用 mes-rest 的 `resolveTargetIps/isPrivateIp` 私网防护,`allowPrivateHost` 显式白名单——采集节点虽是 admin 配置面,与 mes-rest 同口径可消【五层拦截链】的认知差。

**DCW 侧**(`dcw/drivers/http.ts`):同理补 `timeoutMs` + `{{SECRET:REF}}` 头插值 + secretRef(method 已恒 POST,不动)。

**不做**(防过度设计):不加深度请求体脚本、不加响应 transforms——那是 mes-rest 声明式映射与插件驱动的领地,http 驱动保持“简单轮询/简单写”定位。

**测试**:单测(method/body/auth/timeout/向后兼容:旧 config 无新字段行为不变);协议目录单测同步。

## F5. 注入面 i18n(P2,分两阶段,~2-3 天)

**目标**:英文界面 Agent 收到的工具描述/工况/作业环为英文。**架构不破坏的关键**:注入是运行时字符串装配(per-agent.ts / industrial-context.ts),天然适合模板化;不动 host-tools.json 的加载机制。

**阶段 A(常注入面,~1 天)**:
1. 新增 `server/services/workshop/agents/prompt-i18n.ts`:`t(locale, key, params)` + `locales/zh.ts`、`locales/en.ts` 两包,覆盖:per-agent.ts 的 5 类后缀模板(daqLine/recipeLine/mesLine/optimizerLine/绑线只读)、industrial-context.ts 工况各段标题、industrialLoopGuide 8 步文案、语义卡标签。
2. `hostToolsForAgent` / `buildIndustrialContext` / `industrialLoopGuide` 增加可选 `locale` 参数,**缺省 'zh' = 现行为逐字节不变**;locale 来源:channel 设置(新增一列或复用 workspace locale)→ 回退属主用户偏好 → 'zh'。
3. `my_industrial_nodes` 语义卡同参透传。

**阶段 B(基础目录,~1-2 天,工作量大但机械)**:
- `host-tools.json` 104 个工具 description 双语化:主文件保持 zh,新增 `host-tools.en.json` 增量文件(en 覆盖 zh 同名键);`hostToolDefsFor` / `set_host_tools` / `registerTool` 三通道按 locale 选文件。
- 分批交付:先 20 个高频工业工具(daq_*/recipe_*/mes_*/optimizer_*/line_*)。

**测试**:快照测试(两 locale 各一份;zh 缺省与现快照 diff 为零);单测 locale 回退链。

## F6. S7 落地(P2-P3,~2-3 天 + 实机验证,风险中)

**目标**:把预留插槽变成真驱动。**沿用 serial-bridge 的 optional-peer-dep 成熟模式**,不引入硬依赖。

**方案**:
1. `npm i nodes7` 为 optionalDependencies(缺失时 available()=false,UI 显示“未安装”——与 serialport 完全同构,不阻断主服务)。
2. 新增 `daq/drivers/s7.ts` 实现 `DaqDriver`:available()(探测 nodes7 可加载)、sample() 连接池(host:rack:slot 复用 + 3s 硬超时 + 3 错误驱逐,复用 modbus-tcp 的池化骨架)、读 DB/DBX/DBW 按 dataType/byteOrder 解码、test()。保留 s7-stub 作为包缺失时的占位(现有 fail-loud 语义不变)。
3. 目录项 `shared/daq-protocol.ts:375-380`:status 'planned'→'real',补 configFields:host/rack/slot/dbNumber/offset(dataType/wordLen/scale)。
4. DCW 侧 `dcw/drivers/s7.ts`:写 + 回读三态(与 modbus.ts:48-81 同构)。
5. **测试环境**:snap7 demo server(或 PLCSIM)起本地 fixture;单测覆盖地址解码。**诚实边界:S7comm 与实机 PLC 的兼容性必须实机验证后才可标生产级**,验收前目录描述注明“实测依赖 snap7 兼容 PLC”。
6. 若实机验证短期不可得:**备选方案**走插件模式(`aw-plugin-s7`,插件 API 已支持,核心零改动)。

## F7. 未开线样本打标 + 导出护栏(P3,~0.5 天 + 产品决策)

**7a. 打标**:`ingest.ts:70` 的 `lineId: lineRun?.lineId ?? null` 改为 `lineId: node.lineId ?? null`(节点属线是配置事实,与活动批次无关;product/recipe/run 四列维持 null)。效果:`daq_query(line_id=X, scope=all)` 能查到未开线时段数据。**注意语义变化**:按线过滤的历史查询会开始包含非批次样本——需在 daq_query 回包 provenance 里注明“含未开线时段样本”。存量 NULL 行不迁移(历史数据如实)。
- 前置小修:daq_query 在 activeRun 为 null 时回包加提示“当前无活动批次,scope=all 可查全部”(`daq-tools.ts:139-147` 附近,2 行)。

**7b. 导出护栏**:200 万点/节点与 7 天窗从常量改为 settings(`daq.export.pagesPerNode` 缺省 400、钳 ≤2000;`daq.export.windowMaxH` 缺省 168)——schema.json 注册键 + `daq-export.ts:28`/`data-export.ts:22` 读 settings;manifest 截断标注机制不变。**不默认放宽**,只给大用户调升的阀门。

**产品决策项**(不在本次实施):是否需要“批次外数据归属线”的 UI 呈现。

---

## 实施顺序与依赖

```
F1(凭据仓)──→ F4(http 增强,复用 F1 的 secret-auth)
F2A → F2B(阶段 B 建议单独评审)
F3(独立)
F5A → F5B
F6(独立,最后做——实机依赖)
F7(独立,7a 含语义决策)
```

建议第一批合入:F1 + F2A + F3(合计 ~1.5 天,全为低风险小 diff);第二批 F4 + F5A;第三批 F2B + F5B + F7;F6 视实机条件排期。

## 验证基线(每批合入后)

- 全量单测(现基线 538+)+ 受影响套件 e2e;
- `daq`/`mes`/`team` 相关 e2e 脚本专项回归;
- F5 合入后跑注入快照(zh 零 diff 断言);
- 每批提交遵守 pathspec 限定(并行会话共享 git index)。

## 非目标(架构护栏)

- 不做“每节点一库”——统一时序库 + 批次打标是正确设计;
- 不把授权逻辑搬进 prompt——工具面/授权面分离、dispatch 五层闸不动;
- http 驱动不做成脚本化集成平台——那是 mes-rest 与插件驱动的定位;
- S7 在实机验证前不标生产级,stub 的 fail-loud 语义保留。
