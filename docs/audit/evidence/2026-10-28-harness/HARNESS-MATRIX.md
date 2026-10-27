# Harness 工具注入能力矩阵(2026-10-28 实测)

> 代码级验证 + 3470 实机验证(工具面 65 工具/语义卡实调)。矩阵按「工具如何进入引擎上下文」划分。

| 引擎 | 进程模型 | 工具注入方式 | HITL | steer | 备注 |
| --- | --- | --- | --- | --- | --- |
| **omp** | 常驻 RPC 子进程 | **原生**:`set_host_tools`(RPC 直注,`hostToolsForAgent` 按角色+绑定装配) | ✅ 程序化审批面 | ✅ 同轮 | 默认推荐引擎;实测注塑频道 4 agent 全 omp |
| **pi** | 每回合一次性(`pi -p --mode json`) | **零依赖扩展**:`-e pi-aw-tools.mjs` 注册平台 host tools(清单经 AW_PI_TOOLS_FILE 与 hostToolsForRole 同源),HTTP 回程 | ❌ 无程序化审批面 | 恒 deferred(一次性进程) | provider/model 可配;智谱网关实测可用 |
| codex | 常驻 | **MCP 桥**:per-agent CODEX_HOME config.toml `[mcp_servers.aw]` → aw-mcp-bridge.mjs(stdio) | ✅ | ✅ | 工具名 `mcp__aw__*` |
| dsh | 常驻 ACP | **MCP 桥**:session/new `mcpServers` 挂 stdio 桥 | ✅ | ✅ | 与 omp 同源 prompt-builder/host-tool-bridge |
| hermes | 常驻 ACP | **MCP 桥**(ACP session/new mcpServers) | ✅ | ✅ | 与 dsh 同型 |
| claude | 常驻 SDK 会话 | **MCP 桥**:`mcpServers.aw` stdio(与 codex/dsh/opencode 同构;清单动态) | ✅ | ✅ | |
| qwen | 常驻 ACP(老版) | **MCP 桥**:~/.qwen/settings.json merge-only 写 `mcpServers.aw`(trust=true) | ✅(requestToolCallConfirmation) | 单飞 | |
| opencode | serve 进程+HTTP/SSE | **MCP 桥** | ✅ | ✅ | |
| gemini / cursor / crush / goose / copilot | 各自原生 | **MCP 桥**(resolveBridgePath → aw-mcp-bridge.mjs) | ✅ | 各异 | |
| mock | 进程内 | 直接函数调用 | 测试语义 | `[mock:*]` 触发器 | 联调/测试 |

**共同底座**(与注入方式解耦):
- 工具清单同源:`hostToolsForRole`/`hostToolsForAgent`(角色差异化:lead 全量,worker 剔除调度/团队管理工具)——omp 原生直注、pi 文件注入、MCP 桥 tools/list 动态拉取,三路同一张清单。
- 回程同源:全部经 `impl.dispatchHostTool` → host-tool-bridge;agent token 自证(x-aw-agent-token)+用户 Bearer 双通道;跨 channel 一律 SCOPE_VIOLATION。
- 桥身份:`generateMcpBridgeEnv(agentId, token, baseUrl, bridgePath)` 注入 AW_BASE_URL/token,工具调用以该 Agent 身份执行(继承其绑定)。

## 按绑定注入提示(全部引擎共享)
`prompt-builder` + `industrial-context`:
- **语义三层合并**:节点 semantics > 模板 semantics > mes-rest driverConfig.desc;物理量/单位/量程/精度/预警带/采样周期由节点与模板元数据合成。
- **只注入实际绑定**:上下文 = 节点语义卡 × 产线工况 × 关联设备,"未绑定对象不出现在清单中"(my_industrial_nodes 契约原文)。
- **调控作业环**:有绑定节点才注入 —— 下发链路(PLC 驱动或 MES writeHook)、配方操作面(recipe_update/apply/trial)、四层限界(量程∩参数∩产品∩配方)、单步上限、manual/auto 模式守则(manual=每次下发请求用户批准,须先说明理由)。
- 实测:分析师只见数采卡(附 `daq_query(node_id=...)` 取数指引);工艺工程师只见数控卡(barrel-temp-1-sp:量程[160,300]/配方窗 240℃/当前设定 240℃/单步上限 ≤2.8℃/manual 逐动作 HITL)。

## 实测结论(2026-10-28,实例 3470,注塑线 ln-e27a1867)
- omp 原生注入:✅(65 工具含 kb/diag/daq/recipe 工业族;4 agent 各角色差异化)
- pi 扩展注入:✅ 设计成立(代码级);未在本轮实机驱动 pi 会话(外部 CLI 可用性另测)
- MCP 桥接 11 引擎:✅ 设计成立(代码级,桥脚本/身份 env/回程三件套齐备);本轮实机以 omp 为引擎验证全链
- **绑定→抓数→分析→控制→HITL 全链**:✅(US-103/104/105,见同目录证据)
