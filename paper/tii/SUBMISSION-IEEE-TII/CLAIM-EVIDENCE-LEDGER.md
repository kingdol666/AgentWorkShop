# Claim–evidence ledger (2026-10-17 revision)

Internal working document; not part of the manuscript. Every quantitative or
falsifiable claim in the paper is traced to the artifact that owns it. "Verified"
means the artifact was re-read during this revision, not merely cited.

| Paper claim | Value in paper | Artifact / command | Status |
|---|---|---|---|
| Q1 out-of-window probes rejected | 24/24 on five lines; 24+9=33 across two presets | `bench/results/20260921184204-10lc/report.md`; `run.json` checks | verified |
| Q1 ablation | full 18/18; no-readback 18/18; no-interlock 12/18; ungated 12/18 | `report.md` Table II; companion run | verified |
| Q1 write latency | median 19.3–47.8 ms; observed max 20.1–248.9 ms; n≈6/line | `report.md` per-protocol lines | verified; p95 removed |
| Q1 DAQ samples | 55 | `report.md` KPI | verified |
| Q2 single-node target | 200→204.704 °C; target 204.704±0.75; settled 204.70 | `report.md` mission block | verified |
| Q2 BOPET | 28.10→25.66 µm; window 25.0±0.7; margin 0.04 µm; structured check true | regenerated `report.md` (line 269 now “target attained: **yes**”); `run.json` `env.biax.missionAttained=true` | verified; report generator fixed |
| Q2 live engine turns | 156.3 s bounded write; 51.7 µm vs 52.0±0.8; 637.3 s recipe save | `report.md` agent-loop block | verified |
| Q3 closed loop | J0≈67.2; J* 89.894; J/J* 0.965–0.972 (seeds 42–44) | `report.md` closed-loop table | verified |
| Q4 four missions | structured checks true for all four; two boundary passes | `scenarios.json` results 0–3 | verified |
| Q4 injection molding | 31.25→32.17 g; window 32.5±0.35; margin 0.02 g | `scenarios.json` `results[0]` | verified |
| Q4 wastewater | DO 0.21→3.504 mg/L; window 3.4±0.6; pH 6.59→6.38 (limit 6.0) | `scenarios.json` `results[1]`; scenario `daqWindows` | verified |
| Q4 annealing | 134.52→100.08 HV; window 95±6; 0.92 HV inside | `scenarios.json` `results[2]` | verified |
| Q4 write economy | 2, 15, 5, 3 writes | `scenarios.json` mission writes | verified |
| Q5 campaign | nine runs; 782 assertions; zero failed checks | `docs/benchmarks/*` reports; Table III | verified |
| Q5 grades | 1 failed, 1 unverified, 2 promoted; six runs readback-verified | macros + hardening report | verified |
| Q5 live load | 34 provisioned lines; 17 running; 111–113 channels; 67 DAQ nodes | `results-macros.tex`; run reports | verified; text now uses 17/111–113 |
| Success-flag baseline | same publish-only receipt: success-flag = success; graded = unverified | `docs/audit/2026-10-17-ack-baseline.log` (22/22; D5 pass) | verified |
| No version/commit/run ID/harness fingerprint in PDF | — | `pdftotext main.pdf` grep for `v0.7`, `e692df1`, date/run patterns | verified; identifiers moved to reviewer package |
| Abstract length | 213 words | `main.tex` abstract extraction | verified (TII 150–250) |
| Page/ref budget | 10 pages; 30 references (TII initial-submission consolidation) | `tools/audit.py`; `check-refs.cjs` | verified |
| Double-blind | system name removed; title and Table I refer to “the platform” | `pdftotext main.pdf` grep for the former name | verified |

## Explicit non-claims (do not strengthen in text)

- Simulation-tier only; no physical-plant, HIL, or operator study.
- No optimization-benefit or safety-assurance claim.
- No prompt-injection campaign; the approval card is an injection surface and
  free text is display-only by construction, but not adversarially tested here.
- The verdict is not independently validated; a caller’s `keep` can stand down
  the record backstop. This remains a stated limitation.
- MES write acknowledgment is covered by route tests but the campaign archives
  MES in read mode only.

## Figure sizes

- All included figures print at 8 pt at their final placed width: Fig. 1
  (full width), Fig. 2 (column), Fig. 3(a)/(b) (side-by-side half-width
  panels), Fig. 4 (column), Fig. 5 (full width).
- No raster figure remains; all are vector, Arial-only, and free of CJK text.
- The previous 6 pt/7 pt exceptions are removed.
