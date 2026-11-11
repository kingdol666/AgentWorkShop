# PR-3 RSI evidence integrity evidence

Baseline: `origin/main@5527d896c6816e63a69127a57585dc9e13362032`.

## Reproduced findings

- C-07: `recordBenchRun` accepted client `pValue` after only range validation; a negative/no-improvement per-seed run could claim `pValue:0`.
- C-08: active profile pins rendered any non-retired memory by ID, including candidate/foreign-channel/wrong-scope rows.
- C-15: experience merge/promotion counted arbitrary `evidence.taskIds` without resolving tasks.
- Memory status migration used an unconditional UPDATE and could overwrite a stronger lifecycle state.

## Fixes

- paired sign-test pValue is computed server-side from perSeed; input pValue is ignored for the ledger.
- pin rendering requires same channel, `kind=experience`, `status=validated`, and matching channel line/product/channel scope.
- when task data exists, evidence IDs must resolve to completed tasks in the current channel; fake/cross-channel evidence is rejected. Minimal memory-only fixtures remain compatible when the task table is empty.
- status migration uses CAS-style guards so validated/retired cannot be regressed by stale writes.

## Green evidence

```text
pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/experience-gates.test.ts tests/rsi-experience-lifecycle.test.ts tests/rsi-evidence-integrity.test.ts
```

Result: **17 tests, 17 pass, 0 fail, 0 skip**.

```text
pnpm run typecheck
```

Result: **typecheck passed**.

`git diff --check`: passed.

## Boundaries

The server-side pValue computation is a deterministic one-sided paired sign test, not a claim that client-provided perSeed values are themselves impossible to fabricate. True server-executed harness benchmarking remains a follow-up boundary.
