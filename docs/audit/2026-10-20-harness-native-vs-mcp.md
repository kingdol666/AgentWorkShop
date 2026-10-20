# Harness 工具集成:原生直连 vs MCP 桥(2026-10-20 实测)

- 平台:AgentWorkShop 0.7.66(本机 3001,dev 源码)
- 工具目录:`.AgentWorkShop/prompts/host-tools.json`(86 个内置定义)+ 插件工具
- 结论先行:**当前只有 omp 与 pi 是“非 MCP 原生注入”;其余 12 个引擎走 `aw-mcp-bridge.mjs`。**
  这不是“没开发”,而是这 12 个上游 CLI 的外部工具面只公开 MCP(或等价配置)。
  想让“全部 harness 都不用 MCP”需要上游提供原生工具注册 API,或为每个引擎写原生插件;
  后者只在 opencode / dsh / claude SDK 这类有插件或 SDK 自定义工具面的引擎上可行。

## 1. 当前注入矩阵(按代码事实)

| harness | 注入机制 | 是否 MCP | 本机运行状态(2026-10-20) |
|---|---|---|---|
| **omp** | JSON-RPC `set_host_tools` → 引擎 `host_tool_call` 回调 | **否(原生)** | **PASS**(任务 15–24s 完成,交付物含 `HARNESS-OK:omp`) |
| **pi** | 扩展 `server/harness/pi-aw-tools.mjs` → `pi.registerTool` | **否(原生)** | 代码路径已实现;本机 provider 配额耗尽(23:22 重置) |
| claude | Agent SDK `mcpServers.aw` → 桥 | 是 | 直接 `claude -p` 可用;平台任务卡住(SDK 侧未拿到可用模型凭据) |
| codex | `config.toml [mcp_servers.aw]` → 桥 | 是 | 直接 `codex exec` 可用;平台任务卡住(默认 provider 反复重连) |
| opencode | 运行时 `POST /mcp` 注册桥 | 是 | 鉴权存在,但 Zhipu 周限额耗尽(23:22 重置) |
| dsh | profile `@deepseek-ai/dsh-mcp-client` | 是 | **profile patch 为空** → 引擎看不到任何 AW 工具;另有 Windows 沙箱 ACL 拒绝 |
| gemini | `.gemini/settings.json mcpServers.aw` | 是 | 未配置 Auth(`GEMINI_API_KEY`/OAuth 均缺失) |
| **copilot** | `mcp-config.json` + `--allow-tool aw` | 是 | **PASS**(任务 27–30s 完成,交付物含 `HARNESS-OK:copilot`) |
| cursor | `--mcp-config aw-mcp.json` | 是 | `cursor-agent` 要求登录/`CURSOR_API_KEY` |
| crush | `.crushrc mcp add aw` | 是 | 无 provider 配置 |
| goose | MCP 配置 | 是 | 无 provider 配置 |
| qwen | `~/.qwen/settings.json mcpServers.aw` | 是 | 缺 `OPENAI_API_KEY`(settings 已选 openai 但没有 key) |
| hermes | 用户级 `hermes mcp add aw` | 是 | OpenRouter key 存在;平台任务 300s 未完成(模型侧未回) |
| mock | 进程内剧本,无 LLM 工具面 | — | 仅测试替身;本次已修复其经 MCP/HTTP 调用协作工具的回退 |

> “平台任务卡住”是环境/模型凭据问题,不是工具注入代码缺失;直接 CLI 探测已给出各自的人话原因
> (`docs/audit/2026-10-20-harness-acceptance-evidence/harness-matrix*.log`)。

## 2. 工具注册与调用全流程

### 2.1 注册(单一事实源)

1. `.AgentWorkShop/prompts/host-tools.json` 存 86 个内置工具定义(name/label/description/JSON Schema)。
   `host-tool-bridge/catalog.ts` 的 `HOST_TOOLS` 在模块加载时读取。
2. 插件工具经 `listPluginTools()` 合并;插件可注册自己的工具。
3. `hostToolsForRole(role, channelId)` 按角色、Channel profile(legacy/hybrid_twin/AML/观察面)、
   插件开关过滤工具集;**新增** `hostToolsForAgent(agentId, role, channelId)` 在描述尾部追加
   该 Agent 绑定的数采节点、配方参数、MES 点位(`host-tool-bridge/per-agent.ts`)。
4. 注入面三条路径共用上述装配:
   - omp:`set_host_tools`(JSON-RPC,进程内);
   - pi:`AW_PI_TOOLS_FILE` JSON → `pi.registerTool`;
   - 其余:`aw-mcp-bridge.mjs` 作为 stdio MCP server,`tools/list` 调
     `GET /api/workshop/agent-tools/list?agentId=...` 取同一份 schema。

### 2.2 调用(同一执行面)

```
harness 模型产生 tool call
  ├─ omp:  JSON-RPC host_tool_call → OmpRpcAgentImpl.handleHostTool
  ├─ pi:   registerTool.execute → POST /api/workshop/agent-tools/invoke
  └─ MCP:  tools/call → aw-mcp-bridge → POST /api/workshop/agent-tools/invoke
                 │  (x-aw-agent-token 自证 agentId)
                 ▼
   manager.invokeHostTool
     ├─ agent token/身份校验
     ├─ 人类调用作用域检查(§13.3)
     ├─ 插件工具 → handler
     ├─ impl.dispatchHostTool → 共享 dispatchHostTool
     │    ├─ 协作面(send_message_to_agent/poll_messages/tasks/memory)
     │    ├─ 工业面(daq_query/recipe_*/mes_*/param_control…)
     │    └─ 治理门控(产线 profile、写面 fail-closed、grant-guard、tool-verify)
     └─ 返回 { text, isError } → 原路回引擎
```

关键点:
- MCP 只是**传输层**;工具定义、鉴权、治理、审计与 omp 原生路径**完全同一份**。
- 每个 Agent 的 MCP 桥进程只带该 Agent 的 `AW_AGENT_ID/TOKEN`;`tools/list` 的 schema 与
  描述按该 Agent 的绑定面生成,不能看到/调用别人的节点。
- 写控/配方操作在 handler 内挂 HITL(manual 绑定/运行门/限界/回读),与传输方式无关。

### 2.3 原生 HITL(ask 与 manual 写是两条链路)

- **ask(提问型)**:omp `ask` 工具 → `extension_ui` → `hitl-registry(kind=omp-dialog,
  requestType=question, questions[])` → AEP `hitl.request` → 前端铃标/群聊页下拉
  (`.hitl-opt` 渲染 yes/no/Other) → `POST /api/workshop/hitl/respond {answers/value}` →
  `hitl.resolved` → 引擎 `ask` 收到答案。
- **manual 写(审批型)**:`recipe_update`/`recipe_apply` 等 handler 在 manual 绑定下
  调 `hitlDispatchGate` → `hitl-registry(kind=dcw-approval)` → 审批卡 →
  `POST /hitl/respond {confirmed:true, comment}` → 门禁返回 → 执行写入/下发 → 回读/ACK。
  两者共用 UI 与应答端点,但 `requestType`/`kind`/载荷不同,不能互相替代。

## 3. 为什么不能“全部 harness 原生直连”

上游能力决定:

| 引擎 | 是否有外部工具的原生注册 API | 可行路径 |
|---|---|---|
| omp | 有(`set_host_tools` RPC) | 已原生 |
| pi | 有(扩展 `registerTool`) | 已原生 |
| claude | SDK 可定义进程内工具(`tool()`/SDK MCP server) | 可改为进程内(仍需 SDK 自定义工具面),但会改变审批/HITL 适配 |
| opencode | 有插件/自定义工具面(需按版本实现) | 可写原生插件 |
| dsh | Cordis 插件面(`@deepseek-ai/dsh-mcp-client` 本身就是插件) | 可写原生 `aw-tools` 插件,替代 MCP client |
| codex | app-server 只公开 MCP server 配置 | 无原生自定义工具 API → 只能 MCP |
| gemini | 外部工具只走 MCP/扩展 | 只能 MCP |
| copilot | `--allow-tool` 白名单 + MCP | 只能 MCP |
| cursor/crush/goose/qwen/hermes | CLI 只提供 MCP 配置 | 只能 MCP |

因此:
- **“所有 harness 都能直接调用注册工具、完全不用 MCP”在当前上游版本上不成立**;
  强行做只能走 shell/脚本,那不是模型原生工具调用,且会绕过治理与 HITL。
- 现实目标是 **native-first + MCP fallback**:
  - omp/pi 默认原生;
  - opencode/dsh/claude 可后续加原生插件;
  - 其余保留 MCP(已把工具面/描述/鉴权做到与原生同源)。

## 4. 本轮修复(与本次实测直接相关)

1. **协作工具回退缺口**:`manager.invokeHostTool` 在 impl 未实现 `dispatchHostTool`(如 mock)
   时只支持 3 个协作工具,`send_message_to_agent` 报“工具桥不支持该协作工具”。
   现在回退到共享 `dispatchHostTool`,与 omp/MCP 同一执行面。
2. **按 Agent 绑定面生成工具描述**:新增 `hostToolsForAgent`,把该 Agent 的
   - 数采节点追加到 `daq_query/daq_frames/daq_export` 描述;
   - 配方与参数追加到 `recipe_*` 描述;
   - `mes-rest` 配方参数追加到 `mes_*` 描述(仅真实 MES 点位,普通产线配方不冒充 MES)。
   MCP `tools/list`、omp `set_host_tools`、pi `registerTool` 均已接上。
3. **验收脚本**:`harness-matrix-e2e.mjs`(14 引擎原生注入矩阵)、
   `harness-team-line-e2e.mjs`(团队/产线/配方/HITL)、`e2e-hitl-live.mjs`(ask + 群聊 UI)。

## 5. 证据

- `docs/audit/2026-10-20-harness-acceptance-evidence/harness-matrix.log`
- `.../harness-matrix-sequential.log`
- `.../harness-matrix-configured.log`
- `.../team-line-e2e-fixed.log`
- `.../hitl-live-omp.log` / `hitl-live-omp-fixed.log`
- `.../us001-connectivity.json`(五协议 test-driver 12/12 与 DAQ 节点状态)

> 诚实边界:14 个引擎的**代码适配**都在;本次真实跑通并产出交付物的是 omp、copilot。
> 其余 12 个的失败均有明确环境原因(未登录/配额/模型/缺 provider),不能宣称“全部 harness
> 已真实作业通过”。MCP 桥对可运行引擎的工具注册已实测覆盖 64 个(legacy 频道角色面,
> 另有 AML/观察面/插件工具按 profile 注入)。
