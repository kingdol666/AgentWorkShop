# P12 AgentTeam episode p12-20261029-injection-recovery-03

> PLC simulator / production-like scenario / not physical plant.

- Qualification: **PASS**
- Workflow outcome: **FAIL**
- Evidence integrity: **FAIL**
- Scene: injection; Harness: omp; Team: lead + 2 workers
- All tasks terminal=true; pending approvals=0; designated workers have completed delegated tasks=false
- Task state: CANCELED; PV: 31.27 → 31.23 g; target 32.5±0.35
- Baseline out-of-spec quality guards: sink-mark=2.069 (limit 1.5, tolerance 0.005)
- All final guards within fresh registered limits: false/true
- Fresh post-goal PV sample pair: true
- Goal-period changed anchors / verified reads / approved writes: 0/0/0
- Source completeness: journal cap=false; ops=true; DAQ=true; approvals capped=false
- Tool events/pairs: 0/0; unmatched starts/ends: 0/0
- Model/provider: lm-studio/qwen3.5-9b-32k; credential reference: none:a303533a834bfdf12558be7142e6fcd2a8082c963d8ccf67796aa1ab36772902
- Source commit: 1f30de698cc004c41d819d82517b8e6f9d3355c2; dirty hash: 85ed88b76be67c441f938dce56f4d7df1bf89da8f58b0ad4b1ff9335b261a198
- Simulator commit: d47eb7c0a7ae5e84d306a332d64844e4ea2499ac; dirty/tree hash: de494b2b3aef65a4cb27b0a396d364218168b175dc6d84013dccd166a40247dd; shadow copy verified=true
- Timing basis: platform DAQ API point.at as Unix epoch milliseconds; freshness is two-sided; no cross-host clock-skew estimate or server cursor is available.
- Post-run simulator reset: manual operator closure only; see operator-reset.template.json (not a control-performance endpoint).
- Stop reason: guard worsened/breached: sink-mark=2.092

The run is one injection engineering feasibility episode and is not a powered comparison. No P0–P11 or historical run is pooled into this denominator. Review `reconciliation.json` and frozen raw evidence before manuscript use.
