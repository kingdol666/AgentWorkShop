**The working tree changed while I was reading it.** It began with the 14 files you named and now has about 39 modified files (14 more `server/api` routes, a v0.18.0 bump) plus new untracked tests and scripts. The in-scope 14 files and the commit's server files kept identical diff stats throughout. Nothing was run; this is all from reading.

## Findings

**P0: none.**

**P1**

1. Commit `7fc10e87` on its own breaks the console's "新建 Channel 并挂载" modal. At HEAD, `D:/tmp/aw-electron-desktop/app/components/workshop/session-list/MountChannelModal.vue:34-44` posts without `workspaceId`, then mounts into the current workspace. `D:/tmp/aw-electron-desktop/server/api/workshop/channels.post.ts:63` now forces the default mount, so a user in workspace B gets the channel in B and in the named/oldest workspace A. The working tree already carries a fix (sends `workspaceId: props.wsId`, drops `wsStore.mountChannel`, adds test W1); I read it and it is correct. Ship it in the same change, and do not merge or cherry-pick `7fc10e87` alone.

**P2**

2. `D:/tmp/aw-electron-desktop/server/api/workshop/channels.post.ts:77-86`: the `lineId` existence check (404) and `requireLineMode` (403) run after `manager.createChannel`. A non-admin without a grant gets an error, yet the channel stays created, in `production_line_integrated` mode, and now mounted and visible. Retries pile up orphans. The ordering is pre-existing, but it defeats the orphan guard at `D:/tmp/aw-electron-desktop/server/services/workshop/runtime/manager/admin-channel.ts:124-129`. Fix: hoist both checks above `createChannel`.

**P3**

3. `D:/tmp/aw-electron-desktop/tests/channel-default-workspace.test.ts:68` onward only calls `ensureChannelWorkspaceMount` and the pure selector. Nothing goes through `manager.createChannel`, so the pre-create rejection, the `workspaceId`/`workspaceName` response fields and "no mount when the flag is absent" are unpinned. Fix: add three `createChannel` tests.
4. `D:/tmp/aw-electron-desktop/server/services/workshop/runtime/manager/workspace-defaults.ts:19`: the fallback works as documented, but it files API/script channels into whatever workspace the user made first. Deleting 默认工作区 does not stop it. Acceptable if intended; otherwise create the named workspace whenever it is missing.
5. `D:/tmp/aw-electron-desktop/app/pages/workshop/channel-templates.vue:150` still instantiates unmounted channels, which are invisible in `/workshop/w/:wsId`. This is pre-existing. Fix: route it through the workspace-scoped `mountChannelTemplate`.
6. `D:/tmp/aw-electron-desktop/app/pages/projects/index.vue:899-905`: `.err-text` is now single-line with ellipsis and no `title`, so long load errors are unreadable. Fix: add `:title="error"` or allow wrapping.
7. `D:/tmp/aw-electron-desktop/app/components/app-header/HitlBell.vue:49-51` with `:21-24`: focusout with a null `relatedTarget` is ignored, and mouse-leave dismissal is blocked while focus is inside the panel. Focus a panel control, move the mouse out, click a non-focusable area: the panel stays open and Esc no longer reaches it. Fix: on null `relatedTarget`, check `document.activeElement` next tick and close if it is `body`.
8. `D:/tmp/aw-electron-desktop/app/pages/projects/index.vue:349,443,450,459`: new hardcoded zh strings ("同步中" and the chip titles) have no locale entries. The page was already hardcoded, so this is not a regression. Line 339 toggles `aria-live` in the same render as the text change, which assistive tech usually skips; keep it static.

Seen outside the requested scope, skimmed only:
- `D:/tmp/aw-electron-desktop/scripts/experiments/gemma4-pipeline.mjs:276,547-548` (untracked, not ignored) hardcodes passwords for accounts it registers. It is not a leaked secret, but it leaves known-password accounts in whichever home it targets.
- The reordered `resolveUser` routes, DAQ ingest and the A2A `agent/getCard` gate showed no weakening.

## Checked and correct

- **Explicit `workspaceId`:** validated before creation and again at mount; 404 for unknown, 403 for foreign, no fallback.
- **Concurrency:** there is no `await` between the channel insert and the mount, and the mount is `INSERT OR IGNORE` on the primary key.
- **No workspace yet:** 默认工作区 is created on demand; failed mounts create nothing.
- **Other creation paths:** project, template, MCP and the `[...path].ts` catch-all (a 404 envelope) never pass the flag.
- **Callers:** agent tokens get 401; the owner is always the caller.
- **Security in the diff:** no credentials, host-validation or IPC sender changes, no `v-html`, and the splash CSP is unchanged.
- **Splash:** all 13 element ids exist; `scaleX` tracks `aria-valuenow`; every transition and animation sits under `prefers-reduced-motion: no-preference`; main still destroys the window after 300 ms. All regexes in `D:/tmp/aw-electron-desktop/tests/desktop-tray-splash.test.ts:145-162` still match.
- **Settings tabs:** roving tabindex, targets always rendered, `hidden` not overridden by CSS, orientation matches the 899px breakpoint.
- **Sidebar:** `.menu-item` buttons are the nav's only focusables, and the toggle selector resolves.
- **i18n:** keys used by the new markup exist in both locales.
- **Design docs:** text files contain no secrets, tokens, external URLs or local paths (PNGs not inspected, per instructions).

Not verifiable without `node_modules`: antdv's `@popup-align` event and `:inert="false"` under SSR (no precedent in `app/`). Both deserve a keyboard smoke test.