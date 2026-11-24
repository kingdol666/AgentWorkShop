# AgentPrefabs, Skills & external MCP

AgentPrefabs package role/scenario prompts, multi-dimensional slots, supported model settings and tool/Skill/MCP capability switches into reusable expert configurations. They are bound to Channel members as immutable revisions and can only **narrow** capability; they never grant platform, Project or industrial write permission.

## 1. Settings › Skills

- **Discovery roots**: built-in `skills/`, managed `<configRoot>/skills`, `~/.agent/skills` (compatibility), `~/.agents/skills`, `$XDG_CONFIG_HOME/agents/skills`, plus explicit `AW_SKILL_ROOTS`.
- Discovery reads `SKILL.md` metadata only; it never executes `scripts/` or eagerly reads `references/`/`assets/`.
- Import creates an immutable managed copy (`<configRoot>/skills/<name>/<hash>/`), **disabled by default**. Enabling only makes it selectable by AgentPrefabs.
- `allowed-tools` is experimental metadata and grants no platform permission.
- Name collisions keep every source and report a diagnostic; nothing is silently shadowed.

## 2. Settings › External MCP

- Streamable HTTP only; endpoints must be `https://` with no inline credentials or query string.
- Credential references must be `AW_MCP_*` environment names; the server resolves values from the environment and never persists them in files, UI or logs.
- “Discover tools” only creates **pending** entries. An admin must explicitly mark:
  - `dataSharing=shared-safe` (data safe to share with every eligible bound member);
  - tool `classification=read`.
  Only both together can be approved; write tools are not enabled in this release.
- Endpoint, credential reference/generation, protocol, tool name/schema changes, or age beyond `maxDiscoveryAgeMs` return approvals to pending.
- At call time the server-side broker rechecks member, Channel/Project, prefab allowlist, schema and data domain. Denials never contact upstream.
- Egress is HTTPS public-only; private/loopback/reserved resolved addresses are rejected, redirects must stay same-origin and are revalidated per hop, and timeouts are never retried.

## 3. Settings › Agent Prefabs

1. Choose **New prefab** and name the draft before creating it. Use **Edit** in the list to open an existing prefab. Owners and administrators can edit, publish, and remove it; other authorized users can view public prefabs.
2. Set the role/scenario prompts, slots, and model profile, and select tools, plugin tools, Skill revisions, or MCP tools. A locked slot comes from the published snapshot and cannot be overridden at binding time.
3. Save the draft, then separately publish an immutable revision. Publishing never changes a member's existing binding. Unpublished drafts can be deleted; archiving hides a published prefab from new bindings without changing existing pins or historical snapshots.
4. In **Bind to Channel member**, select the Channel, member, and published revision. Each member instance can have one binding. Another bind returns `409 PREFAB_ALREADY_BOUND`; explicitly unbind before switching. An unbound member runs with its ordinary Agent configuration and platform permissions.

Effective capability = prefab selection ∩ system enabled/review ∩ Channel/Project policy ∩ role/industrial gates ∩ harness support. Platform collaboration/task tools remain available (still subject to Channel/Project policy).

## 4. Versions, clones and retries

- A member binding pins `(prefabId, revision, slotValues, contentHash)`; publishing a new revision never silently upgrades existing bindings.
- Session creation pins the member binding and snapshot hash; session clones copy the same revision and do not follow the latest.
- A Project task instance pins its snapshot on first creation; retries of the same work item reuse it; a new work item reads the Channel binding at that time.
- Missing required capability, missing revision, corrupt binding, or an empty required slot fails new work closed; it never falls back to the legacy tool surface.
- Ordinary revision updates wait for a safe idle boundary and do not force-stop busy work/HITL. Admin revocation, member disablement or tool/Skill/MCP disablement blocks the next call immediately.

## 5. Boundaries and known limits

- The first complete end-to-end path is verified with **OMP**; other harnesses declare their managed scope in the capability registry incrementally. Cached or native tools are adapter-dependent; a catalog filter alone is not proof of containment.
- Managed Skills are injected as low-trust text through `activate_skill`; scripts inside Skills are never executed.
- OMP runs under the same OS account as the service: credentials never enter harness config/environment, but this feature does not claim an OS/filesystem sandbox against a compromised same-identity harness.
- Simulator/shadow-twin evidence is not physical HIL, site admission or production approval.
- Existing MCP HTTP/REST/bridge authorization was hardened in this round; industrial HITL/DCW remains authoritative.

## 6. Acceptance evidence (v0.15.0)

- Isolated fresh-instance live acceptance **21/21** (`scripts/experiments/prefab-acceptance.mjs`): global-scope discovery from a clean `~/.agent/skills`, immutable import disabled by default, enable, prefab draft/publish, member binding to the pinned revision, tool-catalog narrowing with `activate_skill` present, low-trust skill body injection, unauthorized dispatch denial, session clone binding + snapshot hash, revision 2 without auto-upgrade, immediate denial after skill revocation, and MCP non-HTTPS rejection / secret-less manifest / bounded discovery failure.
- Merged-main gates: unit 2185/2186 (1 conditional skip), MCP 14/14, skills 197/0, docs 101/0, i18n 3439/3439, lint/typecheck/build PASS.
- Not yet verified: an external MCP positive live trace against a public HTTPS server, real OMP-model work under a prefab, and browser UI click-through. See the [full-flow acceptance report](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/evidence/2026-11-21-fullflow-round/REPORT.md).
