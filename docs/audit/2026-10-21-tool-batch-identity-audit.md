# 数采/数控批量能力与 Agent 身份注入审计 — 2026-10-21

审查对象:数采(DAQ)/数控(DCW)工具面是否批量、自定义 API(MES REST)的理解与 req/res 契约、逐 Agent 差异化注入、调用时 Agent 元数据的自动注入与节点/verify/拦截链。全部结论均有代码锚点与当日真实环境测试佐证。

## 结论速览(五问五答)

| # | 问题 | 结论 |
|---|------|------|
| 1 | 数采获取/导出是否批量 | **是**。`daq_query` 不传 `node_id` 一次查询全部有权节点(实测 14 节点单次返回);`daq_export` 接受 `node_ids` 多节点并支持 `merge:true` 产出多参数对齐宽表 |
| 2 | 参数/配方下发是否批量 | **是,且只经配方面**。`recipe_update(params[{node_id,value}])` 一次保存多参数;`recipe_trial`/`recipe_apply` 整批下发;`recipe_propose` 多候选包整包审批。直写工具 `dcw_control`/`param_control` 对 Agent 是 v2 禁用桩(双保险) |
| 3 | 自定义 API 理解与 req/res 要求 | **是,双方都有明确契约**。req:`readMap/writeMap/historyMap` 的 method/path/query/headers;res:按格式的 `valuePath/valuesPath/dataPath/rowsPath/tsPath/tsFormat`,坏映射配置期 400 拒绝。Agent 经 `mes_catalog` 获得能力面+字段字典 |
| 4 | 不同绑定 → 不同注入提示 | **是**。`hostToolsForAgent` 把该 Agent 的绑定面写进 daq/recipe/mes 工具描述;MCP tools/list、omp `set_host_tools`、pi `registerTool` 三条注入路径同源函数 |
| 5 | 调用时自动注入 Agent 元数据+拦截 | **是**。token↔agentId 双向自证(冒用/伪造实测 401),identity 由服务端构造;五层执行链(作用域→Channel 工具闸→grant→tool-verify→工具自身门)全部在 handler 之前 |

## 1. 批量能力矩阵

| 工具 | 批量形状 | 锚点 |
|------|----------|------|
| `daq_query` | 省略 `node_id` = 绑定面 ∪ 频道绑线只读全部节点;`node_id`/`line_id` 只能收窄不能放大 | `daq-tools.ts:19-51`(daqTargetsOf),`130`(for targets 循环) |
| `daq_frames` | 同一 targets 面 | `daq-tools.ts:253` |
| `daq_export` | `node_ids`(数组或逗号/分号/空白分隔)>`line_id` 过滤>全部可见;`merge:true` 产出按秒对齐宽表 merged.csv;护栏 7 天窗/400 万行/保留 50 次 | `daq-export.ts:405-448`,`77-106` |
| `mes_fetch`/`mes_export` | `ids` 多点位一次取数/导出;`param` 透传 requestHook/dataHook | `mes-tools.ts:65,78`,`mes-controller.ts:787` |
| `recipe_update` | `params[{node_id,value,min,max}]` 数组,部分合并+失效参数剪除 | `ops-tools.ts:738-825` |
| `recipe_trial`/`recipe_apply` | 整批下发(`applyRecipe(overrides)`,逐参数 ACK 鉴定 证实/未证实/失败 三段口径) | `ops-tools.ts:1103-1136` |
| `recipe_propose` | `packages[].params[]` 多方案整包一次裁决 | `recipe-propose-tools.ts:66,86` |
| `dcw_control`/`param_control` | v2 禁用桩(工具面已摘除定义,handler 仍拒绝防直连绕行) | `dcw-tools.ts:90-100`,`param-tools.ts:55-69` |

## 2. 自定义 API(mes-rest):理解面与 req/res 契约

**req(请求映射,配置期校验)** — `drivers/mes-rest.ts:24-71,109-190`:
- `readMap`/`writeMap`/`historyMap` 均为 text 表单 JSON:`method`(缺省 GET)/`path`(必填字符串)/`query`/`headers`。
- res 提取路径按格式强制:scalar 必填 `response.valuePath`;vector 必填 `valuesPath`;image 必填 `dataPath`;history 必填 `rowsPath`+`tsPath`;`tsFormat` 仅 epoch_s/epoch_ms/iso。坏映射在配置期抛 400(如 `historyMap.response.valuePath 必填(format=scalar)`),不进请求链路。
- 凭据零明文:`secretRef` 只存引用名,token 从 `AW_MES_<REF>_TOKEN` 或运行时设置解析,401 文案直接指向该链路(`mes-rest.ts:261,382,400`)。
- SSRF 防护:仅 http/https,DNS 解析落私有/环回段即拒,内网白名单须显式 `allowPrivateHost:'true'`(`mes-rest.ts:247-251`);同驱动实例令牌桶限速 5 req/s(`335-349`)。

**Agent 如何"理解"这个 API** — 数据驱动,零硬编码:
- `mes_catalog` 回包列每点位能力(读/写/史,史·vector/image/table/event 五格式,钩子标记)+ **字段字典**(单位/量程/物理意义/逐点语义;来自 MES 响应 `dictionaryPath` 缓存 ∪ 节点 `driverConfig.dictionary`,`mes-controller.ts:134-241,345`)。
- `mes_fetch(ids, from, to, max_rows, param?)`:`param` 透传给用户自写的 `requestHook`(请求构造)与 `dataHook`(数据下沉),处理摘要与产物清单随回包返回;回包只含统计摘要与 ≤3 行采样,**MES 行级原文不进 prompt**,全量落 `<数据根>/datasets/<id>.csv`(`mes-tools.ts:1-9`,`mes-controller.ts:677-703`)。

**实测**:MES 集成 e2e 25/25(自建 MES REST 模拟器:向量历史+dictionaryPath→`mes_fetch` 字典/数组采样→`mes_export` manifest/README→`mes_catalog` 复用响应字典;外部 API 推送数组/图像→`daq_frames` 语义读取)。

## 3. 逐 Agent 差异化注入

`per-agent.ts:90-114` `hostToolsForAgent(agentId, role, channelId)`:在角色过滤后的工具面上,对该 Agent 的绑定面追加描述——
- daq 族追加「本 Agent 直接绑定的数采节点(仅这些可查):…」/「频道绑线只读数采节点(可查):…」
- recipe 族追加「本 Agent 已绑定的配方(仅这些可写/下发):…(参数:…)」
- mes 族追加「可经配方参数面取数的 MES 点位」(仅 `driver=mes-rest` 的配方参数节点,`per-agent.ts:70-77`)

三条注入路径同源:REST `list.get.ts:23` → `hostToolDefsFor`(`manager/host-tools.ts:175`,即 stdio MCP 桥 tools/list 源,覆盖其余 12 个 harness)、omp `set_host_tools`(`omp-agent/client.ts:91`)、pi(`pi-agent.ts:75`)。注入面与执行面同源,不会"描述里有、执行时无权"。

**实测**:线绑定频道内 analyst(14 个 daq 直绑)与 optimizer(仅配方绑定)的 `daq_query`/`recipe_update` 描述互不相同(T4.1–T4.4);无绑线频道 A/B 各绑一节点,描述互不含对方节点、查询各只覆盖 1 节点、跨节点查询被拒(隔离 e2e 7/7)。

## 4. 身份注入与拦截链

**身份不在请求里**:`POST /api/workshop/agent-tools/invoke`(`invoke.post.ts:35-65`)双通道强制自证——`x-aw-agent-token` 必须解析为**该 body.agentId 本身**(否则 401);用户 Bearer 路径必须可支配该 agent(channel 属主或 admin,否则 403)。`manager.invokeHostTool` 再复核 `token !== row.token → 401`(`manager/host-tools.ts:85`),identity `{agentId, channelId, role}` 由服务端 DB 行构造后传入 dispatch——工具模块因此始终知道"是谁在调"。

**五层执行链**(全部在 handler 之前,`dispatch.ts:59-181`):
1. 人类发起者作用域(§13.3,@Agent 不放大成员权限)
2. Channel 逐工具闸门(`channelToolGate`,目录隐藏不是安全边界,执行面复核)
3. Twin/profile 门控 + 写面档位守卫
4. **grant 收权复核**(v3:按调用参数解析目标产线,读≥readonly/写需 operate,撤权即失活,fail-closed;`grant-guard.ts:122-170`)
5. **tool-verify 统一预检**(参数形状 + 引用归属:`nodeFace = 绑定节点 ∪ 频道绑线 ∪ 配方参数节点 ∪ 配方所在线`;`lineFace/recipeFace`;dataset/job/model/plan/scene 链式谱系回溯「创建者本人 ∪ 可读线」;拒绝文案带完整绑定面与下一步动作,授权性拒绝入册 `tool.call.denied`;自身故障 fail-closed;`tool-verify.ts:1-26,300-381`)

**实测**:A id+B token→401、伪造 token→401、A token 取 B 工具面→401、本人正常;未绑定配方回退被拒(带绑定指引)、数采节点不在优化师面被拒(`仅可查你绑定范围内的对象:rc-a68489be`)、不可读产线被拒(列出可读产线);`tool.call.denied` 审计 2 条可查(`ops-logs?scope=all&q=工具调用被拒`)。

## 5. 设计边界(如实记录)

- **单步限幅的分层**:stepLimit/60s 间隔/写入保持窗只约束**在线增量写**(agent/manual 源,`write.ts:113-141`「recipe/rollback 仍由其专用路径管理,避免启动批次时把整套配方误判为在线探索步」)。批量试验面的把关 = HITL 卡片(人看到 from→to)+ 量程/参数基准/产品层联锁(逐参数照跑,`write.ts:107`)+ 配方级下发频控。因此 Δ=8.4(>stepLimit 2.8)但在量程内的整批候选**会被放行**(设计使然,非漏洞);越量程 400℃ 实测被拒(「超出上限 节点工艺安全量程 的 300℃」)。Agent 可用面已无在线直写(optimization_explore 仅工艺优化 Channel 且走完整治理链)。
- 批量负例若在 HITL 批准后才被网关拒绝,顺序是「人批准→网关拒绝」——`recipe_propose` 有预检剔除「批准必被拒包」;`recipe_trial` 负例依赖网关兜底,本次实测即此路径。
- 工具结果 16k 字符统一截断,`daq_export`/`diag_run` 豁免(`dispatch.ts:44-57`)。

## 6. 测试证据(2026-10-21,隔离实例 127.0.0.1:3470/4050,注塑线 ln-593e76b2)

| 套件 | 结果 | 说明 |
|------|------|------|
| `npm run test:unit` | **283/283** | 含 tool-verify 归属面/链式谱系/审计入册/绑定面一致性 |
| `scripts/tool-face-batch-identity-e2e.mjs`(本轮新增) | **22/22** | T1–T8:批量查询/收窄/批量导出+merge 盘上校验/描述差异/身份 401×3/三层拦截+审计/两参数一次保存 v3+整批下发 2/2 证实+回读一致/越量程负例 |
| `scripts/agent-daq-isolation-e2e.mjs` | **7/7** | 无绑线频道 A/B 节点隔离+跨节点拦截 |
| `scripts/mes-agent-integration-e2e.mjs` | **25/25** | 自定义 API 全链(字典/向量/导出/数据集/UI) |
| `scripts/scenario-suite-setup.mjs` | 21/23 | 2 失败为**已知测试脚本断言缺陷**(产线状态字段读 `active`、均值解析取首节点),非系统缺陷;环境供给正常 |

Evidence:`docs/audit/evidence/2026-10-21-batch-identity/tool-face-batch-identity.json`、`batch-write.json`。
