# Experimental figure alternatives

These three alternatives are generated from the existing supplementary evidence. They are candidates for selection and are not inserted in the manuscript. All process observations are from local simulators.

## A — Four process sequences

`option-A_mission-sequences.pdf` shows the four scenario-specific deterministic missions, with events in order and the original process units. It is suitable when the goal is to show the operation–observation sequence and preserves the detail of the existing four-panel figure. It does not measure language-model decision performance.

**Proposed caption:** Process observations in four deterministic direct-node simulator missions, one trajectory per scene. The shaded band shows each scene's primary target. Dashed segments indicate the order of structured observations, not elapsed time or a continuous trajectory. The open triangle is the reverted annealing candidate reported in event text. Open squares are separately reported mission-final values for annealing and wastewater. No language model selected the mission setpoints.

## B — R20 pre-task observations and post-trial probes

`option-B_r20-paired-observations.pdf` shows the six tasks from the model-configured registered harness, retaining the pre-task and single post-trial process values in their original units. This is the recommended alternative if the main figure should emphasize the task-to-device execution path and its observed outcomes. All six post-trial probes lie below their bands; the figure does not imply that any task reached steady state.

**Proposed caption:** Pre-task observations and single post-trial probes for six sequential R20 registered-harness tasks in two local simulator scenes. Shading shows the target band. Task numbers denote execution order within each shared simulator instance. Dashed connectors pair each task's pre-task observation with its single post-trial probe; a small vertical offset separates the markers and has no measurement meaning. The probe delay was 20 s after the receipt/readback checkpoint. The tests used synthetic approval and a SQLite fallback; independent model-provider request and response logs were not retained. These points do not establish convergence or independent replication.

## C — Distinct evidence on a common target-relative display

`option-C_distinct-evidence.pdf` places deterministic mission observations and R20 probes in separate panels. Each x position is calculated as `(value − target center) / target half-width`; thus −1 to +1 denotes each observation's own target band. This is a compact overview, but the two panels use different variables and setups and are not a matched performance comparison. Actual R20 values and units are printed alongside the tasks.

**Proposed caption:** Target-relative positions in two distinct local-simulator evaluations. (a) Initial and final primary values in four deterministic direct-node missions. Open squares denote separately reported final values for annealing and wastewater; these endpoints are not connected to the structured observations. (b) One post-trial probe for each of six sequential R20 registered-harness tasks. The dimensionless coordinate is `(v − c)/h`, where `v` is the observed value, `c` is the scene-specific target center, and `h` is its half-width; the shaded interval is each record's own target band. The panels represent different variables and setups and do not constitute a matched performance comparison. The R20 tasks shared a simulator instance within each scene and used synthetic approval and a SQLite fallback.

## Recreate and use

The script reads `four-missions/figure-data/four-scenario-2026-09-28.json`, `real-harness/R20-TRACE-SUMMARY.csv`, and the six pre-task values in `EVIDENCE-OVERVIEW.md` from the adjacent `Supplementary-evidence-2026-10-27` directory. Its `--data-root` argument can point to another copy of that evidence bundle. It generates a 350-dpi PNG preview, vector PDF, and SVG for each option.

```text
python make_figure_options.py
```

For a selected two-column figure, the inclusion pattern is:

```latex
\begin{figure*}[!t]
  \centering
  \includegraphics[width=\textwidth]{figure-options-2026-10-27/option-B_r20-paired-observations.pdf}
  \caption{Insert the selected evidence-bounded caption above.}
  \label{fig:selected-results}
\end{figure*}
```

Each option is designed for its native 7.16-inch full-width size; reducing it to a single column would reduce the 8–9 pt lettering below the intended print size. Recheck the page layout after a figure is selected.
