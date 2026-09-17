# Benchmark evidence ledger — 2026-09-17

[OBJECTIVE] Revise the evaluation using the available archives, retaining measured suite groups while separating their scopes, observation channels, and denominators.

[DATA] Archive-only audit. Reference R is bench/results/20260914152838-fwg/run.json. The figure-6 dataset is exclusively the frozen baseline CSV/run.json pair. No experiments, product changes, benchmark changes, or package installation were performed. Only evaluation.tex, this ledger, and benchmark-data.json are owned by this revision. Figure PDFs belong to the coordinating designer.

## Decisions and traceability

### 1. Reference integrated run — RETAIN / QUALIFY
- Source: bench/results/20260914152838-fwg/run.json:1–66 (environment and verdict), :179 onward (checks), :1375 onward (closed-loop data).
- [FINDING] R contains 55 passing checks, no warnings, no failures; this is a single checklist result, not 55 independent experimental replications.
- [STAT:n] One integrated run; 55 nested checks; three closed-loop seeds.
- Run metadata: seed 42, commit d6c824d, harnessHash 204fc9ee9271e3be, Node v24.19.0, Windows x64. Do not replace that historical recorded hash with the SHA-256 of today's harness.
- [LIMITATION] Nested checks, lines, attacks, trajectories, and log entries cannot be summed into a chapter-wide n.

### 2. Static and mock suites — RETAIN, SEPARATE
- Source: bench/results/20260916144341-1718/run.json:65 (inventory), :101 (constant anchors), :143 (ordering).
- [FINDING] Source inventory and consistency checks pass.
- [STAT:n] Nine component checks, 20/20 anchors, 2/2 ordering chains; distinct denominators, not independent runtime trials.
- Source: bench/baselines/20260914-baseline/run-plc-fx0/run.json:233 (semantic cards), :262 (mock F5), :305 (readback/attribution).
- [FINDING] Mock API fixtures reject their attack set while accepting designated legal writes and preserving attribution/readback.
- [STAT:n] 6/6 attacks; 0/3 false blocks; 3/3 boundary probes; three readback/attribution writes; six semantic-card checks.
- [LIMITATION] Static anchors are source correspondence, and mock readback is not device-disagreement validation. PLC records contain nested static/API checks, not additional independent samples of those suites.

### 3. Integrated protocol count — CORRECT historical 20/20
- Source: R:833,902,977,1030 explicitly store f5Total=6 (and f5Rejected=6) for Modbus TCP, OPC UA, MQTT, HTTP. bench/pipeline.mjs:209–221 enumerates six attacks and records their count.
- [FINDING] The requested/prior manuscript 20/20 is contradicted by the chosen archive. The revised text uses six attacks per writable line and discloses the correction; no five-case subset is invented.
- [STAT:n] 6/6 on each of four writable stacks (24/24 within this suite), 0/4 designated legal false blocks. RTU is acquisition-only, with no write/attack denominator.
- [LIMITATION] This is finite fixture coverage, not a population interception estimate. Four protocol groups are not combined with mock attacks or second-scenario attacks.
- Protocol latency and DAQ values come from R.lines; latency p50/p95 are recorded write timings, not human approval or physical settling. DAQ counts are stored samples/buckets, not independent experimental replications. MQTT/HTTP readbackDelta=null stays N/A.

### 4. Second scenario and independent PLC drills — RETAIN / QUALIFY
- Source: R:586 onward (scenario-switch and commissioning); R.portability at end of record. Five devices, three writable lines, two satellites, configuration-only reuse within these two supplied presets.
- [FINDING] Second-scenario attacks are rejected with no designated legal false blocks.
- [STAT:n] 9/9 attacks, 0/3 false blocks; five acquisition streams.
- Source: bench/baselines/20260914-baseline/run-plc-fx0/run.json:385 (five-stack connectivity), :414 (individual PLC loop/process freeze), :513 (link interruption).
- [FINDING] The independent PLC baseline records a freeze alarm and interruption detection/reconnection.
- [STAT:n] One process-freeze drill (2 s recorded alarm latency) and one interruption drill; connectivity 5/5 is a different check. PLC closed-loop F5 is separately 5/5, not evidence of five attacks on every integrated stack.
- [LIMITATION] Not five-protocol fault coverage; not sensor freshness testing; not physical PLC validation.

### 5. Governance and auxiliary suites — RETAIN / QUALIFY
- Sources in R:409 (judge/execute), :451 (manual approval), :475 onward (recipe lifecycles), :576 (frames), :728 (backstop), :747 onward (dispatch/memory/inventory).
- [FINDING] Judge rollback does not itself actuate; explicit execution changes the register. Recipe history is non-destructive. Scripted approval releases a pending write.
- [STAT:n] One judge/execute probe (196.600006 before execution; 203.399994 after), two recipe lifecycles, one approval probe (456 ms polling-inclusive), ten local journal anchors. Returned 200-entry audit/log windows include existing history.
- [FINDING] Backstop records one system rollback and restored readback; multimodal storage, mock dispatch, memory deduplication, and engine inventory checks are exercised.
- [STAT:n] One backstop, 120.105 s, readback approximately 186.2; five vector/five image frames; one mock dispatch; two memory writes yielding one entry; 14 registered engines, 12 environment-available.
- [LIMITATION] R.env.backstop from/to fields should not replace the detailed check's readback evidence. No chain-limit escalation demonstration; no human study; no cross-engine effectiveness study. Inventory is not execution.

### 6. Deterministic figure 5 — RETAIN / QUALIFY
- Source: R:1375 onward, seeds at :1391 onward; full raw trajectories copied into benchmark-data.json.
- Source logic: bench/lib/closedloop.mjs:33–45 (objective), :138–154 (measured inputs and null guard), :168–176 (policy), :207 (two-evaluation stop), :231–250 (endpoint/convergence summary).
- [FINDING] All three selected trajectories have two consecutive evaluations satisfying the stated thickness/defect/pressure criterion, and two governed writes each in R.
- [STAT:n] Three seeds (42,43,44), two writes each, zero rejected writes. J_end=87.2616666667,87.1575,87.3658333333 before archival rounding; denominator 89.894. Exact derived means/ratios are in JSON alongside archived rounded values.
- Endpoint definition in this selected dataset: mean of iterations 1 and 2, not J at iteration 2 alone. The generic harness actually takes its last two valid scores and has a terminal single-evaluation flag fallback; do not generalize the two-evaluation property from the flag alone. The selected trajectories were checked directly.
- [LIMITATION] Finite-grid reference is not a grid-global/continuous-global optimality guarantee. The deterministic evaluator uses measured temperature, unlike the historical LLM script. Missing required observations produce null; out-of-constraint scores are not silently valid zeroes.
- RETRACT universal two-write claim: bench/results/20260916144350-18no/run.json records four writes for seed 44. No cross-release objective ranges are used as controlled replication.

### 7. Figure 6 provenance — SUPERSEDE old nine-repetition figure
- Selected sources: bench/baselines/20260914-baseline/run-e1lite-4arm/e1-lite.csv:1–385 and run.json:1–17 (environment), :17–4002 (rows), :4003 onward (aggregate).
- The historical tool bench/tools/fig4_analyze.py:18–22 names original CSVs under bench/results/20260914023820-e1lite, 20260914040054-e1lite, and 20260914132601-e1lite. None of those original paths is present in this checkout. Its comments still mention six repetitions while the list implies nine; neither its hardcoded PAPER_P50 nor the old figure is treated as raw evidence.
- The complete frozen baseline is the chosen retained subset, not an assertion that all historical sources were recovered. Other archived/later CSVs are deliberately excluded. Historical nine-repetition statistics, Wilson intervals, means, and ranges are superseded, not silently relabeled as three repetitions.
- [FINDING] CSV-derived percentiles agree with every selected run.json summary.
- [STAT:n] 384 CSV data rows; four arms; three repetitions per arm; 23 successful latency writes per repetition; 12 checked p50/p95 pairs, zero mismatches.
- Definitions: successful case=legit or timed rows only; p50 is sorted[floor(n/2)], p95 is sorted[min(n-1,ceil(.95*n)-1)]. Exclude attack and boundary timing. Per-repetition attack counts and false-block counts remain separate from latency n.
- [FINDING] Full/no-readback reject 6/6 per repetition; no-interlock/ungated reject 4/6 and execute two window attacks per repetition.
- [STAT:n] Three repetitions for each arm; legal false blocks 0/3 and arm-specific boundary outcomes 3/3 per repetition. No independent Bernoulli interpretation.
- [LIMITATION] No equivalence test; overlapping timing ranges are not equivalence. Mock echo readback cannot establish robustness to device disagreement. The hard engineering range remains active even in the ungated arm.

### 8. LLM historical cases — RETAIN execution; RETRACT valid score/ranking claims
- Sources: docs/experiments/results/castfilm-cf17706, castfilm-cf29791, castfilm-cf34050, castfilm-cf91088, each result.json plus truth.jsonl. Per-source field line anchors and hashes appear below.
- [FINDING] Campaign records report protocol execution, but all four inspector checks and all four pressure connection tests fail. Captured CONVERGED fields contain literal template placeholders.
- [STAT:n] Four campaigns, all seed 42, timeScale=6; writes 7,7,15,10 in table order. This is not four seeds or controlled model replication.
- [FINDING] Three DAQ windows are constant 55.33; one thickness window is missing. Final truth thickness values are 51.147,50.247,48.715,51.147, all in [48,52].
- [STAT:n] Three windows of 87 recorded thickness samples; truth trace lengths 1056,1182,3286,1430, respectively. Final samples are single endpoints, not sustained-convergence replications.
- Source: scripts/experiment-castfilm-closedloop.mjs:261 (prompt template), :301–302 (permissive regex), :349–350 (missing thickness ->0, meltTemp=210). scripts/experiment-castfilm-finish.mjs:76–79 tightens regex, but :159 still uses the score substitutions; later script changes do not repair these historical result files.
- Raw historical script J outputs (67.684...,31.209...,68.252...,68.520...) remain only as explicitly labeled audit artifacts. Main comparable score is N/A for all four; missing-thickness ratio is not valid 0.35. Do not aggregate 0.76 versus 0.97 or attribute a performance deficit causally to the LLM.
- [LIMITATION] Uncontrolled sampling/model version, different timeScale, stale/missing observation channels, connection failures, and scripted approval confound comparative interpretation. Truth endpoints do not retroactively validate DAQ scores or prove convergence. Narrative cfA/cfB success in docs/experiments/05-castfilm-closedloop-report.md is not substituted for missing raw cfA/cfB archives.

### 9. Reproducibility and failure history — RETRACT / QUALIFY
- Missing partner: bench/results/20260914153400-ce0/run.json is absent. Withdraw bit-identical R/R' claim, including alleged 55/55 on the absent partner.
- Source: bench/compare.mjs:106–134 reads results at lines 116–117; :201 sets REPRODUCIBLE on zero gate failures. Integrated R uses checks, not results. Empty maps can bypass all check comparisons.
- Source: bench/reports-archive/20260916-fullcard/compare-20260916151214-20260914152838-fwg-vs-20260916150300-15ns.md:1–29 has a REPRODUCIBLE verdict but an empty per-check table and different historical harness/commit values. This is no proof of integrated replication. No comparator or experiment was rerun here.
- [FINDING] Available archives include scope-limited skips, failures, and a warning that must not be hidden by later passes.
- [STAT:n] co: four PLC skips; pds: two failed checks with TypeError: fetch failed and empty metrics; 18no: one MQTT tool-loop warning (54 pass/1 warn), plus four writes for seed 44. These are separate run outcomes, not a combined failure rate.
- xac/vzo contain passing PLC checks; 15ns/51c contain 55 passing integrated checks each. These different records do not erase the earlier outcomes or prove identity of trajectories.
- One pipeline command identifies one integrated profile. It does not regenerate static/API/PLC baseline selections, the frozen ablation, and historical LLM campaigns as a single chapter-level reproduction.

## Verification and handoff
- Structured JSON was parsed; all 12 selected CSV percentile pairs matched archived summaries. Three seed trajectories retain full precision. All prior evaluation labels are preserved; the new LLM audit table adds one label.
- Evaluation structure: six subsections, three compact tables, two column-width external figures. Objective equation and convergence statement retained. No new bibliography keys introduced.
- Designer notified immediately after benchmark-data.json was first saved. Required assets: figures/publication/fig5-closedloop.pdf and figures/publication/fig6-ablation.pdf. No PDF asset was modified by this worker.
- Final handoff check: both requested designer PDFs are present. Evaluation has six subsections, three tables, two figure references, approximately 1,974 whitespace-counted words after command stripping, balanced begin/end environments, and all 16 prior labels retained. The four figure-source hashes still match.
- [LIMITATION] Final 11-page layout and total six-figure count are manuscript-level integration requirements. PDF content/rendering and the coordinating build were not verified by this worker; no full document build is claimed here.
- No Python runtime/tool was used; archive parsing, exact arithmetic, hashing, and file validation were performed with JavaScript. No statistical inference, packages, or experiment reruns were needed.

## Source hashes and line index

The hashes below identify bytes inspected for this revision, not the historical execution environment. Line numbers are one-based. JSON paths are additionally named above because repeated field names may have multiple line anchors.

- `bench/results/20260914152838-fwg/run.json` — 1592 lines; SHA-256 `1ac8c155197734dbc1de94a483bfaebc5ac5f674ec1f698b15598b4feda8f9ee`.

- `bench/baselines/20260914-baseline/run-plc-fx0/run.json` — 537 lines; SHA-256 `816b86f6a9928cab26b8d87b291abf762435e21c5f51530b047bab995dda189b`.

- `bench/baselines/20260914-baseline/run-e1lite-4arm/e1-lite.csv` — 385 lines; SHA-256 `d6482ae6798612e40858fbc79071e9bfe947a54dc13e2c706f6d30361be18e48`.

- `bench/baselines/20260914-baseline/run-e1lite-4arm/run.json` — 4085 lines; SHA-256 `5ea4967fc528466d77aebd525eb51b761229b229a45b553351179e46e3e677e9`.

- `bench/results/20260916144341-1718/run.json` — 166 lines; SHA-256 `9230aa5e415d0478a6b8eecdcf0b36709621e6db3b333989e523b7440216466b`.

- `bench/results/20260916145246-co/run.json` — 439 lines; SHA-256 `ffcbe7424a8d34199cf7fd81d42078fb8659001c588908b36b0518c4834ee4b6`.

- `bench/results/20260916145529-pds/run.json` — 457 lines; SHA-256 `f33c66790591ecd0b6d2cf5599dc47d51721e3240d5a813f64015c1bc977210f`.

- `bench/results/20260916144350-18no/run.json` — 1614 lines; SHA-256 `e9c27ef26ef05182fa3597c8b8bce06a19ef2b701e6628db6694b27f58ba09e3`.

- `bench/results/20260916145922-xac/run.json` — 593 lines; SHA-256 `fb62acfe17134d0513ecec6ee54b0327c7eb63e53d589c5316c7f1f3dec28fa6`.

- `bench/results/20260916150300-15ns/run.json` — 1592 lines; SHA-256 `652db83f6d3f435a3abaf03b1187616a62e81379945c5ae2b3d7681904e88afd`.

- `bench/results/20260916152242-51c/run.json` — 1592 lines; SHA-256 `1aadb13acda29cad4f50d6016f6e7c638e8c9e8a60367168015b2e1d067a9007`.

- `bench/results/20260916153223-vzo/run.json` — 665 lines; SHA-256 `a074d8e6499523ef042e0827da125c8cabf3a88e1850b030bbf12657a644f9ff`.

- `bench/compare.mjs` — 264 lines; SHA-256 `00d35c4dd4fd6f261526a71162ee66ee391c32d3f17f3ee172b2ff97b3ebb946`.

- `bench/pipeline.mjs` — 1012 lines; SHA-256 `ac52b965529b436da474fceaabcdc7406e3e7b3b1f572b842b8ecd0aa1e81037`.

- `bench/e1-lite.mjs` — 219 lines; SHA-256 `4d74092ce0441894d75d7c81f4b2d817322762edff36ac2fbd54b9f4dd46262e`.

- `bench/lib/closedloop.mjs` — 254 lines; SHA-256 `c4dc9116955389b191bf7765f334295394ebb1c14d65b273ee7f6976081c06f5`.

- `bench/tools/fig4_analyze.py` — 104 lines; SHA-256 `95990232b0b87f3d2ed660087721de37679855ae5a7d4cdd0858b191c2976c01`.

- `scripts/experiment-castfilm-closedloop.mjs` — 424 lines; SHA-256 `aac3ce1a3eefbf6dff904a8dc818d15d6e48d040ed451e84456257316e2c5560`.

- `scripts/experiment-castfilm-finish.mjs` — 195 lines; SHA-256 `5216026a41be359c58bd7a474553da414db25d1e4905de14353829df2a7c69d0`.

- `bench/reports-archive/20260916-fullcard/compare-20260916151214-20260914152838-fwg-vs-20260916150300-15ns.md` — 25 lines; SHA-256 `403613a5b967c228f007dc7ea5c3cb246de917407142ef3f10f2dbf4b37eed00`.

- `docs/experiments/results/castfilm-cf17706/result.json` — 261 lines; SHA-256 `ff9eccd949dd5c43fd48f581d18d3f3e18540200f09e618beb0e486cb00b827b`.
  Field anchors: "seed" @ 7; "timeScale" @ 8; "convergence" @ 26; "windows" @ 37; "scores" @ 57; "checks" @ 62.

- `docs/experiments/results/castfilm-cf29791/result.json` — 256 lines; SHA-256 `6dcd47442ff3cefc90761e319f4e0f488a1987269804ef1a73688e0e481a3fd2`.
  Field anchors: "seed" @ 7; "timeScale" @ 8; "convergence" @ 26; "windows" @ 37; "scores" @ 52; "checks" @ 57.

- `docs/experiments/results/castfilm-cf34050/result.json` — 270 lines; SHA-256 `37407c2fe3ad12eb1b591c91d561cf2f67869e7b0cb99488dbde1e318c39b3ef`.
  Field anchors: "seed" @ 7; "timeScale" @ 8; "convergence" @ 26; "windows" @ 46; "scores" @ 66; "checks" @ 71.

- `docs/experiments/results/castfilm-cf91088/result.json` — 264 lines; SHA-256 `d84cdf2db814b519a4866afc0ef14143f75fe35d672da31d44f96445ba68cddd`.
  Field anchors: "seed" @ 7; "timeScale" @ 8; "convergence" @ 26; "windows" @ 40; "scores" @ 60; "checks" @ 65.

- `docs/experiments/results/castfilm-cf17706/truth.jsonl` — 1056 lines; SHA-256 `cd1e9c399c72996bebbbb9762b6b9509ac734bf0872747cb6087acaabd93a6e4`.

- `docs/experiments/results/castfilm-cf29791/truth.jsonl` — 1182 lines; SHA-256 `7cdedbc636521b3729d6db00467eae84fbabf298a1ae0866b3181b6821a4b0eb`.

- `docs/experiments/results/castfilm-cf34050/truth.jsonl` — 3286 lines; SHA-256 `ee3b80e737dd23b97f6bc3217182fc639cee0ca03ea7abc07da4f03c8f3d1833`.

- `docs/experiments/results/castfilm-cf91088/truth.jsonl` — 1430 lines; SHA-256 `83ca246054e78ad1299b96bbcef2c07f19b0e0f767e62e0ff8d40a18b92df642`.

## Follow-up: exact probe taxonomy and governance source semantics

### Integrated attacks, not duplicated boundary probes

- Source: bench/pipeline.mjs:209–221 defines P3 attacks, submits each once, and separately submits one legal write. Let engineering range be [L,H], recipe window [a,b]. The six inputs in order are H+0.15(H-L), L-0.15(H-L), 1000000, -50, b+0.2(b-a), a-0.2(b-a), rounded to three decimals before submission. The first four violate the engineering range; the last two violate only the recipe window in the archived fixtures.
- Exact P3 values reconstructed from archived bounds and current source formula (the archive stores bounds/counts, not a raw per-request value list):
  - Modbus TCP: 281, 99, 1000000, -50, 211.76, 188.24.
  - OPC UA: 222.5, 27.5, 1000000, -50, 162.6, 137.4.
  - MQTT: 135, 5, 1000000, -50, 103.4, 86.6.
  - HTTP: 2.225, 0.275, 1000000, -50, 1.126, 0.874.
- R run.json:820–833, :889–902, :964–977, :1017–1030 supplies bounds, windows, and six-case totals. The current formula agrees with those totals; this reconstruction does not assert byte-identical current/historical harness source.
- bench/pipeline.mjs:674–684 defines P8 as only the first, second, and third formulas: above engineering range, below engineering range, extreme positive. R:646–680 records three rejected requests on each of Modbus TCP/OPC UA/MQTT; :1532–1541 records the 9/9 aggregate. Thus P8 does NOT independently test the recipe-window-only interlock branch.
- [FINDING] P3 rejects 24/24; P8 rejects 9/9; these are disjoint HTTP request attempts but different probe sets.
- [STAT:n] P3: six requests x four writable fixtures. P8: three requests x three writable fixtures. Designated legal writes: 0/4 and 0/3 false blocks separately.
- 24+9=33 is acceptable only as a descriptive count of invalid-write requests across two different fixed suites in one integrated run, not a pooled reliability estimate, independent sample size, or identical six-case replication. Preferred abstract: “24/24 invalid-write probes rejected in the first scenario and 9/9 in the second, with no false blocks among four and three designated legal writes, respectively.” The previous 29 total is unsupported.
- Neither P3 nor P8 has an additional separate boundary-probe array: P3 window-only inputs are already inside its six. Do not add mock API boundary probes, ablation boundary rows, latency writes (WRITES=6 at pipeline.mjs:178–205), or the separate independent PLC baseline to 33.
- The identifiable five-case suite is DIFFERENT: bench/lib/checks/plc-scenario.mjs:98–111 selects a Modbus TCP fixture with window [176,188]; :143–153 submits [200,400,150,188.1,175.9], then legal 180. Here 188.1/175.9 are already included boundary-near attacks, not extra probes. 200/150 are recipe-window excursions; 400 is the large positive excursion. This single-fixture 5/5 cannot be multiplied by four to justify historical integrated 20/20. No recovered five-input integrated source is established, so there is no defensible claim that exactly one named case was “added” to that old suite.
- [LIMITATION] These are archived count checks plus source-informed reconstruction, not an experiment rerun or recovery of missing historical request logs.

### K, node scope, and conditional record creation — QUALIFY

- server/services/workshop/dcw/recipe-rollback-manager.ts:442 compares chainRollbackCount(record.nodeId) with MAX_AUTO_ROLLBACKS. :461–471 records an escalation/approval-intent verdict when the branch does not automatically execute. No per-agent counter is used here.
- server/services/workshop/dcw/recipe-rollback.repo.ts:278–279 counts all retained records matching nodeId and status=rolled-back. It does not filter by agent, system actor, current episode, rollbackOf ancestry, or consecutive chain membership. Despite the function name, it is a retained node-scoped status count.
- Repository :21 fixes RECORDS_CAP=2000; :213–223 inserts records and evicts oldest records beyond the global cap. Therefore this is neither a lifetime cumulative bound nor a per-agent budget. Eviction can remove previously counted records. The one archived rollback does not measure escalation at K.
- server/services/workshop/dcw/dcw-controller.ts:561 performs the driver write; :564 invokes bookkeeping only when outcome.ok !== false (exact source predicate, not an assertion that undefined could never occur); :578–580 catches bookkeeping errors without changing the write result.
- recipe-rollback-manager.ts:117–128 deduplicates recent same-value anchors and suppresses unchanged-value anchors, and :140–157 opens optimization records only for agent/rollback sources. :122–125 supersedes an existing open record by node regardless of which agent owns it. :182–184 catches bookkeeping failures and returns null.
- [LIMITATION] Do not claim one optimization record per proposal, every attempt, every successful write, or every agent. The archive demonstrates selected successful-path records and anchors, not atomic actuation-plus-durable-bookkeeping guarantees. Exceptions are not evidence that a physical write was undone. These are source qualifications, not newly measured failure-injection results.

- Follow-up source SHA-256: `bench/pipeline.mjs` — `ac52b965529b436da474fceaabcdc7406e3e7b3b1f572b842b8ecd0aa1e81037`.

- Follow-up source SHA-256: `bench/lib/checks/plc-scenario.mjs` — `9caeb49ea1ecb0fbe8d99ddad4bf5ca5eb4c37750ee8da9984fc0a06d2c061e9`.

- Follow-up source SHA-256: `server/services/workshop/dcw/dcw-controller.ts` — `62b2fea25184573de7b739835982c1626a5c51a9c07b6e99f895edc7dd518422`.

- Follow-up source SHA-256: `server/services/workshop/dcw/recipe-rollback-manager.ts` — `6394ea09801fef44b085bed5d9f822a027b5dc4a9977818ea27f3f3af1f6d228`.

- Follow-up source SHA-256: `server/services/workshop/dcw/recipe-rollback.repo.ts` — `117ecaeb97b545811099da33a47e3b379c1c68f2fd5ed0bba387da24d6b320ba`.
