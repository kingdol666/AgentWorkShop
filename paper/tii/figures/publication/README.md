# Publication figure package

Authoritative files: `fig1-intro`, `fig2-architecture`, `fig3-channel-loop`, `fig4-workflow`, `fig5-closedloop`, and `fig6-ablation`, each as HTML with inline SVG, standalone SVG, print PDF, and 300-dpi PNG.

Open `index.html` locally for all previews, format links, dimensions and source notes. No web server is required. The gallery is responsive; the publication figures intentionally retain their fixed physical dimensions.

## Rebuild

From repository root:

```powershell
python paper/tii/figures/publication/build_figures.py
node paper/tii/figures/publication/export_figures.mjs
python paper/tii/figures/publication/verify_figures.py
```

Python dependencies: Pillow, fonttools (with WOFF2 support), PyMuPDF for verification. Node dependency: Playwright with Chromium. The exporter searches local Playwright first, then the bundled Codex runtime; `PLAYWRIGHT_MODULE_PATH` can override the latter.

The embedded Calibri regular/bold subsets are included in this folder. If absent, the generator recreates them from Windows Calibri font files. All figure HTML and SVG files embed their font subsets directly; Figure 4 also embeds all screenshot crops as PNG data URIs. No remote assets are used. The gallery uses the included local font files.

Build output writes only within this directory. `benchmark-data.json` is read-only to these scripts and is owned by the scientist. Missing data should not be interpreted as an available quantitative result; only figures 1–4 can be generated without the data contract. The exporter prints the exact SVG at CSS page size through Chromium, without rasterizing the diagrams. Figure 4 intentionally contains original raster screenshot crops; its labels and framing remain vector.

## Provenance and scope

- Figures 1–3: new conceptual drawings informed by the manuscript; no universal claims about prior systems, engine containment, atomic stores, universal write checks, or guaranteed readback.
- Figure 3: independent human authority and auto backstop; `dcw_judge` records the agent verdict, does not compute it or actuate. Compensation is separate. No lifetime rollback-counter guarantee.
- Figure 4: actual archived `../walkthrough/` screenshots. Exact crop rectangles are in the build script. Device association is not agent capability binding. Team composition and records are archived interface details, not evidence of a new successful deployment or experiment.
- Figure 5: three seeds from the contract; raw per-evaluation trajectories, finite-grid reference, ratio based on mean of final two evaluations, no LLM. Build assertions recompute the ratio.
- Figure 6: complete frozen baseline, three repetitions per arm; each raw p50/p95 pair is plotted separately. Six fixed attacks yield 6/6, 4/6, 6/6, 4/6 in each repetition. No confidence intervals, pooled nine-repetition aggregates, mixed-extrema summaries, or equivalence claims.

`figure-manifest.json` records dimensions and the data-contract SHA-256. `export-qa.json` records loaded fonts, browser errors, text bounds and text-overlap checks. `verification.json` checks PDF pages, dimensions, font embedding, vector paths, and gallery links. Parent manuscript compilation and page-level QA remain separate.
