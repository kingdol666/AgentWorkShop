# v0.18.0 发版验收与后端 API 审查报告（2026-11-23）

> 口径：本报告只引用本轮实际执行输出与证据文件；历史基线只作对照，不复制成当前结果。
> 未覆盖面在 §8 单列，不混入「通过」判定。

## 0. 结论

- **修复 3 个真实缺陷**：console「新建频道」跨工作区串区（P1）、11 个 REST handler + 数采推送 + A2A 方法的「先查资源后验身份」（P2，未鉴权 ID 枚举 oracle）、`dcw/line/query` 无窗口时对时序超表全表聚合（P2，共享 Timescale 实测 10–15 s）。
- **API 面全量探测**：构建产物注册的 **503 个 handler** 经 **1060 次探测**（含 35 个带真实 ID 的详情读），**0 个 5xx、0 个连接错误**；10 个「管理员无效请求被接受」逐条定性（§5.3），其中 2 个静默成功列为 P3。
- **界面级证明**：串区缺陷在真实 console 弹窗上被端到端证实已修（8 项断言中 7 项通过，1 项为既有水合警告，见 §8）。
- **需求追溯**：README 40 条产品声明 33 条实现+测试互证；Project 层计划（192 项）与上下文学习框架（46 项）、RSI 证据晋升计划（40 项）**并未全部落地**，逐项状态见 §7——计划文本的复选框全未回填，不能当作完成度证据。

## 1. 基线与环境纪律

| 项 | 值 |
|---|---|
| 主干基线 | `main` @ `f2ca04f6`（与 origin/main 同步，0 open PR） |
| 被测分支 | `feat/auto-default-workspace`（+ 本轮未提交改动） |
| 构建 | `npm run build`（Nuxt 4.5.2 / Nitro 2.13.4，node-server） |
| 隔离实例 | 端口 3080，`AW_MODE=home`，`AW_HOME=D:/tmp/aw-release-acceptance/home`，`BACKUP_DISABLED=1` |
| 会话密钥 | 每次启动运行时生成，不落盘、不回显 |
| 凭据 | 只存 `D:/tmp/aw-release-acceptance/private/admin-credential.json`（私有目录） |
| 共享服务 | MQTT 1883 / Timescale 5432 / 对象存储 9000 仅复用读取，未重启；未对真实设备写入 |
| 已安装桌面 | 0.17.5 运行中（pid 65456，真实 home），本轮审查阶段未触碰，update 在 §6.4 单独执行 |

第一轮扫描曾触发产品自身防护并被 429/403 拦截（`IP temporarily blocked (scanning)`、`Too many requests`），说明限流与 404 扫描封锁按设计工作；随后扫描器改为**顺序 + 滚动窗口预算**（≤45 个 404/min、≤480 次 /api/min，均低于产品默认阈值 60 与 600）重跑，未再触发。

## 2. 审查发现与处置

| ID | 级别 | 位置 | 现象 | 处置 |
|---|---|---|---|---|
| R1 | P1 | `app/components/workshop/session-list/MountChannelModal.vue` | 弹窗先建频道（服务端新特性挂默认区）再补挂当前区，导致频道同时出现在两个工作区，并为多工作区用户凭空生成「默认工作区」 | 已修：`workspaceId` 随创建请求提交，由服务端原子校验并挂载；移除二次挂载入口 |
| R2 | P2 | `server/api/workshop/{agents,teams,channel-templates,tasks}/**`、`daq/[id]/ingest`、`a2a/[agentId]/rpc` | 先查资源返回 404、后验身份返回 401，未鉴权调用者可枚举 ID 是否存在 | 已修：11 个 handler + ingest + `message/send` 改为先解析身份 |
| R3 | P2 | `server/api/workshop/dcw/line/query.get.ts` | `from`/`to` 缺省时查询窗口为 `[1970, now]`，对 `daq_samples` 全表聚合（10–15 s，随历史增长） | 已修：缺省 24h 窗口（`resolveLineQueryWindow`，纯函数 + 5 单测） |
| R4 | P3 | `a2a/[agentId]/card/index.get.ts`、`rpc/index.post.ts` | `security.a2aCardPublic=false` 只拦 HTTP card，JSON-RPC `agent/getCard` 可旁路 | 已修：共用 `canReadAgentCard` 守卫 |
| R5 | P3 | `scripts/e2e-line-governance.mjs` | 套件建于 v17 频道模式门控之前，用 generic 频道跑产线治理，L3 起全被 `PROFILE_DENIED` 拒绝 | 已修：频道建为 `production_line_integrated` |
| R6 | P3 | `aml/datasets/[id].patch.ts`、`daq/alarms/[id]/ack.post.ts` | 资源不存在时仍返回 200（`{dataset:null}` / `{acked:false}`），掩盖操作失误 | **未改**，如实记录（行为变更留待下轮评估调用方） |
| R7 | — | `app/plugins/session-restore.client.ts` | SSR 无会话身份、客户端水合后立即切换为登录态，部分页面出现 `Hydration completed but contains mismatches` | **既有问题**（该文件自 main 未改），非本轮引入；见 §8 |
| R8 | — | `docs/mcp.md`、`README.md`/`README-zh.md` | MCP 工具数 35→38、缺失 3 个配方工具、断言组 12→14、skill 3→9、项目页 880/312/1080px 与实现不符 | 已修 |
| R9 | P2 | `server/services/workshop/db/memory.repo.ts`（`upsertExperience`） | `dedup_key` 是 `exp:task:<id>` 这类来源键、不含内容哈希；ON CONFLICT 只保护 status/evidence，正文/标题/结论/范围/权重仍会被同键重放覆盖——「已验证」名下可出现未经人工策展的新文本 | 已修：受保护行的五个字段一并保持策展值；新增 `experience-replay-immutability` 2 用例，经验族 46/46 |
| R10 | P2 | `server/api/workshop/channels.post.ts` | 创建时绑线的 `lineId` 404 与 `requireLineMode` 403 都在 `createChannel` **之后**，非授权用户会「报错但频道已建、且已挂进工作区可见」，重试堆积孤儿频道 | 已修：两项校验前移到建频道之前；新增 3 个 `createChannel` 级用例（拒绝不留孤儿、响应带 workspaceId/Name、不传标记不挂载），共 11/11 |
| R11 | P3 | `app/components/app-header/HitlBell.vue` | `focusout` 的 `relatedTarget` 为空时被忽略，点击不可聚焦区域后面板可能留在打开状态且 Esc 不可达 | 已修：空 `relatedTarget` 时下一轮按 `activeElement` 复核关闭 |
| R12 | P3 | `app/pages/projects/index.vue` | 错误条改为单行省略后长错误不可读 | 已修：补 `:title` |
| R13 | P3 | `scripts/experiments/gemma4-pipeline.mjs` | 脚本内硬编码一次性账号口令字面量 | 已修：改为运行时 `crypto.randomUUID()` 生成 |

## 3. 修复的回归测试

| 测试 | 覆盖 |
|---|---|
| `tests/channel-default-workspace.test.ts`（8） | 默认区按需创建且只挂一次；显式目标**绝不**漏进最早工作区（新增）；外部/未知工作区与外部频道在挂载前拒绝 |
| `tests/frontend-contract.test.ts`（+W1） | 弹窗必须带 `workspaceId`、不得二次挂载、store 不得保留 `mountChannel`、API 类型需声明 `workspaceId` |
| `tests/api-auth-order.test.ts`（2） | 11 个 handler `resolveUser` 必须先于资源查找；A2A `message/send` 先验 token 再判目标；`agent/getCard` 与 HTTP card 共用开关 |
| `tests/dcw-line-query-window.test.ts`（5） | 缺省 24h / 只给 from / 只给 to / 两端原样 / 下界不为负 |

## 4. 门禁结果

### 4.1 静态与契约（T0/T1）

| 门禁 | 结果 |
|---|---|
| lint（含 RSI 红线） | `0 error`；RSI 红线 31 个学习环文件 0 处设备写调用 |
| typecheck | 通过 |
| check:cssvars | 162 个变量引用全部有定义（264 文件） |
| i18n:check | zh 3441 / en 3441，未解析 0 |
| docs:check | 101 通过 / 0 失败（含版本、设置计数、站点孪生逐字一致） |
| readme:lint | 通过 |
| frontend-lifecycle-contract | 3/3 |
| test:skills | 197 PASS / 0 FAIL |
| test:mcp | 14/14 |
| test:plugin-lifecycle | 22 通过 / 0 失败 |
| test:sdk-surface / test:twin-provider | 通过 / 5/5 |
| test:unit | **2306 用例 / 2305 通过 / 0 失败 / 1 跳过**（认证轮 `logs/gates-summary-4.txt`） |

第二轮（修复串区与鉴权顺序后）：unit 2296 / 2295 通过 / 1 跳过；第三轮 2303 / 2302 / 1（加入时间窗与经验重放测试）；第四轮（加入 createChannel 级用例与审查修复后）**2306 / 2305 / 1**，即本报告采用的认证数字。

### 4.2 发布产物冒烟（T5）

- `npm pack --dry-run --ignore-scripts`：`agentworkshop@0.18.0`，5838 个文件、45.4 MB；`.output/server/index.mjs`、`desktop/*`、`chrome/splash.html`、`skills/**`、`sdk/**`、`mcp/**` 均在清单内；无 `docs/audit/evidence`、`paper/`、`bench/`、`.mimosa/` 泄漏。

## 5. 后端 API 全量探测

### 5.1 方法

从源码派生 505 个 handler（构建产物 503 个路由 chunk，差异为 catch-all），三类探测：
1. **未鉴权**：全部 handler 无凭据调用 → 期望 401/403/4xx，不得 2xx 泄内容、不得 5xx；
2. **管理员详情读**：先带 `zz-sweep-missing` 无效 ID，再用父列表解析出的**真实 ID**（35 个）；
3. **管理员无效写**：只对无路径参数或有路径参数的 276 个写路由发 `{"__sweep__":true}`，**36 个可能产生全局副作用的路由（关机/备份恢复/设置重置/控制器/AML 环境/MES 外呼/权限覆盖/工具同步等）不发鉴权请求**。

### 5.2 结果（`evidence/api-sweep-run3.json`）

| 阶段 | 探测 | 状态分布 |
|---|---|---|
| 未鉴权 | 533 | 401×514、404×4、400×3、426×4、403×1、200×7 |
| 管理员详情读（无效 ID） | 216 | 200×99、404×92、400×8、422×5、405×5、401×4、426×2、超时×1（SSE） |
| 管理员详情读（真实 ID） | 35 | 200×31、404×2、400×1、410×1 |
| 管理员无效写 | 276 | 404×159、400×83、200×10、422×15、401×7、403×1、426×1 |

**0 个 5xx，0 个连接错误。** 未鉴权阶段的 7 个 200：`/api/health`、`/api/users/setup-status`、插件 i18n/manifest（公开面）、`GET|DELETE /api/users/session`（会话探测/清理，设计如此）、A2A RPC（JSON-RPC 规范：错误也以 200 返回 error 对象）。

### 5.3 需要定性的 10 个「无效写被接受」

| 路由 | 结论 |
|---|---|
| `POST /api/workshop/eda/dashboards`、`/eda/spc`、`/workshop/ontology/drafts`、`/system/config-groups` | 缺 body schema，`{"__sweep__":true}` 被当作空对象创建了实体（管理员可达）。**校验缺口，P3** |
| `PATCH /api/workshop/aml/datasets/:id` | 资源不存在返回 200 `{dataset:null}`（R6） |
| `POST /api/workshop/daq/alarms/:id/ack` | 告警不存在返回 200 `{acked:false}`（R6） |
| `POST /api/workshop/ws/ticket`、`/workshop/ontology/traces/:id`、`/api/metrics`、A2A RPC | 端点本身无 body 契约或以文本/JSON-RPC 信封响应，非缺陷 |

## 6. 实机演示

### 6.1 Console 建频道（真实 UI，puppeteer + 生产构建）

`evidence/console-mount/results.json`、截图 01–04：

| 断言 | 结果 |
|---|---|
| 弹窗提交后关闭 | PASS |
| 频道已创建 | PASS |
| 只挂载在目标工作区 | PASS（`hosting=["E2E Target …"]`） |
| 未漏进更早的工作区 | PASS |
| 未凭空创建「默认工作区」 | PASS |
| 工作区总数未增加 | PASS |
| 刷新后仍在目标工作区 | PASS |
| 页面无 JS 错误 | **FAIL**：`Hydration completed but contains mismatches`（既有，见 §8） |

### 6.2 全站 UI 走查（27 静态路由 × 明暗双主题）

`evidence/ui-walk/`：27 条路由 × 2 主题 = **54 次加载全部 200 落地、0 页面错误、0 横向溢出**，逐页截图见目录。

### 6.3 产线治理实机套件（隔离实例 + mock 驱动 + HITL）

`logs/e2e-line2.log`（首次重跑，套件未对齐回合来源门）：**42/44**，两项失败是 L11c/L11d——agent token 直接发起 `line_start` 被「缺少可信回合来源」拒绝。该门是 v17 之后新增的防伪造回合保护（`host-tool-bridge/host-tools.ts:112`），套件编写于其之前；已把 L11c/L11d 改为「必须被拒绝且不产生审批卡」，重跑 **PASS(44/44)**（`logs/e2e-line3.log`）。覆盖：L1–L10（建线/节点/产品/配方/绑线、开线审批与设备证实、停线、审批期换线取消、停用参数如实报错、非法参数、批次换线、配方改版快照、跨线清理）与 L11/L12（读面 agent token 可用、错误 token 拒绝、写面缺回合来源拒绝且无副作用、实采 + 写/回读/单步/60s/量程）。

### 6.4 插件与工具注册面（T4）

隔离实例：8 个插件装载、`failures=[]`；工具注册表 142 项（builtin 127 / plugin 15）。

### 6.5 桌面安装版 update

**TBD-DESKTOP**

## 7. 需求追溯（文档声明的真实需求 vs 实现）

### 7.1 README 产品声明（40 条抽样）

33 条「实现 + 测试」互证；4 条有实现无测试（60s/300s 写入与审批默认值、串口插件行为、`/town` 3D 场景、调度 60s 下限）；2 条文档漂移（已修）；1 条待澄清（WS AEP v1 seq 续传未断言）。

### 7.2 Project 层计划（`docs/plans/2026-11-03-project-layer-plan.md`，验收清单 192 项）

J–M 段（55 项）：**VERIFIED 14 / PARTIAL 36 / NOT_FOUND 3 / IMPL_NO_TEST 1 / SUPERSEDED 1**。未找到：性能 fixture（J8）、observe 影子运行报告（K15）、重复/双批准 SQL 断言（M3）。A–I 段（137 项）本轮**未完成逐项核对**（审查预算用于 M 段与三份其它计划），不作完成度判定——已核对段与未核对段分开陈述，不用计划复选框代替实现证据。

### 7.3 上下文学习框架（`docs/plans/2026-11-13-…`，46 项）

**VERIFIED 5 / PARTIAL 34 / NOT_FOUND 4 / IMPL_NO_TEST 1 / SUPERSEDED 2**。整个 Task 2（extension 注册/校验/发布/退役与本体桥）未实现；框架是默认关闭的 `rsi-interface-beta` 只读切片，无 REST/MCP/UI 暴露；验收脚本只导入 Node 内建模块、不调用框架本体，其「9 个 profile PASS」证明的是 harness 而非框架。

### 7.4 RSI 证据晋升计划（`docs/plans/2026-11-17-rsi-evidence-promotion-product-memory-plan.md`，40 项）

**VERIFIED 0 / PARTIAL 28 / NOT_FOUND 9 / SUPERSEDED 3**。本计划未按原文实施；实际发布的是后继计划 `docs/superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md`（PR #240–#245）的库内子集。要点：resolver、release gate、evidence ledger、claim cluster、evaluation、ontology proposals 均**无生产调用方**；`advanceLearningAuthorizationEpoch` 生产路径从未调用（撤权不会触发）；没有 release/withdraw 的 REST 路由，也没有把版本推进到 validated/active 的路径；自动晋升按后继计划显式推迟。本轮据此修复了其中一个可独立收敛的完整性缺陷（R9：受保护行正文被重放覆盖），其余按缺口记录，不宣称「RSI 证据闭环已上线」。

### 7.5 历轮审计声明的未决缺口

| 缺口 | 本轮状态 |
|---|---|
| 物理 HIL | 从未测试；本轮产线治理 44/44 使用 `simulated=true` 影子/模拟驱动，不是物理证据 |
| Mimosa 安全扫描 | 历轮 inconclusive，本轮提交时钩子亦报 `scanner_enobufs`；**不宣称安全通过** |
| 外部 IDD / RAG / MES 真机 | 本机未运行这些服务，相关套件 NOT_RUN；IDD/RAG 插件仅静态与单测覆盖 |
| UI 全量交互回归 | 本轮补 27 路由 × 双主题渲染走查（0 错误/0 溢出）与 console 建频道交互；完整点击/键盘回归仍未覆盖 |
| 容量与并发 | 容量闸可配，单实例串行执行锁是显式设计；大规模并发未测 |
| 计划签署 | Project 层 M10 要求 Owner/Security/QA/Ops 四角色签字，当前只有 AI 签署，人工 Owner 仍「待签署」 |
| Project 计划 A–I 段 | 本轮未逐项核对（见 §7.2） |

## 8. 已知限制与未覆盖面

| 项 | 口径 |
|---|---|
| 水合不一致（R7） | 既有设计问题：SSR 无会话身份、客户端水合后切换登录态；表现为控制台类页面偶发 `Hydration completed but contains mismatches`，功能断言全部通过。修复需 SSR 会话身份方案，本轮不做 |
| 物理 HIL | 未测试；全部产线为 `simulated=true` 或 mock 驱动 |
| 外部 IDD / RAG / MES | 本轮本机未运行这些服务，相关套件未执行，不作通过声明 |
| 真实 LLM 作业 | 本轮未跑真实模型回合；频道/任务链以 mock harness 验证 |
| Mimosa 安全扫描 | 本轮未执行；不宣称安全通过 |
| 签名/HIL 认证 | 安装器未签名；软件 PASS 不等于安全认证 |
| 计划签署 | Project 层计划 M10 要求的 Owner/Security/QA/Ops 四角色签字仍缺人工 Owner 签署 |

## 9. 证据索引

- 门禁：`logs/gates-summary.txt`、`logs/gates-summary-2.txt`、`logs/*.log`
- API 探测：`evidence/route-table.json`、`evidence/api-sweep-run3.json`、`evidence/get-latency-profile.json`
- 串区复现与修复后 UI：`evidence/regression-default-workspace-leak.json`、`evidence/console-mount/`
- UI 走查：`evidence/ui-walk/`
- 水合探针：`evidence/hydration/`
- 需求追溯：`evidence/trace-project-JM.md`、`evidence/trace-*.md`
- 本轮私有目录（不入库）：`D:/tmp/aw-release-acceptance/`
