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
| 全量 `test:unit` | **最终 2437 tests / 2436 pass / 1 skip / 0 fail**（首轮唯一失败为 `managed-mcp-client` 并行端口抖动，单独复跑 1/1 PASS，整仓复跑 0 fail） |
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

## 5. 未完成 / 不在本轮验收范围（如实）

- **批次 E（Curator 通用知识手册 + LLM 写作器 + 调度/版本/来源表）未实现**；参数手册目前是确定性模板（无 LLM、无独立 run 表），满足“连续结构化经验分析”，但不满足计划 M13–M22 的 Curator 验收。
- **批次 H（注入效果归因 + 保守自动退役）未实现**。
- **批次 M2/M3 的建议引擎 / HITL 建议卡 / `parameter_proposals` 未实现**；用户已裁决“具体怎么下发交给 Agent 研究”，本轮只做事实链 + 结构化经验 + 只读查询；Agent 仍走 `recipe_trial/update/apply + HITL + 本体护栏`。
- **批次 C（本体产品域）只完成迁移与证据词表；repo/service/API/UI 的 productId 透传未完成**。产品域迁移已注册，但 `latestPublishedForLine` 尚不区分产品。
- **Phase 2/3（Fabric/Blocks/Documents/时序/透明控制）未开始**。
- **全量 unit 已复跑并通过**（2436/2437，1 skip）；首轮 `managed-mcp-client` 失败为并行抖动，单跑与整仓复跑均 PASS。
- **实机验收数据是演示夹具**：`aw-seed-acceptance.mjs` 通过真实表结构写入 2 条干预、1 条 DAQ 快照、1 条结构化 claim、2 条写尝试；不是历史自然积累。`raw_available=0` 是故意构造“raw 已过期仍可查快照”的场景。
- 测试 home 中被脚本误改的 Harness 记忆（标题/正文被追加、其中 1 条被裁定退役）是验收脚本早期选择器缺陷留下的痕迹；不影响本轮功能结论，但该 home 不是干净数据。

## 6. 证据清单（本目录）

- `01-memory-list.png` … `09-industry-top.png`：Web 端全流程
- `10-desktop-dashboard.png` … `12-desktop-industry.png`：桌面端
- `web-run.log` / `desktop-run.log`
- `timing-dialog-evidence.json`：自动注入隔离 + 对话沉淀的实机 DB 证据
- 复现脚本（仓库外）：`D:/tmp/aw-web-acceptance.mjs`、`D:/tmp/aw-desktop-acceptance.mjs`、`D:/tmp/aw-seed-acceptance.mjs`、`D:/tmp/aw-timing-live.mts`
