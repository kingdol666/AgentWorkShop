# TUI 终端工作台(`aw tui`)

与 AgentTeam 交互作业的终端客户端。渲染层基于 `@earendil-works/pi-tui`(openclaw
同款组件化 TUI 框架),代码在仓库 `tui/` 目录(`.mjs` 直跑,零构建);与服务端
的关系和 WebUI 平级 —— 同一套 REST + AEP WebSocket,不引入新的服务端形态。

> 完整用法/按键/命令表见 [`tui/README.md`](../tui/README.md);本文是架构与集成说明。

## 能力总览

- **频道管理**:`/channel new|use|add` 创建频道(可内联建 lead)、切换订阅、
  放置 Agent 实例(模板克隆或内联定义)。
- **任务下发**:普通文本发 lead(`priority=task`);`/send` immediate 直发
  (忙碌时 steer 注入 omp 当前回合);`/task` 正式任务(goal/loop/pipeline)。
- **实时观察**:AEP WS 订阅(断线 `lastSeq` 续传);`/monitor <agent>` 打开
  右侧终端镜像面板(omp `rpc-ui` 会话的净化帧流)。
- **HITL 统一作答**:omp ask 对话框与 dcw 下发审批的待办在 `/hitl` 聚合,
  作答经 `POST /api/workshop/hitl/respond` 路由回 omp stdin / 审批裁决。

## HITL 集成(服务端增量)

服务端新增 `server/services/workshop/agents/hitl-registry.ts`(进程内待办登记处):

- 两条既有 HITL 链路统一登记:`harness-terminal.ts`(omp `extension_ui_request`,
  park 语义:零订阅倒计时 `security.hitl_timeout_ms`,订阅即暂停)与
  `tool-approvals.ts`(dcw 审批,180s 超时同源)。
- AEP 新帧:`hitl.request` / `hitl.resolved`(频道流 publish + 全员直推各一路,
  WebUI/TUI 不依赖频道订阅即达;快照恢复走 `GET /api/workshop/hitl/pending`)。
- 统一应答:`POST /api/workshop/hitl/respond`(幂等,已落定返回 409
  `ALREADY_RESOLVED`;用户 token + channel 所有权校验 + audit 留痕)。

WebUI 侧:`app/stores/workshop/hitl.ts` 消费帧 → `AppHeader` 铃标 → 点击跳
`/monitor?agentId=&channelId=` 直达该 Agent 终端作答(OmpTerminalPanel 既有
作答界面不变)。

## 测试

| 命令 | 覆盖 |
|---|---|
| `npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-hitl-registry.ts` | registry 登记/落定/订阅/park 暂停与超时(22 断言);根 tsconfig 为 solution-style,tsx 须显式指定含 `@/*` 映射的子配置 |
| `node scripts/test-tui-reducers.mjs` | AEP 帧 → 会话状态归约(15 断言) |
| `node scripts/test-tui-commands.mjs` | 命令解析/分发(21 断言) |
| `node scripts/tui-smoke.mjs` | 无头 e2e:虚拟终端驱动真实 TUI ↔ 真实 dev server(12 断言) |
