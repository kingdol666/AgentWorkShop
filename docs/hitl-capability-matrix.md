# HITL 能力矩阵(原生 ask / approval)

- 日期:2026-09-22｜归属:Worker E(HITL/Harness)｜依据:主计划 §8、§13.4、§13.5
- 代码事实源:`server/services/workshop/agents/hitl-capabilities.ts`(`hitlCapabilityMatrix()`)
- 现场打印:`npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-hitl-decision.ts`(第 11 节输出本环境实测矩阵)

> 运行提示(仓库既有问题,非本轮引入):`npx tsx scripts/<x>.ts` 直接跑会因 `server/services/workshop/settings.ts`
> 里的 `@/shared/config/home.mjs` 别名无法解析而 `ERR_MODULE_NOT_FOUND`;脚本必须带
> `--tsconfig .nuxt/tsconfig.server.json`(与 `scripts/test-hitl-registry.ts` 现状一致)。

## 1. 状态口径(不可混淆)

| 状态 | 含义 | 判定依据 |
| --- | --- | --- |
| `PASS` | 声明 HITL **且** 引擎已安装 **且** 有本环境真实原生契约验证记录 | `markHarnessHitlVerified()` 写入的 `verified.ok === true`(未安装引擎调用该函数会直接抛错,杜绝伪造) |
| `FAIL` | 有验证记录但真实契约失败(引擎拒绝/协议不符) | `verified.ok === false` |
| `BLOCKED` | 声明 HITL,但引擎未安装,或已安装却**未在本环境真实触发**原生 ask/approval | `checkHarnessAvailability()` + 无 `verified` 记录 |
| `UNSUPPORTED` | 引擎**无原生 HITL 通道**(能力全 false) | 适配器无 `register/resolve` 调用点(静态证据 file:line) |

要点:HTTP 200、mock 结果、UI 卡片**都不构成 PASS**;"不支持结构化提问"的引擎只能是 `UNSUPPORTED`。

## 2. 矩阵(本机实测,2026-09-22)

`installed-detected` = `checkHarnessAvailability()` 的 PATH 探测结果(仅证明可执行文件在 PATH,**不等于**原生 HITL 契约可用);
本机 12 个 CLI 全部探测到(见 §4 备注),因此"声明 HITL"的引擎状态均为 `BLOCKED`(差**真实触发**这一条)。

| harness | providerKind | approval | question | multiQuestion | structuredResponse | cancel | installed-detect | 状态 | evidence(file:line) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| omp | `omp-dialog` | ✅ | ✅ | ❌ | ❌ | ✅ | 是(`omp.exe`) | **BLOCKED**(未真实触发) | `harness-terminal.ts:273` 登记 / `:624` 应答落定 / `:416` 撤销 |
| codex | `codex-approval` | ✅ | ✅ | ✅ | ✅ | ✅ | 是(`codex.ps1`) | **BLOCKED**(未真实触发) | `codex-agent.ts:545` 审批登记 / `:585` 提问登记(全量 questions) / `:625` `respond(rpcId,{answers})` / `:202` 路由 |
| opencode | `opencode-permission` | ✅ | ✅ | ✅ | ✅ | ✅ | 是(`opencode.ps1`) | **BLOCKED**(未真实触发) | `opencode-agent.ts:703` permission.asked / `:708` question.asked / `:241` `POST /question/:id/reply\|reject`、`POST /session/:id/permissions` |
| dsh | `dsh-permission` | ✅ | ❌ | ❌ | ✅ | ✅ | 是(`dsh.ps1`) | **BLOCKED**(未真实触发) | `dsh-agent.ts:552` 登记 / `:162` ACP `selected{optionId}`/`cancelled` |
| claude | `claude-permission` | ✅ | ❌ | ❌ | ❌ | ✅ | 进程内(SDK) | **BLOCKED**(未真实触发) | `claude-agent.ts:543` `canUseTool` 登记 / `:167` PermissionVerdict allow/deny |
| qwen | `qwen-permission` | ✅ | ❌ | ❌ | ❌ | ✅ | 是(`qwen.ps1`) | **BLOCKED**(未真实触发) | `qwen-agent.ts:523` 登记 / `:182` allow/reject/cancelled |
| hermes | `hermes-permission` | ✅ | ❌ | ❌ | ✅ | ✅ | 是(`hermes.exe`) | **BLOCKED**(未真实触发) | `hermes-agent.ts:508` 登记 / `:143` `selected{optionId}`/`cancelled` |
| dcw | `dcw-approval` | ✅ | ❌ | ❌ | ❌ | ✅ | 进程内(平台机制) | **BLOCKED**(未真实触发) | `tool-approvals.ts:63` 登记 / `:88` decide / `:112` cancelPendingFor |
| gemini | — | ❌ | ❌ | ❌ | ❌ | ❌ | 是(`gemini.ps1`) | **UNSUPPORTED** | `registry.ts` 能力声明 `hitl:false`;适配器无 HITL 调用点 |
| copilot | — | ❌ | ❌ | ❌ | ❌ | ❌ | 是(`copilot.ps1`) | **UNSUPPORTED** | 同上(`--allow-tool` 白名单制,无程序化审批) |
| cursor | — | ❌ | ❌ | ❌ | ❌ | ❌ | 是(`cursor.cmd`,注意是 IDE 可执行文件) | **UNSUPPORTED** | 同上 |
| crush | — | ❌ | ❌ | ❌ | ❌ | ❌ | 是(`crush.ps1`) | **UNSUPPORTED** | 同上 |
| goose | — | ❌ | ❌ | ❌ | ❌ | ❌ | 是(`goose.exe`) | **UNSUPPORTED** | 同上 |
| pi | — | ❌ | ❌ | ❌ | ❌ | ❌ | 是(`pi.ps1`) | **UNSUPPORTED** | 同上 |
| mock | — | ❌ | ❌ | ❌ | ❌ | ❌ | 进程内(恒可用) | **UNSUPPORTED** | `mock-agent.ts` 无 HITL;测试经 `registerHitlNativeDispatcher()` 注入 |

> `question=❌` 且带 `unsupportedReason` 的引擎(omp 除外):ACP/SDK 只有权限请求通道,自由提问不支持 —— 上层不得把"审批通过"当作"回答了问题"。
> `omp` 的 `structuredResponse=❌`:对话框应答只有 `value:string` + `confirmed/cancelled` 三件套,无结构化 `answers[]`。

## 3. 逐 harness 原生协议要点(修复项已落地)

| harness | 原生请求 | 原生应答 | 取消 | 本轮修复 |
| --- | --- | --- | --- | --- |
| codex | `item/commandExecution|fileChange/requestApproval`、`tool/requestUserInput` | 审批 `{decision: accept\|decline\|cancel}`;提问 `{answers:[{answer}]}` | `respondError(rpcId, -32800, '人工取消')` | **提问路径此前不可达**(`respondUserInput` 仅超时可达,且 `respondHitl` 恒发 `{decision}`)→ 按类型路由;`questions[]` 全量承载(此前只取第一题) |
| opencode | `permission.asked`/`permission.v2.asked`、`question.asked` | 审批 `POST /session/:id/permissions {response}`;提问逐题 `POST /question/:id/reply {answer}` | 提问逐题 `POST /question/:id/reject {}` | **显式 `reject` 此前被降级为 `once`(静默放行)** → 白名单透传 + 未知枚举抛错;`questions[]` 全量 + per-question id/options/multiSelect;逐题应答(此前只答第一题) |
| dsh / hermes | `session/request_permission` | ACP `{outcome:{outcome:'selected',optionId}}` / `cancelled` | `cancelled` | 登记补 `requestType/nativeRequestId/sessionId/harness` |
| claude | SDK `canUseTool` | `PermissionVerdict` allow/deny(超时 deny) | deny | 同上 |
| qwen | 旧版 ACP `requestToolCallConfirmation` | allow/reject | cancelled | 同上 |
| omp | `extension_ui_request` | `extension_ui_response{value|confirmed|cancelled}` | `cancelled:true` | 无(登记在 `harness-terminal.ts`,非本 worker 写入范围) |
| dcw | 工具侧 `request()` | `decide(id, approved, comment)` | `cancelPendingFor` → denied | 统一进 `claimPending` 原子闸门(`hitl-decision.ts:450`) |

## 4. BLOCKED / 未验证清单(真实原因)

1. **全部"声明 HITL"的引擎状态为 BLOCKED** —— 本机虽已探测到可执行文件,但本轮**未在真实引擎上往返一次**原生 ask/approval
   (需要真实凭据、真实子进程与真实工具越界触发;mock 结果不计 PASS)。要转为 `PASS`,须由测试方对每个引擎调用:
   `markHarnessHitlVerified('<harness>', { ok: true, evidence: '<命令 + 原生 requestId + 引擎侧恢复证据>' })`。
2. **`installed-detect` 只是 PATH 存在性探测**(与仓库既有 `checkHarnessAvailability` 同源),不校验版本与协议能力;
   `cursor` 命中的是 IDE 可执行文件 `cursor.cmd`,不代表 Cursor CLI 可用。
3. **omp-dialog 无结构化提问**:`structuredResponse=false`,`questions` 无法逐题回传(引擎协议限制)。
4. **omp 登记点不在本 worker 写入范围**(`harness-terminal.ts` 属其他 worker),其 `register()` 未显式传 `harness/sessionId`;
   持久化层用 `harnessOfKind('omp-dialog') → 'omp'` 兜底,`sessionId` 留空(重启对账按"整条失败"处理,不影响正确性)。
5. **`dsh/claude/qwen/hermes` 无提问能力**:不要在前端对其渲染 ask 表单(`supportsHitlQuestion(kind)` 返回 false)。
6. ~~WS 侧 `hitl.request` 帧的可见人群比审批资格宽~~ —— **已修复(集成方 Worker D 收口)**:
   `ws.ts` 的 `hitlAudience()` 现按**审批资格**扇出定向通知(`owner_only` → 仅 owner + admin;
   `any_member` → owner ∪ active 成员 + admin),与 `requireCanApprove` 同口径、随策略收紧即时收窄。
   `hitl.request` 仍进频道流(§6 的审计/回放轨迹),但**可操作性**另受两道闸门约束:
   REST `pending` 快照按可裁决性过滤 + `respond` 走决策服务(`requireCanApprove` + `claimPending`)。
   即"频道成员看得到轨迹" ≠ "能审批"。
7. **遗留无主 Channel 的审批口径已收紧(集成方决定,§13.2)**:`assertCanDecideHitlChannel` 原先对
   `owner=NULL` 回落 `getChannelForUser`(任意登录用户可裁决)以保持兼容 —— 这等于"任何登录用户都能
   批准无主 Channel 的高危操作"。现改为 **403 `FORBIDDEN_LEGACY_APPROVAL`,仅 admin 可裁决**,
   与 `ws.ts` 终端接入 / `requireChannelMember` 对遗留 Channel 的口径统一。属**收紧**,不违反 §0.8。
   omp 对话框(park TTL / 订阅暂停 / 撤销落定)语义未改,`scripts/test-hitl-registry.ts` 22 项仍全通过。
