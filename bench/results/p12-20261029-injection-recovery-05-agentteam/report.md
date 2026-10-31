# P12 AgentTeam episode p12-20261029-injection-recovery-05

> PLC simulator / production-like scenario / not physical plant.

- Qualification: **PASS**
- Workflow outcome: **FAIL**
- Evidence integrity: **FAIL**
- Scene: injection; Harness: omp; Team: lead + 2 workers
- All tasks terminal=true; pending approvals=0; designated workers have completed delegated tasks=false
- Task state: CANCELED; PV: 31.28 → 31.27 g; target 32.5±0.35
- Baseline out-of-spec quality guards: sink-mark=2.121 (limit 1.5, tolerance 0.27)
- All final guards within fresh registered limits: false/true
- Fresh post-goal PV sample pair: true
- Goal-period changed anchors / verified reads / approved writes: 0/0/0
- Source completeness: runner finalization followed isolated AW shutdown; late raw records=8; taskless tool events=8; final log stable=true (10043 ms)
- Tool events/pairs: 34/11; unmatched starts/ends: 0/0; missing identity=8
- Model/provider: lm-studio/qwen3.5-9b-32k; credential reference: none:a303533a834bfdf12558be7142e6fcd2a8082c963d8ccf67796aa1ab36772902
- Source commit: 1f30de698cc004c41d819d82517b8e6f9d3355c2; dirty hash: cba4a514e7c880e3341e5e5cd9842df7747ec7ea8e23e96e2ca9765d42c3bf3f
- Simulator commit: d47eb7c0a7ae5e84d306a332d64844e4ea2499ac; dirty/tree hash: de494b2b3aef65a4cb27b0a396d364218168b175dc6d84013dccd166a40247dd; shadow copy verified=true
- Event source shutdown verified=false; offline evidence finalization required=true
- Timing basis: platform DAQ API point.at as Unix epoch milliseconds; freshness is two-sided; no cross-host clock-skew estimate or server cursor is available.
- Post-run simulator reset: manual operator closure only; see operator-reset.template.json (not a control-performance endpoint).
- Stop reason: none

The run is one injection engineering feasibility episode and is not a powered comparison. No P0–P11 or historical run is pooled into this denominator. Review `reconciliation.json` and frozen raw evidence before manuscript use.

## Evidence finalization

The isolated AW listener was confirmed stopped before the raw event log was frozen. The final SHA-256 was recomputed from all 35 raw event records. The earlier package had 27 normalized records; 8 records were appended after that snapshot. The earlier raw hash matches the final raw hash: false. Taskless tool event records: 8.
