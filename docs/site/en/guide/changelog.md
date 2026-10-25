# Version history

> Full release artifacts and per-version notes live on [GitHub Releases](https://github.com/kingdol666/AgentWorkShop/releases).
> The milestones below each mark an acceptance-verified capability jump; evidence is archived under `docs/audit/`.

## v0.8.x — Knowledge & closed loop (late Oct 2026)

- **v0.8.3 (2026-10-26)** — Results-library re-acceptance closeout (L1/L2/L4) + clean-tree release prep; global zero-state test fixes.
- **v0.8.2 (2026-10-25)** — Results-library reviewer fixes: PATCH role gate, hot toggle, absolute URLs, evidence chain.
- **v0.8.1 (2026-10-25)** — **diag-bridge results library**: three tools (`diag_results` / `diag_result_get` / `diag_result_annotate`) + the `/plugins` results panel + five governance switches, off by default, visibility = diagnostic-token owner. **Readable model metadata** and one-click ontology-draft **auto-fix**; the ontology graph tab became an interactive **node-edge view** (1/2-hop neighbourhood drawer). Same round completed the full acceptance: 821 checks green.
- **v0.8.0 (2026-10-24)** — **Ontology service + AI-first model loop**: 10 entity kinds × 8 closed relation kinds × three evidence levels × five-state lifecycle; four compiled artifacts (process model / ProblemIR delta / scene patch / guard set) under a tighten-only invariant with per-rule traces; agents build the virtual model themselves and propose adoption via `optimizer_profile_propose` — an HITL approval publishes and rebinds, verified live across two rounds (v1→v2→v3) with zero device writes. 72/72 ontology e2e · 46/46 model-loop e2e. See [Ontology & AI-first model loop](./ontology.md).

## v0.7.6x–7x — Governance & optimization (Oct 2026)

- **v0.7.71 (2026-10-24)** — **Process optimizer & solver**: process model → AML training (G1–G3 gates) → profile freeze → hash-pinned ProblemIR → OSQP/SLSQP solve → independent TS crosscheck → governed dispatch; **declarative tool-face governance** (all 104 host tools carry explicit `references` declarations).
- **v0.7.70 (2026-10-21)** — **Data workbench + EDA studio** (`/data` · `/studio`): compound queries, bulk export, golden trajectories, FDC/SPC (Nelson 1-8 / EWMA / CUSUM), OCAP, virtual metrology, derived datasets.
- **v0.7.66 (2026-10-17)** — **Unified tool-call preflight** (tool-verify: argument shape + reference ownership + chained lineage backtracking).
- **v0.7.63–65 (2026-10-15/16)** — Data-analysis ledger finalized (`analysis_reports` + `/analysis` page + IDD six-intent catalog), dead tool surfaces removed. See [Data-analysis ledger](./analysis-reports.md).
- **v0.7.62 (2026-10-13)** — **Data-analysis system**: `analysis_save` / `analysis_query` first-class records with line-scoped permissions.
- **v0.7.58 (2026-10-11)** — **Production hardening**: hold-write heartbeat lifecycle, silent mock fallback blocked, frame fingerprints + object GC, Timescale daily chunks + columnstore compression, heap-watermark auto-respawn.

## v0.7.4x–5x — Platform foundation (Sep 2026)

- **v0.7.54 (2026-09-30)** — Full protocol-matrix regression (Modbus/OPC UA/MQTT/HTTP/serial) and MES integration closeout.
- **v0.7.52 (2026-09-28)** — Team knowledge-base toggles, lead→worker node delegation, generic closed-loop optimization templates.
- **v0.7.50 (2026-09-28)** — **Dual-mode optimization loop** (production shadow/adoption), any-scenario twin modeling, `aw mcp` gateway, line-operations page, timezone base.
- **v0.7.45 (2026-09-21)** — Scheduled tasks, DCW write-hold windows, real-scenario merged acceptance all green.
- **v0.7.42 (2026-09-19)** — Site-wide zh/EN i18n completion and end-to-end acceptance.

## Upgrading

Releases follow semver. `aw start` verifies the config root on every launch and migrates the legacy `data/` layout into it (newest file wins), so data survives upgrades; SQLite schema migrations run server-side at boot.
