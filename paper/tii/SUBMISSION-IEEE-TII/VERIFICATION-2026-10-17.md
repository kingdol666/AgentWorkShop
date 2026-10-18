# Verification record — 2026-10-17 final TII revision

## Manuscript

- `main.pdf`: **10 pages**, US Letter, **0 overfull**, **0 undefined references**.
- `tools/audit.py`: **F1–F8 pass** (pages=10, cited=30).
- `check-refs.cjs`: **30/30** cited keys resolve and appear in the rendered PDF.
- Abstract: **214 words** (TII 150–250).
- **30 references**, matching the TII initial-submission consolidation.
- **Double-blind**: system name removed from title, abstract, Table I, and
  body; no author/repository identifiers in the PDF. The title is
  “A Governed Supervisory Execution Layer for LLM-Agent Plant Writes”.
- No `v0.7.x`, commit hash, run ID, or harness fingerprint in the PDF.

## Figures

| Figure | File | Placed type | Size / notes |
|---|---|---:|---|
| Fig. 1 | `resources/fig2-architecture.pdf` | **8.0 pt** | full width; Arial-only |
| Fig. 2 | `resources/fig-runtime.pdf` | **8.0 pt** | 89 mm vertical runtime sequence |
| Fig. 3(a) | `resources/fig-admission.pdf` | **8.0 pt** | side-by-side panel; label gutter |
| Fig. 3(b) | `resources/fig-hitl-card.pdf` | **8.0 pt** | English vector approval card |
| Fig. 4 | `resources/fig-process-campaign.pdf` | **8.0 pt** | S4/S5 lanes; no run ID |
| Fig. 5 | `resources/fig-missions.pdf` | **8.0 pt** | full-width four-panel figure |

`tools/audit-figures.py`: **PASS** (per-figure type floor 8.0 pt, Arial-only,
no CJK, media-height caps, raster DPI branch). No raster figure remains.

## Evidence

- BOPET archive: `bench/results/20260921184204-10lc/report.md` prints
  `target attained: **yes**`.
- Success-flag baseline: `docs/audit/2026-10-17-ack-baseline.md` (22/22;
  D5 success-flag=true vs graded=unverified).
- Claim–evidence ledger: `CLAIM-EVIDENCE-LEDGER.md`.
- Reference consolidation record: `REFERENCE-FALLBACK-30.md`.

## Commands

```bash
cd paper/tii/SUBMISSION-IEEE-TII
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
python tools/audit.py
python tools/audit-figures.py
python -c "import pymupdf; d=pymupdf.open('main.pdf'); open('.main.txt','w',encoding='latin1',errors='replace').write('\f'.join(p.get_text() for p in d))"
node check-refs.cjs .main.txt
```

Visual check: pages 1, 2, 3, 5, 7 and 9 rendered at 150–200 dpi; reference
item boundaries at 600 dpi show visible gaps (no overprint); Fig. 3(b)
reason/table collision re-check is clean.

## 2026-10-18 addendum — architecture and experiment-protocol exposition

Changes (text only; figures, references, and page count unchanged):

- §III now names each plane's modules and the evidence each produces
  (team: channels, tasks, memory, engine adapters, retrieval, analysis;
  integration: DAQ/DCW nodes, runtimes, drivers, gateway, MES modes;
  governance: binding authority, admission, approval queue, recipe dispatch,
  grader/verifier, verdict, compensation, backstop, journal; operations:
  line/product/recipe/run registries, versioned recipes, run ledger, ops log;
  extensibility: plugin registry, SDK, REST/MCP/A2A/CLI/TUI), and states what
  each subsection covers.
- §V-B is restructured into evidence unit, Q1–Q4 procedure (the 20 archived
  phases grouped by claim), Q5 procedure (S0–S7 plus campaign repetitions and
  the seven-leg suite), controls, and reported quantities.
- Q1–Q4 subsections gain procedure/result run-ins (Protocol closure, Drills,
  Ablation; Missions, Live engine turns; Closed loop; Four missions) so each
  question reads as setup → procedure → archived result.
- Redundant sentences removed to hold the 10-page budget: duplicated p95
  justification, repeated figure pointer, repeated live-load counts, and
  duplicated leg/grade wording.
- Campaign dates, the snapshot timestamp, and the unverified "four
  control-pair replays" claim are removed. The campaign is now identified by
  three passes (Table III), which preserves the baseline → grading →
  live-load progression without exposing internal run dates; seed 42 remains
  as an experimental parameter.

Verification:

- `main.pdf`: 10 pages, US Letter, 0 overfull, 0 undefined references.
- `tools/audit.py`: F1–F8 pass (pages=10, cited=30).
- `tools/audit-figures.py`: PASS (all figures 8.0 pt, Arial-only).
- `check-refs.cjs`: 30/30 cited keys present.
- Abstract: 214 words.
- `FILE-MANIFEST.json` regenerated (2026-10-18).
