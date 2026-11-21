# AgentPrefab、Skills 与外部 MCP 能力装配设计

**日期：** 2026-11-21  
**研究基线：** 本地已检出的 `main@1ae080e17c30e891ddae54fa26629e485492ffdf`；远端 `main@6a53b5a25ba3f609dcc881f2fb3c334fde6b8599` 经 GitHub compare 核实仅多 TSA5 工作流、脚本和证据，未改应用运行时。  
**范围：** 系统设置中的 Skills/MCP 管理、外部 MCP 工具受管调用、可复用且版本化的 Agent 预制件，以及 Channel/会话/Project 运行时的可追溯装配。  
**状态：** 调研与设计，尚未实施；本文件不授权安装依赖、迁移数据、改动生产配置、发布、部署或物理产线操作。

## 1. 目标与判断

用户希望把 Agent 的运行配置、角色/场景指令、可自定义提示词插槽和工具/Skills/MCP 能力组合成可复用专家配置，并在 Channel 成员作业时装配。该方向可行，但“看到能力”“有权调用能力”和“当前 harness 实际可执行能力”必须分开；把完整 MCP 原配置或任意 shell 命令直接复制给 harness 不满足现有平台的角色、Channel、Project、HITL 和工业权限边界。

推荐实施顺序：先补已有 MCP HTTP 入口的主体/范围授权差异；再实现系统级 Skills 管理和仅限审核、受控只读工具的外部 MCP 出站代理；之后实现 AgentPrefab 草稿/发布版本和 Channel 成员绑定；最后才把固定版本装配进 runtime、克隆和 Project 任务实例。所有新能力经单一有效能力解析和调用时二次授权；AgentPrefab 只缩小能力范围，不授予平台或工业权限。

## 2. 事实与证据边界

### 2.1 现有源码

- Agent 模板是放置时复制配置的模板，不是每次执行都会查询的 runtime preset；`templateId` 主要是来源信息。成员实际配置经 `wireMember` 形成 `AgentRuntime` 的 harness 实例。参考 [`admin-agents.ts`](../../../server/services/workshop/runtime/manager/admin-agents.ts)、[`runtime-wiring.ts`](../../../server/services/workshop/runtime/manager/runtime-wiring.ts) 与 [`agent-interface.ts`](../../../server/services/workshop/agents/agent-interface.ts)。
- 手动会话克隆和 Project 任务 Channel 会复制成员配置并产生新成员身份；克隆可能没有原始模板 ID，Project 重试可能重用旧实例。因此只把 prefab ID 放在 Agent 模板或 Channel 模板中不足以重建运行语义。参考 [`session-clone.ts`](../../../server/services/workshop/agents/session-clone.ts)、[`task-channel.ts`](../../../server/services/workshop/agents/task-channel.ts) 与 [`projects/service.ts`](../../../server/services/workshop/projects/service.ts)。
- Channel 已有 Channel 级工具策略；host-tool bridge 分别装配工具目录、按 Agent/harness 注入和在 dispatch 时验证。尚无通用的每成员 AgentPrefab 工具策略。目录过滤不是调用授权。参考 [`catalog.ts`](../../../server/services/workshop/agents/host-tool-bridge/catalog.ts)、[`per-agent.ts`](../../../server/services/workshop/agents/host-tool-bridge/per-agent.ts)、[`dispatch.ts`](../../../server/services/workshop/agents/host-tool-bridge/dispatch.ts) 及 [`channel-template.repo.ts`](../../../server/services/workshop/db/channel-template.repo.ts)。
- 仓库中有符合 Agent Skills 形态的文档和镜像，但没有完整的生产级 Skill 发现、受管导入、按 Agent 分配和激活链。已有 acceptance Skill 是作业 runbook，不是运行时自动加载证明。独立构建的运行时也需要显式包含内置 Skill 资产。参考 [`scripts/test-aw-skills.mjs`](../../../scripts/test-aw-skills.mjs)、[`package.json`](../../../package.json)、[`cli/core/post-build.mjs`](../../../cli/core/post-build.mjs) 和 [`nuxt.config.ts`](../../../nuxt.config.ts)。
- `/api/mcp/workshop` 是固定工具面的 MCP HTTP ingress；`server/harness/aw-mcp-bridge.mjs` 则将 AgentWorkShop 工具通过 stdio 暴露给 harness；`aw mcp` 是供人类 CLI 使用的另一条适配器。未发现通用生产级上游 MCP client/broker、MCP server 管理目录或外部服务工具目录。参考 [`server/api/mcp/workshop.ts`](../../../server/api/mcp/workshop.ts)、[`server/mcp/workshop-server.ts`](../../../server/mcp/workshop-server.ts)、[`server/harness/aw-mcp-bridge.mjs`](../../../server/harness/aw-mcp-bridge.mjs) 与 [`mcp/aw-mcp-server.mjs`](../../../mcp/aw-mcp-server.mjs)。
- 静态复核发现现有 MCP HTTP ingress 的身份与资源范围校验需在接入新外部工具前单独加固：会话没有明确绑定请求主体；部分 device 读/绑定路径没有与其他管理入口一致的资源范围检查；一处 Agent token 解析路径未体现与 harness bridge 相同的 enabled 检查。此项是代码审查发现，未在本次调研中运行复现测试。对应位置为 [`server/api/mcp/workshop.ts`](../../../server/api/mcp/workshop.ts) 与 [`server/mcp/workshop-server.ts`](../../../server/mcp/workshop-server.ts)。
- 系统设置采用专门的懒加载 pane；读设置为 admin/editor，变更为 admin 并审计。受管写目录应通过 [`shared/config/home.mjs`](../../../shared/config/home.mjs) 的 `resolveRunMode().configRoot`，而非引擎工作目录、包目录或 `AW_DATA_DIR`。

### 2.2 近期实测能证明什么

- PR #250 的隔离实例实测证明插件注册工具可进入 AgentWorkShop 工具目录，并观察到 lead/worker 工具面差异；它没有证明接入了外部 MCP 服务、完成了真实 MES 调用，或覆盖了所有 harness 的 native 工具调用。
- TSA3–TSA5 证明了若干 Channel、模拟产线治理、Project 工作项、Skill 驱动的人工/工具工作流和工具过滤路径。它们没有证明 AgentPrefab 存在、外部 MCP client 已可用或运行时能按成员独立开关 Skills。
- TSA5 的脚本化跨频道探针记录 `401` 且没有送达；报告另记一项有机协作观察，二者不得合并当作脚本往返通过。TSA4 的回执有人工补采。
- TSA5 落地页单项记录为 `COMPLETED+reviewed`，但持久摘要截断在 8000 字符，不能据此证明完整产物可取回；项目交付物状态仍为 `planned`。工业快检 2 次 `ROOT_TIMEOUT`，AML 训练路径仍为 `PARTIAL/NOT_COMPLETED`。这些是历史验收边界，不是 AgentPrefab 回归通过。
- 上述验收使用模拟孪生，不代表物理 HIL、现场准入、生产投用或 Mimosa 安全通过。

证据参考：[PR #250 live proof](https://github.com/kingdol666/AgentWorkShop/blob/012a1be8/docs/audit/evidence/2026-11-20-plugin-tool-integration/live-proof.json)、[TSA4 报告](https://github.com/kingdol666/AgentWorkShop/blob/1ae080e1/docs/audit/evidence/2026-11-20-tsa4-v0140-round/REPORT.md)、[TSA5 报告](https://github.com/kingdol666/AgentWorkShop/blob/6a53b5a25ba3f609dcc881f2fb3c334fde6b8599/docs/audit/evidence/2026-11-21-tsa5-v0140-round/REPORT.md)、[TSA5 findings](https://github.com/kingdol666/AgentWorkShop/blob/6a53b5a25ba3f609dcc881f2fb3c334fde6b8599/docs/audit/evidence/2026-11-21-tsa5-v0140-round/FINDINGS-tsa5.json)。TSA5 报告是远端 `main@6a53b5a2` 的已合并文档证据；被测构建是 `1ae080e1`，不可描述成在 `6a53b5a2` 上重跑。

## 3. 标准与兼容性

### 3.1 Agent Skills

依据 [Agent Skills specification](https://agentskills.io/specification)，Skill 是含 `SKILL.md` 的目录；名称/描述来自 YAML frontmatter；相对引用相对于 Skill 根；可含 `scripts/`、`references/`、`assets/`；推荐 progressive disclosure：初始仅名称/描述，激活后读取正文，需要时再读取资源。`allowed-tools` 是实验性声明，不能被 AgentWorkShop 当成工具授权。

规范不定义全局安装目录。调研的 `npx skills`/多客户端目录包括 `~/.agents/skills`、`$XDG_CONFIG_HOME/agents/skills`（默认 `~/.config/agents/skills`）以及特定客户端目录；`~/.agent/skills` 作为用户要求的兼容目录显式支持，但不是通用规范路径。本机只检查目录是否存在：`~/.agents/skills` 存在，`~/.agent/skills` 与默认 XDG 目录不存在；本次没有列举或读取用户 Skill 内容。远程部署时这些路径指服务进程账号而非网页终端用户。

### 3.2 MCP

依据 [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)，当前协议版本为 `2026-07-28`，使用逐请求 `_meta` 和 `server/discover`；旧版 `2025-11-25` 及更早版本采用 `initialize` 握手。工具通过 `tools/list`/`tools/call` 发现与调用；列表可分页/变化。名称在单个 server 内唯一，跨 server 聚合需稳定命名空间；工具 schema/注解/`readOnlyHint` 均不能替代管理审查和平台授权。

官方 TypeScript MCP client v2 已分包；调研时 npm `@modelcontextprotocol/client` 最新为 `2.4.0`、Node 要求 `>=20`，符合本仓库 `>=23.4.0`。v2 连接默认使用 legacy 模式；`versionNegotiation: { mode: 'auto' }` 才显式执行 modern probe 并兼容 legacy。实现前锁定依赖并验证所选版本/传输行为；保留现有 `@modelcontextprotocol/sdk` server 接口，client/server 包拆分与测试通过前不做无关迁移。

MCP 标准不规定 AgentWorkShop 的配置目录布局。官方 Registry 是公开 server 元数据/下游聚合生态，不要求运行时直接依赖 Registry，也不取代本机受管清单。本设计因此只定义产品自己的配置契约。

## 4. 设计目标、非目标与不变量

### 目标

1. 用户能在系统设置查看可发现 Skill 与 MCP server、审阅来源/版本/诊断、把内容导入受管存储，并显式启用/停用。
2. 管理员可登记受管 MCP Streamable HTTP server，发现并审阅工具 schema；Agent 只通过共享 host-tool dispatch 调用审核启用的工具。
3. 用户可创建 AgentPrefab 草稿，包括 Agent profile/受支持模型配置、角色/场景和多维提示词插槽、明确列出的平台/插件/Skill/MCP 工具能力；发布为不可变 revision。
4. Channel 成员绑定明确的 prefab revision；成员可填 prefab 明确允许覆盖的插槽；runtime、Session clone 和 Project task clone/retry 都可记录同一来源 revision 和覆盖值。
5. 能力目录和工具注入只展示有效能力的交集；每次执行重新授权。禁用、撤销、Agent 停用、Channel 规则、Project scope、角色约束、高危写和 HITL 门仍为权威。
6. 更新期间不强停忙碌 harness；配置状态、已装配 revision、何时生效/等待状态可分别观察；缺失必需能力 fail closed。
7. 旧成员没有 prefab binding 时行为不变；启动迁移为 additive 且不需历史行回填权限。

### 非目标

- 不替代现有插件系统、Harness MCP stdio bridge、工具注册/dispatch、Channel/Project 角色规则或工业审批/设备安全闸。
- 第一版不支持任意 stdio/命令启动 MCP server，不执行外部 Skill 的脚本，不隐式安装 npm 包或从 Registry 自动运行代码。
- 第一版不做 OAuth 浏览器流程、MCP resources/prompts/sampling/elicitation、远程 Marketplace、自主 Skill 生成或自动晋升。
- 不宣称一次设置开关即可关闭所有 harness native、本地用户级工具/Skill；按真实 harness 能力声明受管范围。首个 runtime E2E 以 OMP 受管路径证明端到端，其他 adapter 逐一做 capability contract，不能将未验证 harness 标成已支持。
- 不启用外部 MCP 产线写工具；模拟器作业也不等于物理 HIL。

### 不变量

- **无授权提升：** prefab 能力是系统允许 × 当前用户/成员身份 × Channel/Project 策略 × 工具角色 × prefab allowlist × harness 受管能力的交集。
- **双层决策：** 服务端目录过滤仅为体验；调用时在共享 dispatch/broker 上再次验证 agent 身份、enabled 状态、调用来源、Channel/Project 范围和当前授权。撤销不能依赖推送刷新完成。
- **版本可追溯：** 发布 revision 不原地修改；成员绑定 `(prefabId, revision, slotValues)`；作业/克隆快照记录 binding hash；克隆不重新解析“最新版”。权限/禁用策略不锁版本，撤销立刻拒绝下一次调用。
- **配置来源分离：** 管理员控制服务级配置与 capability registry；prefab 不含 secret values、命令行、动态代码或任意 URL；成员不能凭提示插槽覆盖系统指令、身份、工具授权或工业上下文。
- **失败可见：** 必需依赖缺失时阻止启动；可选依赖缺失时显示降级原因；禁止静默替换同名工具/Skill、静默扩权或失败后重放有副作用调用。
- **凭据与出站：** 凭据只通过环境变量或密钥服务引用解析，源码、样例、测试和持久清单不含可用凭据字面量；HTTP(S) URL/每一重定向/解析后地址做既有出站守卫，拒绝 localhost、loopback、private 和 reserved 地址；不能借本设计放宽现有 SSRF 控制。
- **工业隔离：** MCP tool 的 server 注解不是可信安全分类；任何工具初次上线都由管理员审阅其操作语义。首发准入的 MCP tools 限在明确批准的只读操作。所有生产写仍只经现有 DCW/HITL/范围/步长/回读链。

## 5. 备选方案与推荐

| 方案 | 好处 | 代价/风险 | 结论 |
|---|---|---|---|
| 每个 harness 自己发现/安装 Skill 和 MCP；prefab 复制原始客户端配置 | 初期少平台代码，利用引擎原生能力 | 配置/凭据复制；不同 adapter 语义漂移；工具调用绕过 AW dispatch；克隆和 Project 实例难审计/撤销 | 不选。不能满足集中治理和拒绝证明。 |
| 只在一个全局 runtime 安装所有 Skill/MCP，再按 prompt 要求模型自律 | 共享运行简单，组件少 | 所有成员暴露相同工具面；提示词不是权限边界；跨 Channel 泄漏；外部依赖不可追溯 | 不选。违背用户的按 Agent 专家配置。 |
| 中央受管 catalog/broker + 不可变 AgentPrefab revisions + 成员绑定 + 共享调用时授权 | 一处管理、同一 dispatch 权威、版本和 clone 可审计，可逐 Adapter 扩展 | 初始需实现目录管理、MCP client、权限回归和克隆状态 | **推荐。** 可分 PR 上线，每阶段独立可测试。 |

## 6. 系统设计

### 6.1 存储与访问面

- 解析配置根只使用 `resolveRunMode().configRoot`。
- 内置 Skills 随 npm/standalone build 作为只读资产发布；外部 roots 只读发现，默认包括用户要求的 `~/.agent/skills`、通用 `~/.agents/skills`、XDG `agents/skills` 和显式配置的客户端 roots。canonical/realpath 去重，记录来源和冲突；不递归扫描整个 home，不执行 Skill 代码。
- 受管导入副本存 `<configRoot>/skills/<skill-id>/<content-hash>/`，校验 frontmatter、根目录名称、相对引用及文件大小/数量边界；拒绝 symlink escape、路径穿越、损坏 YAML 和重复未审阅版本。原始脚本只作为静态文件，不在扫描/导入/激活时运行。版本/hash 固定且可回滚。
- MCP server manifest 存 `<configRoot>/mcp/servers/<server-id>.json`，只含 server 身份、HTTPS endpoint、启用状态、protocol/transport、allowlisted credential reference 与 generation、已审阅的工具 schema hash/分类和管理员审计元数据，不含 secret value。以原子写入保存；catalog cache/last-check/health 可重建。
- AgentPrefab 定义和 immutable revision 存 Workshop SQLite，由 schema/migration ledger 管理；revision snapshot 含 profile ref、prompt slots、capability refs/hashes、required/optional flags、支持的 adapter contract 和 hash。Channel member binding 显式存于 AgentInfo/`channel_agents` 字段，不混进自由格式 harness `config_json`；所有通道模板的成员引用也保留 prefab binding/value；不存凭据。
- Settings 提供 Skills 与 MCP 两个一方 pane 区段（可用同一个 pane），受管内容的 list/detail/check/import/enable/disable/delete/publish 操作均经过受权限保护的 API，写入按系统管理审计规则记录。

### 6.2 技能发现与运行时激活

- 解析器将 Skill 映射成 `{id, name, description, source, sourcePath, contentHash, compatibility, diagnostics}`；源是 built-in、managed、global-discovered 或 configured-root。目录列表先只加载 metadata，显示 malformed/conflict/incompatible，而非隐式执行或覆盖。
- 导入是显式动作，产生受管不可变 snapshot；更新产生新版本，旧版本仍可供已固定的作业使用，除非管理员撤销它。
- 有效能力解析从 binding 指定的 Skill revision 形成渐进式目录（name+description），Agent 显式激活后由 `skill_activate` 返回 frontmatter/body 和根路径；相对资源仍需通过受控资源读取能力按需读取。不得直接将不可信 Markdown 提升为 platform/system prompt；明确包裹为低信任 Skill content。首个 E2E 可先验证 OMP；其他 harness 是否以 host tool 或原生路径交付由 adapter contract 声明。
- Skill 安装不自动授权它提到的工具；`allowed-tools` 无权限效果。激活重复、被撤销、路径失效、超限或路径穿越都必须有确定诊断和拒绝结果。

### 6.3 MCP 出站目录和调用

- 外部服务仅支持 Streamable HTTP；管理员登记/更新 endpoint，平台 broker 做 client connect/discovery/list 分页/schema 校验和审计。首发只发布人工 review 并标注为只读的 tools；trusted `readOnlyHint` 不替代该审查。
- 锁定已核验可用的 MCP client 版本；对当前 modern `2026-07-28` 使用显式 `mode: 'auto'` 验证 server/discover，同时覆盖 legacy `2025-11-25` handshake server。版本协商、重定向、断线、分页、超时、动态工具变化按测试结论记录；列表通知触发重新发现及重新审核，不自动改写已发布 revision 的 schema。
- 统一工具外部名为稳定的 `mcp_<serverId>_<toolName>`，serverId/toolName 规范化和截断后仍需碰撞检查；保留上游原名作为审计字段。schema 应校验为 JSON Schema object，MCP 内容类型和结果大小设限；结果转换/净化后再送模型。上游 tool `annotations` 全部视为不可信。
- 调用经 `mcpBroker.call(agentIdentity, toolId, args, trustedExecutionContext)` 进入既有 dispatch 权威；在网络前验证管理员 server 状态、当前上游 schema hash、成员身份/enabled、prefab binding allowlist、Channel/Project role/scope 和工具 review status。只有通过才访问上游。记账发起 Agent、server/tool/schema 版本、参数脱敏摘要、时长、结果/错误分类和 request ID；不记 secret、不无限记录响应。
- Credentials 用 secret resolver 从允许的 environment/secret store 取值。API/UI 仅提交引用键，不回传解密值。custom fetch 实现 URL/IP/redirect policy；DNS 解析与连接目标绑定，重定向和重新解析每跳都校验；无可证明的统一限制时 fail closed。不得把普通 Agent 的 tool arguments 解释为 HTTP URL/header/command。
- 所有旧 MCP ingress/bridge/human CLI 都做入口权限矩阵回归。新 broker 是额外一条出站执行路径，不宣称自动修复/取代已有 ingress；先修复请求主体、token enabled 与资源范围验证差异，再允许 MCP 工具入 Agent catalog。

### 6.4 AgentPrefab 和成员运行时

- API/表/类型名统一 `AgentPrefab`。草稿保存名称、描述、所有者/可见性、Agent harness profile/model 引用（使用已支持/受约束 profile，不把 shell env 混为 profile）、有序 slot schema 和能力 refs。每个 slot 有稳定 key、标题/说明、默认值、是否必填、长度上限和是否允许成员覆盖；只有发布时解析变量及检查覆盖策略，不支持任意模板代码。
- 发布创建不可变 revision：`{prefabId, revision, snapshot, contentHash, createdAt, createdBy}`。相同的受众/能力变更需要新 revision，不覆盖历史。绑定同时存版本、slot values 及 source hash。用户/Channel 只可见并绑定自己有权限使用的 prefab；system MCP capability 只由管理员管理。
- 选择/可用 capability ref 精确到来源 ID 和版本（builtin/plugin registry item、Skill version hash、MCP server ID/tool name/schema hash）。发布校验所有引用。发布后不会随着新的 registry 项目自动扩权；撤销或禁用可使 pinned 项目 fail closed。
- 配置解析器的建议签名：`resolveAgentCapabilitySet(input: AgentCapabilityInput): AgentCapabilityResolution`；解析结果按稳定 ID/hash 排序，列出 active、disabled、missing、denied、unsupported，以及原因；同一结果用于 UI preview、Agent tool catalog 和 invoke guard。
- 成员 binding 增加为 `AgentInfo.prefabBinding: AgentPrefabBinding | null`，存储层向旧行读取为 `null`。placement、内联 lead 建立、Channel template capture/instantiate、manual session clone、Project task Channel create/retry 均显式复制 binding 和 slotValues；克隆只改变身份/credential，不改 pinned revision，不复制秘密。
- `wireMember` 在 implFactory 前解析出一个 validated effective config，不在多个 adapter 各自解读 binding。配置快照同时进入 `AgentRuntime` 权威身份/调用上下文；adapter 只得到其能力子集。共享 host tool catalog 和 dispatch 用相同 resolution，不能发生“目录无工具但旧缓存仍能调用”。
- 配置变化默认等待当前运行安全边界后生效；不 force stop busy task/approval/hitl。区分 `desiredBinding` 与 `activeBinding` 状态/版本，显示待生效。管理员撤销、成员停用和 scope 丢失立即由调用时检查阻断下一次网络请求，工具/Skill catalog refresh 不成为撤销前提。`required` 缺失时阻止开始新的作业并给出可行动原因；在途任务按已有取消/HITL 语义处理。
- Prompt 以结构化分区拼装：既有平台/安全与工业约束不变；受信任运行上下文保留；角色 prompt、场景 prompt、slot values 按固定顺序作为低信任业务指导；当前任务位于最后。新增独立 prefab prompt/config key，不覆盖 `systemPromptPrefix`、Channel `scenarioPrompt` 或 AML `composeChannelSystemPrompt`。slot value 不可写到工具/授权或身份状态。

## 7. 施工切分与依赖

本需求涵盖四个可独立审查的子系统：既有 MCP ingress 权限收敛、Skills catalog/store、外部 MCP broker、AgentPrefab/runtime bindings。整体执行计划要求先出可独立合并的 MCP authorization hardening；随后分别完成功能底座，只有 broker 与 resolver 稳定后才装配 prefab runtime。分 PR 和逐任务验收见配套 [Implementation Plan](../plans/2026-11-21-agent-prefab-skills-mcp.md)。

| 子系统 | 交付门 | 对后续依赖 |
|---|---|---|
| 0. MCP ingress authorization | 主体绑定/启用状态/资源范围闭合，未授权操作无副作用 | external broker 开放给 Agent 前必须通过 |
| 1. Skill registry/store/Settings | 标准解析、安全发现、审核导入、版本撤销、审计 | prefab 能引用受管 Skill revision |
| 2. MCP server registry/broker/Settings | 受控连接、tools discovery、只读审查、共享 dispatch、调用时拒绝 | prefab 能引用受管 MCP tool/schema revision |
| 3. Prefab revision/member binding | 草稿、发布、slot schema、版本、Channel grant/member/template 持久化 | runtime resolver 消费稳定 binding |
| 4. Runtime effective resolution | 单一目录和 invoke source、平台 prompt/tool activate、Session/Project 快照与 retry/revoke 行为 | full E2E |
| 5. Integration acceptance | clean home + simulator/tool mock + ordinary Project;真实请求 trace 及拒绝 trace | release decision and docs |

### 7.1 首发能力依赖关系

- **Task instance 与 retry snapshot：** `channel_sessions` 已有工业 `binding_snapshot_json/hash/revision`，Project `project_work_items` 保存 `instance_channel_id` 且 `project_work_item_attempts` 保存 attempt lineage。实现 AgentPrefab snapshot 应复用 Session 溯源语义，并在 work item/首次实例建立时写入 AgentPrefab 的 `binding_snapshot_json/hash/revision`，后续 retry 使用它。历史行默认空；不可用旧 template_id 或当前 Channel 配置回填权限。
- **Harness profile：** `HarnessProfile` 现有对象是 Channel experience/prompt overlay，不是成员 harness/model profile；AgentPrefab 不引用它作为 engine profile，不改 adapter 身份。首次只对成员当前 harness 的明确 allowlisted model/runtime fields 生效。
- **OMP trust：** OMP 在服务进程同身份下执行，当前配置会给 harness 一部分 AW bridge credentials 以调用平台工具。MCP 上游秘密只留 broker，不放入此配置/环境；但既有 Agent token 和本地文件访问范围不属于本功能可隔离的 OS 沙箱承诺。
- **纯共享数据：** `read-only` 只表示工具语义不改上游，不代表数据对所有 Channel 成员公开。首发 MCP 只发布管理员验证的 shared-data read；不得从模型参数传入 Project/tenant 身份来推导访问。


## 8. 验收契约

验收对每个必要层分别给出 `PASS`、`PARTIAL`、`BLOCKED`、`NOT_RUN`。HTTP 200 本身不证明业务通过；负例需要断言 response body 与 side-effect count；脚本/Skill check 的文件存在检查不能替代运行行为验证。

1. **Install/Settings:** 从源码与打包运行时分别发现内置 assets；对 configurable/global roots 同名、无效 frontmatter、重复、symlink/traversal、大小限制有诊断；路径不跨 root；未授权读取/写入拒绝；导入不执行脚本；禁用/删除记录审计。
2. **Skill progressive delivery:** 两名成员只分配一名可见已选择 Skill；初始 prompt 只含 metadata；激活返回预期版本 hash 的正文；相对 reference 读取位于同一受管 root；未绑定、撤销、unsupported harness 时拒绝且不泄漏另一成员内容；工具权限不因 Skill 文本改变。
3. **MCP compatibility:** 随机本地假服务覆盖 modern/legacy connect、server discovery、分页、工具列表 hash、schema 缺陷、通知后待审状态、超时/断线、重定向、DNS/IP/rebind guards、secret ref 未落盘。现代 `2026-07-28` 和 legacy `2025-11-25` 均有证据。测试凭据全是非凭证占位值，且不进入 artifacts/logs。
4. **MCP authorization:** 开启且已审工具正例调用；成员未绑定、工具未审批/已禁、server 已停、Agent disabled、token 过期、角色/Channel/Project 越权、旧目录缓存和 MCP ingress 无主体等负例，所有拒绝需断言 upstream `hitCount=0`。两成员来自同一 prefab 但权限不同，禁止者调用必须拒绝。
5. **Prefab lifecycle:** 编辑草稿不变更已发布版本；发布 hash 稳定；两个成员绑定不同 pinned revisions/slot values 能并行存在；越权引用、并发 CAS 冲突和非法 slot 被拒；旧 Agent/Channel 读取无绑定并行为不变；clear/unbind 有明确 API 语义。
6. **Clone/restart:** Channel template capture/instantiate、manual session clone、Project task instance 和同项重试分别断言 binding/version/slot/hash；新 Agent token/identity 与原成员不同；重启恢复 active binding；Project clone 不重新读“最新版”。
7. **Runtime effective behavior:** 实际 OMP Agent 对指定任务先看到 Skill metadata、按需激活并读一个资源，调用已分配 read MCP tool；worker 不具备的 direct invoke 经共享 dispatch 被拒，upstream hit count 为零；更改角色/Channel policy 后调用仍受现权威限制；能力不可用时 required fail start、optional 显示降级。
8. **Safe rollout:** busy/HITL/queued work 时普通 revision 更新不强停且可见等待；revoke/disabled 下一次 call 阻断，旧 cached catalog 不可绕过；没有自动重放上游副作用；日志 redaction/secret scan 和超时有覆盖。
9. **Whole-main gates:** 每个 PR 跑 focused RED→GREEN + typecheck/lint/相关 tests；合并后全量 `pnpm test:unit`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test:mcp`、`pnpm test:skills`、`pnpm docs:check`、`pnpm i18n:check`、`pnpm check:cssvars`、`pnpm frontend-lifecycle-contract`。新 Skills 目录校验、managed package smoke 和 MCP mock E2E 都必须有独立命令与报告。后续隔离实例跑完两种小任务，并从运行 trace、上游 hit journal、完整 artifact hash 和 Review state 提交证据。Mimosa 若 inconclusive 只能如实标注，不能宣告“全绿/安全通过”。
10. **工业边界：** 本次真实作业阶段仅使用影子孪生，复用既有读/审批写保护；不因 MCP/Prefab 另开产线写工具，不连接物理 PLC，不宣称 HIL/现场准入/生产批准。

## 9. 实施前开放项

以下按平台当前“单系统配置根 + user-owned templates + admin-managed system settings”的形态作为本设计默认，而不阻塞写计划；实现 PR 开始前需在设计评审中复核：

- 用户身份映射的 public/private prefab 可见性采用 Agent/Channel template 既有规则；系统级 MCP/Skill catalog 写操作只有 admin；只读管理面 admin/editor。
- 第一版 MCP 范围限预配置身份与管理员提供的 credential reference。OAuth UI、stdio subprocess 与私有网络目标不属于第一版。
- 第一版先保证 OMP 的端到端 Skill/tool capability contract；每个其他 harness 在 capability registry 中清晰标明受管能力和不支持项。
- 仅初始化管理员审核为只读的 MCP tool。将来开放副作用工具必须独立权限/approval设计与明确重新授权，不能依赖 MCP 注解。

- **外部数据边界（保守默认）：** 第一版 MCP 仅允许在管理员配置的服务身份下访问、且经审阅可由所有获准绑定成员安全共享的数据。凡是上游授权会隐含更广用户权限、结果可能跨 Project 泄露、或不能证明目标数据公开/共有时，不发布给 Agent；首版不将 caller 身份假扮为上游个人身份。未来要访问私有或项目级数据时须新增 caller→上游 principal 映射、参数与结果 scope enforcement 设计及独立验收。
- **旧调用入口一致性：** prefab deny 必须覆盖语义相同的 Agent-authenticated AW MCP HTTP、Agent REST/tool bridge 和内部 native invoke 入口；以工具/操作 capability ID 建立跨入口映射。若一个旧入口无法挂接相同授权检查，则禁止该入口暴露这类操作或该 prefab 能力不支持绑定。必要的 mailbox/task 协作面按平台基础能力列出，并继续应用原有 Channel/Project 作用域，不从 prefab 自由扩权。
- **本地 Harness 信任：** 首发假设 OMP 是 AgentWorkShop 同一受信任服务账户下的本地子进程。受管 MCP credentials 和 Skill 通过平台 broker/host tool 提供，不放入 OMP config、环境或文件；但这不构成 OS/filesystem sandbox，也不防恶意/已失陷的 harness 获取进程同权限可读文件或环境。需由部署隔离服务账号/容器/权限实现更强对抗边界，不在本功能中虚称隔离。
- **模板/Channel 授权传递（保守默认）：** 成员绑定检查创建者对 prefab 的使用权并记录 `grantedBy` 和 Channel ID。成功绑定授予该 Channel 及其 Session/Project task clones 持续使用该 pinned revision 的权利（不授予编辑权）。私有 prefab 不得被 public Channel template 间接引用；模板公开或跨 owner 转移时必须验证所有引用皆 public/system，或移除绑定。所有者/管理员撤销引用时，后续 activation/invoke fail closed，并向绑定 Channel 给出影响诊断。
- **MCP 审核失效条件（保守默认）：** 工具批准绑定 `(serverId, canonical endpoint identity, credential principal/reference generation, protocol/transport, upstream tool name, schema hash)`。endpoint/server identity 或 credential principal 改变、tool/schema 变化、超出最大 discovery staleness，均将相关工具置为 pending-review，立即不再调用，旧 prefab revision 显示失效，不自动迁移或重批。无 server notification 的情况下在每次管理页检查连接/调用前 refresh，且启用有限 `maxDiscoveryAge`；具体初始值由实现结合缓存和可用性测试确定并写入 manifest/UI。
- **Agent profile 范围（保守默认）：** AgentPrefab 不切换 harness；它绑定当前成员已有 harness，并只覆盖该 adapter 明确支持且可校验的 provider/model/effort/runtime settings allowlist。对已绑定 prefab 的成员，published prefab 的明确 profile 值优先于旧 member config；成员只有在对应 slot 明确允许覆盖时才能 override。未在 prefab profile 中给出的旧 member config 保留。不能通过任意 command/args/env/extension 字段切换引擎或执行代码；不支持/冲突必须提示而非静默回落。
- **作业何时固定版本（保守默认）：** Session 成员在 Session 创建时固定 prefab revision、slot values 和 content hash。Project 的 task-instance channel 在创建时捕获并固定此快照；针对同一 work item 的重试复用已保存在 work-item/task-instance 谱系中的初始 binding snapshot，不能重新读取 Channel 的最新 binding。新 work item 建立新 instance 时可读取当时 Channel binding。每次开始/续跑仍检查 binding snapshot 当前未被撤销、required dependencies 仍有效；缺失/撤销则阻止新执行。普通 Channel 成员新配置只影响之后创建的 Session/Project task instance。
- **提示层优先级（保守默认）：** 既有 platform/safety 指令和可信身份/Project/工业上下文不可被覆盖；现有 Channel `scenarioPrompt` 保留最高优先级的业务规则；其后按固定顺序注入 prefab 角色提示、prefab 场景提示、已允许覆盖的 slot values；当前用户/任务输入最后。Skills 仅按需包裹注入，不转成 system 指令。未绑定 prefab 的 prompt byte behavior 不变。

这些是系统范围或安全边界的有意缩小；若负责人在审批设计文档时不同意，应在实施前更新规格与计划。除最后列明的保守默认，服务身份 MCP 的数据共享范围、旧入口等价操作映射、OMP trust boundary 和授权传递均以本节建议为准，不能误读为已由用户确认。
