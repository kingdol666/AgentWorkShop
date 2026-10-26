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

`analysis_intent` selects the IDD-side skill protocol (full intent catalog; executed by IDD's harness, decoupled from the platform):

| Intent | Purpose |
|---|---|
| `deep-diagnosis` (default) | nine-stage deep root-cause pipeline (heaviest) |
| `stability-report` | line stability report: score + grade + advice (no root cause) |
| `quick-screen` | fast screening: over-limit/drift/freeze anomaly list + HTML dashboard (fastest) |
| `doe-analysis` | DOE analysis: factor effects / significance / optimal settings |
| `experience-mining` | tuning-experience mining: structured entries for the knowledge base |
| `optimizer-campaign` | optimization campaign: iterative search + recommended settings (heaviest) |

Each intent carries a scenario-specific default question (business semantics injected by the bridge, executed by IDD). On completion the platform **auto-delivers the result** to the originating channel (score / verdict / summary / absolute report path), and the agent persists the conclusions (with `run_id` provenance) via `analysis_save`.

RAG mirrors this: `kb_agent` supports async tasks — `mode:"async"` returns a `task_id` immediately while the knowledge base ingests in the background, with `kb_agent_status` tracking by taskId; retrieval Q&A uses `mode:"sync"` for an immediate cited answer.

## Retention

`retention.analysis_days` (default 365) controls ledger retention and participates in the unified retention sweep.

### Results library

The diag-bridge plugin now integrates IDD's results library (index / detail / metadata editing). It is **off by default** — the visible result set equals the diagnosis API token owner's visibility, and results are not line-scoped, so an admin must enable it explicitly.

| Agent tool | Purpose |
|---|---|
| `diag_results` | search the result index (q/intent/category_id/tag/scene/harness/min_score/sort/limit/offset; `brief=true` by default to save tokens, `brief=false` includes key_numbers) |
| `diag_result_get` | fetch detail by `result_id` (summary + traceable key numbers + **absolute** artifact/HTML URLs; optional `include_md`, truncated by limit) |
| `diag_result_annotate` | edit metadata (description/tags/title; `description=null` clears it; lead-only + plugin switch; ownership enforced by IDD) |

Settings (`Plugins → diag-bridge → Results library`): `results_enabled` (master switch, default off), `results_allow_annotate` (editing, default off), `results_allow_worker` (worker read access, default off = lead only), `results_default_limit` (default 20), `results_md_max_chars` (report truncation limit, default 4000). The `/plugins` page ships a Results library panel: search/filter → detail → edit description & tags (same-source routes `GET /api/plugins/diag-bridge/results`, `/results/detail?id=`, `PATCH /results/edit?id=`).

Typical agent flow: `diag_results(q="film thickness")` → pick `result_id` → `diag_result_get` for conclusions and key numbers → `diag_result_annotate` to record what the result means and when to reuse it.

> The ledger records conclusions; the EDA studio explores data — for interactive analysis (charts / pipeline / SPC / golden) see [Data workbench & EDA studio](./eda.md).