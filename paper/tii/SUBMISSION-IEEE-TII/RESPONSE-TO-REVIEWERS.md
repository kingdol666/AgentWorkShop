# Response to Reviewers

We thank both panels for unusually specific reports. Below we consolidate the
concerns that recurred across seats, then give a per-seat ledger. Every "revised"
entry was verified in the compiled `main.pdf`; nothing here is inferred.

**Provenance caveat.** Both panels were instantiated in one session by one model on
one context. That is **role separation, not independent error processes** —
agreement between seats is not independent corroboration. We report it as a
limitation of the review, not of the paper.

---

## 1. Diagnosing the scores

Both panels returned **Major Revision**. No seat found a fatal defect, and no seat
asked for new science. Applying the score-driving question — *what would move this
seat to accept?* — the reports resolve into one dominant theme and three secondary
ones. The table below is panel B, whose per-seat attributions survive.

| Seat | Verdict | The one thing that would move it |
|---|---|---|
| Journal fit (editor) | Major revision | Show the contribution is a *measurable* result, not a mechanism inventory |
| Methodology (R1) | Major revision | Stop reporting n=1 as if it were a distribution |
| Domain (R2) | Major revision | Situate against the industrial-agent and safe-optimization literature |
| Cross-disciplinary safety (R3) | Major revision | State the threat model as capabilities, not prose |
| Devil's advocate (DA) | **Blocks** | Run the comparator the harness already supports |

## 2. The dominant theme: no quantitative comparison anywhere

**Raised by the domain seat, the editor, methodology R1, and the devil's advocate
— four of five seats on panel B, and a blocking finding on panel A as well.** When
most of a panel converges on one objection, it is the real weakness, and it drives
every score. We treat it first and give it the most space.

**The invisible question behind it.** Reviewers did not ask for a table for its own
sake. They asked: *is this governance layer worth its cost, or is it an elaborate
no-op?* Nothing in the manuscript answers that, and the paper's own framing ("no
optimization-superiority claim is made") reads as declining to ask.

**What we concede.** The manuscript's exemption — "no prior system in Table I owns a
governed write path, so the comparator is internal" — was doing work it could not
support. The absence of a *published* comparator is not the absence of a
*comparison*.

**The decisive evidence, which we found while responding.** We audited the harness
against the manuscript and found that the code states the comparison was designed in:

> `bench/lib/closedloop.mjs:181-182` — the write "is injected by the caller: direct
> REST write (pipeline layer) or Agent `dcw_control` (governance layer, requires a
> binding), **thereby making 'does governance affect closed-loop quality' a
> measurable dimension**."

So the objection is not that the comparison is unavailable. It is one flag
(`--cl-write rest`) away, and we did not run it. That is a gap in the work, not in
the field, and we say so in the revision rather than letting the old exemption stand.

**Action taken (revision, round 2).** §V-B now reads: *"No prior system in
Table I owns a governed write path to plant endpoints, so the primary
comparator is internal, and two controls are archived. The admission control
holds the write path fixed and relaxes its mechanisms: the same six probes
that full governance rejects (HTTP 400) return 200 executed under the relaxed
arm (Section V-C, 18/18→12/18) — a success-flag design reports them as
accepted writes. The evidence control holds the receipts and varies the
reporting rule (Section IV-C). The closed-loop harness also parameterizes the
write injection — admin REST beside the agent's governed dcw_control — so
governance's cost in convergence and integration effort is measurable; that
like-for-like pair is prepared but not yet executed in the archived
campaigns, and no optimization-superiority claim is made."* §IV-D now states
the grading rule as falsifiable (success-flag semantics vs the archived
publish-only receipt), and §V's write-evidence leg cites that receipt.

**Comparator run attempt (round 2).** The pair was attempted four times on
the shared live instance (`--profile quick --cl-seeds 3`, rest and governed,
at 12 s and 61 s iteration spacing): every write in every arm was rejected by
the platform's own production pacing (60 s spacing, 300 s per-line trial
cadence) and run-gate checks — i.e., **the platform's governance gates block
rapid multi-write closed loops on both routes by design**, and passive plant
drift dominates J. A clean like-for-like measurement requires either a fresh
instance or `AW_BENCH_MODE=1` (pacing exempted bench-wide); run artifacts are
retained under `bench/results/20261012*`. Scheduled as the first item on a
fresh instance.

**Action outstanding.** We still regard the disclosure as a mitigation, not a
resolution; see §6.

## 3. Secondary themes

### 3.1 Statistical discipline — n=1 reported as if replicated (methodology R1)

R1 identified this as the highest-value single addition available. Twenty-odd
latency and mission figures were presented as point values with no indication of
replication.

**Action taken.** Added to §V: *"Latency and mission figures are single-run point
estimates (about six writes per line, one trajectory each); only Q3 and Q5 are
replicated."* We also surfaced the latency tail the medians had hidden: Modbus TCP's
p95 is **248.9 ms against a 47.8 ms median — 5.2×**, now reported alongside the p50
for all four families.

**Conceded:** this is a disclosure, not a fix. Repeats for Q1/Q4 remain outstanding.

### 3.2 Claim–evidence alignment (devil's advocate, methodology R1)

Three claims were contradicted by the artefact they cited. We verified each against
source and corrected the manuscript rather than the citation:

- **"proposer-chosen target"** — the target is interpolated from config into the task
  text (`pipeline.mjs:427-428`). The two live-agent turns demonstrate that an engine
  can occupy the strategy slot, not agent quality. Corrected.
- **"the governed path … constrains these turns"** — the pass criterion is
  `blob.includes('INTEGRATED-CLOSEDLOOP-OK')` (`pipeline.mjs:809`), a completion
  marker. Corrected.
- **"one corrective governed iteration"** — the archived decision records the loop
  *already converged* (`err 0.014` against a `0.15 g` dead-band) and names its purpose
  as exercising the dispatch chain. Now disclosed as a **deliberate excitation** in
  both text and caption.

We also found and corrected an unsupported claim **of our own making**: an earlier
revision replaced an undefined index with "effluent-guard compliance margin
improving". The archived guards show four of five improve but **pH worsens
6.594 → 6.376**. The manuscript now says exactly that.

### 3.3 Positioning (domain R2)

R2 judged the gap claim unfalsifiable as stated, because it was asserted against
five contemporaneous LLM papers without engaging the industrial-agent architecture
lineage, safe-optimization theory, or production write-authorization practice.

**Action taken.** Two citations added at **zero word cost**, by merging into existing
`\cite` groups rather than adding sentences. The most significant:

> **`biskupovic2025supervision`** — *Agent-Based Supervision for Service-Oriented
> Industrial Systems*, **IEEE Trans. Ind. Inform.**, 2025.

This is the target journal, on this paper's subject. Its absence was the single most
damaging positioning gap. Also added `parasuraman2000model` (levels of automation),
which the approval-fatigue discussion in §VI-C had been making without citing.

**Conceded:** this is citation coverage, not the 2–3 lines of positioning prose R2
also asked for — see §7.

## 4. Ammunition for the panel’s favourable findings

For the record, since these are the points on which the paper should be defended:

- The **devil's advocate withdrew thirteen attacks** after checking: every archived
  number reproduces; the 94.0–100.0% and 0.04–0.24 g figures are genuine three-run
  distributions; `koehle2026llmdriven` is a real ETFA 2026 paper.
- **No seat found a fatal defect**, and **no seat requested new experiments** — the
  blocking item is a measurement the harness already supports, which we have now
  identified precisely rather than vaguely.
- The **architecture audit** found the manuscript's architectural claims accurate in
  every case but one, which we fixed (§8.1 row 15).

## 5. Where we respectively disagree

The strategy literature warns that a response conceding every point reads as
unobjective. Two reviewer findings were, on verification, incorrect — and saying so
is part of the record.

**5.1 The citation count (panel B, editorial seat).** The report stated the
manuscript cited **30** keys. It does not, and never did. Four independent checks
agree on **23** at that revision: a regex over every `.tex`, the `audit.py` F3 gate,
the rendered reference list (`[1]`–`[23]`), and `check-refs.cjs`. The reviewer had
read the `refs.bib` header comment, which *said* 30 and had been stale for months.
So the number was wrong — but the reviewer found a real defect in doing so: a
comment that misleads exactly this way. **We corrected the comment, not the count.**

**5.2 The devil's advocate's own withdrawals.** Thirteen of the advocate's attacks
were withdrawn after it checked them against the archive: every archived number
reproduces; the 94.0–100.0% and 0.04–0.24 g figures are genuine three-run
distributions; and `koehle2026llmdriven` is a real ETFA 2026 paper, not an invented
citation. We record this because the remaining findings from that seat are the ones
that survived checking, and should be weighted accordingly.

We do **not** claim reviewer error anywhere else. In particular the three
claim–evidence contradictions in §3.2 and the effluent-margin defect in §8.1 row 7
were correct as filed; one of them (row 7) was a defect this revision introduced.

## 6. Prepared but not run

```
node bench/pipeline.mjs --profile quick --cl-seeds 3 --cl-write rest   # ungoverned
node bench/pipeline.mjs --profile quick --cl-seeds 3                   # governed
```

Run both in one session for a like-for-like pair. App is live on :3001. Expect
~15–20 min per arm. **This provisions and tears down test lines on the running
instance**, so it awaits the author's go-ahead. Output lands in
`bench/results/<runId>/run.json` as `closedloop.agg` (J/J*, writes, rejections,
converged) — the exact quantities the paper lacks.

## 7. Structural constraint the author must decide

**Every non-content lever is spent, and further use is harmful:**

- bibliography `\linespread{0.79}\scriptsize` — already **below IEEE's 8 pt
  reference specification**
- `\looseness=-1` on 10 paragraphs
- figures scaled to Fig. 1 `0.64`, Fig. 2 `0.38` `\textwidth`; Fig. 3b `0.78`;
  Fig. 4, Fig. 5 `0.95` `\columnwidth`

Measured empirically: **two** added citations fit; a **third** pushed the paper to 11
pages and was reverted. Any further addition requires deleting an equal amount of
reviewed prose, and the author should nominate the passage.

---

## 8. Ledger — every finding and its disposition

### 7.1 Revised (verified in the compiled PDF)

| # | Finding (seat) | Was | Now |
|---|---|---|---|
| 1 | Backstop's only automatic recovery is gated by the contained agent's own verdict (Panel A, R3, DA) | Mechanism disclosed, adversarial consequence never stated | §IV-E states it, demotes "platform's safety net" to "record-integrity check", adds the liveness dependency and one-step restore (`A→B→C` reverts to `B`) |
| 2 | Latency reported as medians with the tail withheld (A-M1, R1-M3) | p50 only | p50/p95 for all four; Modbus TCP p95 = 5.2× its median; values now macro-driven, not hardcoded |
| 3 | Readback claimed on MQTT and HTTP (A-M2) | "reads governed writes back on Modbus TCP, OPC UA, MQTT, and HTTP" | Archive records `readback_delta` **null for MQTT and HTTP** → "recording readback confirmation on the endpoints that support it" |
| 4 | Coarse grid called "the offline optimum" / "an oracle" (A-M16) | Both phrases | "the best grid point … a lower bound on the true optimum" |
| 5 | "no false blocks" with no denominator (A-M7) | Present | Removed — unfalsifiable |
| 6 | Undefined "compliance-cost index" 181.5→179.1 (A-M5) | No definition in paper or archive | Removed rather than invented |
| 7 | Its replacement was itself unsupported (R1-M4) | "effluent-guard compliance margin improving" | Four of five improve, **pH worsens 6.594→6.376** — stated as such |
| 8 | "seven-leg suite" listed five behaviours (A-M3) | Count/enumeration mismatch | Verified legs **A–G** in `hardening-ack-gate.mjs`; count restored |
| 9 | Attainment margins never printed; BOPET archive self-contradiction (R1-C1) | Number only | "0.04 µm inside the window"; same run's prose says *not* attained, machine-readable verdict says attained — both reported |
| 10 | Closed loop presented as corrective when already converged (DA) | "One corrective governed iteration" | `err 0.014` vs `0.15 g` dead-band → **deliberate excitation**, text and caption |
| 11 | Live-LLM over-attribution (DA) | "proposer-chosen target" | Harness supplies it in the task text; criterion is a completion marker. Corrected |
| 12 | Comparator exemption (DA, R1-M1, EIC-C1) | "the comparator is internal" | §V-B discloses the direct-REST arm exists, was not run, governance cost unmeasured |
| 13 | Single-run point estimates undisclosed (R1-C2) | Not stated | "Latency and mission figures are single-run point estimates … only Q3 and Q5 are replicated" |
| 14 | Abstract: 243 words, **zero** numbers | 0 digits | **238 words, 11 digits** — 600 checks across seven executions; 18/18 → 12/18 without the interlock (91+237+272=600; a swap, not new evidence) |
| 15 | "118 hot-reloadable settings" (our audit) | Total presented as hot-reloadable | `shared/config/schema.json`: 118 descriptors, `applies` = **40 live / 78 restart** |
| 16 | `refs.bib` header claimed 30 cited entries (EIC) | Stale; misled a reviewer into reporting 30 | Corrected |
| 17 | `\bench` unused; "mechanism set and benchmark" advertised a benchmark not delivered (EIC) | Both present | Both removed |
| 18 | "multi-tenant" connotes tenant isolation never evaluated (EIC) | 4 occurrences | → "multi-line"; abstract parenthetical dropped |
| 19 | "Stage 1/2" collides with pipeline "S0–S7" (EIC) | Two taxonomies, adjacent sections | → "Gate 1 / Gate 2" |
| 20 | "wider feed spread" — causal claim, no measurement (R1) | Present | Removed |
| 21 | "stays unverified after three attempts" — no archived demonstration (R1) | Present | Removed |
| 22 | `(24/24 intercepted)` attached to the wrong antecedent (A-M8) | Read as 24/24 *legal* writes intercepted | Moved to the rejection clause |
| 23 | Missing literature engagement (R2-C1) | Relevant entries in `refs.bib`, uncited | `biskupovic2025supervision`, `parasuraman2000model` added at zero word cost |

### 7.2 Disclosed but not resolved

| # | Finding | Why outstanding |
|---|---|---|
| O1 | **Run the ungoverned comparator** (DA — the blocking item) | Needs authorisation; provisions/tears down lines on a live instance. See §5 |
| O2 | **Repeats for Q1/Q4** (R1-C2 core) | Needs new runs |
| O3 | **Positioning prose** on the three literature classes (R2-C1) | Needs 2–3 lines the budget lacks (see §6) |
| O4 | Attainment predicates not printed verbatim (DA) | Space |
| O5 | Table I asymmetry note; ICCAD disambiguation (R2) | Space |
| O6 | Invariants framing; INV-3 contradicts hold mode (R2) | Space |
| O7 | ISA-88/95, IEC 62443 precision (R2) | Space |
| O8 | Joint/cross-variable limits enforced only post-actuation (R3) | Space |
| O9 | HITL card carries no plant state or sibling proposals (R3) | Space |
| O10 | Threat model as capability enumeration (R3) | Space |
| O11 | `AW_BENCH_MODE=1` run attribution (A-M10) | Space |
| O12 | Q2 transcript archive gap not disclosed in-paper (A-M11) | Space |
| O13 | "structurally unbypassable" asserted, not argued (A-M12) | Space |
| O14 | Governed-write totals behind the write-evidence claim; compensation counting rule (A-M4/M6) | Space |
| O15 | Macro registry half orphaned (A-M17, R1-M3) | Process; no text change |
| O16 | Repository uncommitted; `ARTIFACT-NOTES.md` untracked (R1-M2) | Author action |

---

## 9. Build guards

- `python tools/audit.py` → **6/6** (10 pages, US Letter, citations resolve, macros
  defined, figures exist, no TODOs)
- `node check-refs.cjs .main.txt` → **25/25**. The guard now *derives* its expected
  key set from `refs.bib` and the sources; it previously hardcoded a stale list and
  reported 18/31 against a correct build.

Seat keys: **A-Mn** = major finding n of panel A; R1/R2/R3 = methodology / domain /
safety seats; EIC = editor; DA = devil's advocate.

**Provenance note.** Panel B's per-seat attributions were recorded as findings came
in. **Panel A's were not preserved** in the written record — only its consolidated
major list — so those are attributed to the panel, not to a named seat. Both panels'
reports live in the session transcript, not on disk; the on-disk record is
`REVISION-2026-10-12.md`, which carries the evidence for each corrected number.

---

## 10. Independent verification of this response

The claims in §8 were checked by a **separate agent in a fresh context**, given only
the claim list and the compiled PDF, instructed to read the *rendered* text (not the
`.tex`) and to report `FALSE` where a claim did not hold. Staleness was ruled out by
comparing `main.pdf` mtime against every `.tex`.

**Result: 16 of 18 `CONFIRMED`, 1 `PARTIAL`, 1 `FALSE`.**

The `FALSE` verdict was **against this response, not the manuscript**. Claim 14
bundled three genuine removals (verified absent: "no false blocks", "compliance-cost
index", "after three attempts") with an assertion that the paper makes no unhedged
"structurally unbypassable" claim. It does — p.8 prints it bare. That item was never
claimed as fixed: it is **O13 in §8.2**, open for space. The error was in the
verification prompt, which overstated the ledger. Two related nuances, accepted:

- "three attempts" *is* printed (p.6), describing the post-write verifier's retry
  policy — a different statement from the unarchived claim removed in row 21;
- "oracle" *is* printed (p.9, "internal-oracle optima"), in §VI-B's inventory of what
  the paper does and does not report. That is the paper disclosing the source of its
  optima, not overclaiming them.

### The defect the checker found — and it was ours

`600` occurred **exactly once in the whole PDF: in the abstract.** The body accounts
for **509 checks over six runs** (237 + 272); the seventh execution is named without
a check count, so the 91 checks completing 600 were **not derivable from the
manuscript** — in a paper whose §VI-B states that counts are "re-derivable rather
than trusted". This number was introduced earlier in the same revision.

**Fixed.** The abstract now reads *"Across six campaign executions all 509 logged
checks pass"*. Verified: the body prints "79 checks per run on October 7–8 (237
total)" and "272 total" across six runs, so 509 is reconstructible from the paper
alone; `600` and "seven campaign executions" now occur zero times.

This is the one finding in the whole revision that self-checking missed and an
independent check caught.