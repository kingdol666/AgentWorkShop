Supplementary Material S7 - LaTeX source (author reference)

Contents:
- Supplementary-File-S7.tex: source of Supplementary-File-S7-20261124.pdf (12 pages).
- resources/refs.bib: bibliography database used by the .tex file.
- resources/fig-s7-*.png: the four console screenshots referenced by the
  "Live runtime walk-through (November 24, 2026)" section; the same images are
  kept with their record files in ../live-runtime-20261124/.

Build (pdfLaTeX + BibTeX), e.g. on Overleaf or locally:
  pdflatex Supplementary-File-S7.tex
  bibtex Supplementary-File-S7
  pdflatex Supplementary-File-S7.tex
  pdflatex Supplementary-File-S7.tex  (rerun until references resolve)

Verified 2026-11-24: the rebuild is page-for-page identical to
Supplementary-File-S7-20261124.pdf (12 pages, all fonts embedded, no undefined
references). Graphik-free: only the standard article class and the packages
listed at the top of the .tex are needed.

This source and the S7 PDF are author-reference materials; TII's routine
initial submission requires only the anonymized manuscript PDF. Do not upload
this folder unless the editor requests supplementary files. The screenshots in
this source show the platform interface and product name and are therefore not
part of the anonymous reviewer package.
