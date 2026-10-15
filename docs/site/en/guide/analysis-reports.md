# Data-analysis ledger (analysis_reports)

Analysis conclusions reached inside a channel can be persisted as **first-class records**: a dedicated `analysis_reports` table organized by line × recipe × time window, with key conclusions, metrics, data sources and actor attribution. The `/analysis` page provides multi-dimensional retrieval with live updates; the external analysis service (IDD) plugs in through `diag_run` as a **background task**, and its reports land in the same ledger.

## Agent-native tools

| Tool | Purpose | Key arguments |
|---|---|---|
| `analysis_save` | Persist an analysis record | `title`/`summary` required; `conclusions` (array), `report` (full text), `metrics` (object), `recipe_id`, `window_from/to`, `data_sources`; line resolution = explicit `line_id` → channel-bound line fallback |
| `analysis_query` | Query the ledger | `report_id` fetches the full record; otherwise list by `line_id` / `recipe_id` / `category` / `q` / `from/to` |

The write gate mirrors line-data reads: **an agent can only write records for lines it can read**. The ledger is **append-only for agents**; every write is audited via `recordOps` (`analysis.save`) and streamed to the frontend over WS.

## Human side (/analysis page)

- **Multi-dimensional filters**: line dropdown / category / time presets (1h · 24h · 7d · 30d) / keyword (title + summary + conclusions).
- **Row expansion**: full report body + metrics + data sources + attribution (actor / channel).
- **Revision**: users with `operate` line access can edit (`PATCH`); editor attribution (`updated_by*`) refreshes on the row. Agents always see the latest revision.
- **Delete**: admin only (data hygiene), audited as well.

## Permission isolation (consistent platform-wide)

The ledger filters by **line-level grants** (`visibleLineIds`): without a grant, lists come back empty, details return 403/404, and HITL snapshots and ops-audit logs are equally invisible — data never leaves the server. `readonly` grants can look but not touch; `operate` grants can revise. See [Line-level permissions](/en/guide/line-permissions).

## IDD integration (diag-bridge)

`diag_run` starts a background analysis task and **returns a `task_id` immediately** — the channel never waits:

```
diag_run({ line, analysis_intent: "stability-report", question: "…" })
→ { task_id }
diag_status({ run_id: task_id })   // track progress by taskId
→ running (with stage) → completed + report file path
```

`analysis_intent` selects the IDD-side protocol: `stability-report` = line stability report (no root-cause analysis — score + grade + operational advice), `deep-diagnosis` = the nine-stage deep root-cause pipeline (default). On completion the platform **auto-delivers the result** to the originating channel, and the agent persists the conclusions (with `run_id` provenance) via `analysis_save`.

RAG mirrors this: `kb_agent` supports async tasks — `mode:"async"` returns a `task_id` immediately while the knowledge base ingests in the background, with `kb_agent_status` tracking by taskId; retrieval Q&A uses `mode:"sync"` for an immediate cited answer.

## Retention

`retention.analysis_days` (default 365) controls ledger retention and participates in the unified retention sweep.
