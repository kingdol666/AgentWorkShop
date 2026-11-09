# main 分支合并复验与发布前门禁（2026-11-10）

## 1. 范围与方法

- 对象：`main` 分支（产品主线，工作树 `AW-sessions-ui`）。
- 同步：本地 `main` 自 `1af4e5f8` **纯快进 17 个提交**至 `origin/main` = `3fadf567`（v0.11.0 发布提交）；无分叉、无冲突、无手工 merge 提交（`git merge-base --is-ancestor` 证实）。工作树由游离 HEAD 正式 `git switch main`。
- 合并：推送期间远端接连合入 **PR #140–#147** 共 8 个修复批（dcw 写面 / API 契约 / 产线治理 / runtime 韧性 / 会话隔离 / 前端契约 / 会话加固 / harness 能力声明如实化）；逐次 rebase 整合零冲突，**每个合并态复跑门禁**（5 轮 lint + 5 轮 unit + 5 轮实机 E2E）；其中 #144 遗留 3 处缩进错误（`admin-agents.ts`）已在本提交修复。最终基线 = `origin/main`@`a14dab0a` + 本提交（`6a275f91`）。
- 门禁：lint（含 RSI 红线）→ 单测 → typecheck → 生产构建 → 实机端到端 ×2 → Mimosa deep 安全扫描。
- 日志：本目录 `logs/`；Mimosa 报告与封印：`mimosa/`。

## 2. 门禁结果

| 门禁 | 命令 | 结果 | 证据 |
|---|---|---|---|
| ESLint + RSI 红线 | `npm run lint` | **PASS（0 错误）**；红线 18 学习环文件 0 设备写；5 个合并态各复跑均 0 错误（#144 遗留 3 处缩进错误已修） | `logs/lint.log`（最终态） |
| 全量单测 | `npm run test:unit` | @`3fadf567` **1356/0/2** → +#140 **1358/0/2** → +~#142 **1370/0/2** → +~#145 **1381/0/2** → 最终态（+#146/#147）**1387 pass / 0 fail / 2 skipped**。注：#142 态首轮出现 `http-drivers.test.ts` 文件级偶发（libuv win async 收尾断言），隔离复跑 ×2 均 10/10、全套件复跑 0 失败——判定为 Windows 套件收尾时序抖动，非产品缺陷 | `logs/unit.log`（最终态） |
| 类型检查 | `npm run typecheck` | PASS（vue-tsc 0 错误） | `logs/typecheck.log` |
| 生产构建 | `npm run build` | PASS（`.output/server/index.mjs` + 外置资产） | `logs/build-tail.log` |
| RSI 实机 E2E | `node scripts/acceptance-rsi-live-e2e.mjs` | **五轮 32/32 PASS**（@`3fadf567` / +140 / +142 / +145 / +147 各合并态）——write_intent→HITL→line_start/recipe_trial 写治理链与会话链在全部合并态无回归 | `logs/rsi-live-e2e{,-initial,-rerun-142,-rerun-140,-rerun}.log`；`../2026-11-09-rsi-live-e2e/report.{md,json}`（最终态重跑更新） |
| Project 实机 E2E | `node scripts/_audit/project-landing-live.mjs` | **39/39 PASS**（蓝图→三频道→依赖链→technical 门→L1→L2→completed + UI 10 检查） | `logs/project-landing-live.log`；`../2026-11-09-project-landing/`（本轮重跑更新） |
| RSI 离线 Gate-1A | `scripts/acceptance-rsi-stage1.ts` | **13/13 PASS** | 本轮控制台输出（确定性脚本可复跑） |
| RSI 离线自进化 | `scripts/acceptance-rsi-evolution.ts` | **11/11 PASS** | 同上 |
| Mimosa deep 扫描 | MCP `security_scan_start(depth=deep)` | **completed，状态 inconclusive**：33 静态发现 / **0 业务逻辑候选**；依赖 333 包 / 0 漏洞通告 | `mimosa/report.md`、`mimosa/seal.json`（seal `sha256:3ba9345d…`） |

## 3. Mimosa 发现复核（如实口径）

- 4 个 HIGH「硬编码凭据」经人工核验**均为误报**：`i18n/locales/*.ts` 的 `embedApiKey: 'Embedding key'` / `mqttPassword: 'MQTT password'` 是 UI 字段标签文案；`scripts/test-group-chat-unit/lib.ts:138` 是单测夹具固定密码（内存库）。
- 其余为 paper 归档快照、验收脚本的环境变量污点链等静态 advisory（扫描器自注「需人工确认真实数据流」）。
- 运行状态 `inconclusive`（部分分析阶段覆盖缺口）——**与 2026-11-08/09 历史轮次一致，不宣称“安全通过”**。
- 污点/注入类 advisory（如 `bench-approval-only.ts` 的 mongo-sort-injection、`stableJson`）留待后续人工复核，本轮不改动产品代码。

## 4. 本提交包含的改动

1. `.gitignore` / `eslint.config.mjs`：把验收会话运行时目录（`.aw-home-ui/`、`.rsi-demo-home/`、`.rsi-demo-state.json`、`.runtime/`）加入忽略；`scripts/_live-*.mjs` 会话驱动按 `_dbg-*` 既有惯例豁免 lint。修复 `eslint .` 扫入 venv 三方产物导致的 2764 个假阳性错误。
2. 证据补档（此前会话产出但漏提交）：`docs/audit/evidence/2026-11-09-full-acceptance/`、`2026-11-09-global-npm-demo/`、`2026-11-09-omp-channel-project-session/`、`2026-11-09-project-landing/` 的 2 份交付物文档，及 `scripts/_audit/omp-channel-project-session-live.mjs`、`scripts/_audit/omp-project-single-live.mjs`、`scripts/_live-rsi-*.mjs`（5 个）驱动脚本。
3. 本轮重跑刷新的证据：`2026-11-09-rsi-live-e2e/`（32/32 @ `3fadf567`）、`2026-11-09-project-landing/`（39/39）、两份 UI capture JSON。

## 5. 如实限制

- 实机 E2E 的设备层为内置 mock DCW/DAQ 驱动、B2 配对为合成 runner（脚本设计如此）；其证明的是链路与治理，不是真实 PLC 上的学习效果。
- Mock/实机口径与限制的完整清单见 `docs/rsi/STATUS-20261109.md` §7 与 `2026-11-10-full-acceptance/REPORT.md` F1。
- 论文分支（`paper/tii-major-revision-20261103`，工作树 `AgentWorkShop`）未在本次范围内，未做任何改动。
