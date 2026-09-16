# Review — Round 1, Seat R1 (Methodology Reviewer)

**Manuscript:** *AgentWorkShop: A Node-Native Integration Framework for LLM Multi-Agent Closed-Loop Control of Heterogeneous Industrial Production Lines*
**Venue:** IEEE Transactions on Industrial Informatics
**Review scope:** research design rigor, evaluation methodology, statistical validity, reproducibility, internal consistency of reported numbers. Read-only review; all Wilson intervals and ratio arithmetic below were independently recomputed.

---

## 1. Mental-Model Reconstruction (comprehension test)

The paper evaluates a Node.js integration framework (v0.7.39) that puts an LLM multi-agent half and a five-protocol industrial half in one process, joined by a governed write path (Algorithm 1: stage-0 approval → availability → per-agent record guardrail → soft interlock (Eq. 1: hard range ∩ recipe window when a run is active) → write-with-readback under tolerance τ(n) (Eq. 2) → journal/audit), plus a backstop that rolls a node back after B=3 out-of-window samples, at most K=2 times per node. The evaluation protocol (Sec. V-A) rests on three pillars: (i) *layered realism* (Table I: L1 seeded simulation and L4 digital-twin closed-loop are measured; L2 TEP/SWaT replay and L3 physical device are designed-only); (ii) *seed determinism* — a mulberry32 PRNG (seed 42 almost everywhere; three plant seeds 42/43/44 for the closed-loop benchmark) makes "judge-class" metrics (interception verdicts, boundary probes, ledger contents) point-wise reproducible, while "environment-class" quantities (latency, J computed from sampled process variables) are expected to vary; (iii) an executable pipeline with a frozen-baseline comparison gate (bench/compare.mjs). Five experiments: (V-B) portability — re-instantiate the deployment on a second scenario via configuration only (9 seeded attacks, 3 legal writes, ~16 s); (V-C) static audit (20 constant anchors, 2 ordering chains) plus live-instance invariant probing on mock drivers (6 attacks, 3 legal writes, boundary probes); (V-D) the same working conditions re-run over real protocol stacks against an independent PLC node simulator (5 attacks × 4 writable protocols, latency per Table II); (V-F/V-G) closed-loop optimization on a cast-film twin with a fixed, pre-declared controller over 3 seeds (J vs offline grid optimum W⋆=89.894), and a four-arm governance ablation (full / no-interlock / no-readback / ungated) on mock drivers; (V-H) four LLM-agent campaigns on the same plant (manual bindings, scripted operator, 6× physics acceleration, seed 42) reporting J_agent and write-ledger attribution. The agent's loop is exercised as observe (daq_query) → propose (dcw_control opens a record) → govern (pipeline) → actuate → verify/judge (dcw_judge, no actuation) → learn, measured by interception, false blocks, attribution, latency, and J-recovery.

**Comprehension breakdown points (where I could not fully reconstruct the design):**
- The **29** of the abstract is never derived in the paper; it equals 20 (V-D) + 9 (V-B) only via V-I's parenthetical "(9/9 on the second)". The 6 mock-tier attacks of V-C/V-G are silently excluded by "across both scenarios".
- "Of 39 acceptance checks **per campaign**, 33–35 passed" (V-H) is not reconstructable: 39 equals the *total* writes across the four campaigns (7+7+15+10), and the unit of the 33–35 range is undefined.
- What the **55/55 pipeline checks** are, and which three released runs feed Fig. 4, is not stated in the paper.
- The hardware/OS environment for all latency figures is absent from the paper (a host macro `\resHost` — Ryzen 7 9700X, 31 GB, Windows — is defined in `results-macros.tex` but never used).
- How J_agent is computed for the fourth campaign, whose thickness channel "produced no in-window samples", is unspecified (J weights thickness at 55/95).

---

## 2. Methodological Strengths

1. **Judge-class vs environment-class separation** is explicit (V-A), motivated (sampled process variables are timing-sensitive), and consistently applied in every section's reproducibility paragraph (V-C, V-G, V-I). This is exactly the right abstraction and is rarely done this cleanly.
2. **All Wilson intervals are numerically correct** (independently verified): 29/29 → [88.30, 100] (paper [88, 100]); 20/20 → [83.89, 100] ([84, 100]); 6/6 → [60.97, 100] ([61, 100]); 4/6 → [30.00, 90.32] ([30, 90]); 9/9 → [70.09, 100] ([70, 100]). Rounding is outward (conservative) at the lower endpoints.
3. **The LLM negative result is framed without cherry-picking**: the abstract, intro, V-H, discussion, and conclusion all repeat the shortfall; the median (0.76) is actually the *higher* statistic (mean = 0.66), i.e., the conservative choice for a negative claim; campaign-level J values (67.7, 31.2, 68.3, 68.5) are printed, and the protocol deviations (no temperature-0, model not pinned, 6× acceleration, scripted operator) are disclosed at the point of use (V-H).
4. **Baseline honesty is consistent everywhere**: B2+ (general agent frameworks, human operators, classical control, cross-engine replication) are declared "defined in the released protocol and *not measured*" identically in V-A, Related Work, VI-A, and the Conclusion. No external comparison is implied anywhere.
5. **Closed-loop benchmark arithmetic is fully self-consistent**: J_end values recompute exactly from the Fig. 3 coordinates ((87.55+86.97)/2 = 87.26 etc.); ratios 0.971/0.970/0.972 recompute to 0.9707/0.9696/0.9720; J₀ range 64.7–70.2 and J_end range 87.2–87.4 match the per-seed values; weights 55+25+8+7 = 95 match the "0–95 scale"; W⋆=89.894 is identical in five places; the median 0.7564 → 0.76 is correct.
6. **Provenance discipline**: seed, harness source hash (204fc9ee), commit, never-overwritten timestamped run directories, frozen baseline with a tamper-rejecting gate plus self-test, and a repo-level macro file mapping every printed number to a run ID (`results-macros.tex`; 94 run directories).
7. **Circularity of the static audit is acknowledged by the authors themselves** ("the harness audits the artifact of which it is part" — V-C), and the layer table honestly marks two of four layers as designed-only.

---

## 3. Major Issues

**M1. The headline LLM comparison (0.76 vs 0.97) is confounded, and the paper repeats it as if it were a controlled contrast.**
*Where:* V-H vs V-F; abstract; Intro contribution 4; VI ("0.76 vs. 0.97 of W⋆"); Conclusion.
*Why:* The four campaigns differ from the 0.97 controller benchmark in at least five respects beyond "LLM in the loop": physics accelerated 6× (vs real-time in V-F), manual-mode bindings with a *scripted operator emulation*, sampling settings that predate the temperature-0/model-pinning discipline (V-H admits this), one campaign with a dead MQTT thickness channel, and a melt-pressure node that failed its connection test in all four. A 6× faster plant systematically disadvantages a high-latency LLM decision loop; the shortfall therefore cannot be attributed to model capability alone. The "existence proof" hedge exists, but the abstract/intro/discussion/conclusion all quote the 0.76-vs-0.97 juxtaposition unhedged.
*Fix:* Either re-run the campaigns under the released protocol (temperature-0, pinned model snapshot, matched physics time-scaling, ≥3 plant seeds) or restate every occurrence as "under an uncontrolled early-access configuration" and drop the direct numeric juxtaposition from the abstract.

**M2. The threats-to-validity section claims mitigations that are not in evidence.**
*Where:* V-I vs V-H and V-A.
*Why:* (a) "Internal: temperature-0, pinned-version LLM arms..." — but V-H states the only measured LLM arms *predate* that discipline; the sentence describes mitigations that did not apply to the reported campaigns. (b) "hence mock-arm matrices with LLM spot-checks and nonparametric tests" — no LLM spot-check and no nonparametric test is reported anywhere in Sec. V; the only equivalence-style claim ("no arm adds latency resolvable at this tier", V-G) is made from overlapping ranges without any test. (c) Several metric families declared in V-A — readback-failure capture rate, spurious-rollback rate, task goal rate, tokens and LLM calls per task, approval wait time, human interventions per task — are **never reported** in any experiment, even though the introduction frames the paper's question as "what does it cost". Notably, no token/cost figures for the four LLM campaigns appear at all.
*Fix:* Report the declared metrics (token/call counts per campaign are already in the run records), actually run and report the nonparametric latency comparisons (or a TOST-style equivalence bound), and rewrite the internal-validity paragraph to describe what was done, not what the protocol aspires to.

**M3. The "39 acceptance checks" sentence (V-H) is internally inconsistent or seriously ambiguous.**
*Where:* V-H, last sentence.
*Why:* The write ledger records 7, 7, 15, 10 governed writes — summing to exactly 39 *across* the four campaigns. "Of 39 acceptance checks per campaign, 33–35 passed" therefore reads either as a wrong denominator (per campaign → 156 total) or as a coincidence-free sign that "per campaign" should be "across the four campaigns"; and the range "33–35" has no stated unit (per campaign? across campaigns? across runs?).
*Fix:* One precise sentence, e.g., "Across the four campaigns, 39 write-intent acceptance checks were issued (7/7/15/10); 33–35 passed per campaign" — or whichever reading is correct.

**M4. The abstract's "29 intercepted" is never reconciled with the reported per-experiment counts.**
*Where:* Abstract and Intro ("29 seeded out-of-window/range writes... [88%, 100%]") vs V-C (6 attacks + 2 boundary rejections), V-B (9), V-D (20), V-G (same 6 attacks).
*Why:* 29 = 20 + 9 is reconstructable only from V-I's "(9/9 on the second)". A reader summing the paper's own interception counts gets 6 + 9 + 20 = 35 (37 with boundary probes) and must infer that the mock-driver "benchmark line" of V-C/V-G is not one of the "two plant scenarios" and is silently excluded. The claim is *correct* but under-derived.
*Fix:* One sentence in V-D or V-I: "The 29 pooled attacks comprise the 20 five-protocol attacks (Sec. V-D) and the 9 film-line attacks (Sec. V-B); the 6 mock-tier attacks of Secs. V-C/V-G are reported separately."

**M5. Eq. (2) is dimensionally inconsistent with its use in Algorithm 1 unless the transform scale is 1.**
*Where:* Eq. (2), mechanisms.tex line 42; Algorithm 1 lines 24–26.
*Why:* t_n maps raw readings to engineering units (line 25: v_rb ← t_n(rb)), so |v_rb − v| in line 26 is in engineering units. The prose says τ is "the larger of half a least-count digit and 0.5% of span **in engineering units**" — both arguments of the max() are engineering quantities — yet Eq. (2) divides the max by |t_n^scale|, which converts it *out* of engineering units. For any |scale| ≠ 1 the acceptance tolerance is wrong by exactly |scale| (too loose or too tight depending on convention). All reported runs use an identity transform (τ = max(0.5·10⁻¹, 0.005·140) = 0.7 °C, matching V-C), so **no reported number is affected**, but the formula as formalized does not say what the prose says.
*Fix:* Either apply the 1/|scale| factor to the least-count term only (before converting to engineering units) or drop the factor and state τ in engineering units. Also: Algorithm 1's JournalAppend uses v_prev, which is never assigned in the pseudocode; and the unbound-node FORBIDDEN check is not one of the six enumerated execution stages — name its stage.

**M6. Independence behind the pooled Wilson intervals is not established.**
*Where:* Abstract, V-B, V-D, V-C, Fig. 4.
*Why:* All attacks traverse one code path (the soft interlock). The 20 (or 29) successes are not 20 (or 29) independent Bernoulli trials of "the governance works" — a single interlock defect fails all of them together; the effective n for the *mechanism* is closer to the number of distinct code paths/exercised branches (which the boundary probes and batch-stopped probe do cover). The authors partially concede this ("structural rather than statistical at n=6", Fig. 4), yet the abstract's "[88%, 100%]" invites a failure-probability reading.
*Fix:* Reframe the intervals as set-coverage statements over the seeded attack suite, or state the exchangeability assumption explicitly; keep the interval in Fig. 4 (where it is properly labeled) rather than the abstract.

**M7. Reproducibility is demonstrated on one machine, one OS, minutes apart — and the environment is not in the paper.**
*Where:* V-I (runs 20260914152838 and 20260914153400 are ~5.5 min apart); missing hardware/OS spec; Conclusion's "% TODO(submission): add the artifact DOI/URL".
*Why:* The "one command reproduces the section" claim currently supports determinism on a single host, not portability. The host spec exists in the repo (`results-macros.tex`: Ryzen 7 9700X, 31 GB, Windows) but the unused macro never made it into the manuscript, so the write-latency tables (Table II, Fig. 4) have no stated measurement environment. The artifact has no resolvable pointer (DOI/URL TODO), the 55/55 pipeline checks are never enumerated, and the number of completed releases underlying the "0.962–0.973 across released runs" span is unstated (five excluded runs are mentioned; the included count is not).
*Fix:* State host/OS in Sec. V; enumerate or reference the 55 checks; report the number of completed releases behind the 0.962–0.973 span; resolve the artifact pointer before camera-ready; ideally add one cross-machine reproduction.

---

## 4. Minor Issues

1. **Layer-labeling slip in threats (V-I):** "we claim no transfer beyond L1–L3–L4 without per-layer evidence" conflicts with Table I, where L3 (physical device) is *designed*, not measured, and with V-I's own "all measured layers are simulation-tier". Should be "beyond the measured layers (L1, L4)" — which is what VI-A says ("one plant domain at L1/L4").
2. **300 s is used for two distinct mechanisms** (supervision stall watchdog, IV-B; same-direction cooldown T_cd, IV-C) and both appear in the static-audit constant list — disambiguate in V-C.
3. **The worst campaign (J_agent = 31.2) has no failure analysis**; the other three campaigns are explained (55.33 µm attractor, dead channel), but why campaign 2 reached 0.35 is never discussed. Also "a 55.33 µm window mean" identical across three campaigns is suspicious enough to warrant one sentence.
4. **"No arm adds latency resolvable at this tier" (V-G)** is an equivalence claim supported only by overlapping ranges; with 9 repetitions per arm a sign/Mann–Whitney test (already promised in V-I) is cheap.
5. **V-B's nine attacks** are not decomposed per protocol (3 per writable protocol? unstated), unlike V-D's explicit 5-per-protocol.
6. **Step rule unverifiable in V-F:** the ±22 rpm/step limit cannot be checked against the "≤2% of span" rule because the rpm span is never given; likewise "six actuators" enumerates only four named groups (zones plural presumably covers three).
7. **Fig. 4 data provenance** (which three released runs are pooled; that they differ from the V-I reproducibility pair) is stated only in repo comments, not in the paper.
8. **Same interval, two populations:** V-F says J/J* spans 0.962–0.973 "across all completed releases"; V-I says the identical interval holds "across campaign repetitions". Pick one description.
9. **Fig. 4's [30, 90]** truncates the true upper endpoint (90.32%) inward, unlike all other intervals which round outward; print [30, 90.3] or round out to 91.
10. **External-validity wording (V-I):** "bounded by the ODE twin's fidelity" — the film-line scenario is a strategy-signal scenario with no physics engine; the fidelity bound differs per scenario.
11. **Seed-42 ubiquity:** every tier except the 3-seed closed-loop benchmark uses seed 42, so all attack sets derive from one PRNG stream; a second seed for the attack suites would strengthen the structural claim at negligible cost.
12. **Abstract phrasing:** "recovers 96.2–97.3% ... (quoted run: 97.0–97.2%)" is correctly labeled but easy to misread as one run's spread; consider "across released runs (quoted run: ...)".

---

## 5. Statistical / Consistency Findings Table

| # | Claim (location) | Cross-checked against | Recomputed value | Verdict |
|---|---|---|---|---|
| 1 | 29/29, Wilson 95% [88, 100] (Abstract, Intro) | 20/20 (V-D) + 9/9 (V-B); V-I "(9/9 on the second)" | [88.30, 100.00] | Interval **correct**; decomposition **never stated** (M4) |
| 2 | 20/20 [84, 100] (V-D, Table II) | 5/5 × 4 protocols | [83.89, 100.00] | **Consistent**, outward rounding |
| 3 | 6/6 [61, 100] (V-C, Fig. 4 Full/No-RB arms) | 6 seeded attacks: 2 window-class + 4 range-class | [60.97, 100.00] | **Consistent** |
| 4 | 4/6 [30, 90] (V-G, Fig. 4) | window-class execute, range-class structurally rejected | [30.00, 90.32] | **Consistent**; upper printed inward (Minor 9) |
| 5 | 9/9 probes [70, 100] (V-G) | 3 probes/rep × 3 reps per arm | [70.09, 100.00] | **Consistent** |
| 6 | 12 out-of-window anchors per bypass arm per run = 6 breach + 6 edge (V-G) | 2 executed attacks/rep × 3 reps; 2 accepted edge probes/rep × 3 reps | 6 + 6 | **Consistent** but per-rep decomposition implicit |
| 7 | 97.0–97.2% quoted; 96.2–97.3% across releases; run means 0.965–0.971 (Abstract, V-F, V-I, Conclusion) | per-seed 87.26/87.16/87.37 over W⋆=89.894 | 0.9707 / 0.9696 / 0.9720 | **Fully consistent**; J_end recompute from Fig. 3 coords exact |
| 8 | W⋆ = 89.894 (Intro, V-F, V-H, V-I, Fig. 3) | — | identical everywhere | **Consistent** |
| 9 | Median 0.76; ratios 0.75/0.35/0.76/0.76 (Abstract, Intro, V-H, VI, Conclusion) | J_agent 67.7/31.2/68.3/68.5 ÷ 89.894 | 0.7531/0.3471/0.7598/0.7620; median 0.7564 → 0.76 | **Consistent** (median is the conservative statistic) |
| 10 | Write ledger 7, 7, 15, 10 (V-H) vs "39 acceptance checks **per campaign**, 33–35 passed" | 7+7+15+10 = 39 | mismatch of unit | **Inconsistent/ambiguous — M3** |
| 11 | Threats: "temperature-0, pinned-version LLM arms" (V-I) | V-H: campaigns "predate the temperature-0/model-pinning discipline" | — | **Contradiction — M2** |
| 12 | Threats: "no transfer beyond L1–L3–L4" (V-I) | Table I: L2, L3 designed; L1, L4 measured | — | **Contradiction (Minor 1)** |
| 13 | K=2, B=3 (IV-E, IV-F, III-C walk, Fig. 1/2, V-E, VI-A, static audit) | — | identical everywhere | **Consistent** |
| 14 | Quota 64; 14 engines (12–14 available, disclosed); 48/23 host tools + 25-tool MCP subset (III, Fig. 1/2, V-E, static audit) | — | identical everywhere | **Consistent** |
| 15 | τ = 0.7 °C example (V-C) | Eq. (2): max(0.5·10⁻¹, 0.005·(260−120)), scale 1, span 140 | 0.7 | **Consistent at scale 1**; Eq. (2) dimensionally unsound otherwise (M5) |
| 16 | Backstop cadence 120–130 s observed (V-E) | T_re = 30 s, T_win = 120 s (IV-E) | detection window [120, 150] s | **Consistent** |
| 17 | Write p50 19–112 ms (V-D text) | Table II p50: 111.5/19.0/19.4/32.8 | 19.0–111.5 | **Consistent** (rounding) |
| 18 | "B2+ baselines not measured" (V-A, Related, VI-A, Conclusion) | — | identical disclosure in all four | **Consistent** |
| 19 | Declared metrics: readback-failure capture, spurious rollback, task goal rate, tokens/calls, approval wait, interventions (V-A) | Secs. V-B–V-H results | none reported | **Gap — M2** |
| 20 | Host/OS environment for all latency numbers | `\resHost` macro (defined, unused) | absent from PDF | **Gap — M7** |

---

## 6. Recommendation

**Major Revision.**

**Rationale.** This is one of the more methodologically honest submissions I have reviewed in this space: the judge-class/environment-class metric split is principled and consistently applied, every Wilson interval that is printed is numerically correct (I recomputed all five), the closed-loop arithmetic survives full reconstruction from the figure coordinates, the negative LLM result is reported against the authors' own system with its protocol deviations disclosed, the unmeasured baselines are disclosed identically in four places, and the layer table honestly separates measured from designed. The core L1-tier safety results (interception, false blocks, attribution, boundary probes) are internally consistent and, given their structural nature, credible.

However, revision is required on substance, not polish: (1) the headline 0.76-vs-0.97 comparison is confounded by acceleration, bindings, operator emulation, and sampling discipline, and must either be re-measured under the released protocol or systematically downgraded in abstract/intro/discussion (M1); (2) the threats section asserts mitigations — temperature-0 arms, LLM spot-checks, nonparametric tests — that demonstrably did not occur, and declares six metric families that are never reported, including the token/cost numbers the introduction promises (M2); (3) the "39 acceptance checks per campaign" sentence is arithmetically untenable as written (M3); (4) the abstract's 29 is under-derived (M4); (5) Eq. (2) is dimensionally wrong for any non-identity transform (M5); (6) the pooled intervals need an independence caveat (M6); and (7) the reproducibility claims need the measurement environment, an artifact pointer, and an enumerated check list in the manuscript itself (M7). None of these require new theory; items M1–M2 require either new measurements or genuine reframing of the claims, which is why this is a Major rather than Minor revision. I would expect a strongly improved resubmission, and I am willing to review it.
