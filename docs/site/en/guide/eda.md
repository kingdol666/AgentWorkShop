---
title: Data workbench & EDA studio
description: /data mirror·MES·ledger and /studio charts·pipeline·dashboards·golden/FDC/SPC/OCAP/VM — usage and the data boundary.
---

# Data workbench & EDA studio (/data · /studio)

> Shipping since v0.7.70. Both surfaces share the same [line-level permissions](/en/guide/line-permissions):
> charts are not data proxies — every read goes back through the server-authorized query path.

- **/data workbench** — look at data: line-scoped live mirror, MES console, export/batch ledger;
- **/studio EDA workbench** — use data: charts, pipeline post-processing, grid dashboards and a set of enterprise-grade EDA analyzers.

## Data workbench (/data)

Three tabs, always line-scoped:

| Tab | What it shows |
| --- | --- |
| Mirror | WS live mirror by line + time window (15 min / 1 h / 4 h / custom) + aggregation; scalars, array profiles and CCD images side by side |
| MES | MES console: interface messages and receipts per line |
| Ledger | Bulk export job ledger: every export produces manifest + merged.csv with trackable job status |

## EDA studio (/studio)

### Charts, templates, dashboards

- Seven chart types: `trend / bar / scatter / table / kpi / histogram / pipeline` (kpi and table are single-series);
- Two visibility levels: `private` (owner only) and `line` (bound to a line, read governed by line grants);
- Templates save a query configuration as a reusable asset; the board (/studio/board) arranges charts into a grid cockpit;
- Board cards re-query on every render; pipeline snapshot charts are **read-only replays** on the board.

### Golden phase reference

Build a reference profile on a 0–100% phase axis from historical good batches, overlay the running batch and
output a deviation score — "how close does this batch run to the golden sample", in one number.

### FDC / SPC / OCAP / VM

| Analyzer | What it does |
| --- | --- |
| FDC reference bands | Extract per-batch features and judge against reference bands, as background jobs (run + jobs query) |
| SPC control charts | Nelson rules 1–8 / I-MR / EWMA / CUSUM, with recompute |
| Commonality | Cross-batch common-factor search |
| OCAP dispositions | Disposition workflow records after an out-of-limit event |
| Virtual metrology (VM) | Model-predicted quality values; OOD (out-of-distribution) is rejected outright instead of guessed |
| Derived datasets | Freeze cleaned/aggregated results into new datasets for downstream analysis |

Runs support labels, giving the analyzers human anchors for good/bad batches.

### Pipeline charts (/studio/pipeline)

Pipeline charts chain "fetch → code post-process → plot" into one step:

1. **Online fetch** (same authorization as `/daq/query`) or **CSV import**;
2. **Code post-processing**: transform in the browser (filter, derived columns, resampling);
3. **Plot & online viewer**: rendered with ECharts; the viewer supports zoom and PNG export;
4. **Save**: as a template (configuration only), or as a **pipeline snapshot chart** (see the B4 boundary below).

## B4: charts store parameters, not data

Ordinary charts store only **query parameters** (nodes, time window, aggregation…); every open re-queries
through the same authorization as `/daq/query` — no data copies, no way around line permissions.

The single exception is the **pipeline snapshot**, a deliberately bounded escape hatch:

- `private` visibility only, must carry a `line_id` that matches the chart;
- the `rows` in `options` are a client-supplied saved view, **capped at 2000 rows**;
- reads still go through the chart's owner / line visibility; Studio shows snapshots with a read-only badge and no overwrite;
- non-pipeline charts allow only `template`-style configuration references in `options` — any other data/extension key is a 400.

## REST & agent surface

Everything the studio does is exposed as `/api/workshop/eda/**` REST routes (charts / dashboards / templates /
golden / features / spc / ocap / commonality / vm / derived / run-segments / runs). On the agent side,
data tools such as `daq_query` / `daq_export` read the same data plane, with references (nodes, lines, batches)
passing the unified preflight (tool-verify: argument shape + reference ownership).

## Acceptance

- End-to-end: `scripts/e2e-eda-pipeline.mjs`, 24/24, including B4 negatives
  (non-pipeline chart carrying data keys → 400; snapshot `line_id` mismatch → 400; missing rows → 400);
- Unit: `tests/chart-pipeline.test.ts` (series-to-rows reduction, dual-shape point compatibility).
