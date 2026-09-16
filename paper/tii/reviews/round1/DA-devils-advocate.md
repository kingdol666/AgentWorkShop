# Review — Seat DA (Devil's Advocate)

**Manuscript:** *AgentWorkShop: A Node-Native Integration Framework for LLM Multi-Agent Closed-Loop Control of Heterogeneous Industrial Production* (submitted to IEEE TII)
**Reviewer seat:** DA — constructs the strongest honest case against the paper. All attacks are evidence-anchored; suspicions that dissolved on closer reading are explicitly flagged as such (Section 6).
**Read:** `main.pdf` (11 pp.) cross-checked against `sections/*.tex`.

---

## 1. Mental-Model Reconstruction

*(Established before critique — a DA who misreads the paper is worthless.)*

This reviewer's reading. **(a) End-to-end design:** AgentWorkShop v0.7.39 is one Node.js process joining an *agent half* (14 interchangeable LLM harness engines, lead-supervised channels, hybrid episodic–semantic memory) to an *industrial half* (five protocol drivers — Modbus TCP/RTU, OPC UA, MQTT, HTTP/REST — per-node edge acquisition, alarm chain, versioned recipes) across a *governed bridge*, over one data domain (SQLite/TimescaleDB/MinIO, signed audit journal, render-only digital twin). Commissioning is configuration: driver configs derive from device integration exports; a named plant scenario re-instantiates the deployment. **(b) Modules:** semantic cards replace register addresses (unit, hard range, recipe window, freshness); channels scope team authority; the governed write path (Algorithm 1) chains availability gate → per-agent serialization (one open record, 30-min staleness, 300-s same-direction cooldown) → batch-scoped recipe-window interlock over the hard range (Eq. 1) → readback-verified write (Eq. 2) → signed journal anchor; `dcw_judge` judges without actuating; a backstop auto-rolls back after B=3 out-of-window samples, capped at K=2 per node lifetime, then escalates to a human; binding modes (manual/auto/unbound) fix the human boundary. **(c) Agent closed loop:** observe (`daq_query`) → propose (`dcw_control`; opens optimization record, freezes baseline, ≤2%-of-span step rule) → govern → actuate → verify–judge → learn; bounded by the guardrails, interlock containment, and K=2. In the 97% benchmark the LLM is bypassed: a fixed two-step controller drives the same governed path on the ODE cast-film twin against the authors' grid optimum W\*=89.894; four LLM campaigns reach a median 0.76.

---

## 2. Strongest Counter-Argument

The paper's central claim — that co-residency makes its governance *"enforceable rather than merely declared"* (Sec. I) — is evaluated inside a closed evidential loop: the same authors designed the platform, both plant simulators, every seeded attack, the objective and its grid optimum, and the audit harness that *"audits the artifact of which it is part"* (Sec. V-C). The 29/29 interception headline therefore demonstrates that an interlock rejects values outside a window its own authors wrote — a result that could not fail and that transfers to none of the adversaries the paper's own threat model names. That threat model is the deeper problem: Sec. IV-G concedes harness engines *"could write to the protocol stacks directly,"* so the enforced contract excludes exactly the component that indirect prompt injection compromises; the compensating deployment assertions (least-privilege service account, IEC 62443 zoning, *"the only reachable write path"*) are never measured, and the one-process architecture abandons precisely the agent-tier zoning that would contain them. The second headline, 97% of the optimum, is similarly self-referential: an author-designed controller, on an author-weighted objective, against an author-computed grid bound, with no classical baseline measured, and the residual shortfall explained away as an objective-corner preference. The only agent-tier evidence — four campaigns, one engine, one model, one plant seed, unpinned sampling, 6× accelerated physics — is an uncontrolled negative that the abstract nonetheless headlines (median 0.76). For TII's industrial readership, the paper measures an artifact's self-consistency — not safety, control quality, or integration cost on any plant, attack, or agent its authors did not build.

*(≈245 words)*

---

## 3. Issue List

Severity legend: **CRITICAL** = undermines a central claim as stated; **MAJOR** = claim–evidence gap requiring new experiments or retraction of a specific claim; **MINOR** = precision, consistency, presentation.

---

### C1 — CRITICAL | Safety claim / trust model
**Anchor:** Sec. IV-G: *"Harness engines are privileged local processes—a compromised engine could write to the protocol stacks directly, the failure mode that indirect prompt injection targets—so the deployment model combines an availability allow-list probe …, a least-privilege service account, and IEC 62443 zoning … to keep the governed surface the only reachable write path, trading zoning isolation for in-process enforceability within one zone."* Together with Sec. I: *"Because the agent runtime and the node drivers share one process, this contract is enforceable rather than merely declared."* And Sec. III-A (P1): *"Co-residency governs the platform-internal path but does not contain the harness engines."*

**Why it matters:** The paper's answer to "what safety does the resulting governance buy?" (Sec. I) is an enforced contract — but the contract binds only tool calls flowing through the platform process. The component the paper's own threat model targets (the harness engine, via indirect prompt injection) sits **outside** the enforced boundary by the paper's own admission. Everything that would make the governed surface "the only reachable write path" — service-account privileges, allow-list contents, 62443 zones — is a deployment assertion with **zero supporting measurement**: no privilege audit, no injection drill, no zone-reachability test appears in Sec. V. Worse, the architecture is self-undermining: P1 (one process, one data domain) is celebrated as the source of enforceability, yet it is exactly what destroys the classical 62443 separation between the agent/IT tier and the control tier — the paper even names the trade ("trading zoning isolation for in-process enforceability") without analyzing its cost. Co-residency demonstrably buys *atomicity* (check-then-actuate in one event-loop turn) and *observability*; what the abstract and Sec. I sell is *containment*, which the paper later concedes it does not provide. The plugin host compounds this: it runs in the same process, and "plugins … never gain a direct plant I/O path" (Sec. IV-B) is stated as convention — no sandbox mechanism is named.

**What would resolve it:** (i) Reword the abstract/Sec. I claim to "the only *platform-exposed* write path"; (ii) add a measured threat exercise: a prompt-injection drill against a real harness, a host-level privilege audit of the engines' service account, and an explicit statement of which 62443 zones exist and what they do not separate; (iii) state the plugin-isolation mechanism (subprocess? `vm`? none?) and its guarantees.

---

### C2 — CRITICAL | External validity / evidence base
**Anchor:** Table I: measured layers are L1 (*"Seeded simulation: two independently defined plant scenarios"* — authored in the same artifact) and L4; L2 (*"TEP / SWaT replay through real drivers"*) and L3 (*"One physical OPC UA/Modbus device"*) are both **designed**, not measured. Sec. V-C: *"the harness audits the artifact of which it is part."* Sec. I: *"This paper measures both costs on a live system."* Abstract: *"29 seeded out-of-window/range writes are intercepted (Wilson 95% [88%, 100%])."* The PLC node simulator is a *"git submodule … versioned in the project repository"* (Sec. VII).

**Why it matters:** Every measured quantity in the paper is produced by one team inside one artifact: platform, both plant scenarios, the attack set (6 + 9 + 20 seeded writes), the success oracle (W\*), the driver simulators, and the auditing harness. "Independently defined" (abstract) means independently *of each other*, not independently of the authors — both scenarios ship in the same repository as the defense they test. The 29/29 interception result is therefore structurally guaranteed: the attack generator and the validator share the same window definitions, and the values (107, 269, 219, 163, 10⁶, −25) are gross violations that no implementation of Eq. (1) could accept. No fuzzing, no mutation, no adversarially chosen values, no third-party scenario or device was tried. The one genuinely external resource — a physical device (L3) — is precisely the layer left unmeasured, as is the public-dataset replay (L2). For a journal whose bar is industrial evidence, the gap between "live system" (Sec. I) and "two seeded simulators written by us" is the paper's largest honesty-of-framing problem — the threats paragraph admits it (*"all measured layers are simulation-tier"*, Sec. V-I), but the abstract's Wilson interval and the word "live" do not carry that admission.

**What would resolve it:** Measure L3 (even one physical device, as already designed) and L2 (TEP/SWaT replay); invite at least one third-party scenario or attack set; report attack provenance (who authored the 35 seeded writes) explicitly.

---

### M1 — MAJOR | Circularity of the 97% headline
**Anchor:** Sec. V-F: controller *"inverts h∝N/v at constant line speed (N←N·(50/h), ±22 rpm per step) … it contains no LLM"*; objective weights *"J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput"*; *"the offline grid-search optimum W\* = 89.894 is the reference bound"* (Sec. V-A); *"The 3–4% shortfall is a throughput/energy trade, not a control failure: the grid optimum sits at a low-throughput corner of the objective."* Sec. V-A baseline note: *"further baseline groups—general agent frameworks, human operators, classical control, cross-engine replication—are defined … and are not measured here."*

**Why it matters:** Every term of the ratio J/J\* is an author artifact: the plant (their ODE twin), the objective (their weights), the controller (their two-step heuristic), and the optimum (their grid search, **grid resolution unreported**). A coarse grid would underestimate W\* and inflate the recovery fraction. There is no comparator at all — no PID/MPC, no human, no un-governed loop measured on J — so "97% of optimum" is unfalsifiable as a control-quality claim: what would falsify it? A tuned classical controller exceeding it, or a finer grid, either of which is absent. The shortfall explanation concedes an objective/controller mismatch: the controller simply declines to pursue the objective's optimum corner, so 97% is a *choice*, not a bound. Two further softeners the paper does not flag: (i) iteration-2 J is *lower* than iteration-1 J on all three seeds (Fig. 3: 87.55→86.97, 87.39→86.92, 87.86→86.87); the headline depends on the settling definition (mean of both in-band evaluations) — iteration-1 values would give ≈97.4–97.7%; (ii) the cross-release spread J/J\* ∈ [0.962, 0.973] (±1%) is attributed to sampling noise of the evaluation itself, i.e., the headline's precision exceeds the measurement's.

**What would resolve it:** Report grid resolution and optimum sensitivity; measure at least one classical baseline on the same plant/objective through the same governed path; state the settling-definition sensitivity (iteration-1 vs. J_end ratios).

---

### M2 — MAJOR | LLM negative result over-generalized and under-reported
**Anchor:** Sec. V-H: *"Four campaigns are released (first-party omp engine driving glm-5.3-flash …; manual-mode bindings; physics accelerated 6×; seed 42 …). Their sampling settings predate the temperature-0/model-pinning discipline …, one reason we report them as an existence proof rather than a controlled measurement."* Results: J_agent = 67.7, 31.2, 68.3, 68.5 → *"0.75, 0.35, 0.76, 0.76 … median 0.76"*; *"Of 39 acceptance checks per campaign, 33–35 passed."* Abstract: *"reached only a median 0.76 of that optimum—a measured shortfall that motivates the framework's propose/dispose design."*

**Why it matters:** This is the paper's **only** agent-tier evidence, and it is n=4 runs of one engine (omp), one model, one plant seed, unknown (harness-default) sampling, on a 6× time-accelerated plant — while the deterministic comparator (Sec. V-F) ran under real-time physics. The initial objective J₀ per campaign is never reported, so the reader cannot distinguish "agent improved poorly" from "agent made the plant worse": the deterministic runs start at J₀ = 64.7–70.2 (0.72–0.78 of W\*), and campaign 2 ends at 0.35 — did it degrade the plant, or start from a broken state (campaign 4's MQTT thickness channel "refused connection"; the melt-pressure node "failed its connection test on OPC UA in all four")? The 4–6 failed acceptance checks per campaign are never itemized. What *varies* across the four campaigns is never stated — if they differ only by LLM stochasticity, the 0.35–0.76 spread is itself the variance estimate and should be presented as such. The paper hedges all of this in Sec. V-H and V-I (*"a measured negative, not a headline"*), yet the abstract, introduction contribution 4, and conclusion all headline the median — you cannot disclaim the number in Sec. V-H while building the architectural motivation (propose/dispose) on it in the abstract. Also: median of {0.35, 0.75, 0.76, 0.76} is 0.755, reported as 0.76.

**What would resolve it:** Report per-campaign J₀, the itemized failed checks, and what differs among campaigns; re-run under the released discipline (temperature-0, pinned model, real-time physics) or at minimum add cross-seed campaigns; soften the abstract to match the Sec. V-H hedge; correct or justify the median rounding.

---

### M3 — MAJOR | "Agent closed-loop control" is, in the measured headline, agent-free
**Anchor:** Sec. IV-E title: *"Agent Closed-Loop Control"*; Sec. V-F: the 97% loop *"contains no LLM, so the benchmark isolates the governed loop rather than a model"*; Sec. V-D: *"the deterministic tool-level control loop (daq_query→dcw_control→dcw_judge) converges on all four lines."* Paper title: *"…LLM Multi-Agent Closed-Loop Control…"*; Fig. 2's "AgentLoop."

**Why it matters:** The paper's strongest quantitative result (97.0–97.2% of optimum, V-F) and its loop-convergence evidence (V-D) are produced by a hand-coded controller/scripted tool loop through governed endpoints. The LLM's measured contribution to closed-loop *control* is the 0.76 negative. The framing — title, Sec. IV-E's name, Fig. 2's agent-centric "AgentLoop," and abstract phrases like *"an agent team's decision become a governed write"* — systematically blurs a mock-tier/deterministic plumbing result with agent-tier capability. To a skimming reader, "agent closed-loop control reaches 97% of optimum" is the take-away; the accurate statement is "a pipeline with an interlock passes traffic from any client, including a trivial script, and a script reaches 97%." The paper is internally honest about this (V-F says so explicitly) but the packaging is not.

**What would resolve it:** Rename/reframe the deterministic benchmark as a *loop-plumbing* benchmark in abstract and title-adjacent claims; reserve "agent closed-loop control" for the L4 case study; state in the abstract that the 97% figure involves no LLM.

---

### M4 — MAJOR | Benchmark protocol promises more than Sec. V measures
**Anchor:** Sec. V-A defines *"five task families—T1…T5"* and *"six fault families… F1 step drift, F2 sensor freeze, F3 communication interruption, F4 out-of-order injection, F5 out-of-window writes, F6 storage unavailability"*, and claims *"F2/F3 are exercised in Secs. V-C and V-D."* Sec. V-A metrics also define *"spurious-rollback rate"* and a whole cost/quality family (*"task goal rate, tokens and LLM calls per task, approval wait time, human interventions per task"*). Sec. IV-G: *"Governance is fail-safe under storage degradation (F6)."* Sec. VI-A: *"an engineering limit exercised only up to one in the drill"* (K=2); I3's evidence (Sec. IV-F): *"the escalation-at-K branch is exercised at acceptance-test level."*

**Why it matters:** F1 (step drift) is never mentioned again after the list; F4 (out-of-order) appears only as a design mechanism (watermark defense, Sec. IV-D), never as a measurement; F6 is asserted ("fail-safe") with no experiment; the V-D "process-freeze" drill freezes the *process*, not the *sensor*, so F2 as specified (sensor freeze; the semantic card's freshness field is never tested) is arguably unmeasured too. No result anywhere in Sec. V is indexed to T1–T5. Of the declared metric families, spurious-rollback rate, task goal rate, token/LLM-call counts, approval wait time, and interventions per task are **never reported** — despite the introduction's framing question being explicitly about cost. The escalation-at-K branch — the mechanism that prevents runaway rollback — is exercised only at acceptance-test level, and K itself only to 1. Section titles and protocol claims thus outrun the evidence: a reader auditing the paper against its own protocol finds six fault families of which two are solidly measured (F5, and F3 via the link-interruption drill).

**What would resolve it:** Either measure F1/F2/F4/F6 (F6 is a table-stakes storage-failure drill) and the escalation-at-K branch end-to-end, or add a coverage table mapping each T/F family to its evidence tier (measured / drill / acceptance test / unmeasured) and delete unreported metrics from Sec. V-A.

---

### M5 — MAJOR | No adversarial, erratic, or multi-agent behavior is tested; the guardrails have a by-design bypass
**Anchor:** Sec. IV-C stage (2): *"Agent writes are serialized per optimization scope—one open record per agent … within a cooldown Tcd = 300 s a same-direction rewrite is rejected while a reverse-direction correction stays allowed, so oscillatory overwrites are impossible."* Sec. IV-A: *"a rule limiting any single step to 2% of span."* Sec. V lists no experiment with erratic agents, proposal storms, or competing agents; T3 ("multi-node joint adjustment") is never measured as conflict.

**Why it matters:** All anti-runaway guarantees are scoped *per agent/per record*: "oscillatory overwrites are impossible" is true within one optimization scope, but nothing in the design prevents **cross-agent oscillation** — two agents (or two teams) bound to overlapping nodes can alternate ±2%-of-span moves every 300 s indefinitely, staying inside the window forever (in-window writes face no rate limit beyond the per-scope cooldown, and the backstop only reacts to *out-of-window* excursions with a lifetime cap of K=2 rollbacks). Likewise, a slow in-window drift attack (≤2% per step, direction alternated) is by construction never intercepted — the entire 29/29 evidence is against *out-of-window/range* values. Proposal storms (an agent flooding `dcw_control`), conflicting proposals from team members, and mid-record objective changes (T5 is defined but unmeasured) are all plausible LLM failure modes the framework claims to bound ("Bounded mechanisms … absorb bad proposals," Sec. VI-A) but never demonstrates absorbing.

**What would resolve it:** Add an adversarial-agent campaign (flooded proposals, alternating-direction writes, two teams on one node), report write-rate/oscillation behavior, and either bound cross-agent write rates or state explicitly that cross-agent in-window oscillation is out of scope.

---

### M6 — MAJOR | The "cost of integration" question is answered with pipeline seconds, not engineering cost
**Anchor:** Sec. I: *"what does it cost, in integration effort and latency …?"*; Sec. V-B: *"five devices across all five protocol drivers are commissioned in one pass … The stage completes in about 16 s in the quoted run (15.7–23.0 s across releases)"; "the artifact is five derived driver configurations plus one scenario identifier."*

**Why it matters:** The paper poses integration *effort* as a headline question, then measures it as wall-clock seconds of an automated pipeline and artifact counts. The quantity an integrator cares about — engineer-hours to author a scenario definition, provision semantics, validate windows, and commission a new line — is never reported; the cost was merely *moved* into "authoring the scenario definition" (Sec. V-B), which is unpriced. Authoring an ODE twin with six actuators and seven sensors is precisely the hidden integration project the framing claims to eliminate. Combined with M4 (token/call costs unreported — the LLM cost half of "cost" is entirely missing), the paper's central economic question is answered rhetorically, not quantitatively.

**What would resolve it:** Report scenario-authoring effort in engineer-hours for both scenarios; report token/LLM-call costs per campaign; scope the claim to "recommissioning after a scenario definition exists."

---

### m1 — MINOR | Provenance of the abstract's "29" is not derivable from the body
**Anchor:** Abstract: *"across both scenarios, 29 seeded out-of-window/range writes are intercepted."* Body counts: 6 (Sec. V-C, mock drivers) + 9 (Sec. V-B, film-line) + 20 (Sec. V-D, five-protocol) = 35 reported attacks. Presumably 29 = 9 + 20, excluding or subsuming V-C's 6; the mapping is never stated, and whether V-C's six overlap the V-D twenty is unclear.
**Resolve:** One sentence: which subsets compose 29, and whether any attack is counted twice.

### m2 — MINOR | Threats paragraph cites a layer Table I marks "designed"
**Anchor:** Sec. V-I: *"we claim no transfer beyond L1–L3–L4 without per-layer evidence"* vs. Table I where L3 (physical device) is *designed*, not measured. The phrase is incoherent as written; the measured set is L1–L4-simulation-only.

### m3 — MINOR | The no-readback ablation is vacuous by the authors' own construction, and I2's degraded path is never negatively tested
**Anchor:** Sec. V-G: *"the no-readback arm matches Full on in-memory drivers (the mock readback echoes the command)."* Sec. V-D: MQTT/HTTP actuators *"report no readback by design … a driver property the write path records rather than conceals."* I2 (Sec. IV-C): a write is ok only with readback within τ or an *"explicit degraded flag."*
**Why:** An ablation arm that cannot differ from Full measures nothing; and the degraded-flag branch — I2's only protection for blind actuators — is never shown to fire in any reported run (no degraded-flag counts appear in V-D).

### m4 — MINOR | Wilson intervals on deterministic, seeded checks quantify noise that does not exist
**Anchor:** Abstract: *"(Wilson 95% [88%, 100%])"* for 29/29; Fig. 4 caption: *"structural rather than statistical at n=6."* The real uncertainty — representativeness of self-authored attacks — is not captured by any interval. The paper knows this in Fig. 4 and forgets it in the abstract.

### m5 — MINOR | Hardware-suggestive wording for simulation results
**Anchor:** Contribution 4: *"a seeded extrusion cast-film line"* (it is an ODE twin; the abstract says "twin"); Sec. I: *"a live system."* A rushed reader will over-credit physicality.

### m6 — MINOR | Signed journal: keys, verification, and tamper-evidence unaddressed
**Anchor:** Sec. IV-C: *"signed audit journal with typed actor attribution"*; the journal lives in the same process and storage substrate (Sec. III-B, one data domain). Host- or process-level compromise (the admitted harness threat) presumably also reaches the journal; signature key management is never discussed.

### m7 — MINOR | Backstop timing is unvalidated against process dynamics
**Anchor:** Sec. IV-E (Tre=30 s, Twin=120 s, B=3) and V-E (*"cadence-bound at 120–130 s"*). Whether 120–130 s detection-to-rollback is safe for the twin's excursion rates is never analyzed; all parameters are engineering constants, not derived from the plant.

### m8 — MINOR | "14 interchangeable engines" is an enumeration, not an evaluation
**Anchor:** Sec. V-E: *"the registry enumerates 14 engines, with environment-available counts of 12–14"*; P4 (engine-agnostic governance) is a design claim; the cross-engine replication baseline is *"not measured here"* (Sec. V-A). Only omp/glm-5.3-flash ever runs in an LLM measurement.

### m9 — MINOR | Median of four campaigns is 0.755, printed as 0.76
**Anchor:** Sec. V-H and abstract. Trivial, but a paper that prints Wilson endpoints to two digits should not round a median upward.

### m10 — MINOR | Denominator scale switches silently between per-repetition and per-run
**Anchor:** Sec. V-G reports per-repetition rates (6/6→4/6; "false blocks are 0/3 in every arm") while Fig. 4's caption aggregates *"nine repetitions per arm across three released runs."* The twelve-anchor count is per run (see Section 6). Correct, but signposting is needed.

---

## 4. Ignored Alternative Explanations / Paths

1. **The agents lacked the process model, not the competence.** The 0.76 comparator controller encodes plant knowledge (*"inverts h∝N/v"*, Sec. V-F); the agents received only semantic cards (unit/range/window/freshness, Sec. IV-A). The 0.76-vs-0.97 gap may measure *withheld process knowledge* or tool ergonomics, not LLM closed-loop incapacity — yet it is used to motivate the propose/dispose architecture as *"working as intended."*
2. **Infrastructure failure, not reasoning failure, drives the negative tail.** Campaign 4's MQTT thickness channel refused connection and the melt-pressure node failed its OPC UA connection test *"in all four"* campaigns (Sec. V-H); campaign 2's catastrophic 0.35 has no reported J₀, so plant-degradation vs. bad-start vs. channel loss is undetermined.
3. **Time-scale confound.** LLM campaigns ran at *"physics accelerated 6×"* (Sec. V-H); the deterministic benchmark and W\* under real-time physics. Control difficulty is not time-scale invariant; part of the gap may be the acceleration.
4. **W\* may be underestimated.** The grid resolution of the offline optimum is unreported (Sec. V-A); a coarse grid lowers the denominator and inflates every recovery percentage, including the 97% headline.
5. **The objective may be shaped around the controller.** J weights thickness at 55/95 and the controller's only closed-form step targets thickness; the "low-throughput corner" explanation (Sec. V-F) is equally consistent with an objective that penalizes the controller's preferred operating point — i.e., the 3–4% shortfall is an artifact of objective design, not a discovered trade.
6. **Portability success may test scenario authoring, not framework generality.** The second scenario is *"a coating-oven line with … per-signal strategies rather than a physics engine"* (Sec. V-B) — scripted signals authored by the same team. An integration export the authors did not also author the platform against was never tried.
7. **Zero false blocks may reflect tiny, self-chosen legal-write samples** (3 legal writes in V-C, 4 in V-B, 4 in V-D), not window permissiveness; a realistically tight window could block legal modulation moves at the ±1-least-count boundary the paper itself probes.
8. **The "enforceable vs. declared" dichotomy has a third option the paper skips:** classic external enforcement (a separate enforcement process/gateway between agents and drivers, i.e., a shield). Sec. II-B cites CBFs and shielding ([14], [15]) and moves on; a sidecar enforcer would preserve 62443 zoning and might enforce the same contract against compromised harnesses — the alternative against which "co-residency enforceability" should have been argued, not asserted.

## 5. Missing Stakeholder Perspectives

- **Operators / human-factors engineers.** Every measured human step is a *"scripted operator emulation"* (Sec. V-H). Approval fatigue, alarm burden, decision quality under time pressure, and the effect of a real human's latency on the loop are unexamined; approval-wait metrics are defined (Sec. V-A) but unreported.
- **Functional-safety engineers.** Sec. VI-A concedes the invariants are *"engineering properties, not certified safety functions."* What a 61511-style safety case would require of the interlock (failure modes, proof-test intervals, SIL candidacy) is absent — leaving an industrial reader unable to place the mechanism in a safety lifecycle.
- **Security / red team.** No adversarial testing of the MCP/A2A surfaces, credential scopes, the plugin host, or the journal; no injection drill against a real harness (the paper's own named threat, [35]); no IEC 62443 SL-level analysis of the one-zone trade (C1).
- **Plant managers / integrators.** Commissioning cost in engineer-hours, scalability beyond one line/six actuators/64-in-flight samples, SQLite/TimescaleDB adequacy at plant tag counts, and the practical adoption blocker of a **PolyForm Noncommercial** platform license (Sec. VII) — a noncommercial license on the "integration framework" being proposed for industry deserves at least a sentence.
- **Independent replicators.** The compare gate asserts equality against *the authors' own archived baseline*; the audit harness audits its own artifact (admitted, Sec. V-C). No external replication path is described.

## 6. Observations (Non-Defects) — including suspicions that dissolved on inspection

1. **Dissolved: the twelve-anchor arithmetic is internally consistent.** I initially suspected the count in Sec. V-G ("twelve out-of-window anchors per bypass arm per run: six breach writes plus six accepted edge probes"). It checks out: per repetition, 2 window-class attacks (219, 163) execute when the interlock is bypassed → 2×3 repetitions = 6 breach writes; the 2 out-of-window boundary probes (205.1, 174.9) are accepted → 2×3 = 6; total 12. The in-window probes (205.0, legal writes) are correctly excluded.
2. **Dissolved: Fig. 3 numbers are consistent.** J_end per seed (87.26/87.16/87.37) is exactly the mean of the plotted iteration-1 and iteration-2 evaluations. The loop's J *decreases* from iteration 1 to 2 on all seeds — worth flagging (see M1) but not an inconsistency.
3. **Dissolved: "Thickness moves from 55.2–56.1 μm"** reads as the *starting* value, consistent with the convergence band [48, 52] μm; the wording is ambiguous but not contradictory. Note the LLM campaigns "settled at a 55.33 μm window mean" — i.e., the agents ended roughly where the deterministic controller *started*, which sharpens M2's point that J₀ reporting is essential.
4. **The paper's self-disclosure is unusually good** for this genre: layer-labeled claims (Table I), printed Wilson endpoints, "structural rather than statistical at n=6," "existence proof rather than a controlled measurement," "measured negative, not a headline," bench-mode bypass flags refused in production builds, and an explicit paper–code consistency check (20/20 constants). My critique is accordingly aimed at **abstract-level framing outrunning section-level honesty**, not concealment.
5. **The single-entry write function and judgment/execution separation** are genuinely sound, transferable patterns; the judge-tool that cannot actuate and the approval/execution decoupling (stale approvals cannot be exploited) are well designed.
6. **Latency reporting is honest** (Modbus TCP p95 attributed to first-write connection setup; whisker semantics carefully defined in Fig. 4).
7. **The "oscillatory overwrites are impossible" claim is true in scope** (per agent, per direction, 300 s) — my attack in M5 is about the *cross-agent* and *in-window* complement, not a misreading of the stated scope.
8. **Related-work positioning is defensible but tight:** Hofmann et al. [8] already actuated real machines over OPC UA in natural language, and [9] already closed LLM fault-tolerant loops on simulated plants; the novelty is the multi-protocol substrate + governance pipeline + benchmark packaging, which is real but incremental and should be claimed accordingly.

---

**Overall read for the panel:** A well-engineered system with unusually candid limitations sections, whose abstract and contribution list make stronger claims (enforceable safety, "live system," agent closed-loop control, integration cost) than any measured layer supports. Two CRITICAL issues (trust boundary vs. enforceability claim; closed self-authored evidence base) require either new measurements or substantive claim retreat; the MAJOR issues are addressable with experiments the released protocol already defines but the paper did not run.
