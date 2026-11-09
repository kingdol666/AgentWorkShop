# RSI: the experience-evolution loop

> RSI (Runtime Self-Improvement) answers one question: **what makes an agent team's experience move from "a feeling inside one task" to "behaviour that is actually injected next time"?**
> The answer is not a longer prompt. It is an auditable loop: capture → gate → share → evolve → verify.

## In one picture

```
task completion / review outcome / governance write
        │
        ▼
   experience row (candidate) + evidence (task / artifact / intervention ledger)
        │  fail-closed gate (one task is never enough)
        ▼
   validated (shareable along the line)
        │                      ┌── paired evaluation (p<0.05, cost non-inferior)
        ├──▶ Harness Profile ──┤
        │    pin / shadow / active / rollback
        ▼
   prompt injection (experience + advisory + isolation notice)
        │
        ▼
   independent readback (match / mismatch / inconclusive) ──▶ L1 gate
```

## Five objects

| Object | Role | Stored in |
|---|---|---|
| **Experience** | A scoped claim with evidence; `candidate → validated` (and rejectable/archivable) | Memory store (channel / line scope) |
| **Evidence** | The task, result or intervention row that produced the claim; no evidence, no promotion | `taskIds` / `resultId` / ledger |
| **Harness Profile** | Versioned overlay injected into prompts (pins + overlay + advisory) | `harness_profiles` |
| **Verification** | Independent readback verdict: `match` / `mismatch` / `inconclusive` | Verification ledger |
| **Meta stats** | Success rate per action kind — does the mechanism itself work? | `improvement-stats` |

## The loop in detail

### 1. Capture

- **Task terminal state** — a completed root task triggers the reflector and writes a `candidate` row carrying `taskIds` evidence.
- **Review outcome** — L1 approval/rejection also produces experience plus a `kb_ingest` candidate.
- **Governance write** — `line_start` / `recipe_trial` leaves an intervention-ledger row at the DCW write choke point, used for both judgement and readback.

### 2. Gate (fail-closed)

The default promotion gate requires **independent evidence** (two tasks in the acceptance口径). With one task the gate refuses and writes the reason back to audit:

```
独立任务样本不足：1/2
```

That refusal is correct behaviour, not a failure. A demo that wants single-task promotion must change the policy explicitly and own the "insufficient evidence" semantics.

### 3. Share

Validated experience is read by scope:

- other channels **on the same line** can read it (`scope=line`);
- another line gets **zero hits** — that is the isolation negative sample and must stay true;
- reads are audited and never write.

### 4. Evolve

Harness Profile is the only path from "experience" into "prompt":

```bash
# versions + the exact injection preview
GET /api/workshop/channels/:id/harness-profiles

# promote (shadow → active requires a paired evaluation result)
POST /api/workshop/channels/:id/harness-profiles/promote
{ "profileId": "…", "to": "active", "bench": { "p": 0.02, "delta": 10, "costDelta": 0.01 } }

# roll back to the previous active
POST /api/workshop/channels/:id/harness-profiles/promote
{ "rollback": true }
```

Rules:

- `shadow` may be observed; **`active` without a paired result is a 409**;
- the paired result must show a significant improvement (p<0.05) with non-inferior cost;
- exactly **one active profile** per channel; rollback uses the same endpoint;
- the preview shows what actually enters the prompt: active overlay + pins + advisory + instruction-isolation notice.

### 5. Verify

The independent readback verifier turns "the platform thinks it wrote" into "does the device agree":

| Verdict | L1 semantics |
|---|---|
| `match` | may pass |
| `mismatch` | **409 blocks review** (False-Done caught) |
| `inconclusive` | treat as unproven, never as pass |

This is where RSI meets line governance: experience may say "this worked last time", but **this time the device readback decides**.

## API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/workshop/channels/:id/memories/experience-stats` | Experience board (lifecycle / scope / polarity + recent rows) |
| `GET` | `/api/workshop/channels/:id/memories?scope=line` | Read experience (cross-channel, line-isolated) |
| `POST` | `/api/workshop/channels/:id/memories/:memoryId/promote` | Promote experience (gate applies here) |
| `GET` | `/api/workshop/channels/:id/harness-profiles` | Profile versions + injection preview |
| `POST` | `/api/workshop/channels/:id/harness-profiles` | Create a pin/shadow version |
| `POST` | `/api/workshop/channels/:id/harness-profiles/promote` | Promote / roll back |
| `GET` | `/api/workshop/channels/:id/verifications` | Independent readback ledger |
| `GET` | `/api/workshop/channels/:id/improvement-stats` | Meta-layer success rate per action kind |

> RSI is currently an **API / agent-tool surface**; there is no dedicated visual page yet. Operators read the endpoints above; writes are owner/admin only.

## Acceptance (2026-11-09, main build)

`scripts/acceptance-rsi-live-e2e.mjs`: **32/32 PASS**, covering:

- two independent tasks capture `candidate` experience with task evidence;
- single-task evidence is refused by the gate (fail-closed);
- project task instance + `write_intent` + HITL double approval → `line_start` / `recipe_trial` dispatched, device value proven;
- C1 readback `mismatch` blocks L1 review with 409, `match` passes;
- review terminal state captures experience + `kb_ingest` candidate;
- evidence merge (2 tasks) promotes to `validated`;
- same-line cross-channel read works, other-line gets zero hits;
- B2 paired evaluation → B3 `shadow → active` gate → B4 rollback;
- C3 meta success rate, C1 ledger, DB audit facts;
- static red line: 0 device-write calls in the learning ring.

Evidence: [`docs/audit/evidence/2026-11-09-rsi-live-e2e/report.md`](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-09-rsi-live-e2e/report.md).

## Boundaries

- **Experience is not fact** — it holds only under the same governance and readback constraints; the device always keeps the final veto.
- **The gate is deliberately expensive** — single-task refusal means "what we just learned" is not available next task; that is the price of evidence.
- **Profiles need real evaluation** — no paired result, no active profile.
- **Scope must be honest** — cross-line sharing would manufacture false causality; the implementation isolates by line.
