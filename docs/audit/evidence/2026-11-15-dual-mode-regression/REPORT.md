# 双模式 Channel 全功能回归验收报告（2026-11-15）

## 0. 结论

在 `main@79723a85`（PR #221 双模式 Channel 隔离 + PR #222 文档审计）上完成全量回归。结论：

- **静态门禁全绿**：lint、typecheck、i18n、docs 0 失败。
- **单元层全绿**：`test:unit` **1720/1720**，双模式 focused **67/67**，MCP 14/14、插件生命周期 22/22、SDK 出口面通过、twin 5/5、skills 167/167。
- **REST 实机层全绿**：隔离 home 实例 **68/68**（generic vs production_line_integrated 全功能对照）。
- **真实 harness 层全绿**：真实 omp 子进程 + **USTC/deepseek-flash** **50/50**。
- **构建与生产启动通过**：`npm run build` 成功，`.output` 在隔离 home 启动 `/api/health = ready`。

本轮发现并修复一个 **P0 回归**（PR #221 引入）：`setChannelSessionScope` 被解构后裸调用，丢失 `this`，导致所有 `BaseAgentImpl` 系 harness（omp/claude/codex/…）在 Channel 激活时 `TypeError: Cannot read properties of undefined (reading 'bridgeCtx')`，`POST /channels` 直接 500。修复后真实 omp 双模式 50/50。修复与回归测试见 §5。

**双模式判定**：generic 与 production_line_integrated 都具备完整的 Channel 框架能力（memory / mailbox / task / session / 群聊 / 协作工具）；差异仅在产线上下文与工业工具注入：generic 无产线注入且执行面拒绝工业工具，integrated 注入工业只读工具并携带产线/产品/会话快照上下文。该结论有真实 omp 行为证据，不只是工具面静态对照。

---

## 1. 环境与版本

| 项 | 值 |
| --- | --- |
| 仓库 | `D:/codes/ABO/AgentWorkShop` |
| HEAD | `79723a85`（main） |
| 版本 | agentworkshop 0.11.2 |
| Node | v24.19.0 |
| REST 实例 | `AW_MODE=home`、`AW_HOME=D:/tmp/aw-dual-rest-home-20261115`、PORT 3044 |
| OMP 实例 | `AW_MODE=home`、`AW_HOME=D:/tmp/aw-omp-accept-home-20261115`、PORT 3045 |
| Harness | 真实 `omp` 子进程（`omp --mode rpc-ui`） |
| 模型 | `provider=ustc, model=deepseek-flash, thinkingLevel=low` |
| 产线 | 模拟线 `OMP-LINE-hb045r`（`ln-7f812041`） |
| 数采 | mock 驱动节点 `OMP-PV-hb045r`（`dn-553cc4c7`） |
| 产品 | `OMP-PRODUCT-hb045r`（`pd-b6cef350`） |
| 外部依赖 | 不启动 Timescale/Docker（`AW_DAQ_STARTINFRASTRUCTURE=never`）；SQLite 时序落盘 |

隔离实例均从本轮修复后的 `.output` 启动；两个 home 目录均为全新重置，未触碰共享 `:4010` 模拟器、未连接真实 PLC。

---

## 2. 静态门禁（T0）

| 门禁 | 结果 |
| --- | --- |
| `npm run lint` | PASS（RSI 红线：21 个学习环文件 0 处设备写；eslint 0 error） |
| `npm run typecheck` | PASS（vue-tsc / tsc 通过） |
| `npm run i18n:check` | PASS（zh 3342 / en 3342 parity，used 2917，unresolved 0） |
| `npm run docs:check` | PASS（87 通过 / 0 失败） |

---

## 3. 单元与契约门禁（T1）

| 套件 | 结果 |
| --- | --- |
| `npm run test:unit` | **1720/1720 PASS**（含新增 `channel-session-scope-wiring` 回归测试） |
| 双模式 focused 19 文件 | **67/67 PASS** |
| `npm run test:mcp` | 14/14 PASS |
| `npm run test:plugin-lifecycle` | 22 通过 / 0 失败 |
| `npm run test:sdk-surface` | PASS |
| `npm run test:twin-provider` | 5/5 PASS |
| `npm run test:skills` | 167 PASS / 0 FAIL |

Focused 套件覆盖：`channel-mode-foundation`、`channel-mode-runtime-gates`、`channel-product-bindings`、`channel-product-session-ui`、`channel-products-api-temp`、`channel-session-product-snapshot`、`channel-template-mode`、`channel-session-scope-wiring`、`daq-product-scope`、`memory-private-channel-isolation`、`memory-strict-session-scope`、`rsi-channel-mode-scope`、`session-hardening`、`session-isolation`、`session-memory-scope`、`session-product-snapshot-create`、`session-recall-isolation`、`session-task-link`、`task-channel-profile`。

---

## 4. REST 实机层（68/68）

脚本：`scripts/accept-rest.mjs`；结果：`results-rest.json`。隔离实例 + 模拟产线，覆盖：

| 组 | 断言数 | 覆盖 |
| --- | --- | --- |
| 认证/权限 | 3 | 首管理员、第二用户、非属主 403 |
| 产线/产品/绑定 | 10 | 同线双产品、跨线拒绝、revision 乐观锁、跨线 product set 拒绝 |
| Channel 模式 | 4 | generic / integrated 创建与 GET 投影 |
| Session 快照 | 12 | generic 无产品、integrated 缺产品拒绝/未绑定产品拒绝/未知产品拒绝、快照 hash+revision、rebind 后快照不变 |
| 工具面 | 10 | generic 无工业工具且保留 memory/mailbox/task 核心；integrated 注入工业族；worker/会话 clone 同口径 |
| 执行门 | 10 | generic 直调 `line_context`/`daq_query` 被拒；integrated 直调成功；memory/queue/mailbox 工具双模式可用 |
| Memory | 8 | 写/搜、团队共享、跨频道隔离、RSI experience 观测面 |
| Mailbox | 6 | 人类消息、工具发送、频道 mail log 可回读 |
| Task | 4 | 双模式任务提交、路由、列表可读 |

关键判定：**generic 与 integrated 在 memory / mailbox / task / session 四个框架面上行为一致**；差异仅是工业工具与产线上下文。generic 的工业工具不仅不在注入面，执行面也返回「通用频道不开放产线工业工具」。

---

## 5. 真实 harness 层（omp + USTC/deepseek-flash，50/50）

脚本：`scripts/accept-omp.mjs`；结果：`results-omp.json`。真实 omp 子进程、真实模型、模拟产线/mock 数采。

### 5.1 形态与工具面（S0–T7，27 项）

- 隔离实例 ready；`/api/workshop/harnesses` 中 omp `available=true`。
- 两种模式各创建 omp lead + omp worker，激活成功。
- 集成频道绑定产品并创建带快照的会话（`cs-07289426`，product `pd-b6cef350`，line `ln-7f812041`），generic 会话无产品（`cs-f9ea7648`）。
- 工具面：
  - generic lead/worker/clone：无 `daq_query`/`line_context`/`recipe_catalog`/`ops_log`/`dcw_journal`/`mes_fetch`/`exp_collect`；保留 `save_memory`/`search_memory`/`send_message_to_agent`/`poll_messages`/`read_channel_mail`/`submit_task`/`get_my_task_queue`（clone 为 worker 定位，无 lead-only `submit_task`）。
  - integrated lead/worker/clone：工业工具族注入，且 worker 核心面保留。
- 直接执行门：generic 直调 `line_context`/`daq_query` 被拒；integrated 直调 `line_context`（返回线名）与 `daq_query` 成功；会话 clone 的 `line_context` 使用快照线；generic clone 的 `daq_query` 被拒。

### 5.2 Generic 真实作业（R1–R5、M1–M3）

| 能力 | 实测 | 证据 |
| --- | --- | --- |
| Memory | omp lead 调用 `save_memory(scope=shared)` + `search_memory`，回复 `GEN-OMP-hb045r PASS`；随后 API 检索命中锚点 | chat message `243a96b6-…`；memory 命中 |
| Task | 通过框架任务 API `POST /channels/:id/tasks` 提交 `TASK-OMP-G-hb045r`，真实 omp lead 接取并 `complete_task`，任务 **COMPLETED** | task `23d44c8e-6e94-4933-8df8-b5d2eedb3646` |
| Mailbox | lead 调 `send_message_to_agent(require_reply=true, priority=task)` → worker 回执 `已收到 MAIL-OMP-hb045r` → lead `poll_messages(wait_seconds=120)` 收到并回复群聊；mail log 含出站+入站锚点 | chat message `4131f555-…`；mail log 2 次命中 |

### 5.3 Integrated 真实作业（I1–I5、MC1–MC3、SS5）

| 能力 | 实测 | 证据 |
| --- | --- | --- |
| 产线上下文 | 会话 clone 调 `line_context` + `daq_query`，回复包含 `PROD-OMP-hb045r`、线名 `OMP-LINE-hb045r`、节点 `dn-553cc4c7` 最新值（empty/offline）；只读，无写操作 | session history agent message |
| 会话记忆 | 会话内 `save_memory(scope=shared)` 落库 `agent_memories`（1 行），会话成员 `search_memory` 命中「产线集成频道记忆正常」 | `I3` + `I3b`；DB count=1 |
| Task | 框架任务 API 提交 `TASK-OMP-I-hb045r`，integrated omp lead 完成，任务 **COMPLETED** | task `c22321fd-6d2e-4a79-af3e-900aba759da6` |
| 模式切换 | `integrated → generic` 后 base lead 工具面回收为 generic（无工业族）；既有会话 clone 保持 integrated 快照工具面；`generic → integrated` 后 base lead 恢复工业族 | MC1/MC2/MC3 |
| 快照不可变 | 解绑频道产品后，会话快照 hash/revision 不变（`f2789a25…` / rev 1），product 仍为 `pd-b6cef350` | SS5 |

### 5.4 任务口径说明

首次探索性运行中，真实 lead 在**群聊回合**调用 `submit_task` 被平台按 §13.3 拒绝（发起者为群成员作用域，`canManageChannel=false`），lead 如实回报失败，未伪造完成。该行为是既有框架设计：人类任务应走框架任务 API/UI 提交，而不是在群聊回合提管理面工具。正式验收因此改用 `POST /channels/:id/tasks` 的框架标准路径，两种模式均由真实 omp 接取并完成。

---

## 6. 发现并修复的 P0

### 6.1 现象

在修复前，用真实 omp lead 创建 Channel：

```
POST /api/workshop/channels -> 500 INTERNAL_ERROR
[api] unhandled error: TypeError: Cannot read properties of undefined (reading 'bridgeCtx')
    at setChannelSessionScope (nitro.mjs)
    at AgentChannelManager.wireMember ...
```

`pre-fix-failure.txt` 保留了原始栈。该问题影响所有 `BaseAgentImpl` 系 harness（omp/claude/codex/dsh/opencode/…），mock 不受影响，因此 REST-only（mock）测试与单测都没有覆盖到。

### 6.2 根因

PR #221 在 `wireMember` 中新增：

```ts
const setScope = (impl as { setChannelSessionScope?: ... }).setChannelSessionScope
setScope?.(channelSessionScope)
```

`setChannelSessionScope` 是 `BaseAgentImpl` 的原型方法；解构后裸调用丢失接收者，`this` 为 `undefined`，访问 `this.bridgeCtx` 立即 TypeError。Channel 创建/激活路径 `ensureLeadSchedulerLoop → ensureChannelActive → wireMember` 同步抛出，API 返回 500。

### 6.3 修复

`server/services/workshop/runtime/manager/runtime-wiring.ts`：改为保留接收者的方法调用：

```ts
const sessionScopedImpl = impl as { setChannelSessionScope?: ... }
sessionScopedImpl.setChannelSessionScope?.(channelSessionScope)
```

新增回归测试 `tests/channel-session-scope-wiring.test.ts`：用带 `bridgeCtx` 的 fake impl 走真实 `wireMember`，若方法被裸调用会以与线上同型的 TypeError 失败；同时断言 generic 频道注入 `null` 作用域。

### 6.4 验证

- 修复前：真实 omp Channel 创建 500（可靠复现）。
- 修复后：真实 omp 双模式 **50/50**，包括 lead/worker 创建、激活、真实回合、任务与模式切换。
- 全量单测 **1720/1720**，typecheck/lint 均通过；`.output` 重新构建后实机通过。

---

## 7. 双模式能力矩阵（本轮实测）

| 能力 | generic | production_line_integrated |
| --- | --- | --- |
| Channel 创建/激活 | ✅ | ✅ |
| 群聊/消息历史 | ✅ | ✅ |
| Memory 写入/检索/团队共享 | ✅ | ✅ |
| Mailbox send/poll/回执关联 | ✅ | ✅ |
| Task API 提交/接取/完成 | ✅ | ✅ |
| Session clone | ✅（无产品，mode=generic） | ✅（产品快照 + lineId + hash/revision） |
| 工业工具注入 | ❌（执行面也拒绝） | ✅（read-only 族） |
| 产线上下文 | ❌ | ✅（line_context / daq_query / 绑定产线简报） |
| 会话快照冻结 | N/A | ✅（rebind 不变） |
| 模式切换 | 基础运行时回收 | 基础运行时回收；既有会话 clone 保持冻结模式 |

---

## 8. 边界与观察

- **物理边界**：本轮产线为 simulated，数采为 `driver=mock`；工业工具只读；未执行 DCW/PLC 写、未开停线、未做 physical HIL。所有“设备值”证据仅代表模拟/影子环境，不构成生产控制声明。
- **UI 面**：本轮未做浏览器像素级走查；`channel-product-session-ui` 等 source-contract 测试在 unit 中通过。若需发布级 UI 验收，建议补真浏览器截图走查。
- **Mimosa（本轮已跑，未通过）**：深度扫描完成并产出 seal，但官方状态为 **`runStatus=inconclusive` / `completeness=partial`**，不是安全通过。
  - scanId：`scan-2026-11-15T04-19-13.703Z-d5fddcefc407`
  - seal：`sha256:4fa12dfbf371f6384e94a3785f2ac9d9942a457a6857feca0c14f120d7437425`
  - 源覆盖：2037 文件全部解析、未截断、0 读取/解析失败；threatModel 与 findingDiscovery 阶段仍为 partial（entryPoints=0、businessLogicCandidates=0）。
  - findings：47 条静态 advisory（其中 path-traversal 16、SSRF 11、跨文件污点 6、硬编码凭据 4、SQL 注入 2、IDOR 1、代码/命令注入 2 等）；多数落在 `scripts/`、`data/workspaces/`、`paper/` 拷贝与 i18n 标签/测试口令上，需人工确认。
  - 人工抽查：`server/services/workshop/evidence/candidate-store.ts:77` 的“命令注入”在该文件中没有 `child_process`/`exec`/`spawn` 调用，判定为扫描器误报；其余条目未逐条确认，不能据此宣称安全。
  - 依赖风险：354 个包，0 个匹配 advisory。
  - 结论：**Mimosa 未通过验收**；安全结论保持 `inconclusive`，不宣称“项目安全”。
- **群聊管理面口径**：`submit_task`/`complete_task` 等管理面工具在群聊发起的回合中被 §13.3 作用域拒绝（包括 owner 本人的群聊消息，代码固定 `canManageChannel=false`）。这是既有设计，不是本轮回归；若产品希望 owner 在群聊中直接建任务，需要单独的产品/安全决策。本轮任务验收走标准任务 API。
- **HTTP memory search 语义**：`POST /channels/:id/agents/:agentId/memories/search` 不带会话上下文时检索不到仅在会话档可命中的共享行；会话成员通过 `search_memory` 工具（带 session 上下文）可命中。属 API 语义差异，不是记忆丢失（I3/I3b 已实证落库与命中）。
- **长提示词截断感知**：一次真实回合中模型自述收到的群聊正文被截断，随后自行纠正并写入完整内容；未影响断言。建议后续单独核查 omp 侧长 prompt/上下文注入的显示或截断策略。
- **`dedup_key` 冲突**：同标题+数值矛盾的共享记忆按既有近邻治理生成 `[contested]` 并存行，而不是覆盖；这与 host-tools 描述中的 “same key overwrites” 存在文档口径差异，建议更新工具说明或明确产品语义。

---

## 9. 证据与复现

目录：`docs/audit/evidence/2026-11-15-dual-mode-regression/`

| 文件 | 内容 |
| --- | --- |
| `gates.json` | 全部门禁/套件计数、环境、边界 |
| `results-rest.json` | REST 68 项逐条断言 |
| `results-omp.json` | 真实 omp 50 项逐条断言（含 ID/锚点/任务 id） |
| `pre-fix-failure.txt` | 修复前 500 原始栈 |
| `scripts/accept-rest.mjs` | REST 双模式验收脚本（可重跑） |
| `scripts/accept-omp.mjs` | 真实 omp 双模式验收脚本（可重跑） |
| `mimosa/seal.json` | Mimosa 扫描封印（scanId + 产物哈希） |
| `mimosa/coverage.json` | 覆盖状态（partial / inconclusive） |
| `mimosa/report.md` | Mimosa 47 条静态 finding 摘要 |
| `mimosa/findings.json` | Mimosa 原始 findings |
| `REPORT.md` | 本报告 |

复现（隔离环境）：

```bash
# 1) 静态与单元
npm run lint && npm run typecheck && npm run i18n:check && npm run docs:check
npm run test:unit

# 2) 构建
npm run build

# 3) REST 双模式（需先按脚本注释启动隔离实例 :3044）
ACCEPT_BASE=http://127.0.0.1:3044 node docs/audit/evidence/2026-11-15-dual-mode-regression/scripts/accept-rest.mjs

# 4) 真实 omp 双模式（脚本自起隔离实例 :3045；需本机 omp + ustc provider）
node docs/audit/evidence/2026-11-15-dual-mode-regression/scripts/accept-omp.mjs
```

> 复跑前清空对应 `AW_HOME`；否则首个 admin 已存在会触发注册闸门。脚本默认会重置 `D:/tmp/aw-*-20261115` 验收目录，并只操作模拟产线。
