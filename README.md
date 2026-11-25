<div align="center">

<img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/hero.png" alt="AgentWorkShop — agent teams driving a real production line" width="100%" />

<br />

# AgentWorkShop

**Where AI agent teams meet the production line.**

[![npm version](https://img.shields.io/npm/v/agentworkshop?logo=npm&logoColor=white&label=npm&color=CB3837)](https://www.npmjs.com/package/agentworkshop)
[![npm downloads](https://img.shields.io/npm/dm/agentworkshop?logo=npm&logoColor=white&label=downloads&color=CB3837)](https://www.npmjs.com/package/agentworkshop)
[![GitHub release](https://img.shields.io/github/v/release/kingdol666/AgentWorkShop?logo=github&label=release&color=35e0a0)](https://github.com/kingdol666/AgentWorkShop/releases/tag/v0.17.5)
[![Stars](https://img.shields.io/github/stars/kingdol666/AgentWorkShop?logo=github&label=stars&color=35e0a0)](https://github.com/kingdol666/AgentWorkShop/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/kingdol666/AgentWorkShop?logo=git&logoColor=white&label=last%20commit)](https://github.com/kingdol666/AgentWorkShop/commits)
[![Issues](https://img.shields.io/github/issues/kingdol666/AgentWorkShop?logo=github&label=issues)](https://github.com/kingdol666/AgentWorkShop/issues)
[![License](https://img.shields.io/badge/license-Apache%202.0-8A2BE2?logo=apache&logoColor=white)](./LICENSE)

[![Nuxt 4](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=white)](https://nuxt.com)
[![Vue 3.5](https://img.shields.io/badge/Vue-3.5-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node ≥ 23.4](https://img.shields.io/badge/Node.js-%E2%89%A5%2023.4-3C873A?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite node:sqlite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![Modbus · OPC UA · MQTT · HTTP](https://img.shields.io/badge/field%20bus-Modbus%20%C2%B7%20OPC%20UA%20%C2%B7%20MQTT%20%C2%B7%20HTTP-41c8f4?logo=siemens&logoColor=white)](https://kingdol666.github.io/AgentWorkShop/guide/daq-protocols)
[![Harness UI](https://img.shields.io/badge/UI-ChatGPT--style%20harness-c96442)](https://kingdol666.github.io/AgentWorkShop/guide/harness-ui)
[![Plugins](https://img.shields.io/badge/plugins-hot%20reload-8b5cf6?logo=puzzle&logoColor=white)](./docs/plugins.md)
[![Docs](https://img.shields.io/badge/docs-VitePress%20%C2%B7%20%E4%B8%AD%2FEN-ffd75e?logo=vitepress&logoColor=black)](https://kingdol666.github.io/AgentWorkShop)

**[简体中文](./README-zh.md)** · **[Documentation](https://kingdol666.github.io/AgentWorkShop)** · **[Releases](https://github.com/kingdol666/AgentWorkShop/releases)** · **[Changelog](./changelog.md)** · **[Plugin API](./docs/plugins.md)** · **[SDK](./docs/sdk.md)**

<sub><b>source v0.20.1 (released 2026-11-25)</b> · DAQ readiness barrier · Timescale fail-closed required schema · CI production boot smoke · host-secret scrubbing across harnesses · explicit desktop update consent · system, manual and direct update routes · resumable verified downloads · one workshop mark across sidebar, rail, splash and icons · power-on boot sequence · generated desktop icon set with theme-aware tray · rebuilt close-session control and swept button family · console workspace-scoped channel creation · API identity-before-lookup hardening · bounded line queries · shared theme and accessibility refresh · desktop tray + boot splash · integrated desktop shell with in-app updates · shared <code>~/.AgentWorkShop</code> home · 14 engines · 6 field protocols (5 built-in + serial plugin) + MES REST (mirror & live) · **Project center** · **RSI experience evolution** · **governed product experience** · **IDD/RAG plugin integration** · **AgentPrefab / Skills / MCP capability supply chain** · bilingual docs (简体中文 / English)</sub>

<br />

*A configuration-driven platform where **AI agent teams** and industrial systems share one runtime. Agents query telemetry and propose supervisory changes through governed paths; whether a write needs HITL depends on the effective line, Channel and binding modes. Simulation evidence is not physical HIL or production approval.*

</div>

[Quick start](#quick-start) · [Current source](#current-source-v0-20-1) · [0.20.1 release notes](#whats-new-in-0201) · [Agent team model](#the-agent-team-model) · [Capabilities](#capabilities) · [Architecture](#architecture) · [Verification](#verification) · [Docs site](https://kingdol666.github.io/AgentWorkShop)

---

## What is this?

A configuration-driven platform where **AI agent teams** and industrial systems share one runtime. Agents can query telemetry and propose supervisory changes through policy-governed paths; whether a write requires HITL depends on the effective line, Channel and binding modes. Simulation evidence is not physical HIL or production approval.

- **Supervisory layer** (SCADA-adjacent, second-level soft real-time): DAQ, write control, line/recipe/batch, permissions and audit in one place;
- **Agents are not chat decoration**: 14 executable engines, mixable per channel (omp / codex / opencode / claude / gemini / …), a 7-state task machine + root queue + HITL approvals, and a **Channel → Session → Agent** object model that keeps teams isolated;
- **Delivery is a first-class concept**: **Project mode** turns a blueprint into a plan, a WBS with dependencies, L1 technical review, L2 owner acceptance and real deliverables — the project closes only when the deliverables pass;
- **The loop is implemented in governed stages**: read → analyze → propose → policy-controlled approval where required → write → readback/audit; the scope of each test and whether it used a simulator or physical equipment are stated with its evidence.

## Current source: v0.20.1 (released)

The source version is **0.20.1** (npm + GitHub Release, 2026-11-25). This release hardens the runtime paths found by the whole-repository review. DAQ time-series readiness now tracks the real adapter initialization (or an explicit SQLite degradation), and collectors, flushes and acceptance scripts wait on it; online recovery, offline retry and stale initialization or rollup attaches are guarded by generation checks, so a late initialization cannot overwrite a recovered adapter or silently drop samples. Timescale startup fails closed when a required table, hypertable, tag column or hot-path index cannot be created — the pool is released and the runtime degrades explicitly — while optional indexes and compression policies only warn; SQLite writes self-heal their schema, and writing through Timescale before initialization is an explicit `TSDB_NOT_READY`. CI runs the standalone `.mjs` suites plus a production boot smoke (build, isolated boot, health/SSR/401, and refusal to start without the session secret). Harness children — omp, line-spawn and the Claude Agent SDK — scrub inherited host secrets by name, preserving `AW_ENGINE_*` and explicitly supplied provider keys. It retains the 0.20.0 desktop update foundation (explicit consent, three network routes, verified resumable downloads), the 0.19.0 icon/splash direction and the 0.18.0 console/API scoping work.

v0.16.0 verification: PR quick-gates green on #262/#264/#265/#263/#266; focused suites **38/38**, post-merge **22/22** and **13/13**, Project/Prefab/Session regression set **235/235**; live isolated-instance acceptance on the release build — Leader/Prefab full chain **30/30 ×2** (create-with-prefab → provenance in SQLite → roster flags → catalog narrowing → dispatch allow/deny → user-worker protection → lead self-op denial → revision switch drops capability → unbind → remove preserves template+revisions → REST lead-delete 409), official L10 **21/21** on a fresh instance, AgentTeam CRUD/deploy/dispatch **25/25**, frontend SSR routes 200. Mimosa deep scan sealed (`sha256:a91957e0…`, 54 findings, dependency risk 0) — findings reported, not a security pass. Boundaries: external MCP positive live trace, real-OMP-model work under a prefab, and browser UI click-through remain NOT_RUN. See the [full-flow acceptance report](docs/audit/evidence/2026-11-21-fullflow-round/REPORT.md) and the [Prefab/Skills/MCP live report](docs/audit/evidence/2026-11-21-agent-prefab-acceptance/REPORT.md).

## What's new in 0.20.1

- **DAQ readiness is a real barrier**: storage reports ready only after the adapter has finished initializing (or explicitly degraded to SQLite). Collectors, flush paths and acceptance scripts wait on it; online recovery, offline retry, stale initialization and stale rollup attaches are guarded by generation checks, so a late initialization can no longer overwrite a recovered adapter or silently drop samples. A rejected barrier is recorded but no longer freezes the flush buffer. 时序库就绪门对齐真实初始化/降级；旧初始化与旧旁路装配被代次守卫；屏障拒绝只记录不再冻结刷盘。
- **Timescale fails closed on required schema**: required tables, hypertables, tag columns and hot-path indexes are applied without swallowed errors; any failure aborts initialization and releases the pool, while optional indexes and compression policies only warn. SQLite writes self-heal instead of dropping rows, and pre-initialization Timescale writes throw `TSDB_NOT_READY`. 必需 schema 失败即初始化失败并释放连接池；可选索引/策略仅告警；SQLite 写入自愈。
- **CI runs the release paths**: quick-gate includes the standalone `.mjs` suites (18 assertions), and `build-smoke` builds the production server, boots it on an isolated port, and checks health, SSR, 401 and refusal to start without `NUXT_SESSION_PASSWORD`. `.mjs` 套件纳入 quick-gate，新增生产构建启动冒烟。
- **Host secrets are scrubbed from every harness child**: omp, line-spawn and the Claude Agent SDK now share one name-based scrubber (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`, `PGPASSWORD`, `MYSQL_PWD`, provider prefixes) and merge explicitly supplied provider keys after scrubbing. 三类引擎子进程统一清洗宿主秘密，显式 provider key 在清洗后合并。
- **Verification (2026-11-25)**: isolated production-build acceptance — line onboarding V1–V6 **8 pass / 0 fail** (V6 skipped without a protected-line fixture), REST **73/73**, DAQ **17/17** with the degraded path still fail-closed, prefab binding **15/15**, and a real omp goal task COMPLETED with a data-grounded deliverable; full unit suite **2,350 pass / 0 fail / 1 skip**; typecheck, lint, i18n 3,496/3,496, docs 101/0, quick-gate and build-smoke green. The Mimosa scan remained incomplete (`runStatus=inconclusive`) and is **not** reported as a security pass. Evidence: [stability audit report](docs/audit/evidence/2026-11-25-stability-audit/REPORT.md).

## What's new in 0.20.0

- **User-controlled desktop updates**: automatic checks only report a newer release. The user clicks `下载更新`, waits for checksum verification, and separately chooses `安装并重启`; download completion, normal exit, Escape and the default 「稍后」 choice never install or restart. 用户完全决定检查、下载与重启安装的时机。
- **Three isolated network routes**: the updater follows the Windows system/PAC route by default, supports a manually entered credential-free HTTP/HTTPS/SOCKS5 proxy, or uses direct HTTPS. Manual proxy settings contain only a validated protocol, host and port; they cannot change the fixed GitHub repository or asset names and never affect Web/local-service traffic. 更新器新增受限手动代理配置，代理失败不静默切换线路。
- **Verified and resumable transfer**: a download resumes only with a matching strong validator and validated `206 Content-Range`; incompatible caches restart from zero. The complete installer is hashed against the exact release `SHA256SUMS.txt` before it becomes installable. 下载断点续传与完整性校验分离，未通过校验不能安装。
- **One visible brand owner per desktop shell**: when the embedded Web shell exposes its own brand, the Electron title rail removes the duplicate wordmark; the title rail remains a compact fallback for narrow drawers and brandless pages. 桌面左上角不再重复显示两个产品字标。

## What's new in 0.19.0

- **One mark, generated icons**: the “gantry A” silhouette is the only product mark — flat apex, 216-unit baseline, a triangular counter and no gradient inside the letter. Sidebar, title rail, boot splash, favicon, docs-site favicon and the desktop badge share one path, and `pnpm brand:desktop` rasterises the checked-in SVG masters into the 512 badge, the nine-entry `icon.ico` (16–64 BMP, 128/256 PNG), 180/512 PNGs and 32 px tray glyphs, byte-reproducibly. 品牌字标收敛为单一实心剪影，桌面图标由脚本从 SVG 母版生成并按尺寸封装 ICO；侧栏、标题栏、启动页与 favicon 同源。
- **Power-on boot sequence**: a scan line crosses the splash, a mint outline draws the mark and hands over to the solid glyph, then the brand rule becomes a four-station rail whose pips sit at the real stage progress; the assembly stage re-traces the outline once. Progress still comes only from the backend, nothing loops while waiting, and `prefers-reduced-motion` keeps every state while dropping the motion. 启动动画重做为一次性通电序列（扫描 / 描字 / 信号轨 / 装配复检），进度仍取真实阶段，无等待循环动效。
- **Close-session control rebuilt**: the session header now uses a 26 px chip on the semantic danger wash (`--tone-danger-bg` / `--tone-danger-dot`) at 12.5 px/600 with a 13 px single-stroke ×, 6 px between glyph and label, a deepened fill and 32 % edge on hover, a spinner while closing, and a solid vermilion primary in the confirmation — instead of the library default (14 px label in a 24 px box, a 17 px box-in-box glyph touching the text and a third red). 关闭会话改为语义红浅底控件，确认框按钮改实心朱红。
- **Button family swept**: inline `i-tabler` icons inside antd buttons now get 6 px of space (antd only spaces its own `.anticon`; 20 occurrences → 0), `autoInsertSpaceInButton` no longer widens two-character Chinese labels (14 → 0), `colorError` is the product vermilion in both themes, 15 destructive confirmations confirm with the danger button, and tables keep their own horizontal scroll so the `/tokens` action column is reachable at 1024 px. 全站按钮审计：图标贴字 20→0、二字中文自动空格 14→0、危险色统一、破坏性确认框 15 处改危险按钮、宽表容器内横扫。
- **Desktop shell**: the frameless title rail, staged splash and tray integration from the 0.17.5 baseline are unchanged in behaviour; this release updates the icons, the splash artwork and the in-app update assets. 桌面壳行为不变，本轮更新图标、启动页视觉与应用内更新资产。

## What's new in 0.18.0

- **Console channel scoping**: `POST /api/workshop/channels` mounts a new channel to the owner's default workspace (created on demand, or an explicit `workspaceId` validated before the channel exists), so REST-created channels are visible in the workspace-scoped console. The console's “new channel” dialog now sends its workspace id with the create request instead of mounting afterwards, so a channel created inside one workspace is never also attached to another. 界面与 REST 建频道统一按工作区归属，不再串区。
- **API identity before resource lookup**: agent, team, channel-template and task detail/action routes, DAQ external ingest and the A2A `message/send` method resolve the caller first, closing a 404-versus-401 id-enumeration oracle for anonymous callers. The `security.a2aCardPublic` switch now also covers JSON-RPC `agent/getCard`. 未鉴权调用者不再能借 404 探测 ID 是否存在。
- **Bounded line queries**: `GET /api/workshop/dcw/line/query` applies a 24-hour default window when `from`/`to` are omitted; an unbounded query against a shared Timescale aggregate took 10–15 s and grew with history. 省略时间窗时按最近 24h 查询。
- **Shared visual layer refresh**: token-only colours across the refreshed pages, keyboard-complete settings tabs, sidebar drawer focus trap and focus return, labelled header controls, HITL popover semantics, ≥44 px touch targets on narrow viewports, and a redesigned boot splash whose progress follows the real boot stages with `prefers-reduced-motion` support. 设置页签、导航抽屉、头部控件与启动动画的键盘与动效一致性修复。
- **Docs alignment**: the MCP guide now lists all 38 tools (including the three recipe tools), the nine bundled skills, 14 MCP test groups; README layout claims match the shipped 1180 px project grid and two-column project detail. MCP 工具与 skill 清单、项目页布局描述与实现对齐。

## What's new in 0.17.5

- **Close to tray**: the titlebar close button now hides the window instead of killing the backend. The tray icon restores it on click/double-click, and `关闭时最小化到托盘` can be turned off when a user prefers close-to-exit. 关闭窗口默认最小化到托盘，后端与正在运行的任务继续工作。
- **Tray menu**: live service state and `127.0.0.1:<port>`, reload UI, restart local service, check updates, open data/log directories, diagnostics, and a 设置 submenu with five persisted toggles: close to tray, launch at login, start hidden, tray notifications, automatic update checks. Settings live in `<home>/electron/settings.json`. 托盘菜单提供服务状态、重启服务、更新检查、数据/日志入口、诊断与 5 项设置。
- **Boot splash**: a frameless 660×440 initialization window appears immediately, reports the real stages (environment → data → service → workshop), a timestamped trace, elapsed time and progress, and reveals the main window only after `/api/health` reports `status=ok` / `workshop=ready` and the page has loaded. Failures offer retry, open logs and quit instead of dying silently. 启动动画显示真实初始化阶段；后端就绪后才进入主界面，失败可重试。
- **Acceptance evidence**: the tray is created before the backend and `desktop-status.json` records phase/port/trayCreated/windowVisible/settings. Source-mode E2E covered splash → ready, close → hidden with a healthy backend, second-instance re-show, start-hidden, close-to-exit, and clean autoquit with no orphan backend. 本轮 E2E 证据见 `docs/design/desktop-chrome/acceptance.md`。

## What's new in 0.17.4

- **Back to main on standalone pages**: `/town` (digital twin, `town` layout) and `/workshop/w/:id` (bare `console` layout) now render a localized `AppBackToMain` control — a NuxtLink to the dashboard `/`, which is the default layout with the navigation sidebar. The icon-only form is used below 640px, and the control keeps `aria-label`/`title`. 数字孪生与裸控制台新增「返回主界面」入口，回到带导航栏的仪表盘；桌面端不再被困在全屏页面。
- **Project page**: `/projects/:id` keeps its own “返回项目中心” (`/projects`) and “返回 Agent 工作台” (`/workshop`) links — both nav pages; covered by the same contract test.
- **Regression test**: a static contract asserts the control targets `/`, that TownTopNav and the console Topbar render it, that both locales define the labels, and that the project page keeps its return links. 新增静态契约测试（4/4）。
- **Verification**: the production build is checked over HTTP on `/town`, and the installed 0.17.4 desktop shows the control and navigates back to the dashboard. 生产构建与安装版实测。

## What's new in 0.17.3

- **Update install helper (historical)**: older 0.17.x notes described a fixed-delay WSH helper. The current desktop updater waits for the owned parent PID and requires an explicit native confirmation; download completion, normal exit, Escape and 「稍后」 never install or restart automatically. 更新安装助手已改为等待旧进程实际退出，并且必须由用户明确确认；下载完成、普通退出、Esc 与「稍后」都不会自动安装或重启。
- **Historical acceptance note**: the old `AW_UPDATE_AUTOINSTALL` test bypass is removed from current desktop code and must not be used for new demonstrations.

## What's new in 0.17.2

- **Update install helper (superseded)**: the first fix routed the install through a detached PowerShell helper, because the previous `cmd.exe` command string embedded quoted paths that Node escapes as `\"`. PowerShell itself exits immediately when spawned with `DETACHED_PROCESS`, so this release never installed anything either; it is superseded by 0.17.3's WSH helper. 该版 PowerShell 助手在分离启动时立即退出，已由 0.17.3 取代。
- **Regression test**: the helper invocation must not embed paths in a command line, and missing installer/executable paths are rejected.
- **Verification**: an installed 0.17.1 build checked the release, downloaded the 0.17.1 installer through the API endpoint (416,549,162 bytes, SHA-256 matched `SHA256SUMS.txt`) and reached 「重启安装」; that run reproduced the broken `cmd.exe` helper (no installer process, install directory untouched). The 0.17.2 PowerShell attempt was then reproduced as a silent no-op. 安装版实测：检查 → 下载 → SHA-256 → 安装 → 重启。

## What's new in 0.17.1

- **Update endpoint robustness**: downloads use the GitHub API asset endpoint (`/releases/assets/:id` + `Accept: application/octet-stream`) rather than `browser_download_url` on `github.com`; redirects still validate to the fixed `release-assets.githubusercontent.com` host. 更新下载改走 API 资产端点，避免受限网络下 `github.com` 不可达。
- **Transfer budget**: the installer download budget is 30 minutes (was 60 seconds), so ~500 MB assets can finish on slow links; the checksum file remains bounded. 安装包下载预算 30 分钟，慢速链路不再中途中止。
- **Verification**: a real 0.17.0 asset downloaded through the API endpoint and matched `SHA256SUMS.txt`; the 0.17.1 download-to-ready flow was covered by the release evidence, while the install step itself was fixed in 0.17.2/0.17.3. 实网资产经 API 端点下载并通过 SHA-256 校验。

## What's new in 0.17.0

- **Integrated desktop shell**: a frameless Electron window with a 40px product title rail (logo, live page title, service status, custom minimize/maximize/close) and a separate content view that loads the unchanged Nuxt/Nitro page. Light/dark theme sync, native double-click maximize, graceful sidecar shutdown, and no Node/IPC exposure to the renderer. 一体化桌面壳：40px 标题导轨 + 原样内容视图；主题同步、原生双击最大化、优雅停机。
- **One data home**: desktop, Web and CLI default to `~/.AgentWorkShop`, so users, Channels, Sessions, tasks, memories, plugins and AML state are read by both front ends. The single-writer lock refuses a second backend on the same home. 桌面/Web/CLI 共用 `~/.AgentWorkShop`，数据互通。
- **In-app update channel**: startup and 30-minute GitHub Releases checks surface a “更新 vX.Y.Z” pill in the rail. Download is HTTPS-only over four GitHub hosts with per-hop redirect validation, public-DNS checks, bounded size and `SHA256SUMS.txt` verification; the NSIS installer runs silently and the app restarts. 应用内更新：定时检查、更新按钮、哈希校验、静默安装并重启。
- **Verification in this round**: full unit suite **2,267 pass / 0 fail / 1 skip** (2,268 tests, 1 conditional skip); focused desktop/update suite **20/20**; shared-home Web↔Desktop interop both directions; a real `omp` Channel job completed with artifact `端到端演示成功` on the real `~/.AgentWorkShop`; installer install/launch and live update are covered by the release evidence. 本轮验证：单测、共享 home 双向互通、真实 `omp` 作业产物、安装器与在线更新（以发布证据为准）。

## What's new in 0.16.0

- **Leader-managed worker Prefabs (#262)**: `create_team_agent` accepts a published-revision selector (`prefabId`/`revision`/`slotValues`) and pins the binding atomically with worker creation; `update_team_agent` switches revisions (`prefab` selector) or detaches (`prefab: null`); `list_team_agents` shows each member's pinned revision/hash plus `manageable`/`protected`. Only the current Leader's own `lead_team`-created workers are manageable — human-bound workers, other leaders' workers, leads, Project Leaders and open Session clones are protected, and removal no longer deletes global Agent templates.
- **Durable creation provenance (#262, schema v10)**: `channel_agents.created_by_kind/created_by_id/created_via/created_reason` persisted on every creation path; legacy rows migrate as `system`/`protected` and never inherit Leader manageability. Worker removal recycles queued/running tasks, cancels pending chat deliveries in the same transaction and clears instance node bindings.
- **Fail-closed runtime boundaries (#264)**: native/REST/MCP/Project dispatch validates a live member in its claimed Channel before any tool runs; malformed or hash-mismatched Prefab bindings no longer fall back to legacy; the Prefab gate precedes the Project-tool early return; workers cannot obtain lead-only baseline tools; pinned capability versions must match the registry exactly.
- **Prefab profiles, Skill aliases, Project retry snapshots (#265)**: published profiles apply per-field to supported harnesses (provider/model/effort; OMP thinking level via `set_thinking_level` RPC, never launch args); unique Skill aliases canonicalize to revision ids; Project work-item retries reuse the first-pinned Prefab snapshot with CAS/hash/member-drift validation instead of re-reading current template bindings.
- **Legacy-home boot fix (schema v9, from 0.15.1)**: a 0.7-era home crashed on boot because the contract SQL built `idx_chat_deliveries_retry` before column backfill; v9 moved the index out of the contract SQL and creates it idempotently after backfill — verified against a copy of a real legacy home.

## What's new in 0.15.0 (historical release notes)

- **Skills management (#253)**: Agent Skills-standard discovery catalog and immutable managed copies (`<configRoot>/skills/<name>/<hash>/`, imports disabled by default); the Settings pane supports discover/import/enable/disable/delete and SKILL.md reading; same-name multi-source conflicts keep every source visible; `allowed-tools` stays experimental metadata and never grants tool permissions.
- **External MCP management (#254)**: HTTPS-only Streamable HTTP manifests (`<configRoot>/mcp/servers/<id>.json`), `AW_MCP_*` environment credential references (never persisted to files/UI/logs), discovery → pending → admin review (`dataSharing=shared-safe` and `classification=read` required; no write tools in the first rollout), automatic re-pending on endpoint/credential-generation/protocol/tool-name/schema changes or `maxDiscoveryAgeMs` expiry, and egress guarding (private/loopback/reserved addresses rejected, pinned DNS resolution, same-origin redirects only, no automatic retry after timeout).
- **MCP ingress identity hardening (#252)**: per-request bearer authentication, session-to-principal binding (principal change → 403 `MCP_SESSION_PRINCIPAL_MISMATCH`), device surface scoped to authorized workspaces (`device.list`/`device.read`/`device.bind_agent` self-binding only).
- **AgentPrefab revisions & bindings (#255)**: draft validation (dangerous slot keys such as command/env/token fail closed, missing required slots rejected) → CAS-published immutable revisions with content hash → Channel members pinned to a revision; the capability catalog projects builtin tools, plugin tools, managed skills and approved MCP tools into one switch surface.
- **Runtime assembly (#256)**: effective capability = prefab selection ∩ system enablement/review ∩ Channel/Project policy ∩ role/industrial gate ∩ harness-managed surface, re-authorized on every invocation; prefab prompts are injected as a low-trust wrapped context prefix; `activate_skill` serves only pinned, enabled managed skills; session clones, task-instance channels and project work items freeze snapshots at creation and retries reuse the original snapshot; missing required capabilities or broken bindings fail closed (409) for new work.
- **Packaging & docs (#257/#258)**: `skills/` ships with the production build (including a zod duplication fix); bilingual guide plus a reusable L10 live-acceptance leg.
- **Bilingual docs**: the [AgentPrefabs, Skills & MCP guide](https://kingdol666.github.io/AgentWorkShop/guide/agent-prefabs) covers discovery roots, import semantics, MCP review rules, the prefab lifecycle and snapshot boundaries.

## What's new in 0.14.0 (historical release notes)

- **Immutable experience versions (#241)**: insert-only `experience_versions` with content/evidence snapshot hashes, CAS head pointers (`EXPERIENCE_VERSION_CONFLICT`), transactional idempotent backfill (legacy rows → `legacy-unverified`, never auto-injected), and cross-kind key isolation (`EXPERIENCE_KEY_CONFLICT`).
- **One governed resolver (#241)**: authorization-epoch → scope → purpose gating; `automatic` reads require `validated` + `canary/active` deployment; overlay cache keys include the epoch so revoke/product-switch stops injection on the next turn.
- **Host-provenanced release gate (#243)**: promotion to `active` requires a `host-evaluation` ledger row; the ledger records real C−B measurements (`pValue: null` when no significance test ran — fabricated significance is rejected), release is pending → audit-acked → CAS with maker-checker separation, and withdrawal stops injection without rewriting facts.
- **Durable write-attempt ledger (#244)**: prepared/dispatched/verified/rejected/not_sent/unknown around every plant write; restart reconciliation classifies unclosed attempts and never resends; old approvals are rejected on generation/lease/context/payload mismatch. HITL rows gain the same correlation columns.
- **Plan progress & pending-plan fencing (#244)**: `planProgress` projection on project observability (`pending_approval/applied/rejected/attention_required`), and `PLAN_CHANGE_PENDING` rejects manual work items that conflict with a pending plan approval.
- **Dependency health & evidence quality (#244)**: provider/RPC/process/budget/queue/progress produce bounded actions (`continue/wait/retry/fallback_readonly/attention_required/failed`) with unknown-effect → attention; batch quality gates control evidence and training on coverage/gaps; external jobs keep upstream terminal state faithful while artifact validity gates acceptance; OMP readiness timeout reaps its own child.
- **Ontology tri-state & model reuse (#245)**: missing declared edge is `unknown` (not refuted), critical-guard observability and recipe/product lineage gate artifact reuse, and ontology candidates carry evidence provenance behind the existing human publication gate.
- **Acceptance runner & merged-main checker (#245)**: a simulation manifest is BLOCKED before any write unless environment/revision/targets/ownership-proof/arm-roots all verify; the main-audit checker requires an exact SHA, ancestor merge commits, a clean checkout and a complete evidence-digested check matrix.
- **Bilingual docs**: [governed product experience guide](https://kingdol666.github.io/AgentWorkShop/guide/governed-learning) covers the version lifecycle, resolver purposes, release flow, write ledger and audit boundaries.

## What's new in 0.13.0 (historical release notes)

- **diag-bridge v2.4**: `external/v1` is the primary contract with a pre-submit `GET /capabilities` probe (5-min fingerprint cache) and an explicit `contract=legacy` fallback; the six v1 terminal states are handled, `awaiting_input` holds the line single-flight lock and ages to `expired`, and `diag_chat` / `diag_stop` / `diag_deposit` are new tools. All seven analysis intents pass through, along with ontology / preprocessing / report-language fields.
- **rag-bridge v2.3**: document tools `kb_doc_create` / `kb_doc_search` / `kb_doc_read` / `kb_catalog` on the `aw-docs` knowledge base (separate from the `aw-industrial` experience base); two-stage retrieval is the primary path with a labelled keyword fallback; creation is idempotent and uses `index-document` (vector + BM25) because a whole-KB reindex does not refresh the backend's in-process BM25 index.
- **One-loop deposit**: `diag_deposit` reads a completed run's report, writes it to `aw-docs`, indexes it, tags it and self-checks retrieval — no manual copy step; empty reports fail readably without creating a partial document.
- **Write safety & observability**: `isPolicyWriteTool` now unions the static write list with registered plugin tools declaring `riskClass: 'write'`; plugin health exposes per-tool ok/err counters and write tools emit ops audits.
- **Bilingual guide**: [IDD / RAG plugin integration](https://kingdol666.github.io/AgentWorkShop/guide/idd-rag-plugins) covers tools, contract pinning, lifecycle, error codes, degradation and gray release.

## What's new in 0.12.0 (historical release notes)

The 0.12.0 round added claim-token CAS, recovery-hold dispositions, DCW transport-ack verification and simulator attestation; see the [changelog](./changelog.md) for the full list. Post-release hardening round 2 (`900ad228`, PR #228) fixed the four defects reproduced in the round-2 evaluation: the message watchdog is now an activity window (HITL waits no longer kill healthy long turns; the 16-minute governed turn that was aborted and replayed 3× in round 1 completed once with zero watchdog aborts), HITL expiry settles authoritatively with denial notices, rag-bridge kb_agent errors are classified (401 → rotate token instead of a misleading "check the web"), and verify-line V6 treats a missing fresh-home fixture as a documented SKIP. Gates: lint, typecheck, unit **1799/1799**, build, docs **101/101**, Skills **176/176**, MCP **14/14**, plugin **22/22**, SDK, twin 5/5. Fresh-home five-protocol round: onboarding 25/25 + smoke 7/7 on first pass; omp + `ustc/deepseek-flash` Channel governed step (HITL → run `readback-verified` 1/1, journal anchor); IDD `industrial-optimizer-loop` R001 31.7875→32.5611 g (incumbent, D=0.825) + R002 GP-EI within CI, gate 13/13; RAG index → retrieval rank 1. See the [round-2 report](docs/audit/2026-11-16-round2-fixes-full-acceptance.md). Physical HIL unverified; RAG internal agent still flaky (external); Mimosa inconclusive; the USTC key hit its 3h budget twice (external quota).

## What's new in 0.11.2 (historical release snapshot)

This patch release closes the final acceptance findings after merging PR #185 and PR #186.

- **Recipe trial preflight**: deterministic out-of-range and recipe-window-invalid candidates are rejected before HITL, with no approval card, driver write, execution batch, or device mutation.
- **Strict recipe input validation**: null, booleans, empty strings, NaN, Infinity, and nonnumeric strings fail closed as a whole batch; finite numbers and numeric strings remain supported.
- **AML nearest-neighbor regression coverage**: offset timestamps, exact timestamp precedence, tolerance boundary, and beyond-tolerance missing behavior are now independently locked to the production helper.
- **Final main acceptance**: main at report time `6af25a8b`, unit 1516/1516, PLC 11/11, Agent 9/9, API 75/75, Project 14/14, RSI 32/32, multi-round RSI 10/10, and six production UI screenshots. Evidence: `docs/audit/evidence/2026-11-12-final-main-acceptance/`.

- **Boundaries**: PLC coverage uses an isolated digital twin; deterministic mock harnesses cover orchestration; Mimosa full scan remained incomplete (`scanner_enobufs`), so this release makes no security-pass claim.
- **UI observation**: the final screenshot matrix recorded one hydration-mismatch warning on `/dcw`; no page crashed and `overflowX=0`. This remains a P3 follow-up, not a silently reported zero-console-error claim.

- **Cancellation hard-stop** (#176): canceled projects are immutable — every write/approval/proposal entry fails closed, missing runtime cancel capability aborts termination with 503 instead of silently skipping, orphan task-instance channels are cancelled and torn down in the same transaction, and unbind stops the runtime first and commits the database side in one atomic transaction.
- **RSI evidence integrity** (#180): bench p-values are recomputed server-side from per-seed data, experience promotion requires real completed same-channel task evidence, harness-profile pins render only channel-owned validated rows in matching scope, and all lifecycle transitions are expected-state CAS.
- **Session idempotency & shutdown** (#181): session messages get a durable actor-scoped `clientMessageId` (atomic INSERT-on-conflict replay, deterministic 409 on payload change), DAQ frames carry `lineId` end-to-end, and runtime stop waits for loop/dispose so shutdown no longer races the database.
- **Upgrade safety** (#182): existing databases upgrade cleanly — the messages idempotency index is now created after its columns migrate (previously crashed startup on pre-0.11.1 databases).
- **UI P0 trio** (#177–#179): shell/tokens/navigation a11y, ChatGPT-style chat rhythm, and a dashboard shift band with a real alarm queue.
- Also landed: AML nearest-neighbor dataset alignment (#166), MV-scoped action evidence (#167/#168), lock-free root-deadline collection (#169), the agent.block protocol surface end-to-end (#170/#172/#173), honest harness capability claims (#171), OMP identity harness (#174), and shared ACP HITL reply mapping (#175).

Verification: unit **1516/1516**, lint/typecheck/i18n/docs 0 fail, final main production-style acceptance on an isolated build — PLC twin **11/11**, governed agent control **9/9**, REST/WS/MCP **75/75**, Project multi-channel dispatch **14/14**, RSI evolution **32/32**, multi-round RSI **10/10**. Evidence: `docs/audit/evidence/2026-11-12-final-main-acceptance/`.

## What's new in 0.11.0

Three additions make the delivery layer reachable, self-improving, and provable on a real model harness.

### Project center: the delivery layer gets a front door

`/projects` is now a first-class navigation destination — sidebar, workspace homepage, command palette and route metadata — instead of a page you could only reach by typing the URL.

- **Project list**: stat band, search, status filter, per-project progress, channel / deliverable / approval chips. `GET /api/workshop/projects` now returns a server-side `summary` (work items, signed deliverables, bound channels, pending approvals, last activity), so the list renders without N+1 calls.
- **Project detail**: real channel names everywhere (binding picker, work-item table, deliverables), a five-column execution board (ready / running / waiting / blocked / completion-and-acceptance), deliverable gates (content → technical → business) and a unified decision-and-event timeline with cursor pagination.
- **No dead ends**: the list uses the platform shell, the detail keeps a breadcrumb back to the platform, and both expose the Project Leader office channel.

<p align="center">
  <img src="docs/audit/evidence/2026-11-09-project-landing/ui-projects-list.png" alt="Project center — stats, filters and progress cards" width="49%" />
  <img src="docs/audit/evidence/2026-11-09-project-landing/ui-project-plan.png" alt="Project detail — execution board and acceptance lane" width="49%" />
</p>

→ [Project guide](https://kingdol666.github.io/AgentWorkShop/guide/projects) · Live acceptance: **39/39** (blueprint → technical 409 gate → L1/L2 → completed) and **13/13** on omp / `ustc/deepseek-flash`.

### RSI: experience that is earned, not asserted

The runtime now closes a **capture → gate → promote → share → verify** loop around its own experience:

- **Capture** — a completed task or a review outcome writes a scoped experience row with task evidence; a governance write becomes an intervention-ledger row.
- **Gate** — one task is never enough: promotion to `validated` requires independent evidence (e.g. two tasks), otherwise the gate fails closed.
- **Share** — validated line-scoped experience is readable by other channels on the same line and invisible to other lines.
- **Evolve** — paired evaluation → Harness Profile `pin → shadow → active`, with rollback and a meta-layer success-rate view.
- **Verify** — an independent readback verifier turns device mismatches into a 409 that blocks L1 review: "done" is not accepted when the device disagrees.

→ [RSI guide](https://kingdol666.github.io/AgentWorkShop/guide/rsi) · Live acceptance: **32/32** on a production build (capture, fail-closed gate, HITL writes, readback block, cross-channel isolation, profile promote/rollback, meta stats, zero device writes in the learning ring).

### Real-model proof: omp + `ustc/deepseek-flash`

Channel and Project tests ran with a **real LLM harness**, not only the deterministic mock:

- two sessions in one channel each received a distinct model reply (`ALPHA-…` / `BETA-…`) with **zero cross-session leakage**;
- a Project work item dispatched into its own task-instance channel was delivered by the model in **619 s** (artifact `PROJECT-SINGLE-OK`), then reconciled, submitted, L1-reviewed, L2-accepted and completed.

→ [Channel sessions](https://kingdol666.github.io/AgentWorkShop/guide/channels-sessions) · Evidence: [`docs/audit/evidence/2026-11-09-full-acceptance/REPORT.md`](docs/audit/evidence/2026-11-09-full-acceptance/REPORT.md)

## What's new in 0.10.0 baseline: harness console, sessions, project mode

### A harness console built for reading

The Channel console and Project detail were rebuilt around the ChatGPT harness pattern — an **800 px reading column**, full-width agent blocks, right-aligned user bubbles, a **harness chip on every reply**, and a 26 px composer that keeps the conversation as the visual center. The industrial shell is still there; it just stopped competing with the work.

<p align="center">
  <img src="docs/readme-assets/harness-channel.png" alt="Channel console — ChatGPT-style harness layout" width="49%" />
  <img src="docs/readme-assets/harness-project.png" alt="Project detail — breadcrumb, leader chat, channel bindings" width="49%" />
</p>

- **Channel**: full-width agent blocks, user right bubble, harness / role / time metadata, neutral composer, hover-revealed channel ops;
- **Project**: breadcrumb header, two-column body (work area + snapshot rail), channel names instead of UUID walls, 2-line leader composer;
- **Entry pages**: 1180 px project grid with a 3-column create form, 1240 px workspace grid;
- **No behaviour removed**: every `data-testid`, keyboard shortcut, @-mention, HITL semantic and API is unchanged — verified by the 12/12 UI interaction suite.

→ [Harness UI guide](https://kingdol666.github.io/AgentWorkShop/guide/harness-ui) · [Design canvas & before/after](docs/design/2026-11-08-harness-ui/README.md)

### Channel sessions: same team, separate worlds

A Channel is the collaboration unit (members, tools, memory, task machine). A **Session** is an isolated execution environment: it clones the channel's base members — each clone gets its own runtime, mailbox, execution lock, engine process and memory domain — while sharing the channel's team memory and node bindings.

```
Channel (base members) ── session A ── clone lead + workers  → own mailbox / runtime
                       └─ session B ── clone lead + workers  → own mailbox / runtime
```

- `POST /api/workshop/channels/:id/sessions` → `{ sessionId, members }`; each clone is a real agent row with a unique `agentId`;
- sessions run **in parallel**; work inside a session stays serialized (one execution lock per clone);
- **closing session B** cancels its in-flight task tree, unloads its clones and leaves session A and the base members untouched;
- base members never leave; a closed session's clones are disabled and refused by invoke;
- template → channel → session: channel templates instantiate full teams (scene, tool profile, control policy, line binding), sessions instantiate execution environments.

→ [Channel sessions guide](https://kingdol666.github.io/AgentWorkShop/guide/channels-sessions) · Live acceptance: **20/20 multi-session**, **24/24 multi-harness isolation**

### Project mode: a contract, not a transcript

A Project binds an **office Channel with a Project Leader** and one or more **member Channels** under a plan. Work is tracked as work items with dependencies; deliverables are the denominator of completion.

```
Blueprint ─▶ Plan approval ─▶ WBS (dependsOn) ─▶ technical L1 ─▶ owner L2 ─▶ completed
   │              │                 │                  │             │
   └ channels     └ plan version    └ attempts         └ reviewed    └ approved deliverables
```

- **Blueprint instantiation**: `POST /api/workshop/projects/instantiate` with a template name or a blueprint document (channels + deliverables + work items + routing policy + mode);
- **Modes**: `observe` (shadow, record only) · `supervised` (default; plan approval + destructive-action approval) · `auto` (auto-dispatch, replan still needs approval);
- **Work item state machine**: `DRAFT → DISPATCHING → DISPATCHED → RUNNING → COMPLETED`, with `BLOCKED / REWORK / FAILED / CANCELED / SUPERSEDED`; state is a projection reconciled against attempts and root tasks;
- **Deliverables**: `planned → active → submitted → approved / rejected / waived`; L1 technical review then L2 owner acceptance, evidence must reference a real task, artifact or analysis report;
- **Continuation**: a completed project reopens when the owner sends a follow-up requirement to the same Project Leader; a new plan version is proposed instead of a new project;
- **CAL-3 historical line evidence**: the 2026-11-08 report records **78/78** for a four-stage scenario (read-only analysis → HITL write → dataset → bounded autonomous optimization), including 300 s / 60 s write gates and device readback. This is dated evidence from the line used for that report, not evidence for this simulated acceptance or other environments.

→ [Project mode guide](https://kingdol666.github.io/AgentWorkShop/guide/projects) · Evidence: [`docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md`](docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md)

## The agent team model

| Layer | What it is | What it gives you |
|---|---|---|
| **Channel** | The collaboration unit: lead + workers, harness/provider/model, tools, node bindings, task machine, HITL | A team with a stable identity and authority surface |
| **Session** | An isolated execution environment cloned from the channel's base members | Parallel work without a shared mailbox, lock or memory leak |
| **Agent** | A clonable object with a unique `agentId`, its own lifecycle and memory scope | Create / activate / disable / delete without touching other channels |
| **Project** | A delivery contract: office channel + leader + member channels + plan + deliverables | WBS, technical review, owner acceptance, auditable completion |
| **Attempt** | One execution of a work item against a channel task | Retries, rework and supersession without losing history |
| **Deliverable** | The accepted result of one or more attempts | Completion is defined by evidence, not by a chat message |

The four boundaries are deliberate: a Project Leader can never raise a Channel's write authority, an Agent can never see another channel's members, and a Session close never touches the base team.

## Capabilities

| Area | In one sentence | Deep dive |
|---|---|---|
| **Agent team runtime** | lead orchestration + worker delivery; 7-state task machine, FIFO root queue, lease fencing, process memory (FTS5 + vector), group chat & scheduled jobs | [Architecture](#architecture) |
| **Channel sessions** | template → channel → session; clone base members with their own runtime, mailbox, execution lock and memory; close one and the others keep working | [Channel sessions](https://kingdol666.github.io/AgentWorkShop/guide/channels-sessions) |
| **Project delivery** | blueprint → plan approval → WBS with dependencies → technical L1 → owner L2 → deliverables; observe / supervised / auto; **project center** for entry, progress and the execution board | [Project mode](https://kingdol666.github.io/AgentWorkShop/guide/projects) |
| **RSI experience evolution** | capture task/review evidence → fail-closed promotion gate → line-scoped sharing → paired-eval Harness Profile (`pin → shadow → active`) → readback-verified L1 gate + rollback | [RSI guide](https://kingdol666.github.io/AgentWorkShop/guide/rsi) |
| **Industrial stack** | Five field protocols (Modbus TCP/RTU · OPC UA · MQTT · HTTP) + serial plugin + MES REST (mirror & live); DAQ cadences, four-layer write limits and per-parameter acknowledgements | [Protocol guide](https://kingdol666.github.io/AgentWorkShop/guide/daq-protocols) |
| **Agent × device binding** | Three-track node authority (dcw point scoping / recipe / line-recipe management), semantic cards injected into prompts, direct writes refused; HITL is required when the effective line, Channel or binding policy requires approval | [HITL guide](https://kingdol666.github.io/AgentWorkShop/guide/hitl) · [Line integration](https://kingdol666.github.io/AgentWorkShop/guide/line-integration) |
| **Model loop** | AML auto-ML (physics priors + residual ensemble + conformal UQ) → promotion gates → policy-governed adoption where required → model deployment subject to release gates → model-driven trials | [AML manual](./docs/aml.md) |
| **Optimizer** | process model → OSQP solve → recipe_trial → promote only on improvement → unified rollback (PLC batch restore) | [Recipe versions](https://kingdol666.github.io/AgentWorkShop/guide/recipe-versions) |
| **Governance & observability** | line-scoped tri-state permissions, structured audit & error ledger, /operations timeline and system monitor; configured 60 s / 300 s write gates | [Line permissions](https://kingdol666.github.io/AgentWorkShop/guide/line-permissions) |
| **Plugin ecosystem** | hot-reloadable plugins: custom drivers/processors/node templates/agent tools/HTTP routes/browser panels/Twin Providers, `aw plugin` CLI + MCP `list_changed` | [Plugins & extension](#plugins--extension) |

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/kingdol666/AgentWorkShop/main/docs/readme-assets/architecture.png" alt="AgentWorkShop architecture: frontend → four entry points → agent runtime → industrial stack → time-series store" width="92%" />
</p>

<details>
<summary><b>Full diagram source (mermaid, open)</b></summary>

```mermaid
flowchart TB
    subgraph FE["Frontend — Nuxt 4 / Vue 3"]
        UI["Harness console · 3D twin · dashboards"]
        WS["AEP client — seq resume"]
    end
    subgraph SRV["Server — Nitro / h3"]
        REST["REST /api/workshop/**"]
        HUB["WS Hub — AEP v1"]
        A2A["A2A JSON-RPC"]
        MCP["MCP Server"]
        subgraph RT["Runtime"]
            MGR["AgentChannelManager"]
            SCH["SchedulerLoop — lead supervision"]
            TE["TaskEngine — 7-state machine"]
            AR["AgentRuntime × N"]
            MEM["AgentMemory — FTS5 + vectors"]
            BUS["ManagerBus — per-channel seq + ring buffer"]
            SESS["Session clones — own runtime / mailbox / memory"]
        end
        subgraph PJ["Project layer"]
            PS["ProjectService — lifecycle & bindings"]
            PK["Project kernel — reconcile + dispatch"]
            DEL["Deliverables · work items · approvals"]
        end
        subgraph IND["Industrial"]
            DAQ["DAQ gateway — per-node edge runtime"]
            DCW["DCW gateway — write control"]
            BR["Queue — inproc / MQTT"]
            TSDB["Time-series — SQLite / Timescale"]
        end
        subgraph HB["Harness adapters — 14 engines"]
            MOCK["mock · claude — in-process"]
            OMP["omp — RPC subprocess"]
            CDX["codex — app-server"]
            DSH["dsh · qwen · hermes — ACP"]
            OC["opencode — serve"]
            FAM["gemini · copilot · cursor · crush · goose · pi — headless CLI"]
        end
        DB[("SQLite — channels · agents · tasks · sessions
messages · memories (FTS5) · projects · deliverables · events")]
    end
    UI <--> WS
    WS --> BUS
    REST & A2A & MCP --> MGR
    MGR --> SCH & TE & AR & SESS
    PS --> PK --> DEL
    PK --> MGR
    AR --> MEM
    AR --> MOCK & OMP & CDX & DSH & OC & FAM
    MGR & TE & MEM & BUS & PS & DEL --> DB
    DAQ <--> BR --> TSDB
    DCW --> BR
    DAQ & DCW --> BUS
```

</details>

**The agent × machine bridge** (the part worth reading source for):

```
agent ──binding──▶ node (DAQ read / governed write)
  │                    │
  │  my_industrial_nodes  ◀── semantic card: meaning · unit · safe range · recipe window
  │  daq_query             ◀── scalar history, statistics + semantics
  │  daq_frames            ◀── vector/image frames
  │  recipe_propose        ──▶ structured candidate + proposal approval card
  │  recipe_trial/apply    ──▶ effective policy gates (including optional dispatch approval)
  │  line_start/stop       ──▶ HITL approval
  │                           ──▶ device write → readback → ACK + write journal
  ◀── result text with numeric values the agent can cite
```

## Quick start

```bash
node -v                            # ≥ 23.4.0 (needs built-in node:sqlite)
npm install -g agentworkshop       # → `aw` / `agentworkshop` on PATH (prebuilt output, no build step)
aw start                           # → http://localhost:3001, everything initializes into ~/.AgentWorkShop
```

Prefer not to install globally: `npx agentworkshop start`. From source: `git clone … && pnpm install && pnpm dev` (→ 3000); production: `pnpm build && pnpm start`. Update: `aw update`.

> **Bundled PLC simulator (source checkouts):** the five-protocol virtual device lives at `plc-node-simulator/` and is part of this repository, so a normal clone includes it. Root `pnpm install` installs its workspace dependencies (including `tsx`); the onboarding scripts start it as an isolated shadow. It is not included in the npm tarball. See its separate license below.

> A real agent harness needs its CLI on PATH (`omp` / `codex` / `opencode` / … pick a subset, channels can mix; `mock` and `claude` run in-process, no CLI needed). Optional DAQ infrastructure (MQTT broker + TimescaleDB) auto-starts when Docker is reachable.

**Your first “agent × line” session (about 2 minutes):**

> Start with an isolated simulator: use a fresh `AW_HOME`, independent platform/simulator ports and a `simulated=true` test line. The walkthrough provisions and starts the line, and its proposed recipe change can write to that simulator; do not connect it to a shared simulator or real production device. See the [line integration guide](https://kingdol666.github.io/AgentWorkShop/guide/line-integration) before proceeding.

1. **Sign in** — register on the isolated test instance; its first account becomes admin.
2. **Build a simulated line** — use a reviewed blueprint and the simulator onboarding flow, then create the DAQ/DCW nodes, product and recipe on the isolated test line.
3. **Create a team and Session** — deploy an Agent team into an integrated Channel and bind the Session to its trusted product snapshot.
4. **Bind nodes** — grant only the required DAQ and recipe/write scopes; do not assume `auto` or `manual` in one binding alone determines the effective approval behavior.
5. **Submit a goal** — ask for a bounded analysis and, only if justified, a governed recipe proposal.
6. **Check the result** — resolve HITL only when effective policy requires it; verify simulator readback, follow-up DAQ data and the journal. A pass is simulator evidence, not physical HIL or production acceptance.

Want the delivery experience instead of a single channel? Open **Projects → New project → continue development**, or instantiate a blueprint:

```bash
curl -X POST http://localhost:3001/api/workshop/projects/instantiate \
  -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"template":"line-optimisation","nameOverride":"CAL-3 rerun"}'
```

<details>
<summary><b>Config-driven · auth · line permissions · exec modes · scheduled jobs (open)</b></summary>

One runtime, one source of truth: **`config.yml`** (defaults) < **`runtime-settings.json`** (runtime overrides) < env vars / CLI flags; every key is declared once in `shared/config/schema.json`, and the settings UI and CLI consume the same descriptors.

**Auth**: email + password issues a bearer token (multiple tokens, revocable); `POST /api/users/register` → `authorization: Bearer <token>` on `/api/workshop/**`.

**Line tri-state permissions** (admin-managed at `/permissions`): none (default — backend returns no data) / view-only / operate (read + write). Agent write authority tracks: `dcw` point bindings (write scope + dispatch narrowing), `recipe` (single-recipe operations), `line-recipe` (all recipes on a line). Direct writes are refused; all writes retain range, recipe, step, run and ACK gates. `manual` uses HITL according to policy; `auto` does not bypass interlocks or audit.

**Exec modes**: `goal` (lead decomposes → judges → re-dispatches until satisfied) / `loop` (fixed-interval replay) / `pipeline` (ordered stages).

**Scheduled jobs**: `interval` (60s floor) / `daily` modes; busy-guard, per-run history, consecutive-failure circuit breaker; `/workshop/schedules` page or REST.

**Four entry points**: WS (AEP v1, seq resume) · MCP (in-process server) · A2A (JSON-RPC 2.0 + AgentCard) · REST (full management surface).

**Task state machine**: `SUBMITTED → ASSIGNED → WORKING → WAITING → COMPLETED` (any state may go `CANCELED / FAILED`; a FAILED task can be reassigned to retry with a fresh execution budget, root tasks are guarded by that budget).

</details>

<details>
<summary><b>Deployment · project layout · development (open)</b></summary>

**Deployment**: terminate TLS on a reverse proxy; optional infra via `docker compose up -d` (MQTT + Timescale + MinIO); `pnpm build && pnpm start` (port from `config.yml` → `server.prod.port`). All data lives in the config root and migrates automatically across versions.

**Project layout**: `app/` (Nuxt frontend) · `server/` (API and services: agents/daq/dcw/aml/projects/sessions/plugins) · `shared/` (cross-boundary contracts: config schema, protocol catalogs) · `scripts/` (acceptance and tooling) · `bench/` (industrial benchmark pipeline) · `docs/` (docs and acceptance evidence).

**Development**: `pnpm dev` hot reload; `pnpm typecheck && pnpm lint` gates; `npm run test:unit` (server tsconfig + force-exit); docs site via `npm run docs:dev` (VitePress, 中/EN).

</details>

## Plugins & extension

Plugins are a first-class extension surface: a directory + `index.mjs` gives you **agent tool registration (`ctx.tools`), custom DAQ drivers (`ctx.daq.registerDriver`), processors & node templates, HTTP routes, browser panels, settings & i18n, Twin Providers (`ctx.twin`), and line-permission hooks (`ctx.permissions`)** — enable/disable hot-reloads instantly, and a failing plugin is isolated from the main service. Built-ins cover the whole surface: custom driver + derate processor (`aw-matrix-plugin`), vector frames (`daq-vector-demo`), knowledge bridge (`rag-bridge`), diagnostics bridge (`diag-bridge`), serial (`serial-bridge`), twin provider (`twin-injection-default`). External simulators (e.g. MATLAB/Simulink) plug in via “Twin Provider registration” or “plugin tool spawn”, and their outputs feed the optimizer directly. → [Plugin API](./docs/plugins.md) · [SDK](./docs/sdk.md) · [MCP](./docs/mcp.md)

## AgentPrefabs, Skills & MCP

System Settings (0.15.0) manages the **capability supply chain** in three panes:

- **Skills**: Agent Skills-standard `SKILL.md` discovery (built-in `skills/`, managed `<configRoot>/skills`, `~/.agent/skills` (npm standard), `~/.agents/skills`, XDG, `AW_SKILL_ROOTS`); import creates an immutable managed copy (content-hash address, disabled by default) with enable/disable/delete audited; **no script inside a Skill package is ever executed** during discovery/import/activation, and `allowed-tools` remains experimental metadata.
- **External MCP**: admins register HTTPS Streamable HTTP servers (credentials only via `AW_MCP_*` environment references); tool discovery only produces a pending list and an admin must explicitly review tools as shared-safe read before any call; identity/credential/protocol/schema changes or expiry flip tools back to pending; outbound calls pass the SSRF egress guard (private/loopback/reserved rejected, same-origin redirects only, no auto-retry).
- **Agent Prefabs**: draft role prompts, scenario prompts, multi-dimensional custom slots (key/label/default/required/member-overridable/length) and per-capability switches (builtin tools / plugin tools / managed skills / approved MCP tools), then publish an immutable revision with CAS and a content hash; Channel members pin `(prefabId, revision, slots)`.

At runtime, a bound member's work is re-authorized **on every invocation** against the intersection of prefab selection × system enablement/review × Channel/Project policy × role/industrial gating × harness-managed surface; session clones, task instances and project work items freeze snapshots at creation and retries reuse them; `activate_skill` injects managed skill bodies as low-trust text; revoking a tool/skill/MCP denies the next call immediately. Live acceptance **21/21** (discover → import → enable → publish → bind → narrow → activate → deny → snapshot → no auto-upgrade → revoke → MCP checks), see the [acceptance report](docs/audit/evidence/2026-11-21-fullflow-round/REPORT.md). → [AgentPrefabs, Skills & MCP guide](https://kingdol666.github.io/AgentWorkShop/guide/agent-prefabs)

## Documentation

| Start | Build | Operate |
|---|---|---|
| [Getting started](https://kingdol666.github.io/AgentWorkShop/guide/getting-started) · [First session](https://kingdol666.github.io/AgentWorkShop/guide/first-session) | [Plugin API](./docs/plugins.md) · [SDK](./docs/sdk.md) · [CLI](./docs/cli.md) | [Configuration](https://kingdol666.github.io/AgentWorkShop/guide/configuration) · [HITL](https://kingdol666.github.io/AgentWorkShop/guide/hitl) · [Permissions](https://kingdol666.github.io/AgentWorkShop/guide/line-permissions) |
| [Harness UI](https://kingdol666.github.io/AgentWorkShop/guide/harness-ui) · [Channel sessions](https://kingdol666.github.io/AgentWorkShop/guide/channels-sessions) · [Project mode](https://kingdol666.github.io/AgentWorkShop/guide/projects) | [DAQ protocols](https://kingdol666.github.io/AgentWorkShop/guide/daq-protocols) · [DCW read/write](https://kingdol666.github.io/AgentWorkShop/guide/dcw-read-write) · [Recipes](https://kingdol666.github.io/AgentWorkShop/guide/recipe-versions) · [Line integration](https://kingdol666.github.io/AgentWorkShop/guide/line-integration) | [AML](./docs/aml.md) · [Ontology](https://kingdol666.github.io/AgentWorkShop/guide/ontology) · [EDA studio](https://kingdol666.github.io/AgentWorkShop/guide/eda) · [AgentPrefabs / Skills / MCP](https://kingdol666.github.io/AgentWorkShop/en/guide/agent-prefabs) |

## Verification

Acceptance follows the **aw-system-acceptance six-layer flow**: T0 static gates → T1 unit & contract → T2 live core loops → T3 regression → T4 plugin/tool surface → T5 release-artifact smoke.

**2026-11-08 to 2026-11-12 historical acceptance evidence (each report identifies its build/commit):**

| Suite | Result | Evidence |
|---|---|---|
| **RSI experience evolution** (capture → gate → share → profile → rollback, production build) | **32/32** | [`2026-11-09-rsi-live-e2e/report.md`](docs/audit/evidence/2026-11-09-rsi-live-e2e/report.md) |
| **Project center** (blueprint → technical 409 → L1/L2 → completed, real Chrome) | **39/39** | [`2026-11-09-project-landing`](docs/audit/evidence/2026-11-09-project-landing/project-landing-live.md) |
| **omp / `ustc/deepseek-flash`** (Project work item delivered by a real LLM, 619 s) | **13/13** | [`omp-single-report.json`](docs/audit/evidence/2026-11-09-full-acceptance/omp-single-report.json) |
| **Session isolation** (two sessions, real model replies, zero leakage) | ✔ | [`2026-11-09-full-acceptance/REPORT.md`](docs/audit/evidence/2026-11-09-full-acceptance/REPORT.md) |
| CAL-3 four-stage industrial loop (read-only → HITL write → dataset → bounded optimization) | **78/78** | [`docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md`](docs/audit/evidence/2026-11-08-industrial-acceptance/REPORT.md) |
| Multi-harness isolation (mock / omp / dsh / codex / opencode) | **24/24** | [`harness-isolation.json`](docs/audit/evidence/2026-11-08-full-acceptance/harness-isolation.json) |
| Channel template multi-session (parallel sessions + HITL write) | **20/20** | [`channel-multisession.json`](docs/audit/evidence/2026-11-08-multisession-opt/channel-multisession.json) |
| Project mode (bookkeeping delivery, 3 channels / 3 work items) | **58/58** | [`bookkeeping.json`](docs/audit/evidence/2026-11-08-final-acceptance/bookkeeping.json) |
| UI interaction (real Chrome, 12 assertions) | **12/12** | [`ui-results.json`](docs/audit/evidence/2026-11-08-full-acceptance/ui/ui-results.json) |
| Unit / typecheck / lint | **1356 pass · 0 fail · 2 skip** / ✔ / 0 error | [`docs/audit/evidence/`](docs/audit/evidence) |

Earlier rounds remain reproducible: the 2026-10-29 full round (**24 suites/checks, ~1100+ assertions, all green**), the real-device integration matrix (`e2e-golive-matrix`) **21/21** — five real protocol stacks connected, platform samples equal device-side values, four-protocol write-through, agent-token batch dispatch, honest disconnect failure and self-healing; security hardening **29/29**; adversarial error handling **26/26**; the 2026-10-31 executable test-card round: static paper-code consistency **100%** (20 anchors) · real five-protocol tier **13/13** · E1a governance ablation matches theory · api-live **75/75** · bit-exact reproduction against the 20260914 frozen baseline ×2.

| Layer | Representative suites |
|---|---|
| Live core loops | line governance 44/44 · ontology 87/87 · model loop 53/53 · optimizer 105/105 · injection closed loop 6/6 · device matrix 21/21 · CAL-3 78/78 |
| Team & delivery | multi-harness 24/24 · channel multi-session 20/20 · Project 58/58 · UI 12/12 |
| Regression | api-live 75/75 · auth matrix 29/29 · template isolation 38/38 · robustness ALL · agent-team 25/25 · error handling 26/26 |
| Special | security S1–S16 29/29 · production gates 8/8 · node authority 52/52 · three-mode live 42/42 · frozen-baseline reproduction ×2 |

Evidence and reproduction commands: [`docs/audit/evidence/`](./docs/audit/evidence) and [`docs/full-test-plan.md`](./docs/full-test-plan.md); the historical baseline (~1100+ assertions, 2026-09-24) is archived in [this coverage report](./docs/audit/e2e-2026-09-24-full-coverage.md).

## Roadmap

Delivered: channel runtime & four entry points, five-protocol DAQ/write control, node binding & HITL, recipe versioning & rollback, AML model loop & optimizer, ontology service, plugin system v2, 3D twin, scheduled jobs, 14-engine harness registry, **ChatGPT-style harness UI**, **Channel multi-session**, **Project delivery mode**, **Project center**, **RSI experience evolution**, bilingual docs — the full list lives in the [changelog](./changelog.md).

In progress / planned: **binding lifecycle** (auto-release on project completion) · **durable project workflow** (outbox + idempotent consumers + saga) · **rate-gate-aware scheduling** · **HITL intent TTL/idempotency** · **harness supervision & stuck-instance reaping** · **SLO dashboards and alerts** · **alarm outbound** (email/webhook) · **edge deployment** (edge-agent + central broker) · more scenario templates & benchmarks.

## Research paper

The governance mechanisms are written up as **“Agent-Mediated Online Data Acquisition and Governed Setpoint Control in Industrial Production Lines”** (IEEE TII submission under review). Sources and compiled draft: [`paper/tii/TII-SUBMISSION-PACKAGE-20261112/`](./paper/tii/TII-SUBMISSION-PACKAGE-20261112/); every mechanism claim is backed by in-repo evidence ([`docs/benchmarks/`](./docs/benchmarks) · [`docs/experiments/`](./docs/experiments) · [`docs/audit/`](./docs/audit)).

## Contributing

Issues and PRs welcome. Before a PR: ① read the contract you are changing ([plugins](./docs/plugins.md) / [SDK](./docs/sdk.md) / [CLI](./docs/cli.md)); ② run gates locally (`pnpm typecheck && pnpm lint`, add a real E2E for behavior changes); ③ conventional commits (enforced by the `commitlint` hook); ④ run `aw doctor` before filing a bug.

## Security

Please **do not** open public issues for vulnerabilities — report privately via [GitHub Security Advisories](https://github.com/kingdol666/AgentWorkShop/security/advisories/new). Before pointing AgentWorkShop at real devices, review the interlocks, safe ranges and HITL settings in `config.yml` — the default posture is advisory, and plant-side logic always holds the final veto.

## License

[Apache 2.0](./LICENSE) (permissive; commercial and production use allowed).

**Bundled simulator exception:** `plc-node-simulator/` is licensed separately under the PolyForm Noncommercial License 1.0.0 (see [`plc-node-simulator/LICENSE`](./plc-node-simulator/LICENSE)); it is not covered by the Apache-2.0 license above, and its required notice must be preserved. Obtain a commercial license from its copyright holder before commercial use.

---

<div align="center">

**If this project is useful to you, a ⭐ helps others find it.**

Current source version: **v0.20.1 (released 2026-11-25)** — [Release v0.20.1](https://github.com/kingdol666/AgentWorkShop/releases/tag/v0.20.1) · [Desktop update notes](./docs/desktop.md#更新通道) · [Changelog](./changelog.md) · [Documentation](https://kingdol666.github.io/AgentWorkShop)

<a href="https://star-history.com/#kingdol666/AgentWorkShop&Date">
  <img src="https://api.star-history.com/svg?repos=kingdol666/AgentWorkShop&type=Date" alt="Star history" width="70%" />
</a>

</div>
