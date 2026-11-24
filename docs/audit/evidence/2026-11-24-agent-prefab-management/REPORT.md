# AgentPrefab management and runtime acceptance — 2026-11-24

Scope: desktop and Web share one Nuxt/Nitro build. All runs used a disposable
data directory, loopback ports and a freshly built candidate; the active
installation and shared services were not touched.

## Change summary

- Prefab list has explicit View / Edit / Archive or Delete actions (the old
  `row-click` binding never fired because the Ant Design Vue table has no such
  event). New prefabs are named before creation instead of producing unnamed
  `Expert` drafts.
- Unpublished drafts are hard-deleted; published prefabs are archived. Archived
  prefabs reject new bindings and publication while existing member pins and
  frozen Session/Project snapshots keep resolving.
- Every member instance can hold exactly one binding. A second bind returns
  `409 PREFAB_ALREADY_BOUND`; clearing requires
  `expectedBindingVersion` (opaque per-binding UUID) and returns
  `409 PREFAB_BINDING_CHANGED` on a stale value. Binding changes are refused
  while the member is busy, has open work, pending mail/approval, or a frozen
  Session/Project instance; the old runtime is detached in the same tick as the
  commit and reconstructed from the new revision.
- Unbound members keep running with their ordinary configuration. Bound members
  keep the pinned revision/hash through Session clones and Project retries.

## Live acceptance (Web + Windows desktop)

`prefab-acceptance.mjs --target both` on the candidate build:

| Target | API/runtime checks | UI click-through | Cleanup |
| --- | --- | --- | --- |
| Web | 38/38 PASS | PASS (create named draft, listed-row Edit, save, reload) | PASS |
| Desktop | 38/38 PASS | PASS (same steps in the Electron window) | PASS |

Both targets exercised: fresh install → register → skill import/enable → prefab
draft/publish → member bind → catalog narrowing → dispatch denial for an
unselected tool → Session clone pin + snapshot hash → revision 2 without
auto-upgrade → archive/delete lifecycle → concurrent bind with exactly one
winner and one persisted binding → versioned clear → archived prefab rejected
for new binds while the old pin still activates.

Two real AgentRuntime jobs ran per target through the mock harness: an unbound
worker and a worker bound to revision 1. Both completed with a `mock 成果`
artifact; the bound job's persisted `contentHash` matched the published
revision before dispatch.

## Not run / limitations

- The pane's "current binding" line was not verified by automated clicks: the
  Ant Design select dropdown did not respond to the harness's option clicks
  (`uiBinding: NOT_RUN`). The binding card rendered in screenshots and the
  binding path itself is covered by the API and job checks above.
- No isolated local-model server was available, so `localModel` stayed
  `NOT_RUN`; the harness refuses to use the shared LM Studio listener. The
  mock-harness jobs prove runtime wiring, not model quality.
- External MCP discovery remains `NOT_RUN` by design.
