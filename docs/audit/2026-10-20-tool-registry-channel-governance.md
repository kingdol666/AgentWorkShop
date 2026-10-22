# 工具注册表透明化 + Channel 级工具治理 —— 实施验收

- 日期：2026-10-20
- 分支：`tii-revision-20261017`
- 代码基线：`package.json` 0.7.70（本轮未改版本号；npm 最新已发布版本）
- 计划：[`.omc/plans/2026-10-20-tool-registry-channel-governance.md`](../../.omc/plans/2026-10-20-tool-registry-channel-governance.md)

## 一、交付结论

本轮把“工具”从**注入时的临时列表**升级为**可查询、可持久化、可按 Channel 治理的目录**：

1. 内置工具与插件 `ctx.omp.registerTool` 注册的工具，统一投影到 SQLite `tool_registry`，包含来源、插件名/作用域、label、description、参数 Schema、角色、分组、定义哈希、可用状态与首次/最近出现时间。
2. Channel 设置新增「工具」区，可选择 `all`（默认全开，deny-list）或 `selected`（仅勾选，allow-list）；硬规则排除的工具置灰并显示原因，不能通过开关绕过。
3. omp `set_host_tools`、pi `AW_PI_TOOLS_FILE`、其余 harness 的 MCP `tools/list` 全部经同一 `hostToolsForRole` 过滤；执行面在 `dispatchHostTool` / `invokeHostTool` 再复核一次。
4. MCP bridge 声明 `tools.listChanged=true` 并每 10s 对比工具面，变化时发 `notifications/tools/list_changed`。
5. 新增 `aw plugin install <本地目录>`：校验 `index.mjs`、拒绝符号链接/越界路径、支持 project/user 作用域，安装后热重载并自动进入工具目录。
6. 新增 admin 页面 `/tools` 与 API：`GET /api/workshop/tools`、`GET /api/workshop/tools/:name`、`POST /api/workshop/tools/sync`。

## 二、关键行为

### 2.1 选择语义

| 状态 | `mode='all'`（默认） | `mode='selected'` |
|---|---|---|
| 无策略行 | 全部合格工具启用 | 全部不启用（UI 切换时预选当前生效集合） |
| 显式 `enabled=0` | 停用 | 停用 |
| 显式 `enabled=1` | 忽略（默认即启用） | 启用 |
| 无该工具行 | 启用 | 停用 |
| `available=0` | 停用（插件未安装/加载失败） | 停用 |
| 硬规则排除 | 停用（显示原因） | 停用（显示原因） |

硬规则顺序：角色（lead-only）→ Channel profile（legacy/training/optimization/observer/hybrid）→ 写守卫（hybrid bounded_auto、观察面零写、训练/优化面）→ 插件总开关/团队插件开关。Channel 选择只能在这些规则之后做减法。

### 2.2 执行面拒绝

- `channelToolGate(channelId, toolName)` 在 `dispatchHostToolInner` 与 `ManagerHostTools.invokeHostTool` 入口执行；
- 被本 Channel 停用的工具返回：`本 Channel 已在「设置 → 工具」中停用「X」。…`；
- 未注册/插件卸载的工具返回 `UNAVAILABLE` 提示；
- 未知工具保持原有“未知工具”错误语义，不被误报为“未启用”。

## 三、改动文件

### 新增

- `server/services/workshop/db/tool-registry.repo.ts` —— 三张表、upsert、unavailable 标记、策略读写、清理。
- `server/services/workshop/tools/registry.ts` —— 运行时快照 → `tool_registry` 同步、防抖、启动订阅。
- `server/services/workshop/tools/policy.ts` —— 策略快照、`channelToolGate`、`applyChannelToolPolicy`。
- `server/services/workshop/tools/catalog-view.ts` —— Channel/全局透明化视图与原因码。
- `server/services/workshop/tools/types.ts` —— 共享原因码/资格类型。
- `server/api/workshop/tools/index.get.ts`、`[name].get.ts`、`sync.post.ts`。
- `server/api/workshop/channels/[id]/tools/index.get.ts`、`index.put.ts`、`reset.post.ts`。
- `app/pages/tools/index.vue` —— 全局工具管理页。
- `app/components/workshop/session-list/ChannelToolSettings.vue` —— Channel 工具选择器。
- `tests/tool-registry-policy.test.ts` —— 10 条注册表/策略/硬规则单测。
- `tests/fixtures/plugins/aw-fixture-tools/index.mjs` —— 验收 fixture 插件。
- `scripts/tool-registry-e2e.mjs` —— 真实实例 56 断言验收。
- `docs/audit/evidence/2026-10-20-tool-registry/` —— 结果 JSON + UI 截图。

### 修改

- `server/services/workshop/db/database/schema.ts`、`db/schema.sql` —— v28 三张表。
- `server/services/workshop/agents/host-tool-bridge/catalog.ts` —— `scopeHostToolsForRole` + 原因记录；`hostToolsForRole` 尾部应用 Channel 策略。
- `server/services/workshop/agents/host-tool-bridge/dispatch.ts` —— 执行面闸门。
- `server/services/workshop/runtime/manager/host-tools.ts` —— 插件分支前闸门（修复插件工具绕过 dispatch 的路径）。
- `server/services/workshop/agents/plugin-tools.ts` —— 卸载时广播变更。
- `server/services/workshop/runtime/manager/admin-channel.ts` —— 删除 Channel 清理插件开关/工具策略。
- `server/plugins/workshop.ts`、`server/plugins/aw-plugins.ts` —— 启动/插件宿主就绪后同步目录。
- `server/harness/aw-mcp-bridge.mjs` —— `listChanged` + 10s 变化通知。
- `server/api/workshop/plugins/index.get.ts` —— 插件清单附带工具计数/名称。
- `cli/commands/plugin.mjs` —— `aw plugin install`。
- `app/components/workshop/session-list/ChannelSettingsModal.vue`、`app/composables/workshop/useWorkshopApi.ts`、`app/components/AppSidebar.vue`、`app/pages/plugins/index.vue`。
- `i18n/locales/zh-CN.ts`、`en.ts`，`i18n/dicts/channelTools.json`、`toolsPage.json`。
- `docs/plugins.md`、`docs/plugins.en.md`、`docs/mcp.md` 及站点副本。
- `config.yml`、README/站点版本声明校准到 0.7.70（原为 0.7.66，docs:check 历史漂移）。

## 四、验收结果

| 项 | 命令 | 结果 |
|---|---|---|
| 单测 | `npm run test:unit` | **283/283 PASS**（原 273 + 新增 10） |
| MCP 单测 | `npm run test:mcp` | **14/14 PASS** |
| MCP live | `npm run test:mcp-live` | **34/34 PASS** |
| 工具治理真实实例 | `node scripts/tool-registry-e2e.mjs` | **56/56 PASS** |
| 产线治理回归 | `npm run test:e2e-line` | **44/44 PASS** |
| 类型检查 | `npm run typecheck` | PASS |
| 生产构建 | `npm run build` | PASS |
| 文档一致性 | `npm run docs:check` | **91/0 PASS** |

### 4.1 工具治理 E2E 覆盖（隔离 home + 端口 3463）

- `aw plugin install --global` 安装 fixture 插件；实例加载后 `tool_registry`：内置 86 + 插件 19（含内置桥接插件与 fixture）。
- `/tools` 页面渲染 fixture（搜索过滤后截图）。
- Channel 默认 `all`；`fixture_echo` / `daq_query` 停用后：
  - `agent-tools/list` 剔除；
  - REST 直调返回 `isError`；
  - MCP `tools/call` 返回 `isError`；
  - MCP 收到 `notifications/tools/list_changed`，重新 `tools/list` 已剔除。
- `selected` 模式只注入 `report_progress` / `complete_task` / `fixture_echo`；`daq_query` 直调被拒。
- 硬规则：`selected` 下启用 `twin_trial_run`（legacy 档位）→ `409 TOOL_NOT_ELIGIBLE`。
- 未知工具 → `400 UNKNOWN_TOOL`。
- 普通用户访问 `/api/workshop/tools` / 修改他人 Channel → `403`。
- 策略落库；重启实例后仍生效。
- Channel 设置「工具」区实际勾选 fixture 并保存 → API 复核 `channelEnabled=false`。
- 删除 Channel → `channel_tool_policies` / `channel_tool_settings` 清零。
- 证据：`docs/audit/evidence/2026-10-20-tool-registry/tool-registry-e2e.json`（56 checks，0 fail）、`tools-page.png`、`channel-tool-settings.png`、`channel-tool-settings-saved.png`。

## 五、边界与已知限制

1. **MCP 引擎侧列表缓存**：平台保证“执行面立即拒绝被停用工具”；列表刷新取决于引擎是否实现 `notifications/tools/list_changed`，否则在下一次 `tools/list` 或新会话刷新。工具治理 E2E 已实测 bridge 通知本身。
2. **DB 故障降级**：策略读取失败时按“默认全部合格工具”放行并限频告警；硬安全规则（角色/profile/写守卫/插件开关）不依赖该表。API 写策略在 DB 故障时返回 503。
3. **插件安装只接受本地目录**：不做远程 URL/市场下载；插件是任意 Node 代码，信任模型与 `docs/plugins.md` 一致。
4. **本轮未重跑全部 14 harness 实机矩阵**：omp/pi/MCP 共用 `hostToolsForRole` 已由单测与 MCP bridge E2E 覆盖；此前 14 harness 矩阵基线仍在。
5. **Mimosa 安全扫描未在本轮完成**，不得把本报告当作完整安全审计结论。

## 六、使用入口

- 全局目录（admin）：`/tools`
- Channel 设置：Channel 列表 → 齿轮「设置」→「工具」区
- API：
  - `GET /api/workshop/tools`
  - `GET /api/workshop/tools/:name`
  - `POST /api/workshop/tools/sync`
  - `GET|PUT /api/workshop/channels/:id/tools`
  - `POST /api/workshop/channels/:id/tools/reset`
- 插件安装：`aw plugin install <source-dir> [--global|-g] [--force|-f] [--no-enable]`
