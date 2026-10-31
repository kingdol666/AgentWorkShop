# Success-flag baseline — evidence capture (2026-10-17)

Scope: extend the hardening ACK suite with a baseline reporting rule and apply
it to the same receipts as the governed rule. No new writes and no model
turn were added.

Command (admin token supplied via `AW_TOKEN`; token not recorded):

```bash
AW_TOKEN=<admin-token> AW_ONLY_ACK=1 node tmp-e2e/hardening-ack-gate.mjs
```

Environment: running platform at `http://127.0.0.1:3001`; isolated test line,
mock nodes, and mock recipes created and deleted by the suite. The Q1–Q4/Q5
archives were not modified.

Result: **22/22 checks pass**.

Key baseline checks:

- **B5** — readback-verified batch: success-flag `{ok:true, 2/2}` and governed
  `{verified:2, unverified:0, failed:0, total:2}` agree.
- **C4** — broker-cut batch: success-flag false and governed false agree.
- **D5** — publish-only MQTT receipt:
  - success-flag rule: `{ok:true, okN:1, total:1}`
  - graded rule: `{ok:false, verified:0, unverified:1, failed:0, total:1}`

This is the empirical basis for the paper's sentence: “applied to the same
receipt, a success-flag rule reports success while the graded rule reports
unverified” (Section V-G, leg 4). The full console log is
`docs/audit/2026-10-17-ack-baseline.log` (ignored by the repository's `*.log`
rule; this file is the tracked summary).

Suite changes in `tmp-e2e/hardening-ack-gate.mjs`:

- `AW_TOKEN` login path and `AW_BASE` override;
- `successFlagVerdict()` / `governedVerdict()`;
- B5/C4/D5 checks;
- `AW_ONLY_ACK=1` early exit that cleans the A–D fixtures.

The `D5` check is skipped when no MQTT broker is reachable; it is not reported
as a pass in that case. The paper must not claim the baseline if the archived
run shows the skip.
