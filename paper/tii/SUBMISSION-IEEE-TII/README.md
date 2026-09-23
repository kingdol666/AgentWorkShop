# IEEE TII manuscript package

Self-contained LaTeX source and compiled PDF for the current manuscript.

## Compile

Run from this directory with TeX Live (IEEEtran and the packages listed in `main.tex`):

```powershell
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

The source uses relative paths. Figures, `refs.bib`, and `results-macros.tex` are in `resources/`; manuscript sections are in `sections/`. The generated `main.pdf` is 10 pages.
