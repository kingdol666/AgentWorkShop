# Fig. 1-A and Fig. 2-A — placed in the manuscript

The author selected the **A** variants. Both are now installed as
`resources/fig-architecture-2026-9pt.pdf` (Fig. 1, page 3) and
`resources/fig-runtime-2026-9pt.pdf` (Fig. 2, page 5) and are referenced by
`main.tex` / `sections/system.tex` with updated captions.

Hard rules used for the rebuild:

1. every arrow connects an element edge to an element edge (no band-to-band stubs);
2. the shortest arrow is 12 pt; vertical inter-band arrows are 12–16 pt, and the
   harness→checks edge is one continuous 110 pt diagonal;
3. no arrow crosses text or runs under a card;
4. the package figure gate: **9.0 pt minimum type, Arial only, height ≤ 260 pt**,
   vector PDF with editable SVG.

Generator: `../make-hero-figures.py` (`fig1-a`, `fig2-a`). QA: `qa/export-summary.json`,
`qa/*.fit.json`, `qa/*.grayscale.png`, `qa/review/*.png`.

## Files

| File | Size | Role |
|---|---|---|
| `fig1-A-layered.pdf` / `.svg` / `.png` | 7.16 × 3.58 in (257.8 pt) | Fig. 1 system architecture |
| `fig2-A-flow.pdf` / `.svg` / `.png` | 7.16 × 3.58 in (257.8 pt) | Fig. 2 per-call software control flow |

Regenerate and install:

```bash
python figures/make-hero-figures.py --only fig1-a fig2-a
cp figures/hero-candidates/fig1-A-layered.pdf resources/fig-architecture-2026-9pt.pdf
cp figures/hero-candidates/fig2-A-flow.pdf     resources/fig-runtime-2026-9pt.pdf
```

## What Fig. 1-A shows

Six strata with one flow spine, plus a record-ownership rail:

- **ACCESS** — task/chat surfaces (CLI, web console, SDK, A2A) and direct
  operation surfaces (REST, stdio-MCP) as two distinct entries.
- **RUNTIME** — workspace/channel (task queue, memory) and the task engine with
  harness adapters; the prompt carries the turn context.
- **GOVERNANCE** — one bounded block with three internal divisions: the tool
  catalog (discovery, not a permission), the dispatch gate (scope, policy,
  S & P & G & B), and write admission (approval card with 180 s expiry;
  H ∩ B ∩ P ∩ R).
- **CONTEXT** — production context (line–product–recipe–run) and scene/semantic
  definitions (signals, guards, units). Dashed links denote configuration, not
  execution: up to the gate (the active tuple it binds) and down to the service
  handlers.
- **SERVICES** — a header states the rule (“route handlers select a service
  adapter”), above DAQ, write control, MES and analysis.
- **FIELD I/O** — configured protocol drivers (OPC UA, MQTT, Modbus) feeding the
  plant or simulator.
- **Right rail** — service-owned records: task journal and approvals, graded
  receipts and write audit, run-tagged samples, summaries, recipe versions;
  linked by actor and run identifiers where a route supplies them.
- **Gold lane** — the direct-operation route bypasses the runtime (no task, no
  harness turn) and enters the governance block from the side.
- **Footnote** — independent PLC/SIS protection remains external; solid =
  execution, dashed = configuration.

## What Fig. 2-A shows

The software control flow of one tool call:

- the harness row assembles the prompt and issues the call (single long edge);
- the shared dispatch checks test scope, policy, grant and binding
  (S & P & G & B); the **allowed?** decision either returns a tool error to the
  harness or selects a handler;
- the bar names the split: read route (left) or write route (right);
- the **read route** returns retrieval results and retains summary records;
- the **write route** runs route guards, requests approval when needed, takes the
  human decision, checks the tuple, applies the DCW admission interval, writes a
  bounded batch, grades the receipt (three outcomes) and records the observation;
  the tuple decision can refuse with no write;
- every result returns to the same harness turn (the loop closes on the right).

## Draft captions (as installed)

See `main.tex` (`fig:arch`) and `sections/system.tex` (`fig:runtime`) — both were
rewritten for the new layouts. The Fig. 1 caption notes that the stdio-MCP
operation route is shown but not tested, since the figure no longer carries an
internal “not tested” note.

## Verification performed

- `tools/audit-figures.py`: **PASS** — 9.00 pt minimum, Arial only,
  heights 257.8 pt (Fig. 1) and 257.8 pt (Fig. 2), all ≤ 260 pt.
- `audit_pdf_text.py --min-pt 8` and `audit_figure_collisions.py`: 0 FAIL / 0 WARN.
- Text-fit assertions at draw time: no string exceeds its container
  (`qa/*.fit.json`).
- No embedded raster images; fonts Type 42.
- Grayscale renders checked.
- Manuscript: 10 pages, 0 overfull boxes, 0 undefined references,
  `check-refs.cjs` PASS (31/31 citations), anonymous author metadata.

The B/C alternatives remain in this folder unchanged for reference; they were
designed at the earlier 7.16 × 3.6–3.9 in size and do **not** meet the 9 pt /
260 pt gate, so they are not drop-in candidates.
