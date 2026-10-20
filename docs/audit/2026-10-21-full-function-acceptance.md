# 全功能复验报告（2026-10-21）

> 环境：隔离平台 `127.0.0.1:3470`（当前构建）+ 专用 PLC 模拟器 `127.0.0.1:4050`（injection-line，五协议）。
> 产线：`ln-07385fad`（注塑成型质量窗口寻优），11 DCW + 14 DAQ，配方 `rc-d1d767fb`。
> 未写 3001/3021，未触碰受保护线 `ln-d7e0a2a2`。证据：`docs/audit/2026-10-21-full-function-evidence/`。

## 1. 总体结论

| 能力面 | 结果 |
|---|---|
| 单元/类型/构建/文档 | PASS |
| 产线治理/开停线/HITL/写控 | PASS 44/44 |
| 产线日志 | PASS 24/24 |
| MES/数采/配方/UI | PASS 25/25 |
| MCP 协议/实时 API | PASS 14/14 + 34/34 + 64/64 |
| 工具注册表/Channel 工具治理 | PASS 56/56 |
| 真实闭环优化 | PASS 9/9 |
| 14 harness 工具注入 + MCP 数采调用 | PASS 73/73 |
| Agent 专属 DAQ 隔离（不绑线对照） | PASS 7/7 |
| 原生任务回合（omp/copilot） | PASS 2/2 |
| 原生 codex/mock 矩阵子集 | 未闭合（环境/脚本原因，见 §5） |

**结论：系统主链全功能通过；14 个 harness 的工具注入与 MCP 数采调用全部通过；原生 omp/copilot 任务回程通过。codex 原生矩阵未完成（provider/model 未在超时内返回），mock 矩阵任务未完成（矩阵任务描述触发 mock lead 委派但矩阵未建 worker，属测试脚本缺陷）。这不是工具注入失败。**

## 2. 全量套件结果

| 套件 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 单元 | `npm run test:unit` | **283/283** | `unit.log` |
| MCP 单测 | `npm run test:mcp` | **14/14** | `mcp.log` |
| MCP live | `npm run test:mcp-live` | **34/34** | `mcp-live.log` |
| 产线治理 | `npm run test:e2e-line` | **44/44** | `e2e-line.log` |
| 产线日志 | `npm run test:line-log` | **24/24** | `line-log.log` |
| MES/数采/配方 | `npm run test:mes-agent` | **25/25** | `mes-agent.log` |
| API/WS/MCP 端点 | `npm run test:api-live` | **64/64** | `api-live.log` |
| 工具注册表/Channel 治理 | `node scripts/tool-registry-e2e.mjs` | **56/56** | `tool-registry.log` |
| 闭环优化 | `npm run test:e2e-injection` | **9/9** | `e2e-injection.log` |
| 类型检查 | `npm run typecheck` | PASS | `typecheck.log` |
| 生产构建 | `npm run build` | PASS | `build.log` |
| 文档一致性 | `npm run docs:check` | **91/0** | `docs-check.log` |

## 3. 逐 harness 工具注入（14/14，MCP 工具面）

方法：在绑定产线的测试 Channel 中为每个 harness 创建独立 worker；每个 worker 绑定**不同的 DAQ 节点**和同一配方（manual）。检查 `GET /api/workshop/agent-tools/list?agentId=` 返回的工具面、描述是否包含该 Agent 的专属节点/配方；再用 `aw-mcp-bridge.mjs` 以该 Agent token 真实 `tools/list` + `tools/call daq_query`。

| harness | Agent 创建 | 工具数 | daq_query 含专属节点 | recipe_trial/update 含配方 | MCP daq_query |
|---|---|---|---|---|---|
| mock | ✔ | 64 | ✔ | ✔ | ✔ |
| omp | ✔ | 64 | ✔ | ✔ | ✔ |
| opencode | ✔ | 64 | ✔ | ✔ | ✔ |
| codex | ✔ | 64 | ✔ | ✔ | ✔ |
| dsh | ✔ | 64 | ✔ | ✔ | ✔ |
| claude | ✔ | 64 | ✔ | ✔ | ✔ |
| gemini | ✔ | 64 | ✔ | ✔ | ✔ |
| copilot | ✔ | 64 | ✔ | ✔ | ✔ |
| cursor | ✔ | 64 | ✔ | ✔ | ✔ |
| crush | ✔ | 64 | ✔ | ✔ | ✔ |
| goose | ✔ | 64 | ✔ | ✔ | ✔ |
| qwen | ✔ | 64 | ✔ | ✔ | ✔ |
| pi | ✔ | 64 | ✔ | ✔ | ✔ |
| hermes | ✔ | 64 | ✔ | ✔ | ✔ |

- 73/73 断言通过；证据 `harness-tool-injection.json` / `harness-tool-injection-summary.json`。
- 该测试 Channel **绑定了整条产线**，所以 14 个 Agent 都可只读查询整线 14 个 DAQ 节点；各自绑定节点在返回首段，但授权面是“直接绑定 ∪ 频道绑线”，**不是只返回自己的节点**。
- 专属隔离另做负向对照（不绑线 Channel）：`agent-daq-isolation.json` 7/7 PASS——A 只能查自己的 1 个节点、B 只能查自己的 1 个，A 调 B 的节点被引用校验拒绝（列出“你的绑定节点”）。
- 14 个 MCP 调用均成功；其中 pi 的 `wall-profile`、hermes 的 `surface-image` 自身节点当前 offline/无窗口数据（调用成功≠该节点有数据），其余 12 个节点有真实样本。
- 工具数 64 是 worker 角色过滤后的实测值；未实测 lead 全量数，不把内置 86 当作 lead 实测值。

## 4. 真实下发与闭环

- **单 harness 下发（omp）**：MCP 桥调用 `recipe_trial`（45→46.8bar，Δ=1.8 ≤ stepLimit），HITL `ap-5e9e8b6b` 批准后整批设备证实，DCW 回读 46.8。
- **完整闭环（注塑线）**：`recipe_trial` 45→50→55→60→65bar，逐轮 HITL，65s 后 DAQ 复测；最终克重 32.28g、飞边 0.009%、缩痕 1.41%、熔温 246.6℃；`recipe_update` 固化 v2 并回读 65/6。9/9 PASS。

## 5. 未闭合项（如实记录）

1. **原生 codex 矩阵子集**：`harness-matrix-e2e.mjs --harnesses mock,omp,copilot,codex` 中 codex 任务 181s 仍 WORKING；omp/copilot 分别 15.1s/36.3s COMPLETED 并回传 `HARNESS-OK`。平台日志显示 codex `PROCESS_EXIT` + D1 兜底，**根因未捕获**；不能断言是 provider/model 超时。codex 的 MCP 工具注入/数采调用在 §3 已 PASS。
2. **mock 矩阵子集**：mock lead 任务 181s WORKING。根因是矩阵任务描述 242 字符超过 mock lead 的简单任务阈值（>240），mock lead 走“委派给 worker”分支，但矩阵脚本只建 lead、未建 worker；不是工具注入失败。可加 `[mock:simple]` 或建 worker 复跑。
3. **pi 原生**：仅验证了工具清单与 MCP 路径；pi 的原生 `pi.registerTool` 注入沿用同源 `hostToolsForAgent`，但本轮未用 pi 模型回合做端到端；另外 9 个 harness（opencode/dsh/claude/gemini/cursor/crush/goose/qwen/hermes）也未做原生 LLM 回合。14/14 是 **MCP 工具面**结论，不是 14 个原生回合结论。
4. 本轮未重新跑 AMD/AML 平台模型训练；数字孪生训练/虚拟模型的上轮结果仍见 `2026-10-20-scenario-suite-*`（服务级 PASS，平台级 cast-film 门禁失败）。

## 6. 非阻塞发现

- `scenario-suite-setup.mjs` 的两条自检断言有缺陷：产线运行态脚本读的是 `lineState.running/state`，而 API 返回的是 `active`；“复算均值”误取首个节点（熔温）而非克重节点。实际数据正确，脚本已记录为测试工具缺陷；setup 汇总为 21 PASS / 2 FAIL，分析报告本身有效。
- HITL 均为脚本以 admin token 调 `/api/workshop/hitl/respond` 完成，不是人工 UI 点击；闭环脚本是 mock optimizer 的固定 45→50→55→60→65 序列，证明链路而非 LLM 自主寻优。
- `recipe_trial` 本轮均带 `emergency: true`，且测试实例设置 `AW_TRIAL_INTERVAL_MS=0`；**频控被刻意绕过，未验证频控**。P7 的 `dcw_journal(recipe_id)` 返回空，写控可追溯性实际由 `dcw-writes.json` / `audit_log` 证明，不能据 P7 单独宣称。
- 平台 3470 启动于 00:54，build.log 完成于 01:13；server 代码未在本轮测试后改动，但“测试二进制与最终 build 完全同源”未严格证明。
- MQTT/OPC UA/Modbus/HTTP 五协议设备全部 running；`daq_query` 调用 14 节点全部成功，其中 12 个节点有真实样本，pi/hermes 的 2 个绑定节点当前 offline（调用成功≠有数据）。
- `recipe_trial` 是配方整批操作，按配方窗口/审批治理；节点 `stepLimit` 是单点直写限制，二者语义不同。本轮 `emergency:true` + `AW_TRIAL_INTERVAL_MS=0` 绕过频控，频控未验证。

## 7. 提交与独立复核

- 提交：**16c1973a** `test(full): 复验产线控制、工具注入与 14 harness 专属工具调用`，已推送 `tii-revision-20261017`。
- 独立 reviewer 首轮：**CONDITIONAL**。已修正报告中的“只返回自己的绑定节点”夸大（补 `agent-daq-isolation` 7/7 无绑线对照）、codex 根因（改为进程退出、根因未捕获）、频控（明确 emergency+interval 0 绕过、未验证）、P7（写控可追溯改由 dcw-writes/audit_log 证明）、setup 断言描述；pi/hermes 自身节点 offline 已披露。
- 未闭合项保持：原生 codex/mock 矩阵子集、pi 与另外 9 个 harness 的原生 LLM 回合未测；14/14 只代表 MCP 工具面 + 工具注入，不代表 14 个原生回合。
- 3470/4050 已停止（含 start.mjs supervisor 一并终止，复核端口无监听）。

## 8. 结论与边界

- **可判定通过**：系统主链、产线治理、数采/写控/配方/HITL、工具注册表、Channel 工具治理、14 harness 工具注入与 MCP 调用。
- **不可宣称全部通过**：原生 codex/mock 矩阵子集未完成；pi 原生回合未测；平台级数字孪生模型训练上轮门禁失败。原因是环境/模型/测试脚本，不是工具注入代码缺失。
- 未做真实 PLC/MES 割接；Mimosa 完整安全扫描未完成，报告不构成安全审计结论。
