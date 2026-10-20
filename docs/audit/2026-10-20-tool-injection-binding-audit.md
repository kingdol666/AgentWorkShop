# 工具注册 / 注入 / MCP 对接 / 按 Agent 绑定面审计(0.7.68)

- 日期:2026-10-20
- 版本:**0.7.68**(全局 npm 安装实例 3001)
- 结论:**内部工具 + 插件工具都能经 MCP 被 harness 调用;不同 Agent 的 DAQ/配方/MES
  描述按其绑定面生成,执行面再做一次授权拦截。** 但“参数 schema 按 Agent 枚举”
  没有做——schema 是共享的,差异在描述与运行时授权,见第 5 节边界。

## 1. 注册与注入全流程(代码事实)

### 1.1 工具来源

| 来源 | 位置 | 数量/示例 |
|---|---|---|
| 内置 host tools | `.AgentWorkShop/prompts/host-tools.json` → `loadHostToolDefs()` | 86 个定义 |
| 插件工具 | 插件 `ctx.omp.registerTool(...)` → `registerPluginTool()` | `kb_agent`、`diag_run`、`diag_status`、`serial_ports`、`optimizer_state` 等 |
| 外部 MCP | 平台自身 `mcp/` server(反向暴露给外部客户端) | 与 harness→平台方向分开 |

### 1.2 装配与过滤

1. `hostToolsForRole(role, channelId)`:
   - lead/worker 角色过滤(LEAD_ONLY);
   - Channel profile(legacy/hybrid_twin/aml_training/aml_optimization/exp-miner/line-doctor);
   - 写面 fail-closed、插件团队开关；
   - 合并 `listPluginTools()`(插件工具与内置同名时内置优先)。
2. `hostToolsForAgent(agentId, role, channelId)`(本轮新增/增强):
   - 读取 `agent-node-bindings.json`；
   - DAQ:显式 `kind=daq` 绑定 + **频道绑线只读节点**(与执行面 `daqTargetsOf` 同源)；
   - 配方:显式 `kind=recipe` 绑定的配方及其参数；
   - MES:配方参数中 `driver=mes-rest` 的点位；
   - 把资源清单追加到对应工具描述尾部（`daq_query/daq_frames/daq_export`、
     `recipe_*`、`mes_*`）。
3. DAQ 执行面 `daqTargetsOf` 的可读集 = 显式 DAQ 绑定 ∪ 频道绑线节点；
   `node_id`/`line_id` 只能缩小范围，越权一律拒绝。

### 1.3 注入到 harness

| harness | 注入方式 | 是否 MCP |
|---|---|---|
| omp | JSON-RPC `set_host_tools` → `host_tool_call` 回程 | 否(原生) |
| pi | `AW_PI_TOOLS_FILE` → `pi.registerTool` 扩展 | 否(原生) |
| copilot / codex / opencode / dsh / claude / gemini / cursor / crush / goose / qwen / hermes | `server/harness/aw-mcp-bridge.mjs` stdio MCP server | 是 |

MCP 桥:
- `tools/list` → `GET /api/workshop/agent-tools/list?agentId=…`（与 omp/pi 同源的
  `hostToolsForAgent` 结果）；
- `tools/call` → `POST /api/workshop/agent-tools/invoke`（`x-aw-agent-token` 自证）；
- 统一入口 `manager.invokeHostTool`：
  `权限作用域 → 插件工具 → impl.dispatchHostTool → 共享 dispatchHostTool → handler`。

## 2. 不同 Agent 的绑定面实测(0.7.68)

同一频道 `adf01bfa…`（绑线 `ln-dd6c9135`）:

| Agent | 绑定 | `daq_query` 描述尾部 |
|---|---|---|
| omp-analyst | 5 个显式 DAQ | “直接绑定:线速PV/温度PV/压力PV/流量PV/膜厚PV” + “频道绑线只读:膜厚断面/表检图像” |
| copilot-operator | 仅配方 manual | “频道绑线只读:线速PV/温度PV/压力PV/流量PV/膜厚PV/膜厚断面/表检图像”(7 个) |

执行面验证:
- analyst `daq_query(node_id=dn-4de6b1de)` → 成功返回流量PV；
- analyst `daq_query(node_id=dn-ffffffff)` → 拒绝“不在授权范围内”；
- 插件频道 `bab03588…` 的 Agent 查 `dn-4de6b1de` → 拒绝(跨线，节点属于 ln-dd6c9135)。

## 3. 插件工具与 MCP

- 插件启用频道 `bab03588…` 的 MCP `tools/list`:**76 个工具**，其中插件工具 9 个:
  `optimizer_campaign/optimizer_round/optimizer_state/sensor_calibration_log/
  diag_run/diag_status/kb_agent/kb_agent_status/serial_ports`。
- MCP `tools/call diag_status {}` → 返回最近 5 条诊断(成功)。
- `kb_agent_status {}` → 正确返回“task_id 必填”，说明 schema/参数校验生效。
- 真实 MCP harness(copilot)任务:
  - `daq_query(dn-4de6b1de,last_minutes=5)` → 最新 **45.1 L/min**；
  - `diag_status {}` → “最近 5 条诊断”；
  - `complete_task` 交付物：`COPILOT-MCP-OK ...`。
- 团队频道 `adf01bfa…` 的 worker MCP 工具数 64（角色过滤后），同样包含插件工具
  （未显式关闭的插件默认启用；这是现有兼容语义）。

## 4. MES API 集成实测

创建临时 MES 探针(线 `ln-a3036f9c`，节点 `dw-521a9471`，配方 `rc-62ba943d`)，
绑定给 mock lead 后经 MCP:

- `mes_fetch` 描述尾部出现:
  `本 Agent 可经配方参数面取数的 MES 点位:MES熔体温度-mvgh7t9k(dw-521a9471,℃)`
- `mes_fetch(ids=[dw-521a9471], from, to, max_rows=20)` 返回真实 MES 历史:
  - 统计 `min 248.95 / max 252.204 / mean 250.708 / stddev 0.796 ℃`
  - 采样 3 行
  - 字段字典 `value [melt_temp 测量值 | °C | scalar]`
- 说明:MES 模拟器 token 通过进程 env `AW_MES_DEMO_TOKEN` 提供；运行时设置
  `mes.secret.DEMO` 不在 schema 白名单，API 无法写入（见边界）。

## 5. 边界与缺口(必须知道)

1. **schema 不按 Agent 枚举**:`daq_query`/`recipe_update`/`mes_fetch` 的 JSON Schema
   仍是共享形状(参数为 `node_id`/`params`/`ids`)，Agent 通过描述里的“可用资源清单”
   知道该传什么；真正的越权拦截在执行层(grant-guard/tool-verify)。没有把 node_id
   做成 enum 塞进 schema。
2. **频道绑线只读扩权**:Agent 不显式绑定 DAQ，也能读整条绑线产线的数采；描述已补上
   “频道绑线只读”清单，与执行面一致。
3. **MES secret 动态键**:`mes.secret.<ref>` 被驱动支持，但不在
   `shared/config/schema.json`，设置 API 会拒绝；本轮用 env 验证。生产应把该动态键纳入
   schema 或改用密钥服务。
4. **插件开关默认**:未配置 `channel_plugins` 行的频道默认启用全部插件；要隔离需显式
   PUT 关闭(既有的团队级开关语义)。
5. **12 个 harness 未真实作业**:omp/copilot 通过；其余受未登录/配额/上游配置阻塞。
   pi 原生路径存在但本机配额耗尽。
6. **TUI HITL 仍有 6 项失败**；Web/API 的 ask HITL 已通过。
7. **模拟器预验收**:PLC 是协议级模拟器，不是物理 PLC 现场。

## 6. 本轮验证命令/证据

- 单元:`npm run test:unit` **268/268**;`npm run typecheck` ✔。
- 证据:
  - `us009-tool-injection.json`(MCP 64/76、插件 9、DAQ 绑定/越权/插件调用)
  - `us010-binding-descriptions.json`(analyst 5+2、operator 7)
  - `us011-mes-mcp.json`(MES 描述 + 真实取数统计/字段字典)
  - `us012-copilot-mcp-tools.json`(copilot 经 MCP 调 daq_query + diag_status)
- 版本:0.7.68 全局 npm 实例；MES token 仅进程 env，不入库/不入源码。
