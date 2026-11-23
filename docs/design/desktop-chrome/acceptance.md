# Desktop chrome acceptance — 2026-11-22

## Brand, icon set and boot sequence — 2026-11-24

Branch `feat/brand-mark-icons-splash-20261124` (PR #289). All numbers below come from this machine,
not from a CI runner.

| Check | Result |
| --- | --- |
| Icon pipeline | `node scripts/desktop-brand.mjs` twice → `icon.ico` / `icon.png` byte-identical (SHA-256 match); `icon.ico` has 9 entries (16–64 BMP, 128/256 PNG) |
| ICO pixels | Every entry 16–256 decoded with Pillow and inspected; 16/32/48/64 show the badge, not noise. **A defect was found here first**: the BMP entries were built from raw binary decoded as base64, so 16–64 were a colour strip. Fixed in `70a5af35`, regenerated, re-verified |
| Icon, Windows shell | `SHGetFileInfo` on the packaged `AgentWorkShop.exe` and on the `.ico` both return the navy badge with the paper-white A (`live-exe-icon-20261124.png`) |
| Installer | `AgentWorkShop-Setup-0.18.0-win-x64.exe` — 412,465,546 bytes, SHA-256 `342fd5cfb4120fa831714c4b922f93605c7bf79ada46220ee6f936a3e9b2b1bd`; silent `/S /D=D:\tmp\aw-desktop-install-v0174`, exit 0 |
| npm payload | `agentworkshop-0.18.0.tgz` — 45,561,152 bytes, SHA-256 `8661996866e2cb6a358ed56c560a13d36ddd98b565f25736359c0eb726840093`, installed alone into an isolated prefix |
| Installed exe | `ProductVersion 0.18.0.0`, `FileVersion 0.18.0`, timestamp 2026-11-24 02:17; asar contains `nativeTheme.shouldUseDarkColors` and `build/tray-{dark,light}.png` (hash equal to the repo's `icon.png`) |
| Boot splash, live | Captured from the real frameless window: `live-splash-draw-20261124.png` (0.65 s — mint outline plus the scan line), `live-splash-rail-20261124.png` (1.1 s — solid mark, rail at 52 %, stage 03/04, trace lines) |
| Main window, live | `live-main-window-20261124.png` — title rail with the bare mark, sidebar `AGENTWORKSHOP / DIGITAL TWIN`, dashboard at 150 % DPI |
| Taskbar icon | `live-taskbar-icon-20261124.png` — dark plate, paper-white A, running underline |
| Tray icon | `live-tray-icon-20261124.png` — bare deep-jade A for the light taskbar (system reports `SystemUsesLightTheme=1`); the mint variant is selected when Windows is dark. A stale `NotifyIconSettings` snapshot from the previous version was backed up to `D:/tmp/aw-brand-20261124/private/tray-cache-backup.reg` and removed; the rebuilt entry shows the new glyph |
| Process hygiene | The 0.18.0 app was idle (`wiredAgents 0`, `activeChannels 0`) before it was stopped for the update; the stale source-mode instance and the old web demo from the previous session were stopped (the web demo was restarted from the new build on :3011). The updated app is left running (`pid 64596`, `phase ready`, `port 58593`) |

Notes: the tray screenshot is captured from the Windows 11 hidden-icons flyout through UIA (matched by
tooltip); the flyout is acrylic, so its apparent background follows the window behind it. No npm publish
or GitHub release is part of this round.

Worktree: `D:/tmp/aw-electron-desktop`, branch `feat/desktop-chrome` (from `origin/main` `3a931171`). Changes are committed on this branch; the user's main working tree was not touched.

## Delivered

- Integrated 40px title rail as the window document (`desktop/chrome/titlebar.html`), with the AgentWorkShop mark, live page title (hidden when the page title is just the product name), local service status, and custom minimize/maximize/close controls. Content remains a separate `WebContentsView` loading the untouched Nitro page.
- Window-control IPC contract (`desktop/chrome/contract.mjs`, `preload.cjs`) with sender checks, sandboxed preload, and a fixed action allowlist. Rail follows the app's `html.dark` theme and hides the page label on bare product titles.
- App icon: `desktop/brand/icon.svg` → `desktop/build/icon.png` + `icon.ico`; used by the NSIS installer, executable, and window; the same mark is inline at 24px in the rail.
- Design prototype/state board: `docs/design/desktop-chrome/prototype.{html,png}`, brand notes and direction record in the same folder.
- Health probe hardening in `scripts/start.mjs`: fresh socket per probe, 10s budget (was 3s) to tolerate busy-but-alive dataset/plugin work without a watchdog restart.

## Observed evidence

| Check | Result |
| --- | --- |
| Focused desktop/TUI tests | 11/11 pass (`tests/desktop-chrome.test.ts`, `tests/desktop-terminal-entry.test.ts`) |
| Full unit suite | 2,268 tests / **2,267 pass / 0 fail / 1 skip** (`TSX_TSCONFIG_PATH=.nuxt/tsconfig.server.json node --import tsx --test --test-concurrency=4 --test-force-exit 'tests/*.test.ts'`). An earlier aborted run left the ablation fixture behind; the two affected files then passed 13/13 in isolation before this clean rerun |
| Window controls, source build | maximize → restore → minimize → restore all observed; close exited 0 with `POST /api/system/shutdown` and the supervisor stop marker |
| Window controls, final packaged build | maximize/restore/minimize/restore verified; close released the port |
| Double-click on the rail | natively maximized (tested) |
| Theme sync | light rail on the light app; after switching the app to dark, rail pixel `rgb(13,33,41)` and `data-theme=dark`; back to light verified |
| Page label | dashboard shows `仪表盘`; `/settings` (bare `AgentWorkShop` title) hides the label and divider |
| Channel/Session probe on final packaged build | 8/8 PASS: clone task COMPLETED, assignee is the clone, 275-byte artifact, assign row session stamp `cs-e4670d55`, `episodic-task` memory scoped to the session |
| Shared home interop (temp home) | Web→Desktop 3/3 (channel, completed task, desktop-created job) and Desktop→Web 4/4 (both channels and tasks visible after switching back) |
| Real home E2E (`~/.AgentWorkShop`) | Desktop opened the real workspace, a real `omp` Channel job completed with artifact `端到端演示成功`; Web on the same home then listed the same workspace/channel and the COMPLETED task. A longer exploratory `omp` job produced 60 tool/message history entries and was canceled after the observation window. The temporary admin password reset was restored hash-for-hash afterwards. |
| Update channel tests | 8/8 focused: version ordering, HTTPS/host/credential/port validation, private-DNS rejection, release asset selection, SHA256SUMS parsing, release comparison, verified download and hash-mismatch deletion |
| AML real job recheck | `PASS` submitted, completed, 6/6 gates, ONNX SHA-256, candidate linked to dataset/recipe, promoted, finite production forecast. Recheck model `mdl-mwrnz38g-2xrw8o` on dataset `ds-mwrnoxe8-dsmu0r` |
| AML full e2e | 37 PASS / 1 FAIL: 4 batches, dataset, cross-line/wrong-product rejections passed; the default G3 gate correctly rejected the synthetic fixture at 23.5% > 20%. The rejected job `job-mwrnp7o0-dkpyut` had one-step test NRMSE 0.0154 and rollout 0.0169. A test-scoped `aml.gates.valTestGap=0.3` override was used for the focused recheck and then cleared (`runtime-settings.json` overrides empty) |
| Installer | NSIS build and silent install exit 0; installed app launched at `127.0.0.1:62626` with DAQ online and closed gracefully |
| Icon | extracted from the installed `AgentWorkShop.exe` at 32×32; matches the mint/cyan A badge |

## Known limitation

Under repeated full AML acceptance runs the shared Timescale run-data queries reached ~5.6–9.1s and `/api/plugins/manifest` reached ~10.7s while the plugin host was loading. The supervisor's three-probe watchdog then restarted the child (health probe now tolerates 10s, but the stall exceeded it). Training/evaluation artifacts remained valid; this is a load/stability limitation of the acceptance scenario, not a titlebar regression. No claim is made that the full real e2e is flake-free.

## Artifacts

- Installer: `D:/tmp/aw-desktop-installer-chrome-final/AgentWorkShop-Setup-0.16.0-win-x64.exe` — 529,521,351 bytes, SHA-256 `80a0658a25bca1fcca77191f785c6c195dfa2111461655da62a9ce443cfdf820` (compression level 1, unsigned).
- npm tarball: `D:/tmp/aw-electron-artifacts/chrome-pack/agentworkshop-0.16.0.tgz` — 45,341,869 bytes, SHA-256 `e97a57404f199ed825d86868076ad0c8987711e80651b78e3f788b5fd4085a78`.
- Screenshots: `D:/tmp/aw-electron-artifacts/final-installed-clean-top.png`, `chrome-dark-top.png`, `chrome-dashboard-1600.png`, `final-exe-icon.png`.
- AML job log: `D:/tmp/aw-desktop-chrome-XVxSLF/aml/jobs/job-mwrnp7o0-dkpyut/run.log` (first job; gate rejection) and the recheck job recorded in `aml-job-recheck.mjs` output.

## Update install acceptance — 2026-11-23 (v0.17.3)

The in-app update flow was exercised on installed builds. The 0.17.0–0.17.2 helpers were reproduced as non-starters before the 0.17.3 host was accepted.

| Check | Result |
| --- | --- |
| v0.17.1 helper (`cmd.exe` string) | Installed build reached 「重启安装」; no installer process appeared and `D:/tmp/aw-desktop-install-v0171` was untouched. Isolated probe: Node passes `\"C:\...\"` to `cmd /c`, which `cmd.exe` does not unquote as a path |
| v0.17.2 helper (detached PowerShell) | Helper never executed: detached PowerShell spawn writes nothing, while the identical non-detached invocation works; the install directory stayed untouched |
| v0.17.3 installer | NSIS silent install exit 0 into `D:/tmp/aw-desktop-install-v0173`; `AgentWorkShop.exe` FileVersion `0.17.3` |
| Update check (installed build, `AW_UPDATE_TEST_VERSION=0.0.1`) | Titlebar pill `更新 v0.17.3`, state `available`, service status `已连接` |
| Download | 416,540,548 bytes through the GitHub API asset endpoint; SHA-256 `a1575a6312ca1c1ae63b10bd4a79a9e25e9a3e7141f7026f08f6b51ba3951109` matches `SHA256SUMS.txt` and the GitHub asset digest |
| Install chain | click `重启安装` → Electron exited code 0 → `wscript.exe //B //NoLogo %TEMP%\agentworkshop-update-helper.vbs` (pid 20536) → NSIS installer (pid 68896) with `/S`; `AW_UPDATE_AUTOINSTALL=1` was used to skip the confirmation dialog for this automated run |
| In-place upgrade proof | `resources/backend/README.md` was tampered to 61,309 bytes / `f581241cad46165171a770180e13ad17119e754b214e32a7ca05e47ba9aa5c4d` before the install; afterwards it is the original 61,285 bytes / `ba23427d9a18e506eda627af4bcb634dbbf8b98bae68f9b5a41384c5fb756634` |
| Automatic relaunch | The helper started the app at 02:34:14 on the same home (`D:/tmp/aw-desktop-update-0173-home`); supervisor pid 75480, port 51068, `/api/health` `status=ok`, `workshop=ready`, version `0.17.3`; the helper process exited afterwards |
| Global npm 0.17.3 | `aw --version` → `agentworkshop 0.17.3`; `aw start` on port 3814 with a fresh home: health `status=ok/workshop=ready`, SSR `/` 200 (32,673 bytes), `aw stop` graceful |
| Release integrity | GitHub asset digests: installer `a1575a63…`, tarball `58d6706c28333a736e5e75bfca099f3b40eaa275b7bddca9cd65d8fc7945d721`; npm tarball HTTP 200 with the same bytes |

Not covered here: Authenticode signing (installer is unsigned), physical HIL, external MCP positive traces, and long real-model runs.

## Back-to-main acceptance — 2026-11-23 (v0.17.4)

| Check | Result |
| --- | --- |
| Contract test | `tests/standalone-return.test.ts` 4/4: control targets `/`; town page, `TownTopNav` and console `Topbar` render it; zh/en labels exist; project page keeps `/projects` + `/workshop` links |
| Static gates | i18n parity 3441/3441 with 0 unresolved keys; CSS variables 161 refs; docs consistency 101/0; ESLint and typecheck exit 0; PR #277 quick-gate success |
| SSR `/town` | Production build served on a temp home: HTML contains `data-testid="back-to-main"` (the loading/empty state renders the control) |
| Browser (Chrome + puppeteer-core) | Logged in on the temp home, opened `/town` (no-channel empty state): control visible with text `返回主界面`, `href="/"`, `title`/`aria-label` set; click → `path=/`, `.home` dashboard and `.app-sider` sidebar rendered; screenshots `D:/tmp/aw-0174-town-back.png` and `D:/tmp/aw-0174-town-after-back.png` |
| Desktop, updated build | Installed 0.17.4, CDP-driven: `/town` shows the same control, click → `/` with dashboard + sidebar (`.app-sider`), control disappears on the dashboard |
| Real in-app update 0.17.3 → 0.17.4 | Installed 0.17.3 (no `AW_UPDATE_TEST_VERSION`) showed `更新 v0.17.4`; download 416,552,815 bytes with SHA-256 `03e863b334b39e673496417db27ce86669bf255a279b7856247e08386061ad11` equal to `SHA256SUMS.txt`; `重启安装` → Electron exit 0 → `wscript.exe` helper → NSIS `/S`; `resources/backend/README.md` tampered to 61,307 bytes came back as the 0.17.4 payload (62,360 bytes, `5b9cc47318abc062d7559dfc6c11856f867811710a16b606417556fa01585832`); app relaunched at 04:12 with version `0.17.4`, supervisor port 60642, `/api/health` `ok/ready` on the same home |
| Release integrity | GitHub asset digests: installer `03e863b3…`, tarball `87119a27b4c6ff7553ba9efd9698777d69a1e4ba5ea42c283843389b4a39fa3d`; npm 0.17.4 published (registry tarball propagation was still pending at report time) |

Not covered here: Authenticode signing (installer is unsigned), physical HIL, external MCP positive traces, and long real-model runs.

## Tray, settings and boot splash acceptance — 2026-11-23 (v0.17.5)

| Check | Result |
| --- | --- |
| Desktop contract tests | `desktop-chrome` + `desktop-tray-splash` + `desktop-update` + `desktop-terminal-entry` **33/33**; after the final startHidden status fix, the three touched suites re-ran **29/29**. Settings normalize/round-trip/corrupt-fallback, tray model, splash actions, CSP/aria/static checks and the close-to-tray guards are covered |
| Static gates | Typecheck exit 0; full ESLint exit 0; i18n parity **3441/3441**, 0 unresolved; CSS variables **161** refs; docs consistency **101/0**; frontend lifecycle contract **3/3** |
| Full unit suite | **2,285 tests / 2,284 pass / 1 skip / 0 fail** (`TSX_TSCONFIG_PATH=.nuxt/tsconfig.server.json node --import tsx --test --test-concurrency=4 --test-force-exit 'tests/*.test.ts'`) |
| npm tarball | `agentworkshop-0.17.5.tgz` **45,370,812 bytes**, SHA-256 `257852a89d987589536efdb370d94dc68f47060536bc4770804e6d8558292afd`, npm shasum `820318038c8910abec0115a56a5fd5aef89e064a`; contains `desktop/chrome/{splash.html,preload-splash.cjs,settings.mjs,tray-menu.mjs}` |
| Isolated npm install | `npm install -g --prefix D:/tmp/aw-install-0175 <tarball>` → `aw --version` **agentworkshop 0.17.5**; `aw start --port 3815` on a fresh home → `/api/health` `status=ok / workshop=ready / version=0.17.5`, SSR `/` HTTP 200 (32,673 bytes); `aw stop` graceful, health unreachable afterwards |
| Installer | `AgentWorkShop-Setup-0.17.5-win-x64.exe` **416,560,375 bytes**, SHA-256 `d68864a0937d349eecfc7ddd98bbc262017f1a429165dd8295e822bb74b7d17a`; silent `/S /D=D:\tmp\aw-desktop-install-v0175` exit 0; installed `AgentWorkShop.exe` FileVersion **0.17.5**, backend `package.json` **0.17.5**, `.output/server/index.mjs` present, `app.asar` contains the splash/tray modules |
| Source-mode Electron E2E | Fresh home, debug port 9344: splash target appeared (`file:///…/desktop/chrome/splash.html`) and a screenshot was captured; status phases `booting → ready`; `/api/health` `ok/ready` version 0.17.5. Clicking the real titlebar close button produced `phase=hidden`, `windowVisible=false`, `trayCreated=true`; the owner process stayed alive and `/api/health` still returned `ok/ready`. A second launch exited 0 and re-showed the window; the test auto-quit exited 0 and the backend was unreachable afterwards (no orphan). Screenshot `D:/tmp/aw-desktop-tray-artifacts-3/splash-boot.png` |
| Settings modes | A fresh home with `{"startHidden":true}` reached `phase=hidden / service=online / trayCreated=true / windowVisible=false`, and a second launch re-showed it; a home with `{"closeToTray":false}` exited 0 on the titlebar close and its backend became unreachable; both runs quit cleanly (ports 9341/9342) |
| Installed-app E2E | Installed 0.17.5 launched at debug port 9350: splash target `file:///D:/tmp/aw-desktop-install-v0175/resources/app.asar/chrome/splash.html`, status `booting/prepare` → `ready`, health `ok/ready` version 0.17.5; close → `hidden`, `trayCreated=true`, backend still `ok/ready`; second launch exited 0 and re-showed; auto-quit exited 0, backend unreachable, and no `AgentWorkShop` process matched the install directory |
| Release integrity | GitHub Release `v0.17.5` is latest; asset digests: installer `d68864a0…`, tarball `257852a8…`, `SHA256SUMS.txt` `d9572a07…`. npm `agentworkshop@0.17.5` resolves on the official registry with `dist.shasum 820318038c8910abec0115a56a5fd5aef89e064a` |
| Real-home installed smoke | The installed app behind the Desktop/Start Menu shortcut (`D:/tmp/aw-desktop-install-v0174/AgentWorkShop.exe`, FileVersion 0.17.5) launched against the real `~/.AgentWorkShop`: status `ready / online / trayCreated=true`, `/api/health` `ok/ready` version 0.17.5; the close button label was `关闭到托盘`; close → `phase=hidden`, owner alive and health still `ok/ready`; a second launch re-showed the window; autoquit exited 0, the backend became unreachable and `.runtime/aw.lock` was gone |
| Real in-app update 0.17.4 → 0.17.5 | Installed 0.17.4 (registry points at `D:/tmp/aw-desktop-install-v0174`), no `AW_UPDATE_TEST_VERSION`: titlebar showed `更新 v0.17.5`; download through the GitHub API asset endpoint reached `重启安装`, 416,560,375 bytes, SHA-256 `d68864a0…` equal to `SHA256SUMS.txt`; clicking install exited the old app with code 0, the WSH helper ran NSIS `/S`, and the updated app relaunched with status `version=0.17.5 / phase=ready / trayCreated=true`, port 52776, `/api/health` `ok/ready`. The tampered `resources/backend/README.md` (55-byte sentinel) was replaced by the 0.17.5 payload (64,252 bytes, `90525d81b96d1bebd2f59640088f1f312f2597cdfc3e56785b793144d059c261`); installed FileVersion and backend `package.json` are `0.17.5`. Autoquit then recorded `phase=quitting`, the process disappeared and the backend was unreachable. A fresh launch of the updated install (debug port 9361) repeated splash → ready, close → hidden with a healthy backend, second-instance re-showing and clean exit |

Not covered here: Authenticode signing (installer is unsigned), physical HIL, external MCP positive traces, and long real-model runs.

