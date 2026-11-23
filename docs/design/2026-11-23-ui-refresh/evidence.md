# UI refresh verification evidence

Date: 2026-11-23
Worktree: `D:/tmp/aw-electron-desktop`, local branch `feat/auto-default-workspace`
Evidence root: `D:/tmp/aw-ui-refresh-artifacts/`

## Static gates

- `npm run lint -- --no-fix`: pass, RSI redline pass, no ESLint errors/warnings after final fixes.
- `npm run typecheck`: pass.
- `npm run check:cssvars`: pass, 162 variable references defined.
- `npm run i18n:check`: pass, zh/en 3441/3441, unresolved 0.
- Desktop contract suites: 23/23 pass (`desktop-tray-splash`, `desktop-chrome`, `desktop-terminal-entry`).
- `npm run build`: pass. Existing non-blocking build output includes UnoCSS `tabler` icon load warning; no build failure.
- AnyDesign contrast report: `design-a11y.md`; design document lint 6/6; tokens exported to `design-tokens.json`.

## Web visual coverage

- Production output served from disposable home `D:/tmp/aw-ui-refresh-home` on `127.0.0.1:3055`.
- Static route screenshot matrix: 28 routes × dark/light at 1440×900; all loaded, page errors 0, document overflowX 0. Files: `shots/` and `shots/_report.json`.
- Narrow fixed-page matrix: templates, ontology, studio, studio-pipeline at 320×720 and 390×844, dark/light: 16/16 audit combinations 0 issues. Files: `audit-final/audit.json`, `mobile-shots-final/`.
- Final narrow candidate audit: projects, optimizer, studio-board at 320×720 and 390×844, dark/light: 12/12 combinations 0 issues. File: `audit-tail-final2/audit.json`.
- Representative screenshots inspected: dashboard dark, projects light, workshop dark, settings light, templates/DAQ/Ontology/Studio mobile, dynamic console/project states.

## Dynamic Web UI

Isolated fixtures created through REST only in the disposable home:

- Workspace: `UI Dynamic Workspace`
- Channel: `UI Dynamic Channel`
- Project: `UI Dynamic Project`

Dynamic screenshot matrix: workspace chat/sessions/board + project detail × dark/light at 1440×900, all page errors 0 and overflowX 0. Files: `dynamic/` and `dynamic/result.json`.

The same dynamic targets at 390×844 light theme all loaded with overflowX 0. A token-scoped browser smoke passed:

- workspace shell (rail, 7 view buttons, channel list, composer)
- switching to sessions view
- composer accepts input
- no page errors

Script used: `D:/tmp/aw-ui-refresh-console-smoke.mjs`.

## Drawer interaction

Token-scoped 390×844 browser smoke passed:

- drawer starts off canvas
- hamburger opens drawer
- scrim appears
- body scroll locks
- Escape closes drawer
- scroll lock clears
- no page errors

Script used: `D:/tmp/aw-ui-refresh-nav-smoke.mjs`.

## Desktop

- Splash/chrome static contract tests pass.
- Splash was not re-captured in a new Electron CDP run in this pass because the repository has no reproducible Electron remote-debugging launcher; historical v0.17.5 evidence remains in `docs/design/desktop-chrome/acceptance.md`. No new installed build, push, release, or update was performed.

## Known boundaries

- The broad 7-viewport verify script was started but stopped after its output showed remaining candidates; final targeted audits for every remaining candidate were re-run after the final production rebuild and are the authoritative results above.
- Historical/externally supplied Electron CDP evidence is not claimed as a new run.
- Physical HIL, external MCP positive traces, long real-model runs, and signed installer verification were not part of this UI refresh.
- No commit, merge, push, tag, npm publish, installer rebuild, or installed desktop update was performed.
