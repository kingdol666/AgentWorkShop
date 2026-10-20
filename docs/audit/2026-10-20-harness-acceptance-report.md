# 多 Harness / 团队作业 / 产线 HITL 全链验收报告

- 日期:2026-10-20
- 平台:AgentWorkShop 0.7.67(构建产物 + 全局 npm 安装)
- 测试对象:14 个注册 harness、Agent 团队作业、产线/配方、原生 ask HITL、群聊 UI
- 结论:**omp、copilot 两条真实引擎全链通过;团队/产线/配方/manual HITL 14/0 全绿;
  ask HITL + 群聊 UI 选项 W1–W8/U2 全绿。其余 12 个引擎的代码适配在,但本机凭据/配额/
  上游配置不满足,不能宣称“全部 14 个真实作业通过”。**

## 1. 验收规范(A1–A8)

| 编号 | 验收项 | 判定 |
|---|---|---|
| A1 | harness 注册表/可用性探测与真实拉起同源 | 14 个引擎均可被 `/api/workshop/harnesses` 发现;PATH 探测与 spawn 同源 |
| A2 | 原生工具注入 | omp(`set_host_tools`)、pi(`registerTool`)为原生;其余 MCP 桥 |
| A3 | MCP 桥工具注册 | 实测 `tools/list` 返回 64 个(legacy worker 角色面),含任务/消息/配方/MES/数采 |
| A4 | 按 Agent 绑定面生成描述 | 分析师 `daq_query` 描述含 5 个绑定节点;操作员 `recipe_update` 含配方参数 |
| A5 | 团队作业/任务派发/mailbox | mock lead 自动派发子任务并完成;lead→analyst 消息落库(state=consuming) |
| A6 | 产线管理/数采 | omp 分析师 `line_context` + `daq_query` 取真实样本并完成 |
| A7 | 配方 + manual 下发 HITL | copilot 两次 HITL 批准(update/apply),配方 v3,PLC 回读=47 |
| A8 | 原生 ask HITL + 群聊 UI | AEP `hitl.request`(select/yes/no)→ 铃标/群聊页 `.hitl-opt` 渲染 → 应答 → agent 收到 yes |

## 2. Harness 真实运行矩阵

| harness | 注入方式 | 原生? | 本次结果 | 失败原因(环境) |
|---|---|---|---|---|
| omp | JSON-RPC `set_host_tools` | **是** | **PASS** `HARNESS-OK:omp` | — |
| copilot | MCP 桥 | 否 | **PASS** `HARNESS-OK:copilot` | — |
| codex | MCP 桥 | 否 | 未通过 | 默认 provider 反复重连;`glm-5.3-flash` 404 |
| opencode | MCP 桥 | 否 | 未通过 | Zhipu 周限额耗尽(23:22 重置) |
| dsh | profile MCP client | 否 | 未通过 | profile patch 为空(未挂 AW 工具);Windows 沙箱 ACL 拒绝 |
| claude | SDK MCP | 否 | 未通过 | 平台 SDK 会话未拿到可用模型凭据(直接 CLI 可用) |
| gemini | MCP | 否 | 未通过 | 缺 GEMINI_API_KEY/OAuth |
| cursor | MCP | 否 | 未通过 | 需 `agent login`/CURSOR_API_KEY |
| crush | MCP | 否 | 未通过 | 无 provider |
| goose | MCP | 否 | 未通过 | 无 provider |
| qwen | MCP | 否 | 未通过 | 缺 OPENAI_API_KEY |
| hermes | MCP | 否 | 未通过 | OpenRouter 模型 300s 未回 |
| pi | 原生扩展 | **是** | 代码路径已验证;未跑 | provider 配额耗尽(23:22 重置) |
| mock | 进程内 | — | 团队调度 PASS | 无 LLM 工具面(测试替身) |

## 3. 团队/产线/配方/manual HITL(最终 14/0)

证据:`team-line-e2e-final.json` / `.txt`

- 频道 `44215fee…` 绑定 `ln-dd6c9135`;mock lead + omp 分析师 + copilot 操作员 + mock worker
- 分析师绑定 5 个数采节点;操作员绑定配方 `rc-2be5c50c`(manual)
- mailbox:lead `send_message_to_agent` → `e5a408ec → caa71552`,state=consuming
- 任务派发:root `a4185e93` 由 mock lead 自动派发并 COMPLETED
- omp 分析师:`line_context` + `daq_query` 取数并 COMPLETED(交付物含活动批次/样本)
- copilot 操作员:`recipe_update` 46→47 → HITL 批准 → `recipe_apply` → HITL 批准
- 结果:配方 v3;PLC 线速回读 **47 m/min**;ACK 4/5 证实(流量 MQTT 为 transport-ack)

## 4. 原生 ask HITL + 群聊 UI

证据:`hitl-live-final.log` / `.txt`

- W1/W2:omp lead channel + 驻留任务
- W3:AEP `hitl.request`,kind=`omp-dialog`,method=`select`,options=`yes/no/Other`
- W4:`GET /hitl/pending` 含目标待办
- U2c:群聊页 `/workshop/w/<channelId>` 加载
- U2d/U2e/U2f:群聊页铃标弹出 `Proceed?`,渲染 yes/no 按钮 + 提交答案按钮
- W5–W8:`POST /hitl/respond` → `hitl.resolved(answered)` → 待办清空 → agent `ask` 收到 `yes`
- Phase T(TUI):T1 通过后服务重启,未完成;不影响 W/U 原生 HITL 结论

> ask 与 manual 写是两条链路:ask 是 `requestType=question` 的提问型 HITL;
> manual 配方下发是 `kind=dcw-approval` 的审批型 HITL。本次两条都实测通过。

## 5. 工具注册/调用全流程(代码事实)

1. `.AgentWorkShop/prompts/host-tools.json`(86 个定义)由 `loadHostToolDefs()` 加载。
2. `hostToolsForRole` 按角色/Channel profile/插件开关过滤。
3. **新增** `hostToolsForAgent` 在描述尾部追加该 Agent 绑定的数采节点/配方/MES 点位。
4. 注入:
   - omp:`set_host_tools`(进程内 JSON-RPC);
   - pi:`AW_PI_TOOLS_FILE` → `pi.registerTool`;
   - 其余:`aw-mcp-bridge.mjs` 的 `tools/list` → `GET /api/workshop/agent-tools/list?agentId=…`。
5. 调用:
   - omp:`host_tool_call` → `handleHostTool`;
   - pi/MCP:`POST /api/workshop/agent-tools/invoke`;
   - 统一入口 `manager.invokeHostTool` → 权限作用域 → 插件 → `dispatchHostTool` → 工业/协作/任务/记忆 handler。
6. HITL:handler 内 `hitlDispatchGate` → `hitl-registry` → UI → `/hitl/respond` → 引擎恢复。

## 6. 本轮修复

1. **协作工具回退缺口**:无 `dispatchHostTool` 的 impl(如 mock)经 MCP/HTTP 调用
   `send_message_to_agent` 被旧开关拒绝;现回退共享 `dispatchHostTool`。
2. **按 Agent 绑定面生成工具描述**:MCP `tools/list`、omp `set_host_tools`、pi 扩展三路同源。
3. **验收脚本**:新增 `harness-matrix-e2e.mjs`、`harness-team-line-e2e.mjs`;
   `e2e-hitl-live.mjs` 支持预置 token 与群聊 UI 断言。

## 7. 打包/发布/全局启动

- `npm version 0.7.67 --no-git-tag-version`
- `npm pack` → `agentworkshop-0.7.67.tgz`(40.8 MB,3735 files,含 `.output`/bridge/per-agent)
- `npm install -g --prefix C:/nvm4w/nodejs <tgz>` → 全局 0.7.67
- 首次打包时 `.output` 仍是 0.7.66(先 build 后 bump 的顺序错误),已重新构建 0.7.67 后再打包
- 全局实例启动(命令行为 `C:/nvm4w/nodejs/node_modules/agentworkshop/.output/server/index.mjs`):
  - `/api/health` 返回 `version: 0.7.67`
  - MCP `tools/list` 64 个工具,`daq_query` 描述含绑定节点
  - omp 任务交付物 `GLOBAL-067-OK`
- **registry publish 未执行**:本机 `npm whoami` 无凭据,且 registry 是 npmmirror(只读镜像);
  需要用户提供 npmjs token。已完成“本地打包 + 全局安装 + 全局启动”验证。

## 8. 诚实边界

- 14 个引擎的**代码适配**都在,本次真实跑通并产出交付物的是 **omp、copilot**;
  其余 12 个是环境/凭据/配额问题,不是“已全部通过”。
- gemini/qwen/cursor/crush/goose 需要先登录或配置 provider;codex/opencode/pi 受模型配额影响;
  dsh 还缺 AW profile 注入(可作为下一步修复项)。
- “所有 harness 不用 MCP”在当前上游版本不可行:codex/gemini/copilot/cursor/crush/goose/qwen/hermes
  只公开 MCP 作为外部工具面;omp/pi 已原生,opencode/dsh/claude 可后续写原生插件。
- Phase T TUI 在服务重启时中断;W/U 的 ask HITL 与群聊 UI 已通过。
- 发布包的全局实例启动验证使用 `node <global>/.output/server/index.mjs`;`aw start` 在仓库 cwd
  会优先使用仓库 `.output`,这是 CLI 的设计行为。
