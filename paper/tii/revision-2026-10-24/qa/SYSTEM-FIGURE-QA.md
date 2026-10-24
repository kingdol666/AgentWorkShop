# Figure 1–2 rebuild and author inspection

## Figure contracts

Figure 1 is a component schematic: replaceable task strategy reaches semantic
industrial I/O through governed execution, with shared production context and
linked evidence. Its three component groups are responsibilities, not a common
ordering of all execution checks. The core evidence is implementation semantics;
there are no measured values, statistics, or fabricated process observations.

Figure 2 compares two execution/evidence lifecycles. The left lane assigns
baseline capture, successful changed-value write/journal opening, observation,
and exploration-summary saving to their distinct stages. The right lane
separates candidate/recipe dispatch, batch evidence, caller observation, and a
separate caller update that saves a recipe. The two lanes are comparable
containers, not matched experimental samples.

Both figures use the existing Python/Matplotlib workflow. Their composition was
informed by two actual image-generation drafts; final geometry, connectors and
editable labels were rebuilt natively. The generated PNGs are not embedded in
the final PDF/SVG/EPS. The image drafts suggested an equipment-to-strategy
feedback path and a journal-opening note after the summary. Both semantic
misreadings were corrected during the vector rebuild.

## Rendered inspection

| Figure/panel | Unique role | Author inspection | Automated evidence |
|---|---|---|---|
| 1, strategy | Task/member, acquired/diagnostic/model evidence, candidate proposal | Short labels; the acquired-data feedback terminates at this component | Text/collision audit: 0 fail, 0 warn |
| 1, governance | Scope/limits, approval/recheck, dispatch/confirmation responsibilities | No arrows between these listed responsibilities; command and receipt arrows are distinct | Text/collision audit: 0 fail, 0 warn |
| 1, I/O/context/evidence | Separate DCW command and DAQ acquisition; shared context and joinable evidence | Context connects to all three groups. Evidence connects to strategy, governance and DAQ. Feedback starts at DAQ. Equipment/local protection is outside the platform boundary | Native paths present; raster objects: 0 |
| 2a | Node-intervention lifecycle | Journal condition appears within the governed-write card. No arrow opens it after summary. Platform observation and summary have separate cards | Lane geometry, label anchors and common edges: PASS |
| 2b | Recipe lifecycle | Batch precedes writes; per-parameter verification yields receipts. Caller observes and separately saves an accepted recipe | Lane geometry, label anchors and common edges: PASS |

Full color and grayscale previews were inspected. Spatial grouping, explicit
labels, and solid versus dashed links preserve meaning without relying on
blue/teal discrimination. No shadow, gradient, pictorial icon, result curve, or
decorative element is used. All text is horizontal. The longest runtime card
line is approximately 100.3 pt inside a 114-pt card, leaving 6.85 pt padding on
each side. Card headings remain 9 pt rather than shrinking to fit.

## Export and audit results

| Check | Figure 1 | Figure 2 |
|---|---|---|
| Exact MediaBox | 7.16 × 3.15 in | 3.50 × 3.55 in |
| Minimum actual PDF glyph size | 9.0 pt | 9.0 pt |
| Embedded fonts | Arial / Arial Bold, TrueType | Arial / Arial Bold, TrueType |
| Editable SVG text elements | 19 | 29 |
| Embedded raster images in PDF | 0 | 0 |
| Native vector paths | 35 | 25 |
| Text audit | exit 0 | exit 0 |
| Collision audit | exit 0; 0 fail / 0 warn | exit 0; 0 fail / 0 warn |
| Alignment | Not applicable: one component canvas | PASS: two aligned lanes, no exemptions |
| PNG preview | 4296 × 1890, 600 dpi | 2100 × 2130, 600 dpi |
| EPS | Type 42 embedded fonts, no raster operator | Type 42 embedded fonts, no raster operator |

The source validator reports 19 PASS, 2 WARN, 0 FAIL. The two warnings are
resolved by the export contract: (1) TIFF is not exported because PDF/EPS are
the vector submission assets and PNG is a preview; (2) its static detector does
not infer dimensions passed through the `canvas` helper, while fresh PDF
MediaBox inspection confirms the exact widths and heights above.

Reproduction: run `make-system-2026.py --only architecture runtime`. The default
QA directory now points to this 2026-10-24 revision. Fig. 3 admission generation
is opt-in and was not invoked or modified. Old script and active Figure 1–2
resources were copied into the revision's `before` folder before replacement.

The authoring pass supplies visual/semantic inspection and deterministic
checks, not final approval. Independent review and full-manuscript compilation
remain with the primary agent.
