Repo root for all paths: `D:/tmp/aw-electron-desktop` (read-only audit; no tests run).

| Claim | Source doc:line | Impl anchor | Test anchor | Status |
|---|---|---|---|---|
| Close-to-tray hides window; 5 persisted settings | README.md:60-61 | desktop/main.mjs | tests/desktop-tray-splash.test.ts | VERIFIED |
| 660×440 boot splash, real stages, `/api/health` gate | README.md:62 | desktop/main.mjs:695; desktop/chrome/splash.html | tests/desktop-tray-splash.test.ts | VERIFIED |
| In-app update: SHA-256, WSH silent install helper | README.md:74,95 | desktop/update.mjs | tests/desktop-update.test.ts | VERIFIED |
| 40px titlebar, dark-theme sync, accessible controls | README.md:93; docs/desktop.md:15,35 | desktop/chrome/titlebar.html; preload.cjs | tests/desktop-chrome.test.ts | VERIFIED |
| Channel→Session→Agent: clones have own runtime/mailbox | README.md:221,228 | server/api/workshop/channels/[id]/sessions/index.post.ts; server/services/workshop/agents/session-clone.ts | tests/session-isolation.test.ts | VERIFIED |
| Closing a session cancels its in-flight task tree | README.md:230 | server/api/workshop/channels/[id]/sessions/[sid]/close.post.ts | tests/session-close-recovery.test.ts | VERIFIED |
| 7-state task machine, root queue | README.md:48,413 | server/services/workshop/runtime/task-engine/transition.ts | tests/task-engine-goal.test.ts | VERIFIED |
| 14 executable harness engines | README.md:31,48 | server/services/workshop/agents/registry.ts | tests/harness-construction-contract.test.ts | VERIFIED |
| Project blueprint instantiate; observe/supervised/auto | README.md:246-247 | server/api/workshop/projects/instantiate.post.ts; projects/service.ts:271 | tests/project-core.test.ts; project-api-completion.test.ts | VERIFIED |
| Deliverable gates L1 technical → L2 owner | README.md:249 | server/api/workshop/projects/[id]/deliverables/ | tests/project-observability.test.ts | VERIFIED |
| HITL approve/deny, authoritative expiry | README.md:48 | server/api/workshop/hitl/respond.post.ts | tests/hitl-expiry-authoritative.test.ts | VERIFIED |
| Durable write-attempt ledger around plant writes | README.md:121 | server/services/workshop/dcw/write-attempt-ledger.ts | tests/governed-resilience-and-plan-progress.test.ts | VERIFIED |
| Configured 60 s / 300 s write/approval gates | README.md:280 | dcw/dcw-controller/write.ts:146; shared/config/schema.json:108 | none asserting defaults | IMPL_NO_TEST |
| Line-scoped permissions + audit ledger | README.md:280,405 | server/api/workshop/permissions/{index.get,index.put}.ts; audit.get.ts | tests/security-b3-authz.test.ts; ops-log-query.test.ts | VERIFIED |
| DAQ scalar query/statistics; vector/image frames | README.md:357-358 | server/api/workshop/daq/query.get.ts; frames.get.ts | tests/daq-agent-query.test.ts; daq-export-frames.test.ts | VERIFIED |
| Five built-in protocol drivers | README.md:276 | server/services/workshop/daq/drivers/registry.ts | tests/multiexpert-p0.test.ts; mqtt-driver.test.ts; http-drivers.test.ts; dcw-drivers-opcua.test.ts | VERIFIED |
| Serial plugin (RTU/ASCII DAQ + writes) | README.md:31 | server/plugins-builtin/serial-bridge/index.mjs | tests/builtin-plugin-security.test.ts (security only) | IMPL_NO_TEST |
| MES REST mirror & live driver | README.md:31 | server/api/workshop/mes/; server/services/workshop/mes | tests/mes-rest-driver.test.ts | VERIFIED |
| DCW journal + readback/ACK | README.md:361 | server/api/workshop/dcw/journal/index.get.ts | tests/dcw-drivers-readback.test.ts | VERIFIED |
| Recipe versions, rollback, trial preflight | README.md:279,144 | dcw/recipes/[id]/rollback-good.post.ts; recipe-rollback-manager | tests/recipe-approval-snapshot.test.ts; recipe-trial-limits-preflight.test.ts | VERIFIED |
| Optimizer OSQP solve → dispatch/readback | README.md:279 | server/api/workshop/optimization/solve.post.ts | tests/optimizer-dispatch.test.ts; optimizer-solver.test.ts | VERIFIED |
| AML jobs/evaluations/model promotion | README.md:278 | server/api/workshop/aml/jobs/index.post.ts; models/[id]/promote.post.ts | tests/aml-job-success.test.ts | VERIFIED |
| Ontology guards fail closed on unknown state | README.md:124 | server/services/workshop/ontology/guards.ts | tests/ontology-guard.test.ts | VERIFIED |
| EDA studio chart/SPC/analysis routes | README.md:447 | server/api/workshop/eda/ | tests/eda-phase-c.test.ts | VERIFIED |
| 3D digital twin at `/town` | README.md:67,481 | app/pages/town.vue; app/components/workshop/town/TownScene3D.ts | tests/standalone-return.test.ts (chrome only) | IMPL_NO_TEST |
| RSI capture→gate→promote + governed resolver | README.md:275,118-119 | channels/[id]/memories/promote.post.ts; experience services | tests/rsi-experience-lifecycle.test.ts; governed-experience-resolver.test.ts | VERIFIED |
| Harness profile pin→shadow→active/rollback | README.md:187 | channels/[id]/harness-profiles/* | tests/harness-profile.test.ts | VERIFIED |
| AgentPrefab CAS revisions + pinned bindings | README.md:111 | server/api/workshop/agent-prefabs/* | tests/agent-prefab-service.test.ts | VERIFIED |
| Skills discovery/import/enable, managed copies | README.md:436 | server/api/system/skills/* | tests/managed-skills-api.test.ts | VERIFIED |
| External MCP pending→admin review, SSRF guard | README.md:437 | server/api/system/mcp-servers/* | tests/managed-mcp-broker.test.ts | VERIFIED |
| Plugin hot-reload, built-in plugins isolated | README.md:430 | server/services/workshop/plugins/ | tests/plugin-reload-swap.test.ts | VERIFIED |
| IDD diag-bridge + RAG kb_doc tools | README.md:130-132 | server/plugins-builtin/{diag-bridge,rag-bridge}/ | tests/diag-bridge-v1-contract.test.ts; rag-bridge-doc-tools.test.ts | VERIFIED |
| Schedules: interval 60 s floor / daily | README.md:409 | server/services/workshop/runtime/schedule-runtime.ts | none | IMPL_NO_TEST |
| Users, roles, multiple revocable tokens | README.md:403 | server/api/users/tokens/*; users/[id].put.ts | tests/security-b3-authz.test.ts | VERIFIED |
| Backup run/restore with retention | docs/site/en/guide/configuration.md:91 | server/plugins/backup.ts; server/api/system/backup/* | tests/security-b4b5-resilience.test.ts:154 | VERIFIED |
| CLI (`aw plugin/desktop/tui/…`), TUI client, SDK | docs/cli.md:184-198; docs/desktop.md:7,9 | cli/commands/*; tui/aw-tui.mjs; sdk/index.mjs | tests/cli-plugin-scaffold.test.ts; desktop-terminal-entry.test.ts; mes-tool-bridge-plugin.test.ts | VERIFIED |
| Localized UI labels (en/zh-CN) | README.md:67 | i18n/locales/{en,zh-CN}.ts; app/components/AppBackToMain.vue | tests/standalone-return.test.ts | VERIFIED |
| A2A JSON-RPC + WS AEP v1 seq resume | README.md:411 | server/api/workshop/a2a/*; ws/hub.ts | tests/session-a2a-scope.test.ts; agent-block-ws.test.ts | UNCLEAR — A2A and AEP frames tested; seq-resume replay not asserted |
| MCP tool surface "35 tools"; "12 assertion groups" | docs/mcp.md:69,116 | mcp/aw-mcp-server.mjs (38 tools) | tests/aw-mcp-server.test.ts (14 tests) | DOC_DRIFT |
| Project UI "880/312/1080 px" layout | README.md:213-214 | app/pages/projects/[id].vue; projects/index.vue | none | DOC_DRIFT |

Counts: VERIFIED 33 · IMPL_NO_TEST 4 · DOC_DRIFT 2 · UNCLEAR 1 (total 40).

DOC_DRIFT quotes:
- `## 五、工具面(35 个)` (docs/mcp.md:69) — actual `name:` entries in `mcp/aw-mcp-server.mjs` = 38; docs/cli.md:190 already says "38 工具"; the table enumerates only 34.
- `npm run test:mcp        # 单测(12 断言组)` (docs/mcp.md:116) — `tests/aw-mcp-server.test.ts` has 14 `test()` groups; README.md:138 says "MCP 14/14".
- `Project: breadcrumb header, 880 px reading column, 312 px snapshot rail` (README.md:213) — no `880` or `312` anywhere under `app/`; project chat bubble caps at 680 px.
- `Entry pages: 1080 px project grid with a 3-column create form, 1240 px workspace grid` (README.md:214) — workspace 1240 px exists; project list is `max-width: 1180px` (projects/index.vue:670).

Stale numbers/statements:
1. MCP tools 35 → 38 (above).
2. MCP tool table lists 34 names, omits `aw_recipe_list/update/mark_good`.
3. MCP unit groups 12 → 14 (above).
4. 880 px / 312 px project layout absent.
5. 1080 px project grid → 1180 px.
6. docs/mcp.md:105-109 says "三个项目级 skill … `skills/` 目录"; `skills/` contains nine (adds aw-doc-to-project, aw-line-onboarding, aw-live-acceptance-round, aw-plc-sim-twin, aw-protocol-onboarding, aw-system-acceptance).
7. README.md:466 says unit "1356 pass · 0 fail · 2 skip" while README.md:96 says "2,267 pass / 0 fail / 1 skip"; the table is labelled historical but the figures are mutually inconsistent.
8. Version check found no drift: package.json `0.17.5` = README release badges/link (README.md:11-13) = docs/desktop.md:61 tarball name.