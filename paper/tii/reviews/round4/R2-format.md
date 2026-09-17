# Round 4 Review — Reviewer 2 (IEEE TII Format and Presentation)

**Manuscript:** AgentWorkShop: Node-Native Integration of Multi-Agent Teams for Industrial Supervisory Control
**Round:** 4 (independent review) | **Date:** 2026-09-16
**Material examined:** rendered pages `_rev4/p-01.png`–`p-12.png` (12 pp.), plus high-DPI re-renders (400–900 dpi) of Fig. 4–7 and Tables I/II/IV; sources `main.tex`, `sections/*.tex`, `refs.bib`, `main.log`, `main.blg`, `main.bbl`, `main.aux`.

---

## 1. Automated / mechanical verification (all PASS)

- **Compile health:** `main.log` contains **0 Overfull hbox**, 0 undefined references, 0 multiply-defined labels, 0 citations warnings. `main.blg`: BibTeX 0 warnings, 30 entries used. Clean build.
- **Page count:** 12 pages ≤ 14 (TII limit). Pass.
- **Layout:** two-column IEEEtran `[journal]`; running head correct; `\IEEEpeerreviewmaketitle` used; figures captioned below, tables captioned above (verified for all 7 figures and 4 tables). Pass.
- **Figure/table numbering:** Fig. 1 (p.2, full-width) → Fig. 2 (p.3) → Fig. 3 (p.5) → Fig. 4 (p.7) → Fig. 5 (p.9) → Fig. 6 (p.9) → Fig. 7 (p.10); Tables I (p.7) → II (p.8) → III (p.9) → IV (p.10). Strictly sequential; every float is referenced in text (`\ref` verified for all 7 figure labels, 4 table labels, Algorithm 1). Pass.
- **Abstract:** single paragraph, **273 words** — within 150–300. Index terms: 6, present. Pass.
- **Sectioning:** I Introduction, II Related Work (A–C), III System Architecture (A–C), IV Core Mechanisms (A–G), V Benchmark Evaluation (A–G), VI Discussion (A–B), VII Conclusion. Automatic IEEEtran numbering correct; no orphaned headings at column breaks observed on any page. Pass.
- **Equations:** (1)–(3) numbered, sequential, punctuated correctly (eq. (1) terminates with period inside `cases`; eq. (2) trailing comma before "where"; eq. (3) period). Pass.
- **References:** 30 bibitems, all cited, no orphans in the rendered bibliography (refs.bib contains 65 entries; the 35 uncited entries never reach the .bbl — harmless, but see finding 11). IEEE style consistent; arXiv/standard entries formatted per IEEEtran.bst. Pass.
- **Algorithm 1:** correct `algorithm`/`algpseudocode` float, caption above, referenced in IV-C. Pass.

## 2. Findings

**[MAJOR] 1. New Fig. 6 (real-LLM agent trace): annotation collisions at the right edge.**
Verified at 900 dpi: annotation **(4) "judge: keep (evidence-cited)" is printed on top of the data** — the text overlaps the PV markers and the red setpoint dashes near the last two data points, the leader arrow cuts through the word "judge", and the closing parenthesis of "(evidence-cited)" is **clipped by the right axis spine** (bisected by the frame). Additionally, the second line of annotation (3), "(1 s→15 s bucket)", **straddles the top axis frame** with tick marks poking through the glyphs. This corner is the visual payoff of the paper's headline new figure and currently reads as a smudge at print size. Fix: move annotation (4) into empty space below the band (right-center is free), shorten to "(4) judge: keep" with the evidence detail already in the caption, keep all annotation text fully inside or fully outside the frame, and route the arrow around the text.

**[MAJOR] 2. Plot-style inconsistency: Figs. 5 and 7 vs Fig. 6.**
Figs. 5 and 7 are matplotlib-styled (sans-serif fonts, open frame without top/right spines, light horizontal gridlines, colored legend text, bold in-panel titles), while Fig. 6 uses the pgfplots `tii` style declared in `main.tex` (boxed frame, inward major+minor ticks, serif/CM fonts, black text). The three result plots are the paper's evidence core, and Fig. 5/6 sit side-by-side on p.9 where the mismatch is unmistakable. Fig. 5 additionally carries (i) a bold in-figure title "Fixed-controller loop · no LLM" that duplicates the caption's role, and (ii) a two-line in-figure note ("J_end = mean of evaluations at iterations 1 and 2. J_end / W* = 0.970–0.972; not a final-point ratio.") that **verbatim-duplicates the caption** and uses literal `J_end` underscore notation while the text uses $J_{\rm end}$. Harmonize all three plots on one style (recommended: restyle Figs. 5/7 to the declared `tii` norms) and delete the redundant in-figure note.

**[MAJOR] 3. Anonymity is broken by artifact URLs; footnote contains an unresolved TODO.**
The paper is anonymized ("Anonymous Authors"), but footnote 1 (p.11, `sections/discussion.tex:15`) links `github.com/kingdol666/...` — an identity-bearing account — and then states "A frozen anonymous artifact and archival identifier **must be prepared** for the applicable submission stage." This is an open pre-submission action item visible in the manuscript itself. For a double-blind round this is disqualifying as-is; even for single-blind TII the TODO sentence should not appear. Fix: create the anonymized/frozen artifact (e.g., Zenodo anonymized mirror or anonymous.4open.science), or strip the footnote to a "artifact available upon publication" statement before submission.

**[MINOR] 4. "Figure" spelled out at sentence starts vs "Fig." elsewhere.**
`sections/evaluation.tex:78, 93, 121` use "Figure 5 shows…", "Figure 6 reconstructs…", "Figure 7 uses…"; all other references use "Fig. X". The IEEE style manual requires "Fig." even at the beginning of a sentence (tables always "Table"). Unify to "Fig.".

**[MINOR] 5. Fig. 6: the advertised "setpoint step" is nearly invisible at print size.**
Verified at 900 dpi that the setpoint line does step 200→197.48 °C at the write time, but 2.5 °C on a ≈40–215 °C axis is <1.5 % of the axis height (well under 1 mm in print), while the caption lists "setpoint step" as one of the figure's three visual elements. Consider a broken-axis or post-write inset zoom, or add an explicit marker/short bracket at the step.

**[MINOR] 6. Fig. 4 contains a Chinese-language UI element.**
Panel 1 shows a "＋ 添加节点" button (Chinese for "add node") in an otherwise English figure/paper. Re-crop from an English locale or add a translation in the caption.

**[MINOR] 7. Fig. 3 numbering "1 / 5 Observe" is cryptic.**
Boxes are numbered 1, 2, 3, 4, 6, 7 with the left box labeled "1 / 5 Observe"; the shared numeral (observation at both step 1 and step 5) is nowhere explained in the caption, so readers will hunt for a missing box 5. Split the label or add one caption clause.

**[MINOR] 8. Redundancy: the same disclaimers recur far more than twice.**
The brief's redundancy test fails in several places: (i) the non-atomicity qualifier appears ~7× (Intro ¶2, III ¶1, Fig. 2 caption, IV-C ×2, VI-B, VII); (ii) the readback caveat appears twice inside a single paragraph (`sections/mechanisms.tex:48`: "not proof that the process has reached…" and "does not establish measured agreement") and again in IV-E and VI-A; (iii) "single-run capability tests, not optimization-quality comparisons" appears verbatim in the abstract and in the Table III caption. Across the paper there are 60+ "X, not Y / rather than" hedges. The evidentiary scoping is a strength, but each claim should be capped at ~2 occurrences; trim the duplicates (≈0.25 column recoverable).

**[MINOR] 9. Last page unbalanced: `\IEEEtriggeratref{22}` isolates [21].**
On p.12 the left column contains only [21] while the right column holds [22]–[30] — worse than no trigger. Move the trigger to ≈ref 26 (or drop it) so the final columns balance.

**[MINOR] 10. Figure source filenames are off-by-one vs printed numbers.**
`figures/publication/fig7-agenttrace.pdf` is printed as Fig. 6, and `fig6-ablation.pdf` as Fig. 7 (`sections/evaluation.tex:99,129`). Output is correct (refs resolve), but the naming is a maintenance hazard for the camera-ready stage.

**[MINOR] 11. Eq. (2) bundles a definition and a constraint.**
`τ_n = max(...), |v_rb − v| ≤ τ_n, (2)` joins two statements with `\qquad` and a single comma; insert "and" or move the constraint inline. (Cosmetic; punctuation itself is correct.)

**[MINOR] 12. Nonstandard "Disclosure" section.**
TII has no "Disclosure" section; the AI-assistance statement is good practice but should be folded into an Acknowledgment footnote or formatted per the venue's AI-policy instructions at submission. Related: `Anonymous Authors` + the `\markboth` "Working Manuscript … Format" header are placeholders that must be resolved per TII's single-blind policy at submission time.

## 3. Story flow (seat-specific assessment)

Title → abstract → I (problem + 3 contributions) → II (positioning vs. orchestration frameworks, ISA-88/95, InstructMPC, benchmarks) → III (node/channel/run architecture) → IV (six mechanisms + Algorithm 1 + HITL) → V (evidence units, governance, closed-loop, agent-team + real-LLM loop, ablation, historical campaigns, reproducibility) → VI (claims/boundaries) → VII (conclusion). Each section earns its place; IV's seven subsections are long but each maps to a mechanism promised in the contributions, and V's evidence-units framing (Table I) is the paper's best structural device. Nothing essential is missing for the TII scope; the only cut candidate is the redundant qualifier text (finding 8) and possibly the IV-A/III overlap on bindings. The new Fig. 6/Sec. V-D real-LLM loop is well integrated (caption self-contained, trace numbers consistent with text: 197.48/197.5 °C, 199.41–200.10 °C, 132 s sentinel).

## 4. Recommendation

**MINOR REVISION.**

Justification: the manuscript is mechanically excellent for a TII submission — clean compile (0 overfull, 0 undefined), correct IEEEtran structure, abstract at 273 words, sequential and fully referenced floats, correct caption placement, consistent IEEE references with no orphans, 12/14 pages. All remaining defects are presentation-level and localized: the new Fig. 6 needs an annotation-cleanup pass (finding 1), Figs. 5/7 need style harmonization with Fig. 6 (finding 2), and the anonymity footnote must be resolved before this leaves the lab (finding 3). No finding requires re-experimentation or restructuring; all are addressable within one minor-revision cycle.

**Top-3 improvements (priority order):**
1. **Repair Fig. 6's right edge** — relocate annotation (4) off the data, un-clip "(evidence-cited)" from the axis spine, and lift annotation (3)'s second line off the top frame; consider an inset so the caption's "setpoint step" is actually visible.
2. **Harmonize Figs. 5/7 to the declared `tii` plot style** (boxed frame, inward ticks, serif fonts, black legend text) and delete Fig. 5's in-figure title and duplicated J_end note.
3. **Resolve the artifact-anonymity footnote** — replace the `kingdol666` GitHub links and the "must be prepared" TODO with a frozen anonymous archive DOI (and set `Fig.` at sentence starts, rebalance p.12 while at it).
