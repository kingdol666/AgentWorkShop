# aw — the AgentWorkShop command-line tool

> A Claude Code style experience: after `npm i -g agentworkshop`, type `aw start` in **any directory**
> to bring the platform up; all configuration, data and custom commands converge on the config root
> `~/.AgentWorkShop` (redirectable with `AW_HOME`), independent of the current working directory and
> of environment paths.

```
__     __        __  __
\ \   / /__  _ _|  \/  |___ _ _ ___
 \ \ / / _ \| '_| |\/| / _ \ ' _(_-<
  \_/\_\___/|_| |_|  |_\___/_| |/__/
```

## 1. Installation

### 1. Install from the npm registry (the standard published path)

```bash
npm install -g agentworkshop
# or run it once without installing (npx fetches the package for you)
npx agentworkshop start
```

`bin` in `package.json` has exactly two entries, both pointing at `bin/aw.mjs`: `aw` and
`agentworkshop` (npm generates the `aw` / `aw.cmd` / `aw.ps1` shims on install). The two are
fully equivalent, and every subcommand has to go through them:

```bash
aw --help                 # or agentworkshop --help (identical)
aw --version              # agentworkshop --version
npx agentworkshop doctor  # there is no standalone doctor / tui executable
npx -p agentworkshop aw doctor   # -p selects the package, then runs its bin — equivalent
```

### 2. Install from this repository (development / internal testing)

```bash
# run from the repository root
npm install -g .            # npm 11 treats a local directory as a Junction link (code edits apply immediately; good for local development)
npm uninstall -g agentworkshop

# or pack and install (identical to the post-release user experience; the tarball already contains the production build in .output)
npm pack
npm install -g ./agentworkshop-<version>.tgz
```

> `--ignore-scripts` skips `postinstall` (`node scripts/home-bootstrap.mjs`, the AW Home bootstrap)
> and `prepare` (husky initialisation), keeping the install light and fast; `prepare` only runs husky,
> there is no Nuxt-side prepare script in the package, and the install involves no build at all —
> the published tarball already ships the `.output` production build. The first `aw start` /
> `aw home` performs the AW Home bootstrap anyway, so there is nothing to worry about.

In-repository development uses pnpm (`packageManager: pnpm@11.9.0`):

```bash
pnpm install
pnpm cli --help      # the in-repo CLI entry (there is no package script named aw)
pnpm tui             # the terminal workbench
```

### 3. Quick use via npx (no global install)

```bash
npx agentworkshop start            # fetch and start (pin a version with: npx agentworkshop@0.7.37 start)
npx agentworkshop doctor           # subcommands work as usual
npx -p agentworkshop aw doctor     # use -p when you want the name aw
```

> "No global install" does not mean "nothing is written to disk": `postinstall`, or the first
> `aw start`, still creates the config root under `~/.AgentWorkShop` and seeds its files (see section 2).
> Set `AW_HOME` to isolate it completely.

### 4. Runtime requirements

| Item | Value |
|---|---|
| Node.js | `>= 23.4.0` (`engines.node`) |
| Package manager | `pnpm@11.9.0` (`packageManager`, needed only for source development) |
| Module format | ESM (`type: module`) |
| License | `PolyForm-Noncommercial-1.0.0` |
| Current version | `0.7.37` (`package.json`) |

## 2. First start (the Claude Code experience)

```bash
# A. npm install (the tarball already contains the .output production build): starts directly, no rebuild
$ aw start
› 生产服务(home 模式) -> http://0.0.0.0:3001  (端口来源: config.yml)
› 配置: C:\Users\you\.AgentWorkShop\config.yml · 数据: C:\Users\you\.AgentWorkShop\data
› 停止: Ctrl+C

# B. first start from a source checkout (no .output yet): builds once first
$ aw start
› 首次启动:正在构建生产产物(约 2-5 分钟,仅一次) ...
› 生产服务(repo 模式) -> http://0.0.0.0:3001  (端口来源: config.yml)
› 配置: D:\codes\ABO\AgentWorkShop\config.yml · 数据: D:\codes\ABO\AgentWorkShop\.AgentWorkShop\data
› 停止: Ctrl+C
```

- Open the printed address in a browser and it is ready; `Ctrl+C` stops it; a later `aw start`
  reuses the existing build output directly.
- The port comes from the effective configuration (`server.prod.port`, 3001 by default) and
  `--port` has the highest priority; the `(端口来源: config.yml|runtime|env|CLI)` suffix in the output
  tells you which layer supplied it.
- `aw stop` terminates a running instance through the single-instance lock at
  `<config root>/.runtime/aw.lock`.

**AW Home** (the user-level config root, `~/.AgentWorkShop` by default) is created idempotently by
`postinstall` (`scripts/home-bootstrap.mjs`) or by the first `aw start` / `aw home`; existing files
are never overwritten:

```
~/.AgentWorkShop/
├── config.yml               # main config (factory default seed; edit here to change global behaviour)
├── runtime-settings.json    # runtime overrides (written by aw config set)
├── .env                     # secrets (a 24-byte random NUXT_SESSION_PASSWORD is generated on bootstrap)
├── .env.example             # key template (shipped with the package)
├── docker-compose.yml       # data-acquisition infrastructure (MQTT/Timescale) self-start definitions
├── plugins-state.json       # plugin enable/disable state (sdk/examples seeds are recorded as disabled)
├── data/                    # sqlite / JSON repositories / backups (all runtime data lands here)
├── logs/
├── commands/                # user-level custom commands (drop a file in and it registers)
├── plugins/                 # user-level plugin directory (seeded from sdk/examples/*, missing files only)
└── prompts/                 # agent prompts (seeded from packaged assets on first start; missing files only)
```

> **repo mode (source checkout)**: the config root is `<repo>/.AgentWorkShop` (runtime-settings.json /
> data / commands / plugins as above), while the factory-default config.yml/.env stay at the checkout
> root and are versioned by git. Prompts resolve as `<project>/.AgentWorkShop/prompts` →
> `~/.AgentWorkShop/prompts` (both modes are isomorphic and seed from packaged assets on first start;
> `AW_PROMPTS_DIR` overrides explicitly). Runtime files in the old locations (`data/`,
> `server/data/`) are migrated into the config root on first start — copied, never deleted, with
> sqlite/JSON repositories and runtime overrides converging on "newest wins" (mtime comparison).

## 3. The dual-mode path model (independent of environment and paths)

| | repo mode | home mode (the default installed shape) |
|---|---|---|
| Trigger | cwd is inside a project checkout (config.yml + nuxt.config.ts present) | any other directory |
| Application code | source in the checkout (builds once on first start when `.output` is missing) | the npm package payload (the tarball already contains the `.output` production build, ready to run) |
| Config root | `<repo>/.AgentWorkShop` | `~/.AgentWorkShop` |
| Factory-default config.yml/.env | `<repo>/config.yml` (versioned by git) | `~/.AgentWorkShop/config.yml` |
| Runtime overrides | `<repo>/.AgentWorkShop/runtime-settings.json` | `~/.AgentWorkShop/runtime-settings.json` |
| Runtime data | `<repo>/.AgentWorkShop/data/` | `~/.AgentWorkShop/data/` |
| prompts | `<project>/.AgentWorkShop/prompts` → falls back to `~/.AgentWorkShop/prompts` | same as the left (seeded from packaged assets on first start) |

### Config-root resolution (three rules)

`resolveRunMode()` in `shared/config/home.mjs` decides in order, **first match returns**:

| # | Condition | Effective config root | Effective config.yml |
|---|---|---|---|
| 1 | walking up from cwd finds a real `./.AgentWorkShop` directory | that directory (repo mode; a plain workspace works too) | the checkout's `config.yml`; for a non-checkout, the config root's `config.yml`, falling back to the packaged one |
| 2 | walking up from cwd finds a source checkout (config.yml + nuxt.config.ts) but **no** `./.AgentWorkShop` | `~/.AgentWorkShop` (repo mode) | `<checkout>/config.yml` (the factory default is still read from the checkout) |
| 3 | any other directory | `~/.AgentWorkShop` (home mode) | the config root's `config.yml`, falling back to the packaged one |

- `AW_HOME=D:\aw-home` overrides the user-level root (every `~/.AgentWorkShop` in the three rules
  points there instead).
- `AW_MODE=home` forces the home shape (skipping rules 1 and 2; the launcher injects it for the
  globally installed application payload so that a package directory containing config.yml +
  nuxt.config.ts is not mistaken for a checkout).
- `AW_DATA_DIR` selects the runtime data directory on its own (the config root's `data/` by default).

### The settings and environment-variable model

- Precedence (the CLI, the web settings page and the dev/prod launch scripts all share one engine,
  `shared/config/engine.mjs`):
  `config.yml defaults < runtime-settings.json runtime overrides < environment variables / explicit CLI flags`.
- There are **99 setting descriptors across 16 groups** (`aw config list` prints exactly 99 rows):

| Group | Count | Group | Count | Group | Count | Group | Count |
|---|---|---|---|---|---|---|---|
| `server` | 3 | `app` | 2 | `api` | 4 | `theme` | 2 |
| `i18n` | 1 | `security` | 2 | `daq` | 27 | `memory` | 10 |
| `omp` | 4 | `harness` | 12 | `dcw` | 4 | `workshop` | 2 |
| `backup` | 3 | `retention` | 5 | `log` | 1 | `aml` | 16 |

  32 of them are `live` (effective as soon as they are saved) and 66 are `restart` (effective after
  restarting the corresponding mode); `aw config list` marks every row with `live` or `restart`.
- Environment-variable mapping: `AW_<KEY uppercased, dots turned into underscores>`
  (for example `AW_SERVER_DEV_PORT`), plus the legacy `aliases` a descriptor declares explicitly
  (priority: `AW_<KEY>` over the declaration order of `aliases`).
- The conventional variables `PORT`/`NITRO_PORT`/`NUXT_PORT` and `HOST`/`NITRO_HOST` apply
  **only when a mode is passed in** (only the launcher chain knows whether that maps to the dev or
  the prod port).
- `aw config set` writes the **config root's** `runtime-settings.json` (inside a source checkout the
  config root may differ from `~/.AgentWorkShop`; the success line prints the actual `settingsPath`).

## 4. Command reference

There are **14** built-in commands (`cli/commands/*.mjs`, one command per file):

| Command | Aliases | Flags | Purpose |
|---|---|---|---|
| `aw start` | `s`, `prod`, `preview` | `--port <n>` `--host <h>` `--skip-infra` | production server (inside or outside a checkout; builds once when the output is missing) |
| `aw dev` | `d` | `--port <n>` `--host <h>` | development server (requires a project checkout; disconnect guard + .env preload) |
| `aw build` | `b`, `compile` | — | production build → `.output/` (requires a project checkout) |
| `aw stop` | — | `--home` | terminate a running instance through the single-instance lock (`--home` forces the home config root as the target) |
| `aw config` | `cfg`, `c` | subcommands `list`(`ls`) / `get` / `set` / `unset` / `reset`(`--yes`/`-y`/`--force`) / `validate`(`check`) | read / write / validate runtime configuration |
| `aw plugin` | `plugins`, `plug` | subcommands `list`(`ls`) / `create`(`new`/`add`) / `enable` / `disable`; `create` also takes `--global`/`-g`, `--project`, `--force`/`-f` | plugin management (three scopes: list / scaffold / enable-disable, hot reload) |
| `aw home` | `hw` | — | inspect / initialise the config root (idempotent) |
| `aw init` | `create`, `new` | `--force` `--no-install` `--silent` | scaffold a new project checkout |
| `aw register` | `reg`, `install-cmd` | `--name <n>` `--global`/`-g` `--force`/`-f` | register a command module (local file / directory / URL / npm package) |
| `aw doctor` | `dsk`, `check-env` | — | environment / configuration / service health check (`--json` prints `{ ok, checks }`) |
| `aw status` | `st`, `info` | — | runtime overview (mode / config sources / service / build / command count / key effective settings) |
| `aw update` | `upgrade` | `--check` `--registry <url>` `--yes` | compare with the latest npm version and update the global install in place |
| `aw tui` | `tui` | `--url <baseUrl>` `--token <ut-*>` `--channel <name>` | terminal workbench |
| `aw version` | `v` | — | version information |

> `aw status` reports the mode, the config path, whether build output exists, the runtime override
> keys, the command count and the key effective settings; it has **no uptime**, and the version number
> appears only in the `package.version` field of `aw status --json`.

### Global options

Only the 5 entries of `GLOBAL_OPTS` in `cli/core/args.mjs` are global:

| Option | Purpose |
|---|---|
| `--json` | machine-readable output (success / failure envelopes below) |
| `--debug` | debug logging (unexpected exceptions additionally print a stack trace) |
| `--help`, `-h` | general help, or help for one command (`aw help <cmd>` is equivalent) |
| `--version`, `-v` | print `agentworkshop <version>` |
| `--root <dir>` | explicitly select the project root (the directory must contain `config.yml`) |

`--port` / `--host` are **per-command** flags of `start` / `dev`, not global options;
`AW_HOME` / `AW_MODE=home` / `AW_DATA_DIR` are **environment variables**, not command-line flags.

### Exit codes and the `--json` contract

| Exit code | Meaning |
|---|---|
| `0` | success |
| `1` | runtime error (`CliError` with `code !== 'USAGE'`, unmet `needsProject`, unexpected exception) |
| `2` | usage error (unknown command, no command given, `CliError` with `code === 'USAGE'`) |

Under `--json`, failures uniformly emit an `{ ok: false, error: <code> }` envelope (no stack trace):

| `error` | Trigger | Exit code |
|---|---|---|
| `unknown-command` | the command name is not in the registry (including `aw --help <unknown>`); carries `name` | 2 |
| `usage` | no command was given at all; carries `hint: 'no command'` | 2 |
| `cli-error` / the concrete `CliError.code` | a usage or runtime error inside a command; carries `message` | 2 (USAGE) / 1 (otherwise) |
| `no-project` | a command marked `needsProject` ran outside a checkout | 1 |
| `internal` | unexpected exception; carries `message` | 1 |

On success each command supplies its own `{ ok: true, ... }` payload (`config list/get/set/unset/reset/validate`,
`status`, `home`, `version`, `doctor`). Note that server-side REST responses (such as
`GET /api/workshop/plugins`) are **not** wrapped in a `{ code, data }` envelope — that is unrelated to
the CLI's `--json`.

### Common examples

```bash
aw config set server.prod.port 8080     # change the production port (effective after restart)
aw config set theme.primaryColor '#41c8f4'
aw config get server.dev.port           # value + source
aw config list                          # 99 settings (16 groups) + source + when they apply
aw config validate                      # validate config.yml and the runtime overrides
aw start --port 3002                    # CLI flags win; the output marks 端口来源: CLI
aw doctor                               # health check: Node/pnpm/AW Home/Docker/MQTT/ports/secrets/build
aw status --json                        # machine-readable runtime state (includes package.version)
aw plugin list                          # plugin inventory across the three scopes (with enable state)
aw plugin create my-plugin              # scaffolds into <checkout>/.AgentWorkShop/plugins/ by default (cwd when there is no checkout)
aw plugin create my-plugin --global     # or scaffolds into ~/.AgentWorkShop/plugins/ (user scope)
aw plugin disable my-plugin             # disables it (writes plugins-state.json; a running server hot-reloads in ~1s)
aw stop                                 # stop the running aw service through the single-instance lock
```

### Plugin management (the three scopes of `aw plugin`)

The host discovers plugins **first scan wins**, so same-name priority is
**`builtin` > `project` > `user`**:

```
1. builtin  <packageRoot>/server/plugins-builtin/<name>/index.mjs   (shipped with the package, always present)
2. project  <checkout>/.AgentWorkShop/plugins/<name>/index.mjs      (the default target of aw plugin create)
3. user     ~/.AgentWorkShop/plugins/<name>/index.mjs               (aw plugin create --global)
```

> Direction warning: the command registry is "later scan wins → project > user > built-in", whereas
> plugin discovery is "first scan wins → built-in > project > user". The two run in opposite
> directions — do not generalise from one to the other.

- `aw plugin create <name>`: lands in the project scope by default; `--global`/`-g` lands in the user
  scope; `--project` is the explicit spelling and equals the default; `--force`/`-f` overwrites an
  existing plugin. The name must match `^[a-z][a-z0-9-]{1,31}$` (starts with a lowercase letter,
  2–32 characters of a-z0-9-). It scaffolds `index.mjs`, `client.mjs` and `README.md`.
- `aw plugin list`: lists the enable state of all three scopes (`已启用` / `已停用`; a `+client` mark
  means a browser enhancement exists).
- `aw plugin enable|disable <name>`: searches the same three scopes in the same order
  (builtin → project → user) and toggles the first same-name plugin.
- Enabling and disabling writes `<home>/plugins-state.json`, where `home = $AW_HOME || ~/.AgentWorkShop` —
  **not** the config root (inside a source checkout the two differ; the config root is
  `<repo>/.AgentWorkShop`).
- A running server watches that file (`fs.watch` + 400 ms debounce + a 10 s polling fallback) and
  hot-reloads within about a second. That state file is the only trigger (a change to it, or a
  disable/enable round trip) — **editing plugin code by itself does not trigger a reload**: the host
  has no plugin-directory watcher, but a reload re-imports the entry with a `?t=<timestamp>`
  cache-busting query, so after editing code touch `plugins-state.json` (or toggle the plugin once)
  and the host picks up the new module without a process restart; only changes to the `server/` and
  `shared/` core require one.
- `aw plugin list` does not show load failures; the failure list appears only in the response of
  `GET /api/workshop/plugins`, which returns `{ plugins, failures }` (plus `initedAt`) and carries no
  `{ code, data }` envelope.
- The plugin contract and lifecycle hooks (`daq:sample` / `daq:frame` / `dcw:write` / `line:start|stop` /
  `config:changed` / `plugins:reloaded` / `event:*` / `server:close`) are documented in `docs/plugins.md`.

### Related modules

- **TUI terminal workbench**: `aw tui` (channel / member management, task dispatch, live monitoring,
  HITL answering); manuals in `docs/tui.md` and `tui/README.md`.
- **AML automated modelling**: the `/aml` page (16 settings in the `aml` group), 26 route modules
  under `server/api/workshop/aml/**`, 10 `aml_*` agent tools, and the built-in `team-aml-shadow` team;
  the manual is `docs/aml.md`.

## 5. The command registry (extension mechanism)

### The registration model (convention over configuration)

Three scan layers, later scan wins on a name clash (**project > user > built-in**); drop a file in and
it is registered, with no central manifest:

```
1. built-in  <packageRoot>/cli/commands/*.mjs        (shipped with the package, always present)
2. user      ~/.AgentWorkShop/commands/*.mjs         (aw register --global)
3. project   <checkout>/.AgentWorkShop/commands/*.mjs (aw register)
```

- Only `*.mjs` / `*.js` / `*.cjs` files are scanned, and files starting with `_` are ignored; a module
  that fails to load is merely recorded in `registry.failures` (`aw doctor` lists them) without
  blocking the other commands.
- The directory name is **`.AgentWorkShop`** (capital A / W / S). Linux and macOS file systems are
  case-sensitive: a command directory whose name has the wrong capitalisation is never scanned.

### One command = one file

```js
// ~/.AgentWorkShop/commands/hello.mjs
export const meta = {
  name: 'hello',
  group: '自定义',
  summary: '问好',
  usage: 'aw hello [--name <n>]',
  aliases: ['hi'],        // optional
  // needsProject: true   // requires a project checkout context
}
export async function run(argv, ctx) {
  // argv = { flags, positionals, unknown }
  // ctx  = { root, mode: 'repo'|'home', home, config, resolveNuxtBin(), bypassEnv(),
  //          json, debug, commandsDir, configRoot, configPath, settingsPath, dataDir,
  //          registry, EXIT }
  console.log(`你好, ${argv.flags.name ?? 'AW'}! (模式: ${ctx.mode})`)
  return 0   // returning a number becomes the process exit code
}
```

```bash
aw hello --name 世界      # registered the moment the file exists; usable immediately
aw hello --help          # help is generated automatically from meta
```

### Registering from outside

```bash
aw register ./my-tool.mjs              # → project scope (copies <name>.mjs into the scan directory)
aw register ./my-tool.mjs --global     # → user scope (available in every project)
aw register ./tools-dir/               # every .mjs/.js/.cjs in the directory
aw register https://example.com/x.mjs  # download from a URL and register
aw register npm:some-cmd-pkg           # generate a wrapper module (dynamic import of the package's { meta, run })
aw register ./x.mjs --name better-name --force
```

`aw register` only writes the module into a scan directory; there is no manifest. Project-scope
registration needs a project context (outside a checkout, without `--global`, it reports `NO_PROJECT`
and exits with code 1).

## 6. Publishing to npm (maintainer guide)

The repository is already wired up: `bin` (the `aw` / `agentworkshop` double registration, both
pointing at `bin/aw.mjs`), the `files` whitelist (`.output`, `bin`, `cli`, `sdk`, `app`, `server`,
`shared`, `i18n`, `public`, `scripts`, `server/plugins-builtin`, `.AgentWorkShop/prompts`, `tui` and
the various config files), `prepublishOnly` (forces `node bin/aw.mjs build` before packing) and
`postinstall` (the AW Home bootstrap).

```bash
# 1. pre-release self-check
npm pack --dry-run          # inspect the payload and its size (it should contain .output/)
node bin/aw.mjs build       # prepublishOnly runs this automatically; run it manually to confirm locally

# 2. version and visibility
npm version patch|minor|major
# the private flag has been removed; if it ever comes back: npm pkg delete private
# (optional) rename / add a scope: npm pkg set name=@yourorg/agentworkshop

# 3. publish (needs an npm account; the default registry on this machine is the read-only npmmirror mirror, so publishing must name the official registry)
npm login --registry=https://registry.npmjs.org
npm publish --access public --registry=https://registry.npmjs.org

# 4. the user side
npm i -g agentworkshop && aw start
npx agentworkshop start
aw update                   # or let users self-update with the built-in command (--check only reports)
```

**Publication model**: the `files` whitelist includes `.output` (together with the runtime
dependencies inside `.output/server/node_modules`), and `prepublishOnly` runs `node bin/aw.mjs build`
once before packing, so **the published tarball carries its own production build and dependencies**:
an npm-installed user starts with `aw start` and never rebuilds, nor needs `pnpm install`. Only a
**source checkout** builds once on first start when `.output` is missing.

**Version source of truth**: `npm version` bumps `package.json` only; `app.version` inside
`config.yml` is a **fallback**, not authoritative — `nuxt.config.ts` prefers the `package.json`
version, so both the version injected at build time and the one echoed by `/api/health` follow the
package. That field's literal has historically drifted out of sync with the package, so read
`package.json` (or `package.version` from `aw status --json`) when you need the version — never
rely on it.

**Repository scripts** (`package.json`): `dev` / `build` / `start` go through
`node bin/aw.mjs <cmd>`, `preview` equals `start`, `generate` is `nuxt generate`, and there are
`cli`, `tui`, `postinstall`, `prepublishOnly`, `lint`, `lint:fix`, `typecheck`, `prepare` (husky),
`game:*` and `test:api-live`. **There is no script named `aw`** — the in-repo CLI entry is `pnpm cli`
and the TUI is `pnpm tui`.

## 7. Design notes (engineering)

- **Thin launcher**: the global package carries only the command system and the application payload;
  the config engine (`shared/config/engine.mjs`) is loaded dynamically from the run root, so the CLI,
  the web settings page and the dev/prod launch scripts all share a single source of truth.
- **Reused launch chains**: `aw dev` goes through `scripts/dev-guard.mjs` (ECONNRESET guard +
  .env preload) and `aw start` goes through `scripts/start.mjs`, exactly the same chains as
  `pnpm dev` / `pnpm start`.
- **Proxy immunity**: every child process launched by aw automatically gets
  `NO_PROXY=localhost,127.0.0.1,::1` injected (a local system proxy can no longer hijack loopback requests).
- **Secure defaults**: the AW Home `.env` generates a 24-byte random `NUXT_SESSION_PASSWORD` during
  bootstrap; prompts (agent system prompts) ship with the package and are seeded on first start as
  `<project>/.AgentWorkShop/prompts` → `~/.AgentWorkShop/prompts` (missing files only, user
  customisations are never overwritten). `AW_PROMPTS_DIR` overrides explicitly but is no longer
  pinned to the package.
- **Single instance**: a running instance writes `.runtime/aw.lock` in the config root
  (`{ pid, startedAt, mode, port }`), and `aw stop` terminates the process tree from it
  (Windows `taskkill /PID <pid> /T /F`; POSIX sends SIGTERM, waits 5 s, then SIGKILL).
- **Window / Ctrl+C**: child processes inherit stdio and SIGINT/SIGTERM are forwarded, so Windows
  Git Bash / CMD / PS all work.
