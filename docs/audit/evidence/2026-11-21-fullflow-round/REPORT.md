# AgentWorkShop 全流程验收报告（2026-11-21 全量轮）

- 被测提交：`origin/main@87805eafbefe8cb43bb7cccb0c69a3649c44635d`
- 构建：`pnpm build` 成功（Nitro `.output`，30.4 MB，外置资产 `prompts/schema.json/aml-python/skills/zod-direct` 全部随产物分发）
- 实例：
  - **A 清洁实例**：`127.0.0.1:3031`，全新 `AW_HOME` + 全新 `USERPROFILE/HOME`（用于 Skill 全局发现）
  - **B 存量实例**：`127.0.0.1:3021`，复用 TSA5 轮 `AW_HOME=D:/tmp/aw-liv2-1119/home`（真实存量库，含 13 个插件与产线数据）
- 环境：Windows / Node v24.19.0 / pnpm 11.9.0；`AW_ALLOW_PRIVATE_OUTBOUND=1`、`BACKUP_DISABLED=1`、`NUXT_SESSION_PASSWORD` 运行时生成（未落盘、未回显）
- 性质：**软件 + 模拟环境验收**；不是物理 HIL、现场准入或生产批准

## 1. 仓库与 PR 完整性

| 项 | 结果 |
|---|---|
| GitHub `main` SHA | `87805eafbefe8cb43bb7cccb0c69a3649c44635d` |
| 合并 PR | #252 `42062a7b`、#253 `58e624c9`、#254 `7188cd96`、#255 `f04d7253`、#256 `8c62d276`、#257 `f6b20707`、#258 `87805eaf` |
| 开放 PR | 0 |
| 本地同步 | `1ae080e1` → 快进到 `87805eaf`；已跟踪文件零差异 |
| 本地 WIP 保护 | 全部已跟踪改动保存于 `stash@{0}`，并打标签 `backup/wip-tracked-20261121`；两个同路径未跟踪文档备份在 `D:/tmp/aw-wip-untracked-20261121/`（spec 与上游逐字节一致，plan 为早期草稿）；其余未跟踪资产（paper/历史证据/实验脚本）原地保留 |

> 说明：本地原有工作区包含大量**旧版本源码**改动（相对 HEAD 约 3296 行删除、226 个已跟踪文件被删除），不是当前 main 的有效内容。为避免覆盖，先整包 stash 再快进；未自动 `stash pop`，避免把旧代码叠回新 main。恢复方式见 §7。

## 2. 静态门禁（在 `87805eaf` 上重跑）

| 门禁 | 结果 |
|---|---|
| `pnpm lint`（已跟踪源码） | **PASS**：`eslint` 0 error；`check-rsi-redline` 31 文件 0 设备写调用 |
| `pnpm typecheck` | **PASS**（vue-tsc -b --noEmit） |
| `pnpm test:unit`（最终轮） | **2186 tests / 2185 pass / 1 skipped / 0 fail**（46.4s） |
| `pnpm test:mcp` | **14/14 PASS** |
| `pnpm test:skills` | **197 PASS / 0 FAIL**（9 个 skill） |
| `pnpm docs:check` | **101 通过 / 0 失败** |
| `pnpm readme:lint` | **PASS** |
| `pnpm i18n:check` | **3439/3439 keys，3012 used，0 unresolved** |
| `pnpm check:cssvars` | **OK**：161 引用全部有定义（263 文件） |
| `pnpm frontend-lifecycle-contract` | **3 pass / 0 fail** |
| `pnpm build` | **PASS** |

### 2.1 全量单测的并发抖动（如实记录）

同一提交连续三次全量单测：

1. 第 1 次：`2188 tests / 2 fail`，失败为文件级 `tests/http-drivers.test.ts`、`tests/managed-mcp-client.test.ts`；
2. 第 2 次：在 `tests/legacy-active-task-recovery.test.ts` 处挂起 >10 分钟（未超时机制），人工终止；
3. 第 3 次：**全绿 2185/2186（1 skip）**。

上述 3 个文件单独执行均通过：
- `http-drivers.test.ts` 10/10（309ms）
- `managed-mcp-client.test.ts` 1/1（555ms）
- `legacy-active-task-recovery.test.ts` 15/15（2.75s）

结论：**提交内容本身可复现全绿**；第 1/2 次属本机并发/资源竞争下的测试运行器抖动，不判为功能失败，但记录为测试基础设施风险（该套件无 `--test-timeout`，挂起时不会自动失败）。

### 2.2 lint 的 44 个错误来自未跟踪的历史脚本

`pnpm lint` 全仓扫描报 44 error，全部集中在 6 个**未跟踪**的本机历史实验脚本：
`scripts/experiments/{tii-daq-repro,tsa-phase-s,tsa2-phase-c,tsa2-phase-p,tsa2-phase-p1,tsa2-phase-s}.mjs`。
按 `git ls-files` 仅扫已跟踪源码时 **0 error**。未改动这些用户资产。

## 3. Mimosa 安全扫描

| 项 | 值 |
|---|---|
| jobId | `scan-job-mwq23d6q-56730dc9caea80d9` |
| scanId | `scan-2026-11-21T06-58-50.373Z-fb0e1048a970` |
| seal | `sha256:9cfdb158b18d72396fdd651a05fa2aa9fb944e052606394ae5d86cfcc45d182d` |
| 运行状态 | `completed`，但 **run status = inconclusive**（覆盖率 `partial`：部分分析阶段未完整覆盖） |
| findings | 54（business-logic candidates = 0） |
| 依赖风险 | 65 个包，匹配 advisory 0，unknown 0 |
| 产物 | `D:/tmp/mimosa-scans-20261121/scan-2026-11-21T06-58-50.373Z-fb0e1048a970/` |

**结论口径：本轮 Mimosa 不构成“安全通过”**。按红线只报封印 + 计数 + 状态。finding 构成：
- 多数位于运行时数据目录 `data/workspaces/**` 与 `paper/**` 的 Python 分析脚本（路径穿越、XML 实体、SSRF 等静态 advisory，带 proof gap，未经运行时验证）；
- 仓库源码中的静态告警：`evidence/candidate-store.ts:77`（命令注入嫌疑）、`i18n/locales/*.ts`（`embedApiKey`/`mqttPassword` 文案被识别为硬编码凭据，实为 UI 标签字符串）、`a2a/[agentId]/rpc/index.post.ts:431`（dispatch→parseParams 路径穿越嫌疑）、`skills/service.ts:49`（跨文件污点，sink 名称被标注为 MongoDB 排序，实际栈为 SQLite/文件系统）、`channel-agent.repo.ts:150`（跨文件到测试代码的 SQL 执行）。
- 以上均为静态 advisory，**不得据此宣称存在或不存在可利用漏洞**；需人工复核。

## 4. 端到端验收

### 4.1 L10 AgentPrefab / Skills / MCP（清洁实例 3031）

`scripts/experiments/prefab-acceptance.mjs`：**21/21 PASS**
证据：`docs/audit/evidence/2026-11-21-fullflow-round/clean-instance/result.json`

| # | 检查 | 结果 |
|---|---|---|
| 1 | admin_register | PASS |
| 2 | skill_discovered_from_user_agent_root | PASS（`~/.agent/skills` → source=global） |
| 3 | skill_imported_immutable_disabled | PASS |
| 4 | skill_enabled | PASS |
| 5 | prefab_draft_created | PASS |
| 6 | prefab_revision_published | PASS（rev=1 + contentHash） |
| 7 | channel_with_mock_lead | PASS |
| 8 | member_bound_to_pinned_revision | PASS |
| 9 | catalog_exposes_activate_skill_only_for_assigned_skill | PASS（20 工具） |
| 10 | catalog_narrows_unselected_tool | PASS（无 `dcw_control`，协作工具保留） |
| 11 | activate_skill_returns_low_trust_body | PASS |
| 12 | unselected_tool_denied_at_dispatch | PASS（平台工业门文案拒绝） |
| 13 | session_created | PASS |
| 14 | session_clone_copies_pinned_binding | PASS |
| 15 | session_snapshot_hash_matches | PASS（64 位 hash） |
| 16 | revision2_published | PASS |
| 17 | existing_binding_not_auto_upgraded | PASS（仍固定 rev1） |
| 18 | revoked_skill_activation_denied | PASS（`FORBIDDEN: 工具 activate_skill 不在当前 AgentPrefab 能力范围`） |
| 19 | mcp_rejects_non_https | PASS（400 `MCP_HTTPS_REQUIRED`） |
| 20 | mcp_manifest_registered_without_secret | PASS（`hasCredential=false`，无 `AW_MCP_` 回显） |
| 21 | mcp_discovery_failure_is_bounded | PASS（502，有界错误） |

### 4.2 L1 栈健康 / 迁移（存量实例 3021）

`l1-check.mjs`：**15/15 PASS**
证据：`docs/audit/evidence/2026-11-21-fullflow-round/provisioned-instance/l1-checks.json`

- `/api/health` ok，version=`0.14.0`
- 插件清单 13 个、`failures=[]`、`mes-tool-bridge` 以 user scope 持久启用（2 工具）
- 工具注册表 157 个；`mes_order_status`/`mes_quality_report` 在册；通讯/记忆工具齐全
- `experience-stats` 鉴权 200（total=5）；匿名 401
- SQLite `aw_migration_ledger` 出现 `schema-contract v8`（存量 v7 库自动迁移）
- 新表 `agent_prefabs`/`agent_prefab_revisions` 存在；`channel_agents.prefab_binding_json`、`channel_sessions.prefab_snapshot_{json,hash}`、`project_work_items.prefab_snapshot_{json,hash}` 均已就位

### 4.3 L9 插件工具腿（存量实例 3021，重启前后各一次）

`scripts/experiments/tsa5-plugin-check.mjs` 两次均 **PASS**（重启前后，跨构建持久）：
- 持久装载：`mes-tool-bridge` scope=user enabled=true
- 注册表：157 工具，两个插件工具在册
- 未配置时 fail-closed：返回“未配置/系统设置”可操作指引，零外呼
- worker 注入面：只含只读工具（`mes_order_status=true`，`mes_quality_report=false`）
证据：`plugin-leg/*.json`

### 4.4 L4 治理评测门（存量实例 3021）

证据：`bench-leg/*.json`

| 断言 | 实测 | 判定 |
|---|---|---|
| 伪报汇总值（primaryDelta=99 ≠ 复算 0.42） | HTTP 400 `BENCH_INVALID` | **拒绝正确** |
| promote→active 无 benchRunId | HTTP 200，body `ok:false`，`BENCH_PROVENANCE_REQUIRED` | **拒绝正确**（decision-in-body） |
| shadow→active 引用客户端 run | HTTP 200，body `ok:false`，`BENCH_NOT_HOST_PROVENANCED` | **拒绝正确** |
| promote→shadow | body `ok:true`，next=shadow | **通过正确** |

> `tsa4-bench-gate.mjs` 中的 `activeGateHeld` 断言按 HTTP 状态码判断，已过时；本系统按 `body.ok` 决策（workflow 已注明）。实际门全部按预期拒绝/放行。

### 4.5 L3 重启对账（write-attempt 台账）

- 重启前：3277 行（verified 3271 / rejected 6）
- 重启后：3277 行（verified 3271 / rejected 6）
- 行数与 outcome 分布完全一致，**未自动重发任何未闭环写**
证据：`reconcile/reconcile-{before,after}.json`

### 4.6 L7-lite 记忆与跨频道通讯（存量实例 3021）

`l7-probe.mjs`：**4/4 PASS**
- `save_memory` → `search_memory` 按唯一标记命中本人私有记忆
- `send_cross_channel_message` → 目标频道消息到达（createdAt=2026-11-21T15:17:01+08:00）
- 未跑：跨频道**回执生成**（需要真实模型），记 NOT_RUN
证据：`provisioned-instance/l7-checks.json`

### 4.7 重启持久性

同一 `AW_HOME` 连续两次重启（含一次跨服务重启）：

| 计数 | 重启前 | 重启后 |
|---|---|---|
| channels | 27 | 27 |
| channel_agents | 77 | 77 |
| channel_sessions | 23 | 23 |
| tasks | 54 | 54 |
| messages | 745 | 745 |
| channel_harness_profiles | 4（shadow×3/candidate×1） | 4（状态一致） |
| harness_bench_runs | 3 | 3 |
| experience_versions | 61 | 61 |
| schema-contract | v8 | v8 |

重启后 L1 再次 **15/15 PASS**、L9 再次 PASS。证据：`provisioned-instance/snapshot-{before,after}-restart.json`、`db-offline-before-restart.json`。

### 4.8 前端装配面（无浏览器点击）

- SSR：`/` → 200，`/settings` → 200（未登录壳）
- 构建产物包含三个新面板：`settings.prefabs`、`settings.skills`、`settings.mcp` 均在 `_nuxt` chunk 中；`app/pages/settings.vue` 已挂载 `SkillsPane`/`McpServersPane`/`AgentPrefabsPane`
- 匿名访问 `/api/system/skills/discover`、`/api/system/mcp-servers`、`/api/workshop/agent-prefabs`、`/api/workshop/plugins` 均 401
- **未做浏览器点击**（会话内无 Playwright/Puppeteer/browser MCP 可用），UI 交互记 NOT_RUN

## 5. NOT_RUN / PARTIAL / BLOCKED（边界）

| 项 | 状态 | 原因 |
|---|---|---|
| L2 产线数采/受控下发、L5 AML 训练 | **BLOCKED** | PLC sim twin `:4056` 未运行；本机无该模拟器启动入口；共享服务禁止代起 |
| L1 IDD/RAG 双桥 token 重铸与热配 | **NOT_RUN** | 共享服务 `:3210`、`:8770`、`:6789` 均未监听（只复用不重启） |
| L6 Project 派发（真实模型） | **NOT_RUN** | 需要可核准计划/真实模型；本轮仅单测覆盖任务实例快照复制 |
| L10 正向外部 MCP 实网调用 | **BLOCKED** | 无可用公网 HTTPS MCP 实例；单测覆盖本地 SDK server 与 fake broker |
| Prefab 指导下的真实 OMP 模型作业 | **NOT_RUN** | 本轮使用 mock lead；未调用真实模型 |
| 跨频道回执生成 | **NOT_RUN** | 需要真实模型 |
| 浏览器 UI 点击验收 | **NOT_RUN** | 无浏览器自动化工具 |
| Mimosa 安全通过 | **不可宣称** | run status=inconclusive，coverage=partial |
| 物理 HIL / 现场准入 / 生产批准 | **不可宣称** | 软件+模拟器证据 |

## 6. 复现命令

```bash
# 1) 同步与门禁
git fetch origin && git merge --ff-only origin/main
CI=true pnpm install --frozen-lockfile
pnpm exec nuxt prepare
pnpm typecheck
git ls-files -z -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.vue' | xargs -0 node_modules/.bin/eslint
pnpm test:unit && pnpm test:mcp && pnpm test:skills
pnpm docs:check && pnpm readme:lint && pnpm i18n:check && pnpm check:cssvars && pnpm frontend-lifecycle-contract
pnpm build

# 2) 清洁实例 L10
node D:/tmp/aw-e2e-1121/start-instance.mjs --port 3031 \
  --home D:/tmp/aw-e2e-1121/clean-home --user-home D:/tmp/aw-e2e-1121/clean-user-home \
  --log D:/tmp/aw-e2e-1121/logs/aw-3031.log
node scripts/experiments/prefab-acceptance.mjs --base http://127.0.0.1:3031 \
  --home D:/tmp/aw-e2e-1121/clean-home --user-home D:/tmp/aw-e2e-1121/clean-user-home \
  --evidence docs/audit/evidence/2026-11-21-fullflow-round/clean-instance

# 3) 存量实例 L1/L9/L4/L3/L7
node D:/tmp/aw-e2e-1121/start-instance.mjs --port 3021 --home D:/tmp/aw-liv2-1119/home \
  --log D:/tmp/aw-e2e-1121/logs/aw-3021.log
node D:/tmp/aw-e2e-1121/l1-check.mjs --base http://127.0.0.1:3021 \
  --db D:/tmp/aw-liv2-1119/home/data/workshop.sqlite --evidence <evidence-dir>
cd /d/tmp/aw-e2e-1121/plugin-check-cwd && node D:/codes/ABO/AgentWorkShop/scripts/experiments/tsa5-plugin-check.mjs
node D:/codes/ABO/AgentWorkShop/scripts/experiments/tsa4-bench-gate.mjs
node D:/codes/ABO/AgentWorkShop/scripts/experiments/tsa4-bench-hostgate.mjs <runId> <profileId>
node D:/codes/ABO/AgentWorkShop/scripts/experiments/tsa4-reconcile.mjs before|after
node D:/tmp/aw-e2e-1121/l7-probe.mjs <evidence-dir>

# 4) 停止本轮实例（只杀自有 pid 文件）
node scripts/_audit/detached-start.mjs --stop --log D:/tmp/aw-e2e-1121/logs/aw-3031.log
node scripts/_audit/detached-start.mjs --stop --log D:/tmp/aw-e2e-1121/logs/aw-3021-restart2.log
```

## 7. 本地 WIP 恢复

```bash
git stash list                          # stash@{0}: wip-before-main-sync-20261121
git stash show --stat stash@{0}         # 查看范围
git checkout stash@{0} -- README.md     # 按文件恢复（推荐）
git stash pop                           # 全量恢复（会与 87805eaf 冲突，不建议直接执行）
```
两个未跟踪文档备份：`D:/tmp/aw-wip-untracked-20261121/`。

## 8. 证据清单

见同目录 `manifest.json`（逐文件 SHA256）。
