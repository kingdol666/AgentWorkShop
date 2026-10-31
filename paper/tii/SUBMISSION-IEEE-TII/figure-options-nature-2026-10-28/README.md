# Fig. 1 and Fig. 5 — refined figure options

The six alternatives are author-selection drafts. They are not inserted into the manuscript. Each figure is exported as editable SVG, vector PDF, and 600-dpi PNG; the Matplotlib source and alignment/collision QA outputs are included alongside them.

## Figure contract

- **Fig. 1 claim:** registered-harness operations and direct operations converge at a shared named-operation dispatcher, while command receipts and later process observations remain distinct evidence records.
- **Fig. 1 archetype:** single-system execution schematic. A/B/C vary only the layout and evidence-lane emphasis; they do not add system behavior.
- **Fig. 5 claim:** configured value ranges constrain online admission, and a required human approval is followed by an authority/context/limit recheck before dispatch.
- **Fig. 5 archetype:** schematic-led mixed-modality composite. Panel a is a normalized conceptual interval intersection with no run-derived values; panel b is a symbolic execution path.
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

**Proposed caption:** (a) Conceptual intersection of hard, baseline, product, and recipe admission ranges; horizontal positions are schematic and do not encode experimental values. (b) Symbolic conditional-approval path: a decline is recorded without dispatch, while approval triggers a recheck of authority, production context, and applicable limits before dispatch.

The interval source coordinates are listed in `fig5_interval_source.csv` and are layout coordinates only. They do not encode measurements or a particular test run.

## Review notes

The flow colors are redundantly encoded with text, dash style, and separate evidence labels; the grayscale Fig. 5 option remains interpretable without hue. Fig. 5 panels have equal heights and aligned top edges; option B uses an explicit width exemption because panel a carries the interval evidence and panel b is explanatory. Before insertion, update the manuscript's `figure`/`figure*` environment to match the selected width, retain the proposed caption's evidence boundary, and compile to confirm the final float position and page count.

## Reproduction

```text
uv run --isolated --with "matplotlib==3.11.2" --with numpy python make_nature_options.py
```
