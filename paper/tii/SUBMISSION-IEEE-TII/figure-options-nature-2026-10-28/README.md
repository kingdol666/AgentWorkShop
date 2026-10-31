# Fig. 1 and Fig. 5 — refined figure options

The six alternatives are author-selection drafts. They are not inserted into the manuscript. Each figure is exported as editable SVG, vector PDF, and 600-dpi PNG; the Matplotlib source and alignment/collision QA outputs are included alongside them.

## Figure contract

- **Fig. 1 claim:** registered-harness operations and direct operations converge at a shared named-operation dispatcher, while command receipts and later process observations remain distinct evidence records.
- **Fig. 1 archetype:** single-system execution schematic. A/B/C vary only the layout and evidence-lane emphasis; they do not add system behavior.
- **Fig. 5 claim:** configured value ranges constrain online admission, and a required human approval is followed by an authority/context/limit recheck before dispatch.
- **Fig. 5 archetype:** schematic-led mixed-modality composite. Panel a is the interval evidence; panel b is a symbolic execution path. The interval values are from a separate archived admission drill, not the four current process missions. Panel b contains no measured process values.
- **Statistics:** none. These are limit ranges and a symbolic flow, not replicate summaries; no error bars or significance claims are appropriate.
- **Output:** IEEE TII two-column width 7.16 in for Fig. 1 B/C and all Fig. 5 alternatives; Fig. 1 A is 3.50 in single-column width. Editable SVG, embedded-font vector PDF, and 600-dpi PNG previews.

## Fig. 1 choices

- **A — `fig1_A_vertical_single_column.pdf`:** single-column vertical flow, with longer inter-stage arrows and separate receipt/sample outputs. It fits a one-column placement but is taller.
- **B — `fig1_B_horizontal_handoffs.pdf`:** compact horizontal sequence; the policy and guard inputs enter above their relevant stages.
- **C — `fig1_C_operation_and_evidence_lanes.pdf`:** separates the operation path from the evidence path. Recommended when the key point is that a command receipt is not a later process observation.

**Proposed caption:** Execution path from task context through the agent, shared operation dispatcher, route checks, and configured device access. Application policy and scene targets or guards enter at their respective stages. Command receipts are returned by execution, whereas subsequent process observations are recorded separately as DAQ samples when available.

## Fig. 5 choices

- **A — `fig5_A_balanced_ranges_and_approval.pdf`:** balanced panels for interval admission and the conditional approval flow.
- **B — `fig5_B_interval_hero_and_recheck.pdf`:** gives the common interval the dominant visual weight and keeps the approval path subordinate. Recommended for the clearest evidence hierarchy.
- **C — `fig5_C_grayscale_admission_flow.pdf`:** monochrome-safe line and fill treatment.

**Proposed caption:** (a) Intersection of the hard, baseline, product, and recipe admission ranges, using illustrative values from a separate archived rotational-speed admission drill; the highlighted interval is their common range. (b) Symbolic conditional-approval path: a decline is recorded without dispatch, while approval triggers a recheck of authority, the production tuple, and applicable limits before dispatch. Panel (b) contains no measured process values.

The interval source values are listed in `fig5_interval_source.csv`. They are ranges, not sample distributions. No values were inferred from the four current process missions. The common range is the exact intersection of the displayed intervals.

## Review notes

The flow colors are redundantly encoded with text, dash style, and separate evidence labels; the grayscale Fig. 5 option remains interpretable without hue. Fig. 5 panels have equal heights and aligned top edges; option B uses an explicit width exemption because panel a carries the interval evidence and panel b is explanatory. Before insertion, update the manuscript's `figure`/`figure*` environment to match the selected width, retain the proposed caption's evidence boundary, and compile to confirm the final float position and page count.

## QA summary

All six PDFs passed the rendered collision audit with zero text/arrow collisions or warnings. PDF text audits found no glyph below 6.75 pt. Fig. 5 alignment passed at 1.5 pt tolerance; the unequal-width hero layout has a recorded panel-width exemption. Fig. 1 is a single schematic panel, so panel alignment is not applicable. The source validator passed with one expected notice: no TIFF raster is included because the vector PDF is the primary output and the 600-dpi PNG is a preview.

## Reproduction

```text
uv run --isolated --with "matplotlib==3.11.2" --with numpy python make_nature_options.py
```
