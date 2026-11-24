## Unreleased — Workshop mark, icon system and a power-on boot sequence（2026-11-24）

- One mark on every surface: the A of the workshop gantry is a single silhouette — flat apex, 216-unit baseline, triangular counter, no gradient inside the letter, no glow. The sidebar (`AwLogo.vue`), the title rail, the boot splash, the browser favicon, the docs-site favicon and the desktop badge now carry the same path, and it still reads as an A at 16 px. 品牌字标收敛为单一实心剪影；侧栏、标题栏、启动页、网页与文档站 favicon、桌面图标同源，去掉渐变与辉光。
- The desktop icon set is generated from SVG masters by `pnpm brand:desktop` (`scripts/desktop-brand.mjs`): a 512 badge, a nine-entry `icon.ico` (16–64 BMP, 128/256 PNG), 180/512 PNGs for the web and 32 px tray glyphs. Nothing is hand-exported any more. 桌面图标改由脚本从 SVG 母版按目标尺寸光栅化并封装 ICO，不再手工导出二进制。
- The tray glyph follows Windows instead of reusing the 512 badge (which was a dark blob at 16 px): signal mint on a dark taskbar, deep jade at 4.8:1 on a light one, swapped on `nativeTheme` changes. 托盘改为裸字标并随系统主题切换。
- The boot splash became a one-shot power-on sequence: a scan line crosses the window, a mint outline draws the mark and hands over to the solid glyph, and the brand rule becomes a four-station boot rail whose pips sit at the real stage progress; assembly re-traces the outline once and ready completes the rail. Progress still comes only from the backend, nothing loops while waiting, `prefers-reduced-motion` keeps every state and drops the motion, and the CSP/IPC surface is unchanged. 启动动画重做为一次性通电序列（扫描 / 描字 / 信号轨 / 装配复检）；进度仍是真实阶段，等待期间没有循环动效。
- Frontend review fixes: the header trail no longer falls back to English slugs for `/tools`, `/data`, `/studio`, `/studio/board`, `/studio/pipeline`, `/optimizer` and `/ontology` (they read “Tools / Data / Studio…”); the appearance switch is labelled 「暗色」 instead of flipping between 「亮色 / 暗色」 while the switch itself tracks dark mode; the login dialog validates empty credentials before posting (it used to fire a request and show a raw `400 Bad Request` toast); the sidebar tagline is back to 11 px. 顶栏航迹补齐 7 条路由元数据；外观开关标题与开关语义对齐；登录框空表单不再发请求。
- The close-session control in the session header was rebuilt: it used a stock antd `danger` small button — 14 px label in a 24 px box, a 17 px box-in-box `square-x` glyph, **zero** gap between icon and text, and a third red (`#c0261f`) that matched neither the product vermilion nor the rest of the danger surfaces. It is now a 26 px chip on the semantic danger wash (`--tone-danger-bg` / `--tone-danger-dot`), 12.5 px/600, 13 px single-stroke ×, 6 px between glyph and label, hover deepens fill and adds a 32 % edge, `:active` scales, `:disabled` shows a spinner, and the confirmation's primary button is solid vermilion instead of brand green. 会话标题栏「关闭会话」重做：浅语义红底 + 朱红字、12.5px/600、13px 单线叉号、图标与文字 6px 间距，悬停加深、确认框按钮改实心语义红；不再使用组件库默认的 24px/14px 描边红按钮。
- Same defect class swept across the app (54 real loads, 27 routes × 2 themes, every antd button measured): inline `i-tabler` icons inside antd buttons had no spacing (antd only spaces its own `.anticon`) — 20 occurrences now 0; antd's `autoInsertSpaceInButton` was widening two-character Chinese labels (`部 署`, `刷 新`, `校 验`, `取 消`, `确 定`) — disabled, 14 occurrences now 0; `colorError` was a separate red from `--tone-danger-dot`, now the same value in both themes; 15 destructive confirmations (delete user/template/schedule, remove member/node, revoke token, reset tools) now confirm with the danger button instead of the brand-green one. 全站同族缺陷：按钮内联图标贴字 20 处清零（统一 6px 间距）、二字中文被 antd 自动插空格 14 处清零、antd error 色与产品语义红合并、15 处破坏性确认框改用危险色按钮。
- Wide tables keep their own horizontal scroll: antd only adds `overflow` to `.ant-table-content` when `scroll.x` is configured, so at 1024 px `/tokens` rendered an 861 px table inside a 702 px container with the action column 100 px outside the viewport and no scrollbar anywhere. The table content/body wrappers are now scrollable, so the row actions stay reachable. 未配 `scroll.x` 的宽表在桌面档也会被裁：`/tokens` 1024px 下操作列被裁到视口外且无滚动条，现改为表格容器内横扫。

- **Verification (2026-11-24)**: full unit suite **2,307 tests — 2,306 pass / 0 fail / 1 conditional skip**; desktop contracts 33/33; lint 0 errors / 0 warnings (incl. the RSI red-line scan); typecheck; CSS variables 162; i18n 3,441 / 3,441; `docs:check` 101/0; production build; real-browser pass **27 routes × 2 themes = 54 loads with 0 page errors and 0 horizontal overflow** (`docs/audit/evidence/2026-11-24-brand-refresh/REPORT.md`). Icon generation is byte-reproducible and every ICO entry 16–256 was decoded and inspected — this review caught a BMP-encoding defect where 16–64 px entries were noise, fixed and re-verified before packaging. The NSIS build was installed over the previous app (`/S`, exit 0); the installed exe, taskbar icon and tray glyph were checked on screen. Evidence: `docs/design/desktop-chrome/acceptance.md` (2026-11-24) and `live-*-20261124.png`. 本轮安全扫描没有完整封印结论，不宣称安全通过。
- **Button-family verification (2026-11-24)**: 142 buttons across 54 loads — icon-glued 0, CJK auto-space 0, danger off-palette 0 (the two hits are correctly disabled rows); geometry across 7 routes × 3 viewports (1440/1024/390) × 2 themes = 42 loads with 0 document overflow and 0 clipped buttons; close control contrast 5.36:1 light / 6.87:1 dark (AA); keyboard reachable in 32 Tab steps with the 2 px focus ring, Enter opens the confirmation whose primary is `#a83f34`. Evidence: `docs/audit/evidence/2026-11-24-close-session-button/REPORT.md`. 按钮族审计与几何检查全绿；证据与未修的既有行为（Esc 不关 popconfirm、`/users` 自身行禁用灰属正确态）记录在报告里。

## v0.18.0 — Console channel scoping, API identity-first reads and a shared visual refresh（2026-11-23）

- Channels created over REST are mounted to the owner's default workspace — created on demand, or an explicit `workspaceId` validated before the channel row exists — so they are discoverable in the workspace-scoped console (`/workshop/w/:wsId`). 控制台是工作区作用域：REST/脚本建的频道现在会挂到 owner 的默认工作区，显式 `workspaceId` 在建频道前校验归属，避免孤儿频道。
- The console's own “new channel” dialog now sends its workspace id with the create request instead of mounting afterwards. Before this, a channel created inside any workspace was also attached to the owner's oldest/default workspace, so multi-workspace users saw channels duplicated and a phantom 「默认工作区」. 界面建频道改为随创建请求提交 `workspaceId`，不再二次挂载；修复多工作区用户「频道串区 + 凭空多出默认工作区」的缺陷。
- Detail and task REST handlers, DAQ external ingest and the A2A `message/send` method resolve the caller's identity before looking up the resource, so an unauthenticated caller can no longer distinguish “id exists” from “id missing” by 404-versus-401. `security.a2aCardPublic` now also guards JSON-RPC `agent/getCard`. 11 个详情/任务 handler、数采推送与 A2A 方法改为先验身份后查资源，关闭未鉴权的 ID 枚举通道；AgentCard 公开开关覆盖 RPC 路径。
- `GET /api/workshop/dcw/line/query` applies a 24-hour default window when `from`/`to` are omitted. An unbounded query aggregated the whole `daq_samples` hypertable (10–15 s against a shared Timescale, growing with history). 省略时间窗时按最近 24h 查询，避免任何登录用户触发全表聚合。
- Shared visual layer refresh: token-only colours in the refreshed pages, keyboard-complete settings tabs (`role=tablist`, arrow/Home/End, `aria-controls`), sidebar drawer focus trap with focus return and scroll lock, labelled header controls with `aria-pressed`/`aria-expanded`, HITL popover semantics, ≥44 px touch targets on narrow viewports, and a redesigned desktop boot splash whose meter follows the real boot stages (`transform`, strong ease-out, `prefers-reduced-motion`). 共享主题、设置页签、导航抽屉、头部控件、HITL 浮层与启动动画的键盘/读屏语义与动效收敛。
- **Validated experience is replay-safe**: `upsertExperience` keyed by the source-derived `dedup_key` (for example `exp:task:<id>`, which carries no content hash) used to refresh title, content, outcome, scope and importance even on `validated`/`retired` rows while keeping the curated status. A replayed task could therefore change the text behind a validated label. Curated rows now keep all five fields; candidates still refresh. 同一任务重放不再改写已验证经验的正文/标题/结论/范围/权重（`experience-replay-immutability` 2 用例）。
- Documentation alignment: the MCP guide lists all 38 tools (adding `aw_recipe_list/update/mark_good`), the nine bundled skills and 14 MCP test groups; README layout claims now match the shipped 1180 px project grid and two-column project detail. 文档与实现对齐（工具清单、skill 清单、项目页布局）。

- **Verification (2026-11-23)**: full unit suite **2,306 tests — 2,305 pass / 0 fail / 1 conditional skip**; lint (incl. the RSI red-line scan) 0 error, typecheck, CSS variables 162, i18n 3,441:3,441, `docs:check` 101/0, MCP 14/14, plugin lifecycle 22/0, skills 197/0, frontend lifecycle 3/3, twin providers 5/5; route-derived API sweep on an isolated instance — **503 handlers / 1,060 probes, 0 server errors**; console channel creation verified end-to-end in a real browser; line governance **44/44** on an isolated instance with HITL; **27 routes × 2 themes = 54 page loads** with 0 page errors and 0 horizontal overflow. Evidence: `docs/audit/evidence/2026-11-23-release-acceptance/REPORT.md`. 本轮验证数字与证据路径见报告；安全扫描未完成，不宣称安全通过。

## v0.17.5 — Desktop tray, close-to-tray and boot splash（2026-11-23）

- Closing the desktop window now hides it to the system tray instead of stopping the local backend. The titlebar close button is labelled 「关闭到托盘」; the tray icon restores the window on click/double-click, and the same menu can switch to close-to-exit. 关闭窗口默认最小化到托盘，本机服务与正在运行的任务继续工作；托盘图标可恢复窗口。
- Native tray menu: live service state and `127.0.0.1:<port>`, reload UI, restart local service, check updates, open data/log directories, diagnostics, and a 设置 submenu with five persisted toggles — close to tray, launch at login, start hidden, tray notifications and automatic update checks. Settings live in `<home>/electron/settings.json`; `launchAtLogin` uses the Windows login item only in the packaged app. 托盘菜单提供服务状态、重启服务、检查更新、数据/日志入口、诊断与 5 项设置。
- New boot splash: a frameless 660×440 initialization window appears immediately and reports the real stages (environment → data → service → workshop), a timestamped trace, elapsed time and progress. The main window is revealed only after `/api/health` reports `status=ok` / `workshop=ready` and the page has loaded; failures show retry, open logs and quit. 启动动画显示真实初始化阶段；后端就绪后才进入主界面，失败可重试。
- The tray is created before the backend starts, and `desktop-status.json` records `phase`, `bootStage`, `port`, `trayCreated`, `windowVisible`, `settings` and `lastError` for diagnostics and acceptance. 启动即创建托盘；状态文件便于诊断与验收。
- The splash follows the existing mint/graphite instrument language (dot grid, signal rule, staged checklist, `prefers-reduced-motion` support) and is CSP-locked to inline local assets. 设计与现有桌面品牌一致。
- Verification: focused desktop suite 33/33; source-mode Electron E2E — splash → ready, close → hidden with a healthy backend, second instance re-shows the window, start-hidden, close-to-exit, clean autoquit with no orphan backend; installer and in-app update evidence recorded in `docs/design/desktop-chrome/acceptance.md`. 本轮实机证据见验收文档。

## v0.17.4 — Back to main from standalone full-screen pages（2026-11-23）

- `/town` (digital twin, `town` layout) and `/workshop/w/:id` (bare `console` layout) now render a localized `AppBackToMain` control — a `NuxtLink` to the dashboard `/`, which uses the default layout with the navigation sidebar. Before this, the desktop window had no way back from the full-screen twin scene. 数字孪生与裸控制台新增「返回主界面」入口，回到带导航栏的仪表盘；桌面端不再被困在全屏页面。
- The control shows its label on desktop and collapses to an arrow below 640px while keeping `aria-label`/`title`; it derives colors from `currentColor`, so it works on both the dark HUD and the light/dark console. 控件自适应：窄屏只留箭头，亮暗主题通用。
- `/projects/:id` keeps its own “返回项目中心” (`/projects`) and “返回 Agent 工作台” (`/workshop`) entries — both nav pages. 项目页保留两条返回导航页的入口。
- Added a static contract test (`tests/standalone-return.test.ts`, 4/4): the control targets `/`, TownTopNav and the console Topbar render it, both locales define the labels, and the project page keeps its return links. 新增静态契约测试。
- Verification: focused test 4/4; i18n parity (3441/3441, 0 unresolved), CSS variables (161 refs), frontend lifecycle contract, ESLint and typecheck green; the production build serves `/town` with the control, and the installed 0.17.4 desktop navigates back to the dashboard. 生产构建与安装版实测。

## v0.17.3 — Desktop update install helper via WSH（2026-11-23）

- The silent install + relaunch step now runs through a detached, console-free WSH helper: `wscript.exe //B //NoLogo <fixed VBS>` with `AW_UPDATE_INSTALLER`/`AW_UPDATE_EXE` in the environment. The VBS waits 6 seconds, runs the NSIS installer with `/S` and waits for it, then restarts the executable from the install directory. 更新安装改由独立无控制台 WSH 助手执行（路径走环境变量）：等待 6 秒 → `/S` 静默安装 → 重启当前安装目录中的程序。
- Root cause of the two earlier failures (both reproduced on Windows 11): (1) `cmd.exe` does not understand the `\"` quoting Node applies to quoted argv, so the installer path never resolved; (2) Windows PowerShell exits immediately when spawned with `DETACHED_PROCESS`, so the 0.17.2 helper never ran. `wscript.exe` is a GUI-subsystem host and survives the parent's exit. 两条旧路径均实测不可用：`cmd.exe` 引号转义破坏路径；分离式 PowerShell 立即退出。
- Added `AW_UPDATE_AUTOINSTALL=1` (acceptance-only) to skip the confirmation dialog for automated end-to-end runs; unit tests pin the helper host/args and reject missing installer/executable/script paths. 新增验收钩子与回归断言。
- Verification: 0.17.3 acceptance run — installed build checks the release, downloads the installer through the API endpoint, verifies SHA-256, then the helper installs over the current install directory and relaunches the app. 安装版实测：检查 → 下载 → SHA-256 → 就地安装 → 重启。

## v0.17.2 — Desktop update install helper fix（2026-11-22）

- The silent install + relaunch step now runs through a detached PowerShell helper (`buildInstallHelper`) that receives the installer and executable paths through `AW_UPDATE_INSTALLER`/`AW_UPDATE_EXE`. The previous `cmd.exe` command string embedded quoted paths, and Node on Windows escapes those quotes as `\"`, which `cmd.exe` does not understand: the update reached “重启安装” but the installer never started after the app exited. PowerShell is invoked with plain argv, waits 6 seconds, runs the NSIS installer with `/S`, then restarts the executable from the install directory. 更新安装改由独立 PowerShell 助手执行（路径走环境变量），修复 `cmd.exe` 引号转义导致安装包未启动的问题。
- Added regression tests: the helper command line must not contain drive-letter paths, and a missing installer/executable path must be rejected. 新增回归测试。
- Verification: an installed 0.17.1 build checked the release, downloaded the 0.17.1 installer through the API endpoint (416,549,162 bytes; SHA-256 matched `SHA256SUMS.txt`), reached 「重启安装」, and exposed the broken `cmd.exe` helper (no installer process, install directory untouched). The PowerShell helper shipped here was then reproduced as a silent no-op (detached PowerShell exits immediately) and replaced in 0.17.3. 安装版实测暴露旧助手缺陷；本版 PowerShell 助手在分离启动时立即退出，0.17.3 已改用 WSH 助手。

## v0.17.1 — Update channel endpoint and transfer budget fix（2026-11-22）

- Update downloads now use the GitHub API asset endpoint (`/releases/assets/:id` with `Accept: application/octet-stream`) instead of `browser_download_url` (which starts on `github.com`). The API endpoint works where `github.com` web is blocked but `api.github.com` is available; redirects still validate to the fixed `release-assets.githubusercontent.com` host and SHA-256 verification is unchanged. 更新下载改走 GitHub API 资产端点，避免受限网络下 `github.com` 不可达；重定向与 SHA-256 校验不变。
- The installer transfer budget is now 30 minutes (was 60 seconds) so a ~500 MB asset can finish on slow links; the checksum file stays bounded. 安装包下载预算从 60s 提升到 30min，慢速链路不再中途中止；校验文件仍限长。
- Verification: the real 0.17.0 asset was downloaded through the API endpoint and matched `SHA256SUMS.txt`; 0.17.1 installer/update flow re-verified below. 实网资产经 API 端点下载并通过 SHA-256 校验。

## v0.17.0 — Integrated desktop chrome, shared home, and in-app updates（2026-11-22）

- Desktop chrome: a frameless `BrowserWindow` with a 40px product title rail (brand mark, live page title, local service status, custom minimize/maximize/close), while the content area remains a separate `WebContentsView` loading the unchanged Nitro page. The rail follows the app's light/dark theme and hides the page label when the document title is only the product name. 桌面壳：40px 一体化标题导轨 + 独立内容视图，不改写网页内容；亮暗主题同步。
- Brand: new `A + channel bus` mark (`desktop/brand/icon.svg`) rendered to a transparent-corner PNG/ICO; used by the installer, executable, window and the rail's top-left logo. 新品牌图标统一用于安装器、可执行文件、窗口和左上角 Logo。
- Shared data home: desktop now defaults to the same `~/.AgentWorkShop` as Web/CLI (`AW_DESKTOP_HOME`/`AW_HOME` override), so both front ends read the same SQLite, plugins, config and AML state. The single-writer lock still prevents two backends writing one home at once. 桌面与 Web 默认共用 `~/.AgentWorkShop`，数据互通；单写者锁仍防止并发写入。
- In-app updates: the desktop checks GitHub Releases shortly after startup and every 30 minutes; a mint “更新 vX.Y.Z” pill appears when a newer release exists. Click downloads the installer, verifies `SHA256SUMS.txt`, and after confirmation runs the NSIS installer silently and restarts. Downloads are HTTPS-only, restricted to four GitHub hosts, reject credentials/non-443 ports/non-public DNS and validate every redirect. 内置更新：启动后与每 30 分钟检查 GitHub Releases；标题栏更新按钮 → 下载 → SHA-256 校验 → 静默安装并重启。仅允许四个 GitHub HTTPS 主机与公网地址。
- Supervisor health probe: fresh socket per probe and a 10s budget (was a 3s shared fetch) so a busy-but-alive dataset/plugin phase is not mistaken for a dead server. 健康探针改为独立短连接 + 10s 预算，降低重负载误重启。
- Verification: full unit suite re-run on the final tree; shared-home Web↔Desktop interop (both directions); real `omp` Channel job completed with artifact `端到端演示成功` on the real `~/.AgentWorkShop`; NSIS installer install/launch and the live update flow against the published release. 验证见 `docs/design/desktop-chrome/acceptance.md` 与本轮发布证据。

## v0.16.0 — Leader-managed worker AgentPrefabs and governed runtime boundaries（2026-11-21）

- Channel Leaders can create workers with a published AgentPrefab selector, atomically pinning `(prefabId, revision, slotValues, contentHash)` while keeping authoring and publishing restricted to the existing Prefab owner/admin surface. Leader updates support explicit revision replacement or `null` detach; omission preserves the current binding.
- Worker creation provenance is durable (`created_by_kind`, `created_by_id`, `created_via`, `created_reason`) and legacy rows migrate conservatively as `system/protected`. A Leader can only update/remove workers they created in the current Channel; human-bound workers, other Leaders' workers, leads, Project Leaders and open Session clones are protected. Removal cleans pending chat deliveries and instance node bindings without deleting global Agent templates or immutable Prefab revisions.
- Prefab authorization is fail-closed across native/REST/MCP/Project dispatch: malformed or hash-mismatched bindings, role-disallowed baseline tools, stale capability versions and template visibility crossings cannot execute or create side effects. Schema contract v9→v10 records the provenance columns.
- Verification: focused Leader/Prefab/migration suite 38/38; targeted review-fix suite 15/15; PR #262 quick-gate passed; Mimosa deep scan sealed `sha256:d8fc1b3d97302444223bf0872a5a7ae6b800102f4e3e6da7fb04248bd1ae8673` with 34 findings and dependency risk 0 (not reported as a security pass). Real OMP/DeepSeek execution, positive external MCP, browser click-through and physical HIL remain NOT_RUN/BLOCKED.

## v0.15.1 — legacy-home boot fix (schema contract v9)（2026-11-21）

- Legacy-home boot fix: a 0.7-era home (no migration ledger, `chat_deliveries` shaped without `attempts`/`next_retry_at`/`claimed_at`) crashed on boot with `no such column: next_retry_at` — the contract SQL created `idx_chat_deliveries_retry(status, next_retry_at)` before the column-backfill migration. The index moves out of the contract SQL and is created idempotently (`ensureChatDeliveryRetryIndex`) right after the backfill; SCHEMA_CONTRACT_VERSION bumps to 9 so existing v8 databases replay cleanly. 0.7 时代存量家目录启动即崩的修复：重试索引移出契约 SQL、补列后幂等创建，契约版本升到 v9。
- Verified against a copy of a real 2026-11-02 legacy home: boot completes, the three columns are backfilled, the retry index exists, schema-contract v9 is recorded, and the AgentPrefab columns land in the same pass. 在真实旧库副本上实证：boot 完成、三列补齐、索引重建、契约 v9 落账、Prefab 列同批就位。
- npm-installed 0.15.0 instances on pre-ledger homes were affected; fresh homes were never affected (first boot creates the full current schema). 全新家目录从未受影响；受影响的是 npm 安装后在旧家目录上的启动。

## v0.15.0 — AgentPrefab capability assembly: managed Skills, external MCP, pinned revisions（2026-11-21）

- Managed Skills catalog: Agent Skills-standard `SKILL.md` discovery across built-in `skills/`, managed `<configRoot>/skills`, `~/.agent/skills`, `~/.agents/skills`, XDG and `AW_SKILL_ROOTS`; import stages an immutable content-hash copy under `<configRoot>/skills/<name>/<hash>/` (disabled by default), enable/disable/delete are admin-audited, and no script inside a Skill package is ever executed during discovery, import or activation. 受管 Skill 目录：标准发现（内置/受管/`~/.agent` 等全局根）、按内容哈希不可变导入（默认未启用）、管理员审计启停、全程零脚本执行。
- External MCP broker: admin-registered HTTPS-only Streamable HTTP manifests at `<configRoot>/mcp/servers/` with `AW_MCP_*` environment credential references; discovery produces pending tool records and an admin must review each tool as `shared-safe` data + `read` classification before any call; identity/credential-generation/protocol/tool-name/schema changes and `maxDiscoveryAgeMs` expiry flip tools back to pending; outbound calls run the SSRF egress guard (private/loopback/reserved rejected, pinned DNS, same-origin redirects only, no auto-retry) and tools are exposed as `mcp_<server>_<tool>`. 外部 MCP 代理：HTTPS 清单 + 环境凭据引用 + pending→评审（shared-safe 只读）+ 失效自动回 pending + SSRF 出口防护。
- MCP ingress identity hardening: every HTTP MCP request re-authenticates its bearer token; sessions are bound to the authenticated agent principal (`MCP_SESSION_PRINCIPAL_MISMATCH` on change) and revalidate member/channel/token state per request; the device surface (`device.list`/`device.read`/`device.bind_agent`) is scoped to the caller's authorized workspaces with self-binding only. MCP HTTP 入口逐请求鉴权、会话绑主体、设备面按授权工作区收窄。
- AgentPrefab revisions: draft validation (slot-key regex, forbidden executable slot keys, capability kinds tool/plugin-tool/skill/mcp-tool) → CAS-published immutable revisions with content hash → Channel members pinned to `(prefabId, revision, slotValues)` via the binding API; a capability catalog projects builtin tools, plugin tools, managed skills and approved MCP tools into one switch surface. AgentPrefab 修订：草稿校验 → CAS 发布不可变 revision → Channel 成员固定绑定；能力目录统一开关面。
- Runtime assembly: the effective capability set is recomputed per invocation as prefab selection ∩ system enablement/review ∩ Channel/Project policy ∩ role/industrial gating ∩ harness support; prefab prompts inject as a low-trust context prefix; `activate_skill` serves only pinned enabled managed skills as low-trust text; session clones, task-instance channels and project work items freeze binding snapshots (with sha256) at creation and retries reuse them; missing required capabilities fail closed with 409 `PREFAB_REQUIRED_CAPABILITY_MISSING`. 运行时装配：每次调用重新授权的多层交集；预制体提示词低信任注入；快照冻结与重试复用；必需能力缺失 fail-closed。
- Packaging & docs: `skills/` ships with the production build (zod duplication fixed via direct-dependency override); bilingual AgentPrefab/Skills/MCP guide and README sections; the live-acceptance workflow gains the L10 prefab leg. 打包（skills 随产物分发 + zod 重复依赖修复）与双语文档；实机验收轮新增 L10 腿。
- Verification: merged-main gates at `87805eaf` all green (typecheck/lint/build/docs 101/0/i18n 3439/3439/skills 197/0/MCP 14/14/unit 2185/2186 with 1 conditional skip); isolated fresh-instance live acceptance 21/21 (discovery→import→enable→publish→bind→narrow→activate→deny→snapshot→no-auto-upgrade→revoke→MCP checks); provisioned instance passed two restart-persistence cycles (write-attempt ledger 3277 rows identical, never resent) and live bench-gate triggers. 验证：合并主干门禁全绿；隔离实例实机 21/21；存量实例重启持久性与治理评测门实机核验。

## 兼容性边界(v0.15.0)/ Compatibility boundaries

- Database schema contract v7→v8 is additive (`agent_prefabs`, `agent_prefab_revisions` tables plus prefab columns on `channel_agents`/`channel_sessions`/`project_work_items`); existing databases migrate on boot via the migration ledger, and rows without a prefab binding keep the exact legacy behavior. Schema 契约 v7→v8 为增量迁移；无绑定的存量成员保持既有行为。
- A published prefab revision is immutable; publishing a new revision never auto-upgrades existing bindings — members must be explicitly re-bound. 已发布 revision 不可变；发布新版本不自动升级既有绑定，需显式重绑。
- External MCP first rollout accepts only reviewed `shared-safe`/`read` tools over HTTPS to public addresses; write-classified tools, private targets and non-HTTP transports are rejected; credential values never enter manifests, UI, logs or prefab revisions. 外部 MCP 首版只放行评审过的 shared-safe 只读工具；凭据值不进入清单/界面/日志/预制体。
- Managed skills are injected only as low-trust text through `activate_skill`; the platform never executes skill scripts and treats skill content as untrusted data. 受管 Skill 仅以低信任文本注入，平台不执行其脚本。
- Not yet verified: external MCP positive live trace against a public HTTPS server, real OMP-model work under a prefab, and browser UI click-through acceptance; the Mimosa deep scan is sealed but inconclusive — no security-pass claim. 未验证项如实记录：外部 MCP 正向实网、Prefab 下真实模型作业、浏览器点击验收；Mimosa inconclusive 不作安全通过声明。

## v0.14.0 — Governed product experience: immutable versions, one resolver, fenced writes（2026-11-20）

- Immutable experience versions: insert-only `experience_versions` with content/evidence snapshot hashes, CAS head pointers (`EXPERIENCE_VERSION_CONFLICT`), transactional idempotent backfill (legacy rows → `legacy-unverified`, never auto-injected), cross-kind key isolation (`EXPERIENCE_KEY_CONFLICT`). 不可变经验版本：只插不改 + CAS 指针 + 幂等回填（旧行 legacy-unverified 不自动注入）+ 跨 kind 键隔离。
- One governed resolver: authorization-epoch → product/recipe scope → purpose gating; `automatic` reads require `validated` + `canary/active`; overlay cache keys include the epoch so revocation/product-switch stops injection on the next turn. 统一解析器按 epoch/作用域/用途闸读取面，撤权与换产品即时停止注入。
- Host-provenanced release gate: promotion to `active` requires a `host-evaluation` ledger row carrying the **real** C−B measurements (`pValue: null` when no significance test ran); release is pending → audit-acked → CAS with maker-checker separation; withdrawal stops injection without rewriting facts; client-submitted bench is display-only. 发布门要求宿主来源评测并只写真实测量值；两段提交 + maker-checker；撤销只停注入。
- Durable write-attempt ledger: prepared/dispatched/verified/rejected/not_sent/unknown persisted around every plant write; restart reconciliation classifies unclosed attempts (`not_sent` / `unknown`) and **never resends**; old approvals are rejected on generation/lease/context/payload mismatch; HITL rows gain the correlation columns. 产线写持久账本，重启对账不重发；旧批准按代次/租约/上下文/载荷拒绝复用。
- Plan progress & fencing: project observability exposes `planProgress` (`pending_approval/applied/rejected/attention_required`) and `PLAN_CHANGE_PENDING` rejects manual work items conflicting with a pending plan approval. 计划进度投影与待批冲突围栏。
- Dependency health & evidence quality: provider/RPC/process/budget/queue/progress → bounded actions with unknown-effect → `attention_required`; batch quality gates control evidence/training on coverage and gaps; external jobs keep upstream terminal state faithful while artifact validity gates acceptance. 依赖健康分域决策；批次质量与外部产物有效性分开出账。
- Ontology tri-state & model reuse: missing declared edge is `unknown` (not refuted); critical-guard observability, recipe/product lineage, calibration and drift gate artifact reuse; ontology candidates carry evidence provenance behind the human publication gate. 本体缺边=未知；护栏可观测性与谱系闸工件复用。
- Acceptance runner & merged-main checker: simulation manifests BLOCK before any write unless environment/revision/targets/ownership-proof/arm-roots verify; the main-audit checker requires an exact SHA, ancestor merge commits, a clean checkout and a complete evidence-digested matrix. 验收清单预检先于任何写；主干审计绑定精确 SHA 与证据摘要。

## 兼容性边界(v0.14.0)/ Compatibility boundaries

- Governed experience deployment requires an explicit human release: new versions are `candidate`/`deployment='none'`, `automatic` reads need `validated` + `canary/active`, and `legacy-unverified` backfilled rows are never auto-injected even if their historical status was `validated`. 受治理经验的部署必须经人工发布：新版本为 candidate/none，自动注入只认 validated+canary/active，回填旧行 legacy-unverified 不继承部署。
- Unclosed plant-write attempts reconcile to `not_sent`/`unknown` on restart and are never auto-resent; `unknown` requires independent human verification. 未闭合产线写尝试对账为 not_sent/unknown 且绝不自动重发；unknown 须人工独立核实。
- Promotion to `active` requires a host-provenanced evaluation row; client-submitted bench remains readable but cannot authorize release. 晋升 active 必须引用宿主来源评测；客户端自报台账只读展示、不能授权发布。
- Existing `validated` experience rows are backfilled as `legacy-unverified` with `deployment='none'` — surface them through the review purpose or re-release them through the new gate if they should stay injectable. 既有 validated 行回填后不再自动注入，需经审阅面查看或走新发布门重新发布。
- The agent-token bridge lacks trusted turn provenance: hazardous and authorization/dispatch tools are filtered and denied; plugin tools must explicitly declare `riskClass: 'read'` to pass that layer, with other governance checks still applicable. agent-token 回程桥缺少可信回合来源，危险和授权/派发工具被过滤并拒绝；插件须显式声明只读风险类别才能通过该层。
- `dispatch_task` rejects combined `grant_node_ids` / `grantNodeIds`. Where needed, explicitly grant with `team_grant_nodes` before dispatch; these are not atomic and a failed dispatch does not undo the grant. `manual` is the delegation default; `auto` requires `confirm: true`. 派发不再随任务授权，应先单独授权再派发；失败后检查并按需撤销授权。
- Aborted native omp work or supervision turns retire their process. Late-frame provenance after normal completion remains unresolved; no new physical HIL or security-pass claim. 原生 omp 工作或监督回合中止时退役进程；正常完成后的迟到帧来源问题仍未解决，不作新增物理 HIL 或安全通过声明。
- Saved Channel scenario prompts, member configurations and custom prompts are not automatically rewritten. Review and manually migrate obsolete combined-grant instructions while preserving customization. 存量场景提示词、成员配置及自定义 prompt 不会自动改写，请检查并手动迁移旧指令。
- Structured recipe-propose approval cards take a 0-based `choice` index into the package list; an out-of-range or missing `choice` on an approval is fail-closed denied. 结构化配方审批卡的 `choice` 为方案集 0 基下标，越界或缺失一律按拒绝收敛。
- Simulator 冷启动清空预设设备:after a simulator process restart, re-materialize blueprint devices before platform writes (platform recipes/journals persist independently). 仿真器进程重启会清空预设设备，平台写入前需重新物化蓝图（配方与台账独立保留）。

## v0.13.0 — IDD/RAG plugin v1 contract & three-system acceptance（2026-11-18）

- diag-bridge v2.4: `external/v1` becomes the primary contract with a pre-submit `GET /capabilities` probe (5-min fingerprint cache) and explicit `contract=legacy` fallback; v1 six-state lifecycle, `awaiting_input` holds the line single-flight lock and ages to `expired`; new `diag_chat` / `diag_stop` / `diag_deposit`; all seven intents and ontology/preprocessing/report-language pass through; 9 error codes map to readable guidance. diag-bridge 主契约迁移 external v1（提交前定轨/legacy 回退），新增续聊/停止/入库工具，全 7 意图与本体参数透传。
- rag-bridge v2.3: document tools `kb_doc_create/search/read/catalog` on `aw-docs` (separate kv from `aw-industrial`); two-stage retrieval primary with labelled keyword fallback; idempotent create plus `index-document` (vector + BM25) because a whole-KB reindex does not refresh the backend's in-process BM25 index. rag-bridge 新增文档工具族与 aw-docs 库，two-stage 主检索、关键词降级；创建幂等并以单文档索引刷新 BM25。
- Closed loop: `diag_deposit` reads a completed run's report → `aw-docs` write → index → tags → two-stage self-check; empty report fails readably without a partial document. 诊断报告一键入库并检索自查；空报告可读失败不落半截文档。
- Safety/observability: `isPolicyWriteTool` unions the static write list with registered plugin `riskClass='write'` tools (live registry, no cache window); plugin health exposes per-tool ok/err counters; write tools emit ops audits. 插件写工具纳入 fail-closed 写族联合判定；health 暴露工具计数并留写审计。
- Verification: lint, typecheck, build; unit **2059/2060** (1 skipped). Fresh-home three-system acceptance: provisioning 9/9, channel forge 11/11, V1–V6 11/11; **142 host tools** (127 builtin + 15 plugin, +965 schema tokens); a real model turn natively called `kb_doc_search → kb_doc_read → diag_run → diag_status`; governed loop **SP 156→150→144→138 °C** (HITL every step, device-confirmed 1/1, PV retest 3/3 inside [138,142], mean 139.68), recipe v2 frozen. Evidence: `docs/audit/evidence/2026-11-18-idd-rag-plugin-v1-contract/REPORT.md`.
- Boundaries: IDD's quick-screen/stability skill did not reach a terminal state on a 60-min / 2,312-row export within 40 min (external engine/skill behavior; plugin submit/poll/stop/failure normalization verified); the deposit→index→retrieval loop is proven with a clearly-labelled mock-engine report because no real analysis run completed; cloud model providers were unavailable during acceptance (quota/subscription/connection) so the real-agent turn used a local 9B model; Mimosa deep scan sealed but **inconclusive** — no security-pass claim. 如实边界：IDD 技能终态不稳定（外部）；deposit 闭环用明确标注的 mock 报告证明机制；云端模型不可用改用本机 9B；Mimosa inconclusive 不宣称安全。

## v0.12.0 — round-3 agent safety boundaries（2026-11-17）

- Claim-token lifecycle: durable per-claim UUID tokens with exact-token CAS for claim/release/requeue/consume/quarantine (`messages.claim_token`, schema contract v3); steer settlement rechecks claim eligibility before consume and quarantines recovery-held linkage instead of replaying it. Claim 令牌全生命周期按精确 token CAS 结算;steer 结算前复检资格,恢复保留联动改为隔离不重放。
- Legacy recovery holds with an audited operator disposition: startup holds for active task trees with missing/invalid leases; admin-only `GET /api/workshop/tasks/recovery-holds` and `POST /api/workshop/tasks/:id/recovery-disposition` (audit-logged; releases the connection-tree marker, requeues in-flight messages by retry budget, never auto-replays, task state untouched). 旧任务恢复保留新增管理员处置面（审计留痕、不自动重放、任务状态不动）。
- DCW transport-ack write verification (`holdObserve`): a transport-acknowledged write releases the hold interlock only after an independent DAQ observation follows the target; timeout or missing declaration surfaces an explicit `lastError` instead of silently disabling the heartbeat forever. Observation polls slide their read window and supersede per write generation. transport-ack 写经独立 DAQ 观测跟随才解除保写锁;超时/未声明显式报错而非静默停心跳。
- Simulator ownership attestation: the vendored simulator exposes `/api/attestation` echoing a spawner-injected nonce; `sim-attest.mjs` spawns fail-closed fresh instances; all onboarding entry points verify nonce + loopback + pid + endpoint binding before any platform API request; verify-line V2/V3 writes are unblocked against attested simulators with live driverConfig binding. 模拟器归属证明（nonce 绑定）端到端落地,接入脚本证明前零平台请求,V2/V3 写验收解封。
- Idle-unload guard excludes permanent zombie messages: task-linked rows whose every referenced task no longer exists can no longer block idle unload; raw rows are retained as evidence. 孤儿任务引用不再永久阻塞空闲卸载,原始行留作证据。
- Bugbot hardening: holdObserve observation slides its read window (dense DAQ cadence could pin the newest sample and spuriously time out healthy writes); governance audit pairs driver_start/driver_end on every pre-flight failure; onboarding endpoint scanner matches explicit port/URL keys only. bugbot 加固三件套（观测滑动窗/审计配对/扫描器收紧）。
- Verification: lint, typecheck, build; unit 2015/2017（唯一失败为 main 既有 optimizer 测试,与发布分支零交集）; live acceptances — FA line end-to-end (attested sim → provision 14/14 → forge 7/7 → verify 10/0 incl transport-ack observation with holdBlocked auto-release), RSD line closed loop (analysis → recipe_propose → HITL → governed write verified 1/1 → journal → retest 111.687→108.527 matching model), paper-operator acceptance (optimization_explore Eq.1 live: u0 anchor → HITL choice=0 → journal 146→140 src=agent → exploration record), dual-scenario dispatch/memory (generic + integrated). Mimosa deep scan completed with seal (43 findings triaged, none exploitable business-path; no security-pass claim).
- Boundaries: simulator evidence only, not physical HIL; omp upstream instability under concurrent harness load (PROCESS_EXIT rebuild loops, 15-min supervise hard timeout caps wedged turns; platform defenses hold — no message loss, no double execution); RAG internal `kb_agent` write path remains unreliable (direct API proven); Mimosa inconclusive is not a security pass.

## v0.11.3 — runtime/security hardening, packaged release（2026-11-16）

- Channel config recycle no longer cancels an in-flight root task: supervise marks the lead busy, recycle defers on active work, and the scheduler aborts with an explicit runtime-stop reason.
- `markConsumed` uses a state-only `state='consuming'` guard: it cannot consume while the message is pending or dead, but a stale completion can still consume it after a new claim returns it to `consuming`. This is not per-attempt ownership CAS. `markConsumed` 仅按状态守卫；消息重新认领为 `consuming` 后旧回合仍可能将其消费，并非按执行次数隔离的 CAS.
- DAQ/DCW/MES test-driver routes close the legacy-unset SSRF hole; rag-bridge `web_url` uses the same localhost allowlist as `base_url`.
- `idd-closedloop-bridge` reports `routesReady=false` instead of a false ok when the current IDD has retired the closed-loop HTTP routes.
- `npm pack` excludes local Mimosa/Nuxt state, logs and pid files.
- Verification: lint, typecheck, unit 1790/1790, build, docs 101/101, README, Skills 176/176, MCP 14/14, plugin lifecycle 22/22, SDK, twin 5/5; simulated five-protocol line + IDD optimizer skill + RAG + omp/`deepseek-flash` Channel V1–V6 25/25, HITL 62.5→64 MPa readback 64, retest 32.416 g.
- Boundaries: simulator evidence only, not physical HIL; V6 records no new protected-line journal anchor, not physical zero disturbance. RAG internal `kb_agent` timed out; Mimosa remains inconclusive and is not a security-pass claim.

## Next — PR-9 RSI Beta management surface (2026-11-14)

- Added a read-only RSI Beta management panel to the plugin page with server-reported status, strict flags/scope, adapter health, Context/Research/Evidence provenance, and limitations.
- Added an authenticated metadata route and fail-closed visibility: absent/off flags or absent, stale, or foreign scope never expose an operational Beta surface.
- No approve, promote, actuate, control-write, or profile activation controls were added; existing UI/runtime behavior remains unchanged when Beta is absent or disabled.
- Release notes and operational boundaries: `docs/rsi-beta-management.md`.


## v0.11.2 — final acceptance closeout（2026-11-12）

- `recipe_trial` now rejects deterministic out-of-range and active recipe-window-invalid candidates before HITL, with no approval card, driver write, execution batch, or device mutation.
- Runtime input validation is fail-closed for null, booleans, empty strings, NaN, Infinity and nonnumeric strings; finite numbers and numeric strings remain supported.
- The PR #166 nearest-neighbor production helper has independent regression coverage for offset timestamps, exact timestamp precedence, tolerance boundary and beyond-tolerance missing values.
- Final main `6af25a8b`: unit 1516/1516, PLC 11/11, Agent 9/9, REST/WS/MCP 75/75, Project 14/14, RSI 32/32, multi-round RSI 10/10; UI screenshots captured from the isolated production-style instance.
- Boundaries are explicit: PLC is a digital twin, orchestration uses deterministic mock harnesses, and Mimosa full scan remained incomplete (`scanner_enobufs`); no security-pass claim is made.


完整发布产物与逐版本说明见 GitHub Releases:<https://github.com/kingdol666/AgentWorkShop/releases>

以下为核心版本节点——每个节点对应一轮可验收的能力跃迁,验收证据收录于 `docs/audit/`。

## v0.11.1 — 加固收口：取消硬停 × RSI 证据完整性 × Session 幂等 × 升级安全（2026-11-11）

- **Project 取消/终止硬停（#176）**：canceled 终态全写面 fail-closed（成员/审批/提案/绑定/成果/回调/对账）；runtime 缺失取消能力时 terminate 以 503 回滚；孤立任务实例频道事务内取消 + durable 回收。
- **RSI 证据完整性（#180）**：bench pValue 服务端按 perSeed 配对符号检验重算（客户端自报不再落台账）；经验 merge/promote validated 必须锚定本频道真实 COMPLETED 任务；pin 只渲染本频道 validated 且 scope 匹配的行；生命周期 expected-state CAS。
- **Session 幂等与停机屏障（#181）**：会话消息持久 clientMessageId（channel+session+actor+key 原子 INSERT→冲突回读；异载荷 409）；DAQ 帧 lineId 贯穿 ingest→REST→WS→前端；runtime stop 等待消费循环/dispose。
- **升级安全（#182）**：修复存量库升级启动崩溃（messages 幂等索引改在补列后创建）+ 回归测试。
- 验收：unit 1508/1508 · 生产式隔离验收 9 套件 0 FAIL。

## v0.11.0 — 项目中心 × RSI 经验演化 × 真实模型实证（2026-11-09）

- **项目中心**:`/projects` 成为一等入口(侧栏 / 工作台 / 命令面板 / 路由元数据);列表统计/搜索/筛选/每项目进度,`GET /api/workshop/projects` 追加 `summary` 零 N+1;详情真实频道名、五列执行看板、交付物三级门、决策事件统一时间线、`?tab=` 深链。实机 **39/39**。
- **RSI 经验演化**:沉淀(任务/评审/治理写)→ fail-closed 晋升门(单任务拒)→ 同产线跨 Channel 共享(异线零命中)→ 配对评测 Profile `pin → shadow → active` → 回读验证 mismatch 409 阻断 L1 → 回滚 → 元层成功率;学习环 0 设备写。实机 **32/32**。
- **真实模型实证(omp / `ustc/deepseek-flash`)**:同 Channel 双会话真实回执零串扰;Project 工作项派发到任务实例,619 秒交付 artifact,对账→L1→L2→completed,**13/13**。
- **修正与文档**:手工项目须 `activate` + 已批准 plan v1 才可派发(激活本身不要求计划);计划体不要带 `work_items/deliverables`(避免 plan alignment 重复物化);复核权限 owner/admin/project leader;README 中英与 VitePress 新增 RSI 指南并补齐 Project 项目中心/数据面。
- **质量门**:unit **1356 pass / 0 fail / 2 skip**;lint 0、typecheck ✔、docs 87/0、i18n 3293/3293、auth 29/0、REST ALL PASS;插件 11/11、工具 148(127 builtin + 21 plugin)全 available。

## v0.10.0 — Harness 控制台 × Channel 多会话 × Project 交付(2026-11-09)

- **ChatGPT 式 Harness UI**:Channel 控制台、Project 详情与入口页统一重排——800px 阅读列、Agent 通栏块、用户右侧浅泡、每条回复带 harness 标识、26px 圆角 Composer、黑白发送钮;全部 `data-testid`、快捷键、@ 提及、HITL 语义与 API 保留。PR #107 / #108 / #109。
- **Channel 多会话**:模板 → 频道 → 会话;每个会话克隆基础成员,拥有独立 runtime / mailbox / 执行锁 / 引擎进程 / 记忆域;会话内串行、会话间并行;关闭一个会话会取消其在飞任务树并卸载 clone,基础成员与其他会话不受影响。
- **Project 交付模式**:蓝图一键实例化、计划审批、带 `dependsOn` 的 WBS、技术 L1 复核、Owner L2 验收、交付物与成果台账;`observe / supervised / auto` 三模式;completed 项目可持续开发(plan vN+1)。
- **产线实证**:CAL-3 四期递进(只读分析 → HITL 写入 → 训练数据集 → 有界自主优化)在真实产线 **78/78**;Channel 多会话 **20/20**;多 harness 隔离 **24/24**;Project 交付 **58/58**;UI 交互 **12/12**;unit **1253 pass / 0 fail / 2 skip**;typecheck ✔ / lint 0。
- **文档**:README(中/英)与 VitePress 全面重写;新增 [Harness 控制台](./docs/site/guide/harness-ui.md)、[Channel 多会话](./docs/site/guide/channels-sessions.md)、[Project 模式](./docs/site/guide/projects.md) 三篇双语指南;新增 README 设计画布 `docs/design/2026-11-09-readme/canvas/`。
- **打包**:npm tarball 含预构建 `.output/`;`npm i -g` 全局安装链路实测。

## v0.9.x — Project 层与生产化(2026-11 上旬)

- **Project 层落地**:ProjectService / 办公室频道 / Project Leader / 成员 Channel 绑定 / WorkItem / Attempt / Deliverable / Result / Approval / Event;技术路由与 `routingPolicy=technical` 默认。
- **生产审计修复**:`leaderHarness` 去默认(禁止静默 mock 生产 Leader)、activate 装配 deadline、设置热重载 watcher 监听生效配置目录、lint 基线恢复、CI quick-gate 稳定。
- **部署与验收**:生产部署 runbook;BRG-5 MQTT 新产线 12/12;记账软件 Project 58/58;文档→节点→Channel→Project 全链 48/48。

## v0.8.x — 知识与闭环(2026-10 下旬)

- **v0.8.8(2026-10-31)** — **时序存储治理与生命周期健壮性收口 + bench v2 写面**。时序库五修:压缩 chunk 上 `ctid` 批删必炸(TimescaleDB 2.29 实证)改为 MIN(ts) 快进 + 时间分片普通 DELETE,保留期清理在实例运行满 1 天后不再整体失效;rollup SQL 三层修复(GROUP BY 全列覆盖 / 参数显式类型 / 运行期新线免重启发现)使 1m/1h 聚合首次真正落行;历史窗口截断改保**最新**段并如实上报 truncated;逐线保留期 PUT 部分更新不再静默抹掉既有覆写(undefined=保持 / null=重置);裁剪上界受 1m 聚合水位钳制——"超保留期=降分辨率保留"契约兑现。任务生命周期四修:停滞判定改现读全行 artifacts(有交付物的任务不再被投影空值误杀;根任务不再被规则引擎越权自动验收)、D1 兜底救援投递前复读状态(杜绝同任务第二回合并发执行)、HITL 顺延逐根分流(受审批保护的根不再被连带 ROOT_TIMEOUT,悬空审批单消除)、引擎 dispatch 终态先拒 + 未接取先接取(孤儿子任务消除)。Agent 工具面六修:refuse_task 对终态 409 诚实拒绝(不再照发"请改派"回执诱导重复派发)、report_progress 终态 fail-open 修正 + 进度钳位 [0,100]、dispatch 随单节点授权判重前移 + 派发失败自动回滚授权、消息面空内容校验 + 回执票据发送失败保留。插件宿主 home 模式路径回归修复(设置热更重载后插件数据根漂移 → diag_run 读数据集 ENOENT)。MQTT 多字段采集与下发(`driverConfig.fields` 展开多子节点 + `jsonTemplate` 模板)。bench v2 治理写面收尾(探索步激励语义 delta 修复 + 自举节拍适配),流水线/场景复绿。验收:单测 913/913 · typecheck / ESLint 全绿 · Mimosa 深扫 46 项静态发现全定性(产品代码项逐一亲验)· PIPELINE 执行卡全层实测(静态一致性 100% · plc 13/13 · E1a 四臂消融理论模式全对且误拦恒 0 · api-live 75/75 · vs 20260914 冻结基线判定类逐位复现 ×2)· IDD/RAG 插件集成链真机全通(真 PLC 工况 + omp/ustc-deepseek-flash:导出 → IDD 深度诊断受理 → 知识入库(HITL)→ 检索命中)· P12 真实 harness 透明闭环 episode(资格门全过;越权工具调用被事件监控门当场取消并冻结 153 事件证据)。
- **v0.8.7(2026-10-29)** — **错误台账 error-ledger 全链 + /logs 日志页生产化**:全异常入账三入口、限流去重、对抗套件 26 断言;/logs 采集-检索-脱敏;README 双语重设计(993/1028 → 248/247 行)。
- **v0.8.6(2026-10-28)** — **多专家设计审查整改(P0×2 + P1×11)**:Modbus 字节序纠正为标准 DCBA(旧实现实际解出 BADC);掩码凭据回写不再覆盖真实口令;停线补种以补种时刻入库;委派 auto 必须显式确认;配方频控在飞占位;Timescale `queryTagged` 补 state 与分页;owner-FK 老库迁移补齐 8 列。验收:单测 739/739 · 真实场景(Qwen3.5-9B + omp)17/17。
- **v0.8.5(2026-10-28)** — **频道执行三模式(observe / manual / auto)**:频道级执行档位与产线总闸、绑定模式三层取最严——观察档物理零写(注入白名单+分发按名拒写双保险,MES 只读族纳入观察面)、手动档频道钳位强制逐动作 HITL(审批卡展示 Agent 依据,批准附言回流)、自动档治理写必须附带 `hypothesis` 依据并入审计(`dcw.write.*` detail 记 `executionMode`/`hypothesis`);切换 REST(owner-only,放开方向须 `confirm:true`)+ 每次切换审计 + 成员运行时热回收 + 执行模式提示卡注入 + Channel 设置面三选一(产线总闸压制提示/二次确认)。存量频道缺省 auto(零行为变化)。验收:单测 673/673 · lint/typecheck/i18n/readme/docs 全绿 · e2e 34/34 · 回归 line 44/44 + tool-surface 37/37 + api-live 60/60 · 真实模拟器产线实测(物理写入证实)。另含:审批后活动批次上下文复核、omp 工具执行事件钩子。
- **v0.8.4(2026-10-26)** — 3 分钟英文界面宣传片(README / VitePress / 独立播放页)+ EDA 管道标题、在线查看器高度与本体基线 i18n 修复。
- **v0.8.3(2026-10-26)** — 结果库复验收尾(L1/L2/L4)+ 净树发布准备;全局零态实测修正。
- **v0.8.2(2026-10-25)** — 结果库 reviewer 修复:PATCH 角色闸门、热开关、绝对 URL 与证据链。
- **v0.8.1(2026-10-25)** — **diag-bridge 分析结果库**(`diag_results` / `diag_result_get` / `diag_result_annotate` 三工具 + `/plugins` 结果面板 + 五项治理开关,默认关闭,可见面 = 诊断 Token 属主);模型**可读元数据**与本体草稿**一键自修复**;本体图 tab 升级为**节点-边可视化**(1/2 跳邻接抽屉)。同轮完成全量验收:821 检查全绿(单测 538+ · 真机 e2e · MCP · 注塑 · optimizer-live 104/104)。
- **v0.8.0(2026-10-24)** — **本体服务 + AI 先行模型闭环**:10 类实体 × 8 种封闭关系 × 三级证据 × 五态生命周期;编译四工件(过程模型 / ProblemIR 增量 / 场景契约 / 控制守卫)带只收紧不变量与 Rule Trace;Agent 亲手建虚拟模型(场景发现→冻结→物理骨架→快照→试验)并经 `optimizer_profile_propose` 提议采纳,HITL 批准即发布+自动重绑——真机两轮 v1→v2→v3 零设备写入。72/72 本体 e2e · 46/46 模型闭环 e2e。

## v0.7.6x–7x — 治理与优化(2026-10)

- **v0.7.71(2026-10-24)** — **工艺优化器与求解器**:过程模型 → AML 训练(G1–G3 门禁)→ Profile 冻结 → ProblemIR 哈希锁定 → OSQP/SLSQP 求解 → TS 独立重算交叉核验 → 治理下发;**工具面声明式治理**(104 宿主工具全显式 references 声明,注册期登记制)。
- **v0.7.70(2026-10-21)** — **数据管理台 + EDA 工坊**(`/data` · `/studio`):复合查询、批量导出、golden 轨迹、FDC/SPC(Nelson 1-8 / EWMA / CUSUM)、OCAP、虚拟量测、派生数据集;npm 全局链路实测冒烟。
- **v0.7.66(2026-10-17)** — **工具调用统一预检**(tool-verify:参数形状 + 引用归属面 + 链式谱系回溯);npm latest。
- **v0.7.63–65(2026-10-15/16)** — 数据分析台账定稿(`analysis_reports` + `/analysis` 页 + IDD 六意图目录),死工具摘除,全功能验收 44/44。
- **v0.7.62(2026-10-13)** — **数据分析系统**:`analysis_save` / `analysis_query` 一等记录,产线级权限隔离。
- **v0.7.58(2026-10-11)** — **生产化硬化**:保写心跳生命周期、mock 静默兜底封堵、帧指纹 + 对象 GC、Timescale 按天 chunk + 列存压缩、堆水位自动重生。

## v0.7.4x–5x — 平台底座(2026-09)

- **v0.7.54(2026-09-30)** — 全协议矩阵回归(Modbus/OPC UA/MQTT/HTTP/串口)与 MES 集成收尾。
- **v0.7.52(2026-09-28)** — 团队知识库开关、lead→worker 节点委派、通用闭环优化模板。
- **v0.7.50(2026-09-28)** — **双模式优化闭环**(production 影子/投用)、任意场景孪生建模、`aw mcp` 网关、产线操作页、时区底座。
- **v0.7.45(2026-09-21)** — 定时任务调度、DCW 写入保持窗、真实场景合并验收全绿。
- **v0.7.42(2026-09-19)** — 全站中英 i18n 补全与端到端验收。

> 语义化版本;`aw start` 每次启动校验配置根并迁移旧版 `data/` 布局,数据可跨版本存活,SQLite schema 迁移在服务端启动时执行。
