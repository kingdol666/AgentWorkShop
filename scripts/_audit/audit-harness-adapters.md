# Harness-adapter audit — `server/services/workshop/agents/`

Read-only audit. All 20 requested files read completely (plus `registry.ts`, `base-agent.ts`,
`prompt-builder.ts`, `mock-agent.ts`, `harness-models.ts`, `harness-terminal.ts`, `plugin-tools.ts`,
`factory.ts` and the call sites `runtime/agent-runtime.ts`, `runtime/scheduler-loop.ts`,
`runtime/manager.ts`, `plugins/workshop.ts`, `plugins/dev-stability-guard.ts`).
Scratch artifacts only: `scripts/_audit/ndjson-partial-line-repro.mjs`,
`scripts/_audit/opencode-await-ternary-repro.mjs`.

Compiler evidence: `npx tsc --noEmit --skipLibCheck --target esnext --module esnext
--moduleResolution bundler <all adapters>` (alias-resolution errors filtered out; module-internal
errors reproduced below are independent of path aliases).

---

## 1. Child-process lifecycle

### 1.1 Every spawn site (complete)

| # | site | API |
|---|---|---|
| S1 | `adapters/line-spawn.ts:114` `return launchChildProcess(file, args, {` | `child_process.spawn`, `shell: false` |
| S2 | `adapters/line-spawn.ts:105` `return launchChildProcess('cmd.exe', ['/d', '/s', '/c', ...line], {` | Windows `.cmd/.bat` shim |
| S3 | `adapters/omp-rpc-client.ts:246` `this.child = spawn(command, args, {` | **bypasses line-spawn** |
| S4 | `harness-process.ts:130` `const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })` | tree-killer |

`spawnLineProcess` callers: `adapters/stdio-jsonrpc.ts:86`, `adapters/one-shot-cli-agent.ts:366`,
`opencode-agent.ts:734`, `harness-models.ts:53`.

S3 is a real gap: it does **not** go through `assertPlainExecutable` / `resolveOnPath` / the `cmd.exe`
shim, and it hard-codes `env: { ...process.env, ...this.options.env }` (omp-rpc-client.ts:249) so the
`cleanEnv` whitelist semantics of `line-spawn.ts:88-90` are unavailable to omp.

### 1.2 The only tree-killer

`harness-process.ts:125-157`:

```ts
125: export function killHarnessProcess(pid: number): boolean {
...
129:     if (process.platform === 'win32') {
130:       const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
...
139:         process.kill(-pid, 'SIGKILL')
...
144:           process.kill(pid, 'SIGKILL')
```

Direct single-process kills that do **not** reap grandchildren:
`adapters/stdio-jsonrpc.ts:192` `this.child?.kill('SIGKILL')`;
`adapters/stdio-jsonrpc.ts:205` `this.child?.kill('SIGKILL')`;
`adapters/omp-rpc-client.ts:237` `this.child?.kill('SIGKILL')`;
`adapters/omp-rpc-client.ts:382` `this.child?.kill('SIGKILL')`;
`adapters/one-shot-cli-agent.ts:263` `child.kill('SIGKILL')`;
`harness-models.ts:61` `child.kill('SIGKILL')`.

### 1.3 (a) Session end / `dispose()`

Only caller: `runtime/agent-runtime.ts:363-369`

```ts
363:     // 清理 impl 持有的资源(omp 子进程等);容错:impl.dispose 可能不存在
364:     try {
365:       await this.impl.dispose?.()
```

reached from `manager.shutdown()` (`runtime/manager.ts:992` `await Promise.all([...this.agentIndex.values()].map(a => a.stop()))`)
and from the Nitro hook `plugins/workshop.ts:168-174` `nitroApp.hooks.hook('close', async () => { ... await manager.shutdown() ... })`.

| adapter | dispose location | child killed? |
|---|---|---|
| omp | `omp-agent.ts:437-449` `await this.client.dispose()` | **single-process only** — `omp-rpc-client.ts:369-389` `this.child?.stdin?.end()` then `this.child?.kill('SIGKILL')` (382). omp's own grandchildren survive. |
| codex | `codex-agent.ts:112-125` `await client.dispose().catch(() => {})` | same weak path via `stdio-jsonrpc.ts:195-218` |
| dsh | `dsh-agent.ts:116-129` | same |
| qwen | `qwen-agent.ts:140-153` | same |
| hermes | `hermes-agent.ts:95-108` | same |
| opencode | `opencode-agent.ts:181-195` `killHarnessProcess(pid)` (185) | **tree** ✓ (+ `this.sseAbort?.abort()` 182) |
| one-shot (gemini/copilot/cursor/crush/goose/pi) | `one-shot-cli-agent.ts:148-151` → `killChild()` (253-265) → `killHarnessProcess(pid)` (259) | **tree** ✓ |
| claude | `claude-agent.ts:113-128` `this.abortCtrl?.abort()` (120), `await this.session?.interrupt?.()` (122) | **no process kill at all**; `getProcessInfo(): null` (`claude-agent.ts:130-132` `return null // SDK 自管二进制生命周期,无宿主侧进程句柄`) |
| mock | no `dispose` method (`mock-agent.ts:38` `export class MockAgentImpl implements AgentInterface {`) | n/a (in-process) |

Asymmetry worth fixing: `killProcess()` uses the tree killer while `dispose()` on the same class does
not — e.g. `codex-agent.ts:134-138`

```ts
134:   killProcess(): void {
135:     const pid = this.client?.pid
136:     if (pid) killHarnessProcess(pid)
137:     else this.client?.kill()
```

vs `codex-agent.ts:118` `await client.dispose().catch(() => {})` → `stdio-jsonrpc.ts:205`.

### 1.4 (b) Error

- `one-shot-cli-agent.ts:442-444` — `child.on('error', ...)` calls `finishTurn(...)` only and **does not
  clear `this.child`** (contrast the `exit` handler `one-shot-cli-agent.ts:445-447` `this.child = null`).
  A later `killChild()` (`one-shot-cli-agent.ts:253-265`) then targets a stale pid.
- `harness-models.ts:59` `child.on('error', err => reject(err))` — the promise rejects but
  the timeout timer created at `harness-models.ts:60` is **never cleared** and `child.kill()` is never
  called on this path.
- `stdio-jsonrpc.ts:106-109`, `omp-rpc-client.ts:280-283` — handled (reject / notifyError).

### 1.5 (c) Timeout

| adapter | per-turn timeout | on timeout | child killed? | error to UI |
|---|---|---|---|---|
| omp | `omp-agent.ts:838` `const idleTimeoutMs = this.config.promptTimeoutMs ?? 600_000` | `omp-agent.ts:915-928` | **yes** — `client.send({ type: 'abort' })` + `this.killProcess()` + `this.client = null` | `TURN_STALLED` error event (921-927) |
| one-shot | `one-shot-cli-agent.ts:206,238` `?? 600_000` | `one-shot-cli-agent.ts:495-502` | **yes** — `this.killChild()` (496) | `TURN_STALLED` (497-501) |
| codex | `codex-agent.ts:238,278` `?? 600_000` | `codex-agent.ts:463-469` | **no** — only `turn/interrupt` (464) | `CODEX_TURN_STALLED` (466-467) |
| claude | `claude-agent.ts:221,262` | `claude-agent.ts:391-397` | no — `this.session?.interrupt?.()` (392) | `CLAUDE_TURN_STALLED` (394) |
| dsh | `dsh-agent.ts:237,277` | `dsh-agent.ts:417-423` | no — `session/cancel` notify (418) | `DSH_TURN_STALLED` (420) |
| hermes | `hermes-agent.ts:209,249` | `hermes-agent.ts:379-385` | no | `HERMES_TURN_STALLED` (382) |
| qwen | `qwen-agent.ts:259,299` | `qwen-agent.ts:407-413` | no | `QWEN_TURN_STALLED` (410) |
| opencode | `opencode-agent.ts:349,391` | `opencode-agent.ts:505-516` | no — `POST /abort` (507) | `OPENCODE_TURN_STALLED` (510) |
| mock | none | — | — | — |

Non-killing timeout paths leave the pending promise resolved (they `enqueue`), so nothing hangs — but
the child process keeps running and keeps its model turn burning tokens.

Per-request (not per-turn) timeouts: `stdio-jsonrpc.ts:133-134`
`reject(new Error(\`${this.options.name} 请求超时: ${method} (id=${id},${timeoutMs ?? this.options.requestTimeoutMs ?? 60_000}ms)\`))`
(adapters pass `requestTimeoutMs: 60_000` — codex-agent.ts:613, dsh-agent.ts:500, qwen-agent.ts:486,
hermes-agent.ts:457 — except `harness-models.ts:110` `requestTimeoutMs: 30_000`);
`omp-rpc-client.ts:309-312` `reject(new Error(\`omp RPC 命令超时: ${command.type} (id=${id})\`))`, 60 s.

### 1.6 (d) Parent process exit — **not guaranteed**

There is **no** `process.on('exit' | 'SIGINT' | 'SIGTERM' | 'beforeExit')` anywhere under `server/`
(only `unhandledRejection`: `plugins/workshop.ts:88`, `plugins/dev-stability-guard.ts:56`;
`uncaughtException`: `plugins/dev-stability-guard.ts:59`). Cleanup depends entirely on the Nitro
`close` hook (`plugins/workshop.ts:168`). Two concrete consequence paths:

1. `plugins/dev-stability-guard.ts:53-54`
   ```ts
   53:     console.error(`[stability-guard] fatal ${kind}, exiting:\n${describe(reason)}`)
   54:     process.exit(1)
   ```
   `process.exit(1)` skips the `close` hook entirely → **every live harness child is orphaned**.
   The exemption regex only knows four engines — `plugins/dev-stability-guard.ts:16`
   `const ENGINE_BOUNDARY = /\b(opencode|omp|codex|dsh) API\b/i` — so failures from
   claude/gemini/copilot/cursor/crush/goose/qwen/pi/hermes are not exempted.
2. The pid registry is process-local: `harness-process.ts:36`
   `const registry = new Map<number, HarnessProcessEntry>()`. After a restart, orphaned children are
   unreachable — `listAliveHarnessProcessesByAgent` (`harness-process.ts:87-89`) can only see pids
   registered in the current process; there is no OS process-table scan.

### 1.7 Windows-specific handling

- `windowsHide: true` — `line-spawn.ts:109`, `line-spawn.ts:118`, `omp-rpc-client.ts:250`,
  `harness-process.ts:130`.
- `.cmd/.bat` shim: `line-spawn.ts:63-66` `if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return { file, needsCmd: true }`
  → `line-spawn.ts:99-112` fixed `'cmd.exe'`, `/d /s /c`, per-arg `assertCmdSafeArg` (`line-spawn.ts:78-83`
  `/["\r\n\0]/.test(arg)`), `windowsVerbatimArguments: true` (111).
- Tree kill is Windows-`taskkill`-only (`harness-process.ts:130`); `process.kill(-pid, 'SIGKILL')`
  (`harness-process.ts:139`) is guarded by `if (process.platform === 'win32')` at line 129, so on Windows
  the POSIX branch never runs.
- `process.kill(pid, 0)` liveness probe: `harness-process.ts:107-116` (EPERM treated as alive, 114).
- `resolveOnPath` PATHEXT resolution: `line-spawn.ts:29-55`, incl. `.cmd` last-resort bare name (51-53).
- `one-shot-cli-agent.ts:104-106 sanitizePromptArg` exists specifically because `arg` delivery goes
  through the cmd wrapper on Windows.

### 1.8 stdio pipes drained?

| consumer | stdout | stderr |
|---|---|---|
| `stdio-jsonrpc.ts:97-105` | drained | drained (8 KB tail) |
| `omp-rpc-client.ts:253-279` | drained (8 MB line cap) | drained (1 MB cap, `STDERR_CAP` 130) |
| `one-shot-cli-agent.ts:404-432` | drained | drained (8 KB tail) |
| `opencode-agent.ts:745-748` | **NOT drained — no `child.stdout` reference in the file** | drained |
| `harness-models.ts:55-58` | drained | **NOT drained — no `child.stderr` reference in the file** |

`opencode serve` is long-lived (`opencode-agent.ts:734`), so an unread stdout that exceeds the OS pipe
buffer will block the engine mid-turn. `harness-models.collect()` is bounded by its 45–60 s timeout
(`harness-models.ts:79,144`), so it degrades to a timeout rather than a permanent hang, but returns a
truncated catalog.

## 2. Unhandled promise rejection risk

**Overall: floating promises are overwhelmingly `.catch()`-guarded — I found no unguarded floating
promise that could reject.** The real rejection risk is *synchronous throws inside `async` methods*
(§4.3/§4.4), which the call sites do catch.

### 2.1 Floating calls (all verified guarded)

`void`-guarded: `omp-rpc-client.ts:466`; `omp-agent.ts:169,348,455,596,1065,1171,1172`;
`claude-agent.ts:136,379,392,521`; `codex-agent.ts:430,464,528,556`; `dsh-agent.ts:389,573`;
`qwen-agent.ts:387,535`; `hermes-agent.ts:352,523`; `opencode-agent.ts:475,507,705,892`.

Floating but `.catch()`-ed (no `void`): `omp-agent.ts:873` `client.send({ type: 'abort' }).catch(() => {})`,
`omp-agent.ts:916` same shape.

### 2.2 `async` setTimeout/setInterval callbacks without try/catch

There is **no `setInterval`** in any of the audited files. Every timer body is synchronous; the two
async timers-adjacent loops have internal try/catch:
`opencode-agent.ts:855-891` (`const connect = async (): Promise<void> => { while (...) { try { ... } catch (err) {...} } }`)
and `claude-agent.ts:521-533` `void (async () => { try { for await (const msg of session) ... } catch ... finally ... })()`.

### 2.3 `timer.unref()`

Exactly three uses in the whole agents tree:
`tool-approvals.ts:83` `timer.unref?.()`, `harness-terminal.ts:301` `session.parkTimer.unref?.()`,
`opencode-agent.ts:92` `srv.unref()`.
**No per-turn / stall / poll / abort-fallback timer is unref'd.** (`AbortSignal.timeout` at
`opencode-agent.ts:766,912` is fine — verified at runtime that Node unrefs it: no `Timeout` appears in
`process.getActiveResourcesInfo()` after `AbortSignal.timeout(60000)`.)

### 2.4 Leaked timers (never cleared, never unref'd)

| file:line | timer | note |
|---|---|---|
| `omp-rpc-client.ts:294` | `setTimeout(() => { if (!this.ready) reject(new Error('omp RPC ready 超时(10s)')) }, 10_000)` | no handle stored → refs the loop 10 s after every successful `start()` |
| `omp-agent.ts:620` | `const timer = setTimeout(abortTurn, timeoutMs)` | **not** cleared on the early-return path `omp-agent.ts:625-629` `if (opts.signal.aborted) { unsub(); resolve([]); return }` → later fires `omp-agent.ts:596` `void this.client?.send({ type: 'abort' }).catch(() => {})` against the shared omp subprocess, cancelling an unrelated live turn |
| `one-shot-cli-agent.ts:506-509` | `setTimeout(() => { resolveWait = null; r() }, Math.min(remaining + 100, 5000))` | no variable |
| `codex-agent.ts:473-476` | `setTimeout(() => { resolveWait = null; r() }, remaining + 100)` | no variable |
| `claude-agent.ts:401-404` | same shape | no variable |
| `dsh-agent.ts:427-430` | same shape | no variable |
| `qwen-agent.ts:417-420` | same shape | no variable |
| `hermes-agent.ts:389-392` | same shape | no variable |
| `codex-agent.ts:431-433` | `setTimeout(() => { if (!isDone) enqueue({ kind: 'done', ... }) }, 5000)` | abort fallback |
| `claude-agent.ts:380-382`, `dsh-agent.ts:381-383`, `qwen-agent.ts:380-382`, `hermes-agent.ts:345-347` | same 5 s abort fallback | |
| `opencode-agent.ts:477` | `setTimeout(() => finishTurn(), 5000)` | abort fallback |
| `harness-models.ts:60-63` | `const timer = setTimeout(...)` | cleared only on `exit` (65); the `error` path (59) leaks it |
| `omp-agent.ts:533`, `harness-terminal.ts:545` | `setTimeout(resolve, 150)` per poll iteration | bounded by 20 s / 8 s deadlines |

Correctly-cleared counterparts (for contrast): `opencode-agent.ts:520-528,536` and
`omp-agent.ts:932-940,948`.

### 2.5 Leaked listeners

1. **`adapters/omp-rpc-client.ts:269`** `this.eventListeners.add(onReady as (event: AgentSessionEvent) => void)`
   — added inside `start()` on every (re)spawn, never removed; only `dispose()` clears
   (`omp-rpc-client.ts:397` `this.eventListeners.clear()`). `handleExit` does not. The `onReady`
   closure also captures the **previous** `resolve`/`reject` of an already-settled promise.
2. **`adapters/stdio-jsonrpc.ts:208`** `this.child.once('exit', () => { clearTimeout(timer); resolve() })`
   — on the 3 s timeout path (`stdio-jsonrpc.ts:204-207`) the promise resolves via the timer branch but
   this listener is left attached.
3. `adapters/stdio-jsonrpc.ts:102-105`, `:106-109`, `:110-117` — child listeners never removed
   (`removeListener`/`off(` never appears in the file); bounded by child lifetime.
4. `harness-terminal.ts:387-393 detachTerminalTap` — clears `unsubRaw` but not `session.batchTimer`,
   so the pending 50 ms flush (`harness-terminal.ts:175-181`) survives detach.
5. `adapters/one-shot-cli-agent.ts:406,430` and `opencode-agent.ts:746` — `data` listeners never
   removed; bounded per-turn (one-shot) / per-server (opencode).
6. No `request.destroy()`, no stream `destroy()`, and no `stdin.destroy()` anywhere; the only
   teardown is `stdin.end()` (`stdio-jsonrpc.ts:199`, `omp-rpc-client.ts:371`, `one-shot-cli-agent.ts:484,488`).

### 2.6 "Dangerous by construction" — `.then()` on an `AsyncGenerator`

`opencode-agent.ts:396-402`

```ts
396:   private runTurn(
397:     prompt: string,
398:     taskId: string | undefined,
399:     opts: { timeoutMs: number, signal?: AbortSignal, beforeStart?: () => void, onDone?: () => void },
400:   ): AsyncGenerator<AgentEvent, void, unknown> {
401:     return this._runTurn(prompt, taskId, opts)
402:   }
```

used at `opencode-agent.ts:301-323` `return await this.runTurn(prompt, undefined, {...}).then((events) => {...})`.
Compiler: `opencode-agent.ts(310,8): error TS2339: Property 'then' does not exist on type 'AsyncGenerator<AgentEvent, void, unknown>'`.
At runtime this is `TypeError: ... .then is not a function` inside `async supervise`, contradicting the
in-file intent at `opencode-agent.ts:281-282` ("绝不让引擎故障以 unhandledRejection 形态逃逸"). It is
caught downstream by `runtime/scheduler-loop.ts:309-312`, so opencode's LLM lead-scheduling silently
degrades to the rule engine on every tick.

## 3. NDJSON / JSON-RPC streaming correctness

| site | cross-chunk buffer | `\r\n` | split JSON line | non-JSON banner |
|---|---|---|---|---|
| `adapters/stdio-jsonrpc.ts:234-252` | ✔ | ✔ via `line.trim()` (240) | ✔ | ✔ `catch { continue }` (246-248) |
| `adapters/omp-rpc-client.ts:404-424` | ✔ | ✔ via `line.trim()` (414) | ✔ | ✔ (420-422) |
| `opencode-agent.ts:866-883` (SSE) | ✔ | ✗ only `\n\n` (870) | ✔ (871) | ✔ (877-880) |
| `adapters/one-shot-cli-agent.ts:406-428` | ✗ **BUG** | ✔ `/\r?\n/` (411) | ✗ **lost** | ✗ dropped (418) |

Correct pattern (verbatim, `stdio-jsonrpc.ts:234-238`):

```ts
234:   private onStdout(data: string): void {
235:     this.stdoutBuf += data
236:     if (this.stdoutBuf.length > 8 * 1024 * 1024) this.stdoutBuf = ''
237:     const lines = this.stdoutBuf.split('\n')
238:     this.stdoutBuf = lines.pop() ?? ''
```

Caveat on 236: the cap check runs *before* the split, discarding the accumulated partial line — a
single frame > 8 MB desynchronises the stream (the remainder is then parsed as a fresh line).

### 3.1 BUG — `one-shot-cli-agent.ts:406-428` parses each chunk with no line buffering

```ts
406:    child.stdout?.on('data', (chunk: string) => {
...
411:      for (const rawLine of chunk.split(/\r?\n/)) {
412:        const line = rawLine.trim()
413:        if (!line) continue
414:        const json = tryParse(line)
415:        if (json === null) {
416:          // 无结构化输出面的引擎:stdout 纯文本行即回复增量;其余(横幅/告警)忽略
417:          if (this.spec.plainTextStdout === true) sink.delta(line)
418:          continue
419:        }
```

Concrete breaking input (executed — `scripts/_audit/ndjson-partial-line-repro.mjs`), one logical
NDJSON stream delivered as two `data` events because the payload exceeds the pipe read size (64 KiB):

```
chunk#1  {"type":"message","role":"assistant","content":"hello wor
chunk#2  ld"}\n{"type":"result","usage":{"input_tokens":42}}\n
```

Observed:

```
A one-shot-cli-agent.ts loop : frames=1 ["result"]  drops=2 ["{\"type\":\"message\",...,\"hello wor","ld\"}"]  assistantText=""
B stdio-jsonrpc.ts loop      : frames=2 ["message","result"]
```

The whole assistant message is silently lost (never becomes a `delta`), and one frame disappears.
Affects every `OneShotCliAgentImpl` subclass without `plainTextStdout`: gemini, copilot, cursor,
goose, pi. `crush` sets `plainTextStdout: true` (`crush-agent.ts:67`) so it survives but with each
fragment `.trim()`-ed (411-412), altering leading/trailing whitespace of the answer.

Additional unbounded buffer: `one-shot-cli-agent.ts:405-409`

```ts
405:     let stdoutAll = ''
406:     child.stdout?.on('data', (chunk: string) => {
407:       if (this.spec.wholeJsonAtExit === true) {
408:         stdoutAll += chunk
```

`stdoutAll` has no cap. Latent only — no shipped spec sets `wholeJsonAtExit`
(only `crush-agent.ts:67` sets `plainTextStdout`).

### 3.2 SSE caveat — `opencode-agent.ts:866-883`

```ts
869:             buf += decoder.decode(value, { stream: true })
870:             const chunks = buf.split('\n\n')
871:             buf = chunks.pop() ?? ''
```

Correct for `\n\n`-delimited SSE. Two gaps: (a) a CRLF-delimited stream (`\r\n\r\n`) never splits and
`buf` grows without bound; (b) multi-line `data:` payloads are parsed line-by-line (873-879), so a
payload split over two `data:` lines is rejected as non-JSON and dropped (880).

### 3.3 Non-stream splits (safe)

`harness-models.ts:82` `for (const rawLine of out.split('\n'))`, `:146`, `:184` — `out` is the fully
collected stdout string, not a chunk. No `readline` usage anywhere in the tree.

## 4. Timeout / retry / error propagation

### 4.1 Per-turn timeout (quoted) — see table in §1.5

Every process-based adapter has one except `mock`. All default to `600_000` ms; supervise defaults to
`150_000` (`base-agent.ts:170`, `omp-agent.ts:576`, `opencode-agent.ts:300`, `qwen-agent.ts:219`).

### 4.2 Correct propagation to `{ kind: 'error' }`

Timeout → error event, verified for all nine: `omp-agent.ts:921-927`, `one-shot-cli-agent.ts:497-501`,
`codex-agent.ts:465-468`, `claude-agent.ts:393-396`, `dsh-agent.ts:419-422`, `hermes-agent.ts:381-384`,
`qwen-agent.ts:409-412`, `opencode-agent.ts:508-514`. Non-zero child exit → error event:
`one-shot-cli-agent.ts:469-479`

```ts
469:      if (code === 0) {
470:        finishTurn({ kind: 'done' })
471:      }
472:      else {
473:        const custom = this.spec.exitErrorMessage?.(code ?? -1, stderrTail)
474:        finishTurn({
475:          kind: 'error',
476:          code: `${this.spec.harnessId.toUpperCase()}_EXIT_${code ?? -1}`,
```

Spawn failure → error event: `one-shot-cli-agent.ts:368-377`, `omp-agent.ts:652-660`.

### 4.3 Swallowed errors (verbatim)

- `base-agent.ts:160-162`
  ```ts
  160:     catch {
  161:       return []
  162:     }
  ```
  `supervise()` failure produces **no AgentEvent at all** — every adapter that relies on the base
  implementation (all except omp/opencode/qwen) loses the reason.
- `qwen-agent.ts:229-231` — the same `catch { return [] }`, duplicated.
- `opencode-agent.ts:320-323` `}).catch(() => { this.supervising = false; return [] })` and
  `opencode-agent.ts:286-289` `catch (err) { log.warn(...); return [] }`.
- `codex-agent.ts:208-210` compact failure → `log.warn(... 放行)`; `opencode-agent.ts:270-272` same.
- `codex-agent.ts:725-727` `catch (err) { log.warn(\`[CodexAgent:${this.selfAgentId}] CODEX_HOME config 写入失败(信任全局配置):\`, ...) }`
  — if the MCP section is not written, the agent runs **without tools** and the turn still reports `done`.
- `opencode-agent.ts:794-796` `catch (err) { log.warn(\`[OpenCodeAgent:${this.selfAgentId}] MCP 桥注册失败(host tools 不可用):\`, ...) }` — same class of silent capability loss.
- `claude-agent.ts:527-529` `catch (err) { log.warn(\`[ClaudeSdk:${this.selfAgentId}] 消息流异常: ...\`) }` — the SDK stream dies but `streamTurn` keeps waiting until the 600 s stall timer; the UI sees nothing until then.
- `omp-rpc-client.ts:420-422` `// 非 JSON 行(理论上不应出现):忽略` and `:549-551` `// chunk 重组失败:忽略`.
- `stdio-jsonrpc.ts:246-248` `catch { continue // 非 JSON 行(横幅/日志混流)忽略 }` — combined with a lost frame this is invisible.
- `harness-models.ts:142` `catch { /* 无凭据则按未登录目录输出 */ }`, `:243` `catch { /* 无 settings.yaml/解析失败 → 仅内置目录 */ }`.

### 4.4 `async` methods that throw before doing any work

| method | throw | compiler evidence |
|---|---|---|
| `QwenAgentImpl.supervise` | `qwen-agent.ts:209` `const prompt = supervisePrompt({` — **`supervisePrompt` is not imported** (`qwen-agent.ts:30` imports only `peerPrompt, systemManual, toolArgsPreview, workerPrompt`) → `ReferenceError`; next failure would be `qwen-agent.ts:219` `const events = await this.collectTurn(...)` (the method is `collectTurnEvents`, `qwen-agent.ts:435`) and `qwen-agent.ts:226` `extractJsonArray(text)` (also not imported) | `qwen-agent.ts(209,20): TS2304: Cannot find name 'supervisePrompt'`; `(219,33): TS2339: Property 'collectTurn' does not exist`; `(226,22): TS2304: Cannot find name 'extractJsonArray'`; `(208,14)/(217,10)/(233,12): TS2341: Property 'supervising' is private and only accessible within class 'BaseAgentImpl'` |
| `OpenCodeAgentImpl.supervise` | `opencode-agent.ts:301` `.then(...)` on an AsyncGenerator | `opencode-agent.ts(310,8): TS2339` |
| `OpenCodeAgentImpl.respondHitl` | `opencode-agent.ts:252` `if (pending.timer) clearTimeout(p.timer)` — `p` is undefined in this scope (the loop variable `p` lives at 652 and 191) → `ReferenceError` **after** the engine was already answered (241/246/249) but **before** `this.pendingHitl.delete(id)` (253) and `getHitlRegistry().resolve(...)` (254) → the local map entry and the global HITL item leak forever, and the REST caller gets a 500 (`server/api/workshop/hitl/respond.post.ts:80` `await manager.respondHarnessHitl(...)` → `runtime/manager.ts:2821` `const ok = await runtime.respondHitl(kind, id, outcome)`) | `opencode-agent.ts(252,37): TS2304: Cannot find name 'p'` |
| `OpenCodeAgentImpl.startServer` | `opencode-agent.ts:805-808` — `await` binds tighter than `?:`, so `created` is a **Promise**, not the session object, and `String(created?.id ?? '')` is always `''`; entry into the 3× retry loop at 811-815 is therefore guaranteed (≥2.5 s `await sleep(2500)`) and the first, real, session is created and abandoned | `opencode-agent.ts(808,38): TS2339: Property 'id' does not exist on type 'Promise<Record<string, unknown>>'`; reproduced in `scripts/_audit/opencode-await-ternary-repro.mjs` (`created instanceof Promise = true`, `this.sessionId = ""`) |

```ts
805:     const created = await (this.config.permission ?? DEFAULT_PERMISSION)
806:       ? createWith({ permission: this.config.permission ?? DEFAULT_PERMISSION }).catch(() => createWith(undefined))
807:       : createWith(undefined)
808:     this.sessionId = String(created?.id ?? '')
```

Also note the ternary condition `this.config.permission ?? DEFAULT_PERMISSION` can never be falsy
(`DEFAULT_PERMISSION` is a 4-line array literal, `opencode-agent.ts:82-86`), so the `: createWith(undefined)`
branch at 807 is dead code and `permission` is always sent on the first attempt.

## 5. DUPLICATION INVENTORY

Line ranges are exact. "Copies" counts textual copies of the same block; near-copies with token
renames are flagged.

### 5.1 MCP-bridge env setup (`AW_BASE_URL` / `AW_AGENT_ID` / `AW_AGENT_TOKEN`)

| # | function / block | file:lines | copies |
|---|---|---|---|
| D1 | `generateMcpBridgeEnv({ agentId, token, baseUrl, bridgePath })` call site | `codex-agent.ts:606-612`, `codex-agent.ts:690`, `claude-agent.ts:452-457`, `dsh-agent.ts:477-484`, `qwen-agent.ts:461-466`, `hermes-agent.ts:438-443`, `adapters/one-shot-cli-agent.ts:296-301`, `gemini-agent.ts:119` | **8 sites / 7 files** |
| D2 | Redundant repeat calls of the *same* expression inside one function | `dsh-agent.ts:485`, `dsh-agent.ts:486` (three identical `generateMcpBridgeEnv(...)` evaluations in one call) | 3 extra evaluations |
| D3 | Hand-rolled `AW_*` literal object duplicating `harness-env.ts:41-53` | `opencode-agent.ts:786-790` vs `harness-env.ts:44-47` | **2 copies** |
| D4 | `\`      ${k} = "${v}"\`` TOML env expansion | `codex-agent.ts:691` | 1 (no dup) |
| D5 | bridge launch pair `process.execPath` + bridge path | `codex-agent.ts:695-696`, `claude-agent.ts:506-508`, `qwen-agent.ts:75`, `gemini-agent.ts:49-51`, `copilot-agent.ts:61`, `cursor-agent.ts:46`, `opencode-agent.ts:784`, `crush-agent.ts:39-43`, `goose-agent.ts:40-41` | **9 copies** |

Canonical source being duplicated: `harness-env.ts:43-48`

```ts
43:   const bridgeEnv = {
44:     AW_BASE_URL: resolvePlatformBaseUrl(input.baseUrl),
45:     AW_AGENT_ID: input.agentId,
46:     AW_AGENT_TOKEN: input.token ?? '',
47:     AW_MCP_TOOL_TIMEOUT_MS: String(200_000),
48:   }
```

### 5.2 `resolveCli` / binary path resolution

| # | function | file:lines | copies |
|---|---|---|---|
| D6 | `resolveCommand` one-liner `config => (typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : harnessSettings().X_command)` | `gemini-agent.ts:60`, `copilot-agent.ts:85`, `cursor-agent.ts:54`, `crush-agent.ts:59`, `goose-agent.ts:33`, `pi-agent.ts:52` | **6 byte-identical copies** (only the settings key differs) |
| D7 | same rule re-implemented for the registry probe | `registry.ts:106-107` `const cmdFrom = (config) => typeof config?.command === 'string' && config.command.trim() !== '' ? config.command.trim() : ''` | +1 |
| D8 | `getProcessInfo` fallback command strings `'opencode serve' / 'dsh --profile acp' / 'qwen --experimental-acp' / 'hermes acp' / 'codex app-server'` re-stating the spawn argv | `opencode-agent.ts:166`, `dsh-agent.ts:135`, `qwen-agent.ts:158`, `hermes-agent.ts:113`, `codex-agent.ts:131` | 5 |
| D9 | PATH probing: `probeExecutable` re-implements the explicit-path test and the POSIX PATH walk already in `resolveOnPath` | `harness-availability.ts:55-67` vs `adapters/line-spawn.ts:29-55` (explicit-path test `harness-availability.ts:58` ≈ `line-spawn.ts:39`) | 2 |
| D10 | `safeId(agentId)` (identical 4-line body) | `copilot-agent.ts:28-31`, `goose-agent.ts:26-29`, `pi-agent.ts:27-30` | **3 identical copies** |
| D11 | "absolute path, no `..`" override validation | `copilot-agent.ts:37-40`, `pi-agent.ts:36-39` | 2 |

### 5.3 `spawn` option assembly

| # | block | file:lines | copies |
|---|---|---|---|
| D12 | `stdio: ['pipe', 'pipe', 'pipe']` literal | `adapters/line-spawn.ts:106`, `:115`, `adapters/omp-rpc-client.ts:247` | 3 (omp-rpc-client bypasses the shared helper) |
| D13 | `{ cwd: this.config.cwd ?? process.cwd(), env, windowsHide: true }` + `new StdioJsonRpcClient({...})` | `codex-agent.ts:601-614`, `dsh-agent.ts:494-501`, `qwen-agent.ts:480-487`, `hermes-agent.ts:451-458`, `harness-models.ts:110` | **5 copies** |
| D14 | `env = { ...bridge.bridgeEnv, ...(engine-specific keys) }` | `dsh-agent.ts:477-493`, `qwen-agent.ts:468-474`, `hermes-agent.ts:444-449`, `one-shot-cli-agent.ts:315-318`, `gemini-agent.ts:67-70`, `copilot-agent.ts:104-107`, `cursor-agent.ts:62-64`, `crush-agent.ts:68-73`, `goose-agent.ts:47-60`, `pi-agent.ts:66-71`, `claude-agent.ts:458-462`, `opencode-agent.ts:736-740` | **12 copies** |

### 5.4 prompt / context assembly

| # | block | file:lines | copies |
|---|---|---|---|
| D15 | `const taskText = request.message.parts.map((p) => { if ('text' in p) ... }).join('\n')` — a re-implementation of `base-agent.ts:189-197 partsText()` | `codex-agent.ts:222-228`, `claude-agent.ts:205-211`, `dsh-agent.ts:221-227`, `qwen-agent.ts:243-249`, `hermes-agent.ts:193-199`, `opencode-agent.ts:332-338`, `omp-agent.ts:669-675` | **7 copies** |
| D16 | same block for `msgText` in `peerTurn` | `codex-agent.ts:256-262`, `claude-agent.ts:240-246`, `dsh-agent.ts:255-261`, `qwen-agent.ts:277-283`, `hermes-agent.ts:227-233`, `opencode-agent.ts:369-375`, `omp-agent.ts:722-728` | **7 copies** |
| D17 | `fromId` / `requireReply` / `crossChannel` / `toolState.replyContext` prelude | `codex-agent.ts:248-255`, `claude-agent.ts:232-239`, `dsh-agent.ts:247-254`, `qwen-agent.ts:269-276`, `hermes-agent.ts:219-226`, `opencode-agent.ts:361-368`, `one-shot-cli-agent.ts:215-222`, `omp-agent.ts:719-740` | **8 copies** |
| D18 | `workerTurn` skeleton (taskId → `toolState.currentTaskId` → prompt → `yield* streamTurn`) incl. `finally { this.toolState.currentTaskId = null }` | `codex-agent.ts:216-243`, `claude-agent.ts:198-226`, `dsh-agent.ts:215-242`, `qwen-agent.ts:237-264`, `hermes-agent.ts:187-214`, `opencode-agent.ts:326-356`, `one-shot-cli-agent.ts:192-211`, `omp-agent.ts:642-688` | **8 copies** |
| D19 | `peerTurn` skeleton | `codex-agent.ts:245-279`, `claude-agent.ts:228-263`, `dsh-agent.ts:244-278`, `qwen-agent.ts:266-300`, `hermes-agent.ts:216-250`, `opencode-agent.ts:358-392`, `one-shot-cli-agent.ts:213-239`, `omp-agent.ts:695-759` | **8 copies** |
| D20 | constructor identity block `super({ agentId: typeof config.agentId === 'string' ? ... , role: config.role === 'lead' ? 'lead' : 'worker', ... })` | `codex-agent.ts:95-100`, `claude-agent.ts:96-101`, `dsh-agent.ts:99-104`, `qwen-agent.ts:123-128`, `hermes-agent.ts:76-81`, `opencode-agent.ts:144-149`, `one-shot-cli-agent.ts:130-135`, `omp-agent.ts:398-403` | **8 copies** |
| D21 | `contextPrefix()` / `systemManual()` per-turn assembly paired with `workerPrompt`/`peerPrompt` | same 8 files, `workerTurn`/`peerTurn` bodies (see D18/D19) | 8 |
| D22 | `partsText` twin in the base itself | `base-agent.ts:189-197` — canonical, already exists | (target, not duplicate) |

### 5.5 `parseXxxLine` / event-line mappers

| # | function | file:lines | copies |
|---|---|---|---|
| D23 | ACP `pushUpdate(params)` notification mapper (`agent_message_chunk` / `tool_call` / `tool_call_update` / usage) | `dsh-agent.ts:327-371`, `hermes-agent.ts:293-336` | **2 near-identical copies (~95 %)**; only `DSH_ACP_METHODS` vs `HERMES_ACP_METHODS` and 2 comment lines differ |
| D24 | inner `statusEvent(text)` helper | `dsh-agent.ts:335-344`, `hermes-agent.ts:301-310`, `claude-agent.ts:311-316`, `opencode-agent.ts:551-558`, `one-shot-cli-agent.ts:339-348` | **5 copies** |
| D25 | `tryParse(line)` JSON guard | `one-shot-cli-agent.ts:108-115` (only one in adapters; `stdio-jsonrpc.ts:244`, `omp-rpc-client.ts:417` are inline `JSON.parse`) | 1 + 2 inline |
| D26 | engine `mapLine` dispatch tables | `gemini-agent.ts:76-108`, `copilot-agent.ts:112-129`, `cursor-agent.ts:68-95`, `crush-agent.ts:78-100`, `goose-agent.ts:61-91`, `pi-agent.ts:82-101` | 6 (shape, not text) |

### 5.6 output accumulation loops

| # | block | file:lines | copies |
|---|---|---|---|
| D27 | `enqueue` closure (artifact-before-done + `isDone` latch + `resolveWait?.()`) | `codex-agent.ts:301-322`, `dsh-agent.ts:304-324`, `hermes-agent.ts:271-291`, `qwen-agent.ts:321-340`, `claude-agent.ts:286-303`, `opencode-agent.ts:423-446`, `one-shot-cli-agent.ts:386-402`, `omp-agent.ts:826-832` | **8** (dsh/hermes/qwen are textually identical except qwen's missing `this.turnActive = false` at dsh:314/hermes:281 — behaviourally equivalent because qwen sets it in the following branch at 332-335) |
| D28 | artifact literal `{ kind: 'artifact', artifact: { artifactId: randomUUID(), name: 'output', parts: [{ text }], lastChunk: true, totalChunks: 1 } }` | `codex-agent.ts:304-309`, `dsh-agent.ts:307-312`, `hermes-agent.ts:274-279`, `qwen-agent.ts:324-329`, `claude-agent.ts:288-293`, `one-shot-cli-agent.ts:390-395`, `opencode-agent.ts:428-433` + `:460-465`, `omp-agent.ts:1035-1044` | **9** |
| D29 | drain loop `while (!isDone \|\| queue.length > 0)` + stall watchdog + `await new Promise((r) => { resolveWait = r; setTimeout(...) })` | `codex-agent.ts:460-478`, `claude-agent.ts:388-406`, `dsh-agent.ts:414-432`, `qwen-agent.ts:404-422`, `hermes-agent.ts:376-394`, `opencode-agent.ts:502-529`, `one-shot-cli-agent.ts:492-511`, `omp-agent.ts:912-941` | **8 copies** |
| D30 | `flushDelta` / `pushDelta` 50 ms delta batching | `codex-agent.ts:324-340`, `omp-agent.ts:845-861` | 2 |
| D31 | `const queue / let isDone / let resolveWait / let lastActivity / let agentText` state prelude | 8 files (same as D29) | 8 |
| D32 | abort fallback `setTimeout(() => { if (!isDone) enqueue({ kind: 'done', ... }) }, 5000)` | `codex-agent.ts:431-433`, `claude-agent.ts:380-382`, `dsh-agent.ts:381-383`, `qwen-agent.ts:380-382`, `hermes-agent.ts:345-347`, `opencode-agent.ts:477` | **6 copies** |
| D33 | `onAbort` handler (log + engine cancel + 5 s fallback) | `codex-agent.ts:428-434`, `claude-agent.ts:377-383`, `dsh-agent.ts:378-385`, `qwen-agent.ts:377-385`, `hermes-agent.ts:342-348`, `opencode-agent.ts:472-478`, `one-shot-cli-agent.ts:434-438`, `omp-agent.ts:871-883` | **8 copies** |
| D34 | `collectTurnEvents` (byte-identical) | `codex-agent.ts:494-501`, `claude-agent.ts:419-426`, `dsh-agent.ts:446-453`, `qwen-agent.ts:435-442`, `hermes-agent.ts:407-414`, `one-shot-cli-agent.ts:242-249` | **6 identical copies** (omp-agent.ts:145-192 is a 7th, differently implemented) |

```ts
494:   protected async collectTurnEvents(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentEvent[]> {
495:     const events: AgentEvent[] = []
496:     for await (const e of this.streamTurn(prompt, undefined, timeoutMs, signal)) {
497:       events.push(e)
498:       if (e.kind === 'error') break
499:     }
500:     return events
501:   }
```

### 5.7 `dispose` / `kill` / process-management bodies

| # | function | file:lines | copies |
|---|---|---|---|
| D35 | `dispose()` (client teardown + `markHarnessProcessExit` + pending-map timer clear) | `codex-agent.ts:112-125`, `dsh-agent.ts:116-129`, `qwen-agent.ts:140-153`, `hermes-agent.ts:95-108` | **4 near-identical** (+ variants `claude-agent.ts:113-128`, `one-shot-cli-agent.ts:148-151`, `opencode-agent.ts:181-195`, `omp-agent.ts:437-449`) |
| D36 | `getProcessInfo()` | `codex-agent.ts:127-132`, `dsh-agent.ts:131-136`, `qwen-agent.ts:155-159`, `hermes-agent.ts:110-114`, `opencode-agent.ts:163-167`, `omp-agent.ts:459-464`, `one-shot-cli-agent.ts:153-157` | **7** |
| D37 | `killProcess()` | `codex-agent.ts:134-138`, `dsh-agent.ts:138-142`, `qwen-agent.ts:161-165`, `hermes-agent.ts:116-120` (byte-identical 5-liners) + `opencode-agent.ts:169-173`, `omp-agent.ts:467-476` | **6** |
| D38 | `reconcileProcess()` | `codex-agent.ts:140-142`, `dsh-agent.ts:144-146`, `qwen-agent.ts:167-169`, `hermes-agent.ts:122-124` (identical) + `opencode-agent.ts:175-179`, `omp-agent.ts:483-485` | **6** |
| D39 | `getContextStats()` shape `{ usedTokens, contextWindow, percent, compacting }` | `codex-agent.ts:144-153`, `dsh-agent.ts:148-157`, `hermes-agent.ts:126-135`, `qwen-agent.ts:171-173`, `claude-agent.ts:139-148`, `opencode-agent.ts:199-208`, `omp-agent.ts:241-252`, `one-shot-cli-agent.ts:170-179` | **8** |
| D40 | `steer()` deferred stub | `dsh-agent.ts:160-162`, `qwen-agent.ts:175-177`, `hermes-agent.ts:137-139`, `one-shot-cli-agent.ts:181-183` | **4** |
| D41 | `respondHitl()` default throw | `base-agent.ts:102-110`, `one-shot-cli-agent.ts:186-188` | 2 |
| D42 | `ensureClient(ctx)` guard (`if (!this.workspace) ... ; if (!this.agentInfo) { ...refreshIdentity() } ; if (client?.alive && session) return ; clientStarting ??= startClient().finally(...)`) | `codex-agent.ts:581-597`, `dsh-agent.ts:457-473`, `qwen-agent.ts:446-457`, `hermes-agent.ts:418-434`, `opencode-agent.ts:714-726` (`ensureServer`), `omp-agent.ts:1092-1103` | **6** |
| D43 | `startClient()` scaffolding (`const command = config.command ?? harnessSettings().X` + `new StdioJsonRpcClient` + pidRef + onExit + `registerHarnessProcess`/`bindHarnessProcess` + handshake + session create) | `codex-agent.ts:599-664`, `dsh-agent.ts:475-545`, `qwen-agent.ts:459-511`, `hermes-agent.ts:436-497` | **4** (~60 lines each) |
| D44 | `const pidRef = { pid: undefined as number \| undefined }` + `client.onExit(...)` + `registerHarnessProcess` + `bindHarnessProcess` | `codex-agent.ts:615-626`, `dsh-agent.ts:502-513`, `qwen-agent.ts:488-499`, `hermes-agent.ts:459-470`, `one-shot-cli-agent.ts:380-384`, `opencode-agent.ts:749-753` | **6** |
| D45 | ACP `initialize` + version-retry + `session/new` + sessionId guard | `dsh-agent.ts:525-542`, `hermes-agent.ts:480-494` | **2 near-identical** |
| D46 | `registerXxxHitl` (registry.register + `harnessSettings().hitl_timeout_ms` + `setTimeout` fail-closed) | `codex-agent.ts:505-533` and `:535-560`, `dsh-agent.ts:547-577`, `hermes-agent.ts:499-527`, `qwen-agent.ts:513-539`, `opencode-agent.ts:686-710`, `claude-agent.ts:539-562` | **7** |
| D47 | `clearPending(id, resolution)` | `dsh-agent.ts:206-211`, `hermes-agent.ts:178-183` (identical), `qwen-agent.ts:196-201`, `claude-agent.ts:187-194 denyPending` | 4 |
| D48 | ACP allow/reject option picking | `dsh-agent.ts:182-201`, `hermes-agent.ts:154-173` | **2 identical** |
| D49 | ensure engine MCP config (read JSON → merge `mcpServers.aw` → write JSON) | `gemini-agent.ts:34-56`, `copilot-agent.ts:47-64`, `cursor-agent.ts:34-50`, `qwen-agent.ts:50-86` | **4** (+ TOML variant `codex-agent.ts:671-728`, bash variant `crush-agent.ts:35-55`) |

### 5.8 Same-key config parsing (config interfaces)

| # | duplicated shape | file:lines | copies |
|---|---|---|---|
| D50 | `command / args / cwd / model / promptTimeoutMs / superviseTimeoutMs / systemPromptPrefix / scenarioPrompt / agentId / name / role / channelId / token / baseUrl / mcpBridgePath` re-declared | `codex-agent.ts:35-66`, `dsh-agent.ts:44-77`, `claude-agent.ts:39-61`, `hermes-agent.ts:42-62`, `qwen-agent.ts:88-109`, `opencode-agent.ts:40-78` (no index signature) and `one-shot-cli-agent.ts:82-101` (has one) | **7 interfaces**, 15 shared keys each |
| D51 | `private agentRole: 'lead' \| 'worker' = 'worker'` re-declared over `base-agent.ts:54 protected agentRole` | `codex-agent.ts:77`, `claude-agent.ts:78`, `dsh-agent.ts:88`, `qwen-agent.ts:114`, `hermes-agent.ts:67`, `opencode-agent.ts:119`, `omp-agent.ts:208` | **7 copies**; compiler: `TS2415 … Property 'agentRole' is private in type 'ClaudeSdkAgentImpl' but not in type 'BaseAgentImpl'` (and the same for Hermes/Omp/Qwen); at runtime the field initializer runs **after** `super()` and overwrites the value the base constructor set — masked only because `ensureClient` re-assigns it (`dsh-agent.ts:461`, `codex-agent.ts:585`, `opencode-agent.ts:718`, `hermes-agent.ts:422`, `omp-agent.ts:1099`) |
| D52 | `private readonly bridgeCtx = { identity: {...}, state: this.toolState, getWorkspace: () => this.workspace }` re-declared over `base-agent.ts:49` | `codex-agent.ts:71-75`, `dsh-agent.ts:82-86`, `opencode-agent.ts:113-117` | **3 copies**; compiler: `TS2415 … Property 'bridgeCtx' is private in type 'CodexAgentImpl' but not in type 'BaseAgentImpl'` (same for Dsh/OpenCode) |
| D53 | `private supervising = false` re-declared over `base-agent.ts:135` | `opencode-agent.ts:278`, `omp-agent.ts:554` | 2; compiler `TS2415` on `opencode-agent.ts(110,14)` |
| D54 | `configRecord()` return `Record<string, unknown>` with a non-index-signature config type | `codex-agent.ts:108-110`, `dsh-agent.ts:112-114`, `opencode-agent.ts:157-159` | 3; compiler `TS2322: Type 'CodexAgentConfig' is not assignable to type 'Record<string, unknown>'. Index signature for type 'string' is missing` |

### 5.9 Duplicate object keys / dead code (verified literals)

| # | file:line | code |
|---|---|---|
| D55 | `omp-agent.ts:1112-1113` | `args: [...(this.config.thinkingLevel ? ['--thinking', this.config.thinkingLevel] : [])],` / `args: this.config.args,` — last key wins, so **`--thinking` is never passed**; compiler `omp-agent.ts(1113,9): error TS1117: An object literal cannot have multiple properties with the same name.` The monitoring registration at `omp-agent.ts:1131` repeats the same (wrong) argv: `args: ['--mode', this.rpcMode, ...(this.config.args ?? [])]` |
| D56 | `goose-agent.ts:44-45` | `promptDelivery: 'arg',` twice; compiler `goose-agent.ts(45,3): error TS1117` |
| D57 | `goose-agent.ts:41` | `args.push('--with-extension', \`${nodePath} ${bridgePath}\`)` — two paths pre-joined into one argv element |
| D58 | `one-shot-cli-agent.ts:117` | `export class OneShotCliAgentImpl extends BaseAgentImpl implements AgentInterface {` — `AgentInterface` is only `import type` at line 20-24, which does not list it; compiler `one-shot-cli-agent.ts(117,67): error TS2304: Cannot find name 'AgentInterface'` |
| D59 | `qwen-agent.ts:205-235` | third copy of `supervise()` (base `base-agent.ts:137-166`, opencode `opencode-agent.ts:280-324`) — see §4.4 for why it never works |

### 5.10 Proposal — shared base class + util module

**Move into `adapters/stdio-jsonrpc.ts` (or a new `adapters/stdio-rpc-agent.ts` subclass base):**
everything shared by codex / dsh / qwen / hermes —
`dispose` (`codex-agent.ts:112-125`, `dsh-agent.ts:116-129`, `qwen-agent.ts:140-153`, `hermes-agent.ts:95-108`),
`getProcessInfo` (D36), `killProcess` (D37), `reconcileProcess` (D38), `getContextStats` (D39),
`ensureClient` (D42), the `pidRef`/`onExit`/register/bind block (D44), `startClient` scaffolding (D43),
`collectTurnEvents` (D34), the `enqueue` closure (D27) and the drain loop (D29).
Net: ≈ **560 lines** of the 4 ACP/JSON-RPC adapters become one ≈ 180-line base.

**Move into a new `agents/harness-turn.ts` util:** the event-queue turn machine
(`enqueue`, `flushDelta`/`pushDelta` when applicable, stall watchdog, `onAbort`, 5 s abort fallback,
`collectTurnEvents`) currently copied as D27/D29/D30/D32/D33/D34 — ≈ **340 lines across 8 files → ≈ 70**.

**Move into `prompt-builder.ts`:** `taskText`/`msgText` (D15/D16) become `partsText()` (already at
`base-agent.ts:189-197`); `fromId`/`requireReply`/`crossChannel`/`replyContext` (D17) becomes
`peerContext(request)`; the `workerTurn`/`peerTurn` skeletons (D18/D19) collapse into two base
template methods. ≈ **300 lines → ≈ 60**.

**Move into `harness-env.ts`:** D1 all 8 call sites become `bridgeEnvFor(config, selfAgentId)`; add
`registerBridgeProcess(client, meta)` covering D44/D5; delete the hand-rolled duplicate at
`opencode-agent.ts:786-790`.

**Move into `harness-process.ts`:** add `spawnKill(pid, child)` so `stdio-jsonrpc.ts:205` and
`omp-rpc-client.ts:382` use the same tree-kill as `killProcess()`; add `registerAgentProcess(child,
meta)` covering D44.

**Move into `agents/harness-config.ts` (new):** the merge-only MCP config writers (D49) as
`mergeMcpServer(file, { type?, command, args, trust? })` + `resolveHarnessHome(root, agentId)`
(covering `safeId`, D10) + `assertSafeAbsolutePath` (D11).

**Move into `registry.ts`:** `resolveCommand` (D6/D7) becomes `HarnessDef.resolveCommand(config)` so
both the probe (`registry.ts:125,134,…`) and the adapter read the same function.

**Delete outright:** all `private agentRole` / `private bridgeCtx` / `private supervising`
re-declarations (D51-D53, 12 declarations), `qwen-agent.ts:205-235` (dead override, D59), the duplicate
key at `omp-agent.ts:1113` (D55) and `goose-agent.ts:45` (D56), the two redundant
`generateMcpBridgeEnv` evaluations at `dsh-agent.ts:485-486` (D2).

Estimated net reduction: **≈ 1 500 lines** of the ~5 000 lines currently in the 13 adapters, with the
divergences in D27/D29 and D51-D54 eliminated by construction.

## 6. Registry + base class

### 6.1 Registry enumeration — complete and correct

`registry.ts:109-236` `export const HARNESS_REGISTRY: Record<string, HarnessDef> = {` contains
**14 entries**: `mock` (110), `omp` (119), `opencode` (128), `codex` (137), `dsh` (146), `claude` (155),
`gemini` (164), `copilot` (173), `cursor` (182), `crush` (191), `goose` (200), `qwen` (209), `pi` (218),
`hermes` (227).
That is **exactly one entry per adapter file** (13 harness adapters + `mock-agent.ts`) — no adapter is
missing and none is registered twice. `factory.ts:10-12` delegates to
`registry.ts:252-258 createAgentImplByHarness`.

Every entry carries a `probe`; the two in-process engines declare
`probe: { inprocess: true }` — `registry.ts:116` (mock) and `registry.ts:161` (claude) — matching
`harness-availability.ts:90-92`. The 11 process engines' `probe.command` uses the same
`cmdFrom(c) || harnessSettings().X_command` rule as the adapters, and
`settings.ts:87-98` declares exactly those 11 keys (`opencode_command … hermes_command`, no
`omp_command` because `registry.ts:125` hard-codes `'omp'`, matching `omp-agent.ts:1108`
`const command = this.config.command ?? 'omp'`).

Cross-file enumeration gaps found (outside the agents tree but same fact source):
- `plugins/dev-stability-guard.ts:16` lists only 4 harnesses (`opencode|omp|codex|dsh`).
- `scripts/e2e-multi-harness.ts:166` lists 12 (identical union minus `omp`) while
  `harness-models.ts:265-303` covers all 13 (`case 'omp' … case 'hermes'` + `default`).

### 6.2 Which adapters do NOT extend `BaseAgentImpl`

Exactly one: **`mock-agent.ts:38`**

```ts
38: export class MockAgentImpl implements AgentInterface {
```

It has no `dispose`, no `killProcess`/`getProcessInfo`, no `respondHitl` and no `onTurnSettled`
— consistent with its in-process nature, but it also means it does not inherit the base
`run()` dispatch (`base-agent.ts:114-125`); it re-implements it at `mock-agent.ts:68-81`.

Declarations (verbatim):

```ts
base-agent.ts:46        export abstract class BaseAgentImpl implements AgentInterface {
adapters/one-shot-cli-agent.ts:117  export class OneShotCliAgentImpl extends BaseAgentImpl implements AgentInterface {
codex-agent.ts:68       export class CodexAgentImpl extends BaseAgentImpl implements AgentInterface {
claude-agent.ts:75      export class ClaudeSdkAgentImpl extends BaseAgentImpl implements AgentInterface {
dsh-agent.ts:79         export class DshAgentImpl extends BaseAgentImpl implements AgentInterface {
qwen-agent.ts:111       export class QwenAgentImpl extends BaseAgentImpl {
hermes-agent.ts:64      export class HermesAgentImpl extends BaseAgentImpl implements AgentInterface {
omp-agent.ts:129        export class OmpRpcAgentImpl extends BaseAgentImpl implements AgentInterface {
opencode-agent.ts:110   export class OpenCodeAgentImpl extends BaseAgentImpl implements AgentInterface {
gemini-agent.ts:112     export class GeminiAgentImpl extends OneShotCliAgentImpl {
copilot-agent.ts:132    export class CopilotAgentImpl extends OneShotCliAgentImpl {
cursor-agent.ts:98      export class CursorAgentImpl extends OneShotCliAgentImpl {
crush-agent.ts:103      export class CrushAgentImpl extends OneShotCliAgentImpl {
goose-agent.ts:94       export class GooseAgentImpl extends OneShotCliAgentImpl {
pi-agent.ts:104         export class PiAgentImpl extends OneShotCliAgentImpl {
mock-agent.ts:38        export class MockAgentImpl implements AgentInterface {
```

So: 8 direct subclasses, 6 indirect (via `OneShotCliAgentImpl`), 1 (`mock`) outside the hierarchy.
`QwenAgentImpl` is the only direct subclass that omits `implements AgentInterface` (it inherits the
contract structurally).

Two "extends BaseAgentImpl" declarations do not actually satisfy it:
`opencode-agent.ts(110,14): error TS2515: Non-abstract class 'OpenCodeAgentImpl' does not implement
inherited abstract member collectTurnEvents from class 'BaseAgentImpl'` — opencode never defines
`collectTurnEvents` (it routes `supervise` through its own `runTurn` instead), so the base
`supervise()` at `base-agent.ts:150` would call an undefined method if the override were removed.
