# DA Re-Verification — Round 2 (claim-retreat audit)

**Seat:** DA (Devil's Advocate), re-reviewing my own Round-1 findings after revision.
**Adjudication under test:** both DA CRITICALs ruled "validated — claim retreat path" (EDITORIAL-DECISION.md, "DA CRITICAL 裁决"): the authors withdraw/downgrade claims rather than run new measurements.
**Method:** full read of `main.pdf` (pdftotext, 11 pp.) cross-checked line-by-line against `sections/*.tex` (`introduction/system/mechanisms/evaluation/discussion/related`) and `main.tex` (title/abstract). Every verdict below quotes the revised text.

---

## C1 — CRITICAL (trust boundary vs. enforceability claim): **RESOLVED-BY-RETREAT**

All four retreat elements ordered by the editor are present and mutually consistent:

1. **Abstract/Intro downgraded.** The unqualified "enforceable rather than merely declared" is gone. Sec. I now reads:
   > "Because the agent runtime and the node drivers share one process, this contract is **enforced on the platform-exposed write path** rather than merely declared (**the containment boundary around the harness engines themselves is a deployment property**; Sec. IV-G)."

   The abstract makes no enforceability claim at all — only "the accepted-action language is constrained by construction," which is the correct, scoped statement (pipeline property, not engine containment).
2. **IV-G states no injection drill / privilege audit was run**, verbatim:
   > "so **engine containment is a *deployment* property, not a measured guarantee**: the deployment model combines an availability allow-list probe (Sec. IV-B), a least-privilege service account, and IEC 62443 zoning with OT-security guidance [31], [44], [45] to keep the governed surface the only *reachable* write path, **and no injection drill or privilege audit appears in Sec. V**."

   Plus the interior scoping: "Inside the sanctioned path a prompt cannot *enlarge* an agent's authority; it can only abuse authority the operator already granted." IEC 62443-3-3 [44] and NIST SP 800-82 [45] cited as ordered.
3. **Plugin host honestly described** (Sec. IV-B):
   > "a hot-reloading plugin host that is **fault-isolated** (a failing plugin cannot crash the platform) **but not privilege-contained**—plugins run in-process and gain no plant I/O path by construction of the tool surface."
4. **No remaining full-containment claim at any load-bearing site.** P1 (Sec. III-A) now reads "Co-residency governs the platform-internal path but **does not contain the harness engines** … (containment is a deployment property; Sec. IV-G)." VI-A scopes the guarantee: "the by-construction guarantee **holds within the sanctioned path** of Sec. IV-G." Sec. V-C adds: "the invariants are defined over the pipeline, **not over any engine**."

**Residual (minor, not blocking):** Fig. 1 caption still says the governed bridge is "**the only path from agent intent to actuation**" — unqualified, and strictly contradicted by IV-G's own concession (a compromised harness engine *is* agent intent reaching actuation). One word fixes it ("the only *platform* path"). This is a caption, not a claim sentence; every prose claim site is downgraded.

---

## C2 — CRITICAL (closed self-authored evidence base): **RESOLVED-BY-RETREAT**

1. **"Live system" qualified everywhere it matters.** Sec. I: "This paper measures both costs on **a live software instance driving real protocol transports against seeded plant simulators**." Abstract ends: "**all measured layers are simulation-tier.**" The former "live" contradiction in V-I is gone (see item 4).
2. **Wilson interval removed from the abstract** (verified: abstract contains no interval). It survives only where the adjudication allowed: Fig. 4 caption keeps "Wilson 95% … with endpoints printed—**structural rather than statistical at n=6**," and V-C keeps the small-n note for 6/6.
3. **Attack provenance / coverage statement present in Sec. V.** V-D: "20/20 pooled, **a set-coverage statement over the seeded suite rather than an independence-based rate**"; V-C: "the harness audits the artifact of which it is part" (retained, now framed as "engineering discipline rather than validation evidence").
4. **The 29 is now derived in the body** (V-B): "These **nine** attacks, pooled with the **twenty** five-protocol attacks of Sec. V-D, **compose the abstract's 29/29**; the six mock-tier attacks of Sec. V-C are a separate in-process pool." — 9+20=29, no double counting; my m1 is closed.
5. **m2 incoherence fixed** (V-I): "we claim no transfer beyond **the measured layers (L1, L4)** without per-layer evidence" (was "L1–L3–L4"). Threats paragraph also now declares TEP/SWaT "designed but unmeasured" and "the four LLM campaigns share one seed and carry no cross-seed variance estimate."

**Residual (minor):** attack-set authorship is stated only implicitly ("seeded suite," simulation-tier admission, repo provenance in Sec. VII); the adjudication's "明确攻击集来源为作者自建" is realized in substance but there is no single sentence saying the 35 seeded writes were authored by the authors. A careful reader can assemble it; a skimming one might not.

---

## M1 — 97% circularity: **RESOLVED-BY-RETREAT**

- Abstract now attributes the headline to the controller: "recovers 96.2–97.3% of the offline grid optimum **under a fixed deterministic controller (no LLM in the loop**; quoted run: 97.0–97.2%…)". Publishing the cross-release range 96.2–97.3% alongside the quoted 97.0–97.2% also absorbs my precision critique (the headline no longer exceeds the measurement's spread).
- **Grid resolution reported** (V-F): "offline grid resolution **2.5 °C × 5 rpm × 2.5 m/min**, die gap fixed at 1.0 mm" — my alternative explanation #4 (coarse grid inflating W*) is now checkable.
- **Classical baseline still unmeasured and declared so**: V-A: "further baseline groups—general agent frameworks, human operators, **classical control**, cross-engine replication—are defined in AW-INDUSTRIALBENCH's released protocol and are **not measured here**"; VI-A/conclusion list the remaining baselines as defined-not-reported. Matches adjudication item F (new experiments → legacy).

---

## M2 — LLM negative over-generalized: **RESOLVED-BY-RETREAT**

- Abstract: "**four uncontrolled same-seed** LLM-agent-team campaigns closed the same loop over real transports with every write attributed, but reached only **0.35–0.76 (median 0.76)** of that optimum—a measured shortfall…". Contribution 4 carries the same qualifiers. The abstract now matches the Sec. V-H hedge ("existence proof rather than a controlled measurement").
- **Per-campaign archive pointer present** (V-H): "Per-campaign initial objective values and itemized failed checks are **preserved in the released campaign archive**; the 0.35 tail is **partly infrastructure** (the refused channel), not purely decision quality." — J₀ and the failed-check itemization are one archive lookup away; my alternative-explanation #2 (infrastructure vs. reasoning failure) is now acknowledged in the body.
- **The "39 acceptance checks" sentence is gone** (grep for "39" hits only "v0.7.39" and a plot coordinate) — the editor's "fix or delete" was resolved by deletion.
- V-I names the confound: "the four reported campaigns **predate** that discipline (temperature-0/pinning) …—**one of their confounds**; no nonparametric comparisons are reported, and the latency-equivalence claim in Sec. V-G rests on overlapping ranges." The unfulfilled statistical promises are retracted, exactly as ordered.
- Median 0.76 vs. 0.755: adjudicated correct from unrounded values (0.7564), not adopted — I accept.

---

## M3 — "Agent closed-loop control" framing: **RESOLVED-BY-RETREAT**

- Title is now "…LLM Multi-Agent **Governed Closed-Loop Optimization** of Heterogeneous Industrial Production Lines" (running head likewise "Governed Industrial Optimization").
- Abstract and contribution 4 attribute the 97% to the fixed deterministic controller, never to agents; the abstract additionally defines the loop: "Throughout, *closed loop* means the **supervisory optimization loop**—setpoint-level decisions at a seconds-to-minutes cadence; **regulatory control remains in the PLCs**."
- Sec. IV-E keeps the name "Agent Closed-Loop Control" — per the adjudication this is acceptable: the section describes the mechanism (record, propose, govern, judge, learn) that the agent team drives, and its benchmark text says plainly "it contains no LLM, so the benchmark isolates the governed loop rather than a model."

---

## M4 — Protocol overreach: **PARTLY**

Delivered:
- **Coverage statement present in V-A**, in the adjudicated measured/drill/acceptance-level/unmeasured tiers: "Coverage as measured below: **F5 and the I1/I2 probes are fully measured; F2 (process freeze) and F3 (link interruption) appear as drills; F1, F4, F6 and the escalation-at-K branch are exercised only at acceptance-test level or unmeasured**; T1/T2 are measured directly." The spurious-rollback rate was deleted from the promised-metrics list rather than left unreported.

Not fully delivered:
1. **"Unreported metric families declared as such" is incomplete.** V-A says cost/quality metrics (task goal rate, tokens/LLM calls per task, approval wait time, interventions per task) are "declared here, **reported only where Sec. V-H notes campaign costs**" — but V-H notes **no** campaign costs (no token/call/approval-wait numbers anywhere). The escape hatch never fires, and token/cost is not in VI-A's legacy list either. Editorial item 12 asked for these to be declared legacy explicitly; instead there is a pointer that silently resolves to nothing.
2. **F6 fail-safe claim not softened.** IV-G still asserts, unqualified: "**Governance is fail-safe under storage degradation (F6).**" It is *covered* only indirectly, two pages later, by the V-A coverage statement naming F6 acceptance-test-level/unmeasured. The adjudication allowed "softened **or** covered," so this passes on a technicality — but the sentence itself remains a design claim about a fault family the paper declares unmeasured, in the same paragraph that concedes "no injection drill or privilege audit appears in Sec. V." Softening ("is designed to be fail-safe…, unmeasured") would have been cleaner.
3. **T3/T4/T5 are left in silence** — the coverage statement covers only "T1/T2 measured directly"; the other three task families are neither measured nor declared unmeasured.
4. **F2 naming wobble**: the fault list defines "F2 *sensor* freeze," but the drill (V-D/V-E) and the coverage statement call it "process freeze." Honest labeling of what was drilled, but it means F2-as-specified (sensor freeze, exercising the semantic card's freshness field) is unmeasured without ever being declared so — the exact move M4 originally flagged, now half-visible.

---

## M5 — Guardrail scope / "oscillatory overwrites are impossible": **RESOLVED-BY-RETREAT**

The impossible-claim is retracted exactly along the adjudicated wording (IV-C stage 2):
> "**Same-direction ratcheting is therefore prevented; alternating corrections remain allowed and are bounded only by the window, the step rule, and the backstop. Cross-agent in-window oscillation (two agents on one node) is out of the guardrails' scope** and listed as a limitation (Sec. VI-A)."

This is precisely the by-evidence restatement I asked for; the adversarial/multi-agent campaign goes to legacy per decision item F.

**Residual (minor):** the cross-reference dangles — VI-A (discussion.tex) contains **no** mention of cross-agent oscillation (closest is "agent re-proposal backoff," a different mechanism). See New Issues.

---

## M6 — Integration cost: **RESOLVED-BY-RETREAT**

VI-A scopes it verbatim as ordered:
> "The integration-cost claim is correspondingly scoped: **the 16 s result measures recommissioning once a scenario definition exists; authoring one—including the expert-validated recipe windows—is engineer effort we do not price, and a mis-authored window is itself a configuration hazard.**"

Both halves of my critique (16 s is not integration effort; scenario authoring is the hidden project) are conceded, and the mis-authored-window hazard is a genuine addition. (Token/cost half of "cost" remains unreported — tracked under M4.1.)

---

## Dissolved suspicions — consistency preserved (not "fixed" into breakage)

- **Twelve-anchor arithmetic (Round-1 Obs. 1):** V-G still reads "twelve out-of-window anchors per bypass arm per run: six breach writes plus six accepted edge probes" — unchanged, and still arithmetically correct (2 window-class attacks × 3 reps + 2 boundary probes × 3 reps). Untouched, as it should be.
- **Fig. 3 J_end (Round-1 Obs. 2):** body keeps "$J_{\text{end}}$ is the mean of the two consecutive in-band evaluations" and the caption keeps "The quoted ratios are the $J_{\text{end}}$ means of both evaluations over $W^*$" (roadmap item 23 explicitly preserved this). Per-seed values (68.07→87.26 etc.) unchanged and consistent with the definition. The iteration-1-vs-2 decline I flagged under M1 remains visible in Fig. 3, now cushioned by the 96.2–97.3% range in the abstract.

---

## NEW issues introduced by the revision (none restore a withdrawn claim)

**N1 (minor, editorial). Systematic dangling "Sec. VI-A" pointers.** Three revised sentences tell the reader a limitation "is listed" in VI-A, but discussion.tex's VI-A was not expanded to receive any of them:
   (a) mechanisms.tex (IV-C): "Cross-agent in-window oscillation … **listed as a limitation (Sec. VI-A)**" — VI-A never mentions oscillation or cross-agent effects;
   (b) evaluation.tex (V-A coverage): "F1, F4, F6 and the escalation-at-K branch are exercised only at acceptance-test level or unmeasured **(Sec. VI-A)**" — VI-A contains no F-family enumeration;
   (c) mechanisms.tex (IV-C stage 4): "whether no-readback actuators may take *auto* bindings at all is deployment policy … **we return to this as a limitation (Sec. VI-A)**" — VI-A says nothing about blind actuators or binding policy.
   The honest content lives in the pointing sentences themselves; the destinations are empty. Mechanical fix: add three clauses to VI-A (or repoint). Until then the paper asserts "listed as a limitation" three times where nothing is listed.

**N2 (minor).** The V-A cost-metrics pointer "reported only where Sec. V-H notes campaign costs" never fires (V-H reports none) — technically not false, but it reads as if costs appear somewhere. Covered under M4.1.

**N3 (nit).** Conclusion still says "four LLM-agent campaigns … reaching a median 0.76 of the optimum (propose/dispose in action)" without the "uncontrolled same-seed" qualifier that the abstract and contribution 4 now carry. The load-bearing site (abstract) is fixed; this is a tail echo.

---

## Final verdict: **CRITICALS-CLOSED**

Both CRITICAL findings were adjudicated to the claim-retreat path, and the retreat actually happened, in the ordered wording, at every site a reader would use: the enforceability claim is now scoped to the platform-exposed write path with the engine boundary, plugin isolation, and unmeasured compensating controls stated in plain text (C1); the evidence base is now announced as a live *software* instance against seeded simulators with set-coverage framing, the 29 derived as 9+20, and Wilson out of the abstract (C2). The five MAJOR retreats (M1, M2, M3, M5, M6) are likewise executed; M4 is PARTLY (coverage statement delivered; metric-family declaration and F6 softening incomplete). The revision introduced no new overclaim — its defects are three dangling limitation pointers and one caption ("the only path from agent intent to actuation") that should be tightened in proof. I accept the retreat as honest; nothing remains that blocks acceptance. Residuals N1–N3 and the C1 caption are copyedit-level and should be required at proof stage, not as a new review round.
