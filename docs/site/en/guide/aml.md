# AML auto-modeling (agent-driven fitting & shadow twins)

Module codename `aml` (Auto Modeling Lab): on top of MAS mirroring DAQ and the time-series
store, a **built-in deep-learning expert team** drives the whole chain on its own —
pull data → clean → train → platform evaluation → gate iteration → HITL promotion → shadow
reference.

```
pull data (isolated triple) → clean → write code & train → authoritative evaluation → gate iteration → HITL promotion → shadow reference
```

Before tuning parameters, a control agent queries the production model through
`aml_model_reference` to get a shadow reference of "proposed parameters → predicted output
trajectory" (the front end of the digital twin / MPC); on the REST side that is
`POST /api/workshop/aml/models/:id/predict`. The full manual (with literature mapping and
ADRs) lives in the repository at
[docs/aml.md](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/aml.md).

## Asset root

AML artifacts (dataset arrays, job workspaces, ONNX artifacts, the uv virtual environment)
are **portable assets**, kept separate from the `.AgentWorkShop` runtime-state directory —
the whole `./aml` tree can be copied, deleted and rebuilt:

| Order | Condition | Asset root |
|---|---|---|
| ① | `AW_AML_DIR` is set | that directory (explicit override, highest priority) |
| ② | running inside a checkout (`AW_MODE` is not `home` and cwd finds `config.yml` + `nuxt.config.ts` upwards) | `<checkout>/aml` |
| ③ | `AW_MODE=home` (global install / home explicitly forced) | `<awHome>/aml` — `AW_HOME` redirects it, it is **not** hard-coded to `~/.AgentWorkShop` |
| ④ | not a checkout, but a real `.AgentWorkShop/` directory exists upwards from cwd (`findLocalConfigRoot`, never past `$HOME`) | `<that project .AgentWorkShop>/aml` |
| ⑤ | fallback for any other directory | `<cwd>/aml` |

Directory skeleton:

```
aml/
  .venv/            Python environment created/managed by uv (deps pinned in aml/python/requirements.txt)
  datasets/<id>/    spec.json fetch spec · manifest.json column defs · report.json quality report · arrays/*.f32
  jobs/<id>/        job.json submission contract · workspace/(train.py+amlkit.py) · run.log · artifacts/
  models/<id>/      model.onnx + io_spec.json (I/O contract, immutable)
  runtime/          uv.json (one-click install record) / env.json
  tools/            uv binary installed by the platform (no admin, no system PATH changes)
```

`GET /api/workshop/aml/env` returns the effective path and its source, which the "Runtime
environment" panel in the UI displays directly.

## Settings (the `aml` group, 16 keys)

The `aml` group on the settings page ("Runtime config") holds **16 descriptors**: thresholds
and quotas are `live` (effective as soon as saved), Python path keys are `restart`.

| config key | Default | Effect | Notes |
|---|---|---|---|
| `aml.python.pythonBin` | empty | restart | pin the Python interpreter (empty = auto-detect) |
| `aml.python.uvBin` | empty | restart | pin the uv executable (takes priority over `./aml/tools`) |
| `aml.python.indexUrl` | empty | restart | pip index mirror (speeds up dependency provisioning) |
| `aml.job.timeoutMs` | 1800000 | live | wall-clock limit per job (30 minutes) |
| `aml.job.maxConcurrent` | 2 | live | concurrent training jobs |
| `aml.job.diskQuotaMb` | 2048 | live | job disk quota |
| `aml.job.stallMs` | 600000 | live | stall watchdog (no progress ⇒ treated as stalled) |
| `aml.dataset.maxRows` | 200000 | live | row cap per dataset |
| `aml.dataset.retentionDays` | 30 | live | retention for unreferenced datasets |
| `aml.dataset.allowCrossRecipe` | false | live | allow fetching across recipes (off by default; the isolated triple is mandatory) |
| `aml.model.retiredKeepDays` | 90 | live | retention for retired artifacts |
| `aml.gates.nrmse` | 0.10 | live | G1 one-step NRMSE ceiling |
| `aml.gates.rolloutNrmse` | 0.25 | live | G2 multi-step rollout NRMSE ceiling |
| `aml.gates.valTestGap` | 0.2 (20%) | live | G3 generalization-gap ceiling |
| `aml.gates.minRows` | 500 | live | G4 minimum training rows |
| `aml.gates.minRuns` | 3 | live | G4 minimum batch count |

CLI examples: `aw config set aml.gates.nrmse 0.12`, `aw config get aml.job.maxConcurrent`.
Besides the standard `AW_AML_*` mapping there are 7 declared env aliases:
`AML_PYTHON_BIN`, `AML_UV_BIN`, `AML_PYTHON_INDEX_URL`, `AML_JOB_TIMEOUT_MS`,
`AML_JOB_MAX_CONCURRENT`, `AML_DISK_QUOTA_MB`, `AML_JOB_STALL_MS`.

## REST tree (`/api/workshop/aml/**`)

| Surface | Endpoints | Notes |
|---|---|---|
| Overview | `GET /api/workshop/aml` | runtime status + environment self-check + recent dataset/model/job counts (one request paints the first screen) |
| Runtime env | `GET .../aml/env`, `POST .../aml/env/{uv,venv,recheck}` | uv/Python detection, one-click uv install, venv create/rebuild, re-detect (async tasks + progress polling) |
| Entity reconciliation | `GET .../aml/entities`, `POST .../aml/entities/prune` | SQLite metadata ↔ `./aml` entities reconciled id by id (missing / orphan / contract incomplete); prune orphan directories |
| Datasets | `GET/POST .../aml/datasets`, `GET/PATCH/DELETE .../aml/datasets/:id`, `GET .../aml/datasets/:id/preview` | the isolated triple (line/product/recipe) is mandatory; snapshots are immutable (sha256 is the reproduction anchor); preview sampling |
| Jobs | `GET/POST .../aml/jobs`, `GET/DELETE .../aml/jobs/:id`, `POST .../aml/jobs/:id/{cancel,retry}`, `GET .../aml/jobs/:id/logs` | FIFO queue + concurrency cap; `##AML` NDJSON progress protocol; incremental log fetch |
| Experiments | `GET .../aml/experiments?datasetId=` | lineage tree + gate details + primary metrics |
| Models | `GET .../aml/models`, `PATCH/DELETE .../aml/models/:id`, `POST .../aml/models/:id/{predict,promote}` | registry stage transitions; predict = what-if prediction; promote = stage promotion (ONNX deep check before production) |

Permissions align with line grants: reading datasets and predicting need `readonly`,
promotion needs `operate`. Deletion is reference-protected (a dataset referenced by an
experiment or model, a production-stage model, a running job, or a job that produced a model
is always refused).

## Agent tools (10)

| Tool | Purpose |
|---|---|
| `aml_node_catalog` | inventory of modelable assets (node semantics × last-24h data volume) |
| `aml_dataset_build` | build a dataset snapshot (isolated triple + cleaning + beatMs alignment + windowing) |
| `aml_dataset_stats` | dataset statistics report (control→target lag cross-correlation / correlation / per-run profile) |
| `aml_job_submit` | submit a training job (train.py code may be inlined) |
| `aml_job_status` | job status snapshot |
| `aml_job_logs` | job logs (troubleshooting) |
| `aml_job_cancel` | cancel a job |
| `aml_leaderboard` | leaderboard (lineage + gate details + primary metrics) |
| `aml_model_promote` | request a stage promotion (lead-only; goes through human approval) |
| `aml_model_reference` | query the shadow reference of a production model (tuning what-if; proposed parameters via `controls`) |

These 10 are **host tools** defined in `.AgentWorkShop/prompts/host-tools.json` (48 entries
on the host tool surface); they are a different surface from MCP
(`server/mcp/workshop-server.ts`, 25 in-process tools).

The built-in team **`team-aml-shadow`** ("AML shadow modeling team") packs 1 lead (chief
data scientist) + 3 workers (data engineer / training engineer / evaluation engineer) with
`omp` as the default harness; add members when creating an instance from the team. The team
playbook lives in `.AgentWorkShop/prompts/aml-playbook.md`.

## Python runtime

The first training run detects uv and Python automatically and provisions pinned
dependencies into `./aml/.venv` (`aml/python/requirements.txt`) — this is the only stage that
touches the network, and `aml.python.indexUrl` can point it at a mirror. The "Runtime
environment" panel on the `/aml` page provides the full walkthrough:

1. **uv detection** — order: the `aml.python.uvBin` setting > `./aml/tools` (installed by the
   platform) > the `./aml/runtime/uv.json` record > system PATH; the source is shown with the
   status;
2. **one-click uv install** — runs the official installer with `UV_INSTALL_DIR=./aml/tools`
   and `UV_NO_MODIFY_PATH=1`: no system PATH changes, no administrator rights; on failure it
   falls back to `python -m pip install --target ./aml/tools uv`;
3. **create/rebuild the training environment** — with uv it runs `uv venv` + `uv pip install`,
   without uv it falls back to `python -m venv`; readiness is keyed on a marker file, so a
   dependency or mirror change marks the environment for rebuild;
4. **re-detect** — install uv/Python by hand and it applies without a restart;
5. **metadata ↔ entity reconciliation** — see the REST tree above; orphan entities can be
   pruned in one click.

Without Python a job reports `AML_PYTHON_MISSING` with guidance; starting with `AML_STUB=1`
runs the whole chain through a stub runner (a stub model is unpredictable, so promotion is
blocked by the deep check).

## Gates G1–G5

| Gate | Criterion | Default threshold | Setting key |
|---|---|---|---|
| G1 | one-step NRMSE | ≤ 0.10 | `aml.gates.nrmse` |
| G2 | multi-step rollout NRMSE | ≤ 0.25 | `aml.gates.rolloutNrmse` |
| G3 | generalization gap `\|test−val\|/val` | ≤ 20% | `aml.gates.valTestGap` |
| G4 | training rows / batches | ≥ 500 rows, ≥ 3 batches | `aml.gates.minRows` / `aml.gates.minRuns` |
| G5 | artifact completeness | ONNX + io_spec present | — |

Authoritative metrics are recomputed by the platform evaluator — never taken from the
agent's own report — and every threshold is `live` tunable.

## Governance and safety boundaries

- Training code runs only inside the job workspace (`./aml/jobs/<id>/workspace/`); the
  platform executes it as a separate subprocess with wall-clock / stall / concurrency limits
  and kills the whole process tree on cleanup;
- Dataset node sets ⊆ the agent's DAQ bindings (they can only shrink, never grow); on the
  REST side line grants apply;
- Every side effect goes through `recordOps` (audit_log + live ops.log frames), and agent
  actions are attributed to "Channel/Member";
- SQL is fully parameter-bound, workspace paths are validated against escaping the root, and
  deletion protection preserves the reproducibility trail of model artifacts.

## Related pages

- [Multi-harness agent teams](/en/guide/multi-harness) — harness selection and capability surface of the built-in AML team
- [Configuration](/en/guide/configuration) — the descriptor system the 16 `aml.*` keys live in, and their effect
- [Line-level permissions](/en/guide/line-permissions) — the authorization model for dataset reads and model promotion
