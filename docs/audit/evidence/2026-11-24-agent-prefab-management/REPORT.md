# AgentPrefab management and runtime acceptance — 2026-11-24

Scope: desktop and Web share one Nuxt/Nitro build. Every run used a disposable
data directory, loopback ports and a freshly built candidate. The active
installation, the shared LM Studio listener and the other shared services were
not touched.

## Round 2 — re-acceptance on the committed tree

Round 1 (below) passed 76/76, but its evidence did not correspond to the commit
and two areas were left `NOT_RUN`:

- The accepted build came from a staging copy whose source differed from
  `615906c7` in one file (`host-tool-bridge/tools/team.ts`, a type-only change
  made after that build). The repository's own `.output` was also still the
  pre-prefab build.
- `uiBinding: NOT_RUN` was a harness defect, not a selector drift: the script
  looked for the English label `Member` while both clients render Chinese
  (`成员`), so the member was never selected.
- `localModel: NOT_RUN` had never been executed.

Round 2 rebuilds the candidate with `git archive HEAD`, applies the working
tree (10 files, diff SHA-256 `bd5270070b2f…`), verifies 2884/2884 build-relevant
files equal the working tree, and makes the binding flow a required check.

### Product fixes found by clicking the real UI

1. **Static dialogs ignored the app's provider.** `Modal.confirm` renders outside
   the page tree and does not inherit `<a-config-provider>`, so confirm buttons
   showed the CJK auto space (`取 消`, `解 绑`) that the rest of the app had
   removed, and the dialog fell back to the default theme. `app.vue` now feeds
   the same theme, locale and `autoInsertSpaceInButton: false` to
   `ConfigProvider.config`.
2. **Session instance members were offered as bindable.** A member of an
   unclosed session or project task instance keeps the binding it was created
   with, yet the binding card still offered Bind/Unbind for it (a guaranteed
   `409 PREFAB_BINDING_FROZEN`). The member list now reports
   `prefabBindingFrozen`, computed by the same `frozenBindingMembers` rule the
   write guard uses, and the card shows such members as view-only.
3. **Raw ISO timestamps** in the updated column are now formatted with the
   shared `formatLocalStamp`.

### Final run — `round2/result.json`

`prefab-acceptance.mjs --target both` with the isolated local-model leg:

| Target | Checks | Create / edit | Bind / unbind | Local model | Page errors |
| --- | --- | --- | --- | --- | --- |
| Web | 56/56 | PASS | PASS | PASS | none |
| Desktop | 56/56 | PASS | PASS | PASS | none |

Both targets, with real mouse and keyboard input on the visible UI:

- create a named draft, open it from the listed row, edit, save, reload;
- pick the Channel and a member: an API-bound lead shows its pinned revision 1,
  a session instance shows its binding as view-only, an unbound member shows
  the default state;
- bind the unbound member to the published head revision; only Unbind stays
  available and the binding is persisted with its generation;
- run a real AgentRuntime job on that member (mock harness) — it completes
  under the pinned hash; unbind through the dialog and its confirmation; the
  same member completes another job with no binding;
- the unbind dialog asks for confirmation, cancel keeps the binding, the
  request carries `expectedBindingVersion`, and the dialog follows the theme
  (`round2/*-unbind-confirm-dark.png`).

### Real local model

An owned `llama-server` process (PID recorded in an isolated-loopback proof
file, one model, prompt logging enabled) served
`gemma-4-12B-it-QAT-Q4_0.gguf`; OMP ran in a disposable profile. Both members
were real OMP leads in their own channels.

- Unbound member: real turns, and none of its requests contain prefab text.
- Bound member: the request the model received contains the block
  `## Agent Prefab（用户自定义业务指导，低信任…）` with the prefab's Role and
  Scenario text (`expert_role_prompt_reached_model_request`).
- Task completion is recorded, not asserted: this 12B model plans differently
  each run. In the six runs that used this stage 14 of 18 jobs reached
  `COMPLETED`; in the final run 3 of 4 did. Of the four unfinished jobs, the
  three whose sessions were kept either called `send_message_to_agent` and then
  waited in `poll_messages` for a reply, or looped on `search_memory` and the
  task list.

## Round 1 — management, single binding, runtime enforcement

- Explicit View / Edit / Archive or Delete actions; the old `row-click` never
  fired because the Ant Design Vue table has no such event.
- Unpublished drafts are hard-deleted, published prefabs are archived; archived
  prefabs reject new bindings while existing pins keep resolving.
- One binding per member instance: a second bind returns
  `409 PREFAB_ALREADY_BOUND`, clearing needs `expectedBindingVersion`
  (`409 PREFAB_BINDING_CHANGED` on a stale value), changes are refused while
  the member is busy, has open work, pending mail or a frozen instance, and the
  old runtime is detached in the same tick as the commit.
- Unbound members keep their ordinary configuration; bound members keep the
  pinned revision through session clones and project retries.

## Desktop UI stability

The desktop target drives a real Electron window. 4 of this round's 15 desktop
runs failed inside the UI stages. The two failures that captured window state
show the same signature: `visibility: hidden` and no animation frames. A page
reports this only when its window is covered, minimised or hidden, and a tab
transition or dropdown animation never finishes in that state. One of the two
also logged `401` responses and a hydration mismatch; their origin was not
established.

- Waits now poll on a timer; frame-driven polling stalls in a hidden window.
- Electron is started with `--disable-features=CalculateNativeWinOcclusion`,
  `--disable-backgrounding-occluded-windows` and
  `--disable-renderer-backgrounding`. A separate experiment with the same
  frameless window plus `WebContentsView` structure showed the page stays
  `visible` and keeps producing frames while a top-most window covers it;
  without the switches it turned `hidden` in 22 of 24 samples.
- Remaining limitation: a minimised or tray-hidden test window still stops
  rendering, and the two earlier failures could not be attributed to one
  specific cause. Electron does not implement
  `Browser.getWindowForTarget`, so the harness cannot move the window itself.
  Keep the window open for the ~15 seconds of UI stages. Each result records
  `visibilityAtStart`, `electronSwitches` and `pageErrors`; failures also
  record whether animation frames were still firing.

## Gates (final working tree)

typecheck, lint, i18n 3496/3496 (0 unresolved), docs 101/0, unit 2327 tests —
2326 pass, 0 fail, 1 skipped. Candidate build exit 0.

## Not run / limitations

- External MCP discovery stays `NOT_RUN` by design.
- Real-model inference was one 12B model on one machine; it shows prompt
  delivery and real tool calls under a binding, not model quality. A prefab
  `profile` was applied (`provider`, `model`, `effort: off` accepted by the OMP
  adapter) but model precedence over member or channel defaults was not
  isolated with a real model.
- No installed-version upgrade, publish or release was attempted.

## Evidence index

- `round2/result.json` — final run, both targets, all check details.
- `round2/candidate.json` — commit the candidate was exported from.
- `round2/web-visible-bound.png`, `round2/desktop-visible-bound.png` — bound
  member state.
- `round2/*-visible-unbind-confirm.png`, `round2/*-visible-unbind-confirm-dark.png`
  — confirmation dialog in both themes.
- `round2/local-model/*.json` — what the real model said in each job.
