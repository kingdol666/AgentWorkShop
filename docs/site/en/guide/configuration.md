# Configuration

One runtime, one source of truth. **`config.yml`** declares defaults; the
**`runtime-settings.json`** inside the config root carries runtime overrides; environment
variables and CLI flags sit on top. Every editable key is declared once in
`shared/config/schema.json` (type/range/enum/effect) — **the web settings page and the
`aw` CLI consume the same descriptor registry**.

```
config.yml (defaults)  <  .AgentWorkShop/runtime-settings.json (runtime)  <  env (AW_* / PORT / HOST)  <  CLI flags
```

## Config root (two modes)

| Run mode | Config root | Factory config.yml / .env |
|---|---|---|
| Source checkout (repo mode) | `<repo>/.AgentWorkShop` | `<repo>/config.yml` (git-versioned) |
| Global install (home mode) | `~/.AgentWorkShop` (redirect with `AW_HOME`) | `~/.AgentWorkShop/config.yml` (seeded on first start) |

Inside the root: `runtime-settings.json`, `data/` (SQLite / JSON repos / backups),
`logs/`, `commands/` (custom commands) and `plugins/`.

## CLI

```bash
aw config list                       # 98 settings (16 groups): 32 live / 66 restart · effective value + source + effect
aw config get server.prod.port       # single key (value + source)
aw config set server.prod.port 8080  # schema-validated, atomic write
aw config set theme.primaryColor '#41c8f4'
aw config unset server.prod.port     # drop the override, fall back to config.yml
aw config reset --yes                # clear all runtime overrides
aw config validate                   # validate config.yml and the overrides
```

## Effect (live vs restart)

There are **98 descriptors** in total, split by effect into **32 `live`** and
**66 `restart`** keys:

- `live` keys take effect **as soon as they are saved** (theme, title, timeouts, DAQ
  sampling cadence, AML gate thresholds — pushed over the server event stream);
- `restart` keys (ports, listen address, AML Python paths) are persisted to disk and apply
  on the next start of the matching mode (`aw dev` / `aw start` / `aw config` all read the
  same effective configuration);
- both the web settings page and `aw config list` label every key with its effect, so a
  `live` key never needs a restart.

Environment variables can override any key; the rules are in the next section.

## Config root resolution (project first, user fallback)

Where runtime data lands is decided in one place, `shared/config/home.mjs`, with three rules:

| Order | Condition | Runtime root | config.yml |
|---|---|---|---|
| ① Project-level | `<cwd>/.AgentWorkShop/` exists | `<cwd>/.AgentWorkShop` | `<repo>/config.yml` (git-versioned) |
| ② Checkout without a project root | repo checkout, project root not initialized | `~/.AgentWorkShop` (redirect with `AW_HOME`) | `<repo>/config.yml` |
| ③ Home mode | global install / `AW_MODE=home` | `~/.AgentWorkShop` (redirect with `AW_HOME`) | `<home>/config.yml` (seeded on first start) |

`~/.AgentWorkShop` is initialized idempotently by `postinstall`
(`scripts/home-bootstrap.mjs`) and `aw home`: seed config, `.env` (random session secret),
`commands/`, `plugins/`, `data/`. Runtime settings written by `aw config set` and the data
directory always follow the runtime root — so on one machine "project-level wins over
user-level" holds out of the box.

## Environment variables and legacy aliases

Since v0.7 every runtime knob is part of the descriptor registry — **every environment
variable has a same-named config key as its fallback**, and the precedence is always
env > runtime-settings > config.yml > descriptor default, with no "hardcoded default in
code" bypass left.

There are exactly two mapping rules:

1. **Standard mapping**: `AW_<KEY with dots → underscores, uppercased>`, e.g.
   `server.dev.port` → `AW_SERVER_DEV_PORT`, `memory.cap` → `AW_MEMORY_CAP`,
   `dcw.rollback_cooldown_ms` → `AW_DCW_ROLLBACK_COOLDOWN_MS`;
2. **Explicitly declared legacy aliases**: the old names listed in a descriptor's `aliases`
   field, matched exactly one by one — there is no prefix inference.

So `dcw.*` / `workshop.*` / `memory.*` / `omp.*` only accept the prefixed standard form
(`AW_DCW_ROLLBACK_*` / `AW_WORKSHOP_IDLE_*`); **an unprefixed spelling is not recognized**.
`retention.messages_days` declares no alias at all — only `AW_RETENTION_MESSAGES_DAYS`.

| Group | config keys (examples) | env names (standard mapping / declared alias) | Notes |
|---|---|---|---|
| `memory.*` | `memory.primer_tokens` / `inject_total` / `maintenance_ms` / `expire_days` / `expire_session_days` / `cap` / `reflect_trigger` | standard mapping `AW_MEMORY_*` | memory budget / maintenance / expiry; the three `embed_*` keys configure vector recall |
| `omp.*` | `omp.compact_enabled` / `compact_threshold` / `compact_min_interval_ms` / `compact_wait_ms` | standard mapping `AW_OMP_COMPACT_*` | automatic context compaction |
| `dcw.*` | `dcw.rollback_cooldown_ms` / `rollback_min_window_ms` / `rollback_baseline_ms` / `rollback_stale_ms` | standard mapping `AW_DCW_ROLLBACK_*` (prefixed form only) | control-loop rollback guards |
| `workshop.*` | `workshop.idle_sweep_ms` / `idle_grace_ms` | standard mapping `AW_WORKSHOP_IDLE_*` (prefixed form only) | idle agent unloading |
| `backup.*` | `backup.disabled` / `interval_hours` / `keep` | declared aliases `BACKUP_DISABLED` / `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | automatic runtime-data backups |
| `retention.*` | `retention.disabled` / `events_days` / `messages_days` / `audit_days` / `approval_days` | declared aliases `RETENTION_DISABLED` / `AW_RETENTION_DISABLED` / `AW_EVENTS_RETENTION_D`; the rest are standard mapping only | data retention sweeps |
| `log.*` | `log.level` | declared alias `AWSHOP_LOG_LEVEL` | server log level |
| `security.*` | `security.hitl_timeout_ms` | declared alias `HITL_TIMEOUT_MS` | HITL approval timeout |
| `daq.*` | `daq.mqtt.qos` / `mqtt.username` / `mqtt.password` / `mqtt.caFile` / `mqtt.rejectUnauthorized` / `daq.tsRetentionH` / `daq.frameRetentionH` / `daq.alarmWebhookUrl` / `daq.alarmEscalateMinutes` | declared aliases `DAQ_MQTT_QOS` / `DAQ_MQTT_USERNAME` / `DAQ_MQTT_CA_FILE` / `DAQ_TS_RETENTION_H` / `DAQ_FRAME_RETENTION_H` / `ALARM_WEBHOOK_URL` / … | DAQ bus / retention / alarm egress |
| `aml.*` | `aml.job.timeoutMs` / `maxConcurrent` / `diskQuotaMb` / `stallMs`, `aml.python.*` and 16 keys in total | declared aliases `AML_PYTHON_BIN` / `AML_UV_BIN` / `AML_PYTHON_INDEX_URL` / `AML_JOB_TIMEOUT_MS` / `AML_JOB_MAX_CONCURRENT` / `AML_DISK_QUOTA_MB` / `AML_JOB_STALL_MS` | see [AML auto-modeling](/en/guide/aml) |

The conventional variables `PORT` / `NITRO_PORT` / `NUXT_PORT` (mapped to the port of the
current mode) and `HOST` / `NITRO_HOST` (mapped to `server.host`) are honoured **only when
the caller passes a mode** — i.e. when launched by `aw dev` / `aw start`. Running
`node .output/server/index.mjs` directly does not read them; use the standard names such as
`AW_SERVER_PROD_PORT` instead.

Two exceptions (structural bootstrap variables that predate the config system and are not
absorbed): `AW_HOME` / `AW_MODE` (they decide the config root itself) and
`AW_PACKAGE_ROOT` / `AW_PROMPTS_DIR` (payload location injected by the launcher). The
whole-connection overrides `DAQ_TSDB_URL` / `DAQ_OS_URL` / `DAQ_MQTT_URL` keep their
"URL wins, assembled config connection parameters are the fallback" semantics.

Server-side reads go exclusively through `server/services/workshop/settings.ts` (typed
group accessors); business code no longer reads `process.env` directly — environment
variables take effect in exactly one place, the descriptor engine.

## Web settings page

**System settings → Runtime config** renders every editable key from the same descriptor
registry — values written by the CLI show up in the browser immediately, and values saved
in the browser are readable by the CLI: every writer converges on one point.
