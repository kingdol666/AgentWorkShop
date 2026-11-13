# AgentWorkShop 生产就绪加固实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复最新主干中已复现的浏览器认证、API 契约、数据恢复/质量、前端生命周期和交付门禁问题，并以独立 PR 逐项验收，明确真实产线仍需现场门禁。

**Architecture:** 采用五个可回滚边界：浏览器会话与 WS ticket、API 契约与恢复、DAQ 质量与可观测性、前端生命周期与 CI、最终集成验收。控制写入口和 Agent Bearer API 保持兼容；浏览器会话改用同源 HttpOnly cookie，WS 只消费短时一次性 ticket。SQLite 迁移和恢复沿用现有单进程设计，不在本计划中假装完成 HA。

**Tech Stack:** Nuxt 4, Vue 3, Nitro/h3, TypeScript, node:sqlite, Zod, Pinia, WebSocket, GitHub Actions, tsx node:test.

**Spec:** `docs/superpowers/specs/2026-11-13-production-readiness-design.md`

## Global Constraints

- 不替代 PLC 硬联锁、急停或 SIS；任何控制写入继续经过现有权限、HITL、write intent、限制和回读链。
- 外部 Agent `Authorization: Bearer` 契约保持兼容；只改变浏览器用户会话和浏览器 WS 握手。
- 不提交凭据、真实现场地址或真实 PLC 数据；模拟器证据必须明确标记为 simulator。
- 每个 PR 必须有独立测试、lint/typecheck 证据和可回滚提交；不得把论文工作树的既有改动带入。
- 所有新 API 错误使用非 2xx HTTP 状态和统一 `{code,message,data:null}` envelope。
- Node 运行版本统一为 24.x；不得通过静默降级掩盖版本不兼容。

## Review Focus

- 旧浏览器 cookie/localStorage 只剩 token 时，用户能否安全迁移且不会循环请求：Task 1 的迁移与过期测试。
- ticket 重放、跨用户、过期和并发消费：Task 1 的一次性消费测试。
- 恢复到已有数据目录或坏备份时，是否原子、可验证且不覆盖现有数据：Task 2 的 dry-run/restore 测试。
- 断线和质量码变化时，UI 是否把 stale/offline 当成正常值：Task 3 的状态转换测试。
- 页面反复导航/隐藏切换后，WS 订阅是否归零、主题首帧是否稳定、门禁是否在 CI 执行：Task 4 的生命周期契约与 workflow 检查。

---

### Task 1: 浏览器会话 Cookie 与一次性 WebSocket Ticket

**Files:**
- Create: `server/services/auth/browser-session.ts`
- Create: `server/api/users/session.post.ts`
- Create: `server/api/users/session.delete.ts`
- Create: `server/api/workshop/ws/ticket.post.ts`
- Modify: `server/api/users/login.post.ts`, `server/api/users/register.post.ts`, `server/api/users/me.get.ts`
- Modify: `app/utils/auth-session.ts`, `app/stores/workshop/user.ts`, `app/stores/workshop/connection.ts`, `app/plugins/session-restore.client.ts`
- Modify: `server/api/workshop/ws/handlers.ts`, `server/api/workshop/ws/peer-sub.ts`
- Test: `tests/browser-session.test.ts`, `tests/ws-ticket.test.ts`

**Interfaces:**
- Produces `issueBrowserSession(userId: string): BrowserSession`, `readBrowserSession(event): ResolvedUser`, `revokeBrowserSession(id: string): void`, and `consumeWsTicket(ticket: string): { userId: string, expiresAt: number }`.
- Browser session is HttpOnly and same-origin; bearer token resolution remains for non-browser API callers.
- WS ticket TTL is 60 seconds, single-use, bound to the authenticated user, and never logged.

- [ ] **Step 1: Write failing tests** for cookie attributes, bearer compatibility, ticket expiry, replay rejection, and cross-user rejection.
- [ ] **Step 2: Run `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/browser-session.test.ts tests/ws-ticket.test.ts` and verify the new contracts fail.
- [ ] **Step 3: Implement browser session storage and session endpoints** using the existing users.sqlite repository; hash opaque session IDs at rest, cap active sessions per user, and set `HttpOnly; SameSite=Lax; Secure` when HTTPS.
- [ ] **Step 4: Implement ticket issue/consume** with an in-memory single-process store bounded by TTL and an explicit note that multi-instance deployment must externalize it.
- [ ] **Step 5: Update browser clients** to call same-origin session bootstrap and request a ticket before WS connect; remove browser `localStorage aw.token` writes and user-token query construction while preserving Agent Bearer paths.
- [ ] **Step 6: Run focused tests, then `pnpm typecheck` and `pnpm test:unit`; verify all pass.
- [ ] **Step 7: Commit `feat(auth): use browser sessions and one-time websocket tickets`.

### Task 2: API Contract, Versioned Migration Ledger, and Backup Restore

**Files:**
- Create: `server/services/workshop/db/database/migration-ledger.ts`
- Create: `server/services/workshop/db/backup/restore.ts`
- Create: `server/api/system/backup/restore.post.ts`
- Modify: `server/api/system/settings/index.patch.ts`, `server/services/workshop/db/database/open.ts`, `server/services/workshop/db/database/schema.ts`, `server/services/workshop/db/database/schema.sql`
- Modify: high-risk write routes selected by the baseline inventory (`dcw write`, recipe apply, permissions, runtime settings)
- Test: `tests/api-contract-hardening.test.ts`, `tests/migration-ledger.test.ts`, `tests/backup-restore.test.ts`

**Interfaces:**
- Produces `assertPatchSettingsBody(input): SettingsPatchBody`, `restoreBackup({ source, target, dryRun }): RestoreReport`, and `currentSchemaVersion(): number`.
- Restore refuses path traversal, refuses overwrite without an explicit admin-only confirmation token, validates SQLite integrity, and uses temp-file + atomic rename.
- Migration ledger records ordered version, checksum, appliedAt, and description; startup remains idempotent.

- [ ] **Step 1: Write failing tests** for invalid settings returning HTTP 400 envelope, high-risk malformed bodies, migration idempotency, checksum mismatch, restore dry-run, integrity failure, and refusal to overwrite.
- [ ] **Step 2: Run focused tests and verify expected failures.
- [ ] **Step 3: Add Zod schemas to the selected write routes** and convert settings invalid-body path to `AppError(400, 'VALIDATION_ERROR', ...)`.
- [ ] **Step 4: Add migration ledger** around existing migrations without rewriting historical data; detect schema checksum drift and fail with an actionable message.
- [ ] **Step 5: Add admin-only restore service and route** with loopback/authorization safeguards, no automatic destructive overwrite, and audit record.
- [ ] **Step 6: Run focused tests, full unit suite, typecheck, and build.
- [ ] **Step 7: Commit `feat(ops): harden api contracts and database recovery`.

### Task 3: DAQ Quality, Staleness, and Recovery Visibility

**Files:**
- Create: `server/services/workshop/daq/quality.ts`
- Modify: `server/services/workshop/daq/daq-node.ts`, `server/services/workshop/daq/daq-runtime.ts`, `server/services/workshop/daq/daq-controller/push.ts`, `server/services/workshop/daq/ingest-policy.ts`, DAQ storage adapters, DAQ API view types
- Modify: `app/composables/workshop/useDaqStream.ts`, `app/components/daq/*`, `app/utils/alarm-presentation.ts`
- Test: `tests/daq-quality.test.ts`, `tests/daq-recovery-contract.test.ts`

**Interfaces:**
- Produces `QualityState = 'good' | 'uncertain' | 'bad' | 'stale' | 'offline'` and `qualityFromReading(input): QualityState`.
- Every displayed reading carries `quality`, `observedAt`, `receivedAt`, and `staleSince` when applicable; old API fields remain backward compatible.
- Recovery events are durable audit/ops events, not fabricated numeric readings.

- [ ] **Step 1: Write failing tests** for good, driver-error, stale timeout, reconnect recovery, future timestamp rejection, and no-value-on-offline behavior.
- [ ] **Step 2: Run focused tests and verify failures.
- [ ] **Step 3: Implement quality state transitions** at the DAQ runtime boundary, preserving raw driver status and avoiding range-derived quality substitution.
- [ ] **Step 4: Persist required quality/timestamp fields** in SQLite/Timescale adapters and expose recovery counters in API metadata.
- [ ] **Step 5: Render quality/stale/offline state distinctly** in DAQ node cards, trends, alarm rows, and mobile view; do not color stale as healthy.
- [ ] **Step 6: Run focused tests, full unit suite, typecheck, and real simulator read/断线/reconnect smoke.
- [ ] **Step 7: Commit `feat(daq): expose signal quality and recovery state`.

### Task 4: Frontend Lifecycle, SSR Theme, Accessibility, and CI Gates

**Files:**
- Create: `app/composables/useScopedStreamFeed.ts`
- Modify: `app/app.vue`, `app/pages/index.vue`, `app/composables/workshop/town/useTownRailData.ts`, `app/plugins/theme.client.ts`, `app/composables/workshop/useVisibleInterval.ts`
- Modify: critical custom modal components and `app/assets/css/main.css`
- Modify: `.github/workflows/ci.yml`, `scripts/ui/lib.mjs`, `scripts/ui/verify-responsive.mjs`
- Test: `tests/frontend-lifecycle-contract.test.ts`, `tests/theme-ssr-contract.test.ts`, `tests/ci-gates-contract.test.ts`

**Interfaces:**
- `useScopedStreamFeed(start: () => () => void)` returns `release(): void` and auto-releases on component unmount; double release is harmless.
- SSR `htmlAttrs.class` is derived from `aw-theme` cookie and matches the client plugin.
- CI runs lint, typecheck, unit, build, i18n parity, CSS variable check, and responsive contract gate on Node 24.

- [ ] **Step 1: Write failing tests** for balanced dashboard/Town subscriptions, SSR dark class, hidden-tab interval pause, dialog semantics, and required CI commands.
- [ ] **Step 2: Run focused tests and verify failures.
- [ ] **Step 3: Implement scoped feed ownership** and update all consumers to release on unmount; use `useVisibleInterval` for project detail refresh.
- [ ] **Step 4: Add SSR theme class and accessible dialog/focus behavior** to custom modals without changing antd modal behavior.
- [ ] **Step 5: Add missing CI gates and expand route inventory only where the harness is deterministic; document simulator-only routes.
- [ ] **Step 6: Run focused tests, UI responsive matrix, lint, typecheck, unit, build, i18n, and CSS checks.
- [ ] **Step 7: Commit `fix(ui): close lifecycle theme and delivery gates`.

### Task 5: PR Acceptance, Main Sync, and Field Integration Package

**Files:**
- Create: `docs/production-readiness/2026-11-13-software-acceptance.md`
- Create: `docs/production-readiness/2026-11-13-field-cutover-checklist.md`
- Create: `scripts/acceptance/production-readiness.mjs`
- Modify: `README.md`, `README-zh.md`, relevant protocol/onboarding docs
- Test: acceptance script and production build evidence under `docs/audit/evidence/2026-11-13-production-readiness/`

**Interfaces:**
- Acceptance script emits machine-readable JSON with commit, environment, software gates, simulator label, and unresolved field gates.
- Field checklist explicitly requires real PLC/MES credentials, network/security owner, 24h read-only soak, independent readback, outage drills, and SIS boundary sign-off.

- [ ] **Step 1: Write failing acceptance assertions** for commit identity, all software gates, no token in browser WS URL, alarm/API/DOM convergence, and explicit simulator-only labeling.
- [ ] **Step 2: Run acceptance script and verify it fails before implementation.
- [ ] **Step 3: Implement evidence collector and field checklist**; do not mark real-PLC gates passed from simulator data.
- [ ] **Step 4: Run production build with required env, start isolated instance, execute API/UI/WS/DAQ/DCW/chat smoke and capture screenshots/logs.
- [ ] **Step 5: Run final whole suite and independent review; address Critical/Important findings with one RED→GREEN pass.
- [ ] **Step 6: Create PRs in task order, wait for CI, merge each into main, sync this worktree to latest main, and rerun unified acceptance.
- [ ] **Step 7: Commit `docs: publish production readiness and field cutover gates`.

## Final verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm i18n:check
pnpm check:cssvars
pnpm ui:verify
node scripts/acceptance/production-readiness.mjs
```

Expected software result: all commands exit 0; unit count is reported from the current main rather than hard-coded. Expected field result: real PLC/MES, security, outage, and SIS gates remain explicitly `PENDING` until independently supplied evidence exists.
