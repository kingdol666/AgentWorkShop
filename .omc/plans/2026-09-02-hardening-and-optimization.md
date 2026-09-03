# AgentWorkShop 稳定性加固与性能优化计划

- **状态**: `pending approval`（本文件仅为计划；未经批准不执行任何代码改动）
- **日期**: 2026-09-02
- **适用范围**: 仓库根 `D:\codes\ABO\AgentWorkShop`（Nuxt 4 / Nitro / node:sqlite）
- **前置**: 需与当前并行开发会话协调（见「风险与协调」），避免双写冲突

---

## 1. 需求摘要

对 AgentWorkShop 做一次**代码审计驱动的加固与优化**：解除当前构建阻断 → 消除多实例/备份导致的
SQLite 锁崩溃 → 为无保留策略的表补保留机制 → 降低热路径 CPU/IO 浪费（全表扫描、JSON 整文件
读写、历史整列重写）→ 治理残留进程。所有改动保持**行为兼容**（默认值不变、配置驱动、env 可调）。

审计结论：架构整体优秀（事件批量刷盘、有界环形缓冲、调度空闲退避、微服务式插件都已有意识设计）；
问题集中在**运行时防护缺失**与**增长型资源浪费**，不涉及核心协议重构。

---

## 2. 完整问题清单（已核实，含证据）

> 每条均经源码/实测核实。`[实测]` = 本次会话真实复现。

| ID | 级别 | 问题 | 证据（文件:行） |
|---|---|---|---|
| **BLD-1** | 🔴 阻断 | **生产构建必失败**：`app/config/index.ts` 使用 `join` 但未 import `node:path` | `app/config/index.ts:23`（`join(...)` 调用）；imports 段 L1-12 无 `join`。[实测] `aw build` exit 1：`join is not defined` |
| **ST-1** | 🔴 | **多实例共享 `data/` → SQLite 锁 → 整进程退出**：无单实例互斥；`dev-stability-guard` 把非 socket 异常一律 `process.exit(1)`（"database is locked" 非噪声 → 必死） | `server/plugins/workshop.ts:92`（打开共享库）；`server/plugins/dev-stability-guard.ts:33-40`（uncaughtException → exit(1)）；[实测] 双实例同开 `workshop.sqlite` → `database is locked` → 崩溃 |
| **ST-2** | 🔴 | **备份用 `VACUUM INTO` 在线库 + 30min 保留清理，与主写者抢锁** | `server/plugins/backup.ts:30`（VACUUM INTO）；`server/services/workshop/daq/storage/sqlite.adapter.ts:54-62`（30min retention sweep）；[实测] 日志 `[daq-tsdb] 保留期清理失败: database is locked` |
| **ST-3** | 🟠 | **node:sqlite 全同步 → 大查询阻塞事件循环**（WS/HTTP 同进程，无分片） | `server/services/workshop/db/database.ts:16,627`（DatabaseSync）；各 repo `prepare().all()/get()` 同步执行；`server/api/workshop/ws.ts:224-265`（同一事件循环推送） |
| **ST-4** | 🟠 | **孤儿进程堆积 + 端口占用无人提示**：残留 dev 实例互相占端口/锁库；`dev-guard` 在端口被占时**静默换端口**导致"找不到服务器" | `scripts/dev-guard.mjs`（端口占用自动换端口逻辑）；[实测] 会话内累积 26+ 残留 nuxt/dev 进程、dev 落在 3117 |
| **GROW-1** | 🟠 | **`audit_log` / `messages` / `approval_history` 无保留策略**（只插不删，磁盘+查询长期退化）。channel_events 与 daq samples **已有**保留（勿重复加） | grep 证实：仅 `channel_events`（`server/api/workshop/ws.ts:39,451`，默认 7 天）与 `daq_samples`（`sqlite.adapter.ts:62`）有 DELETE；`messages`/`audit_log`/`approval_history` 全库无 DELETE 语句 |
| **PERF-1** | 🟠 | **热路径反复 `repo.all()` 全表扫描**：status/metrics 同函数内 3-4 次全量遍历 | `server/services/workshop/daq/daq-controller.ts:469,479`（相邻两行分别 `all().length`、`all().filter().length`）；另见 L254/262/271/536/588/694；`dcw-controller.ts:115,222,234,244,276,377` |
| **PERF-2** | 🟡 | **JSON 仓库整体读写**（启动整文件 load + 1.5s 防抖整文件 write），写放大 O(节点数)/次；多实例并发写互相覆盖 | `server/services/workshop/dcw/dcw-node.repo.ts:18-27`（load）、`61-67`（防抖）、`76`（整文件 writeFileSync）；同模式：`daq-node.repo.ts:83`、`device-twin.repo.ts:72` |
| **PERF-3** | 🟡 | **任务历史整列 JSON 重写**（有界但 O(n²) 写放大；代码已自认并有 CAP） | `server/services/workshop/runtime/task-engine.ts:409-414`（注释明言"每事件整列重写…O(n²)…在此收口"） |
| **ARCH-1** | 🟡 | **`manager.ts` 2380 行 god-object**（116KB）：装配/调度/回收/总线/权限全收口 | `server/services/workshop/runtime/manager.ts`（2380 行，`wc` 实测） |

### 已核实为"设计合理、勿动"（防止过度修复）

- WS 事件**400ms 单事务批量落库**、环形缓冲双封顶、单次序列化广播 —— `ws.ts:242-264`
- channel_events **7 天保留** + 死流回收 + 总线重订自愈 —— `ws.ts:445-460,467-487,400-443`
- 调度器**指纹空闲退避（≤8s）+ wake 唤醒** —— `scheduler-loop.ts:57,119`
- 记忆检索 **LIMIT** 已存在 —— `server/services/workshop/db/memory.repo.ts:48`
- 全部后台定时器 `unref()`、DAO TSDB 批量攒写 + 背压丢帧 —— `daq-controller.ts:206-231`

---

## 3. 实施步骤（按阶段；每步含验收）

### Phase 0 — 解除构建阻断（BLD-1）

- **0.1** 修复 `app/config/index.ts`：在 imports 段补 `import { join } from 'node:path'`。
  - 文件：`app/config/index.ts`（第 1-12 行 import 区块）。
  - ⚠️ 该文件当前由并行会话编辑，**先确认其最新内容再改**。
- **0.2** 冒烟：`pnpm build`（或 `node bin/aw.mjs build`）。

**验收 0**：干净状态下 `aw build` 退出码 0 且生成 `.output/server/index.mjs`；`aw config list` 正常。

### Phase 1 — 单实例互斥 + 端口治理（ST-1 / ST-4）

- **1.1** 新建 `scripts/lib/single-instance.mjs`（零依赖）：
  - `acquireLock(root)`：在 `<root>/.runtime/aw.lock` 写 `{pid, startedAt, mode, port}`（`wx` 原子创建）；已存在且 PID 存活 → 返回冲突信息。
  - `releaseLock(root)`：进程退出时删除（`close`/`exit` 兜底）。
  - `checkPort(port)`：端口占用探测，返回占用进程信息。
- **1.2** 接入三个启动入口：`scripts/start.mjs`、`scripts/dev-guard.mjs`、`cli/commands/start.mjs`、`cli/commands/dev.mjs`：
  - 启动前 `acquireLock`；失败 → 打印"已有实例在运行（pid/端口/模式）"并退出码 2。
  - dev 端口被占：**明确报错**（含占用 PID）而非静默换端口；用户可用 `aw dev --port N` 显式指定。
- **1.3** `aw doctor` 增加：列出 `.runtime/*.lock` 与残留 dev 进程（按命令行匹配 `bin/aw.mjs dev`/`nuxt dev`）。

**验收 1**：同仓双开 `aw start` → 第二个 ≤5s 退出，退出码 2，报错含首个实例 PID；`aw dev` 在 3000 被占时不再静默换端口；`aw doctor` 能列出残留 dev。

### Phase 2 — 备份与保留清理的锁竞争消除（ST-2）

- **2.1** `backup.ts`：`VACUUM INTO` → `node:sqlite` 的 **backup API**（`new DatabaseSync(src).backup(dest)`，Node ≥23.4 已具备）；失败（锁/忙）时**跳过并记录**，不抛中断。
- **2.2** 备份与 `daq`/`ws` 的 30min 清理**错峰**（如清理偏移随机分钟数），清理前先 `wal_checkpoint(TRUNCATE)` 降低锁窗口。
- **2.3** `sqlite.adapter.ts` 的 `sweepRetention` 包 try/catch + 忙判定（`SQLITE_BUSY` 时延后重试而非连续报错）。

**验收 2**：活跃写入下连续触发 3 次备份全部成功；30min 日志窗口内 `database is locked` 由"每次必现"降为 0（用 grep 断言新日志）；既有 `backup` 目录结构兼容旧快照。

### Phase 3 — 增长治理（GROW-1）

- **3.1** 为 `audit_log`、`messages`、`approval_history` 增加保留批量清理，复用 `channel-event.repo.ts:93-98` 的带头/分批 DELETE 模式：
  - 新文件 `server/services/workshop/db/retention.ts`（单入口）。
  - 默认保留：`messages=30d`、`audit_log=90d`、`approval_history=180d`（历史主张不可变，放宽；audit 合规默认 90d）。
  - env 可调：`AW_MESSAGES_RETENTION_D` / `AW_AUDIT_RETENTION_D` / `AW_APPROVAL_RETENTION_D`。
  - 接入 `manager.ts` 现有 6h 维护定时器（`manager.ts:310-318`）一并调用，或独立 24h 定时器（unref）。
- **3.2** 清理任务包 try/catch + 分批 LIMIT（每次 DELETE ≤5000，循环至 0），避免长事务。

**验收 3**：预置 10 条 `created_at` 为 40 天前的 audit 行 → 触发 sweep 后余 0 条；`AW_AUDIT_RETENTION_D=1` 时已删除行为可复现；对运行中表无锁错误。

### Phase 4 — 热路径性能（PERF-1，PERF-3）

- **4.1** **省略法**：`daq-controller.ts` / `dcw-controller.ts` 的 status/metrics 段建立**增量维护的视图缓存**（`{count, onlineCount, enabledCount, lastSeq}`，在 insert/update/remove 钩子中更新），替换同函数内多次 `all()`（L469/L479 等）。
  - 目标：`status()` 路径 `repo.all()` 调用数从 ≥3 降为 0~1。
- **4.2**（可选，评估后决定）**PERF-3**：`task.history_json` 拆独立 append-only 表 `task_history(task_id, seq, at, message_json)`，读取时按任务分页；保留 `history_json` 兼容读取（迁移期双写）。
  - 若 4.2 体量过大或与并行会话冲突 → 降级为：维持 CAP，仅把 `update()` 改为"仅当 history 变化时写"（现状已如此），列为 follow-up。

**验收 4**：单元断言 `status()` 不再调用 `repo.all()`（或 ≤1 次）；500 节点基准下 CPU 用户态时间下降 ≥30%（对比火焰图/采样）；4.2 若实现：长任务 500 条历史时写放大恒定 O(1) 本次更新量。

### Phase 5 — 数据层演进（PERF-2）+ 架构拆分（ARCH-1）【中远期，独立跟踪】

- **5.1** JSON 仓库 → 迁移 `node:sqlite`（复用 `daq/storage` 的 adapter 模式；或每实体分片文件）。**默认不做**，列为 follow-up，避免与并行会话冲突。
- **5.2** `manager.ts` 拆分（IdleSweeper / MemoryMaintenance / 路由逻辑独立）。列为 follow-up。

**验收 5**（若进入跟踪项）：仅记录于 `.omc/`，不设硬性时间线。

---

## 4. 验收标准（可测试，≥90% 具体）

| # | 标准 | 可测方式 |
|---|---|---|
| AC-1 | `aw build` 在干净掉 `app/config/index.ts` join 修复后 exit 0 | 命令行执行，检查退出码 + 产物存在 |
| AC-2 | 双开 `aw start`（同数据目录）第二个实例 ≤5s 内退出码 2，报错含冲突 PID | 脚本断言退出码与 stderr 匹配 `/已有实例|already running/i` |
| AC-3 | `aw dev` 在 3000 被占时输出"端口占用 + PID"且退出码 ≠ 0；显式 `--port` 可正常启动 | 脚本断言 |
| AC-4 | 活跃写入下连续 3 次备份成功；新日志中 `database is locked` 计数为 0 | 触发备份 + grep 日志 |
| AC-5 | 插入 40 天前的 audit 行 → 默认配置 sweep 后为 0；`AW_AUDIT_RETENTION_D=1` 可复现 | 测试脚本 + 数据断言 |
| AC-6 | `daq-controller.status()` 与 `dcw-controller.status()` 不（或仅 1 次）调用 `repo.all()` | 单元测试（spy on repo.all）+ 代码评审 |
| AC-7 | 500 节点状态查询 CPU 用户态采样下降 ≥30%（优化前后同场景） | `perfrecord`/`--cpu-prof` 采样对比 |
| AC-8 | 全部改动通过 `pnpm lint` 与 `pnpm typecheck`（typeCheck 需在 `nuxt typecheck` 开闸前先跑 `eslint`） | CI / 命令行 |

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **并行会话冲突**：`app/config/index.ts`、`server/plugins/*`、`shared/*` 正被另一会话编辑 | 双写互相覆盖、计划文件失效 | Phase 0 前先读最新文件；改动前再次 diff；对上述文件改动**最小化**；必要时与用户确认接管边界 |
| **node:sqlite backup API 行为差异**（Node 版本） | 备份失败没有旧路径可退 | `engines.node` 已 ≥23.4；`backup` 失败降级回 VACUUM INTO（保留旧实现为 fallback 一行开关 `AW_BACKUP_API=vacuum`） |
| **保留策略误删合规数据** | 不可逆 | 默认值保守（audit 90d > 合规观察期）；全部 env 可调；清理先 `COUNT` 打印再删；`AW_RETENTION_DISABLED=1` 逃生门 |
| **单实例锁在崩溃/强杀后残留** | 锁永久占用 | 锁校验 PID 存活；`releaseLock` 挂 `exit`/`close`；提供 `aw doctor` 手动清除提示 |
| **PERF-4.2 任务历史迁移**改变 DB 契约 | 破坏并行会话功能 | 默认**不做 4.2**；只做 4.1；4.2 列为 follow-up 并在独立分支评估 |
| 加固改动引入回归 | 破坏现网演示 | 每 Phase 冒烟（`aw doctor` + 关键 API 自检 + E2E 脚本 `scripts/_dbg-full-feature-e2e.mjs`） |

---

## 6. 决策记录（ADR 精简）

- **决策**：分五阶段加固——先解除构建阻断（P0）与多实例崩溃（P1），再做备份锁竞争（P2）与增长治理（P3），最后做热路径优化（P4）；P5（JSON→sqlite、manager 拆分）列为 follow-up。
- **驱动因素**：当前仓库存在一处**必现构建失败**与**已实测的整进程崩溃**（优先级压倒一切）；备份/保留的锁报错可复现；性能问题为慢速增长型，非即时故障。
- **备选方案**：(A) 全量重构（不选：触碰并行会话太多、风险大、无即时收益）；(B) 只写审计报告不实施（不选：BLD-1/ST-1 会持续阻塞）；(C) 本计划（选：小步、可回退、与并行开发兼容前置相吻合）。
- **后果**：P0-P4 合计约 6-10 个文件改动；默认行为不变；新增 env 覆盖项 4 个（`AW_*_RETENTION_D`、`AW_RETENTION_DISABLED`、`AW_BACKUP_API`）。
- **Follow-ups**：PERF-2（JSON→sqlite）、ARCH-1（manager 拆分）、PERF-3（task_history 独立表）、开发期 `qa 巡检`（`aw doctor --full`）。

---

## 7. 验证步骤（最终）

1. `node bin/aw.mjs build` → 成功生成 `.output/`
2. `node bin/aw.mjs start --port 3100` → 启动；再次 `node bin/aw.mjs start --port 3101` → 退出码 2 且提示已有实例
3. `node bin/aw.mjs doctor` → 全部 PASS（含残留进程扫描、锁文件状态）
4. 触发 3 次备份（环境临时 `BACKUP_INTERVAL_HOURS=0.0001` 不可行→以 `BACKUP_DISABLED` 之外的最小间隔或手工调用脚本测试）→ 日志无 `database is locked`
5. 保留测试脚本：审计/消息预置过期行 → 清理 → 断言
6. 性能基准：`node --cpu-prof` 采样对比 `status` 接口（优化前后）
7. `pnpm lint && pnpm typecheck`

---

## 8. 变更记录

- 2026-09-02：初版（Direct 模式产出，依据本会话代码审计 + 实测证据）。
