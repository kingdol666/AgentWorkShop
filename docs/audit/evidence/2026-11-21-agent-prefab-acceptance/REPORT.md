# AgentPrefab / Skills / MCP 实机验收报告（2026-11-21）

- 被测构建：`origin/main@f6b20707b`（#252 + #253 + #254 + #255 + #256 + #257 全部合并后）
- 构建：`.output` 成功；外置资产 `prompts/schema.json/aml-python/skills/zod-direct` 均随产物分发
- 实例：隔离 worktree + 全新 `AW_HOME` + 全新 `USERPROFILE/HOME`，端口 `3026`，`/api/health` version=0.14.0
- 证据：`result.json`（21 项检查，脚本尾行 `RESULT {"total":21,"pass":21,"fail":0}`）
- 性质：软件 + 模拟环境验收；**不是物理 HIL/现场准入/生产批准**

## 1. 端到端执行结果（21/21 PASS）

| # | 检查 | 结果 | 说明 |
|---|---|---|---|
| 1 | admin_register | PASS | 全新实例首管理员注册 |
| 2 | skill_discovered_from_user_agent_root | PASS | 隔离 `~/.agent/skills/acceptance-analyzer` 被识别为 global 源 |
| 3 | skill_imported_immutable_disabled | PASS | 导入受管 revision，默认未启用 |
| 4 | skill_enabled | PASS | 显式启用 |
| 5 | prefab_draft_created | PASS | 角色/场景/插槽 + Skill 能力 |
| 6 | prefab_revision_published | PASS | 不可变 revision 1 + content hash |
| 7 | channel_with_mock_lead | PASS | 隔离 Channel + mock lead |
| 8 | member_bound_to_pinned_revision | PASS | 成员绑定固定 revision 1 |
| 9 | catalog_exposes_activate_skill_only_for_assigned_skill | PASS | 工具面 20 项，含 activate_skill |
| 10 | catalog_narrows_unselected_tool | PASS | `dcw_control` 不在目录；协作工具保留 |
| 11 | activate_skill_returns_low_trust_body | PASS | 返回 SKILL.md 正文 + low-trust 声明 + 受管目录 |
| 12 | unselected_tool_denied_at_dispatch | PASS | 直调未选能力被拒（平台工业门文案） |
| 13 | session_created | PASS | 会话克隆创建 |
| 14 | session_clone_copies_pinned_binding | PASS | clone 的 binding revision/hash 与基成员一致 |
| 15 | session_snapshot_hash_matches | PASS | Session 行含 64 位 prefab snapshot hash |
| 16 | revision2_published | PASS | 发布 revision 2 |
| 17 | existing_binding_not_auto_upgraded | PASS | 既有成员仍固定 revision 1 |
| 18 | revoked_skill_activation_denied | PASS | 停用 Skill 后下一次激活立即被拒 |
| 19 | mcp_rejects_non_https | PASS | `http://127.0.0.1` 登记返回 400 `MCP_HTTPS_REQUIRED` |
| 20 | mcp_manifest_registered_without_secret | PASS | HTTPS manifest 不含 secret/凭据值 |
| 21 | mcp_discovery_failure_is_bounded | PASS | 外部发现失败返回有界错误（502），无 secret 回显 |

## 2. 合并后门禁

| 门禁 | 结果 |
|---|---|
| `pnpm test:unit` | 2186 tests / 2185 pass / 1 skipped / 0 fail |
| `pnpm lint` | PASS（RSI 红线 31 文件 0 写调用） |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS（含 skills/zod-direct 资产） |
| `pnpm test:mcp` | 14/14 |
| `pnpm test:skills` | 197 PASS / 0 FAIL |
| `pnpm docs:check` | 101/0 |
| `pnpm readme:lint` | PASS |
| `pnpm i18n:check` | 3439/3439 keys，0 unresolved |
| `pnpm check:cssvars` | 161 变量引用全部有定义 |
| `pnpm frontend-lifecycle-contract` | PASS |

## 3. 覆盖与未覆盖边界

**已覆盖（真实进程 + 真实 HTTP + 真实 SQLite）**：Skill 标准发现/不可变导入/启用；Prefab 草稿/发布/成员绑定；工具目录收窄与 `activate_skill`；dispatch 拒绝未选能力；Session clone binding 与快照；发布新 revision 不自动升级绑定；Skill 撤销即时生效；MCP HTTPS/无 secret/失败有界。

**PARTIAL / BLOCKED**：

- **外部 MCP 正向联通未实测**：本轮仅验证登记校验与失败路径；没有可用的公网 HTTPS MCP 实例，未完成 `discover → approve → broker call` 的正向 live trace。单测覆盖了 v2 client 对本地 SDK server 的 legacy 发现/调用，以及 broker 的 fake client 正向/拒绝路径，但不能替代实网。
- **OMP 真实模型链路未跑**：本轮使用 mock lead 验证平台装配、目录、dispatch、绑定与克隆；未调用真实 OMP 模型完成自然语言作业。因此不能宣称“Prefab 指导下的完整 OMP 自主作业”通过。
- **Project 任务实例快照仅单测**：`createTaskInstanceChannel` 复制 binding/返回快照有单测；本轮未创建真实 Project work item 跑派发/重试。
- **UI 仅 API/结构验证**：Settings 三个新页签/编辑器的构建与 typecheck 通过；本轮未做浏览器点击验收。
- **Mimosa**：本轮未完成完整扫描（历史 `scanner_enobufs`）；不宣称安全通过。
- 模拟器/软件证据不是物理 HIL、现场准入或生产批准。

## 4. 观察与说明

1. 未选 `dcw_control` 的拒绝文案来自既有通用频道工业门（“通用频道不开放产线工业工具”），发生在 Prefab 门之前；仍是平台拒绝且零副作用，但测试应接受平台既有拒绝语义，而不是只匹配 `FORBIDDEN`。
2. `activate_skill` 在 Skill 被停用后返回“工具不在当前 AgentPrefab 能力范围”，说明 resolve 在调用时重新计算了 skillIds，而不是依赖目录缓存。
3. 构建发现并修复了 zod 3 直依赖与 MCP client 传递 zod 4 导致的 standalone 产物入口缺失；post-build 现在用直依赖覆盖产物根，MCP client 的嵌套副本保留。
4. 首管理员注册后自助注册关闭；验收脚本应使用一次性干净 home 或登录既有管理员，不能重复注册。
