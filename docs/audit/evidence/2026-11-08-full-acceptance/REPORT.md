# 全功能实机验收报告（2026-11-08 · :4001）

> 覆盖：Plan 新增功能回归、多 harness 适配、Channel 多会话隔离、Agent 生命周期对象隔离、
> Project 模式全链、前后端交互与实机浏览器演示。
> 环境：`AW_MODE=home` + `.deep-home-20261108` + `BACKUP_DISABLED=1`，生产构建 `node .output/server/index.mjs`。

## 一、总览

| 套件 | 结果 | 证据 |
| --- | --- | --- |
| 健康检查 | `status=ok` / `workshop=ready` | `harness-isolation.json` H0 |
| 全 14 harness 构造契约 | **16/16** | `tests/harness-construction-contract.test.ts` |
| 多 harness 实机 + 对象隔离 | **24/24** | `harness-isolation.json` |
| Channel 模板多会话 | **20/20** | `../2026-11-08-multisession-opt/channel-multisession.json` |
| Project 模式（记账软件） | **58/58** | `../2026-11-08-final-acceptance/bookkeeping.json`（本轮重跑） |
| 前后端交互（headless Chrome） | **12/12** | `ui/ui-results.json` |
| 静态回归 | typecheck ✔ · lint 0 error · unit 1253 pass/0 fail/2 skip · build ✔ | `logs/{typecheck,lint,unit,build}.log` |

## 二、多 harness 适配（mock / omp / dsh / codex / opencode）

每个引擎独立建频道并激活，全员构造与启停成功：

- H1×5：创建成功并返回 `channelId` / `leadAgentId`（创建响应本身不校验 harness；harness 一致性由 H2 激活后的成员读取验证）
- H2×5：`activate` 200，成员列表可读，lead harness 正确
- H3×5：worker 创建成功
- H4/H5：lead 与 worker 的 `agentId` 跨 5 频道**互不重复**
- H6：A 频道成员列表不含 B 频道成员
- H7：A 频道删除 B 成员 → 非 2xx（invoke 以 agentId 为身份、无频道参数，故未做跨频道 invoke 断言）
- H8：无 @ 群聊消息 → **0 次 Agent 执行**（不回落默认 lead）
- H9：停用成员 → invoke 被拒（HTTP 4xx/5xx 或 isError）
- H10：删除成员 → 列表消失
- H11：关闭频道 A → 频道 B 成员仍 `enabled=1`

> 说明：本轮验证的是「引擎可实例化 + 频道/成员对象隔离 + 生命周期」，**未**对 dsh/codex/opencode
> 逐一发真实 LLM 消息（成本与时长）；真实 LLM 回复路径由 omp 在既有套件中覆盖。

## 三、Channel 多会话隔离（20/20）

- 同一模板实例化 → 两个会话，各克隆成员；`cloneId` 互异
- 会话 A/B 并行真 LLM 对话；会话级真实产线读（daq_query / line_context）
- 会话 A 治理写：`recipe_trial` → HITL → 批准 → 设备回读收敛
- 关闭 B：B 克隆 `enabled=0`、B 身份 invoke 被拒；A 克隆仍可作业；基础成员保留

## 四、Project 模式（58/58）

三频道（需求/开发/测试）+ 三个工作项 W1/W2/W3（`dependsOn` 链未独立断言）+ plan 审批 + L1/L2 签核 →
项目 `completed`；真实产物 `SPEC.md / ledger.py / test_ledger.py / TEST-REPORT.md`，
`python` 真实执行 PASS；负面用例「缺 leaderHarness → 400」通过。

## 五、前后端交互演示（12/12）

交互断言由 **headless Chrome** 驱动（`frontend-interaction-demo.mjs`）；`desktop-*.png` 由**非 headless Chrome 窗口**截图（复现脚本 `desktop-demo-shot.mjs`）。两者都是真实 Chrome 渲染，区别只是截图来源窗口。

| 断言 | 内容 | 截图 |
| --- | --- | --- |
| U1 | Channel 控制台加载 + 群聊可见 | `ui/u1-channel-chat.png` |
| U2 | 切换任务板 | `ui/u2-task-board.png` |
| U3 | 切换多会话 | `ui/u3-sessions.png` |
| U4 | 切换时间线 | `ui/u4-timeline.png` |
| U5 | 发言后刷新仍存在（后端持久化；投递台账未在本轮断言） | `ui/u5-chat-persist.png` |
| U6 | 全程无 pageerror | — |
| U7×5 | Project 五个 tab 全部渲染 | `ui/u7-project-overview.png` / `ui/u8-project-approvals.png` |
| U9 | Project 关键 testid 齐备 | — |

实机窗口（非 headless Chrome，脚本 `scripts/_audit/desktop-demo-shot.mjs`）：`ui/desktop-channel.png`、`ui/desktop-project.png`。

## 六、未覆盖 / 残余风险（如实）

1. **未使用 MCP computer-use 的桌面级截屏**：用非 headless Chrome 窗口截图替代；
   两者都证明真实渲染，但后者不含桌面其他窗口。生成脚本位于 `scripts/_audit/desktop-demo-shot.mjs`（本轮工作区）。
2. dsh/codex/opencode 只验证到「启动 + 成员 + 隔离」，未做真实 LLM 对话。
3. Project 全链的 Lead 为 mock；四个交付物文件由驱动写入（脚本头已披露），`python` 真实执行验证。plan 的 `dependsOn` 链未独立断言（脚本只校验 w1/w2/w3 非空）。
4. 多 harness 频道为验收临时数据，已清场；A 频道关闭、其余删除。
5. 全量 unit 与 build 并行时 `http-drivers.test.ts` 超时属已知资源竞争，串行 0 fail。

## 七、结论

Plan 新增功能的核心链路（多会话隔离、Project 全链、多 harness 启动适配、Agent 生命周期对象隔离、
前后端交互）在真实实例上全部通过；UI 改造未破坏既有 testid 与交互语义。可交付。
