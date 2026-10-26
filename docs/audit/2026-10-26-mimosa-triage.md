# Mimosa security scan triage — 2026-10-26

## Scan

- Scan ID: `scan-2026-10-26T10-50-32.541Z-fee2a4898ff1`
- Depth: deep
- Status: **inconclusive** (coverage gap: some analysis stages did not complete)
- Evidence boundary: static analysis only; no runtime execution
- Findings: **46** (38 high, 6 medium, 2 low), 0 business-logic candidates
- Dependency scan: 354 packages, 0 matched advisories
- Seal: `sha256:503fa1473b6262f9c5c9fa12b120c69c98961bb0695d40dba5d761219dde7457`
- Raw artifacts: `report.md`, `findings.json`, `coverage.json`, `seal.json`,
  `scan-manifest.json` in this directory.

**This is not a security certification.** The scan is incomplete and the findings are
static advisories. Do not describe the repository as "security verified".

## Finding triage

### Removed or false-positive

- Hardcoded credential advisories in `i18n/locales/en.ts:234,279` and
  `zh-CN.ts:234` are **UI labels** (`embedApiKey`, `mqttPassword`), not literal secret
  values. No change needed.
- Hardcoded `Passw0rd!123` in `scripts/demo-group-chat-order.ts`,
  `scripts/test-agentteam-task-chat-flow.ts`, and `scripts/test-group-chat-unit/lib.ts`
  belonged to the obsolete test scripts removed by
  `docs/audit/2026-10-26-repo-cleanup.md`. The scan snapshot predates that cleanup.
- `data/workspaces/**` path-traversal findings point at ignored runtime files generated
  by agents during earlier demos; they are not tracked source. Scanner configuration
  should exclude this data directory in future runs.

### Requires separate review (not fixed in this cleanup)

- `drivers/http.ts` and `server/api/workshop/dcw/[id]/write.post.ts` SSRF advisories:
  the HTTP write/read driver is intentionally allowed to call configured industrial
  endpoints. Access is admin-configured and line-scoped, but a host allowlist and
  explicit rejection of loopback/private/reserved targets remain a hardening item.
  Changing it blindly would break local PLC gateways.
- Paper and benchmark tooling path-traversal advisories (`paper/tii/**`,
  `bench/tools/fig4_analyze.py`): CLI tools with operator-supplied paths; they are not
  exposed as runtime services. The paper tree is also an active parallel workstream.
- SQL/IDOR cross-file advisories (`channel-agent.repo.ts`, `e2e-multi-harness.ts`,
  `a2a/.../parseParams`) are static hypotheses without runtime proof. No business-logic
  candidate was produced by the scan.

## Conclusion

The Mimosa deep scan has now been **run and sealed**, but it remains **inconclusive**.
The actionable source-level items are the removed obsolete test scripts and the remaining
SSRF/path-traversal advisories listed above. No security verdict is claimed.
