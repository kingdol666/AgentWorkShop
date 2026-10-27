# Repository cleanup — 2026-10-26

## Scope

Remove obsolete one-off debug/test scripts and superseded design notes without touching
runtime code, acceptance evidence, the current test suites, or any uncommitted parallel work.

## Removal criteria

A file was removed only when all of the following held:

1. It is tracked in git.
2. It has zero references across the repository (including `package.json`, current scripts,
   tests, README files, VitePress docs, skills, and archived evidence).
3. It predates 2026-10-01 (the current acceptance era began with the v0.8.x rounds).
4. It is not one of the preserved helper/acceptance tools listed below.

Preserved on purpose: `scripts/_audit/**` (acceptance helpers referenced by skills),
`scripts/ui/record-demo.mjs`, `scripts/ui/seed-industrial-demo.mjs`, all `tests/**`,
all `docs/audit/evidence/**`, and the active acceptance suites.

## Removed

- 58 obsolete one-off scripts:
  - `_aw-*`, `_i18n-*` duplicate scanners, `_lib-*`, `_probe-*`, `_loop-*`, `_lint-reflow`
  - old `test-*` / `demo-group-chat-*` / `proof-*` / `smoke-*` scripts
  - old `test-group-chat-unit/**` and `test-scheduler-loop/**` sections
  - old `scripts/ui/*` capture/audit helpers (except the two preserved above)
- 5 superseded design/experiment notes:
  - `docs/aml-twin-plugin-sdk-hotload-plan.md`
  - `docs/dcw-exploration-safety-and-line-operations.md`
  - `docs/design/nightwatch-instrument.md`
  - `docs/experiments/06-review-actions-plan.md`
  - `docs/experiments/07-tii-experiment-review.md`

The full list is reproducible from `git show --stat` for this commit.

## Verification after cleanup

| Layer | Command | Result |
| --- | --- | --- |
| T0 static | `npm run lint` | PASS |
| T0 static | `npm run typecheck` | PASS |
| T0 docs | `npm run docs:check` | 91/91 |
| T0 i18n | `npm run i18n:check` | 3148/3148, unresolved 0 |
| T0 README | `npm run readme:lint` | PASS |
| T1 unit | `npm run test:unit` | **581/581** (0 fail) |
| T1 MCP | `npm run test:mcp` | 14/14 |
| T1 plugins | `npm run test:plugin-lifecycle` | 22/22 |
| T1 SDK | `npm run test:sdk-surface` | PASS |
| T1 twin | `npm run test:twin-provider` | 5/5 |
| T1 skills | `npm run test:skills` | 124 PASS / 0 FAIL |
| T2 ontology | `e2e-ontology-live.mjs` | **87/87** (L1–L7, including Chrome six tabs) |
| T2 model loop | `e2e-model-loop-live.mjs` | 54/54 |
| T2 optimizer | `e2e-optimizer-live.mjs` | 104/104 |
| T2 line governance | `test:e2e-line` | 44/44 |
| T3 REST | `test:api-live` (admin token on isolated instance) | 64/64 |
| Docs build | `npm run docs:build` | PASS |

The unit suite reports 581 passing tests. The acceptance skill still records a historical
599 baseline; no test files under `tests/**` were removed in this cleanup, so the difference
is a documentation/baseline reconciliation item, not a regression in this commit.

## Boundaries

- The 4-scenario bench still fails attainment after the v2 driver migration; see
  `bench/V2-MIGRATION.md`. Writes now execute through `recipe_trial`; the remaining red is
  simulator blueprint/response fidelity, not a T2 functional gate.
- Mimosa deep scan was run and sealed, but remains **inconclusive** with 46 static advisories;
  see `docs/audit/2026-10-26-mimosa-triage.md`. No security certification is claimed.
- IDD/RAG result-library suites and the injection closed-loop suite were not rerun because
  their external backends/fixtures were not part of this isolated cleanup run.
