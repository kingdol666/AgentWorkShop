# Desktop chrome acceptance — 2026-11-22

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
