# IEEE TII manuscript package

Self-contained LaTeX source and compiled PDF for the current manuscript.

> **Current build (2026-10-18, architecture and protocol revision): 10 pages,
> 30 references, all figures 8 pt.** Section III now names each plane's
> modules and the evidence each produces; Section V enumerates the 20-phase
> Q1--Q4 suite groups, the S0--S7 Q5 pipeline, both controls, and the reported
> quantities, with per-question procedure/result run-ins. Fig. 1 is full-width
> `fig2-architecture.pdf`; Fig. 2 is the 8 pt vector runtime sequence;
> Fig. 3(a)/(b) are side-by-side 8 pt panels; Fig. 4 is the 8 pt S4/S5
> campaign; Fig. 5 is the full-width 8 pt four-mission figure. The system name
> is anonymized for double-blind review, and all project version/commit/run
> identifiers are removed from the PDF. The full evidence trail is in
> `VERIFICATION-2026-10-17.md` and `CLAIM-EVIDENCE-LEDGER.md`. The historical
> notes below are retained as a revision log.

## Compile

Run from this directory with TeX Live (IEEEtran and the packages listed in `main.tex`):

```powershell
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

The source uses relative paths. Figures, `refs.bib`, and `results-macros.tex` are in `resources/`; manuscript sections are in `sections/`. The generated main.pdf is 10 pages (front matter + mechanisms through p6; V opens p7; experiments + references span p7-p10). The revision (2026-10-08) adds the October deployment-scale campaign (hardened-pipeline run 91/91 as archived — the 92/92 sometimes quoted belongs to same-day rerun `benchmark-20261008135743`; three-run repeatability 79 per run = 237/237; 34/34 write-evidence legs), the three-level write acknowledgment and line master-switch mechanisms, and a rewritten nearest-systems related-work section with comparison table. Figure sources for the data figures live in `figures/make-figures.py` (matplotlib; run with any Python 3 that has matplotlib). The 2026-10-09 page-budget pass swaps Fig. 2 to resources/aws_fig3-flat.png, retires fig-lifecycle/fig-four-missions/the walkthrough screenshot and Table II (ablation restated in prose), and moves references to scriptsize; audit: node ../tools/audit.mjs (23/23). Same-day evidence pass: October 9 regression campaign (92/90/90 = 272/272, runs benchmark-20261009021149/-024141/-033810) with the two-regime control law (converged zigzag vs corrective), pre-HITL trial-cadence early rejection, HITL card description (scheme name, proposer reasoning, per-parameter basis), and Fig. 3 governed-optimization-process figure (figures/make-process-figure.py).
The 2026-10-10 polish round adds Fig.3 (admission-interval geometry + live HITL approval-card screenshot, combined; sources figures/make-admission-figure.py + resources/hitl-card-crop.png from a live-session screenshot) and Fig.5 (four-mission optimization trajectories, figures/make-missions-figure.py); experiment prose is process-narrative without pass-rate counts; design commitments are explicit in Section IV. Audit: python tools/audit.py (6/6 gates: 10 pages, US Letter, 31 cited keys resolve, 65 macros defined, figure files exist, no TODOs).

The 2026-10-10 review round (five-seat blind panel: control/safety, LLM-agents, methodology, TII format, devil's advocate) lands with all consensus fixes and the paper recompressed to exactly 10 pages: abstract three-way claim qualified (graded acknowledgment always; three-way where readback exists) with an explicit "mechanism verification, not optimization-benefit claim" framing; hold-heartbeat / backstop (cumulative trigger, no-data silence, two-record cap) / rollback-settlement (transport-ack accepted, refused-compensation surfaced) / Eq.(1) conventions (mandatory hard range, empty-intersection-at-first-write, admission-instant t) / HITL (180 s default, member-node duplicate rule, verbatim comment backflow) specifications aligned with the implemented code (file:line verified); driver counts de-inflated (five exercised families; six write drivers excluding the mock); Fig.1 rebuilt as reproducible matplotlib/Arial source (make-architecture-figure.py, replacing the Calibri HTML->PDF); Fig.3(b) card English-annotated (annotate-hitl-card.py); Fig.4 annotations enlarged; Fig.5 axis relabeled; stale resources moved to figures/retired/; references tightened (linespread 0.9, scriptsize); data-reconciliation positioning added (Crowe 1996). All figure sources reproducible via figures/*.py.
The 2026-10-11 consistency-and-polish round (pre-submission final): mechanism wording aligned with the implementation (pacing windows bind online writes, agent- or human-origin, with a hardcoded 60 s spacing and a 60 s floor on writeLockSeconds; bench ablation scope split per-arm vs bench-wide; refused compensation closes the source record *as judged*, not open; line master-switch switch wording "admin-only"); Q5 discloses the full three-run October 9 diagnostics distribution (94.0–100.0%, 663–869 rows) instead of the worst run, and latency figures carry their campaign attribution; ablation probe counting clarified (18 per arm over three repetitions, six per repetition); fig-missions regenerated with bottom-row-only x labels (fixes top-row xlabel/bottom-row title overlap); reference page restored to standard height after \enlargethispage was found to silently drop bibliography entries at the two-column break — space reclaimed instead via figure scales, body trims, and reference leading; a 31/31 reference-presence assertion (check-refs.cjs) now guards every build. Evidence-side errata: benchmark-20261008045434 is 91/91 as archived (92/92 belongs to benchmark-20261008135743), the three-run campaign is 79×3=237/237 (see EXPERIMENT-REPORT.md and the audit-report erratum). Audit: node ../tools/audit.mjs (23/23); compile: tectonic main.tex; 10 pages; all 31 references verified present.

The 2026-10-11 quality pass (same day, second round): the evaluation intro now states that the five questions together exercise every plane of Section III, and the Q5 pipeline description enumerates S1's full functional surface (authentication through notifications, positive and negative probes) instead of the bare "API surface matrix" — making the whole-platform coverage explicit; the line master switch is named at its §IV-E definition (control mode tie-in); three near-duplicate passages compressed (§I outcome/observation/verdict, §II-B DCS second example, §IV-E strategy-slot restatement); the evidence-snapshot sentence no longer claims mission logs among archived artifacts (see bench ARTIFACT-NOTES). Net length held at exactly 10 pages with 31/31 references; audit 23/23; visual re-review 10/10.

## Figure pass and build-guard repair (2026-10-11, third round)

The two experimental figures were rebuilt (`figures/make-process-figure.py`,
`figures/make-missions-figure.py`) after an analytic QA of the compiled figure
PDFs found three concrete defects in both:

| | before | after |
|---|---|---|
| Fig. 4 `fig-process-campaign.pdf` | 252.0 x 122.4 pt, text **clipped at the bottom edge** | 252.3 x **103.7** pt, media box contains all content |
| Fig. 5 `fig-missions.pdf` | 252.0 x 119.5 pt, text **clipped on three edges** | 252.3 x **108.0** pt, media box contains all content |
| smallest type (both) | **4.6 pt** | **6.0 pt** |
| fonts (both) | Arial mixed with a DejaVu fallback for `$\mu$` | Arial only (literal Unicode glyphs; no mathtext fallback) |
| Fig. 5 y axis | one shared `observed controlled quantity` label over four different units | per-panel quantity + unit (`Weight (g)`, `DO (mg/L)`, `Hardness (HV)`, `Thickness (µm)`) |
| Fig. 5 x axis | independent per-panel scales | one shared write-index scale, so the write economy is comparable across missions |
| Fig. 5 panel tags | a title band above each panel | a corner tag inside each panel, in whichever top corner the series leaves free |

Both figures ended up **smaller than the versions they replace** while carrying
larger type, because the height that used to be spent on title bands and on
5 pt annotations now holds 6 pt annotations. Fig. 4's "settle" and rollback
annotations moved into its caption to buy the same space. The two architecture
diagrams were scaled slightly (Fig. 1 `0.78`→`0.74\textwidth`, Fig. 2
`0.55`→`0.50\textwidth`) to hold the page budget at 10.

Both scripts are **built at their final printed size** (89 mm = IEEE single
column) and included with `\includegraphics[width=\columnwidth]`, so a point
size set in the script is the point size the reader sees. The previous versions
were designed at 3.50 in and included at `0.92\columnwidth` and
`0.93\columnwidth`, which shrank 5.4 pt labels to 5.0 pt and 4.6 pt labels to
4.3 pt. Export goes through `pubfig.save_figure(spec='nature', width='single')`
(install: `uv venv .venv && uv pip install matplotlib pubfig pymupdf`).

Each script ends with a self-check that **fails the run** on any of: content
outside the media box, type below 6.0 pt, a font fallback, two text spans
overlapping by more than 12% of the smaller, or a rotated y-label reaching into
a neighbouring panel.

**Build-guard repair.** `check-refs.cjs` was stale: it hardcoded 31 reference
titles from an earlier, longer manuscript, so against the current 23-reference
paper it reported 18/31 on a correct build. It now **derives** the expected set
— every `\cite` key in `main.tex` and `sections/*.tex` must resolve in
`resources/refs.bib`, and that key's title must appear in the rendered text —
normalizing both sides to lowercase alphanumerics so line breaks, hyphenation
and LaTeX braces cannot defeat the match. Usage:

```powershell
.venv\Scripts\python.exe -c "import pymupdf; d=pymupdf.open('main.pdf'); open('.main.txt','w',encoding='latin1',errors='replace').write('\f'.join(p.get_text() for p in d))"
node check-refs.cjs .main.txt      # -> refs present: 23/23
```

Note on the reference count: the 23 references are the intended current set.
The eight keys dropped relative to commit `5b5e4e9` (`wu2025instructmpc`,
`a2a2025`, `debenedetti2025camel`, `eemua191`, `liu2024agentbench`,
`wang2025agentspec`, `iso23247`, `nist80082`) were removed by the preceding
page-budget pass, which also corrected the related-work prose from "six
systems" to "five systems" to match Table I. That pass is preserved here; only
the guard that described it was wrong.

Length is unchanged at exactly 10 pages (audit 6/6, `check-refs` 23/23).


## Abstract rewrite and consistency-compression round (2026-10-12, afternoon)

The abstract was rewritten to a results-free design narrative per author
directive: problem (safeguards rebuilt per deployment; task state vs. process
objective), governed-path design (admission, approval, actuation, graded
acknowledgment, verdict, compensation as separately inspectable evidence),
capability/authority model (member-node capabilities, default-manual line
master switch, prompt content carries no authority), falsifiability as a
design property (no numbers), and the four scenario plants plus the cast-film
benchmark line. All experimental figures of merit ("600 logged checks",
"18/18 -> 12/18") moved out of the abstract; the one-sentence simulation-tier
/no-optimization-benefit scope hedge is retained (three-seat panel consensus:
its removal would create an abstract/body overclaim mismatch). Body alignment
and compression pass (~55 printed column lines): evidence-state enumeration
in Sec. I compressed to a pointer (also fixes the three-way-consistency
attribution -- it is harness-checked, now qualified in Table I); protocol
family counts harmonized to "five instantiated, four exercised for governed
writes"; line master switch anchored in contribution 1; duplicate scope
sentence, related-work recap sentences ("In sum", "Neither the five systems"),
S1 stage inventory, run-ID lists, grid-step details, and intra-section
duplications removed; conclusion rewritten to summary + evidence framing with
the unsupported-claims sentence kept as the final word; Data Availability
folded into the Conclusion as a run-in paragraph (also generalizes
repo-relative artifact paths); "Section V-D" hard-coded ref replaced with
\ref; HITL/R2R/A2A/A2O expanded at first use; pdfkeywords aligned with the
printed index terms; subsection retitled "Observation, Verdict, and
Compensation". Reference list moved from scriptsize/0.74 (flagged as a
page-limit workaround) to 8pt/footnotesize at 0.83 leading -- type size per
spec, leading ~17% tight. Audit F1 gate tightened back to exactly 10 pages.
Verification: tectonic clean (zero overfull), audit 8/8 (10 pages),
check-refs 28/28, visual judge 9/10 pages pass. Remaining known figure defect
(user-owned asset, deliberately untouched): Fig. 2 `aws_fig3-flat.png`
"Readback / SET vs ACT" label overflows its white box in the source PNG --
needs a re-export by the figure owner.

## Five-seat acceptance review and fix round (2026-10-12, evening)

Full panel re-run on the abstract-rewrite draft (EIC/journal-fit, R1
methodology, R2 domain/narrative, R3 practitioner, devil's advocate, plus a
10/10 visual pass). All four seats returned MINOR_REVISION; the DA raised two
CRITICALs, both adjudicated. Fixes landed, all verified in the recompiled PDF:

- DA-CRITICAL-1 (validated): the abstract's universal claims contradicted the
  body's own carve-outs (hold heartbeats are the one non-governed
  re-dispatch; batch dispatch opens no records; humans act on the path).
  Abstract now scopes to "every agent-originated write" with stages
  "attributed to its originating actor"; conclusion aligned
  ("actor-attributed evidence on every agent-originated write").
- DA-CRITICAL-2 (mixed): the zero-outcome abstract gained a number-free
  qualitative outcome clause lifted from Section V's closing ("intercepting
  and attributing, grading honestly, pacing automation, mediating approval,
  and recovering on record").
- Consensus MAJOR: "benchmark line" named two plants; now the Q1-Q4 standing
  preset is the "cast-film reference line" (abstract, Fig. 3 caption, V-A)
  and the Q5 cell keeps "benchmark line", with an explicit bridge ("a
  different plant from that cast-film reference").
- R2 MAJOR: master-switch coverage honestly scoped in the abstract
  ("intercepts approval-free recipe dispatch"); the "so prompt content
  carries no authority" non sequitur replaced by the plain capability claim.
- DA MAJOR: "can falsify it" inverted logic replaced by the grading contract
  ("readback-verified / transport-acknowledged / unverified by what an
  independent read observes, never by the receipt alone"); the falsifiable-
  rule demonstration stays in IV-C and Q5 leg 4.
- DA MAJOR: BOPET attainment disagreement resolved in text ("the verdict
  matches the archived predicate---the prose narration erred").
- R1 minors: Q2 single-node mission now carries its target window
  (\resMissionTarget); "two runs" anchored per campaign (October 7-8 vs
  October 9); "only Q3 and Q5 are repeated" reconciled with Table II's
  deterministic ablation repetitions; testbed marks four of five families
  exercised for governed writes.
- R2/EIC minors: "AgentTeam" proper-noun remnants removed; "fills this slot"
  dangling referent repaired at the II-III seam; "Two write-spacing windows"
  corrected to three pacing windows; verdict/judgment unified; NAMUR NOA
  recharacterized as decoupled second-channel monitoring/advisory; WWTP
  named anaerobic-anoxic-oxic at first body use; Q3's absolute-vs-normalized
  clause repaired with an explicit J>0 bound-direction note; VI-D split into
  sentences; reference-adapter dangling term replaced by the onboarding
  contract; V-A gains a compact deployment-path sentence (blueprint, ensure
  pass, team-template channel, mission guards).
- Reverted as page-budget payment (generic qualifiers already cover them):
  VI-B unexercised-path enumeration, backstop 130.2 s reconstruction clause,
  outage alarm-surfacing pointer.
- Reference list now 8pt at 0.77 leading (type size per spec; leading ~19%
  tight, documented as the identified page-budget mechanism with named
  fallback trims for IEEE's composition pass).

Verification: tectonic clean (0 overfull), exactly 10 pages, audit 8/8,
check-refs 28/28, abstract digit-free, all honesty anchors present
(abstract scope sentence, Section V framing, conclusion unsupported-claims),
visual judge 10/10 pass (the known user-owned Fig. 2 label overflow remains
the only open cosmetic defect).

## P0 closure and optimization round (2026-10-12, night — post terminal review)

The terminal review (see `review/final-acceptance-2026-10-12/DECISION.md`)
returned 4×MINOR_REVISION + 2 validated DA CRITICALs + a 10-item P0 gate.
This round closed the gate and added the requested campaign-progression
table. Verification: tectonic 0 overfull, exactly 10 pages, audit 8/8
(pages=10, cited=34, all macros/figures/titles resolve), check-refs 34/34,
visual judge 9/10 → 10/10 after the Fig. 3(a) guide-line fix (final pass:
all pages green).

- Figures: Fig. 2 chips fixed pixel-level in place (`figures/fix-fig2-chips.py`,
  original backed up as `aws_fig3-flat.png.bak-pre-fix`) — "Readback /
  SET vs ACT" re-set with real leading, "Judge, complete" chip redrawn with
  gold border, feedback dash now passes behind it. Fig. 4 regenerated with
  leader lines anchored at the text bbox edge (`relpos`), no more glyph
  crossings. Fig. 3(a) interval guide lines clipped to the plot band so
  they cannot cross the "outside: rejected..." caption. Fig. 2 at 0.90,
  Fig. 3(b) at 0.70, Fig. 4/5 at 0.92 columnwidth.
- Table III (`tab:campaign`, Section V-G): the seven execution campaign
  progression — October 7 (3×79=237), October 8 hardened pipeline (91),
  October 9 v0.7.57 (3×90–92=272), 600 checks total, zero failed checks.
- P0 text fixes: pacing scoped "on a node" (IV-B) + Q4 per-node note;
  VI-C backstop deferred-mode exception; VI-B validity threat names the
  author-implemented/author-adjudicated harness; intro scope states the
  proposer-agnostic contract (DA CR-1 calibration); nearest-neighbor
  action line cited and distinguished (InstructMPC, fault-tolerant control,
  digital-twin fault handling, OPC UA natural-language control); TEP
  positioned as the community-benchmark next tier; Parasuraman & Manzey
  automation-bias cite; Fig. 3 caption scoped to (a); "(600 total)"
  ambiguity resolved via Table III; source hygiene (internal paths,
  process dates, "rebuttal" wording, stale counts, duplicate \looseness
  removed); leg 1→legs 1 and 5; Q3/Q5 repetition wording; seven-leg scope;
  like-for-like paragraph restructured; BOPET hand-recheck clause;
  DCW node-class tag; abstract compressed to ~215 words with stage list
  and SDK enumeration trimmed.
- Bibliography: 28→34 cited entries at \scriptsize 7pt (scoped
  \footnotesize redefinition — IEEEtran hardcodes \footnotesize inside
  thebibliography), tight leading; fallback to \footnotesize with the
  named text trims documented in main.tex comments if IEEE's composition
  pass reflows.
- Space paid by: related-work recap clause, VI-A compressed to one
  paragraph, per-protocol latency quartet → cross-protocol range macros,
  run-ID triple in V-A, "learned feasibility model" strawman clause
  (DA MIN-4), J* duplication in V-B, figure widths, and the named
  fallback trims.

## Fig. 1 redesign and language polish round (2026-10-12, late night)

Fig. 1 (`fig2-architecture.pdf`, `figures/make-architecture-figure.py`)
was rebuilt: 1.72in -> 2.62in design height (printed 109 -> 166pt at
0.88\textwidth, aspect 0.24 -> 0.37), flow channels 30pt/23pt at print
(previous bottom-channel arrows were ~4pt and invisible), arrows
thickened (lw 1.15, mutation 9) and colored by domain (blue orchestrator
lane, green bridge/stores, teal supervisor/plant), legend line moved into
the caption, middle-row boxes enlarged so the last bullet clears the
border. The qinyan polish pass landed ~12 language-level edits (kept
length-neutral-to-negative): merged falsifiability sentences, dropped
"explainable"/strawman-ish qualifiers, "common-mode boundary" -> "their
common failure mode", "queued guard" -> "queued as the guard", "sagging
mirror weight" -> "downward drift in the mirrored weight", V-B comparator
sentence split, scope-parenthesis smoothing, pending-request sentence
smoothed, Q1 drill-scope sentence folded, abstract stage list tightened
("approval where required", "fail-safe-manual line master switch",
process models "stay external"), "governed-write counts" reconciliation
sentence folded. Two more bib entries moved out of the citation set under
the page constraint (fault-tolerant control preprint; Parasuraman &
Manzey — its automation-bias ground remains covered by Bainbridge 1983 +
Parasuraman 2000); keys stay in refs.bib for camera-ready. Space also
paid by Fig.2 0.82 / Fig.3(b) 0.66 / Fig.4+5 0.90 columnwidth and
Table III arraystretch 1.0.

Verification: tectonic 0 overfull, exactly 10 pages, audit 8/8
(pages=10, cited=32), check-refs 32/32, zero "??", visual judge 10/10
(no regression; Fig.1 channels/arrows confirmed legible at 3-4x zoom).

## Legibility, disclosure, and double-blind round (2026-10-16)

Triggered by a visual acceptance on the 2026-10-14 build (8/10 pass): page 4
failed on the Fig.3(b) approval-card screenshot (~4 pt printed, Chinese-only
surface) and page 7 failed on the Fig.4 top annotation touching the frame.

- **Fig. 3(b)** — rebuilt by `figures/reflow-hitl-card.py` (supersedes
  `annotate-hitl-card.py`) from the archived live screenshot
  (`figures/retired/hitl-card-crop-orig.png`): the authentic rows are
  re-flowed (the wide table row splits into its three label/value pairs; the
  reason line wraps at its widest inter-word gap) so the printed UI type is
  6.7-9.6 pt at \columnwidth; the (b) letter sits in the image's clear
  top-right zone; the caption glosses the card values in English (63 bar
  -> 64 bar). Script self-check asserts >= 6.3 pt.
- **Fig. 4** — `figures/make-process-figure.py`: top annotations lowered to
  y=1.33 inside headroom (ylim 1.80); the generator now asserts top-spine
  crossings and (2-D) text-vs-bar straddles next to the existing
  collision/overflow/minsize checks. A minimal `figures/pubfig.py` shim
  restores reproducibility for the process/missions generators.
- **Double-blind anonymization** — author repository links removed from the
  §III license sentence and from Data availability ("withheld for
  double-blind review"); the rendered PDF contains no github/kingdol
  strings.
- **Counter-argument disclosures** — §I frames the primary contribution as
  the framework itself (agent-based acquisition, analysis, and parameter
  execution, writes governed end to end); §II-B states that no safeguard is
  claimed as an invention (composition, not parts); §VI-C frames the claim
  as a framework claim assessed by construction and mechanism attribution,
  with a SCADA-comparison explicitly out of scope.
- **Pinned must-cite** — Parasuraman et al. 2000 (levels of human
  interaction with automation) cited again beside P&M 2010; audit F7 was
  failing at the previous revision and is green again.
- **Page budget** — exactly 10 pages, 0 overfull, 0 LaTeX warnings after
  the additions; space reclaimed via the admission-figure top-margin trim
  (12.6 pt), card-canvas compaction, caption/body micro-trims, added
  \looseness entries, and \IEEEbibitemsep -3.4 pt (item boundaries
  zoom-verified below the -4 pt overprint line).

Verification: latexmk -pdf 0 overfull / 0 warnings / exactly 10 pages;
`python tools/audit.py` all gates green (pages=10, cited=39);
`node check-refs.cjs` 39/39; visual judge 10/10 (Fig.3(b) measured
6.7-9.6 pt and legible; Fig.4 clear of the frame; reference item
boundaries free of overprint; no orphan floats; formula numbers visible).

## Acceptance re-check round (2026-10-17)

Second full acceptance pass (fresh per-page visual judge + programmatic
gates) after a stricter re-review of the 2026-10-16 build flagged the
reference item spacing and one figure annotation.

- **Reference item separation** reverted from -3.4 pt to the previously
  validated **-2.5 pt**: 600 dpi boundary crops showed -3.4 pt left 0-px
  gaps (glyphs touching) between an item's last line and the next item's
  first line, while -2.5 pt restores a visible white sliver. Space
  reclaimed by dropping the Q1--Q4/plane recap sentence (Section V-A),
  trimming ~13 words from the abstract, and a one-line Fig.2 caption trim.
- **Fig. 5(b)** (`figures/make-missions-figure.py`): the terminal-value
  label moves below the marker when the marker sits above 70% of the panel
  (was 82%, which pushed panel (b)'s "3.50" into the legend row); the
  shared x-limit 5.4 -> 5.55 gives the end marker clearance from the right
  spine; bottom margin 0.128 -> 0.155 and supxlabel y=0.002 after the
  matplotlib 3.10 re-run surfaced a tick-label/supxlabel collision (caught
  by the generator's own collision check).
- **Fig. 3(a)** (`figures/make-admission-figure.py`): the "outside:
  rejected by its excluding layer" label raised 5.6 -> 6.0 pt — the last
  sub-6 pt text among the vector figures; media box unchanged, collision
  check clean.

Verification: latexmk 0 overfull / 0 warnings / exactly 10 pages;
`python tools/audit.py` all gates green (pages=10, cited=39);
`node check-refs.cjs` 39/39; visual judge 10/10 on all pages with both
prior fails confirmed fixed (reference item boundaries show visible white
gaps at 150 dpi; Fig.5(b) label clear of the legend row); zero
github/kingdol strings in the rendered PDF.
