# R-EIC — Journal-Fit Review (Reviewer Seat: EIC / Associate Editor)

**Manuscript:** *AgentWorkShop: A Node-Native Integration Framework for LLM Multi-Agent Closed-Loop Control of Heterogeneous Industrial Production Lines*
**Venue:** IEEE Transactions on Industrial Informatics (TII), regular paper
**Reviewed artifact:** `main.pdf` (11 pp.), `main.tex`, `sections/*.tex` (read-only review)
**Date:** 2026-09-16

---

## 1. Mental-Model Reconstruction (comprehension test)

Reconstructed after a full read of the PDF; this is what a TII reader should carry away:

AgentWorkShop is one Node.js process organized as three planes joined by a governed bridge. The **agent plane** couples a 14-engine harness registry (engines interchangeable behind a capability matrix) with lead-supervised *channels* — one lead, N workers, a seven-state task tree, a 1 s supervision tick with a deterministic rule-engine fallback — plus typed episodic–semantic memory (SQLite/FTS5 + optional vectors, RRF k=60 fused with MMR λ=0.7, three-layer injection). The **industrial plane** terminates five protocol drivers (Modbus TCP/RTU, OPC UA, MQTT, HTTP) behind per-node edge runtimes on decoupled acquisition intervals, a 250 ms starvation-free gateway sweep (quota 64), an ISA-18.2-style alarm chain, and a line/product/recipe/run tree. The **bridge**: binding a node injects a *semantic card* (unit, hard range S(n), recipe window Wr(p), freshness) and exposes exactly one write path — Algorithm 1: availability gate → per-agent record serialization with 300 s same-direction cooldown → soft interlock against C(n,r)=S(n)∩Wr(p) → readback-verified write (tolerance τ(n), Eq. 2) → signed journal anchor. Binding mode fixes the HITL posture: *manual* (human approval gate), *auto* (interlock+backstop only), *unbound* (no write path). The **closed loop** works as: agent observes via `daq_query`, proposes via `dcw_control` (opens an optimization record freezing a pre-write baseline), the pipeline actuates, `dcw_judge` returns keep/rollback/uncertain without actuating; a backstop re-scores open records every 30 s and, after B=3 out-of-window samples, rolls back to the recorded baseline — at most K=2 per node lifetime, then human escalation; rollbacks themselves traverse the same pipeline.

*(≈225 words — the system is followable end-to-end; Sec. III-C's concrete 187→185 °C walk-through materially helps.)*

### Comprehension breakdown points (where I had to guess)

| # | Location | Problem |
|---|----------|---------|
| B1 | Sec. V-B, p. 8 | The portability stage never states its **driver tier** (mock or real transports). Readback ≤0.04 °C suggests real, but only Sec. V-D declares a simulator stack. I had to guess. |
| B2 | Secs. IV-C/IV-E, pp. 4–5 | "**Optimization record**" is central (records, supersede, T_stale, baselines) but never formally specified — fields, lifecycle states, and relation to the journal anchor must be inferred. |
| B3 | Sec. IV-E, p. 6, invariant I3 | "the **third response** and all manual-policy rollbacks require human confirmation" — ambiguous between "third out-of-window sample" and "third rollback attempt." I guessed the latter from context. |
| B4 | Sec. III-B, p. 3 | Tool-count triple "48 host tools, 23 industrial/automated-ML, MCP server exposing a 25-tool subset" — the **selection criterion** for the 25-tool subset is never stated. |
| B5 | Sec. V-F vs. abstract | The closed-loop headline (97.0–97.2 %) comes from a **deterministic controller**, not an agent; a reader skimming the abstract's "governed closed-loop benchmark" may initially misattribute it. The paper does explain this (Sec. V-F), but only two pages later. |
| B6 | Sec. V-C, p. 8 | "10 s dedup" of audit events appears in Algorithm 1 (p. 5) but the *rationale* (what duplicate storm it defends against) is unstated — minor guesswork. |

No unresolved incomprehension; all six points are fixable with one-sentence additions.

---

## 2. Journal Fit & Originality Assessment

**Fit: strong.** TII's scope — industrial informatics, CPS integration, protocol/enterprise-layer convergence, human-in-the-loop automation — is squarely matched. The paper's subject is precisely the *integration* problem (agent↔plant binding, protocol drivers, semantic grounding, commissioning-as-configuration), not a generic LLM contribution dressed in industrial clothing. Prior TII-published work is cited as direct comparanda (CoMA-IKG, TII 2026 [3]), positioning the paper inside the journal's ongoing conversation. TII readers (integration engineers, plant IT/OT architects) can act on: the semantic-card pattern, the single-governed-write-path contract, the binding-mode HITL taxonomy, and the executable benchmark protocol.

**Originality: good, with a clearly argued delta.** The related-work section correctly triangulates the gap: advisory-boundary industrial LLM systems [3]–[7], single-loop closed-loop control [8], [9], adjacent-domain actuation [10], [11]. The original combination is (i) node-native co-residency of agent runtime and protocol drivers (check-then-actuate in one event-loop turn), (ii) a *formalized, engine-agnostic* accepted-action language with three checkable invariants (I1–I3), and (iii) a seeded, machine-checkable benchmark with frozen baselines. Individually none is revolutionary; jointly they are a genuine contribution, and the honest **measured negative** (LLM teams reach median 0.76 of optimum vs. 0.97 for a fixed controller) is a credibility asset rare in this literature.

**Significance: moderate-to-high, capped by evidence tier.** Table I is admirably honest: all *measured* evidence is simulation-tier (L1/L4); dataset replay (TEP/SWaT, L2) and the physical OPC UA/Modbus device (L3) are "designed" only. For TII's plant-floor readership, the absence of any physical-hardware measurement and of any measured external baseline (AutoGen/LangGraph/CrewAI arms are "defined but not measured") caps the significance claim. The framework claims are structural and survive this, but adoption-level claims should not.

**Readership relevance:** high — protocol heterogeneity, ISA-95/88, IEC 62443/61511 framing, and commissioning economics are exactly the journal's register.

---

## 3. TII Format Compliance Checklist

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | IEEEtran two-column, title/author block | **PASS*** | Two-column IEEEtran throughout (pp. 1–11); title + author block present, but author names/affiliations are placeholders (see item 7). |
| 1a | Abstract length ~150–250 words | **PASS** | 230 words (counted from `main.tex` ll. 70). Single dense paragraph; acceptable. |
| 1b | Index terms present, alphabetized | **PASS** | p. 1: Agent integration framework → closed-loop control → digital twin → human-in-the-loop → industrial automation → large language models → multi-agent systems → node-native integration → protocol heterogeneity. Correct alphabetical order. |
| 2 | Roman section numbering, lettered subsections, no "??"/undefined refs | **PASS** | Sections I–VII (pp. 1, 2, 3, 5, 10, 11); subsections A–G (Sec. IV), A–I (Sec. V), A (Sec. VI). Grep of extracted text: zero "??"; `main.log` shows no undefined/multiply-defined labels. All Eq. (1)–(3), Algorithm 1, Figs. 1–4, Tables I–II referenced. |
| 3 | Figure captions below, "Fig. N.", legibility, units, color discipline | **PASS** with nits | Fig. 1 (p. 3) and Fig. 2 (p. 6): captions below, self-contained, vector-crisp at print size (smallest sub-labels ≈6 pt equivalent — borderline but legible). Fig. 3 (p. 9): caption below; axes "Objective J" / "Closed-loop iteration" (dimensionless, scale stated in text) — nit: caption says "Eq. 3" (should be "Eq. (3)") and the "red stars" of iteration 2 are almost indistinguishable due to marker overplotting of three seeds. Fig. 4 (p. 10): axes carry units — "Interception (%)", "Write latency (ms)"; hatch+color pairing survives grayscale. Preamble documents a palette with color+linestyle/marker redundancy for monochrome/CVD reprint (`main.tex` ll. 18–46) — good discipline. |
| 4 | Table captions above, "TABLE N" small caps, booktabs | **PASS** | Table I (p. 7) and Table II (p. 9): captions above in small caps, booktabs rules, Table II has a proper footnote ("acquisition-only satellite node"). |
| 5 | IEEE-style references, relevance, arXiv consistency | **PASS with failures** | [1]–[35], all topically relevant, no orphans, two-column balance on p. 11. **Inconsistencies:** arXiv variants differ — "also arXiv:2410.14209" [4], ", arXiv:2505.02076" [7], ", arXiv:2405.18092" [6], ", arXiv:2308.03688" [20] vs. "arXiv preprint arXiv:…" [8], [9], [13]; [5] lists "Ren et al." with no author initials; [11] misspells "Chatgpt" and lacks its venue (published in IEEE Access); URL-only entries [24], [25], [27], [30] lack access dates. |
| 6 | Page count ≤ 14; visual defects; float placement | **PASS** | 11 pages including references. Floats all placed at column/ page tops (Fig. 1 p. 3 top-span, Fig. 2 p. 6 top-span, Table I p. 7, Table II + Fig. 3 p. 9, Fig. 4 p. 10) — good placement quality; no orphaned section heads observed; `\balance` applied to references. `main.log`: one Overfull \vbox (3.44 pt, invisible) and several Underfull hboxes (badness ≤10000) — cosmetic only. |
| 7 | Author-block placeholders | **FAIL** | p. 1: "First Author, Second Author, and Third Author"; "Manuscript received XXXX; revised XXXX."; "The authors are with XXXX, City, Country (e-mail: first.author@xxxx.edu)." Source TODOs: `main.tex` l. 60 (`% <-- TODO: fill real names`), l. 62 (`% <-- TODO: affiliation`); `sections/discussion.tex` l. 8 (`% TODO(submission): add the artifact DOI/URL`) — the rendered conclusion cites "the project repository" with **no URL/DOI anywhere**. |
| 8 | Formal academic English register | **PASS** | Consistent, precise, and unusually candid register ("a measured negative", "unfavorable to the agent"). Minor colloquialisms: "the rig is restored" (p. 8), "gel counter" used without gloss (pp. 8–9), engine name "omp" never expanded (p. 4). |

---

## 4. Major Issues

**M1. Author block, received-date, and artifact-DOI placeholders make the manuscript administratively incomplete.**
*What/where:* p. 1 author block (names, affiliation, e-mail, manuscript-received dates all XXXX); conclusion (p. 11) references "the project repository" without any URL/DOI; `sections/discussion.tex` l. 8 carries the TODO. *Why it matters:* TII will not enter review with an anonymized-by-neglect block, and the reproducibility claims ("frozen baselines", "released protocol", "run archives") are hollow without a resolvable artifact DOI. *Fix:* fill author metadata; mint a DOI (Zenodo/IEEE DataPort) for platform + harness + simulator submodule; replace the internal path citation with the DOI footnote.

**M2. Abstract framing risks over-reading the evidence tier ("on a live system").**
*What/where:* Abstract, p. 1 — "This paper measures both costs on a live system"; also "closed the same loop over real transports." All measured evidence is simulation-tier (Table I: L2/L3 = designed). *Why:* TII reviewers and readers routinely penalize perceived hardware overstatement; the paper's own honesty (Secs. V-A, VI-A) is its best defense, but the abstract does not carry it. *Fix:* one clause in the abstract — e.g., "on a live software instance over real protocol transports against seeded plant simulators" — and keep "real transports" (which is accurate) while avoiding any hardware implication.

**M3. Headline LLM result (median 0.76) rests on four campaigns sharing one seed with no variance estimate.**
*What/where:* Sec. V-H, p. 10; abstract; conclusion. The threats section (Sec. V-I) concedes it. *Why:* a TII readership will treat a same-seed n=4 as anecdotal; the propose/dispose design conclusion hangs on this number. *Fix (minimal):* either add cross-seed campaigns at least for the median claim, or explicitly downgrade the wording from "median 0.76" (abstract) to "in four same-seed campaigns, 0.35–0.76" and mark it exploratory in the abstract, not only in Sec. V-I.

**M4. No measured external baseline — "benchmark" claims rest on internal ablation only.**
*What/where:* Sec. V-A, p. 7 ("further baseline groups … are defined in AW-IndustrialBench's released protocol and are not measured here"); Sec. VI-A. *Why:* the paper simultaneously releases a benchmark *and* reports no cross-framework measurement on it; this weakens both the originality claim for the benchmark and the comparability of the reported numbers. Acceptable for a framework paper, but the title/abstract register ("benchmark") should not imply external comparability yet. *Fix:* measure at least one general-framework arm (e.g., a LangGraph or AutoGen team over the same MCP tool surface, as the protocol already defines), or add a scope sentence to abstract and Sec. V-A distinguishing "measured here" from "defined in protocol."

**M5. Comprehension gaps B1–B3 (driver tier in Sec. V-B; optimization-record definition; "third response").**
*What/where:* p. 8 (V-B), pp. 4–5 (record), p. 6 (I3). *Why:* the paper's own standard is "checked rather than asserted"; a careful industrial reader reconstructing the loop (my Sec. 1 test) stalls at exactly these three points, and B1 affects how the portability claim (the paper's central framework claim) should be weighed. *Fix:* one sentence each — state the driver tier in V-B; add a 2-line record schema/lifecycle in IV-C; reword I3 to "the third rollback attempt."

---

## 5. Minor Issues

1. Fig. 3 caption (p. 9): "Eq. 3" → "Eq. (3)" (body style); the caption's "Red stars mark the iteration-2 settling measurement" is not visually supported — the three seed markers overplot the stars; offset the stars or drop the sentence.
2. Reference hygiene: unify arXiv formatting (recommend "arXiv preprint arXiv:NNNN.NNNNN" everywhere, or drop arXiv notes when the venue is cited); [5] needs author initials (all authors, or "F. Ren et al."); [11] "Chatgpt" → "ChatGPT" and add venue (IEEE Access); [24], [25], [27], [30] add "[Online]. Available:" per IEEEtran.
3. p. 8: internal repo path "(figures/pdf/fig-walkthrough)" cited in body text — replace with a footnote to the artifact DOI (subsumed by M1).
4. Sec. III-B (p. 3): state the criterion for the MCP 25-tool subset of the 48-tool surface (B4).
5. Terminology: expand "omp" at first use; gloss "gel counter" at first use (p. 8).
6. Sec. V-C reports two attack pools ("6 seeded gross out-of-constraint writes" p. 8; abstract's "29 … across both scenarios" = 9+20): add a one-line tally so the abstract's 29 is traceable to Secs. V-B/V-D (currently V-C's 6 is a separate mock-tier pool).
7. Cosmetic LaTeX: one Overfull \vbox 3.44 pt (log l. 909); underfull hboxes at `sections/*` justified list lines — negligible, but re-check after edits.
8. Index terms include the self-coined "node-native integration" — permissible, but consider "system integration" as the discoverable anchor term.
9. Table I's L4 row is the only place the phrase "case study" appears before Sec. V-H — align the label ("digital-twin case study" vs. Sec. V-H "Case Study") for cross-reference ease.

---

## 6. Recommendation

**Minor Revision.**

*Rationale:* From the journal-fit and format seat, this manuscript is unusually well matched to TII: the contribution is an *integration* contribution (architecture, governance contract, commissioning economics, executable benchmark) rather than a model paper; the related-work delta is argued precisely; the paper is honest about evidence tiers and reports a negative LLM result against its own framework — which raises, not lowers, its credibility for this readership. Format compliance is high (correct IEEEtran apparatus, captions/rules/numbering conventions, 11 pp. ≤ limit, no broken references), and the two-column product is clean.

The revision bar is low but non-negotiable: (M1) complete the author block and mint an artifact DOI — the reproducibility narrative currently points at an unresolvable "project repository"; (M2/M3/M4) align abstract-level claims with the simulation-only, single-seed, no-external-baseline reality in three precisely-placed sentences; (M5) repair the three comprehension stalls. None of these requires new experiments to satisfy the letter, though measuring one external baseline arm (M4) would materially raise the paper's standing and my recommendation would move to Accept-on-revision with enthusiasm. No format obstacle prevents a smooth path to publication once these items land.
