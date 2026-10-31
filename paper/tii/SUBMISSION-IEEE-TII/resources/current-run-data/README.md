# Source data for the current-run figures

These CSV files are the figure-ready values extracted from the selected
integrated simulator execution, `bench/results/20261031034253-1dbo`. The
execution is the latest fully recorded integrated run with a PASS verdict in
the results directory; no failed run is used to produce manuscript claims or
plots.

- `p6-seeds.csv` contains the three fixed-seed objective records. `Jend` and
  `Jlast` are distinct fields from the runner; `Jend_over_Jstar` is the
  case-level ratio shown in Fig. 6. The three seeds are subcases of one
  pipeline execution, not independent system replications.
- `bopet-trace.csv` contains the initial thickness observation and three
  scripted post-write observations. The terminal observation is in the
  configured target band, but the task record remained open and unjudged.
- `figures/build_current_run_figures.py` regenerates the two result figures
  as PDF, SVG, and 600-dpi PNG files using Matplotlib.

The full selected-run records and delivery-time hashes are in
`Supplementary-File-S6-Evidence.zip`. Its hashes verify the delivered files;
they are not runtime signatures. This data folder excludes historical runs
and does not include physical-plant measurements.
