# PR-1 Project hardening evidence

Baseline under test: `origin/main@bee38de8` before rebase; latest fetched main at review time: `5527d896c6816e63a69127a57585dc9e13362032`.

## Reproduction/red evidence

- `C-04`: before the fix, a throwing `cancelTaskTreeInternal` was swallowed by `cancelTaskTreeForProject`, allowing terminate to commit Project/WorkItem terminal state while runtime cancellation had failed.
- `C-05`: canceled Project mutable-entry matrix was missing; `continueProject`/create/update/dispatch/leader paths required explicit terminal guards.
- `C-06`: reconcile marked missing task/attempt `BLOCKED` but left live attempt/currentAttemptId, preventing safe retry.
- `C-12`: unbind finalized DB state without invoking runtime task-tree cancellation.
- Orphan task_instance binding (review blocker): terminate's post-transaction phase detached active `task_instance` bindings without a prior runtime cancel — the `manager.closeChannelSession` cascade (cancelTree→abort→disableAgent→stopAndDetach→session.close) can fail mid-way, leaving the runtime task tree alive while the binding was already detached, violating runtime-first + fail-closed.

## Green evidence (after fix)

Command:

```text
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/project-p1b-terminate.test.ts tests/project-cancel-hard-stop.test.ts tests/project-p0-hardening.test.ts tests/project-review-fixes.test.ts
```

Result: **32 tests, 32 pass, 0 fail, 0 skip** (project-p1b-terminate 9, project-cancel-hard-stop 5, project-p0-hardening 9, project-review-fixes 9). `pnpm run typecheck` and `pnpm exec eslint server/services/workshop/projects/service.ts tests/project-p1b-terminate.test.ts` are green.

Covered tests: existing T1/T2/T3 plus C-04/C-05/C-06/C-12 and the two orphan-binding tests added for the reviewer blocker:

- `T-orphan`: seeds an orphan `task_instance` active binding (fresh channel), a non-terminal task on that channel and an active channel session; terminate must cancel the task tree inside the terminate transaction (`cancelTrees` contains the task, task ends `CANCELED`), then durably close the session, disable the channel (`enabled=0`) and detach the binding.
- `T-orphan-fail-closed`: same fixture with a `getTaskEngine` stub whose `cancelTree` throws; terminate must reject (fail-closed 503 path) with the project still `active`, the binding still `active`, the task still non-terminal and the session row unmodified — no terminal state is committed before runtime cancellation succeeds.

Nuxt config was generated with `pnpm exec nuxt prepare`; dependencies were installed with `pnpm install --frozen-lockfile --ignore-scripts` because the shared native sqlite-vec package was locked by another process during parallel install.

## Boundary

This evidence is valid only after the branch is rebased onto the fetched latest `origin/main`; full unit/typecheck/lint remain required at PR review and post-merge gates.
