# 会话管理并入对话页 + 删除确认位置化 —— 验收与整理（2026-11-26）

**隔离实例**：`http://127.0.0.1:3081`（AgentWorkShop v0.21.0，隔离 home，真实 Chrome UI）
**证据**：`D:/tmp/aw-line-demo-20261126/`（87 screenshots、`evidence.json`、`line-summary.json`、`screens/`）
**纪律**：本轮只承认自己执行过的结果；不可见、不可批的路径标 PARTIAL / NOT_RUN，不冒充通过；未对真实 PLC 写入；共享 MQTT/Timescale 只复用不重启。

---

## 1 覆盖矩阵（本轮）

| 层 | 项目 | 结果 | 证据 |
| --- | --- | --- | --- |
| UI | 新建 Workspace「产线作业演示」 | PASS | `a01-a03` |
| UI | 手工 Channel「无产线作业」 | PASS | `a04-a06` |
| UI | Channel 模板「实例化·全栈交付通道」 | PARTIAL | `b01-b05`（装配完成，UI 无入口） |
| UI | AgentPrefab 新建/编辑/发布 revision=1 | PASS | `c01-c04, d02-d03` |
| UI | AgentPrefab 绑定频道成员 | PASS | `e01-f07, g01-g02` |
| UI | 频道设置 执行模式「手动」 | PASS | `j02-j03` |
| UI | 删除/移除就地确认（Popconfirm） | PASS | `probe-07`（Town/Channel）、`d02`（发布 Modal）、`p9`（频道 X） |
| UI | 闭环频道可见/可管理 | BLOCKED | 不在 `workspace.channelIds`，UI 无入口 |
| API | 会话改名/归档/恢复/清理 | PASS | 单测 `session-archive-purge`；E2E API（2026-11-26） |
| API | 归档会话必须先关闭（150 ms） | PASS | `session-managed-guard`；重复归档 409 |
| API | 产线建线 | PASS | `ln-5addafe9`（UI 尝试为 PARTIAL，改 API） |
| PLC | 影子仿真孪生 `:4034` | PASS | `sim-twin` 归属证明 + tick 活性 2/0 |
| API | DCW/DAQ 节点 + driverConfig | PASS | `dw-932bb43c`（SP）、`dn-c3e3cc1e`（PV） |
| API | SV 写入 + 回读 | PASS | raw 182.5 / readback 182.5 / `readback-verified` |
| API | DAQ 采集查询 | PARTIAL | query 200；样本窗口空 |
| HITL | 手动模式在 UI 可选项落存 | PASS | `j02-j03` |
| HITL | 审批卡 / 一次人工参数下发 | NOT_RUN | 本轮无配方试验链路 |
| 模型 | 本地 Gemma 实回合 | NOT_RUN | omp 频道不在 workspace UI |
| 功能 | 参数自动学习 | NOT_FOUND | 代码库无该实现；最接近优化器/参数试验 |
| 门禁 | lint / typecheck / unit / i18n / docs / build | PASS | `gates` |

---

## 2 测试整理（本轮实际跑过）

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| 全量单测 `npm run test:unit` | 2,371 / 2,370 pass / 0 fail / 1 skip | 本轮发布前重跑 |
| 会话契约 `tests/chat-session-host-contract.test.ts` | 7/7 | 群聊宿主、事件序号、项目深链、旧视图移除、就地确认 |
| 归档清理 `tests/session-archive-purge.test.ts` | pass | 先关闭、再归档、清理按属主/可见频道 |
| 管理守卫 `tests/session-managed-guard.test.ts` | pass | task/project/catalog 拒绝、跨频道 404、归档关闭 150 ms |
| eslint | 0 | `npm run lint` |
| typecheck | pass | `npm run typecheck` |
| i18n | 3,577/3,577 unresolved 0 | `npm run i18n:check` |
| docs | 101/0 | `npm run docs:check` |
| readme lint | pass | `npm run readme:lint` |
| build | pass | `node bin/aw.mjs build` |
| boot smoke | 6/6 | `npm run test:boot-smoke`：健康/SSR/401 + 缺密钥拒绝启动 |
| 真实 Chrome UI | PASS | `D:/tmp/aw-line-demo-20261126` 11 步、760 px 无溢出、0 pageerror/0 failed request |
| Mimosa 安全扫描 | NOT_RUN | 本轮未跑，不宣称安全通过 |

---

## 3 缺口与后续

| # | 类型 | 事项 | 处理 |
| --- | --- | --- | --- |
| G1 | UI | 模板实例化频道不在 workspace.channelIds | 需补入口；本轮 API 可进 |
| G2 | UI | 已有频道不能加成员 / 「从 Channel 模板挂载」只有提示 | 需补按钮；本轮 API 建成员 |
| G3 | Gate | 模板成员 mock 不能绑 local prefab profile | 409 正确拒绝；本地模型须建 omp 成员 |
| G4 | UI | PATCH 成员不能改 harness | 需补 harness 编辑 |
| G5 | Guard | 删除 lead 被保护 `CHANNEL_AGENT_PROTECTED` | 不能 UI 换 lead；新建频道替代 |
| G6 | UI | `/dcw` 新建产线弹窗：表单定位失败（自动化问题） | 改 API 建线，非产品缺陷 |
| G7 | Boundary | PLC 模拟器须独立影子树 + `--spawn` 归属证明 | 未证明即拒绝，fail-closed |
| G8 | API | `/daq/:id/samples` 样本窗口空 | 采集样本口径待补 |
| G9 | 功能 | 无「参数自动学习」 | 保留优化器 / 参数试验作为最接近能力 |

---

## 4 发布与复验

1. `npm run lint && npm run typecheck && npm run test:unit` 全绿（本轮）。
2. `npm run i18n:check && npm run docs:check && npm run readme:lint` 全绿。
3. `node bin/aw.mjs build` + `npm run test:boot-smoke` 全绿。
4. 真实 Chrome UI 验收：截图 87 张，从 `a01` 到 `j06`，同一隔离实例。
5. 发布：`npm version minor` → commit → tag → GitHub Release → `npm publish --access public --registry=https://registry.npmjs.org`；随后全局 `npm i -g agentworkshop@latest` 与 `aw update`。

> 发布是用户本轮明确要求的动作；在此之前的所有代码改动都还没有提交或推送。发布前如果此文档执行的验收有红，则不得发布。
