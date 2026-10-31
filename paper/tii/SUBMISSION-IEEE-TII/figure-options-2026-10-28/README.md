# Fig. 1 and Fig. 5 alternatives

These six alternatives are ready for author selection and have **not** been inserted into the manuscript. Each is exported as editable SVG, vector PDF, and a 600-dpi PNG preview. Fig. 1 A is sized for a single column; Fig. 1 B/C and all Fig. 5 options are sized for the IEEE two-column width (7.16 in).

## Fig. 1 — system execution and evidence paths

- **A — `fig1_option_A_column-flow.pdf`:** vertical flow sized for one column; the stage-to-stage arrow gaps are lengthened while preserving a compact, familiar layout.
- **B — `fig1_option_B_horizontal-handoffs.pdf`:** horizontal handoffs emphasize where application policy and scene guards enter, then separate command receipt from a later DAQ sample.
- **C — `fig1_option_C_two-lane.pdf`:** separates the operation path from evidence collection. This is the clearest option for distinguishing a write/readback receipt from a later process observation; it is my recommended version.

**Proposed caption:** System execution path from production context through the agent, shared operation dispatcher, write handler, and device access. Application policy and scene targets or guards enter at the corresponding stages. Command receipts are returned from execution, whereas later process observations are acquired separately as DAQ records when available.

## Fig. 5 — interval admission and conditional approval

- **A — `fig5_option_A_origin-interval-approval.pdf`:** restrained Origin-style ranges and a concise approval flow.
- **B — `fig5_option_B_intersection-and-states.pdf`:** shades the common allowable interval and gives the clearest visual separation of the conditional decision states. This is my recommended version.
- **C — `fig5_option_C_grayscale.pdf`:** monochrome-safe option using line and marker distinctions rather than color alone.

Every option marks the interval values as illustrative values from a separate archived admission drill. They are not results from the four current process missions. Panel (b) is symbolic and contains no measured process values.

**Proposed caption:** (a) Illustrative intersection of hard, baseline, product, and recipe admission ranges, using values from a separate archived admission drill; the shaded bar denotes their common interval. (b) Symbolic conditional-approval path: a decline is recorded without dispatch, while approval triggers a recheck of authority, the production tuple, and applicable limits before dispatch. Panel (b) contains no measured process values.

The figure options follow IEEE's two-column width guidance and use embedded Arial fonts in vector PDFs. Text and arrows are deliberately redundant with color through labels, marker shapes, and line styles. Final placement, label size, caption wording, and float behavior should be checked after the selected version is inserted into the manuscript.

**Recommended pair:** Fig. 1 C + Fig. 5 B. Choose Fig. 1 A instead if keeping Fig. 1 in one column is more important than the extra room for the evidence lane.

# Fig. 6 alternatives

These alternatives present the same six pre-task observations and single post-trial probes from the two registered-harness simulator scenes. They are for selection and have not been inserted into the manuscript. The figure source reads pre-task values and target limits from `Supplementary-evidence-2026-10-27/EVIDENCE-OVERVIEW.md`; post-trial values are checked against `real-harness/R20-TRACE-SUMMARY.csv`. It stops if the six pairs or rounded overview values do not match the raw probe file.

No mean, error bar, fitted curve, interpolation, or independent replicate is added. The connectors identify within-task checkpoints only. They do not represent elapsed process trajectories or establish that the operation caused the measured change.

## Option A — Original-unit paired dot plot

`fig6_option_A_origin_paired.pdf` retains the measurement scale for each scene and shows the target interval behind each task row. It is the most direct comparison of each pre-task reading with that task's single probe. Hollow circles and filled squares distinguish checkpoints by both shape and fill; muted dashed connectors pair them.

**Proposed caption:** Pre-task process observations and single post-trial probes for six sequential registered-harness tasks in two simulated scenes. The shaded regions mark the scene-specific target bands. Each dashed line pairs the two checkpoints for one task. A small vertical offset separates paired markers; row position otherwise denotes task order and has no measurement meaning. The post-trial probe was taken 20 s after the receipt/readback checkpoint. Tasks in each scene shared a simulator instance and used synthetic approval and a local SQLite fallback. These checkpoints do not establish convergence, independent replication, or causation.

## Option B — Before/after slopegraph

`fig6_option_B_before_after_slope.pdf` places each pair on a categorical before/after axis and uses color to identify task pairs. It makes the direction of each observed change easy to scan while preserving original units. A small horizontal offset separates task pairs at each checkpoint; exact values remain in the evidence overview and the text. The slope is a checkpoint connector, not a continuous trajectory.

**Proposed caption:** Paired pre-task observations and single post-trial probes for six sequential registered-harness tasks in cast-film and annealing simulators. Shading marks each scene's target band. Lines connect checkpoints from the same task; color identifies task order, and endpoint markers distinguish pre-task observations from probes. Small horizontal offsets separate task pairs; the horizontal axis is categorical and does not encode elapsed time. The vertical axes show the original measurement units. The runner initiated each probe 20 s after the receipt/readback checkpoint. Tasks within a scene shared a simulator instance and used synthetic approval and a local SQLite fallback. The observations do not establish convergence, independent replication, or causation.

## Option C — Target-relative paired plot

`fig6_option_C_target_relative.pdf` uses the dimensionless coordinate `(v − L)/(U − L)`, where `v` is the observation and `L` and `U` are the lower and upper limits of that scene's target band. The shaded interval is therefore `[0, 1]` in both panels. Original values are annotated beside each marker. This highlights how far records lie from their own acceptable band, but it does not make the two process variables physically equivalent.

**Proposed caption:** Target-relative positions of pre-task observations and single post-trial probes for six sequential registered-harness tasks. For each scene, the horizontal coordinate is `(v − L)/(U − L)`, where `v` is the observed value and `L` and `U` are the scene-specific lower and upper target limits; `[0, 1]` is the target band. Labels give the original values in micrometers for cast film and degrees Celsius for annealing. Dashed lines pair checkpoints from one task. A small vertical offset separates paired markers; row position otherwise denotes task order and has no measurement meaning. The probes followed receipt/readback by 20 s. Tasks in each scene shared a simulator instance and used synthetic approval and a local SQLite fallback. The normalized points do not establish convergence, independent replication, or causation.

## Reproduction

The script uses the object-oriented Matplotlib API and exports vector PDF/SVG plus 600-dpi PNG previews at 7.16 in full width. It uses a restrained, color-vision-accessible palette and redundant marker encoding. From this folder:

```text
uv run --isolated --with "matplotlib==3.11.2" --with numpy python make_fig6_options.py
```

To use another copy of the evidence bundle, pass `--data-root PATH`. Select one option before replacing the current Fig. 6; then update its caption and check the compiled manuscript layout at the intended two-column size.
