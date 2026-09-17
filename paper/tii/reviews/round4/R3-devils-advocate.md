# Round 4 — Reviewer 3 (Devil's Advocate, Claim–Evidence Alignment)

**Scope.** Every quantitative claim in the rendered draft (`paper/tii/_rev4/p-01..12.png`, cross-checked against `sections/evaluation.tex`, `main.tex`) was re-verified against the primary archives: R = `bench/results/20260914152838-fwg/`, E = `bench/results/20260917044223-17ho/` (summary.json, run.json 62-check array, agentteam-mission.log, agent-loop-omp.log), fresh runs 20260917045341-186k / 20260917041225-1bjc / 20260917045058-105w / 20260917045202-e1lite, apilive logs, comparators `compare-20260917*.md`, frozen baselines `bench/baselines/20260914-baseline/`, campaign raw files `docs/experiments/results/castfilm-cf*/`, and the bench code that generates the claimed numbers.

## Verification summary of the five mandated checks

**1. Abstract — SUPPORTED.**
- "24/24 and 9/9": R `run.json` lines[] store f5Rejected=6/f5Total=6 for Modbus-TCP, OPC-UA, MQTT, HTTP (6×4=24) and `portability.agg` f5 9/9 with falseBlocks 0. Attack design verified in `bench/pipeline.mjs:219-225`: exactly four hard-range values (setpoint.hi+15%, setpoint.lo−15%, 1e6, −50) plus two recipe-window-only values (window.max/min ±20% span) per writable line — the paper's "four hard-range violations and two recipe-window-only violations" (p.8) matches the code exactly.
- "97.0–97.2 %": R `closedloop.agg` ratioMin 0.97, ratioMax 0.972 (J* = 89.894).
- Mission sentence ("attains its setpoint objective … in one write"): `agentteam-mission.log` — "writes=1 finalPV=204.6999969482422 attained=true terminal=COMPLETED".
- Omp-loop sentence ("read–write–verify–judge … evidence-cited"): `agent-loop-omp.log` lines 193–255 — daq_query read → dcw_control(197.48, hypothesis=…) → sleep 3 → re-queries → dcw_judge keep citing "199.41→200.1℃ … [191.6, 208.4]℃". Model name glm-5.3-flash correct (p.1 render confirms "omp/glm-5.3-flash"; my initial "dm" read was an OCR artifact).

**2. Sec. V-D — ALL NUMBERS SUPPORTED.**
- Target 204.704 ± 0.75 °C, window [191.6, 208.4], ≤3 writes: mission log header; P4m check `mission-attained` evidence "writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75".
- Five-minute window: P4m check `mission-timescale-read` evidence "window 300s".
- 78% of window: `bench/pipeline.mjs:351` `target = window.min + span * 0.78`; arithmetic 191.6 + 0.78×16.8 = 204.704 exactly.
- One governed write, readback match, judged keep, journal attribution, COMPLETED: mission log steps 1–4; P4m checks `mission-governed-write`, `mission-journal`, `mission-closed`.
- 6/6 mission checks: run.json `checks` array contains exactly six P4m checks (mission-board, mission-timescale-read, mission-governed-write, mission-journal, mission-attained, mission-closed), all "pass".
- COMPLETED + sentinel in 132 s: log header "wall: 132.344s, final state: COMPLETED, oracle INTEGRATED-CLOSEDLOOP-OK: yes"; P5 check `agent-loop` "COMPLETED（132.344s）✔ 交付含 INTEGRATED-CLOSEDLOOP-OK". Adaptive bucket switch (1 s → 15 s): log lines 219–235.

**3. Fig. 6 vs the log — SUPPORTED with one disclosure gap (Finding 3).**
- Log DAQ sequences: first read 12:42:15→12:43:45 = 44.65, 111.86, 167.23, 188.4, 195.74, 198.36, 199.32 (90 s); post-write re-query 12:43:45→12:44:30 = 199.41, 199.65, 200.02, 200.1. Text "44.7 to 199.3 °C in 90 s" matches.
- `figures/publication/fig7-agenttrace.py` plots exactly the 10 points listed in the review mandate; SP 200→197.48, readback 197.5, window [191.6, 208.4] all annotated and match the log. Legend "measured PV (15 s buckets, Modbus TCP)" correct (verified at 2× zoom).

**4. Sec. V-F repro — SUPPORTED.**
- Static 20/20: 20260917045341-186k report s2 "anchors=20 found=20 missing=0"; s3 chainsOk=2/2.
- Integrated 61/61: 20260917041225-1bjc run.json — 61 checks, 0 non-pass.
- PLC 13/13: 20260917045058-105w report "13 pass · 0 warn · 0 fail"; also confirms 5/5 connectivity, 5/5 attacks + legal write accepted, freeze alarm f2_alarm_latency_s=2, link-recovery drill — matching the Sec. V-B PLC claims.
- Ablation: 20260917045202-e1lite pattern (100/66.7/100/66.7 % interception, 0 false blocks, 9/9 boundary) matches; all eight p50/p95 ranges in Sec. V-E match the frozen baseline values itemized in `compare-20260917045341-…e1lite….md` (e.g., full.p50 [125.4,140.9,125.8]; ungated.p50 [112.4,110.9,125]; no-readback.p95 [156.5,156.4,156.7]).
- API survey 60: `apilive-20260917.log` "★ ALL PASS (60 passed)".
- Comparator gap: `compare-20260917042630-20260917041225-1bjc-vs-20260917041804-1ahw.md` indeed contains an **empty** per-check table under a "REPRODUCIBLE" verdict — the paper's disclosure (p.10, V-G) is accurate, and the PLC/ablation comparators are non-empty (4 and 13 rows) as claimed.

**5. Sweep of all remaining numbers — verified unless listed as a finding below.** R metadata (seed 42, commit d6c824d, harness 204fc9ee, Node v24.19.0, win32 x64, 55/0/0), Table II (2/11/12/12/14 samples; 111.5/141.6, 19.0/22.1, 19.4/19.5, 32.8/33.2; Δ 0.04/0/N/A), nine component checks, mock 6/6-0/3-3/3-3, second scenario 9/9 + 0 false blocks + 0 code changes, lifecycle 196.60 (196.600006…) / ≈203.40 (203.399993…) / 456 ms / 10 anchors / 200 audit-log entries, backstop 120.105 s @ 186.2, 5 vector + 5 image frames, registry 14 (12 env-available — correctly attributed to R; E's own snapshot says 14, not cited), V-C (N=150, v=95, J weights, [195,225] °C, 22 MPa, [196,224] °C, [48,52] μm, 2%; J0 68.071/70.206/64.694; Jend 87.262/87.157/87.366; ratios 0.971/0.970/0.972; two writes/seed; 36.188 s; thickness 50.03/49.73/50.58; 18no seed-44 four writes — `20260916144350-18no/summary.json` perSeed writes=4, verdict 54 pass/1 warn matching the MQTT-loop warning), V-E (23 writes/rep — `benchmark-data.json.verification.successful_latency_samples_per_repetition=23`; all 12 percentile pairs), V-F (old J 67.684/31.210/68.252/68.520; 87×3 windows at 55.33; cf29791 thickness null + MQTT ECONNREFUSED; four pressure OPC-UA connection failures; four inspector failures; seed 42 + timeScale 6 ×4; melt-210 and permissive CONVERGED regex confirmed at `scripts/experiment-castfilm-closedloop.mjs:301,349`; **Writes 7/7/15/10 are anchored** in each archived result.json check name "[数控] dcw-writes 账本 7/7/15/10 条真实协议写"), V-G (ce0 absent; co 4 skips; pds 2 fetch-failed checks; xac/vzo/15ns/51c passing; reproCmd with `--agent omp` in E).

The two previously contested items remain correctly handled: the 24/24 correction is explicit ("This corrects the earlier manuscript's unsupported 20/20 count", p.8) and matches the archive; the LLM campaign scores remain withdrawn (Table IV caption "Main-score status is N/A for every campaign"; "the missing-thickness main score is N/A, not a 0.35 ratio" — archived ratio 0.347 for cf29791).

## Findings

**1. [MINOR] Commit identifier for archive E does not match the archive's own provenance field.** Sec. V-A (evaluation.tex:8, rendered p.7): "$E$ = 20260917044223-17ho (commit f45b231, same host, fresh fixture)". Archive E's `summary.json`/`run.json`/`report.md` all record `gitCommit: 2b569a7` (the state at run start); f45b231 is the *next* commit, which committed the run's trace logs and report ("p5 真引擎闭环过程日志…omp 闭环 62/0/0"). Both hashes exist, so this is not fabrication — but for R the paper cites the run-recorded commit (d6c824d), while for E it cites a post-run commit, an inconsistent convention in the one place a reviewer will spot-check. Fix: cite 2b569a7 as the run-recorded commit, or write "run recorded at 2b569a7; trace logs finalized in f45b231".

**2. [MINOR] "whose tool calls the model itself chooses" (Sec. V-D, evaluation.tex:93) overstates the loop's autonomy.** The archived task assignment (`agent-loop-omp.log:10-15, 93-98`) prescribes, verbatim and under "严格按步骤执行" (strictly follow the steps): daq_query → dcw_control(**value=197.48**, hypothesis=…) → wait 3 s → daq_query → dcw_judge(keep) → include sentinel → complete_task. The model's genuine discretionary behavior is the 1-s-bucket re-query, the switch to 15 s buckets/narrower interval, and the evidence-cited rationale — and the paper rightly highlights exactly those. Suggest rewording to, e.g., "whose execution the model itself carries out (observation, re-query strategy, and verdict reasoning) under the platform's operating rules", so no reader infers the model chose the setpoint.

**3. [MINOR] Fig. 6 silently selects between two archived values for the same timestamp bucket, and its x-label stretches "task window".** At 12:43:45 the first read returned 199.32 and the post-write re-query returned 199.41 (log lines 199 vs 231 — the bucket was re-aggregated after the write). `fig7-agenttrace.py:33` plots 199.41 and drops 199.32, which slightly beautifies the curve (198.36 → 199.41 → 199.65 is monotone; 199.32 would not be). Both values are genuine; the selection is defensible (it is the series the judge cited) but undisclosed. Also, the x-label "task window 12:42:15–12:44:30" is actually the plotted *data* window: the agent task started 12:43:09 (wall 132.344 s), so the 12:42:15–12:43:00 ramp samples predate the agent's start (they were acquired by the earlier pipeline phases and read by the agent in its first query). Fix: one caption clause, e.g., "at 12:43:45 the pre-write read and post-write re-query returned 199.32/199.41; the post-write value is plotted" and relabel "data window".

**4. [MINOR] PLC/ablation REPRODUCIBLE verdicts span harness revisions; drift disclosed only in machine files.** `compare-20260917045341-…plc….md` notes harnessHash d4946c11 (baseline) vs d55894c1 (fresh) and gitCommit d6c824d vs 2b569a7; configHash is identical. The paper's claim "compare REPRODUCIBLE against the frozen baseline with non-empty per-check tables" is literally accurate and the judge-contract comparison is meaningful, but for symmetry with the integrated-comparator caveat the sentence could add "across a harness update (hash drift recorded in the comparator files)".

**5. [MINOR, cosmetic] Figure file names do not match figure numbers** (fig5-closedloop = Fig. 5, fig7-agenttrace = Fig. 6, fig6-ablation = Fig. 7). No reader-facing impact; risk of future cross-referencing errors only.

## Recommendation

**MINOR REVISION.** Every quantitative claim I traced — including all five mandated checks — is supported by the archived evidence, and the two previously contested claims (24/24 correction; campaign scores N/A) are now stated correctly with their corrections disclosed. The remaining issues are wording/provenance hygiene, none of which undermines a result.

**Top-3 improvements:**
1. Fix the archive-E commit attribution (Finding 1): cite the run-recorded commit 2b569a7, or state explicitly the run-start/finalization relationship — this is the paper's own provenance standard applied to itself.
2. Tighten the real-LLM loop sentence (Finding 2) so the scripted task frame (fixed steps, fixed 197.48 °C target, sentinel grading) is as visible in the main text as the oracle-sentinel disclosure, leaving the model's discretionary re-query/verdict behavior as the claimed capability.
3. Add the one-line Fig. 6 disclosure for the 12:43:45 bucket selection and relabel the x-axis window (Finding 3).
