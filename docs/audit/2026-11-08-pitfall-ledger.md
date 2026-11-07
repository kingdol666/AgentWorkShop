# 测试过程问题与坑总账（2026-11-08）

> 范围：本会话全系统审计 + 2026-11-05 → 2026-11-08 记忆中的测试问题/坑。
> 分类：**真缺陷（已修）** / **测试基建坑（已修或已沉淀）** / **设计预留（如实未修）**。
> 基线：`main @ cd874522`（本轮 5 个 PR 合并后，main CI `quick-gate` success）。

## 1. 真缺陷（本轮修复，按 PR）

| ID | 问题（现象） | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| D-1 | 多工作项交付物的项目永远无法 `complete`（L8 永远 409 `DELIVERABLES_INCOMPLETE`） | `uq_project_result_approved` 唯一索引按交付物共享槽位；批准新工作项会把其他工作项的 approved 挤成 superseded → `deliverableAcceptanceReady`（每工作项需 approved）不可满足 | **PR #82**：索引加 `work_item_id` + `migrateApprovedSlotScope` 迁移；同工作项版本替换语义保留 | 单测 3/3；生命周期 demo L8-1 通过 |
| D-2 | 重复创建工作项返回 500 | UNIQUE 约束异常未捕获 | **PR #82**：结构化 409 `WORK_ITEM_EXISTS` | 单测 3/3 |
| D-3 | 手动 + 自动/重试并发派发同一工作项：双建实例 Channel（败者留启用态孤儿）；attemptNo 竞争撞唯一索引 → 工作项永久 BLOCKED | 实例创建在 CAS claim 之前；唯一冲突落入“无 attempt”分支 | **PR #84**：同工作项派发串行链；attempt 唯一冲突映射为可重试 `WORK_ITEM_IN_FLIGHT`；输家交还指针并回收自建实例 | 单测 DA-1..3；实机 V1（双派发恰一次成功、唯一 attempt/session） |
| D-4 | 关闭会话后 clone 仍持有信箱/进程（僵尸克隆）；关闭会话的 clone 仍可被寻址重装配 | close 只 `cancelTree`，不 abort 当前回合；`unloadAgent` 被 idle/pending 闸门挡住 | **PR #86**：close 对 cancelTree 返回的每个任务 `abortTask`；clone `enabled=0`；强制 `stopAndDetach`；装配守卫（频道停用/会话 closed 拒绝重装配） | 单测 S-C/S-E/LH-1/2；实机 V2（closed + enabled=0 + 拒新消息） |
| D-5 | 任务实例 lead 的 brief / 工作项 / 成果读面恒为空集 | 提交侧已双通道（模板频道 ∪ 实例频道），读面只比模板 `channelId` | **PR #86**：`w.instanceChannelId === ctx.channelId` 认领；成果按工作项归属判定；他频道仍读不到未批准成果 | 单测 R-1/R-2；实机 V3 |
| D-6 | omp 压缩摘要没有平台 session 戳，`scope=session` 检索不命中 | omp 内部 session 与平台 `cs-*` 未打通，harvest 不传 sessionId | **PR #86**：桥内按 `memberMap` 反查 manual/task 会话补 `sessionId`（排除 project 恒等映射） | 单测 S-E；既有 inject-v2 24/24 |
| D-7 | lead 卡 busy 时 D1 救援无条件跳过，滞留 root 永不被救援 | busy 一律视为健康长回合 | **PR #86 / WP9**：`continuity.lastUsedAt` 超阈值才视为 busy-stuck；`AW_RESCUE_BUSY_STUCK_MS` 可覆盖 | 单测 LH-3 |
| D-8 | 任务实例回收时 close/disable 的 403/404 被吞，会话永远 active | catch 空实现 | **PR #86**：Channel 行/owner 缺失时直接收敛会话行 + 直写停用；失败可观测 | 代码审查 + 单测覆盖 |
| D-9 | `recipe_apply` / `recipe_propose` 的 Agent 正式下发写账 `source=recipe`，审计归因丢失，Agent 互斥/回退冷却方向性被跳过 | 可信 `DcwWriteMeta` 只在 `trial=true` 构造，且两个工具不传 `agentTrialMeta` | **PR #87**：`agentDispatch && agentTrialMeta` 即构造；两个工具补齐 actor/taskId/executionMode（propose 带 hypothesis） | 单测 B-P1-5 |
| D-10 | 无 Channel 归属的 HITL 待办可被任意登录用户裁决（审批旁路） | `!manager || !channelId` 直接 return（fail-open） | **PR #87**：运行时不可用 503；无归属仅 admin；正常归属保留可见性 + `requireCanApprove` 双检 | 单测 H-1..4 |
| D-11 | 调度器重复派发/汇总时 `WORKING→WORKING` 抛 `INVALID_TRANSITION` 假错误 | `TRANSITIONS` 不含自迁移 | **PR #88**：WORKING 自迁移幂等 no-op；终态自迁移仍拒绝 | 单测 T-1 |
| D-12 | V2 压缩验收在并行套件下偶发假阴性 | 只等压缩层出现，filler 可能仍在 recent 窗口 | **PR #85**：轮询组合终态（压缩层 + pinned + filler 离开 recent），超时 60s | 验收脚本重跑 24/24 |
| D-13 | 隔离实例 boot 期 401 级联 + 迟到登录框 | 宿主异步驱逐 cookie 罐，单通道 cookie 认证崩 | **PR #68（前轮已合）**：token 双通道（cookie + localStorage）+ 401 单次自愈重试 | 前端验证轮 |
| D-14 | 多级任务树聚合证据无法提交（`EVIDENCE_UNVERIFIED`） | 证据回溯只到 root，不含后代 | **PR #80（前轮已合）**：递归 CTE 回溯 root + 全部后代，三个调用点成对传入 | 实机 S5-7；回归 1189/1187/0 |

### 已确认“不是 bug”的治理语义
- `SELF_APPROVAL_FORBIDDEN`（owner 提交的成果 owner 不能批）——治理正确。
- `PROJECT_TASK_SCOPE_VIOLATION`（工具上下文必须用实例频道 lead + 完整 task uuid）——范围校验正确。
- `CHAT_DISABLED` 409、`REGISTRATION_CLOSED`、`PROJECT_STATE_INVALID`——预期治理门。
- 失败工作项契约锁定（FAILED/COMPLETED 不可 PATCH）——改预算需新建工作项，属接口约束。

## 2. 测试基建坑（已修/已沉淀）

### 2.1 HTTP / API 脚本
| 坑 | 现象 | 处置 |
|---|---|---|
| `api()` GET 传 `null` | `JSON.stringify(null)` → Node 24 拒绝 GET body → 所有 GET 静默空数组（轮询永远 pending、误建重复项目） | 4 个脚本已修；规则：`body == null` 不序列化；新脚本统一 `body === undefined/​null ? undefined : ...` |
| `api()` 第 4 参 | 传裸 token 字符串（实际是 headers 对象）→ 全线 401 | 脚本统一 `{ authorization: Bearer ... }` |
| 频道字段名 | 创建返回 `channelId`，列表返回 `id`；混用会让评审频道收 0 条消息 | 按端点区分 |
| `chatEnabled` | 建频道时传参不生效 | 建后 `PATCH { chatEnabled: 1 }` |
| 审批 body | `decide` 键是 `approve`（不是 `approved`）；review decision 枚举是 `reviewed`/`rejected` | 统一按 API |
| agent 提交 | 必须完整 task uuid + **实例频道** lead；8 位前缀 → `CONTEXT_MISSING`，基础频道 lead → `SCOPE_VIOLATION` | 从 observability `instanceChannelId` 取实例频道 |
| owner 提交 | owner 提交的成果 owner 不能批（`SELF_APPROVAL_FORBIDDEN`） | agent 作者持证提交 |
| terminate | `{}` body → `reason: Required` | 带 reason |
| 事件类型 | 无 `project.created` 类型 | 断言用 `work.*`/`result.*`/`approval.*` |
| parts 数组 | `String(parts)` = `[object Object]` | `parts.map(p => p.text).join('')` / `JSON.parse` |
| 成果频道 | `project_results.channel_id` 恒为模板频道，不是实例频道 | 查 session 戳/成果时按工作项归属，不要按实例频道直查 |
| 会话戳位置 | 任务终态记忆在**任务实例频道**的 clone 上，不是基础频道 clone | 全实例频道扫描 |
| 压缩 filler | mock 回执会引用人类消息前 80 字符；filler 必须 >80 字符 | 用长填充句 |
| 压缩指针 | 消息 id 是 randomUUID 不可比 | 用 rowid |
| 会话历史 | 旧版无 `GET /sessions/:sid/messages`（前端拉全频道 500 条本地过滤） | 已有 `history.get.ts`；新代码用历史端点 |
| 重试风暴 | 反复失败探针触发平台 IP 扫描保护（403 retry-after ~587s） | 探针 pid/draft 空即退出；重启实例清除 |
| `routingPolicy` | REST 创建默认 `technical`，Agent 工具路径曾为 `legacy` | P0-7 已统一；快照透出（PR #63） |
| 工作项去重 | 同标题重复创建曾 500 | D-2 已修结构化 409 |
| 交付物多工作项 | 同交付物多工作项必须给独立 `resultKey`，否则“成果槽有多个生产者”静默 `apply_failed` → activate 409 | 计划/模板必须分 key |
| 交付物门 | CANCELED/DRAFT maxed 工作项会永久卡交付物门禁 | 用 replan 新 dedupeKey 重建，或 owner 取消 |
| G-1 假交付 | `work.completed` 由 reconciler 在 root COMPLETED 时自动打标；完整任务 ≠ 有产物 | 核查三连：`tasks.artifacts_json` 长度 + `project_results.payload` 长度 + 全盘 sha；以“已核验成果”为准 |

### 2.2 运行时 / harness
| 坑 | 现象 | 处置 |
|---|---|---|
| omp 长输出 | `promptTimeoutMs` 默认 600s → 长 HTML 纯生成被 `TURN_STALLED`；深层是重启后 session 不重绑 | lead config 调大 `promptTimeoutMs`；杀进程可复活卡死回合；重绑目前是观测面问题（见 §3） |
| mock 行为 | mock lead 秒完成、不吃 delayMs；mock 不消费普通消息（只吃 assign/nudge） | 队列/多会话消费验证必须用 omp；并发窗口用 `[mock:complex]` + worker `delayMs` |
| `complete_task` | Agent 只交摘要，workspace 文件不进 artifact | 真实文件补挂为 task artifact 再提交 |
| Leader criteria | Leader 计划常不写结构化 `acceptanceCriteria` | prompt 已强制；owner 可事后 PATCH 交付物 |
| 评审冷启动 | 评审 Channel 空闲被卸载，L1 首轮约 10 分钟 | 仍未完全解决（§3） |
| D1 救援 | busy-skip 盲区 | D-7 已修 |
| 状态机 | `WORKING→WORKING` 假错误 | D-11 已修 |
| build 竞态 | 构建与服务共用 `.output` 会让运行中进程 500 | 先停服再 build |
| 实例守卫 | 一个 AW_HOME 只允许一个写者；3001/3002 有旧实例 | 新实例用独立 home/端口；不要误判旧实例 |
| 备份 | 备份 `dirBytes` 冻结事件循环 | `BACKUP_DISABLED=1` |
| 认证 | 嵌入式浏览器宿主异步驱逐 cookie | 双通道 token（D-13）；排查看 `performance.getEntriesByType('resource').responseStatus`，不要用 `document.cookie` |
| puppeteer | `file://` + `networkidle2` 挂死；并发 chrome 互相卡死 | `domcontentloaded`；顺序跑 + 输出重定向文件 |
| `.nuxt` 竞态 | typecheck（nuxi prepare）与单测并行会让 `tsconfig.server.json` 短暂不可读 | typecheck 与测试**顺序执行** |
| 包管理器 | junction worktree 下 `pnpm run` TTY 失败 | 直接 `node scripts/...` / `npx tsx ...` |
| 单测命令 | `node --test` 对目录导入失败 | `npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/*.test.ts` |
| Windows 路径 | heredoc 反斜杠被吞（`C:Program Files...`） | 正斜杠路径 / 环境变量 |
| 大文件移动 | 手写转录必坏 | Read 全文 → Write → diff 对账 |
| 合并残留 | 合并会“复活”main 已删除代码；被杀测试进程留陈旧 ablation 模块 | P0 回归测试做探针；删除陈旧模块 |
| gh 合并 | graphql 瞬断 | REST `gh api repos/:o/:r/pulls/:n/merge -X PUT`；SSH push 兜底 |
| 工作树 | paper 工作树是旧基座 | 源码改动只在 origin/main worktree |
| demo 账号 | users.sqlite 可直接改 `password_hash`（salt:hash，scryptSync） | 仅本地演示 |
| bench | `AW_IDENT_GATE=0` 必入环境块；SIM 端口 offset；`controlMode` 缺省 manual；影子模拟器需 `ensureScenarioLine`；opencode 僵尸；`util.raw` 8×重试；E4 变值写；api-live 需 `AW_E2E_TOKEN` | 已写入 bench 记忆/流水线 |

### 2.3 UI / 视觉验收
| 坑 | 现象 | 处置 |
|---|---|---|
| `vpTier` 就绪门 | 裸布局页缺少 `<html data-vp-tier>` → 视觉/E2E 90s 超时 | 布局层保留 `useResponsive()` |
| 反色按钮 | 暗色下写死白字 = 白底白字 | 前景用 `var(--chat-canvas)` |
| antd 进度条 | `strokeColor` 不识别 CSS var | 自绘 div 进度条 |
| 截图假 pass | wsId undefined → 空态截图被当通过 | 显式建 workspace + 挂载 + 等 DOM；断言脚本化 |
| 并发截图 | 并发 chrome `protocolTimeout` 假死 | 顺序跑 |
| 残留进程 | 旧进程锁 tmp home → `rmSync EPERM` | 先杀干净再跑 smoke |

## 3. 设计预留 / 如实未修

| 项 | 现状 | 建议 |
|---|---|---|
| `memoryPolicy` 字段 | 建表/Repo/DTO 已透出，但无任何消费（S3 预留） | S3 前删除透出面或显式标注“预留”；不要在 UI 当可用旋钮 |
| 容量闸 | `{ perChannel: 1, perProject: 4, perTick: 2 }` 硬编码 | 复用 `workshopSettings()` 暴露；`perChannel` 必须保持 1（每实例 Channel 单根） |
| `submitChannelTask` | 无 `sessionId` 路由；人类频道任务不落会话 | S2/S3 补 sessionId 路由 |
| omp `promptTimeoutMs` | 只 per-agent config，未入 `workshopSettings()` | 设置面暴露 |
| omp 重启 session 重绑 | prompt RPC 不携带 sessionId，仅 continuity 记账 | 观测项；不是执行阻塞 |
| 评审 Channel 冷启动 | 空闲卸载后首轮 L1 约 10 分钟 | unload guard / 预热 |
| LLM 摘要压缩 | 当前为提取式压缩 | 后续开关 |
| 会话结束记忆降级钩子 | 未实现 | M3 |
| 跨 session 搜索工具 | 未实现 | M3 |
| 项目级记忆域 | `__team__` 按 channelId 键控；任务实例是全新 channelId → 旧任务经验新任务看不到 | 与 `memoryPolicy` channel 档绑成一个验收单元，否则“跨任务学习”预期落空 |
| 审批历史 `expiresAt` 展示 | 失真（P3） | 展示面修正 |
| 保写心跳持锁 | 长事务持锁（P3） | 缩短持锁 |
| omp-dialog 附言 | 人工附言不回注（P3） | 回注链路 |
| `scenarioPrompt` | 频道级，clone 原样复制（P3） | 会话级个性化 |
| `normParams` | 静默收编未挂线节点（P3） | 显式告警 |
| 交付物门 maxed 项 | CANCELED/DRAFT maxed 永久卡门禁（无 bypass/API 调 maxAttempts） | replan 新 key 是干净解；可考虑显式 waive |
| 安全扫描 | Mimosa 多次 `scanner_enobufs`，无完整结论 | **不宣称项目安全**；需完整扫描后再出安全结论 |

## 4. 合并后复验（2026-11-08）

- **main**：`cd874522`（#84 → #85 → #86 → #87 → #88 依次合并）。
- **CI**：main push run `42389931536` **success**（typecheck / lint / unit）。
- **全量单测（新鲜）**：`1207 tests / 1205 pass / 0 fail / 2 skipped`（`unit-main-fresh.txt`）。
- **构建**：`node bin/aw.mjs build` exit=0（`build.log`）。
- **实机复现**（新构建，独立端口 3996，`verify-pitfall-fixes.mjs`）：**17/17 PASS**（`verify.json`）
  - V1 并发双派发：一次 200 / 一次 409 `WORK_ITEM_IN_FLIGHT`；唯一 attempt；唯一 task session。
  - V2 会话关闭：closed + clone `enabled=0` + 关闭后新消息 409 `SESSION_CLOSED`。
  - V3 实例读面：实例 lead 读到本工作项与自己工作项的 draft 成果（修复前均为空）。
- **PR 列表**：#84 派发原子化、#85 验收稳定性、#86 生命周卫+读面+救援、#87 治理归因+HITL fail-closed、#88 状态机幂等；#82 槽位缺陷（前轮）。

## 5. 结论

- 本轮把“能杀死任务/让项目永远无法完成/审批旁路”的缺陷全部收敛并复验：槽位、派发原子化、会话关闭、读面对称、归因、HITL、状态机。
- 测试基建坑已沉淀为规则（§2），新脚本默认规避（null body、instance channel、parts、domcontentloaded、顺序执行）。
- 剩余项均为设计预留/可观测性/配置面（§3），未冒充已修；安全结论待完整扫描。
