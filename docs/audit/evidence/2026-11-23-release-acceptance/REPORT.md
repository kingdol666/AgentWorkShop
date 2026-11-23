# v0.18.0 发版验收与后端 API 审查报告（2026-11-23）

> 口径：本报告只引用本轮实际执行输出与证据文件；历史基线只作对照，不复制成当前结果。
> 未覆盖面在 §8 单列，不混入「通过」判定。

## 0. 结论

- **发布完成**：PR #283 合并到 `main`（`e8063553`，CI quick-gate 通过；合并后 main 的 CI 与文档站部署均成功）；tag/Release `v0.18.0`（latest）；npm `agentworkshop@0.18.0`；安装版桌面端已就地更新到 0.18.0。详见 §10。
- **修复 6 个 P1/P2 缺陷**（均有回归测试）：console「新建频道」跨工作区串区（P1）、11 个 REST handler + 数采推送 + A2A 方法的「先查资源后验身份」（P2，未鉴权 ID 枚举 oracle）、`dcw/line/query` 无窗口时对时序超表全表聚合（P2，共享 Timescale 实测 10–15 s）、已验证经验被同键重放改写正文（P2）、建频道时绑线授权校验晚于落库（P2）、A2A AgentCard 开关可被 RPC 旁路（P3 但属授权面）；另修 2 项 P3 界面可访问性/可读性、1 处套件漂移与文档漂移。
- **认证门禁**：unit **2306 / 2305 通过 / 0 失败 / 1 跳过**；lint、typecheck、cssvars、i18n、docs:check、readme、生命周期契约、skills、MCP、plugin-lifecycle、SDK、twin-provider 全绿。
- **API 面全量探测**：构建产物注册的 **503 个 handler** 经 **1060 次探测**（含 35 个带真实 ID 的详情读），**0 个 5xx、0 个连接错误**；10 个「管理员无效请求被接受」逐条定性（§5.3）。
- **实机演示**：串区修复在真实 console 弹窗上端到端证实；产线治理 **44/44**（HITL + 设备回读 + 回合来源门）；UI 走查 **54/54**（27 路由 × 明暗主题，0 错误 0 溢出）。
- **需求追溯**：README 40 条产品声明 33 条实现+测试互证；**三份计划都没有全部落地**——Project 层计划 192 项中完全验证 56 项（29%），上下文学习框架 46 项中完全验证 5 项，RSI 证据晋升计划 40 项中 0 项；逐项状态见 §7——计划文本的复选框全未回填，不能当作完成度证据。
- **安全扫描**：Mimosa 深扫有封印（29 项发现，覆盖状态 partial/inconclusive），**不构成安全通过**（§7.5）。

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
| 已安装桌面 | 审查阶段为 0.17.5（pid 65456，真实 home，未触碰）；发版后更新到 0.18.0，过程与证据见 §6.5 |

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
- **正式发布包**（从注册中心下载，sha1 `c57ea85b…` 与 `npm view` 一致）装入全新隔离前缀后：`GET /` → 200（32,200 B）；`GET /api/workshop/aml`、`/api/workshop/workspaces` 未鉴权 → 401；`/api/health` → `ok / 0.18.0 / workshop ready`。
- **会话密钥口径（更正文档表述）**：验收手册写「缺 `NUXT_SESSION_PASSWORD` 时拒绝启动」，实测 `aw start`（home 模式）在**不提供该环境变量**时照常启动——因为 `runBootstrap` 在首启时生成随机密钥写入 `<home>/.env` 并由 `preloadDotEnv` 注入；`server/plugins/security.ts` 的拒绝只在 `NODE_ENV=production` 且密钥为空/仓库默认值时触发。浏览器会话是服务端存储的不透明随机凭据（`randomBytes(32)`，库内只存哈希，可过期与吊销），不依赖该密钥；`server/` 业务代码没有 `seal`/`unseal` 调用。结论：**默认路径安全（靠生成随机密钥，而非拒绝）**，属文档不精确，不是漏洞。另：全局安装里直接 `node .output/server/index.mjs` 会找不到 `schema.json`，必须走 `aw start`。

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

### 6.5 桌面安装版 update（0.17.5 → 0.18.0）

**产物一致性**：`npm publish` 的 `prepublishOnly` 会重新构建，所以「先本地 `npm pack` 再打安装包」得到的两份 tarball 字节不同（本地 `4a82fb4e…` vs 注册中心 `c57ea85b…`）。为让 **npm 包 = Release 附件 = 安装包内后端** 三者同源，安装包是用注册中心下载的正式 tarball 装入隔离前缀后重新构建的；第一版安装包作废未发布。

**路径一：应用内更新（真实用户路径，本网络下未能完成）**

| 步骤 | 结果 |
|---|---|
| 应用自身的周期检查 | Release 发布后，运行中的 0.17.5 在下一次 30 分钟检查时亮出标题栏「更新 v0.18.0」 |
| 触发 | 通过 Windows UI Automation 按可访问名称定位该按钮并触发（不依赖调试端口、不重启应用）；下载开始 |
| 下载 | 更新器按设计**直连** GitHub 资产 CDN（`assertPublicHost` 拒绝非公网地址，不走本地代理）。本机直连实测 60–120 KB/s 且间歇停滞，20 分钟约 104 MB（≈25%）；更新器预算为 30 分钟，按此速度必然超时。同一资产经本机系统代理（127.0.0.1:7890）curl 实测 5.4 MB/s |
| 进度显示 | 标题栏显示 10% 时真实已 24%：CDN 重定向响应不带 `Content-Length`，进度按大小上限而非真实文件大小计算（显示问题） |
| 结论 | 在「直连 GitHub CDN 很慢、依赖系统代理」的网络下，应用内更新路径不可用。**这是既有限制，非本轮回归**；改进方向见 §8 |

**路径二：应用自身优雅退出 + 已校验安装包就地静默安装（已完成）**

| 步骤 | 结果 |
|---|---|
| 空闲确认 | 退出前 health：`activeChannels=0`、`wiredAgents=0` |
| 优雅退出 | 通过托盘菜单「退出 AgentWorkShop 0.17.5」（UI Automation，仅操作名称以 `AgentWorkShop` 开头的托盘图标）；状态文件先变 `phase: quitting`（后端服务先行停止），2 秒内进程自行退出；**全程未强杀任何进程** |
| 安装包校验 | sha256 `ee2c59ce…` = Release 资产 `SHA256SUMS.txt` |
| 残留检查 | 安装目录下无任何运行中的进程 |
| 静默安装 | `/S /D=<原安装目录>`，13 分 11 秒，退出码 0 |
| 重新启动 | 24 秒就绪：`version=0.18.0 pid=88792 service=online`，托盘已创建，用户设置原样保留（关闭到托盘等 5 项），`lastError=null` |
| 独立复核 | `/api/health` → `ok / 0.18.0 / workshop ready`，DAQ 链路在线；`resources/backend/package.json` = 0.18.0，exe 产品版本 0.18.0.0；未鉴权 `GET /api/workshop/agents/<不存在>` → **401**（本轮「先验身份」修复已在安装版生效） |

收尾：清除了被中断的应用内下载留下的 104 MB 不完整临时文件（我触发的下载；应用已是 0.18.0 不会再下载同版本）。

## 7. 需求追溯（文档声明的真实需求 vs 实现）

### 7.1 README 产品声明（40 条抽样）

33 条「实现 + 测试」互证；4 条有实现无测试（60s/300s 写入与审批默认值、串口插件行为、`/town` 3D 场景、调度 60s 下限）；2 条文档漂移（已修）；1 条待澄清（WS AEP v1 seq 续传未断言）。

### 7.2 Project 层计划（`docs/plans/2026-11-03-project-layer-plan.md`，验收清单 192 项）

D–F 段（47 项）：**VERIFIED 16 / PARTIAL 17 / SUPERSEDED 5 / IMPL_NO_TEST 5 / NOT_FOUND 4**。未找到：项目删除/purge（D7）、成果注入不得改变下一次决策（E13）、工作项状态机表驱动测试（F6）、BLOCKED 期间 root 完成的状态收敛（F9）。值得注意：所有 `tests/project-*.test.ts` 都把 `manager.submitProjectRoot` 打桩，真实 manager 侧派发代码没有被测试直接覆盖（F1）。

J–M 段（55 项）：**VERIFIED 14 / PARTIAL 36 / NOT_FOUND 3 / IMPL_NO_TEST 1 / SUPERSEDED 1**。未找到：性能 fixture（J8）、observe 影子运行报告（K15）、重复/双批准 SQL 断言（M3）。

A–C 段（45 项）：**VERIFIED 17 / PARTIAL 13 / NOT_FOUND 6 / IMPL_NO_TEST 6 / SUPERSEDED 3**。未找到：项目数据保留期清理（A8）、`db/schema.sql` 文档同步（A10）、Mandate 列 `mandate_json`/`mandate_digest`/`revalidated_at`（A15）、P0 后零回归的过程性证明（B6）、控制频道唯一 project_leader 的 409 守卫（C2）、`allow_leader_manage` 开关（C15）。部分实现的要点：`project_usage` 表未建（A1）、没有项目删除/purge（A9）、非 admin spawn 策略只有纯函数单测、入口接线未测（B1/B3）、绑定产线频道没有 grant 校验（C13）。

**已核对 147 项（A–C、D–F、J–M）小计**：VERIFIED 47 / PARTIAL 66 / NOT_FOUND 13 / IMPL_NO_TEST 12 / SUPERSEDED 9。所有 `tests/project-*.test.ts` 都把 `manager.submitProjectRoot` 打桩，且没有测试经过 `dispatchHostTool`——真实 manager 侧派发与工具分派路径未被测试直接覆盖。逐项明细见 `trace-project-AC.md`、`trace-project-DF.md`、`trace-project-JM.md`。

G–I 段（45 项）：**VERIFIED 9 / PARTIAL 22 / IMPL_NO_TEST 7 / SUPERSEDED 4 / NOT_FOUND 3**。未找到：人工接管/暂停 leader 的 override API（G17）、项目级 SSE 实时更新（I10，页面靠 `setInterval` 轮询）、项目中英文案一致（I12——`projects/index.vue` 与 `[id].vue` 没有任何 `$t(`，文案为硬编码中文）。值得注意的部分实现：`project_leader` 运行时从未获得 SchedulerLoop（G1，无测试）；pause/archive 不会卸载 leader（G3）；没有项目级截止期与预算/频道数上限、`project_usage` 表未建（G13/G14）；五个计划内提示词文件缺三个（H1）；19 个 `project_*` 工具中 14 个没有英文工具定义（H8）；决策/事件/成果列表没有分页或过滤（I3）；Trace 只有 API、页面不调用（I16）。该段所有 UI 项都没有自动化测试，只有 Puppeteer 实机脚本触及页面。

**192 项合计：VERIFIED 56（29%）/ PARTIAL 88 / NOT_FOUND 16 / IMPL_NO_TEST 19 / SUPERSEDED 13。**

### 7.3 上下文学习框架（`docs/plans/2026-11-13-…`，46 项）

**VERIFIED 5 / PARTIAL 34 / NOT_FOUND 4 / IMPL_NO_TEST 1 / SUPERSEDED 2**。整个 Task 2（extension 注册/校验/发布/退役与本体桥）未实现；框架是默认关闭的 `rsi-interface-beta` 只读切片，无 REST/MCP/UI 暴露；验收脚本只导入 Node 内建模块、不调用框架本体，其「9 个 profile PASS」证明的是 harness 而非框架。

### 7.4 RSI 证据晋升计划（`docs/plans/2026-11-17-rsi-evidence-promotion-product-memory-plan.md`，40 项）

**VERIFIED 0 / PARTIAL 28 / NOT_FOUND 9 / SUPERSEDED 3**。本计划未按原文实施；实际发布的是后继计划 `docs/superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md`（PR #240–#245）的库内子集。要点：resolver、release gate、evidence ledger、claim cluster、evaluation、ontology proposals 均**无生产调用方**；`advanceLearningAuthorizationEpoch` 生产路径从未调用（撤权不会触发）；没有 release/withdraw 的 REST 路由，也没有把版本推进到 validated/active 的路径；自动晋升按后继计划显式推迟。本轮据此修复了其中一个可独立收敛的完整性缺陷（R9：受保护行正文被重放覆盖），其余按缺口记录，不宣称「RSI 证据闭环已上线」。

### 7.5 历轮审计声明的未决缺口

| 缺口 | 本轮状态 |
|---|---|
| 物理 HIL | 从未测试；本轮产线治理 44/44 使用 `simulated=true` 影子/模拟驱动，不是物理证据 |
| Mimosa 安全扫描 | 本轮对发布树（与合并后 main 逐文件一致）执行深度扫描：封印 `sha256:db9489b2d49483a3559047881c3daec500ea230adc751ac7303ac098fcbd765b`，29 项发现（high 16 / medium 13，分布在 14 个文件），依赖核查完成（扫描 303 个包，命中 0 / 未知 0）；覆盖状态 `partial`、运行状态 `inconclusive`（调用图部分不完整）；证据边界为静态扫描。29 项里 1 项落在本轮改动过的文件（`a2a/[agentId]/rpc/index.post.ts:434`，「dispatch 经 1 跳到达 path-traversal」），该行不是本轮新增或修改的行。提交/推送钩子每次仍报 `scanner_enobufs`。**只报封印与计数，不构成安全通过** |
| 外部 IDD / RAG / MES 真机 | 本机未运行这些服务，相关套件 NOT_RUN；IDD/RAG 插件仅静态与单测覆盖 |
| UI 全量交互回归 | 本轮补 27 路由 × 双主题渲染走查（0 错误/0 溢出）与 console 建频道交互；完整点击/键盘回归仍未覆盖 |
| 容量与并发 | 容量闸可配，单实例串行执行锁是显式设计；大规模并发未测 |
| 计划签署 | Project 层 M10 要求 Owner/Security/QA/Ops 四角色签字，当前只有 AI 签署，人工 Owner 仍「待签署」 |

## 8. 已知限制与未覆盖面

| 项 | 口径 |
|---|---|
| 水合不一致（R7） | 既有设计问题：SSR 无会话身份、客户端水合后切换登录态；表现为控制台类页面偶发 `Hydration completed but contains mismatches`，功能断言全部通过。修复需 SSR 会话身份方案，本轮不做 |
| 物理 HIL | 未测试；全部产线为 `simulated=true` 或 mock 驱动 |
| 外部 IDD / RAG / MES | 本轮本机未运行这些服务，相关套件未执行，不作通过声明 |
| 真实 LLM 作业 | 本轮未跑真实模型回合；频道/任务链以 mock harness 验证 |
| Mimosa 安全扫描 | 已执行深度扫描并取得封印，但覆盖为 partial/inconclusive（§7.5）；**不宣称安全通过** |
| 应用内更新（桌面） | 更新器直连 GitHub 资产 CDN、不支持系统代理、下载预算 30 分钟、不支持断点续传：在直连很慢的网络下 416 MB 安装包无法在预算内下完（本机实测 60–120 KB/s，经系统代理可到 5.4 MB/s）；CDN 不带 `Content-Length` 时进度百分比按大小上限计算而偏低；下载中途退出应用不会清理不完整临时文件。本轮桌面更新因此改走「托盘优雅退出 + 已校验安装包静默安装」。这些是待改进项，未在本轮修改 |
| 模板实例化不挂载（既有） | `app/pages/workshop/channel-templates.vue:150` 从模板实例化频道后不挂到任何工作区，这些频道在按工作区作用域读取的 console 里不可见；本轮只修了 console「新建频道」弹窗与 REST 缺省路径，模板路径未改（独立审查 P3，留待下轮） |
| 项目页未国际化（既有） | `app/pages/projects/index.vue` 与 `[id].vue` 没有任何 `$t(`，文案为硬编码中文（计划核对 I12）；本轮未改 |
| 签名/HIL 认证 | 安装器未签名；软件 PASS 不等于安全认证 |
| 计划签署 | Project 层计划 M10 要求的 Owner/Security/QA/Ops 四角色签字仍缺人工 Owner 签署 |

## 9. 证据索引

- 门禁：`logs/gates-summary.txt`、`logs/gates-summary-2.txt`、`logs/gates-summary-4.txt`、`logs/*.log`（本机 `D:/tmp/aw-release-acceptance/`）
- API 探测：`route-table.json`、`api-sweep-run3.json`、`get-latency-profile.json`（本目录）
- 串区复现与修复后 UI：`regression-default-workspace-leak.json`、`console-mount-results.json`、截图 `01`–`04`（本目录）
- UI 走查：`ui-walk-index.txt`（54 张截图在本机 `evidence/ui-walk/`）
- 水合探针：`hydration-report.json`
- 产线治理：`e2e-line-governance.log`
- 需求追溯明细（本目录）：`trace-readme-claims.md`、`trace-project-AC.md`、`trace-project-DF.md`、`trace-project-GI.md`、`trace-project-JM.md`、`trace-context-framework.md`、`trace-rsi-plan.md`；独立代码审查 `trace-code-review.md`
- 遗留证据入库清单：`evidence-intake-manifest.json`（脱敏 14 处、剔除 4 个工具目录）
- 桌面更新：`logs/desktop-inapp-update.log`、`logs/desktop-install-local.log`（本机）
- Mimosa：本机 `D:/tmp/aw-release-acceptance/mimosa-scans/scan-2026-11-23T12-11-23.891Z-0e926c016af7/`（`findings.json`、`coverage.json`、`seal.json`、`report.md`）

## 10. 发布记录

| 项 | 值 |
|---|---|
| 合并 | PR #283（9 个提交）→ `main` `e8063553`；PR CI quick-gate 通过（4m43s）；合并后 main 的 CI 与 Deploy Docs 均 success |
| 标签 | `v0.18.0` → `e8063553` |
| npm | `agentworkshop@0.18.0`，shasum `c57ea85b904520aec5adea506f5c8cd42a21cb5e`，`npm view` 与注册中心 tarball（HTTP 200）一致 |
| GitHub Release | `v0.18.0`（latest，非草稿/非预发布），发布于 2026-11-23T11:59:02Z |
| 附件 | `agentworkshop-0.18.0.tgz` 45,437,926 B，sha256 `1cdaf2f2481dade4d0ac9abdaedc524e4cd0d4de06efeb5345d8006c0d5ded37`（= 注册中心 tarball）；`AgentWorkShop-Setup-0.18.0-win-x64.exe` 416,654,810 B，sha256 `ee2c59ce0f4324571c6efa8a208ea37ac8dec8c2abf32091e2a422d099024196`；`SHA256SUMS.txt`（远端与本地逐字节一致） |
| 安装包来源 | 用注册中心正式 tarball 装入隔离前缀后构建，内嵌后端 0.18.0（`desktop/build.mjs --backend <prefix>/node_modules/agentworkshop`） |
| 本地 `main` | 已快进到 `origin/main`（纯引用更新；主工作树当时在论文分支上，未触碰） |
