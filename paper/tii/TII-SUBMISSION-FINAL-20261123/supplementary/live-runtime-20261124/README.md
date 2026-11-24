# Live runtime walk-through — 2026-11-24

Author-reference record of the live console walk-through described in Section “Live runtime
walk-through (November 24, 2026)” of `Supplementary-File-S7-20261124.pdf`.

**This folder is not part of the anonymous upload.** The screenshots show the platform's
interface and product name, so they stay out of the reviewer package; the companion
reviewer archive continues to withhold UI media for the same reason.

## What was run

| Item | Value |
|---|---|
| Platform build | package version 0.18.0, source commit `7e50642493f9babf052c4be774cac3a85ea366f4`, fresh home directory (`AW_MODE=home`) |
| Platform endpoint | `127.0.0.1:3090` (loopback only) |
| Simulator | repository PLC simulator, `127.0.0.1:4044`; one-line loopback bind patch recorded in `evidence/runtime-state.json` |
| Scenario | `injection-line` preset of `bench/lib/scenarios.mjs` (the manuscript's own scenario library), seed 42 |
| Provisioning | `provisionScenarioLine()` — 1 line, 1 product, 11 writable endpoints, 14 acquisition nodes, 1 recipe |
| Drivers | Modbus TCP, Modbus RTU, OPC UA, MQTT, HTTP — real driver stacks against the simulator |
| Agent identity | platform tool bridge with a deterministic mock harness; no language-model run |
| Human decisions | supplied by the operator of this run through the console approval card |

Not a replication of the November experiments: later source tree, warm-started plant,
no per-block reset, no physical device. It documents implemented behaviour, not process efficacy.

## Recorded outcomes

| # | Request (bar) | Outcome | Readback (bar) | Part weight (g) | Batch / record |
|---|---|---|---|---|---|
| 1 | 130.0 | Refused before approval (above the 110 bar node limit) | 45.0 | 31.25 | `evidence/invoke-reject.json` |
| 2 | 60.0 | Approved, then rejected by the write handler (15 bar > 1.8 bar step limit) | 45.0 | 31.25 | `rr-da6dfdeb` |
| 3 | 46.8 | Dispatched, readback verified | 46.8 | 31.31 | `rr-7b33651f` |
| 4 | 48.6 | Dispatched, readback verified | 48.6 | 31.40 | `rr-6d5e1c6d` |
| 5 | 50.4 | Dispatched, readback verified | 50.4 | 31.48 | `rr-9ef47779` |
| 6 | 52.2 | Dispatched, readback verified | 52.2 | 31.58 | `rr-997bc46c` |
| 7 | 54.0 | Dispatched, readback verified | 54.0 | 31.67 | `rr-1180d109` |

Two further approvals (`ap-160d261a`, `ap-10af521e`) were refused before dispatch because the
previous recipe trial was 145 s and 178 s old against a 300 s trial cadence.

Part-weight values are channel means over four 15 s buckets sampled 25 s after each outcome —
later process observations, not command receipts. Part weight stayed below the 32.00–32.30 g
band; no convergence or efficacy is claimed.

## Files

| File | Content |
|---|---|
| `fig-s7-1-approval-card.png` | structured approval card with two candidate packages, preflight result, rationale and experience reference |
| `fig-s7-2-write-history.png` | line write history: engineering value, raw value, acknowledgement, batch id |
| `fig-s7-3-part-weight-trend.png` | part-weight channel canvas, 15 s buckets, warm-start spike + five-step staircase |
| `fig-s7-4-line-console.png` | line console: 11 nodes, 5 node writes, 0 failed writes, setpoint/readback/step limit per card |
| `evidence/runtime-state.json` | build identity, ports, recorded PIDs, simulator patch |
| `evidence/seed.json` | simulated devices, provisioned entities, bindings, node limits, baseline means |
| `evidence/invoke-reject.json` | the out-of-range refusal, verbatim tool response |
| `evidence/invoke-main.json` | the approved-then-rejected 60 bar dispatch, verbatim tool response |
| `evidence/steps.json` | per-step request, approval, readback, part-weight means |
| `evidence/platform-record.json` | recipe runs with per-parameter results and ACK summaries, approval history, write history, sampled series |
| `evidence/daq-check.json` | DAQ infrastructure state, per-channel sample counts, DCW readbacks |
| `evidence/channel-mode.json`, `evidence/relabel.json` | channel mode binding and the English label pass (labels only, no setpoint or limit changed) |

## Reproducing

The instance and simulator are disposable and loopback-only; the launcher scripts live in the
author's scratch directory and are not part of this record. Re-running the sequence creates new
batches and identifiers and will not reproduce these values unless the plant state is restored.
The platform's own gates (1.8 bar step limit, 300 s trial cadence, range and window preflight)
are enforced by the build, not by the record.
