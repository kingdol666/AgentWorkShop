# 合并主干统一审计（Task 15）

- 审计时间：2026-11-20（本地隔离克隆）
- 固定 SHA：`5614aa06a209c84549f291491b14ed3146e291d8`（`origin/main`）
- 方法：另建空目录 `gh repo clone` → `git fetch origin main` → `git rev-parse origin/main` → `git switch --detach <SHA>`；不复用开发工作树、PR 工作树或旧构建。
- 检出状态：`git status --porcelain` 为空；Node `v24.19.0`；pnpm `11.23.0`（本机全局版本；CI 按 `package.json`/CI 使用 11.9.0 与 Node 24）。
- 依赖：`pnpm install --frozen-lockfile` 退出 0。

## 1. 合并覆盖

以下合并结果 SHA 均验证为构建 SHA 的祖先：

| PR | 批次 | 合并提交 |
| --- | --- | --- |
| #240 | A 基线（Task 1） | `58d6d703` |
| #241 | B 经验正确性（Tasks 2–4） | `e2963f03` |
| #243 | C 经验运营（Tasks 5–7） | `a88ae675` |
| #245 | E 工件与验收（Tasks 12–15 检查器、14 文档、13 runner） | `deb4e5d6` |
| #244 | D 运行韧性（Tasks 8–11） | `5614aa06` |

## 2. 固定检查矩阵（本次全部重跑）

| 检查 | 退出码 |
| --- | --- |
| `pnpm run typecheck` | 0 |
| `pnpm run lint` | 0 |
| `pnpm run test:unit` | 0（2108 tests / 2107 pass / 0 fail / 1 conditional skip） |
| `pnpm run i18n:check` | 0（PARITY OK） |
| `pnpm run check:cssvars` | 0 |
| `pnpm run frontend-lifecycle-contract` | 0 |
| `pnpm run test:acceptance-context` | 0 |
| `pnpm run test:onboarding-v6` | 0 |
| `pnpm run test:sdk-surface` | 0 |
| `pnpm run test:plugin-lifecycle` | 0 |
| `pnpm run test:mcp` | 0 |
| `pnpm run docs:check` | 0 |
| `pnpm run build` | 0 |

`checkMainAudit` 判定：**PASS**（无阻断项）。每项证据均为本次运行日志，并按 SHA-256 绑定到同一构建 SHA。

## 3. 隔离运行时核验

- 以全新 `AW_HOME`、独占端口 `3031`、临时会话密钥启动该 SHA 的构建：健康门 `status=ok / workshop=ready / version=0.13.0`。
- 迁移生效：全新库出现全部 8 张治理表（`experience_versions`、`experience_heads`、`experience_version_audit`、`learning_authorization_epochs`、`experience_release_requests`、`experience_release_outbox`、`experience_reflection_outbox`、`dcw_write_attempts`），且 `aw_migration_ledger` 记录 `9002 experience-version-store`。
- 新增只读端点 `GET /api/workshop/channels/:id/memories/:memoryId/experience` 在未认证时返回 **401**。
- 未启动任何设备、未连接物理现场；实例在核验后按 PID 归属确认停止。

## 4. 分层结论

| 层 | 结论 | 依据 |
| --- | --- | --- |
| 软件门 | **PASS** | 固定矩阵 13/13 退出 0；`checkMainAudit` PASS |
| 迁移与启动 | **PASS**（隔离新库） | 8 表创建 + 迁移标记；健康门通过 |
| 隔离模拟验收 | **PARTIAL** | 见 `evidence/2026-11-20-governed-acceptance-round/`（A6/A7 收口缺口，A8 现场 NOT_RUN）；本轮未重跑真实模型长链 |
| 外部真实依赖 | **NOT_RUN** | 未在本轮审计中调用 IDD/RAG/云端模型 |
| 收益验证 | **NOT_RUN** | 需要 Task 5 冻结协议的独立前瞻样本 |
| 物理与现场准入 | **NOT_RUN** | 见 `operations/governed-industrial-pilot-admission.md`，无现场签核 |

## 5. 不主张

- 本报告不构成安全认证；提交期 Mimosa 扫描在实施分支不完整（`scanner_enobufs`），未以单有扫描痕迹代替结论。
- 不把软件门 PASS 外推为外部服务 SLA、真实收益、物理 HIL 或现场准入。
- 若后续新增行为差异（含修复本报告发现的缺口），须走新 PR 并重新锚定 `main` 复验；文档提交号不冒充运行 SHA。

## 6. 复现

```bash
gh repo clone kingdol666/AgentWorkShop <empty-dir>
cd <empty-dir> && git fetch origin main && git rev-parse origin/main
git switch --detach <该 SHA>
pnpm install --frozen-lockfile
# 串行执行 §2 的 13 条命令，保留日志与 SHA-256
node -e "import('./scripts/_audit/governed-main-audit.mjs').then(m=>console.log(m.checkMainAudit({...})))"
```
