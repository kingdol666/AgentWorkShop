# IEEE TII manuscript package

Self-contained LaTeX source and compiled PDF for the current manuscript.

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
