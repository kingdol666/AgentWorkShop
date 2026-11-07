# Figure 5: simulator endpoints and guard ablation

`fig5-editable.drawio` can be edited in diagrams.net. `render_figure5.py` reads the E6 paired records from `supplementary/S7-e6-e7-2026-11-07.zip` and guard-ablation records from `supplementary/S7-core.zip`, then refreshes the CSVs here, and regenerates the vector PDF, SVG, and 600-dpi PNG under `figures/`. Run `make_editable_drawio.py` after changing the data to refresh the editable plot.

Panel (a) shows only the nine valid fixed-horizon E6 pairs; the two C0 sampling-gap pairs and the separate pilot are excluded. Panel (b) shows technical guard-ablation repetitions, not independent trials; HTTP status does not prove a driver call. Consult the manuscript caption and S7 before changing labels or interpretation.
