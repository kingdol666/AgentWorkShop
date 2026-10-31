# CII submission checklist (2026-11-01)

## Files in this package

| File | Purpose | Status |
| --- | --- | --- |
| `main.pdf` | Anonymous manuscript, `elsarticle[review,12pt,a4paper]`, line-numbered | built, 46 pp |
| `main.tex` | LaTeX source of the anonymous manuscript | ready |
| `title-page.tex` / `title-page.pdf` | Author details, CRediT, competing interests, funding, acknowledgements | placeholders to fill |
| `highlights.tex` / `highlights.pdf` | 5 highlights, 68–79 characters each | ready |
| `figures/graphical-abstract.png` / `.pdf` | 1535×590 px, 300 dpi (≥1328×531) | ready |
| `figures/fig1-architecture.pdf` … `fig4-modeltier.pdf` | Vector figures; text ≥8 pt effective | ready |
| `resources/refs.bib` | 46 references, `elsarticle-num` | ready |
| `cover-letter.md` | Draft cover letter | author to adapt |

## CII requirements (verify in Editorial Manager)

- [ ] Double-anonymous: manuscript, figures, tables, references, and PDF
      metadata contain no author identity. **Done** in `main.pdf`.
- [ ] Separate title page with authors, affiliations, corresponding author,
      CRediT, competing interests, funding, acknowledgements. **Fill
      placeholders in `title-page.tex`.**
- [ ] Highlights: 3–5 bullets, ≤85 characters, separate editable file.
      **Done** (`highlights.tex`: 5 bullets, 68–79 chars).
- [ ] Graphical abstract: 1328×531 px minimum, 300 dpi, 5×13 cm.
      **Done** (`figures/graphical-abstract.png`, 1535×590).
- [ ] Abstract ≤250 words. **250 words.**
- [ ] Keywords ≤6. **6 keywords.**
- [ ] Regular paper length ~10,000 words (verify current guide). Body
      ~9.7k words; PDF ~12.2k including tables/references.
- [ ] Line numbers and review spacing. **Line numbers added; `review`
      option uses 1.5 spacing; if CII insists on double spacing, add
      `\usepackage{setspace}\doublespacing` and rebuild.**
- [ ] Figures: vector or ≥300 dpi; text ≥8 pt. **Effective figure text
      8.3–10.8 pt in the built PDF; figures are vector PDFs.**
- [ ] Tables: editable, caption above, readable font. **Tables tightened
      with single spacing; Table 3 uses compact columns.**
- [ ] References: `elsarticle-num` (numbered, square brackets). **Done.**
- [ ] Data availability statement. **Done.**
- [ ] Generative-AI declaration. **Done.**
- [ ] Cover letter. **Draft ready; confirm no concurrent submission.**
- [ ] Confirm no dual submission, especially if the manuscript was
      previously submitted to another journal (e.g., TII). **AUTHOR MUST
      CONFIRM.**

## Scientific risks that formatting cannot fix

1. **Simulator-only external validity.** All plant contact is
   simulator-backed; CII is application-oriented. A real pilot or a
   clearly framed industrial-testbed contribution is still needed.
2. **No baseline comparison** against AgentSpec/CaMeL/session-level policy
   engines on the same attack/legit workload.
3. **Single-run / small-n** ablation and case study; add repetitions or
   confidence intervals where possible.
4. **Human approval quality/workload** not measured.

## Build commands

```bash
cd paper/ci/SUBMISSION-CI
python figures/make_figures.py
python figures/make_graphical_abstract.py
pdflatex -interaction=nonstopmode -halt-on-error main.tex
bibtex main
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error title-page.tex
```
