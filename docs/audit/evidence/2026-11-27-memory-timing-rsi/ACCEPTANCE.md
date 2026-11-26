# 记忆 / 经验 / 知识（本体）时机与 RSI — 实机验收报告（2026-11-27）

计划：`.omc/plans/2026-11-26-memory-timing-rsi.md`
基线：`main@1252198d` + 本轮改动（未提交前）
验收实例：`AW_HOME=D:/tmp/aw-runtime-harness-20261126/home`（旧 home 迁移后启动）
桌面端：Electron 45.4.1（源码壳）+ 同一 home 的 sidecar

## 1. 结论（按用户 5 个问题）

| 问题 | 结论 | 证据 |
|---|---|---|
| 记忆管理机制是否真正生效 | **是（修复了一个 P0 后）** | `/memory` 列表/详情/覆写/版本链/批注/置顶/软删/恢复/硬删/晋升/部署/裁定均走真实 API；截图 01–07、11 |
| 人类用户能否参与管理 | **是** | 人工覆写写入 `memory_revisions`（r1→r7，原文保留）；裁定“不成立”→ 原行 `retired` + `[人工否定]` 负向 candidate + 批注；截图 05/06/07、DB 查询 |
| 存储和注入的时机 | **是（决定性证据）** | s1 自动注入含本会话 `3.12` 与频道级 `777`，**不含 s2 的 `999`**；对话回合落定恰 1 行 `episodic-dialog`，30 天过期，自动注入不含，显式检索命中；`timing-dialog-evidence.json` |
| 是否可以真正获取到记忆 | **是** | `recall`（自动）与 `recallRows`（显式）均命中；人工覆写后正文可检索；FTS 归一修复沿用批次 3 |
| 产线 Channel 能否获得产品历史设定 + 数采 + 经验分析 | **是（事实底座 + 结构化经验）** | 桌面端同页展示：`保压压力SP 60→62 / P-ACCEPT-01 / R-ACCEPT-01@v3 / exact / 前3.05→后3.14(n=50, raw过期) / identifiable_effect`；拒绝尝试保留“想写值 185.5”；参数手册 1 claims / 1 sources；截图 08/12 |

## 2. 门禁结果

| 门禁 | 结果 |
|---|---|
| `npm run lint` | PASS（含 RSI 红线：34 文件 0 设备写） |
| `npm run typecheck` | PASS |
| 定向测试（timing/dialog/provenance/claims/ontology surface） | 18/18 PASS |
| 全量 `test:unit` | **最终 2458 tests / 2457 pass / 1 skip / 0 fail**（首轮 `managed-mcp-client` 并行端口抖动，单跑与整仓复跑均 PASS） |
| `npm run i18n:check` | PARITY OK（3757/3757） |
| `npm run docs:check` | 101/0 |
| `npm run readme:lint` | PASS |
| `npm run build` | PASS |
| `npm run test:boot-smoke` | 6/6 PASS |

## 3. 本轮修复的真实缺陷（实机发现）

1. **`/memory` 列表恒空（P0）**：页面直接用 `$fetch` 读 `list.items`，拿到的是 `{code,message,data}` 信封；改为统一 `apiFetch` 解包。修复后列表、详情、所有治理动作才真正可用。此前批次 3 的“记忆中心”只在 API 层可用，UI 实际不可用。
2. **新 REST 面只认 Bearer token**：`operations` / `parameter-handbook` / `parameter-experience` 用 `resolveAgentOrUser`，浏览器 cookie 会话被 401；改为“用户会话或 Bearer 用户/Agent token”双通道，控制台可直接看操作追溯与手册。
3. **自动注入跨会话泄露**：`auto` 档 SQL/JS 双侧补会话过滤（当前会话 + `session_id=''`），显式检索仍可跨会话。
4. **部署/撤下/人工覆写不即时生效**：overlay 进程缓存 60s；新增按频道失效。
5. **本体证据词表断裂**：回灌写 `observed/observed_weak`（rank=-1）→ 映射到 `observed_correlation/candidate_influence`，历史非法值一次性迁移，`appendEvidence` 拒绝非法枚举。
6. **工具注册表**：新增 `operation_provenance` / `param_experience_query`（host-tools.json、handler、catalog、观察档白名单），builtin 127→129，实机 `tool-registry synced builtin=129`。

## 4. 交付能力（代码锚点）

- **批次 A**：`runtime/memory/memory-scopes.ts`、`runtime/memory/state.ts`、`supervise.ts`、`experience/overlay.ts`
- **批次 B**：`message.ts` 回合落定 → `recordDialog`（会话域/30 天/不自动注入）；`memory-admin.rejectMemory` + `/api/workshop/memory/[id]/reject`
- **批次 N**：`migrations-provenance.ts`、`write-attempt-ledger.ts`（payload/context）、`intervention-ledger.ts`（attempt/task/session/product/recipe/revision/context_source）、`daq/provenance-evidence.ts`（pre/post 统计 + ≤120 点 + raw_available + 不插值）、`aml/provenance-query.ts`、`operation_provenance` 工具 + `/channels/:id/operations`
- **批次 M（核心）**：`experience/types.ts` `ParameterClaim`、`versions.ts` `preserveHeadState/appendEvidenceVersion`、`experience/claims.ts`（claim 侧表 + 查询 + 参数手册）、`param_experience_query` 工具、`/parameter-experience`、`/parameter-handbook`
- **批次 D**：`migrations-ontology-evidence.ts`、`ontology/repo.ts` 非法等级拒绝、`aml/ontology-learning.ts` 映射
- **UI**：`/memory` 新增「产线追溯 / 参数手册」区、人工裁定入口；修复信封解包

## 4.5 Phase 2/3 补充交付（2026-11-27 二轮）

- **C 本体产品域**：`product_id` contracts/repo/service/API/UI 全链；`latestPublishedForLine(line,'')` 不取产品版、产品不回退产线；`ontology-product-scope` 测试 2/2。
- **E Curator**：`memory_curation_runs/sources/state`；来源准入、12+ 碎片→五段结构化文档、来源 id、增量 noop、人工编辑保护 + force、冲突并列、L0.5 注入 ≤200 tok；LLM 写作器（OpenAI 兼容 + SSRF 护栏 + 超时/非法 JSON 模板回退）；30min 调度；`/memory` 知识手册管理面。
- **F 决策点线索**：HITL 登记时附 ≤3 条 validated+deployed 经验（≤150 tok，只读）。
- **H 效果闭环**：注入留痕/任务归因（同 task 只计一次）/channel 自动退役/line-product flag/人工恢复 30 天豁免/90 天日志清理。
- **M2/M3 建议引擎**：硬过滤、1–3 条 + doNothing、cold_start、证据深链、`parameter_proposals`、`param_proposal` 工具/API、`proposal_id` 下发校验、verdict → assessed + 追加证据版本（继承 active）。
- **I Fabric 策略**：channel/session `memory_access_mode`；disabled 不读不写、isolated 不读 line/product/workspace、readonly 只读；recall/write/Curator 一致；API/UI。
- **J Core Blocks / 文件 / 工作记忆**：blocks（limit/locked/revision/rollback）、documents（六命令、路径穿越拒绝、软删恢复、64KB/200 上限）、runtime working memory（每回合落定、TTL 24h、按 runtime/session/task 隔离）；注入与工具/API/UI。
- **K 时序/链接**：valid_from/valid_to/recorded_at/superseded_by；默认排除失效、`as_of` 回看；memory_links 四关系；Curator 写 derived_from；supersede 不删除。
- **L 控制面**：incognito（disabled）、导出/导入 JSONL、敏感过滤、健康（FTS/超限）、修复（工作记忆/日志清理）。

实机（桌面端 CDP）：
- 截图 13：产线追溯 + 参数手册 + 核心块（工艺口径）+ 记忆文件（保压调参.md）+ 访问策略；
- 截图 14：生成 2 条参数建议（proposed，期望 0.085/0.08，置信 67%）；
- 截图 15：知识手册（Curator）在记忆中心可见；
- API：readonly→inherit 策略往返成功；导出 12,490 B；健康 memories=10/fts=15/blocks=1/docs=1；curations=1。

## 5. 已知边界（功能已交付，但不等同于“零限制”）

- **Curator LLM 写作器**需运维配置 `AW_MEMORY_CURATOR_LLM_URL/KEY/MODEL`（并过 SSRF 护栏）；未配置/超时/非法 JSON 一律模板回退，run 行记 `fallback_reason`。本轮实机走模板（未配置端点）。
- **产品域选择器**当前为文本输入（产品 id），候选来自调用方；尚未从 `channel_product_bindings` 动态下拉。
- **导出/导入/健康/修复**以 REST + 服务层为主；`/memory` UI 仅展示核心块/文件/访问策略/建议/手册，导出/导入/健康页尚未做成独立面板。
- **建议 HITL 拒绝回写**：`proposal_id` 已透传到 trial/apply 与干预台账，判定后 `assessed`；HITL 卡拒绝原因尚未单独回写 proposal（当前由未下发 + 人工审计体现）。
- **引用面板/时间线**：`memory_injection_log`、`memory_links`、`as_of` 已落库/可查，但对话侧“本轮引用了哪些记忆”的 UI 尚未展开。
- **session 级 access mode**：列/解析/生效已实现，UI 只提供 channel 级选择。
- **实机验收数据是演示夹具**：`aw-seed-acceptance.mjs` / `aw-phase23-seed.mts` 通过真实服务/表结构写入干预、DAQ 快照、claim、提案、块、文件与 Curator 文档；不是历史自然积累。`raw_available=0` 是故意构造“raw 已过期仍可查快照”的场景。
- 测试 home 中被早期脚本误改的 Harness 记忆是选择器缺陷留下的痕迹；不影响功能结论，但该 home 不是干净数据。

## 6. 证据清单（本目录）

- `01-memory-list.png` … `09-industry-top.png`：Web 端全流程
- `10-desktop-dashboard.png` … `12-desktop-industry.png`：桌面端 Phase 1
- `13-desktop-phase23.png` / `14-desktop-proposals.png` / `15-desktop-curated.png`：桌面端 Phase 2/3（块/文件/访问策略/建议/知识手册）
- `web-run.log` / `desktop-run.log` / `desktop-phase23.log`
- `timing-dialog-evidence.json`：自动注入隔离 + 对话沉淀的实机 DB 证据
- 复现脚本（仓库外）：`D:/tmp/aw-web-acceptance.mjs`、`D:/tmp/aw-desktop-acceptance.mjs`、`D:/tmp/aw-seed-acceptance.mjs`、`D:/tmp/aw-timing-live.mts`、`D:/tmp/aw-phase23-seed.mts`、`D:/tmp/aw-desktop-phase23.mjs`
