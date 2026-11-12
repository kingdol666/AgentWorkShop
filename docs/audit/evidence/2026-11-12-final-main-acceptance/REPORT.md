# AgentWorkShop v0.11.2 final main acceptance

- Date: 2026-11-12
- Final main: `6af25a8b10ec14e529af134a3395b52beadb94dd`
- Release base: v0.11.1
- Runtime: production `.output/server/index.mjs`, `AW_MODE=home`, isolated `AW_HOME=D:/tmp/aw-final-accept-20261112/home`, port 3167
- PLC: isolated simulator twin at `127.0.0.1:4044`, Modbus device port 5056, source export `accept-inject`; no shared 4010 target

## Final acceptance matrix

| Suite | Result | Evidence |
|---|---:|---|
| Static gates | PASS | lint, typecheck, i18n parity, docs 87/0, README lint |
| Unit | PASS | 1516/1516, 0 fail, 0 skip |
| Production build | PASS | `.output/server/index.mjs` |
| Production smoke | PASS | `/` 200, unauthenticated AML 401, health 200 |
| Persisted home restart | PASS | health 200 after restart; DCW 2/2 online; DAQ 2/2, samples restored; channels 9 |
| PLC provision | PASS | 10/10 |
| PLC V1–V6 | PASS | 11/11 |
| Agent control | PASS | 9/9 |
| REST/WS/MCP | PASS | 75/75 |
| Project/SuperAgent multi-channel | PASS | 14/14 |
| RSI live | PASS | 32/32 |
| RSI multi-round | PASS | 10/10 |
| UI screenshots | PASS with observations | 6 pages, overflowX=0, pageErrors=0, consoleErrors empty after final capture |

## Fixed issues in this acceptance wave

1. `recipe_trial` deterministic out-of-range candidates previously created a HITL card and only failed after approval. Final behavior rejects before HITL, creates no approval card, performs no driver write, and leaves device unchanged. The same preflight covers active recipe windows.
2. PR #166 nearest-neighbor alignment now has an independent production-helper regression test covering offset timestamps, exact timestamps, tolerance boundary, and beyond-tolerance missing values.
3. Follow-up strict runtime validation rejects null, booleans, empty strings, NaN, Infinity, `"NaN"`, `"Infinity"`, and nonnumeric strings as a whole batch; finite numbers and numeric strings remain valid.
4. Historical upgrade blocker #182 remains reproduced-and-fixed: messages idempotency index is created after migrated columns; cloned persisted home restarted successfully.

## UI evidence

Screenshots are stored in `shots/` and were captured from the final production-style instance at 1440×900 dark theme:
`dashboard`, `workshop`, `projects`, `monitor`, `daq`, `dcw`.

The browser matrix reported `overflowX=0`, no page errors, and no console errors after the final capture. Earlier exploratory capture showed hydration mismatch warnings on two routes; the final capture did not reproduce them. They remain a follow-up observation rather than a release blocker.

## Boundaries

- PLC evidence uses an isolated digital-twin simulator, not physical PLC hardware.
- Agent control, Project and RSI orchestration use deterministic mock harnesses; real OMP/deepseek execution is not part of this final patch-release run.
- RSI B2 paired statistics use the acceptance runner, not a production model benchmark.
- Mimosa full security scan did not complete (`scanner_enobufs`); no security-pass claim is made.
- The final home uses persisted data cloned from the prior acceptance home and was restarted on the final main build; physical production resources were not touched.
