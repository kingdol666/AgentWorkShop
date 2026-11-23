**Audit of `D:/tmp/aw-electron-desktop/docs/plans/2026-11-13-operational-context-research-learning-framework.md`** (read-only; no tests were run, so a "test" anchor means located and read).

Path prefixes, all under `D:/tmp/aw-electron-desktop/`: `ctx/`=`server/services/workshop/context/`, `res/`=`server/services/workshop/research/`, `ev/`=`server/services/workshop/evidence/`, `rsi/`=`server/services/workshop/rsi-adapter/`, `sh/`=`shared/context/`, `plug/`=`.AgentWorkShop/plugins/rsi-interface-beta/`, `run`=`scripts/acceptance-context-learning.mjs`. Tests: core=`tests/context-core-contract.test.ts`, neu=`tests/context-schema-neutrality.test.ts`, adp=`tests/context-adapter-contract.test.ts`, res=`tests/research-orchestration.test.ts`, proj=`tests/context-projection.test.ts`, rt=`tests/context-runtime-scope-binding.test.ts`, acc=`tests/context-learning-acceptance.test.mjs`, rda=`tests/rsi-read-adapters.test.ts`, rbi=`tests/rsi-beta-research-integration.test.ts`, rbl=`tests/rsi-beta-plugin-lifecycle.test.ts`, roe=`tests/rsi-operational-evidence.test.ts`. ADR=`docs/architecture/2026-11-13-adr-rsi-beta-boundary-contract.md`.

| Item | Status | Implementation anchor | Test anchor | Note |
|---|---|---|---|---|
| Task1-1 | VERIFIED | sh/contracts.ts:41-152; sh/refs.ts:4-17 | core L45, L83; neu L25 | no negative test for unqualified namespace |
| Task1-2 | PARTIAL | neu L7-16 | — | 6 contract files only |
| Task1-3 | PARTIAL | ctx/validator.ts:27-169 | core L63, L83 | unit mismatch untested |
| Task1-4 | PARTIAL | sh/hash.ts:16-22 | core L54 | in-memory only |
| Task2-1 | NOT_FOUND | — | — | |
| Task2-2 | NOT_FOUND | — | — | |
| Task2-3 | NOT_FOUND | — | — | |
| Task2-4 | NOT_FOUND | — | — | |
| Task3-1 | PARTIAL | ctx/contracts.ts:229; ctx/registry.ts:113 | adp L24; rbl L210 | |
| Task3-2 | PARTIAL | ctx/contracts.ts:9-18; ctx/registry.ts:225-231 | adp L66 | no `actuate` |
| Task3-3 | PARTIAL | ctx/registry.ts:397-440; server/services/workshop/plugins/host/reload.mjs:129-149 | adp L78, L92; rbl L210 | |
| Task3-4 | IMPL_NO_TEST | sdk/index.d.mts:82,133,331,340 | — | |
| Task4-1 | PARTIAL | res/orchestrator.ts:142-223, 346; res/state.ts:5-16 | res L49, L104; rbi L160 | no CAS, pause/resume |
| Task4-2 | VERIFIED | res/orchestrator.ts:243-307 | res L32; neu L34 | |
| Task4-3 | PARTIAL | res/contracts.ts:14-41 | adp L128; res L49 | |
| Task4-4 | SUPERSEDED | res/orchestrator.ts:265, 443-462 | res L104; acc L34 | ADR §4 |
| Task4-5 | VERIFIED | res/orchestrator.ts | res L32 | ends at candidate evidence |
| Task5-1 | PARTIAL | ev/normalizer.ts:54-88; ev/candidate-store.ts:50-65 | res L112; core L92 | |
| Task5-2 | PARTIAL | ctx/adapters/industrial-read.ts:241-402, 805 | proj L37; roe L156 | |
| Task5-3 | PARTIAL | rsi/contracts.ts:5-6, 120-139 | rda L44, L80 | read-only |
| Task5-4 | PARTIAL | rsi/contracts.ts:156-212 | rda L80, L91, L107 | |
| Task6-1 | PARTIAL | ctx/runtime.ts:161-201; plug/scope.mjs:160-175 | rt L47, L89; rbl L189 | no risk dimension |
| Task6-2 | PARTIAL | ctx/runtime.ts:88-138, 188-201 | rt L47, L59 | |
| Task6-3 | SUPERSEDED | plug/index.mjs:56; res/orchestrator.ts:237 | rbl L168 | ADR §1.3/§4/§5 |
| Task6-4 | PARTIAL | plug/index.mjs:614-627; ctx/runtime.ts:235-250 | rbi L126; rt L102; rda L80 | |
| Task7-1 | VERIFIED | ctx/adapters/industrial-read.ts:275-327 | proj L37 | |
| Task7-2 | PARTIAL | same, :823 | proj L37 (title only) | |
| Task7-3 | PARTIAL | ctx/runtime.ts:191-193 | proj L148; rt L47 | |
| Task7-4 | PARTIAL | ctx/adapters/industrial-read.ts:817-823 | roe L156 | |
| Task8-1 | VERIFIED | run:131-153; tests/profiles/context/*.json (9) | acc L7 | one shared fixture |
| Task8-2 | PARTIAL | run:449-454 | acc L7 | |
| Task8-3 | PARTIAL | run (no domain branch, by inspection) | — | no static check |
| Task8-4 | PARTIAL | run:483-495 | acc L7 | |
| Task9-1 | PARTIAL | plug/client.mjs:33-105 | — | |
| Task9-2 | PARTIAL | plug/client.mjs:33-36 | — | |
| Task9-3 | PARTIAL | plug/i18n.json | — | |
| Task9-4 | PARTIAL | run `--report` | acc L7 | no report.json committed |
| DoD-1 | PARTIAL | neu L7-16 | — | |
| DoD-2 | PARTIAL | ctx/registry.ts:113 | adp L128 | |
| DoD-3 | PARTIAL | run:456-504 | acc L7 | |
| DoD-4 | PARTIAL | ctx/adapters/industrial-read.ts:268-373 | proj L37 | |
| DoD-5 | PARTIAL | ev/candidate-store.ts:50-65; rsi/contracts.ts:156-191 | res L112; rda L91 | |
| DoD-6 | PARTIAL | ctx/registry.ts:227-231; rsi/contracts.ts:181-189 | adp L66; rda L91; res L61 | |
| DoD-7 | PARTIAL | res/contracts.ts:35-41 | adp L128; res L104 | |
| DoD-8 | PARTIAL | package.json:108-113 | not executed | |
| DoD-9 | PARTIAL | tests/profiles/context/ | acc L7 | no industrial/core profile |

**Counts:** VERIFIED 5 · PARTIAL 34 · NOT_FOUND 4 · SUPERSEDED 2 · IMPL_NO_TEST 1 (46)

## NOT_FOUND

Task 2 has no implementation. `server/services/workshop/context/extensions/` does not exist, and neither do `tests/context-extension-registry.test.ts` or `tests/context-ontology-bridge.test.ts`. Patterns tried across server, shared, mcp, sdk, app, tests and scripts: `ContextSchemaExtension|extensionRegistry|ExtensionRegistry|extension-registry|extensions/|registerExtension|validateExtension|publishExtension|retireExtension` (no hits), and `ContextRef|contextSnapshot|extensionId|shared/context` inside the ontology service, ontology API and mcp (no hits).

- **Task2-1** “实现 extension registration/validate/publish/retire，固定 namespace/version/immutable 语义” — only an `extensionRefSchema` label field exists (`sh/contracts.ts:127`).
- **Task2-2** “实现 extension validator 的 accept/warn/reject contract 和结构化 error path” — nothing.
- **Task2-3** “将 ontology entities/relations/evidence 映射到四个核心实体；禁止 extension 重定义核心字段或放宽控制” — `rsi/ontology.ts` only passes ontology payloads through as read records.
- **Task2-4** “覆盖跨 extension 冲突、未知 extension、版本漂移、unsupported compile form 和 candidate 文本注入负例” — nothing.

## SUPERSEDED

- **Task4-4** “研究执行生成 EvidenceEnvelope refs；actuate 只调用治理后的 gateway，非物理模式不得伪造 readback” — evidence refs are generated and tested; ADR §4 replaces the governed actuate with a hard ban (`RESEARCH_ACTUATE_FORBIDDEN`).
- **Task6-3** “所有高风险研究/证据/发布动作经过独立审批；Agent 不可自批；物理写仍走单一写咽喉” — ADR §1.3/§4/§5 and `plug/index.mjs:56` put approval, promotion and actuation outside the Beta boundary. `approveRead(id)` takes no approver and is auto-called in the same request (`plug/index.mjs:649-650`).

## IMPL_NO_TEST

- **Task3-4** “保持现有 ctx.daq、ctx.dcw、ctx.twin、ctx.permissions 兼容，不为通用框架复制专用 driver” — the SDK still exposes all four and no context types were added; `scripts/test-sdk-surface.mjs` does not name them.

## PARTIAL

- **Task1-2** “写 neutrality test，扫描 core contract、schema 和 generic API 参数…” — scans 6 contract files; bare `product/recipe/run` are not forbidden, and no DB-schema or API-parameter scan exists.
- **Task1-3** “写时间有效性、单位失配、悬空引用、重复 assignment、无 provenance 的失败用例” — the unit-mismatch branch (`ctx/validator.ts:102-108`) has no test.
- **Task1-4** “以隔离数据库运行 contract tests，确认冻结 snapshot 的 canonical hash 稳定” — hash stability is tested in memory; there are no context tables and snapshots are not frozen or persisted.
- **Task3-1** “注册 OperationalContextAdapter、capability、extension、evidence adapter 和 research strategy” — only the adapter and its capabilities register.
- **Task3-2** “将 discover/snapshot/observe/simulate/replay/verify/actuate 统一为 typed request/result…” — `actuate` is excluded by design.
- **Task3-3** “对 project/user/builtin plugin 做热加载、dispose、失败隔离、凭据和出站安全测试” — registry lifecycle is tested; plugin-type hot-load and credential/outbound tests are missing, and the host cleanup in `reload.mjs` is untested.
- **Task4-1** “实现 ResearchCase/Plan/Run/Step/verdict 状态机、CAS、幂等、cancel/pause/resume/recovery” — no CAS and no pause/resume; there are separate Case and Step contracts but the orchestrator only uses Run and Plan.
- **Task4-3** “支持 observational/interventional/simulation/replay/human-review/custom 研究模式” — modes are implicit capability choices; no human-review or custom mode.
- **Task5-1** “实现 EvidenceEnvelope normalization、hash、provenance、quality/freshness、support/refute/conflict” — no freshness field or evaluation and no conflict detection; `ev/registry.ts` is absent.
- **Task5-2** “将现有 intervention/DAQ/MES/twin/document/human/model evidence 映射到通用 refs” — industrial sources are mapped; document exists only as a test fixture; human and model evidence are not mapped.
- **Task5-3** “将 RSI recall/reflect/validate/promote/rollback 适配为 generic subject/object/material scopes…” — only a `read` adapter exists.
- **Task5-4** “验证无锚、stale、跨 scope、无独立验证的工件不能 promote/control；回滚和权限撤销可收敛在飞引用” — stale, cross-scope, revoked and conflict reads are tested; the rest does not exist.
- **Task6-1** “实现 actor × scope × capability × risk 的通用判定，父级不隐式授予子对象写权” — principal × deployment scope, plus capability in the plugin; no risk dimension, and subject refs are rejected as unknown fields.
- **Task6-2** “映射现有 lineMode 和工业绑定权限，确认 line/product/recipe/run 只在 adapter view” — `lineId/lineIds/industrial` sit in the generic runtime (`ctx/runtime.ts:23-31`), outside the gate.
- **Task6-4** “覆盖 readonly、跨 tenant/subject、撤权、驱动失联、审批拒绝和恰一条审计事件” — revocation, driver loss and audit-event count are untested.
- **Task7-2** “保留现有 API、driverConfig、DAQ/DCW/MES/Twin、recipe evidence 与权限行为” — the adapter is additive and read-only; the test asserts nothing about legacy output.
- **Task7-3** “证明 core research service 可用同一接口访问 industrial 与 non-line fixture…” — no test runs research over the real industrial adapter; rbi L57-60 substitutes a fixture.
- **Task7-4** “验证控制 guard 只收紧、写频控/HITL/回读证据不被 adapter 绕过” — read-only by construction; no bypass or guard-tightening test.
- **Task8-2** “运行 C0–C5、R1–R6、权限 negative cases 并输出 report.json” — a report is produced, but there are no gates or permission negatives, and `physicalWrites: 0` is a constant (`run:397`).
- **Task8-3** “静态检查 runner 不含领域条件分支；profile 只提供数据、extension、adapter、能力和期望” — the runner is branch-free, but no static-check test exists and profiles carry no extension.
- **Task8-4** “对每个 profile 记录未覆盖面、拒绝码、证据 refs 和 adapter/schema 版本” — no uncovered-coverage or rejection-code fields.
- **Task9-1** “展示 ContextSubject/object/attribute/material、snapshot、research run、evidence provenance、permission decision 和 adapter health” — the panel shows flags, scope, adapter health and three provenance rows only.
- **Task9-2** “UI 不把 line/product/recipe/run 作为通用导航前提；工业视图可通过 adapter label 展示” — no prerequisite exists, but no industrial view and no UI test.
- **Task9-3** “中文/英文术语 parity，所有 fixture 名称与领域说明放在 profile 文档…” — parity only for about 30 panel strings; no site or profile docs.
- **Task9-4** “运行全量回归并保存每个 profile 的 report.json…” — no report.json is committed.
- **DoD-1** “核心 contract 仅依赖领域无关基元；静态 neutrality gate 通过” — the gate is narrower than planned.
- **DoD-2** “任意 extension/adapter/plugin 可在不改 core schema 的情况下注册新的 subject/object/attribute/material/driver” — extensions cannot register.
- **DoD-3** “至少一个无产线 profile 完成 research→evidence→RSI 闭环；至少 PVA、注塑、WWTP 三个 profile 用同一 runner 验收” — profiles pass, but the runner is a simulation with no RSI step.
- **DoD-4** “line/product/recipe/run 仅在 industrial adapter/compatibility view 出现；现有工业链路和权限回归全绿” — see Task6-2; regression not run.
- **DoD-5** “evidence provenance/hash/scope/freshness、ontology trace、RSI lifecycle 和 rollback 均可查询、审计、负例可证伪” — provenance, hash and scope only.
- **DoD-6** “readonly/cross-scope/agent-self-approve/unsupported-capability/stale-evidence/driver-failure 等负向测试全部 fail closed…” — all covered except self-approval.
- **DoD-7** “研究编排支持 observe/simulate/replay/human-review/custom，不强制物理写；任何 actuate 仍经过既有治理链” — actuate is banned (ADR §4); human-review and custom modes are missing.
- **DoD-8** “plugin lifecycle、SDK、ontology、AML/Twin、RSI、line permission、科学探索和发布 smoke 无回归” — suites exist; not verifiable read-only.
- **DoD-9** “每个 PR 都有独立测试和 evidence；最终矩阵包含 core、non-line、custom driver、industrial、PVA、注塑、WWTP profile” — no industrial or core profile exists.

## Summary

1. What exists is a read-only "RSI Beta" slice: domain-neutral contracts and validator, an adapter registry, an in-memory bounded research orchestrator, a candidate-only evidence store, read-only RSI adapters and one industrial read adapter.
2. All of it is reached only through a default-off plugin at `.AgentWorkShop/plugins/rsi-interface-beta/` (not `server/plugins-builtin`). There are no REST routes, MCP tools or Vue pages for it.
3. Task 2 is entirely absent, as are actuation, promotion, independent approval, pause/resume, CAS and persistence tables. ADR-PR0 deliberately descoped the first four; the 2026-11-20 governed-learning plan says it implements only a subset and does not replace this plan.
4. The acceptance runner imports only Node builtins and never calls the registry, orchestrator, validator or evidence store, so its PASS for nine profiles proves the harness, not the framework.
5. 5 of 46 items are fully implemented and tested, 34 are partial, 4 are not found, 2 are superseded and 1 is untested.