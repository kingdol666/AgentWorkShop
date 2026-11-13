# AgentWorkShop 生产就绪加固设计说明

**日期：** 2026-11-13  
**基线：** `origin/main` / `1555ded2c456ee069fd879866b35d3a307e7b230`  
**目标：** 将已验证为真实存在的安全、运行时、数据契约、前端生命周期与交付门禁问题拆成可独立验收的改动，同时明确不能由软件单独证明的现场边界。

## 目标与非目标

### 目标

1. 浏览器会话不再依赖长期 JS 可读凭据，WebSocket 不再把用户令牌放入 URL；保留外部 Agent Bearer API 兼容性。
2. 高风险写入接口对请求体、失败状态和幂等语义给出一致、可测试的契约。
3. 修复前端首帧主题、实时订阅生命周期和可见性调度问题，并把关键质量门禁纳入 CI。
4. 为单实例试点提供可恢复的数据备份/恢复入口、版本化迁移记录和部署一致性。
5. 对 DAQ 的质量、陈旧、断线和告警语义补充显式状态，避免把模拟器或范围判断误称为真实现场可靠性。
6. 对每个 PR 提供 RED→GREEN 单测、类型/构建/静态门禁和必要的生产构建实机验收证据。

### 非目标

- 不把 AgentWorkShop 变成 PLC/SIS/安全仪表系统，不替代硬接线急停、PLC 硬联锁或安全认证。
- 不在没有真实厂商设备、网络分区和现场签字的情况下声称“真实产线已验证”。
- 不在本轮引入横向多实例 HA；这需要外置会话/WS/限流状态和数据库迁移，单独作为规模化阶段。
- 不为了消除静态扫描数字而进行无行为收益的大规模 UI 重写。

## 已复现的事实矩阵

| 结论 | 证据 | 本轮处理 |
|---|---|---|
| 最新主干单测/类型/i18n/CSS 门禁可通过 | `pnpm test:unit` 1542/1542；`pnpm typecheck`；`pnpm i18n:check`；`pnpm check:cssvars` | 保持并扩展 CI |
| 浏览器端保存 `aw.token`，WS URL 带 `?token=` | `app/stores/workshop/user.ts`、`app/stores/workshop/connection.ts` | 修复为 HttpOnly 浏览器会话 + 一次性 WS ticket；Agent Bearer 保留 |
| 仪表盘和 Town 建立 WS feed 未消费退订函数 | `app/pages/index.vue`、`app/composables/workshop/town/useTownRailData.ts` | 修复并加生命周期契约 |
| SSR 仅设置 `htmlAttrs.style`，深色 class 由 client plugin 添加 | `app/app.vue`、`app/plugins/theme.client.ts` | 将 cookie 主题映射到 SSR `class` |
| 系统设置非法体返回 HTTP 200 + `ok:false` | `server/api/system/settings/index.patch.ts` | 改为统一 400 envelope |
| CI 没有执行 i18n/CSS/响应式门禁 | `.github/workflows/ci.yml` | 加入快速门禁；版本统一 Node 24 |
| schema.sql 与运行时 schema.ts 漂移、无迁移版本账本 | `server/services/workshop/db/database/schema.ts`、`schema.sql`、`open.ts` | 单一生成源 + 迁移 ledger/检查；不伪造历史迁移 |
| DAQ 驱动/现场能力有明确边界 | 驱动 registry、OPC/MQTT/Modbus、DAQ runtime、现场 onboarding 文档 | 加质量/陈旧/恢复可见性；现场协议/SIS列为 cutover gate |

## 方案选择

### 方案 A：一次性重写全部控制面

拒绝。风险最高，难以区分安全修复、UI 重构与协议行为变化，无法做到每个 PR 独立回滚。

### 方案 B：只补文档和静态检查

拒绝。不能解决令牌暴露、订阅泄漏、HTTP 200 失败或恢复入口缺失等运行时问题。

### 方案 C：按边界拆分的增量加固（采用）

每个 PR 只拥有一个主要边界，并带自己的契约测试和验收命令：

1. 浏览器会话与 WebSocket 票据；
2. API 契约、输入校验与恢复/迁移；
3. DAQ 质量与断线可观测性；
4. 前端首帧、流生命周期和 CI 门禁；
5. 统一主干实机验收与现场 cutover checklist。

这样每个 PR 可以独立审查、合并和回滚；协议/SIS/HA 仍明确停在现场门禁，不被代码演示掩盖。

## 安全与控制边界

- 浏览器会话 cookie 使用 `HttpOnly`, `SameSite=Lax`, HTTPS 时 `Secure`；浏览器写请求通过同源 CSRF token/header 约束。
- 外部 Agent 继续使用 `Authorization: Bearer`，不改变 Agent SDK 的认证契约。
- WebSocket 使用短时、一次性、绑定用户的 ticket；ticket 仅用于握手，不作为 REST token。
- 所有控制写入仍必须经过 line grant、HITL、write intent、参数/配方/节点限制和回读；本轮不放宽任何控制闸门。
- 现场必须另外完成 OPC UA 安全策略、MQTT TLS、网络分区、NTP/PTP、SIS/急停责任划分和真实 PLC 试运行。

## 验收定义

### 软件验收

- 每个 PR 有针对性 RED→GREEN 单测；合并前运行 `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, `pnpm i18n:check`, `pnpm check:cssvars`。
- 生产构建启动后，真实 UI 登录、WS 连接、DAQ 告警、DCW 读回、移动端布局和主题首帧均有可复现实机证据。
- 任意失败不得只以 `ok:false` + HTTP 200 表达；数据恢复必须有备份和恢复后计数校验。

### 现场验收

- 只读：真实 PLC/MES 接入至少 24 小时，与 HMI 对值、单位、时标、质量和陈旧状态。
- 闭环：人工 HITL 下完成最小步长写入、独立回读、配方应用/回滚、断网/断 PLC 拒绝演练。
- 任何无人值守或 SIS 结论必须由现场控制工程师、网络/安全负责人和产线 owner 签字；本软件验收不能替代签字。
