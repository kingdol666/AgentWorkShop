# Artifact Notes — run 20260921184204-10lc

This directory is the archived evidence snapshot for the TII manuscript's
Q1–Q4 tiers (see `resources/results-macros.tex` header in
`paper/tii/SUBMISSION-IEEE-TII/`).

## Contents

`report.md`, `run.json`, `scenarios-benchmark.md`, `scenarios.json`,
`metrics.csv`, `summary.json`, plus the generated `report.html`,
`scenarios-benchmark.html`, `dashboard.html`, `line-profile.json`.

`report.md` §"Artifact Manifest" lists four `*.log` files
(`agentteam-mission.log`, `agentteam-biax.log`, `agent-loop-omp.log`,
`agent-goal-loop-omp.log`) with byte sizes. Those console logs were
generated during the run but were excluded from this archive by the
repository's `.gitignore` `*.log` rule and no longer exist in the working
tree. Their checked outcomes (mission terminal states, wall-clock spans,
the two omp engine-turn results with provider/model) are recorded inside
`report.md`, `run.json` (phases P4c/P5/P5b evidence), `metrics.csv`, and
`scenarios.json`, which is what the manuscript cites.

Note added 2026-10-11 during the pre-submission consistency pass. The log
files themselves were not modified or removed by that pass; this note only
documents their absence.
