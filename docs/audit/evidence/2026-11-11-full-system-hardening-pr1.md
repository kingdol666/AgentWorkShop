# PR-1 Project hardening evidence

Baseline under test: `origin/main@bee38de8` before rebase; latest fetched main at review time: `5527d896c6816e63a69127a57585dc9e13362032`.

## Reproduction/red evidence

- `C-04`: before the fix, a throwing `cancelTaskTreeInternal` was swallowed by `cancelTaskTreeForProject`, allowing terminate to commit Project/WorkItem terminal state while runtime cancellation had failed.
- `C-05`: canceled Project mutable-entry matrix was missing; `continueProject`/create/update/dispatch/leader paths required explicit terminal guards.
- `C-06`: reconcile marked missing task/attempt `BLOCKED` but left live attempt/currentAttemptId, preventing safe retry.
- `C-12`: unbind finalized DB state without invoking runtime task-tree cancellation.

## Green evidence (after fix)

Command:

```text
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/project-p1b-terminate.test.ts
```

Result: **6 tests, 6 pass, 0 fail, 0 skip**.

Covered tests: existing T1/T2 plus C-04/C-05/C-06/C-12. Nuxt config was generated with `pnpm exec nuxt prepare`; dependencies were installed with `pnpm install --frozen-lockfile --ignore-scripts` because the shared native sqlite-vec package was locked by another process during parallel install.

## Boundary

This evidence is valid only after the branch is rebased onto the fetched latest `origin/main`; full unit/typecheck/lint remain required at PR review and post-merge gates.
