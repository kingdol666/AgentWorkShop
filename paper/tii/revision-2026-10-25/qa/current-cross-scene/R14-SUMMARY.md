# R14: exploratory signal-pair pilot

This report preserves the first isolated current-version two-scene run. It is
included because its outcomes informed the signal pairs used in R13. It is not
pooled with R13 or counted as replication.

The cast-film pilot paired screw speed with melt pressure. The annealing pilot
paired the zone-1 temperature setpoint with furnace temperature. Each scene
collected 582 DAQ points and built a lineage-bearing dataset (539 cast-film
rows; 538 annealing rows). Neither model met the configured optimization
eligibility and validation gates:

| Scene | Eligibility change statistic | Held-out model gates | Disposition |
|---|---|---|---|
| Cast film | 0.132956 | Test NRMSE 0.1119 > 0.10 | Rejected |
| Annealing | 0.086654 | Test NRMSE 0.5896 > 0.10; rollout improvement -15.0% < 20% | Rejected |

The R13 signal pairs were subsequently selected after inspecting the preset
signal mappings. R13 therefore characterizes platform integration and gate
behavior after exploratory selection; neither run is an unbiased estimate of
model performance. The raw report, dataset arrays/manifests, and fit artifacts
are retained in this evidence extension.
