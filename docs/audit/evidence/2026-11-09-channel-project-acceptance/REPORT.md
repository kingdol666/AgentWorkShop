# Channel / Project 全流程实机验收报告（2026-11-09）

> 对象：`main` @ `d21f6c94`（v0.10.0 发布版），生产构建 `node .output/server/index.mjs`
> 实例：隔离 home `.deep-home-20261109`（从 `.deep-home-20261108` 复制，保留 CAL-3/涂布线种子），端口 **4013**
> 设备层：PLC 模拟器孪生（:4011）+ Modbus/OPC UA 协议栈；**不是真实工厂 PLC**
> 方法：`aw-system-acceptance` 六层 + ralph PRD 逐故事取证；每条结果附本轮命令/证据路径

## 一、结论先行

- **Channel 全绿**：多 harness 24/24、模板多会话 20/20、Agent 生命周期/对象隔离全部通过。
- **Project 主链通过**：记账软件交付 58/58、蓝图一键实例化全链 PASS、文档→Channel→Project 48/48、CAL-3 四期 77/78（两次；W3-t3 的 PV=SP 判据不成立、偏置来源待查；写控与零写证据通过，见 §五）。
- **T0/T1/T4/T5 通过；T3 4 项全绿 + HITL live 未通过**（T1 有一次并发 flake，已复现并解释；T3 HITL 见 §六）。
- **UI 12/12**：Channel 四视图、发言持久化、Project 五 tab、无 pageerror，截图归档。
- **不能宣称“全系统零回归”**：CAL-3 的 W3-t3 是 77/78 红项；HITL live 未通过（3 次尝试，U2c 未归档）；Mimosa 未在本轮重跑，且上一轮 deep scan 为 inconclusive/partial。

## 二、环境与实例纪律

| 项 | 值 |
|---|---|
| 代码 | `main` `d21f6c94`（PR #110 后） |
| 构建/版本 | `.output` v0.10.0；health `version=0.10.0` |
| Home | `.deep-home-20261109`（895 MB，复制自 2026-11-08 验收库） |
| 端口 | `:4013`（验收实例）· `:4011`（PLC 模拟器孪生） |
| 账号 | owner `admin@awshop.local`；独立评审 `verify-pitfall@aw.local` |
| 启动 | `AW_MODE=home AW_HOME=... PORT=4013 BACKUP_DISABLED=1 NUXT_SESSION_PASSWORD=... node .output/server/index.mjs` |
| 现场 | 139 active channels；14 harness 全 available；插件 11/11 enabled；工具 147（126 builtin / 21 plugin）全 available |

> 隔离说明：未使用共享 `.AgentWorkShop`，未改动 `.deep-home-20261108` 原件；验收产生的项目/频道/绑定只落在副本。

## 三、逐层结果

### T0 静态门禁

| 检查 | 结果 | 证据 |
|---|---|---|
| `npm run lint` | 0 error | `logs/t0-lint.log` |
| `npm run typecheck` | ✔ | `logs/t0-typecheck.log` |
| `npm run docs:check` | **87 通过 / 0 失败**（修复后） | `logs/t0-docs.log` |
| `npm run i18n:check` | zh/en 3291 keys，used 2873，unresolved 0，PARITY OK | `logs/t0-i18n.log` |
| `npm run readme:lint` | 全部通过 | `logs/t0-readme.log` |

**T0 抓到的真实回归**（已修复）：`docs/cli.md` / `docs/cli.en.md` / `docs/site/guide/configuration.md`（中英）仍写“140 个设置项 / 47 live / 93 restart”，而 schema 是 **143 项 / 47 live / 96 restart**；CLI/插件/SDK 的站点副本与源文档差 1 字符（版本号改动后未同步）。修复后 87/0。

### T1 单元与契约

| 套件 | 结果 | 证据 |
|---|---|---|
| `npm run test:unit` | **1253 pass / 0 fail / 2 skip** | `logs/unit-pass.log` |
| `npm run test:mcp` | 14 pass / 0 fail | `logs/t1-test-mcp.log` |
| `npm run test:plugin-lifecycle` | 22 pass / 0 fail | `logs/t1-test-plugin-lifecycle.log` |
| `npm run test:sdk-surface` | 通过（agentworkshop@0.10.0） | `logs/t1-test-sdk-surface.log` |
| `npm run test:twin-provider` | 5 pass / 0 fail | `logs/t1-test-twin-provider.log` |
| `npm run test:skills` | 167 PASS / 0 FAIL（8 skills） | `logs/t1-test-skills.log` |

**2 个 skip 的来历**：`tests/governance-harness-audit.test.ts` 中两条 WIP 用例显式 `skip`（“待 bridgeCtx.identity.harness 落地后恢复”与“待驱动审计 outcome 字段落地后恢复”），不是失败被隐藏；其余 optimizer 相关 skip 条件在本轮均为 false，未计入 skip。

**T1 flake 说明（如实）**：unit 在验收实例运行期间连续两次在 `tests/http-drivers.test.ts` 失败（单文件隔离复跑 10/10 全过）；第三次全量 `npm run test:unit` 1253/0/2 通过。判定为并发资源竞争/测试隔离 flake，非产品回归；仍建议 CI 串行或隔离网络用例。

**与历史基线对照**（2026-11-08 全功能轮）：unit 1253/0/2 持平；Channel 24/24、20/20 持平；Project 58/58 持平；api-live 75/75 持平；UI 12/12 持平；CAL-3 由 78/78 变为 77/78（唯一差异 W3-t3，归因为 PV=SP 判据/偏置，见 §五）。没有断言数下降或套件被删除；本轮新增的是失败分析，不是放宽门槛。

**工作树说明**：本轮测试提交为分支 **`test/acceptance-channel-project-20261109`** 的 HEAD（tag `acceptance-20261109`），基于 `main @ d21f6c94`；工作树干净，docs 87/0 等 T0 结果依赖该提交里的 docs 修复，不能直接 checkout `d21f6c94` 复现。

### T2 Channel

| 套件 | 结果 | 证据 |
|---|---|---|
| 多 harness + 对象隔离（mock/omp/dsh/codex/opencode） | **24/24** | `harness-isolation.json` |
| 模板多会话 + 会话内真实产线读写 | **20/20** | `channel-multisession.json` |

关键断言：五引擎建频道/激活全 200；lead/worker `agentId` 跨频道全不重复；A 看不到/删不掉 B 成员；无 @ 消息 0 执行；停用 invoke 拒；删除后列表消失；关闭 A 后 B 成员仍 enabled。多会话：两会话 cloneId 互异、克隆继承绑定面、双会话并行真 LLM、会话 A 内 `recipe_trial` HITL 写回读收敛、关闭 B 后 B 克隆停用且 invoke 拒、A 与基础成员保留。

### T2 Project

| 套件 | 结果 | 证据 |
|---|---|---|
| 记账软件通用交付（3 频道/3 工作项/L1+L2/真实 Python） | **58/58** | `bookkeeping.json` + `artifacts/ledger-app/` |
| 蓝图一键实例化 + technical 门 + 项目完成审批 | **PASS（17 步）** | `blueprint/blueprint-live.json` |
| 产线文档 → Channel → Project（涂布线） | **48/48** | `doc-to-project/doc-to-project.json` |
| CAL-3 四期真实产线递进（原始判据） | **77/78** | `cal3/staged.json` + `logs/cal3.log` |
| CAL-3 沉降窗复跑 | **77/78**（W3-t3 773.0 vs SP 778，n=86） | `cal3-settled/staged.json` |

Project 关键证据：

- 记账项目：W1 规格 → W2 源码 → W3 测试报告，`dependsOn` 链、technical 路由、L1/L2 双账号、项目 completed；`ledger.py` 由 `python ledger.py summary` 真实执行 PASS；4 件产物齐备。
- 蓝图：保存命名蓝图 → `instantiate` 返回 `active` + 3 个工作项 → 未 review 上游时 W2 dispatch **409 TECHNICAL_REVIEW**（负例）→ review 后放行 → 3 个交付物 approved → 项目完成审批 → `completed`。
- 文档→项目：从涂布线文档落袋的线/节点/配方/双频道被 Project 正确编组；W1 真实 `daq_query`（定量 PV/温度 PV）+ `analysis_save`；W2 `write_intent` + `recipe_trial` HITL + 设备回读收敛；项目 completed，审计事件齐备。

### T3 回归面（本轮抽 4 项全绿）

| 套件 | 结果 | 证据 |
|---|---|---|
| `api-live-e2e.mjs` | **75/75** | `logs/api-live.log` |
| `e2e-agent-team.mjs` | **25/25** | `logs/agent-team.log` |
| `e2e-template-isolation.mjs` | **38/38** | `logs/template-isolation.log` |
| `e2e-rest-robustness.mjs` | **ALL PASS** | `logs/rest-robustness.log` |
| `e2e-hitl-live.mjs` | **未通过**（3 次尝试：AEP ask 超时 / 频道创建失败；U2c 未归档） | `logs/hitl-live.log` · `logs/hitl-live-retry.log` |

### T4 插件/工具面

| 项 | 结果 |
|---|---|
| 插件 | 11 个，11 enabled，`failures=[]`，无 error |
| 工具注册表 | 147 total = **126 builtin** + 21 plugin；available 147，unavailable 0 |
| harness | 14/14 available（含 omp/dsh/codex/opencode） |

证据：`t4-surface.json`。

### T5 发布产物冒烟

| 项 | 结果 | 证据 |
|---|---|---|
| `npm run build` | ✔（v0.10.0 生产构建；本轮 `npm run build` 复跑） | `logs/t5-build.log` |
| fresh home 启动 | `/` 200；`/api/health` 200 `version=0.10.0`；未鉴权 `/api/workshop/aml` **401** | `logs/t5-smoke.log` + `logs/t5-start.log` |
| 缺 `NUXT_SESSION_PASSWORD` | `NODE_ENV=production` 下启动过程中被安全插件拒绝并 exit 1（日志显示先 `Listening` 后 fatal） | `logs/t5-nopass.log` |
| `npm pack --dry-run` | 当前工作树 42.9 MB / **4681** files；含 `.output`、prompts、schema、AML/optimizer Python | `logs/t5-pack.log` |
| 已发布 0.10.0 tarball | 42.9 MB / **4682** files，shasum `7ed5a5…`（发布时点早于本轮 docs 计数修复；不重发同版本） | GitHub Release / npm |
| 安装验证 | **隔离 prefix** 两条路径（tarball / registry）均 `aw --version=0.10.0`；默认全局 `aw` 未动，仍是 0.8.7 | `logs/t5-install.log` |

### T6 UI 实机走查

| 断言 | 结果 |
|---|---|
| Channel 控制台加载 + 群聊可见 | ✔ |
| 任务板 / 多会话 / 时间线切换 | ✔ ×3 |
| 发言后刷新仍存在（持久化） | ✔ |
| 全程无 pageerror | ✔ |
| Project 五 tab | ✔ ×5 |
| Project testid 齐备 | ✔ |
| **合计** | **12/12** |

截图：`ui/u1-channel-chat.png`、`u2-task-board.png`、`u3-sessions.png`、`u4-timeline.png`、`u5-chat-persist.png`、`u6-projects-list.png`、`u7-project-overview.png`、`u8-project-approvals.png`、`u9-workshop-list.png`；结果 `ui/ui-results.json`。

## 四、发现与定性

| # | 发现 | 性质 | 证据 | 建议 |
|---|---|---|---|---|
| F1 | completed Project 仍持有频道绑定，重跑同频道 409 `CHANNEL_ALREADY_BOUND` | **真实 P0**（本轮复现 8 次，手工解绑 8 个频道） | CAL-3 首跑 409/409/409/409；doc-to-project 首跑 409/409 | 项目完成/归档自动释放绑定，或绑定加租约/可抢占语义 |
| F2 | 蓝图测试驱动未显式 `leaderHarness` | 测试驱动陈旧（产品已收紧，正确） | S4 报“必须显式声明 leaderHarness” | 已修驱动：传 `mock`；生产应传真实引擎 |
| F3 | 任务实例在 root 收口后 lead 被禁用，post-close 的 `project_submit_result` 必须带 task_id 且属实例 lead | 生命周期收紧（正确） | S8 先报 `PROJECT_TASK_CONTEXT_MISSING`，再报 `PROJECT_TASK_SCOPE_VIOLATION` | 测试驱动改为 owner REST 提交；产品侧文档明确“收口后谁提交” |
| F4 | L1/L2 同账号自批被拒（`SELF_APPROVAL_FORBIDDEN`） | **正确治理**（测试驱动缺独立评审） | S16 首跑 L2 全 pending | 已修驱动：`verify-pitfall` 独立评审；保持该硬门 |
| F5 | CAL-3 W3-t3 用“治理后 PV 均值≈SP”判数据在场：原始 28s 窗 783.2、沉降 172s 窗 773.0，均偏离 SP 778 超 4.0 | **PV=SP 判据不成立**（偏置来源待查），非写控失败 | W2-t4 设备=778.0；W3-t2 零写后=778.0；原始 783.2(n=14)；沉降 773.0(n=86) | 测试改为“设备 setpoint 精确 + PV 方向/工艺带 + 数据集含治理后段”；产品侧查偏置并考虑数据集沉降窗 |
| F6 | 第一次交互运行在群聊页等待 `.hitl-bell` 超时（该次未归档）；归档复跑分别 AEP ask 超时与频道创建失败 | **UI 可达性/测试脚本稳定性**（HITL 写控由 CAL-3/doc-to-project 证明） | `logs/hitl-live.log` · `logs/hitl-live-retry.log` | 明确 console 的 HITL 入口、给 omp 冷启动更长等待、失败打印 HTTP 错误体 |
| F7 | unit `http-drivers.test.ts` 在并发实例下间歇失败 | 测试隔离/资源竞争 flake | 两次失败、单文件 10/10、第三次全量 1253/0/2 | CI 串行或隔离网络用例 |
| F8 | `security.allowRegistration=false` 导致多个 e2e 脚本自注册失败 | 安全默认（正确） | agent-team/template/robustness 首跑注册失败 | e2e 支持 `AW_E2E_TOKEN` 或验收实例显式开注册后恢复 |
| F9 | 首次 `npm run build` 失败：stale `.nuxt` / 共享 `node_modules/.cache` 引用不存在的 motion chunk | 构建缓存污染，非代码缺陷 | 清理 `.nuxt` 后 build exit 0 | 构建前清 `.nuxt`；避免多 worktree 共享 Nuxt cache |

### 四.1 测试驱动修正（披露）

| 脚本 | 修正 | 原因/影响 |
|---|---|---|
| `project-blueprint-live.mjs` | 蓝图显式 `leaderHarness:'mock'` | 产品已移除默认 mock 替身；不传则 instantiate 400 |
| 同上 | post-close 提交从 `project_submit_result` 改为 owner REST | 任务实例在 root 收口后被禁用；产品生命周期收紧 |
| 同上 | L1/L2 使用独立 reviewer `verify-pitfall` | `SELF_APPROVAL_FORBIDDEN` 是正确硬门；原驱动缺第二账号 |
| 同上 | 增加 `project_complete` 审批决策 + 轮询到 `completed` | 原驱动只创建完成审批，未签核，final 仍 active |
| 同上 | A1 负例从“非 200”收紧为 `409 TECHNICAL_REVIEW` | 断言加强，不是放宽 |
| 同上 | `waitRootDone` force 改用任务 `assigneeId`（实例 lead） | 基础频道 lead 无权收口实例任务；原 force 403 |
| 同上 | 删除未使用的 `leadTokenFor` 与 `channel` 参数 | T0 lint 修复；无行为变化 |
| `cal3-staged-live.mjs` | W3 取证前沉降 150s | 原 28s 窗含瞬态；仍用同一 4.0 容差，未删断言；原始 77/78 保留 |

覆盖变化：blueprint 不再覆盖“实例 lead 在收口后提交”的路径（该路径本身已被产品禁用）；`bookkeeping` 仍覆盖实例 lead `complete_task`。force 收口从基础 lead 改为实例 lead，是修正而非放宽。

## 五、CAL-3 77/78 的红项分析

原始运行：

```
✔ W2-t4 设备侧精确生效: before=786 after=778.0 target=778
✔ W2-t5 工艺惯性后炉温复测: post窗均值=783.2℃(n=14)
✔ W3-t2 零写佐证: after=778.0 治理值=778
✖ W3-t3 治理后窗均值=783.2℃(n=14, SP=778, 容差 4.0)
✔ W3-t4 aml_dataset_build: 33221 行，窗口含治理后时段
✔ W4-t4 精确有界生效: Δ=+6±0.5，界内，≤步限
```

节拍闸证据（`logs/cal3.log`）：W4 前“距 W2 下发 32s → 等待 273s”（两次调整 ≥300s）；在线写间隔闸“等待 57s 后重试（第 1 次）”。300s / 60s 闸真实生效，不是测试放水。

解释：W3-t3 的窗口从 `w2WriteAt` 开始，W3 在 W2 验收后立即开始，窗口只有 ~28s；设备 SP 从 786 降到 778（W2-t4），炉温 PV 实测在 30s 窗为 783.2℃、沉降窗为 773.0℃，28s 窗均值必然偏离 SP。设备侧 setpoint 已精确 778.0（W2-t4），且 W3 零写保持 778.0（W3-t2）——**写控链路正确，红在测试判据**。

沉降复跑：按 τ≈75s 在 W3 取证前等待 150s，窗口扩大到 172s / 86 点，均值 **773.0℃**，仍偏离 SP 778 达 5.0。说明该炉温对象不是“PV 收敛到 SP”的理想一阶环节：存在稳态偏置/过冲（SP 786→778，PV 783.2/778.0→773.0，方向与 -8 治理一致）。因此 **W3-t3 的“PV 均值≈SP”判据本身不成立**，不是沉降时间不够；偏置来源（对象稳态偏置 / 回读标定 / 工艺扰动）待查。原始与沉降两轮都保留为失败证据；正确的验收判据应是“设备 setpoint 精确等于目标 + PV 相对治理前有正确方向/工艺带响应 + 数据集包含治理后时段”，而不是要求 PV=SP。产品侧建议在 `aml_dataset_build` 质量门中显式标注/排除治理后过渡段。

> 结论：CAL-3 的**写控与零写证据通过**；四期项目链其余 77 项全过；W3-t3 的 PV=SP 判据不成立（偏置来源待查），不能用它判产品回归，也不能把它改绿后宣称 78/78。

## 六、HITL live 未通过（U2c 未归档）

`e2e-hitl-live` 本轮尝试 **3 次**，结论：**不通过，不能作为 HITL 回归证据**。

- 第 1 次（仅终端观察，**未归档**）：观察到群聊页等待 `.hitl-bell` 超时；该次没有任何日志落盘，因此本节不引用它的后端断言或“铃标红”结论。
- 第 2 次（`logs/hitl-live.log`）：`waitUntil timeout: AEP hitl.request 帧`（last=null），omp ask 在 300s 内未出现。
- 第 3 次（`logs/hitl-live-retry.log`）：频道创建失败（`channel=undefined`），随后 `send` null。

因此 **HITL live 脚本本身不稳定**（omp 冷启动/ask 时延 + 频道创建时序），本轮不把 T3 HITL 计为通过。HITL 写控能力由 **CAL-3 W2**（HITL 卡→批准→设备回读）与 **doc-to-project W2**（write_intent + recipe_trial HITL + 回读）独立证明；但 omp 对话框/全局铃标的浏览器链路没有取得本轮归档证据。建议：给 omp 冷启动更长的可诊断等待、失败时打印 HTTP 错误体、并明确 console 页的 HITL 入口（或同步 e2e 选择器）。

## 七、未覆盖 / 边界（如实）

- 设备层是 **PLC 模拟器孪生**（:4011），不是真实工厂 PLC；系统链路、协议、HITL、回读是真实执行，物理对象为模拟。
- 本轮未重跑 T2 的 ontology / model loop / optimizer / IDD 结果库（超出 Channel/Project 范围；上一轮分别为 87/87、53/53、105/105、36/36）。
- 未使用 MCP computer-use 桌面截屏；UI 走查为 headless Chrome + 截图。
- Mimosa 安全扫描未在本轮重跑；上一轮 deep scan 为 **inconclusive/partial**（33 条静态发现、0 business-logic candidate），不得宣称安全全通过。
- 注册开关在 e2e 期间临时打开并已恢复 `false`；未改生产默认。

## 八、证据索引

```
docs/audit/evidence/2026-11-09-channel-project-acceptance/
├── REPORT.md
├── harness-isolation.json          # Channel 24/24
├── channel-multisession.json       # 多会话 20/20
├── bookkeeping.json                # Project 58/58
├── blueprint/blueprint-live.json   # 蓝图全链
├── doc-to-project/doc-to-project.json # 文档→项目 48/48
├── cal3/staged.json                # CAL-3 原始 77/78
├── cal3-settled/staged.json        # CAL-3 沉降复跑
├── t4-surface.json                 # 插件/工具/harness
├── ui/ui-results.json + ui/*.png   # UI 12/12
└── logs/                           # t0/t1/t3/cal3/hitl 原始日志
```

## 九、裁决

- **Channel**：通过。多 harness、多会话、生命周期、对象隔离均有本轮实机证据。
- **Project**：通过。通用交付、蓝图、文档→项目、CAL-3 四期主链均通过；CAL-3 的 1 项红为 PV=SP 判据不成立（沉降后仍 773 vs 778，偏置来源待查），已归档原始与复跑两轮证据，不能用它判写控回归。
- **发布产物**：通过。0.10.0 构建、鉴权屏障、npm pack 与隔离 prefix 安装均验证；默认全局 `aw` 未改动（0.8.7）。
- **不能宣告“全系统零回归 / 安全通过”**：CAL-3 W3-t3 原判据红、HITL live 未通过（U2c 未归档）、Mimosa inconclusive；这三项已如实归档，需在下一轮修复/复验。

## 十、独立复核

| 轮次 | 结论 | 处理 |
|---|---|---|
| Reviewer #1（全量） | **REJECTED**（10 条 must-fix：T0 lint 遗留、HITL/T5 证据缺口、蓝图步数、u6 缺失、措辞、skip 解释、工作树脏等） | 逐项修复；T0 lint 0；蓝图 17 步 + A1=409；HITL 只引用归档日志；T5 五份日志入库；补 u6/u9；报告措辞统一；提交到分支/tag |
| Reviewer #2（快速复核） | **APPROVED** @ HEAD `41dfe729` / tag `acceptance-20261109` | 确认 26 个日志入库、无“Project 全绿/铃标红（肯定句）/t5-smoke 不存在/PV 从 786/后端全 PASS”，t5-smoke 记录 200/0.10.0/401 |

复核结论：报告可以支持 **“Channel/Project 核心功能通过；CAL-3 W3-t3 与 HITL live 仍红”** 的结论，不支持“全系统零回归”或“安全通过”。
