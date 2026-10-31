# P12 AgentTeam episode p12-20261030173217-8f6e4715

> PLC simulator / production-like scenario / not physical plant.

- Qualification: **PASS**
- Workflow outcome: **FAIL**
- Evidence integrity: **FAIL**
- Scene: injection; Harness: omp; Team: lead + 2 workers
- All tasks terminal=true; pending approvals=0; designated workers have completed delegated tasks=false
- Platform dispatch verified to both designated workers=false; unapproved Harness tool calls=9; actor-role mismatches=0
- Task state: CANCELED; PV: 31.28 → 31.36 g; target 32.5±0.35
- Baseline out-of-spec quality guards: sink-mark=2.121 (limit 1.5, tolerance 0.27)
- All final guards within fresh registered limits: false/false
- Fresh post-goal PV sample pair: false
- Goal-period changed anchors / verified reads / approved writes: 3/3/0
- Source completeness: runner finalization followed isolated AW shutdown; late raw records=28; taskless tool events=97; final log stable=true (10081 ms)
- Tool events/pairs: 152/75; unmatched starts/ends: 2/0; missing identity=97
- Model/provider: lm-studio/qwen3.5-9b-64k; credential reference: none:a303533a834bfdf12558be7142e6fcd2a8082c963d8ccf67796aa1ab36772902
- Source commit: 60fa983e93a85f9a97728f96dafab5bd1754d292; dirty hash: 9ff33b18d1eecf5e33b5456d64f7c4d95d4832d9b42548a712b625107b33ddc5
- Simulator commit: d47eb7c0a7ae5e84d306a332d64844e4ea2499ac; dirty/tree hash: de494b2b3aef65a4cb27b0a396d364218168b175dc6d84013dccd166a40247dd; shadow copy verified=true
- Event source shutdown verified=false; offline evidence finalization required=true
- Timing basis: platform DAQ API point.at as Unix epoch milliseconds; freshness is two-sided; no cross-host clock-skew estimate or server cursor is available.
- Post-run simulator reset: manual operator closure only; see operator-reset.template.json (not a control-performance endpoint).
- Stop reason: freshness stop: target PV sample stale/future

The run is one injection engineering feasibility episode and is not a powered comparison. No P0–P11 or historical run is pooled into this denominator. Review `reconciliation.json` and frozen raw evidence before manuscript use.

## Evidence finalization

The isolated AW listener was confirmed stopped before the raw event log was frozen. The final SHA-256 was recomputed from all 153 raw event records. The earlier package had 125 normalized records; 28 records were appended after that snapshot. The earlier raw hash matches the final raw hash: false. Taskless tool event records: 97. Tool-surface violations: 12. Actor-role mismatches: 0. Verified platform dispatches to both designated workers: false.
