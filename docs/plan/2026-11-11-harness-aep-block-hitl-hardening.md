# Harness × AEP × Block × 工具 × HITL 加固计划（2026-11-11）

> 基线：`origin/main@2f8677a5`。来源：四路只读专家审查（registry 能力矩阵 / AEP-Block 管线 / 逐 harness 工具注入 / 逐 harness HITL）+ 本轮契约测试（82 tests / 80 pass / 0 fail / 2 skip，skip 均为治理 WIP）。
> 口径：静态证据 = file:line；复现 = 可运行红测；不宣称安全。

## 1. 问题登记与根因

| ID | 问题 | 证据 | 复现方式 | 根因 |
|---|---|---|---|---|
| H1 | `agent.block` 未进 `AepEvent` 类型联合；`AEP_GROUPS.tools` 不含它（死导出且分组不全） | shared/workshop-protocol.ts:373-411,455-470 | 运行时断言 `AEP_GROUPS.tools` 含 `agent.block` → 红 | 帧上线时走 `AepEnvelope.type: string` 宽容通道，类型面/分组未同步 |
| H2 | 文本归一派生块 `harness` 恒空串（逐 harness 归因丢失） | server/api/workshop/ws/event-mapping.ts:44 | 纯函数断言派生块 harness='codex' → 红（现为 ''） | `normalizeToolLine(toolLine.trim())` 未传 harness，映射层也无 harness 来源 |
| H3 | `durationMs` 死字段（声明无人填） | shared/agent-blocks.ts:34,99 | 断言块对象无该键 → 红 | 字段预留后未接线，属协议噪声 |
| H4 | 管线中层零测试（原生优先/归一兜底/harness 归因/坏载荷） | ws/event-mapping.ts（无对应测试） | 新建 `selectStatusFrame` 纯函数测试 | 逻辑内联在发布函数里不可测 |
| H5 | pi 被声明为"发射 harness"，实际 `pi-agent.ts` 无任何 🔧 发射点 | tests/agent-blocks.test.ts:7,49 vs pi-agent.ts:83-102 | 源码 grep + 文档对齐（行为锁定测试为绿测） | PR96 文案/测试头注释夸大；pi JSON 模式当前无工具事件可用 |
| H6 | mock registry 声明 `supervise:false`，实现有且被调度真实使用 | registry.ts:83 vs mock-agent.ts:155 | 契约测试断言 mock caps.supervise===true 且 impl.supervise 为函数 → 红 | 保守声明与实际使用脱节（徽标失真） |
| H7 | `hitl-capabilities.ts` evidence 锚点整批漂移（指向拆分前旧路径） | hitl-capabilities.ts:98-127 等 | 漂移守卫测试：逐条 evidence 抽取 path:line 断言文件存在 → 红 | 适配器目录化重构后未回填 |
| H8 | crush 标注 manual + hint 称"平台不自动写入"，但 `crush-agent.ts` 缺文件时**会自动整份写 `.crushrc`** | registry.ts:297、harness-availability.ts:55 vs crush-agent.ts:35-55 | 断言 hint 不再含"平台不自动写入"且与 TOOL_SURFACE 一致 → 红 | 标注早于自动写入实现，未回填 |
| H9 | 前端 `ClusterTool` 不校验块载荷（DB 回放路径原样进组件） | app/components/workshop/blocks/ClusterTool.vue:24 | 源码契约断言使用 `isAgentToolBlock` → 红 | 防御只在服务端与测试里 |
| H10 | 「消息」过滤含文本孪生帧不含 `agent.block`（不对称） | app/stores/workshop/events.ts:25 | 源码契约断言 messages 白名单含 `agent.block` → 红 | Block 上线时过滤面未同步 |
| H11 | 注意力档位不一致：文本帧=silent、结构块=default(status) | app/composables/workshop/event-blocks/attention.ts:38-42 | 纯函数断言 `envelopeTier(agent.block 帧)==='silent'` → 红 | 同 H10 未同步 |
| H12 | Block 无下游业务消费者（只有渲染+回放） | 全仓 grep agent.block 消费面 | 新端点不存在 → 404 红 | 缺一个真实业务面 |
| H13 | omp 3 处 identity 重写丢 `harness` 字段（治理审计开日志时 tool_start 被拒），2 个治理测试 skip:WIP | omp-agent/client.ts:21、core.ts:130/146；tests/governance-harness-audit.test.ts:90,101 | 直接 unskip 治理测试 → 红 | omp 重写 identity 时漏字段；驱动审计 outcome 字段其实已落地（skip 过期） |
| H14 | 7 家 HITL 桥应答链无 adapter 级单测 | codex-agent/hitl.ts、dsh-agent respondHitl 等 | 抽取纯映射函数 + 单测（绿锁） | 协议应答内联在类里 |
| H15（记录不修） | snapshot 不携带工具块（断线快照路径后工具历史靠 REST 补）；omp HITL 走 terminal stdin 与 respondHitl 机制不对称；omp hitl/terminal 徽标不随 rpcMode 收缩 | publish.ts:58-99 等 | — | 设计取舍/条件能力，标注为已知边界 |

## 2. PR 批次与验收门

每个 PR 统一验收门：红测先行 → 定向测试 → 全量 `test:unit`（≥基线 1434 pass/0 fail）→ `typecheck` → `lint` → CI 绿 → 合并 main。

| PR | 内容 | 关键验收 |
|---|---|---|
| PR-A（本计划随附） | H1-H4：协议入册/分组、`selectStatusFrame` 纯函数化 + harness 归因（manager.harnessOfAgent 新查询）、移除 durationMs；plan 文档 | 新增 ws 映射测试全绿；AEP_GROUPS 含 agent.block；全量无回归 |
| PR-B | H5-H8：pi 发射声明纠正（注释/测试头/行为锁定）、mock supervise 翻正、hitl-capabilities evidence 回填 + 漂移守卫测试、crush 标注/检测对齐、omp 条件能力 configNote | 漂移守卫测试绿；D5 契约按新真值更新 |
| PR-C | H9-H11：ClusterTool 载荷校验、messages 过滤补 agent.block、attention 一致化；前端契约守卫测试 | classify/attention 纯函数测试 + 源码契约断言绿 |
| PR-D | H12：`GET /api/workshop/channels/:id/tool-usage`（channel_events 中 agent.block 聚合：按工具/harness/agent 统计 ok/error/last-at）+ repo 查询 + 聚合纯函数单测 | 新端点契约测试绿；聚合边界（坏载荷/上限）覆盖 |
| PR-E | H13：omp identity 补 harness；治理测试 unskip 全绿（含驱动审计 outcome） | governance-harness-audit 全绿、无 skip |
| PR-F | H14：抽取 codex 答案归一 / dsh·hermes 选项 fail-closed / opencode permission 应答体 纯函数并补单测 | 新增映射测试全绿 |

H15 不修，报告与代码注释标注边界。

## 3. 终验（全部合并后）

1. 干净 rebase 后全量 T0/T1（lint/typecheck/docs/i18n/readme/unit/mcp/skills 等）。
2. 重跑 14 harness × 五维矩阵复验（AEP 消费/Block/渲染/工具/HITL），输出更新版审计报告到 docs/audit/evidence/。
3. Mimosa 扫描本轮改动文件 0 新增命中（不宣称安全）。
