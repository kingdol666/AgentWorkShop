# Architecture consistency audit — paper vs. running system (2026-10-12)

Requested check: does §III/§IV describe the system that actually exists?
Method: each quantitative claim traced to the artifact that owns it.

| Paper claim | Source of truth | Verdict |
|---|---|---|
| "14 engine adapters" | `server/services/workshop/agents/registry.ts` → `HARNESS_REGISTRY` | **Accurate** — exactly 14 keys: mock, omp, opencode, codex, dsh, claude, gemini, copilot, cursor, crush, goose, qwen, pi, hermes |
| "118 hot-reloadable settings" | `shared/config/schema.json` → `settings[]`, field `applies` | **WRONG — fixed.** 118 descriptors is right, but `applies` splits **40 live / 78 restart**. The paper called all 118 hot-reloadable. Now reads "118 declared settings (40 hot-reloadable, the rest restart-scoped)" |
| "six protocol families, five with drivers today … an S7 stub that fails loudly" | `server/services/workshop/daq/drivers/` | **Accurate** — http, modbus-tcp, modbus-rtu, mqtt, opcua, s7-stub (+ mock, index, registry, shared) |
| "six drivers over the five writable families plus MES REST, mock outside that count" | `server/services/workshop/dcw/drivers/` | **Accurate** — http, modbus, modbus-rtu, mqtt, opcua, mes-rest (+ mock) |
| DAQ modalities: scalars, vector profiles, image frames with fingerprints, mirrored MES records | `daq/daq-controller/frames.ts` — `kind: 'vector' \| 'image'` | **Accurate** |
| "member-written episodic memory retrieved by hybrid search" | `runtime/memory/recall.ts` — RRF fusion over ranked lists | **Accurate** (Reciprocal Rank Fusion is hybrid retrieval) |

## One caveat found, not changed

`HARNESS_REGISTRY` includes a `mock` harness, so "14 engine adapters" counts it —
while the same paper paragraph's companion claim explicitly excludes the mock
*driver* from the DCW count ("with the evaluation's mock driver registered
explicitly and outside that count"). The two counts use different inclusion
rules. "14" is literally correct (14 registered harnesses), so it was left
alone rather than silently restated; a reviewer checking the registry will find
14. If the authors prefer a like-for-like rule, it becomes "13 engine adapters
plus a mock".

## Terminology aligned this round

`multi-tenant` → `multi-line` in all four places (abstract, §I, §V-A, §VI).
The paper's own gloss was "many provisioned lines and channels on one host",
which is a multi-*line* deployment; "multi-tenant" in an industrial venue
connotes tenant isolation (an IEC 62443 property) that the paper does not
evaluate. The abstract then also drops the now-unneeded parenthetical.

## Abstract

238 words (limit 250), now carrying **11 digits** where it previously carried
**zero**: "Across seven campaign executions all 600 logged checks pass, and
removing the window interlock drops probe rejection from 18/18 to 12/18."
Both numbers were already in the paper (91 + 237 + 272 = 600), so this is the
swap the reviewers asked for, not new evidence. 1 + 3 + 3 = 7 executions.

## Budget

Still exactly **10 pages** (audit 6/6, `check-refs` 24/24). The additions above
were paid for by: `\looseness=-1` on six more long evaluation paragraphs (a
lever the paper already used; it cannot alter a claim), and scaling the two
full-width diagrams (Fig. 1 `0.74→0.64\textwidth`, Fig. 2 `0.50→0.38\textwidth`).
The bibliography is already at `\linespread{0.79}\scriptsize`, below IEEE's
8 pt reference specification — that well is dry and should not be drawn on again.
