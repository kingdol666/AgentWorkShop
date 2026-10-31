# Supplementary experimental evidence

This document distinguishes the experiments by execution method and unit of analysis. All process values are from local simulators. The trials and missions below must not be pooled into a single success rate. The accompanying files are selected evidence, not a complete frozen runtime or a guarantee of reproducibility. `MANIFEST.json` identifies the source and delivery hash of each source-derived artifact and records transformations and omissions.

## A. Registered harness: R20

R20 used a v0.8.0 working-tree application, a registered OMP harness and the configured `glm-5.3-flash` model (`zhipu-coding-plan`). Application records associate each proposal with that harness and configuration; independent provider request/response logs were not retained. The controller was provided with current control and process readings, a target band, and three prevalidated candidate setpoints. The model's decision was therefore a selection among bounded candidates, not unconstrained optimization. Three tasks ran sequentially on a shared simulator instance in each scene. Each task used a separate task and production context; an isolated synthetic administrator approved the proposal.

| Scene and task | Pre-task process value | Target band | Setpoint, initial → selected | Single post-trial probe | Task state |
|---|---:|---:|---:|---:|---|
| Cast film 1 | 55.82 μm | 48–52 μm | 120 → 125 rpm | 45.69 μm | COMPLETED |
| Cast film 2 | 45.69 μm | 48–52 μm | 120 → 130 rpm | 46.69 μm | COMPLETED |
| Cast film 3 | 46.69 μm | 48–52 μm | 120 → 125 rpm | 45.69 μm | COMPLETED |
| Annealing 1 | 675.40 °C | 700–760 °C | 730 → 745 °C | 679.60 °C | COMPLETED |
| Annealing 2 | 678.30 °C | 700–760 °C | 730 → 745 °C | 677.70 °C | COMPLETED |
| Annealing 3 | 676.90 °C | 700–760 °C | 730 → 745 °C | 678.10 °C | COMPLETED |

Each task retained an approved proposal, one route-specific recipe trial with a 1/1 verified receipt, and an explicit run-tagged probe. **Every post-trial probe was below its target band.** The runner initiated a 20 s delay after the receipt/readback checkpoint, then performed one driver probe, ingest and tagged query; task state was checked afterward. No task-completion-to-probe interval was retained. SQLite was used as the local time-series fallback because isolated online queue and Timescale endpoints were unavailable. These are neither settled-state trajectories nor independent process replications and do not establish convergence, online data-pipeline behavior, human approval effectiveness or physical-plant performance.

`real-harness/R20-TRACE-JOINS.csv` preserves the source matrix's per-task task/approval/trial and expected/returned run relationships using synthetic pseudonyms. The equality between expected and returned run tags is preserved; these are transformed, not original identifiers. `R20-EVIDENCE-PROJECTION.json` contains application configuration, candidate selections and assertion outcomes; `R20-TRACE-SUMMARY.csv` contains the probe values. The original task and run identifiers in the source matrix were cross-checked against the application evidence before transformation. Readers cannot independently reconstruct the pseudonym mapping from this package, and the projection omits detailed request payloads. The access-controlled original records and the hash in `MANIFEST.json` remain necessary for a complete record-level audit. The 76 reported runner checks include cleanup and isolation assertions; they are not 76 independent experiments.

**Figure S1 (`figures/fig-r20-origin.pdf`).** One explicit run-tagged post-trial probe for each of the six R20 tasks; the green band is the configured target, and the horizontal position gives task order within each shared simulator instance, not elapsed time. Candidate values beneath each task are selected setpoints. Synthetic approval, receipt-anchored 20 s delay and SQLite fallback apply; provider request/response traces were not retained. No line or error bar implies trajectory, variance or independent replication.

## B. Four deterministic simulator missions

Each row is one deterministic, scenario-specific direct-node trajectory. No language model selected its setpoints. The target bands and final values below describe the mission-reported primary outcomes; sequential observations are not independent trials.

| Scenario | Primary outcome | Target band | Initial → mission-reported final | Missing or distinct evidence |
|---|---|---|---|---|
| Injection molding | Part weight | 32.15–32.85 g | 31.296 → 32.36 g | One trajectory, three record-linked writes. |
| BOPET film | Film thickness | 24.3–25.7 μm | 28.03 → 25.30 μm | One trajectory, four writes across three controls; the additional BOPET log is corroboration of this mission, not another run. |
| Continuous annealing | Hardness | 89–101 HV | 134.9 → 99.5 HV | The final value is separately reported; terminal tensile-strength and surface-defect readings are unavailable. |
| A2O wastewater | Dissolved oxygen | 2.8–4.0 mg/L | 0.194 → 3.54 mg/L | The final value is separately reported; the full final effluent vector is unavailable, and a simulator cost index is not measured operating cost. |

The original mission logs, figure data and source hashes are indexed in `four-missions/`. UUIDs in the delivered logs are pseudonymized, and the executed runtime snapshot was not completely retained. The integrated benchmark report did not record a real-LLM P5/P5b loop for this campaign. The scenarios therefore illustrate operation–observation sequences and reported primary values under these local configurations; they do not establish comparative benefit, physical-plant behavior, complete secondary constraint satisfaction or statistical repeatability.

**Figure S2 (`figures/fig-missions-origin.pdf`).** Ordered process observations for the four missions; horizontal positions indicate event order rather than elapsed time. Solid segments are ordering guides between adjacent structured observations, not continuous time-series traces. The reverted annealing candidate comes from event text; separately reported annealing and wastewater endpoints are unlinked. The green region shows each primary target band.

## C. Other checks and evidence boundaries

R21 is a fixed-call registered-task fixture, and R22 is a direct REST operation without a harness turn. Both used synthetic approvals and local probes in isolated environments; they do not establish route equivalence. The approval-context tests used mock drivers and simulated decisions and do not measure real human approval effectiveness or physical safety. Protocol connectivity and onboarding are separately executed simulator checks, not additional replications of either R20 or the four missions. The complete per-sample protocol trace was not retained.

Older OMP model transcripts are included under `historical-model-runs/` as historical material, not as current-version R20 repetitions. They include model-written statements inconsistent with the stated target limits: 53.00 exceeds the 52.8 μm upper bound and 51.03 falls below the 51.2 μm lower bound. These text statements must not be used as evidence of all-sample compliance. An older v0.7.67 multi-harness report is indexed but not distributed: it describes real OMP and Copilot tasks with a mock lead, four of five verified device receipts and six TUI failures in the final round, not a pass for all harnesses.

## D. Recreating the plots

The source programs and a basic panel-alignment helper are in `plotting/`. From the root of this bundle, using Python with matplotlib and a suitable sans-serif font:

```text
python plotting/plot-r20-origin.py --data-dir real-harness --output output/fig-r20-origin
python plotting/plot-missions-origin.py --data four-missions/figure-data/four-scenario-2026-09-28.json --output output/fig-missions-origin
```

Create the `output/` directory first. Font availability, rendering-library versions and PDF metadata can affect output bytes; reproduce the plotted data and visual content rather than assuming bitwise-identical exports. The original final figures underwent the full plotting audit; the bundled helper supplies only the portable basic panel-alignment check. The figure source code and outputs are individually hashed in the manifest.
