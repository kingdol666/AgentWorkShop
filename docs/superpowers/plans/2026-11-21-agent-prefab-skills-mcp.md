# AgentPrefab, Skills 与外部 MCP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AgentWorkShop 建立可管理、可审核、可追溯的 Skills 和外部 MCP 工具目录，并以不可变 AgentPrefab 版本安全地装配到 Channel、会话克隆和 Project 作业 runtime。

**Architecture:** 先加固现有 Agent MCP ingress 的身份/资源范围，再分别实现服务端 Skill catalog/store 和 MCP outbound broker。之后以 SQLite immutable prefab revisions、显式 Channel member binding、单一有效能力解析器与共享 host-tool dispatch 完成 runtime 装配。管理面声明仅是选择；每次调用在 dispatch/broker 中按当前身份和授权二次验证，不能依赖 harness 缓存目录作为权限边界。

**Tech Stack:** Node.js `>=23.4.0`、TypeScript、Nuxt/Nitro、Vue、SQLite `node:sqlite` + schema/migration ledger、`js-yaml`、当前 `@modelcontextprotocol/sdk` server 与锁定版本的 `@modelcontextprotocol/client`、Node `node:test`/`tsx`、现有 host-tool bridge、`server/services/workshop/net/ssrf.ts`。

**Spec:** [AgentPrefab、Skills 与外部 MCP 能力装配设计](../specs/2026-11-21-agent-prefab-skills-mcp-design.md)

## Global Constraints

- AgentPrefab 只能缩小可用能力：有效能力是系统启用 × 调用者/成员身份 × Channel/Project 策略 × 工具角色/授权 × prefab allowlist × harness 受管支持面的交集。
- host tool/Skill catalog filtering is advisory; service-side dispatch and outbound MCP broker must reauthorize every invocation immediately before side effects.
- 已发布 prefab revision 不可原地修改；绑定 `(prefabId, revision, slotValues)`，会话/Project clone/retry 继承快照，不重新追最新版。
- 旧成员无 prefab binding 读取为 `null` 且保持现有行为；新的 DB 字段/表只做兼容迁移，不以历史数据推断或扩大授权。
- Agent Skills `allowed-tools` 是实验性 metadata，不能映射成 AW 工具权限；Skill 导入/扫描/激活不得执行包内 scripts。
- Secret values must come only from environment variables or a secret service; source, examples, fixtures, logs, reports, and manifests must contain no usable credential literals.
- MCP discovery is metadata, not trust: annotations, names, `readOnlyHint`, schema, and registry metadata never grant permission or prove a tool is safe.
- MCP outbound transport starts with reviewed Streamable HTTP only; no arbitrary stdio command, OAuth browser workflow, private target, or side-effecting tool in the first rollout.
- Reuse `resolveRunMode().configRoot` for managed `skills/` and `mcp/` state; use the existing SSRF/address-validation policy and reject localhost, loopback, private, and reserved addresses without a feature-specific bypass.
- Credentials and raw secret values must not enter prefab revisions, Channel member config, cloned workspace config, harness env, or audit detail.
- Never let prefab configuration override platform safety prompt, Agent identity, Project authorization, DCW/HITL, product/line binding, or execution policy.
- External MCP v1 identity is a preconfigured service principal and approved tools may read only administrator-reviewed data safe to share with every bound Channel member; reject tools whose data domain cannot be established. No caller-specific/Project-private upstream data is supported until principal mapping and data-scope enforcement are designed.
- Prefab does not switch harness; runtime profile only selects validated settings supported by the member's existing harness. OMP is trusted at the OS service-account boundary: credentials never enter its process config/environment, but this feature does not claim a sandbox against a compromised same-identity harness.
- A successful authorized bind grants that Channel and its clones use of the pinned revision, not edit permission. Public templates may not reference private prefabs; owner/admin revocation immediately denies subsequent Skill/tool calls.
- Prefab/Skill/MCP deny policy applies across equivalent Agent-authenticated native, stdio bridge, HTTP MCP ingress and REST invocation paths. For paths that cannot carry operation checks, withhold the corresponding operation rather than treating one dispatch path as sufficient.
- MCP tool review is invalidated by endpoint/server identity, upstream credential principal generation, protocol, tool name or schema change, and by exceeded `maxDiscoveryAge`; invalidation marks tools pending and blocks invocation until reviewed again.
- Session/Project task instance creation captures the binding snapshot and hash; work start checks current revocation, and task retry reuses that captured snapshot. Missing or revoked snapshot blocks new execution; ordinary member edits affect only subsequently created instances.
- Simulation is not physical HIL, production admission, or field approval; incomplete Mimosa results are not security passes.

## Review Focus

1. **MCP session reused by a different principal or stale/disabled Agent token:** bind each ingress session to its authenticated Agent principal and revalidate enabled/current status on every call; Task 1 `rejects_session_principal_change_and_disabled_agent`.
2. **MCP tool endpoint redirects/rebinds DNS to loopback/private/reserved address:** validate each resolved destination and redirect with the shared SSRF guard, fail before network call; Task 4 `blocks_private_dns_and_redirect_before_tool_call`.
3. **Skill package contains traversal, symlink escape, malformed metadata or oversized resources:** reject without reading/executing outside the canonical root; Task 3 `rejects_untrusted_skill_paths_without_execution`.
4. **Old cached harness tool catalog or equivalent HTTP/native path invokes a revoked tool:** every entrypoint must deny before upstream side effect, including when tool definitions are stale; Tasks 1, 7 `revoked_prefab_mcp_tool_has_zero_upstream_hits`.
5. **Project/session clone, retry or busy runtime silently changes latest binding, loses snapshot, or interrupts HITL:** preserve instance snapshot and expose pending active version without force stop; Task 7 `clone_and_busy_revision_update_preserve_pinned_snapshot`.

---

## File Map

Existing integration points are kept narrow; no unrelated harness or plugin refactor is included.

- Modify `server/api/mcp/workshop.ts`: authenticate/bind legacy MCP HTTP session principals and enforce per-request revalidation.
- Modify `server/mcp/workshop-server.ts`: pass authenticated caller through a request-scoped server factory and close device resource scope gaps; keep human-only management denied.
- Modify `server/services/workshop/runtime/manager/host-tools.ts`: make token lookup semantics consistent for active members; route host tool definition and dispatch through effective prefab resolution when present.
- Create `server/services/workshop/skills/{types,frontmatter,discovery,store,service}.ts`: standards parsing, source classification, bounded discovery, reviewed immutable managed import/versioning and audit-safe diagnostics.
- Create `server/api/system/skills/{index.get,discover.get,import.post,[id].patch,[id].delete}.ts`: authenticated admin/editor reads and admin mutations; no secret values.
- Create `app/components/settings/SkillsPane.vue`; modify `app/pages/settings.vue` and `i18n/locales/{zh-CN,en}.ts` to add a lazy-loaded first-party Skills/MCP tab.
- Create `server/services/workshop/mcp-client/{types,config,client,broker}.ts`: server manifests, secret reference resolver, current/legacy protocol client, safe calls, result limits and audit. Preserve existing server `@modelcontextprotocol/sdk` paths.
- Create `server/api/system/mcp-servers/{index.get,index.post,[id].get,[id].patch,[id].delete,discover.post,review.post}.ts`: admin-only changes and explicit tool review; redact secret values on every response.
- Create `server/services/workshop/db/agent-prefab.repo.ts` and `server/services/workshop/agent-prefabs/{types,service,resolution,prompt}.ts`: SQLite records, version publication, validation, effective capability intersection and prompt blocks.
- Modify `server/services/workshop/db/database/schema.ts`, `server/services/workshop/db/database/migrations.ts`, `server/services/workshop/db/database/open.ts`, `server/services/workshop/db/database/rows.ts`, `server/services/workshop/db/database/index.ts`, and `server/plugins/workshop.ts`: additive schema/migration/repository wiring. Bump `SCHEMA_CONTRACT_VERSION` only when `SCHEMA_SQL` changes and add migration fingerprint tests.
- Modify `server/services/workshop/db/channel-agent.repo.ts`, `server/services/workshop/agents/agent-interface.ts`, `server/services/workshop/runtime/manager/types.ts`, `server/services/workshop/runtime/manager/admin-agents.ts`, `server/services/workshop/runtime/manager/admin-channel.ts`, `server/services/workshop/runtime/manager/channel-templates.ts`, `server/services/workshop/agents/session-clone.ts`, `server/services/workshop/agents/task-channel.ts`, and `server/services/workshop/runtime/manager/runtime-wiring.ts`: member binding, template persistence, all clone paths, effective runtime configuration, reload/pending state.
- Modify `server/services/workshop/agents/host-tool-bridge/{per-agent,dispatch}.ts`, `server/mcp/workshop-server.ts`, `server/api/mcp/workshop.ts`, `server/services/workshop/agents/base-agent.ts`, and `server/services/workshop/agents/prompt-builder.ts`: consistent effective operation checks across native/HTTP/tool bridge, plus structured low-trust prompt/Skill activation.
- Modify `app/pages/workshop/agents.vue`, Agent member inspector/UI and `app/pages/workshop/channel-templates.vue` / Channel template editing components for binding and permission-aware transfer diagnostics; Settings remains the global catalog-management surface.
- Modify `package.json` / `pnpm-lock.yaml` only for an audited, pinned MCP client dependency and explicit packaged built-in Skill assets; modify docs/README/VitePress only in the documentation task.

## Interfaces

- `SkillRecord`: `{ id: string, name: string, description: string, source: 'builtin'|'managed'|'global'|'configured', sourcePath: string, contentHash: string, diagnostics: SkillDiagnostic[] }`; external source paths are read-only until explicit import.
- `McpServerManifest`: `{ id: string, label: string, transport: 'streamable-http', endpoint: string, credentialRef?: string, enabled: boolean, protocolPolicy: 'auto', tools: McpToolRecord[] }`; tool records pin `upstreamName`, `schemaHash`, `reviewStatus: 'pending'|'approved'|'rejected'`, `classification: 'read'|'write'` and bounds. No credential value is serializable in this type.
- `McpToolRecord`: `{ id: string, serverId: string, upstreamName: string, exposedName: string, description: string, inputSchema: Record<string, unknown>, schemaHash: string, reviewStatus: 'pending'|'approved'|'rejected', classification: 'read'|'write' }`.
- `AgentPrefabBinding`: `{ prefabId: string, revision: number, slotValues: Record<string,string>, contentHash: string }`; a missing member/project snapshot reads as `null`. Project work items store a separate first-instance snapshot and hash; retries do not replace it.
- `AgentCapabilityInput`: `{ binding: AgentPrefabBinding|null, member: AgentInfo, channelPolicy: ChannelToolPolicy, projectScope: ProjectToolScope|null, harnessCapabilities: HarnessCapabilitySet }`.
- `AgentCapabilityResolution`: `{ bindingHash: string|null, active: CapabilityRef[], disabled: CapabilityRef[], missing: CapabilityRef[], denied: CapabilityRef[], unsupported: CapabilityRef[], reasons: Record<string,string> }`; lists are deterministic and do not include credential values.
- `resolveAgentCapabilitySet(input: AgentCapabilityInput): AgentCapabilityResolution` is pure and deterministic. The same result contract feeds Settings preview, Agent tool catalog, activation, and dispatch; dispatch additionally resolves current revocation/enabled/auth state immediately before side effect.
- `createAgentPrefabDraft(input: AgentPrefabDraftInput, actor: PrefabActor): AgentPrefabDraft`; `publishAgentPrefabRevision(prefabId: string, expectedHead: number, actor: PrefabActor): AgentPrefabRevision` uses compare-and-swap and immutable snapshots.
- `McpBroker.call(identity: AgentIdentity, toolId: string, args: Record<string,unknown>, trusted: TrustedExecutionContext): Promise<HostToolResult>` returns a platform-normalized result and records audit metadata; it performs zero outbound requests if authorization/schema/egress checks fail.
- `activate_skill({ skillId: string, revision: string }): Promise<SkillActivationResult>` is a platform host tool exposed only for currently bound Skills. It returns low-trust wrapped instructions and canonical root metadata; file resource reads remain constrained to the same immutable root.

## Execution Plan

### Task 1: Close existing MCP ingress identity and resource-scope gaps

**Files:**
- Modify: `server/api/mcp/workshop.ts`
- Modify: `server/mcp/workshop-server.ts`
- Modify: `server/services/workshop/runtime/manager/host-tools.ts`
- Test: `tests/mcp-workshop-authz-regression.test.ts`
- Test: `tests/aw-mcp-server.test.ts`

**Interfaces:**
- Consumes: `createWorkshopMcpServer(manager)` and the existing stateful Streamable HTTP transport.
- Produces: request-scoped authenticated Agent identity; session is bound to the principal that initialized it; current member existence/enabled/token status is checked before every request; `findActiveAgentByToken` and `deviceAccessScopeOf` on the manager. Device reads/bindings are constrained to caller-authorized devices/workspaces; human-only operations remain denied. Prefab cross-entry capability checks are introduced in Task 7 where prefabs exist.

- [x] **Step 1: Add failing ingress-auth regression tests** named `rejects_missing_invalid_and_disabled_agent_tokens`, `rejects_mcp_session_principal_change`, `device_read_is_scoped_to_authorized_device`, `device_bind_checks_agent_and_device_scope`, and `empty_scope_does_not_grant_workspace_devices`; assert unauthorized status and side-effect count `0`.
- [x] **Step 2: Run focused regression tests and verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/mcp-workshop-authz-regression.test.ts`. Expected: tests fail because the pure auth/scope module does not exist; use only in-process fakes, no credentials/listener/external services.
- [x] **Step 3: Implement request-principal session binding** in `server/api/mcp/workshop.ts`: authenticate every request, store only manager-resolved Agent ID on the session, reject principal changes, revalidate token/Agent enabled/Channel enabled. Never accept a model/caller-supplied Agent ID as authority.
- [x] **Step 4: Add strict manager resolution and device scope** in `runtime/manager/host-tools.ts` and `server/mcp/workshop-server.ts`: `findActiveAgentByToken`, `deviceAccessScopeOf`, scoped `device.list`/`device.read`, self-only `device.bind_agent`; keep admin/control/telemetry methods denied to Agent principal.
- [x] **Step 5: Run focused MCP ingress tests.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/mcp-workshop-authz-regression.test.ts`. Expected: all pass; denied paths mutate no repository state.
- [x] **Step 6: Run shared static gates.** Run: `pnpm typecheck` and `pnpm lint`. Expected: exit code 0.
- [x] **Step 7: Update the live REST/MCP smoke script** to authenticate initialize/tools-list/DELETE and assert anonymous 401 + session-principal 403; commit the authorization fix.

### Task 2: Add managed Skill standards parser and bounded discovery

**Files:**
- Create: `server/services/workshop/skills/types.ts`
- Create: `server/services/workshop/skills/frontmatter.ts`
- Create: `server/services/workshop/skills/discovery.ts`
- Test: `tests/managed-skills-discovery.test.ts`
- Modify: `package.json` only if a direct parser dependency is required (baseline already has `js-yaml`).

**Interfaces:**
- Consumes: `js-yaml`, `node:fs`, `node:path`, `node:crypto`; roots supplied by service layer, never inferred from request path.
- Produces: `parseSkillMarkdown(markdown: string, directoryName: string): ParsedSkill`; `discoverSkills(roots: SkillRoot[], limits: SkillScanLimits): Promise<SkillRecord[]>`.

- [x] **Step 1: Add failing `parseSkillMarkdown` tests** named `parses_required_fields_and_optional_metadata`, `rejects_bad_name_and_directory_mismatch`, `handles_yaml_description_with_colon`, `reports_invalid_frontmatter`, and `hashes_exact_source_content`.
- [x] **Step 2: Run parser tests to verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-skills-discovery.test.ts`. Expected: imports/types/functions are missing and tests fail.
- [x] **Step 3: Implement `parseSkillMarkdown(markdown,directoryName)`** with existing `js-yaml` and Agent Skills required `name`/`description`; preserve optional supported fields as metadata, treat `allowed-tools` informational only, enforce 1–64 lowercase alphanumeric/hyphen name, no leading/trailing/consecutive hyphen, exact parent directory match, and 1–1024 character description; return hash and path-safe diagnostics.
- [x] **Step 4: Add failing discovery tests** named `discovers_service_user_agent_agents_xdg_and_compat_roots`, `does_not_claim_global_home_is_remote_browser_home`, `rejects_root_escape_symlink`, `does_not_scan_beyond_configured_depth`, `caps_skill_count_and_file_bytes`, `deduplicates_same_realpath`, `records_name_conflict_without_shadowing`, and `never_executes_skill_script`; assert script side effect count `0`.
- [x] **Step 5: Implement bounded `discoverSkills(roots,limits)`**: inspect only direct skill-directory children containing exact `SKILL.md`; support explicit `~/.agent/skills` compatibility, `~/.agents/skills`, `$XDG_CONFIG_HOME/agents/skills` (default `~/.config/agents/skills`) and configured client roots; derive roots from server service identity/config only; canonicalize, reject symlink escapes, deduplicate, cap count/depth/bytes, report conflicts/provenance, never read scripts/resources during discovery.
- [x] **Step 6: Run focused Skill tests.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-skills-discovery.test.ts`. Expected: all metadata/path boundaries pass on Windows and POSIX; remote server does not use a caller's browser-local home.
- [x] **Step 7: Commit discovery/parser task** with message `feat: discover Agent Skills with bounded standard parsing`.

### Task 3: Add immutable managed Skill storage and Settings management API/UI

**Files:**
- Create: `server/services/workshop/skills/store.ts`
- Create: `server/services/workshop/skills/service.ts`
- Create: `server/api/system/skills/index.get.ts`
- Create: `server/api/system/skills/discover.get.ts`
- Create: `server/api/system/skills/import.post.ts`
- Create: `server/api/system/skills/[id].patch.ts`
- Create: `server/api/system/skills/[id].delete.ts`
- Create: `app/components/settings/SkillsPane.vue`
- Modify: `app/pages/settings.vue`
- Modify: `i18n/locales/zh-CN.ts`
- Modify: `i18n/locales/en.ts`
- Test: `tests/managed-skills-api.test.ts`
- Test: `tests/managed-skills-settings.test.ts`

**Interfaces:**
- Consumes: Task 2 `discoverSkills`, `parseSkillMarkdown`.
- Produces: `importManagedSkill(catalogId, actor): ManagedSkillRevision`; source is selected only from server-discovered catalog ID, never arbitrary client path. `listManagedSkills(actor)`; `patchManagedSkillStatus(id, enabled, actor)`; `readManagedSkillFile(id, revision, relativePath)` resolves only within immutable content root.

- [x] **Step 1: Add failing API tests** named `read_requires_editor_or_admin`, `mutation_requires_admin_and_audit`, `import_accepts_only_discovered_catalog_id`, `import_is_immutable_and_does_not_execute_scripts`, `api_never_returns_secret_values`, `relative_file_read_rejects_traversal`, `symlink_cannot_escape_managed_root`, and `revoked_revision_cannot_activate`.
- [x] **Step 2: Run API tests to verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-skills-api.test.ts`. Expected: catalog service/routes are missing.
- [x] **Step 3: Implement immutable Skill store** under `<configRoot>/skills/<id>/<contentHash>/` with staging+atomic rename; copy only bounded regular files contained under source realpath; reject symlinks, traversal, unsupported file types, invalid refs, oversized files/total size and duplicate ambiguous versions. Never execute code.
- [x] **Step 4: Implement authenticated Skill endpoints** following `requireRole` and `recordOps`: admin/editor read catalog, admin import/enable/disable/delete; request accepts catalog ID and explicit status, not arbitrary filesystem path. API exposes diagnostics/source/hash only, never secret values or raw environment values; audit changed ID/action only.
- [x] **Step 5: Add UI behavior tests** for lazy Settings tab, source/status badges, conflict/diagnostic display, explicit import confirmation, enable/disable state and permission errors; implement `SkillsPane.vue` and Settings tab using existing style/localization parity. Discovery never implies global Skill already enabled for Agent.
- [x] **Step 6: Run focused tests and Skills/UI gates.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-skills-api.test.ts tests/managed-skills-settings.test.ts`; `pnpm test:skills`; `pnpm i18n:check`. Expected: all pass.
- [x] **Step 7: Commit managed Skills task** with message `feat: manage immutable Agent Skills in system settings`.

### Task 4: Implement managed Streamable HTTP MCP registry and broker

**Files:**
- Create: `server/services/workshop/mcp-client/types.ts`
- Create: `server/services/workshop/mcp-client/config.ts`
- Create: `server/services/workshop/mcp-client/client.ts`
- Create: `server/services/workshop/mcp-client/broker.ts`
- Create: `server/api/system/mcp-servers/index.get.ts`
- Create: `server/api/system/mcp-servers/index.post.ts`
- Create: `server/api/system/mcp-servers/[id].get.ts`
- Create: `server/api/system/mcp-servers/[id].patch.ts`
- Create: `server/api/system/mcp-servers/[id].delete.ts`
- Create: `server/api/system/mcp-servers/[id]/discover.post.ts`
- Create: `server/api/system/mcp-servers/[id]/review.post.ts`
- Modify: `app/components/settings/SkillsPane.vue`
- Modify: `server/services/workshop/net/ssrf.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `tests/managed-mcp-broker.test.ts`
- Test: `tests/managed-mcp-config.test.ts`

**Interfaces:**
- Consumes: Task 1 authorized principal/operation semantics; existing `resolveTargetIps`, `isPrivateIp` and `assertSafeHttpUrl` from `server/services/workshop/net/ssrf.ts`; injected secret resolver and approved-service-data policy. No module reads secrets directly from arbitrary environment variable names supplied by request.
- Produces: `McpClient.connect(config): Promise<McpConnection>`; `McpConnection.listTools(): Promise<McpToolRecord[]>`; `McpBroker.call(identity,toolId,args,trusted): Promise<HostToolResult>`; only approved, fresh, endpoint/principal/schema-pinned, share-safe read tools can call upstream.

- [x] **Step 1: Add failing mock-server tests** for modern 2026-07-28 auto probe, legacy 2025-11-25 initialize fallback, paginated tools/list, invalid tool schema, duplicate exposed names, same-schema endpoint/principal change, tool-list mutation requiring review, staleness expiry requiring review, bounded timeout/result limits, and auth header obtained via injected fake secret resolver.
- [x] **Step 2: Add failing outbound-policy tests** named `blocks_private_dns_and_redirect_before_tool_call`, `blocks_redirect_to_loopback`, `rejects_non_http_url_and_embedded_credentials`, `rejects_unresolved_or_changed_dns_target`, and `does_not_leak_secret_to_manifest_or_audit`; assert mock upstream hit count `0` for all denied requests.
- [x] **Step 3: Run MCP broker tests and verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-mcp-broker.test.ts tests/managed-mcp-config.test.ts`. Expected: broker/config modules missing; no live external MCP host contacted.
- [x] **Step 4: Select and pin MCP client version** compatible with Node >=23.4 and current repo dependencies; explicitly configure auto protocol negotiation and verify legacy fallback from source and mock tests. Preserve existing `@modelcontextprotocol/sdk` server dependency/imports. Add only necessary client package and lockfile diff.
- [x] **Step 5: Implement manifest + data-scope policy**: atomically save JSON under `<configRoot>/mcp/servers`; include server identity, canonical endpoint and credential principal/reference generation, reviewed shared-data class, `maxDiscoveryAge`, and approved tools. Reject an upstream tool unless an admin explicitly marks its data safe to share for every eligible bound member; do not let tool args choose arbitrary URL, headers, or tenant/project identity.
- [x] **Step 6: Implement URL/address guard** by composing/extending the existing SSRF helpers: HTTPS-only; reject URL credentials; validate every resolved A/AAAA result against private, loopback, link-local, reserved and non-global ranges; bind validation to actual connection target to prevent DNS rebinding; disable automatic redirects and validate every hop before requesting it; do not honor `AW_ALLOW_PRIVATE_OUTBOUND` for this broker. Deny before network when any validation cannot be proven.
- [x] **Step 7: Implement MCP discovery/review** with deterministic server-scoped tool IDs, JSON Schema object validation, pagination, content/result bounds, schema hashes and pending-review on any server identity, endpoint, credential principal generation, protocol, tool name/schema change or age expiry; do not trust `readOnlyHint`/annotations.
- [x] **Step 8: Add admin-only management endpoints/UI**: list/edit server manifest, test connection, browse pending tools, review only shared-data-safe read tools; require endpoint/principal change to re-review affected tools. Never return secret values. Audit manifest status and tool review decisions without secret or unbounded result data.
- [x] **Step 9: Implement broker invocation** through canonical operation IDs/shared dispatch; validate current Agent identity/enabled, binding, Channel/Project rules and server/tool review state immediately before outbound request; block if `maxDiscoveryAge` expired; enforce timeout, bound/sanitize content results and log redacted metadata. Never automatically retry a call with an unknown effect.
- [x] **Step 10: Run focused MCP tests plus existing MCP tests.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-mcp-broker.test.ts tests/managed-mcp-config.test.ts tests/aw-mcp-server.test.ts tests/mcp-workshop-authz-regression.test.ts`; then `pnpm typecheck`, `pnpm lint`. Expected: all pass; every denied call has zero upstream hits.
- [x] **Step 11: Commit MCP broker task** with message `feat: broker reviewed outbound MCP tools`.

### Task 5: Add AgentPrefab draft, publication revisions, binding schema and resolver

**Files:**
- Create: `server/services/workshop/db/agent-prefab.repo.ts`
- Create: `server/services/workshop/agent-prefabs/types.ts`
- Create: `server/services/workshop/agent-prefabs/service.ts`
- Create: `server/services/workshop/agent-prefabs/resolution.ts`
- Modify: `server/services/workshop/db/database/schema.ts`
- Modify: `server/services/workshop/db/database/migrations.ts`
- Modify: `server/services/workshop/db/database/open.ts`
- Modify: `server/services/workshop/db/database/rows.ts`
- Modify: `server/services/workshop/db/database/index.ts`
- Modify: `server/services/workshop/db/channel-agent.repo.ts`
- Modify: `server/services/workshop/db/database/migrations-project.ts`
- Modify: `server/services/workshop/db/channel-session.repo.ts`
- Modify: `server/services/workshop/db/project.repo.ts`
- Modify: `server/plugins/workshop.ts`
- Modify: `server/services/workshop/runtime/manager/types.ts`
- Modify: `server/services/workshop/agents/agent-interface.ts`
- Test: `tests/agent-prefab-repo.test.ts`
- Test: `tests/agent-prefab-resolution.test.ts`
- Test: `tests/migration-agent-prefab.test.ts`
- Test: `tests/project-prefab-snapshot.test.ts`

**Interfaces:**
- Consumes: Task 3 immutable Skill revision IDs/hashes; Task 4 reviewed MCP tool IDs/endpoint/principal/schema identities; existing Agent, Channel and Project authorization context.
- Produces: `AgentPrefabBinding|null`, `AgentCapabilityResolution`, `resolveAgentCapabilitySet(input)`, `createDraft(input, actor)`, `patchDraft(id, patch, expectedUpdatedAt, actor)`, `publishRevision(id, expectedHead, actor)`.

- [x] **Step 1: Add failing repo/resolver tests** for stable sorted intersections, duplicate capability refs, denied role/scope, unsupported existing harness, share-safe data class, required and optional missing refs, slot validation/length/order, endpoint/principal/schema change invalidating references, revoked binding and disabled/retired capabilities.
- [x] **Step 2: Add failing revision/migration tests** named `published_revision_is_immutable`, `publish_uses_expected_head_cas`, `legacy_agent_binding_defaults_null`, `concurrent_publish_conflict_does_not_move_head`, and `schema_contract_version_bumps_with_schema_sql`.
- [x] **Step 3: Run focused tests to verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/agent-prefab-repo.test.ts tests/agent-prefab-resolution.test.ts tests/migration-agent-prefab.test.ts`. Expected: new repository/resolver API absent.
- [x] **Step 4: Add prefab revision tables and Project work-item/task-instance snapshot storage** to `schema.ts`/`rows.ts`; implement additive idempotent migration and fingerprint registration in `open.ts`; bump schema contract only with SCHEMA_SQL change. Legacy member bindings and Project snapshots are null; never infer grants from old config.
- [x] **Step 5: Implement `agent-prefab.repo.ts` and central repository wiring** at `server/plugins/workshop.ts`/`runtime/manager/types.ts`; implement immutable publication with revision content hash, expected-head CAS, owner/visibility checks, separate draft mutation, explicit unbind, and stable read projection excluding prompt secrets/config credentials.
- [x] **Step 6: Implement pure resolver** that intersects prefab refs with admin registry enabled/review state, safe-to-share policy, Channel policy, Project scope, current Agent role, dynamic dispatch authorization, current identity/endpoint/principal/schema pins and declared current-harness capability. No model argument can select identity/scope.
- [x] **Step 7: Persist `prefabBinding` separately from `config_json`** in ChannelAgent row and `AgentInfo`; default legacy row to null; ensure patch distinguishes omitted binding (preserve) from explicit null (clear); update token/member projections so public roster payloads do not include secrets or entire prompt slot values.
- [x] **Step 8: Implement binding access semantics**: successful channel bind grants use to that Channel and derived clones only; validate private/public visibility when capturing or publishing Channel templates; public templates cannot reference private prefab revisions. Store grantor and channel relation for audit/revocation.
- [x] **Step 9: Run focused tests and migration recovery gates.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/agent-prefab-repo.test.ts tests/agent-prefab-resolution.test.ts tests/migration-agent-prefab.test.ts tests/migration-contract-recovery.test.ts`; then `pnpm typecheck`, `pnpm lint`. Expected: all pass and existing DB fixtures upgrade without lost rows or expanded grants.
- [x] **Step 10: Commit prefab domain task** with message `feat: persist versioned AgentPrefab revisions and bindings`.

### Task 6: Add AgentPrefab Settings and Channel member binding workflows

**Files:**
- Create: `app/components/settings/AgentPrefabsPane.vue`
- Create: `server/api/workshop/agent-prefabs/index.get.ts`
- Create: `server/api/workshop/agent-prefabs/index.post.ts`
- Create: `server/api/workshop/agent-prefabs/[id].get.ts`
- Create: `server/api/workshop/agent-prefabs/[id].patch.ts`
- Create: `server/api/workshop/agent-prefabs/[id]/publish.post.ts`
- Create: `server/api/workshop/channels/[channelId]/agents/[agentId]/prefab.patch.ts`
- Modify: `app/pages/settings.vue`
- Modify: Channel agent/member views and matching i18n entries (locate current owner components at implementation time and do not repurpose unrelated MemoryPanel WIP).
- Test: `tests/agent-prefab-api.test.ts`
- Test: `tests/agent-prefab-settings.test.ts`

**Interfaces:**
- Consumes: Task 5 draft/publish/resolution services.
- Produces: per-user visible prefab CRUD endpoints; publish returns immutable revision/hash; member binding returns persisted binding, authorization grantor/Channel, compatibility diagnostics and effective-capability preview; explicit null clears.

- [x] **Step 1: Add failing route tests** named `prefab_reads_respect_visibility`, `only_owner_or_admin_edits_draft`, `publish_returns_revision_hash`, `bind_requires_channel_management_right`, `member_cannot_bind_unavailable_capability`, `patch_omission_preserves_binding`, `explicit_null_clears_binding`, `public_template_rejects_private_prefab`, and `channel_grant_survives_authorized_clone_until_revoked`.
- [x] **Step 2: Run focused route tests to verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/agent-prefab-api.test.ts`. Expected: endpoints and binding operations absent.
- [x] **Step 3: Implement prefab API** with user-auth roles and owner/public rules; any Channel bind requires channel management authority and use permission at bind time; only admin publishes system-managed capabilities. Record grantor. A valid bind grants derived Channel/session/task clones use of the pinned revision, not edit rights. Revocation/visibility changes must surface impact and block future use.
- [x] **Step 4: Add failing Channel-template tests**: capture/save/instantiate preserves prefab ID, revision and slot values; public template rejects private prefab reference at save and instantiate; source-owner permission loss blocks new bind but does not silently migrate existing bindings.
- [x] **Step 5: Implement Channel-template binding persistence and checks** in `channel-template.repo.ts` and `channel-templates.ts`; capture the instance binding and authorized grant rather than resolving only mutable Agent `templateId`; validate visibility and use grant on template publish/instantiate.
- [x] **Step 6: Implement inline lead, member binding route and UI**: Channel template editor selects authorized prefab revision and slot values; add `AgentPrefabsPane.vue` as a lazy Settings tab and binding editor in Channel Agent member views; localize labels/help/errors; show effective capability/version preview without secret values.
- [x] **Step 7: Add UI assertions** for explicit switches, unavailable reasons, shared-data classification, revision creation, private/public template denial and unbind/revocation confirmation; cover empty/loading/error/no-permission/conflict/success states.
- [x] **Step 8: Run focused tests + i18n parity.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/agent-prefab-api.test.ts tests/agent-prefab-settings.test.ts tests/channel-template-prefab.test.ts`; `pnpm i18n:check`; `pnpm typecheck`; `pnpm lint`. Expected: all pass.
- [x] **Step 9: Commit authoring workflow** with message `feat: author and bind AgentPrefab revisions`.

### Task 7: Assemble pinned binding in runtime, clone, prompt, and shared tool dispatch

**Files:**
- Modify: `server/services/workshop/runtime/manager/admin-agents.ts`
- Modify: `server/services/workshop/runtime/manager/admin-channel.ts`
- Modify: `server/services/workshop/runtime/manager/channel-templates.ts`
- Modify: `server/services/workshop/agents/session-clone.ts`
- Modify: `server/services/workshop/agents/task-channel.ts`
- Modify: `server/services/workshop/projects/service.ts`
- Modify: `server/services/workshop/runtime/manager/runtime-wiring.ts`
- Modify: `server/services/workshop/agents/base-agent.ts`
- Modify: `server/services/workshop/agents/prompt-builder.ts`
- Modify: `server/services/workshop/agents/host-tool-bridge/per-agent.ts`
- Modify: `server/services/workshop/agents/host-tool-bridge/dispatch.ts`
- Modify: `server/mcp/workshop-server.ts` (equivalent operation gates)
- Create: `server/services/workshop/agent-prefabs/prompt.ts`
- Test: `tests/agent-prefab-runtime.test.ts`
- Test: `tests/agent-prefab-clone.test.ts`
- Test: `tests/agent-prefab-cross-entry-authz.test.ts`

**Interfaces:**
- Consumes: Task 5 `resolveAgentCapabilitySet`, Task 6 persisted binding and use grant.
- Produces: `resolveEffectiveAgentRuntime(member: ChannelAgentRow, channel: ChannelRow, context: RuntimeTrustedContext): EffectiveAgentRuntime`; effective result contains immutable revision/slot snapshot/hash, authorized operation IDs, available Skill revisions and structured prompt layers. Session/Project task instance carries `{ binding, bindingHash, createdAt }`; `wireMember` passes one validated result to both `implFactory` and `AgentRuntime` trusted context. `hostToolsForAgent`, native dispatch and HTTP MCP operation gates use the same resolved capability source.

- [x] **Step 1: Add failing runtime tests** named `two_same_prefab_members_get_distinct_tool_sets`, `prompt_slots_do_not_override_platform_or_industrial_sections`, `aml_prefix_and_prefab_layers_coexist`, `cached_tool_after_revoke_is_denied`, `required_missing_capability_blocks_new_run`, `optional_missing_capability_reports_degradation`, and `skill_activation_is_revision_pinned`.
- [x] **Step 2: Add failing clone/snapshot tests** for `channel_template_roundtrip_preserves_binding`, `session_clone_preserves_revision_slot_values_and_new_identity`, `project_instance_captures_enqueue_binding_snapshot`, `task_start_rejects_revoked_snapshot`, `project_retry_does_not_follow_prefab_head`, and `missing_snapshot_blocks_project_retry`.
- [x] **Step 3: Add failing cross-entry authorization tests**: for every prefab-controlled operation, invoke through native, Agent stdio/REST bridge and HTTP MCP ingress; assert a denied worker/disabled binding/revoked capability produces the same platform denial and zero MCP upstream hits.
- [x] **Step 4: Run focused tests to verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/agent-prefab-runtime.test.ts tests/agent-prefab-clone.test.ts tests/agent-prefab-cross-entry-authz.test.ts`. Expected: there is no common resolver/snapshot or operation parity gate.
- [x] **Step 5: Implement binding copy at every creation/template path**: ordinary member placement, inline lead, Channel template capture/instantiate; session/task clone copies existing instance binding and slot values without rereading source template. Public template creation/instantiation rechecks referenced prefab visibility/use grant; identity/token regenerate and no secret copies.
- [x] **Step 6: Freeze snapshots at instance enqueue/create**: persist the prefab revision, slot values and hash with the Session/Project task instance lineage; on task start, check revocation/visibility and required resources. Project retry reuses exact task-instance snapshot and blocks if absent/revoked rather than reading current member or latest prefab revision.
- [x] **Step 7: Implement `resolveEffectiveAgentRuntime`** at common `wireMember` seam before adapter construction. It selects the member's existing harness and only allowlisted, supported settings; keep prefab prompt keys separate from `systemPromptPrefix`; do not replace AML `composeChannelSystemPrompt`, Channel scenario or safety context.
- [x] **Step 8: Implement ordered prompt composition** of platform/system policy (unchanged), trusted runtime/industrial context (unchanged), prefab role layers, allowed slot values and Channel scenario as low-trust business text, current task last. Skill instructions are wrapped low-trust activated content; constrained resource reads resolve only under immutable revision root.
- [x] **Step 9: Route Skill activation through managed host bridge** with `activate_skill`; metadata first, explicit activation second, bounded resources on request, per-session deduplication, only pinned/reviewed/active member Skills. Never expose another member's private Skill root; document that same-account compromised harness isolation is not provided.
- [x] **Step 10: Apply identical capability gates** to per-agent catalog, core/plugin/native dispatch and HTTP MCP operations. Re-resolve enabled/revocation/scope/schema at call time; old cached tool or parallel ingress cannot bypass a deny. Keep existing built-in industrial, Project, HITL and DCW gates authoritative.
- [x] **Step 11: Implement safe runtime apply state**: regular revision edits affect newly created instances; a member binding update waits for safe idle/recycle for the base member and exposes desired vs active state; do not force-stop active task, HITL or queued work. Revocation/disable denies next Skill activation/tool call immediately. Required missing dependency blocks task start; optional missing dependency reports degradation.
- [x] **Step 12: Run Task 7 focused tests and existing runtime suites.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/agent-prefab-runtime.test.ts tests/agent-prefab-clone.test.ts tests/agent-prefab-cross-entry-authz.test.ts tests/session-clone*.test.ts tests/task-channel-profile.test.ts tests/tool-face-authz.test.ts tests/host-tool-surface-consistency.test.ts`; then `pnpm typecheck`, `pnpm lint`. Expected: all pass; clone identities differ, snapshots stay pinned, stale/revoked calls are denied across ingress, and pending state is visible.
- [x] **Step 13: Commit runtime assembly** with message `feat: assemble pinned AgentPrefab capabilities at runtime`.


### Task 8: Verify package assets, settings documentation, and support declarations

**Files:**
- Modify: `package.json`
- Modify: `nuxt.config.ts`
- Modify: `cli/core/post-build.mjs`
- Modify: README bilingual docs, relevant MCP/Skills/Agent/Channel guides and VitePress source pages plus sidebar.
- Test: `tests/managed-skills-package.test.ts`
- Modify: `scripts/test-aw-skills.mjs` only for new mirror/validation rules.

**Interfaces:**
- Consumes: Task 3 managed catalog and Task 7 runtime activation.
- Produces: built-in Skill assets available from source, installed npm package and standalone build; support matrix per harness distinguishes managed, partial and unsupported capability.

- [x] **Step 1: Add failing packaging tests** named `built_in_skills_exist_in_npm_file_allowlist`, `post_build_copies_assets_to_standalone_root`, `standalone_service_discovers_built_in_assets`, `skill_relative_resources_survive_package_install`, and `unsupported_harness_is_labeled_not_managed`.
- [x] **Step 2: Run package tests to verify RED.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-skills-package.test.ts`. Expected: Skills are not yet included in `package.json` files/output-copy contract.
- [x] **Step 3: Add explicit built-in Skills asset mapping** to package allowlist and post-build output copy; verify no unrelated runtime home/credentials are bundled and `SKILL.md` relative resource roots remain intact.
- [x] **Step 4: Publish adapter capability support matrix** in runtime support API/UI: managed Skill delivery and managed host tools are separate flags; unknown adapter capability defaults false/unsupported.
- [x] **Step 5: Update English and Chinese docs** for source scopes (`~/.agent/skills`, `~/.agents/skills`, XDG/client roots), platform config roots, import/review behavior, MCP transport/protocol support, credential references, prefab revision/slot behavior, revocation and harness limitations. Avoid claiming npm Skill discovery from a directory unsupported by the standard.
- [x] **Step 6: Run docs/package gates.** Run: `pnpm exec tsx --tsconfig .nuxt/tsconfig.server.json --test tests/managed-skills-package.test.ts`; `pnpm test:skills`; `pnpm readme:lint`; `pnpm docs:check`; `pnpm i18n:check`; `pnpm typecheck`; `pnpm lint`. Expected: all pass, exact README/site source pairing remains consistent.
- [x] **Step 7: Commit package and support documentation** with message `docs: document managed Skills MCP and AgentPrefab support`.

### Task 9: Full isolated mainline acceptance and security review

**Files:**
- Create: `scripts/experiments/agent-prefab-acceptance.mjs`
- Create: `docs/audit/evidence/YYYY-MM-DD-agent-prefab-acceptance/{REPORT.md,manifest.json,*.json}`
- Modify: `skills/aw-live-acceptance-round/SKILL.md` and its `.agents/skills` mirror only if the user-owned current version is restored/reconciled in a separately authorized task; this plan does not overwrite existing WIP.

**Interfaces:**
- Consumes: all prior task APIs/runtime behavior plus isolated app build, disposable `AW_HOME`, local loopback mock MCP server (only for a test-only egress policy explicitly isolated from non-test broker; no private-address production bypass), and attributed simulator.
- Produces: per-gate evidence, run manifest, `PASS|PARTIAL|BLOCKED|NOT_RUN` report, no credentials, and one reproducible bounded workflow.

- [x] **Step 1: Create isolated acceptance runner** with build SHA, disposable home, app port, mock server port and evidence path; require process ownership proof before starting/stopping test-only processes; never restart shared IDD/RAG/PLC services. Mock MCP transport is injected into test-only client factory, not reachable through production URL config.
- [x] **Step 2: Assert Skills admin workflow**: discover built-in plus explicitly configured service-user roots, import a fixture with a reference file, enable one revision and verify provenance/hash; never execute fixture scripts.
- [x] **Step 3: Assert MCP protocol and approval identity** against modern and legacy mock servers. Change mock endpoint identity, credential principal generation and schema independently while keeping schema unchanged in at least one case; each identity change must set review pending and block call. Invoke approved share-safe read tool through a prefab-bound OMP lead and record hit/hash.
- [x] **Step 4: Assert data-domain limits**: configure mock tool as project-private/unknown domain and verify admin cannot approve for shared Agent use; configure a reviewed share-safe response and verify bounded/sanitized output reaches eligible member only. Assert destination receives no caller-selected URL/header/tenant path.
- [x] **Step 5: Assert cross-entrypoint denial**: bind same prefab to lead and worker with different tool sets; attempt worker invocation through native host bridge, cached stdio catalog, REST bridge and HTTP MCP equivalent operation. Each deny must use shared operation policy; mock upstream hit count remains zero.
- [x] **Step 6: Assert revocation and restart**: disable upstream tool or member, try cached definitions, assert zero upstream hits; restart isolated app and verify pinned revision/hash and credential-ref state restored, with no secret value in DB/evidence.
- [x] **Step 7: Assert Session and Project snapshot lifecycle**: create a Channel session and Project task instance; verify exact revision/slot/hash snapshot and new Agent identity/token; change Channel member binding, retry same item (must use the original snapshot) and create a new work item (must use then-current binding); revoke old snapshot and assert new execution is blocked. Verify authorized Channel grant passes to clones but cannot cross into a public template if underlying prefab is private.
- [x] **Step 8: Run one small non-industrial Project task** to create a full retrievable HTML artifact with independent SHA-256 and explicit submit/review/deliverable state; COMPLETED status alone does not pass artifact acceptance.
- [x] **Step 9: Run one simulation-only read/analysis scenario** with Skill guidance and reviewed read MCP capability; do not add MCP write tool or physical PLC action. Existing controlled-write regressions, if run, use simulator and existing governance only.
- [x] **Step 10: Run complete repository gates**: `pnpm test:unit`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test:mcp`, `pnpm test:skills`, `pnpm docs:check`, `pnpm readme:lint`, `pnpm i18n:check`, `pnpm check:cssvars`, `pnpm frontend-lifecycle-contract`, and focused MCP/prefab E2E. Expected: each mandatory command exit 0; do not sum overlapping suite counts.
- [x] **Step 11: Run Mimosa on changed files** and report seal, finding counts and run status; inconclusive/incomplete is not a security pass. Do not edit security config to force green.
- [x] **Step 12: Obtain independent PR review** of authorization entrypoint matrix, data egress scope, secret source/sinks, URL/DNS/redirect policy, schema/migration, clone provenance and positive/negative assertion quality; fix findings and rerun affected gates.
- [x] **Step 13: Write acceptance report** with tested SHA, exact commands/results, evidence hashes, harness support limits, simulation-vs-HIL statement and all remaining BLOCKED/PARTIAL/NOT_RUN items plus Mimosa status. Do not claim production readiness or physical integration.
- [x] **Step 14: Commit workflow and evidence report** with message `test: add AgentPrefab Skills MCP acceptance evidence`.

## Dependencies and PR Boundaries

1. Task 1 is an independent authorization PR and must merge before Task 4 exposes external MCP tools to Agent calls.
2. Tasks 2 and 3 form a Skills management PR; repository code-discovery tests do not require MCP broker.
3. Task 4 is an MCP management/broker PR; it may be built while Skills UI is underway but must share the hardened dispatch contract from Task 1.
4. Task 5 is the prefab data/resolver foundation; it may be developed alongside UI scaffolding but no runtime feature is accepted until its API/revision tests pass.
5. Task 6 depends on Task 5; Task 7 depends on Tasks 3, 4, 5 and 6.
6. Task 8 follows actual package/runtime implementation. Task 9 tests the merged `main` SHA and does not use the historical TSA5 report as current proof.
7. Merge one reviewed PR at a time; after merge, rebase later PRs onto the actual latest `origin/main` SHA. Do not stack against a branch that was squash-merged/deleted without rebasing.

## Self-Review

- **Spec coverage:** settings discovery/import for Skills (Tasks 2–3, 8); external MCP admin/transport/discovery/review/call and authorization hardening (Tasks 1, 4); immutable prefab and slot lifecycle (Tasks 5–6); runtime prompt, Skill, tool, clone and Project integration (Task 7); evidence and security boundary (Task 9).
- **Step scan:** each task has named failing assertions, explicit focused command and expected gate, concrete implementation seam and commit boundary. No task uses an open-ended “test edge cases” step; all listed cases name the input and expected outcome.
- **Type consistency:** `McpServerManifest`, `McpToolRecord`, `AgentPrefabBinding`, `AgentCapabilityInput`, `AgentCapabilityResolution`, `resolveAgentCapabilitySet`, `McpBroker.call`, and `resolveEffectiveAgentRuntime` are defined once and reused by dependent tasks.
- **Review focus coverage:** ingress principal/session tests Task 1; address/redirect SSRF Task 4; Skill path and metadata Task 2/3; cached revoked tool Task 7; pinned clone and busy apply Task 7.
- **Proportion:** nine tasks divide independent authorization, Skill, MCP, prefab, runtime, package/docs and integrated acceptance boundaries; no implementation bodies are prescribed beyond the exact security/persistence invariants.

## Rollback and Release Boundary

- Every PR is independently revertible where schema allows; for schema-backed prefab changes, retain additive columns/tables and disable the feature before any destructive cleanup.
- Roll back external MCP visibility by disabling the server/tool at broker and dispatch; cached harness schemas must not preserve invocation rights.
- Roll back a Skill by revoking its managed revision; existing historical binding remains auditable but future activation fails closed.
- Do not remove or rewrite paper, TSA evidence, Skills mirrors, README edits or other user WIP as part of implementation.
- No tag/release/publish/deployment is included. A release requires an explicit request after merged-main verification.

## Approval Gate

This is a plan artifact only. Before implementation, the design/spec and each PR boundary must be reviewed and approved. Implementation requires a separate explicit start/approval; this document does not itself authorize code changes, tests with external services, migration, commit, push, release or physical operation.
