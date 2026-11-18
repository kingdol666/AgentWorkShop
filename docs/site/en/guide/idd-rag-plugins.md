---
title: IDD / RAG plugin integration
description: diag-bridge v2.4 and rag-bridge v2.3 — tool surface, external/v1 contract pinning, lifecycle, errors and degradation
---

# IDD / RAG plugin integration

> Bundled plugins: `diag-bridge` (v2.4, IDD industrial deep diagnostics) and `rag-bridge` (v2.3, rag-knowledge).
> Upstream contracts: IDD `external/v1` manual v1.3 and RAG `api-web` v2.0. This page covers the **platform-side plugins** only.

## 1. Tools

### rag-bridge (v2.3, deterministic document tools)

| Tool | Roles | riskClass | Purpose | Key args | First line |
| --- | --- | --- | --- | --- | --- |
| `kb_agent` | lead+worker | write | Native KB agent (search/ingest/experience); writes go through HITL | `prompt` `action=query\|ingest` `wait/wait_seconds` | completion text |
| `kb_agent_status` | lead+worker | read | Async task lookup / long poll | `task_id` `wait_seconds` | result text |
| `kb_doc_create` | lead+worker | write | Write Markdown into the doc KB and index it (idempotent by name) | `name` `content` `description?` `kb?` `tags?` | `status=created doc_path=… index=ok tags=ok` |
| `kb_doc_search` | lead+worker | read | Two-stage retrieval first, keyword fallback | `query` `kb?` `top_k?` | `status=ok mode=two-stage hits=N` |
| `kb_doc_read` | lead+worker | read | Read document body (bounded) | `doc_path` `kb?` `max_chars?` | `status=ok doc_path=… truncated=no` |
| `kb_catalog` | lead+worker | read | Knowledge-base catalog with document counts | — | `status=ok kbs=N` |

Default document KB = `plugins.rag-bridge.docs_kb` (default `aw-docs`); the experience surface (`kb_agent`) still writes `aw-industrial`. Passing `aw-industrial` to `kb_doc_create` emits a **drift warning** without blocking.

### diag-bridge (v2.4, external v1 primary)

| Tool | Roles | riskClass | Purpose | Key args | First line |
| --- | --- | --- | --- | --- | --- |
| `diag_run` | lead+worker | read | Launch any intent (returns task_id) | `line/export_id/data_path` `analysis_intent` `wait?` `ontology_*` `preprocessing_mode` `report_language` | `… contract=v1` |
| `diag_status` | lead+worker | read | Status/result incl. report path and URL | `run_id?` | `run_id=… contract=… 状态=…` |
| `diag_chat` | lead+worker | read | Continue a run (v1) | `run_id` `message` | `status=ok delivered=… resumed=…` |
| `diag_stop` | lead+worker | write | Stop a run (audited) | `run_id` | `status=stopped run_id=…` |
| `diag_deposit` | lead+worker | write | Deposit a report into `aw-docs` + retrieval self-check | `run_id` `kb?` `title?` | `status=ok doc_path=… search=hit` |
| `diag_results` / `diag_result_get` / `diag_result_annotate` | results library (off by default) | read/write | Search/detail/metadata | see tool descriptions | — |

All seven intents: `deep-diagnosis` / `stability-report` / `quick-screen` / `doe-analysis` / `experience-mining` / `optimizer-campaign` / `improvement-advisory`.

## 2. Contract pinning and fallback

- `plugins.diag-bridge.contract = auto|v1|legacy` (default `auto`).
- auto probes `GET /api/external/v1/capabilities` **before submitting** and caches the verdict for 5 minutes (base+token fingerprint).
  - 200 with the v1 envelope → v1;
  - 404 / unreachable / 200 with a non-v1 envelope (proxy catch-all) → legacy;
  - 401/403/5xx → **no silent fallback**; a readable token/service error is returned instead.
- Per-run `contract + task_id + run_id` is persisted; submit, polling, status, receipts and `/report` all route on the same contract.
- Explicit `legacy` exists for regression only; `diag_chat` and `diag_deposit` require v1.

## 3. Lifecycle and single-flight lock

- Terminal states: `completed` / `failed` / `stopped` / `interrupted` / `expired`.
- `awaiting_input` is **not** terminal: it holds the line single-flight lock and does not send a terminal receipt; after `plugins.diag-bridge.awaiting_max_minutes` (default 30) it becomes `expired` with an advisory receipt.
- v1 `404` on three consecutive polls → `expired`; legacy still converges to `failed`.
- One non-terminal run per line (`queued/running/awaiting_input` all hold the lock).
- Export datasets without an explicit `line` lock on `manifest.lines[0].lineId`; `lineScope` separates the authorization scope so pure offline datasets are not rejected as “offline-data not readable”.

## 4. Errors

- IDD v1 error codes map to readable guidance: auth, intent, harness, data path, intent/harness mismatch, chat state, stop terminal.
- `diag_run` pre-flight: unknown intent, harness without `runs` capability, unsupported intent → rejected before submit with a prescription.
- RAG: 401/403 (token re-mint path), 429 (30s backoff once), 404 (KB/document name), 5xx/timeout (switch to async or `kb_doc_search`).

## 5. Degradation

- KB agent turn unavailable (600s hard cap / 502 / 503) → `kb_agent` errors and recommends `kb_doc_search` (two-stage retrieval does not depend on the internal agent).
- Two-stage retrieval failure → keyword fallback labelled `mode=keyword-degraded` (metadata only; verify with `kb_doc_read`).
- `diag_deposit` self-check miss (index visibility window) → `search=miss`; the document is already written, re-check later with `kb_doc_search`.

## 6. Observability

- `GET /api/plugins/rag-bridge/health`: both KB ids, token verify tri-state, per-tool `toolCounters`.
- `GET /api/plugins/diag-bridge/health`: contract, token probe, runs byStatus, `toolCounters`.
- `GET /api/workshop/channels/:id/tool-usage`: agent tool counts (requires a ws subscriber to persist `agent.block` events).
- Write audits: `plugin.kb_doc.create`, `diag.report.deposit`, `diag.run.stop`.

## 7. Gray release and kill switch

1. Batch one (read): `kb_doc_search` / `kb_doc_read` / `kb_catalog` / `diag_chat`.
2. Batch two (write): `kb_doc_create` / `diag_deposit` / `diag_stop` after batch one passes.
3. Kill switch: disable the plugin → tool calls return a readable “not registered” instead of crashing.
4. Contract switch: `contract=legacy` returns to the old path immediately (no restart).

## 8. Security boundaries

- Outbound URLs are limited to `http(s)://127.0.0.1|localhost`; tokens live in system settings, never in source.
- `diag_run` / `diag_chat` / `diag_stop` / `diag_deposit` enforce the line read scope (fail-closed).
- `diag_deposit` / `diag_stop` / `kb_doc_create` are write-family: policy or catalog unavailable → fail-closed (`isPolicyWriteTool` unions the static list with plugin `riskClass='write'`).
- The results library is off by default; `diag_results` is lead-only unless the worker switch is enabled.

## 9. Acceptance summary (2026-11-18)

Fresh home / line / channel: provisioning 9/9, channel forge 11/11, V1–V6 11/11; 142 host tools (127 builtin + 15 plugin, ≈965 schema tokens); a real model turn natively called `kb_doc_search → kb_doc_read → diag_run → diag_status`; governed loop SP 156→150→144→138 °C (HITL every step, device-confirmed 1/1), PV retest 3/3 inside [138,142] (mean 139.68).

Honest boundaries: IDD quick-screen/stability did not reach a terminal state on a 60-min / 2,312-row export within 40 min (external skill/engine); the deposit→index→retrieval loop was proven with a clearly-labelled mock report; cloud model providers were unavailable, so the real turn used a local model; Mimosa deep scan is sealed but **inconclusive** — no security-pass claim. Full evidence: `docs/audit/evidence/2026-11-18-idd-rag-plugin-v1-contract/REPORT.md`.
