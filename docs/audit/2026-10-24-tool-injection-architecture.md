# 工具注入架构 · 全设计与代码级设计思路

- 日期:2026-10-24(ralph US-INJ2)
- 回答的问题:工具怎么按不同 Agent 注入?是创建不同的工具执行对象吗?有没有一个 Manager 做统一对象生命周期管理?
- 一句话答案:**不是"为每个 Agent 克隆一套工具执行对象"。工具定义全局唯一且无状态,系统在注入时刻按 Agent 编译一份"视图"(同名工具、不同描述),执行走单口无状态分发(身份随调用传递);Manager 管理的是 AgentRuntime(引擎子进程)与调度器的生命周期,工具面本身没有生命周期——这是刻意设计,状态全部外置到可审计的存储层。**

---

## 1. 三层模型:定义 → 视图 → 执行

```
                     ┌──────────────────────────────────────────────┐
                     │  定义层(全局唯一,静态,无生命周期)            │
                     │  host-tools.json(92 工具,含 references 声明) │
                     │  插件工具注册表(内存,热变更通知)              │
                     └──────────────┬───────────────────────────────┘
                                    │ 即时编译(每次注入时)
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
     hostToolsForAgent(A)   hostToolsForAgent(B)   hostToolsForAgent(C)
     = 角色/档位/策略过滤     + A 的绑定面描述        + C 的绑定面描述
     (同名工具,不同视图 —— 浅拷贝,只换 description)
              │                     │                      │
     ┌────────┴───────┐   ┌────────┴────────┐    ┌────────┴────────┐
     │ omp:set_host_tools│ │ pi:工具 JSON 文件 │    │ 其余引擎:stdio MCP 桥 │
     │ (进程内 RPC 推送)│   │ (AW_PI_TOOLS_FILE)│   │ (tools/list 拉取)  │
     └────────┬───────┘   └────────┬────────┘    └────────┬────────┘
              └─────────────────────┼──────────────────────┘
                                    ▼
              执行层(单口,无状态,身份随调用传递)
        dispatchHostTool(ctx{identity}, {toolName, arguments})
        token→scope→channelToolGate→插件治理→grant→verify(实时)→handler(agentId,args)
```

## 2. 定义层:一份定义,零对象克隆

- **内置工具**:`.AgentWorkShop/prompts/host-tools.json` 92 个工具,模块导入时一次性加载为常量 `HOST_TOOLS`(`server/services/workshop/agents/host-tool-bridge/catalog.ts:17`,`loadHostToolDefs()` 带 mtime 缓存,`prompts/loader.ts:184-214`)。每个工具带 `references/noRefs/riskClass` 声明(2026-10-24 WP5 起),导入时登记进声明表(`catalog.ts:19-20` → `tool-reference-spec.ts:registerToolReferenceDeclarations`)。
- **插件工具**:插件经 `ctx.omp.registerTool` 注册进内存注册表(`agents/plugin-tools.ts:61-80`),变更通知触发热同步(`scheduleToolRegistrySync`)与 omp 热重发。
- **关键事实:定义层没有任何 per-Agent 副本**。`HOST_TOOLS` 是模块级单例;插件的 `byName` Map 也是全局单例。

## 3. 视图层:按 Agent 即时编译(这是"注入"的本质)

`hostToolsForAgent(agentId, role, channelId)`(`agents/host-tool-bridge/per-agent.ts:96`)做四步:

1. **角色硬规则**(`catalog.ts:161-270` `scopeHostToolsForRole`):worker 剔除 13 件 lead 专属(`tool-classes.ts:8-22`);Channel profile 档位互斥裁剪(aml_training/aml_optimization/exp-miner/line-doctor/legacy/hybrid_twin);直写兜底;团队插件开关过滤。排除原因记录进 `excluded` 供 UI 审计。
2. **Channel 逐工具策略**(`tools/policy.ts:85` `applyChannelToolPolicy`):all=deny-list / selected=allow-list,读取失败走分级降级(WP7:缓存快照→写族拒/读族 degraded)。
3. **绑定面描述增强**(`per-agent.ts:100-140`):`agentToolResources` 读该 Agent 的 daq/dcw/recipe 绑定 + 频道绑线 + 优化器绑定,把"你可直接操作的节点/配方"拼进工具描述;超预算确定性折叠(`description-budget.ts`,同绑定面逐字节稳定)。
4. **优化器绑定裁剪**(`per-agent.ts:95-98`):无有效绑定的 Agent 连 solve/status/cancel/plan_get 四件都不注入(保留 capabilities 作解释入口)。

**视图不是对象克隆**:`filtered.map(t => suffix ? {...t, description} : t)`(`per-agent.ts:129-136`)——同名、同 schema、同 handler 引用,只是 description 被浅拷贝替换。**视图只读约定**:消费端(omp RPC 推送/pi 写文件/MCP 桥序列化)只读不变异——原地修改视图会污染共享定义,新增消费端必须遵守。实机 T5f 断言了两 Agent **工具名集合完全一致、daq_query 描述逐字不同**,直接证明"同名工具/不同视图"而非"两套工具对象"。

**注入的三个消费端**(同一编译函数,三种投递):
| 消费端 | 机制 | 锚点 |
|---|---|---|
| omp(主 harness) | RPC `set_host_tools` 推送,进程内工具调用回调 `onHostToolCall` | `agents/omp-agent/client.ts:91`;插件变更热重发 `refreshPluginTools()`(`omp-agent/lifecycle.ts:26-30`) |
| pi | `prepare()` 把视图 JSON 写文件 `AW_PI_TOOLS_FILE`,引擎启动时同步注册 | `agents/pi-agent.ts:72-82` |
| codex/dsh/opencode 等外部引擎 | stdio MCP 桥子进程:`tools/list` 拉 `/api/workshop/agent-tools/list`(ETag/304,10s 签名轮询发 `tools/list_changed`) | `server/harness/aw-mcp-bridge.mjs:46-77` |

**注入面缓存语义**:桥的 10s 缓存与 ETag 只是**传输优化**;绑定变更后最多 10s 描述陈旧,而执行面(下节)即时生效——"描述可陈旧、授权不陈旧"是明文设计(计划 §6 风险表)。

## 4. 执行层:单口分发,身份随调用走(无执行对象)

所有路径最终汇聚到**一个无状态函数** `dispatchHostTool(ctx, req)`(`host-tool-bridge/dispatch.ts:40`),`ctx.identity = {agentId, channelId, role, name}` 随每次调用传入。工具"执行对象"不存在——handler 是 `(agentId, args, channelId) => Promise<HostToolResult>` 的纯函数式入口,状态全部外置:

| 状态 | 存放 | 锚点 |
|---|---|---|
| 绑定面(授权事实源) | `agent-node-bindings.json` | `agents/node-bindings.repo.ts` |
| 工具元数据/策略 | `tool_registry` / `channel_tool_policies` / `channel_tool_settings`(SQLite) | `db/tool-registry.repo.ts:26-59` |
| 身份/凭据 | `channel_agents`(token + 轮换宽限列) | `db/channel-agent.repo.ts` |
| 引用归属 | **每次调用实时重算,不缓存** | `agents/industrial/tool-verify.ts:57-88`(`resolveRefFaces` 注释明示"绑定可在调用间隙被改写") |

**执行链五层复核**(两条路径完全同源):
- REST/MCP 桥路径:`invokeHostTool`(`runtime/manager/host-tools.ts:96`):repo `isTokenValid`(常量时间+轮换宽限,`channel-agent.repo.ts` WP3 单点)→ 人类发起者作用域 `checkToolAgainstScope` → `channelToolGate` → 插件治理(`governPluginToolCall`:kb 入库 HITL + 声明式 verify + 审计)→ `runtime.dispatchHostTool`(impl 实现)或共享 `dispatchHostTool` 兜底(mock 等无引擎面成员)。
- omp 进程内路径:`handleHostTool` → `dispatchHostToolInner`(`dispatch.ts:112`):invocationScope(:118-125,防群成员借 Agent 身份提权)→ channelToolGate(:129)→ 插件分支(治理+审计)→ twin/optimizer 门控 → 写族守卫 → **工业族:`guardIndustrialToolGrant`(运行时收权即失活)→ `verifyIndustrialToolCall`(声明驱动、实时归属校验)→ handler**(:247-256)。

铁律(代码注释原文):**注入面隐藏不是安全边界,服务端实时重算才是**(`dispatch.ts:126-131`、`tool-verify.ts:57`)。

## 5. Manager:管"进程生命周期",不管"工具对象生命周期"

`getWorkshopManager()` 是全局单例(`server/plugins/workshop.ts`),类链 `Manager… → ManagerAdminChannel → ManagerHostTools → ManagerA2A → …`。它持有的生命周期对象只有一类:**AgentRuntime(引擎子进程的包装)与 SchedulerLoop(调度循环)**:

| 方法 | 职责 | 锚点 |
|---|---|---|
| `ensureAgentRuntime(channelId, agentId)` | **幂等懒装配**:agentIndex 以 `(channelId, agentId)` 为键;命中即返回缓存;未命中从实例行 `wireMember` 创建 AgentRuntime(拉起 harness 子进程、装配 workspace/mailbox)并 `start()` | `runtime/manager/runtime-wiring.ts:140-147` |
| `ensureChannelActive(channelId)` | 装配 lead 运行时 + 挂 SchedulerLoop(双重判空防孤儿循环) | `runtime-wiring.ts:154-168` |
| `reviveScheduler` | lead 空闲被清扫后复活调度器(只认已装配 lead,防递归) | `runtime-wiring.ts:177+` |
| `unloadChannelAgents(channelId)` | 停调度器(`stopAndWait`)→ 各 runtime `stop()` → 从 `channels` Map 删除;空闲(120s)清扫复用 | `runtime/manager/admin-channel.ts:256+` |
| `recycleChannelForTwinProfile` | profile 变更 → 全量卸载重装(新档位工具面随下次注入生效) | `admin-channel.ts:249` |
| harness 进程治理 | `dispose/refreshPluginTools/killProcess`、`killHarnessProcess/markHarnessProcessExit`、watchdog(`lastToolInvokeAt` 活性信号) | `omp-agent/lifecycle.ts` |

**为什么工具面没有生命周期?** 因为工具是纯投影:
1. **一致性**:状态只有一份(绑定/策略/身份在存储层),不存在"对象间同步"问题——绑定撤销即刻影响下一次调用,无须通知任何对象。
2. **可审计**:授权判定每次调用实时发生,审计面(agent token rotate、tool.call.denied、plugin.tool.call)记录的就是判定时刻的真实状态。
3. **热变更免费**:插件注册/档位切换/绑定修改都只是"下次编译时生效",无须失效通知、无缓存失效键不完备问题(2026-10-24 反方评审否决 manifest 缓存的核心理由)。
4. **代价被有意接受**:每次注入/调用重算视图与归属面的成本 = 一次内存数组过滤 + 若干点查(实测毫秒级),换来零陈旧授权。

## 6. 完整时序(一次真实调用的一生)

以「外部引擎(codex)经 MCP 桥调 `daq_query`」为例:

```
codex ── tools/call daq_query ──▶ aw-mcp-bridge.mjs(每 Agent 独立子进程)
  │ POST /agent-tools/invoke {agentId, tool, args} + x-aw-agent-token
  ▼
invokeHostTool (host-tools.ts:81)
  1 row = channelAgents.findById(agentId);enabled 检查
  2 isTokenValid(row, token)          ← repo 单点:常量时间 + 宽限窗
  3 checkToolAgainstScope(invocationScope)  ← 人类发起者限制
  4 channelToolGate(channelId, tool)  ← 目录 available + Channel 策略(分级降级)
  5 (插件工具→governPluginToolCall:kb HITL/声明 verify/审计)
  6 runtime.dispatchHostTool / 共享 dispatchHostTool
  ▼
dispatchHostToolInner (dispatch.ts:112)
  7 invocationScope 复核(进程内双保险)
  8 channelToolGate 复核("目录可能被引擎缓存")
  9 guardIndustrialToolGrant(identity, tool, args)  ← 产线授权运行时复核
 10 verifyIndustrialToolCall(agentId, tool, args)
      └ resolveRefFaces(agentId) 实时重算:
        绑定节点 ∪ 频道绑线只读节点 ∪ 绑定配方参数节点;链式对象按谱系回溯
      └ 按声明(refs/nodeLists/deepNodeRefs/chained/atLeastOne)逐条校验
 11 handler(agentId, args, channelId)  ← 真正的执行,身份已验证
 12 truncateToolResult(16k,export 类豁免) → 文本结果
  ▼ 原路返回:MCP content[] / REST {result:{text,isError}}
```

## 7. 与"每 Agent 克隆工具对象"方案的对照(为什么本设计更优)

| 维度 | 本设计(视图编译) | 克隆对象方案 |
|---|---|---|
| 绑定变更生效 | 下一次调用立即(执行实时重算) | 需失效通知/版本号,漏更新=陈旧授权 |
| 内存/对象数 | O(1) 定义 + 每次注入临时视图 | O(Agent×工具) 常驻对象 |
| 审计 | 判定时刻状态即审计事实 | 对象内部状态难以还原"当时凭什么放行" |
| 热变更(插件/档位) | 免费生效 | 全量对象重建 |
| 教学式自纠 | verify 拒绝文案实时列绑定面,Agent 可自我纠正 | 对象克隆常伴随 schema 预收窄,失去自纠通道 |

**边界与代价(诚实披露)**:① 注入面描述有 ≤10s 陈旧窗(MCP 桥轮询 TTL),安全无关;② 每次编译/校验有重算成本(实测毫秒级,若未来成为瓶颈,替代方案是"绑定面版本号+失效缓存",2026-10-24 评审已论证其前置条件未成熟);③ `HOST_TOOLS` 模块加载期冻结,host-tools.json 热编辑不生效(须重启或走插件热注册通道)。

## 8. 实测证据索引

- `scripts/e2e-tool-surface-multiagent.mjs`(隔离实例,37 断言):T5f 同名集合+不同描述;T7/T9 原生与 MCP 同链 verify;T13 两 Agent 并行真实作业闭环(查各自绑定节点→analysis_save 留痕→台账读回,产物 ar-542926bc/ar-e4a28ffc 归因正确);T6 ETag/304;T11 rotate 宽限;T10 ingest 鉴权。
- `docs/audit/evidence/2026-10-24-tool-surface/multiagent-report.json`(本轮运行)。
- 单测:`tests/tool-references.test.ts`(声明等价)、`tests/agent-token-rotation.test.ts`、`tests/plugin-governance.test.ts`、`tests/tool-surface-budget.test.ts`、`tests/daq-ingest-policy.test.ts`。
