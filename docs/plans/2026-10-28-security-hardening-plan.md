# 安全与逻辑加固计划(2026-10-28)

> 状态:**S1–S16 全部实施并验收(2026-10-28)**。
> 执行证据:`docs/audit/2026-10-28-full-hardening-and-3mode-acceptance.md`(最终轮)、
> `docs/audit/evidence/2026-10-28-security-hardening/report.json`(29/29)、
> `docs/audit/evidence/2026-10-28-p2-qwen35-3mode/report.json`(三模式,omp+Qwen3.5-9B)。
> 回归:typecheck 通过、变更面 ESLint 0 error、`test:unit` 702/702、`test:e2e-line` 44/44、本体离线 57/57、`build` 通过。
> 依据:2026-10-28 两轮只读代码审计(鉴权/写控/数采三条线),并对每条结论逐锚点人工复核。
> 原则:**增量修复,不推翻骨架**。不动 host-tool-bridge 的七层 dispatch、绑定 v2/v3 模型、驱动注册表、recipe 协议下沉等既有设计;所有新拒绝都必须给出可行动文案(与仓库既有风格一致)。
> 本轮不改代码,仅出计划。

---

## 一、核查结论

### 1.1 属实(已逐锚点复核)

| # | 问题 | 复核锚点 | 备注 |
|---|---|---|---|
| 1 | 任意登录账号经 harness `config.command/args/cwd` 获得宿主机命令执行 | `channels.post.ts:24-34`、`agents/index.post.ts:12-19`、`admin-channel.ts:64-104,324-335`、`omp-agent/client.ts:30-37`、`line-spawn.ts:86` | 创建 Channel 即 `ensureLeadSchedulerLoop`(`channels.post.ts:72-74`),无需等任务。`assertPlainExecutable` 只拦元字符,拦不住 `cmd.exe /c` / `node -e` |
| 2 | 产线 operate 用户经 DCW 节点 PATCH 执行任意 JS,并可把节点重定向到别线 PLC | `dcw/[id].patch.ts:24-30`、`dcw-controller/crud.ts:76-83`、`dcw/drivers/mes-rest.ts:622-635`、`mes/mes-hook.ts:316` | 前提是"对该线有 operate"(非任意用户)。`dcw` 创建是 admin-only,但 PATCH 让 operate 拿到同等的落点/代码能力,权限不对称 |
| 3 | Agent 实例 token 对同 Channel 成员可见 → worker 可冒充 lead | `channels/[id]/agents/index.get.ts:13-26`、`runtime/manager/helpers.ts:20-31`、`caller.ts:27-34` | Agent token 走 `Authorization: Bearer` 解析,worker Agent 可直接拉名册 |
| 4 | 数据面读接口系统性绕过产线授权 | `dcw/recipes/index.get.ts:9-11`、`dcw/journal/index.get.ts:11-19`、`daq/alarms.get.ts:9-16`、`dcw/[id]/read.post.ts:13-16`、`dcw/[id]/param-ledger.get.ts:11-14`、`dcw/mes-artifacts/file.get.ts:25-41` | 与 `daq/[id]/samples.get.ts:16`(强制 readonly)形成明显不一致;`permissions.ts:8-10` 的"无记录=不返回"承诺在 REST 面未兑现 |
| 5 | 删除配方、关闭批次无任何授权校验 | `dcw/recipes/[id].delete.ts:11-16`、`dcw/runs/[id]/close.post.ts:11-14` | 任意登录用户可删他线治理锚、关生产打标窗口 |
| 6 | `test-driver` 任意用户可提交任意驱动配置;SSRF 白名单由请求体自填 | `daq/test-driver.post.ts:15-22`、`dcw/test-driver.post.ts:14-17`、`net/ssrf.ts:62-72` | `allowPrivateHost:'true'` 由调用方传入即关闭校验 |
| 7 | 保写心跳绕过四层限界/步长/60s/保持窗;解绑产线后心跳恢复 | `dcw-runtime.ts:106-119`、`dcw-controller/lines.ts:35-41` | `lineId=''` 命中 `!node.lineId` 豁免;删除产线不清 `value` |
| 8 | `recipe_trial` 候选值绕过配方工艺窗口 | `industrial/ops-tools.ts:1088-1096`、`dcw-controller/recipes.ts:132-133`、`write.ts:103-107` | 配方路径 `skipRecipe:true`;节点量程/参数/产品层仍在,但第四层缺失 |
| 9 | 回退链可把"坏值"写回;`lastGood` 可指向别的配方批次 | `recipe-rollback-manager/rollback.ts:19-47`、`lock.ts:79-92`、`sweep.ts:37-54`、`dcw-recipe.repo.ts:357-364` | 回退写自身生成 open 记录 `from=回退前坏值`;`markGood` 只校验 run 存在 |
| 10 | HITL 待批全局判定导致跨 Channel 调度冻结 | `runtime/scheduler-loop/tick.ts:70-91`、`tool-approvals.ts:263-268` | `listPending()` 无过滤;超期根每 tick 顺延并 `return`;hold 模式无限期 |
| 11 | 启动期采样早于基础设施就绪,样本落入占位 SQLite/进程内队列后不迁移 | `server/plugins/daq.ts:17-31,65-70`、`server/plugins/workshop.ts:227-241`、`daq/storage/index.ts:24-48` | Nitro `runNitroPlugins` 不 await(已核对 nitropack 2.13.4);`workshop.resumeAll()` 不受 infra 状态约束 |
| 12 | infra "在线"只由 TCP 探测决定;`rebuildTsdb` 失败被吞,`degraded` 仍 false → 不重试 | `daq/infra.ts:170-190`、`server/plugins/daq.ts:65-70`、`daq/storage/index.ts:63-97` | 结果是"UI 显示健康、采样在跑、生产库无数据" |
| 13 | 未注册驱动在加载期被永久改写为 mock 并落盘,产出假数据/假告警 | `daq/daq-node.repo.ts:19-45`、`daq/drivers/registry.ts:89-96`、`daq-node.ts:151-156` | 触发面:插件驱动在插件宿主注册完成前被加载;`lastError` 不进 `toRow`,首次成功采样即清空 |
| 14 | ingest 接受未来时间戳并推进单游标 → 该节点实时样本被永久判 late | `daq/ingest-policy.ts:32-35`、`daq-runtime.ts:157-163` | API 仍返回 `accepted:true`;系统时钟回拨同样触发 |
| 15 | 默认 MQTT broker 匿名 + 通配订阅信任 `payload.nodeId` | `daq/bus/mqtt.adapter.ts:23,72-91`、`docker-compose.yml:12-19` | 同网段可向任意节点注入样本;生产若自备鉴权 broker 则不成立 |
| 16 | 告警/设备遥测 WS 帧无 `lineId`,全量扇出;撤权后 peer 可见集不刷新 | `daq-controller/sweep-alarms.ts:110-114`、`scene-events.ts:44-52`、`ws/hub.ts:87-91` | `permissions.changed` 只广播,服务端不重算 `__awVisibleLines` |
| 17 | Modbus int16/uint16 原始值静默回绕;写失败语义误导为"值未改动" | `dcw/drivers/shared.ts:165-174,194-210`、`write.ts:163-167` | `engToRaw` 不 clamp,`raw & 0xFFFF`;PLC 已变但账本/节点值不动 |
| 18 | 优化器下发缺运行门(新增发现) | `optimization/dispatch.service.ts:119-202,238-261`、`dcw/access.ts:168-174` | D13 八项重验无 `getActiveLineRun`;批准后 `applyRecipe` 也无运行门 → 停线检修中的设备可收到下发 |
| 19 | 外部 `reconnect` 无角色校验 | `daq/infra/reconnect.post.ts:8-18` vs `daq/controller.post.ts:25-27` | 任意用户可触发 docker compose / 重建后端 / 重启全局采样 |

### 1.2 需要修正的结论(审计口径校准)

| 原判断 | 修正 |
|---|---|
| "多实例部署时 writeLocks 无跨进程互斥" | **部分不成立**:`shared/config/single-instance.mjs` 已有 `<configRoot>/.runtime/aw.lock` 原子锁,`scripts/start.mjs:72-88` 与 `dev-guard.mjs:88-89` 已使用。风险降级为"直接 `node .output/...` 启动可能绕过锁",列入 P2 覆盖确认,而非重做分布式锁 |
| "未知驱动会静默产假数据" | 属实,但**新创建/改配**走 `requireDriverKind` 会显式报错;问题只在**启动加载期**的 `migrateDriverKind`。影响面收窄为"存量节点/插件驱动时序" |
| "启动竞态导致样本丢失" | 更准确:样本落入**本地占位 SQLite**(`data/daq-timeseries.sqlite`)或进程内队列,切库后不迁移。不是彻底丢失,是**生产库静默缺口 + 指标仍增长** |
| "工具面/执行面可能错位" | 维持首轮:dispatch 七层与 grant/verify 同源,未发现绕过。本轮严重问题集中在 **REST/配置面**,不在 Agent 工具面 |

### 1.3 暂不纳入(需实测/细读再定级)

- OPC UA `connect()` 无短超时占满全局采样额度(代理提到 60s 默认,未实测)。
- MQTT 驱动连接池并发首连覆盖/泄漏(未细读 `drivers/mqtt.ts` 全量)。
- 对象存储 disk↔MinIO 切换后历史帧不可读(需确认 `frames.ts` 读路径与 key 是否记录 backend)。

---

## 二、修复总览

| 批次 | 编号 | 主题 | 预估 | 依赖 |
|---|---|---|---|---|
| P0 | S1 | harness 启动面收敛(命令白名单 + env 白名单 + workspace 约束) | 1.5d | — |
| P0 | S2 | DCW 节点配置面分权(driver/driverConfig/hook/量程 admin-only + 键白名单) | 1.5d | — |
| P0 | S3 | Agent 名册不回显 token/config | 0.5d | — |
| P1 | S4 | REST 数据面统一产线授权(读/删/关) | 1.5d | S3 无关,可并行 |
| P1 | S5 | test-driver / reconnect 角色门 + SSRF 固定策略 | 1d | — |
| P1 | S6 | 保写心跳纳入写咽喉点;解绑/收窄时清值 | 1d | S2 字段分权 |
| P1 | S7 | 配方第四层复检 + 审批快照 + 优化器运行门 | 1.5d | — |
| P1 | S8 | 回退链 / lastGood 修复 | 2d | S7 口径 |
| P1 | S9 | HITL 待批按 channel 收敛,tick 不早退 | 1d | — |
| P2 | S10 | 启动屏障 + 后端健康状态机 | 2d | — |
| P2 | S11 | 未知驱动 fail-loud(禁止降级 mock) | 1d | 插件注册时序 |
| P2 | S12 | ingest 时间戳方向校验 + 游标语义 | 1d | — |
| P2 | S13 | MQTT topic/payload 一致性 + 生产默认鉴权 | 1.5d | — |
| P2 | S14 | WS/REST 告警与遥测的产线隔离 + 撤权刷新 | 1d | S4 权限助手 |
| P2 | S15 | Modbus 原始值范围校验 + 失败语义 | 1d | — |
| P2 | S16 | 单实例锁覆盖确认(直接 `.output` 启动) | 0.5d | — |

合计约 **20.5 人日**;P0 3.5 天,P1 8 天,P2 9 天。

---

## 三、P0:先堵可利用面

### S1 harness 启动面收敛

**目标**:普通账号不能指定任意可执行文件,不能让 harness 子进程继承无关敏感环境变量,不能在任意目录落 workspace。

**改动**:

1. `server/services/workshop/agents/harness-spawn-policy.ts`(新增纯函数,便于单测):
   - `assertSpawnConfigAllowed(harness, config, actor)`:
     - `config.command` / `config.args` / `config.cwd` 出现时:**非 admin 一律 403**(文案给"如需自定义引擎路径请联系管理员")。
     - admin 允许,但 `command` 必须通过"basename 与注册表默认命令一致或显式白名单"校验(`omp`/`omp.exe`、`codex`、`claude`…),拒绝 `cmd.exe`、`sh`、`node` 等通用解释器。
     - `cwd` 必须位于 `configRoot/workspaces` 或 `process.cwd()` 之下(realpath 后前缀校验),admin 可通过 `AW_ALLOW_ARBITRARY_CWD=1` 豁免。
   - `buildHarnessEnv(base, config, actor)`:白名单 env —— `PATH`、`HOME/USERPROFILE`、`APPDATA/LOCALAPPDATA`、`SystemRoot`、`TEMP/TMP`、`SHELL`、`LANG/LC_*`、`TERM`、`AW_*`、provider key 前缀(`ANTHROPIC_/OPENAI_/GEMINI_/GOOGLE_/DEEPSEEK_/QWEN_/ZHIPU_/MOONSHOT_/OPENROUTER_/AZURE_/AWS_/GITHUB_/COPILOT_/CURSOR_`),外加 `config.env`(admin-only)。
2. 接入点:`admin-channel.ts:324-335`(`createAgent`)、`createChannel` 的 leadAgent 分支、`updateChannel` 的 config 变更;所有 harness 的 `spawnLineProcess` 调用统一传 `cleanEnv: true` + `env: buildHarnessEnv(...)`。
3. `channels.post.ts` / `agents/index.post.ts`:在 zod 校验后调用策略函数,拒绝时 403 并 `recordOps`(`harness.spawn.rejected`)。
4. workspace:`ensureWorkspaceDir` 增加根目录约束;非 admin 的 `workspace` 仅允许相对名(拼到 `data/workspaces/` 下)。
5. 启动审计:Channel/Agent 创建时记录 `harness` 与**生效命令**(admin 自定义时高亮),进 `ops` 日志。

**测试**:
- 单测:`assertSpawnConfigAllowed` 覆盖 普通用户+cmd.exe → 403;admin+omp 绝对路径 → 200;admin+cmd.exe → 403;cwd 越界 → 403;env 白名单不含 `NUXT_SESSION_PASSWORD`。
- e2e(新增 `scripts/security-regression.mjs` 的 S1 段):普通账号 `POST /channels` 带 `config.command` → 403;admin 正常创建 → 200;`GET /api/workshop/channels/:id` 的 ops 日志含创建记录。

**兼容/回滚**:若现网已有自定义 `command` 的 Agent 模板,启动时扫描并输出清单(不阻断),由管理员逐个重新保存(走 admin 分支)。回滚开关 `AW_HARNESS_SPAWN_POLICY=off` 仅用于灰度期,启动时 warn。

---

### S2 DCW 节点配置面分权

**目标**:operate 用户能改"运行参数",但不能改"设备落点/安全限界/可执行代码"。

**改动**:

1. `dcw/[id].patch.ts` 按字段分组鉴权:
   - **admin-only**:`driver`、`driverConfig`、`transform`、`min`、`max`、`decimals`、`stepLimit`、`writeLockSeconds`、`lineId`。
   - **operate**:`name`、`enabled`、`holdIntervalMs`、`readIntervalMs`、`semantics`、`publishIntervalMs`(如有)、`posX/posZ`。
   - 混合请求里含 admin-only 字段且非 admin → 403 并列出被拒字段。
2. `driverConfig` 键白名单(按驱动 kind):
   - modbus: `host/port/unitId/register/dataType/byteOrder/rawMin/rawMax/engMin/engMax/allowPrivateHost`
   - opcua: `endpoint/nodeId/…`
   - mqtt/http/mes-rest: 各自白名单;未知键默认拒绝,`extra` 键仅 admin。
3. **hook 下线**:`writeHook` / `writeCheckHook` 从 `driverConfig` 中移除(读时忽略);新增 `server/services/workshop/dcw/hook-registry.ts`(admin 写、按 nodeId 存、`recordOps` 留痕),执行时 `spawnLineProcess(..., { cleanEnv: true, env: 最小集 })`。`mes-hook-test` 维持 admin-only。
4. `crud.patch` 在 `driver/driverConfig/transform/min/max/lineId` 变更时清除 `node.value` 并 `rearm`(现在只对 driver/driverConfig 做),同时写 `dcw.patch` 审计(已有)。
5. 可选(建议同步):`daq/[id].patch.ts` 的 `driver/driverConfig` 同样升为 admin-only(DAQ http 驱动同样能发外连请求)。

**测试**:
- operate 用户 PATCH `driver='mes-rest'` → 403;PATCH `min/max` → 403;PATCH `name` → 200。
- admin PATCH `driverConfig.writeHook` → 400/被忽略(字段已废弃),旧 hook 迁移后仍可用。
- 单测:白名单函数对未知键拒绝;`transform.scale=0` 仍拒(现有校验保留)。

**兼容/回滚**:旧数据里的 `driverConfig.writeHook` 在启动迁移中搬入 hook registry(仅 admin 可读改写);未迁移则写入时显式报"hook 已迁移,请在管理端配置"。

---

### S3 Agent 名册不回显凭据

**目标**:列表/详情不再泄露 token 与完整 config;token 只在 rotate-token 一次性返回。

**改动**:

1. 新增 `channelAgentSummary(m)` DTO:`id/channelId/name/harness/role/enabled/templateId`,**不含 token/config**。
2. `listChannelAgents` 返回 summary;`getChannelForUser` 与 `channels/[id]/index.get.ts` 的 `agents` 字段同源替换。
3. `config` 仅对 admin 或 channel owner 返回,且**脱敏**:剔除 `command/args/cwd/env/writeHook` 等敏感键。
4. 检查前端/CLI 是否依赖列表里的 token(搜索 `agents[].token`),改为"需要 token 时调 rotate-token(admin/owner)"。
5. 审计:token rotate 已留痕则补 `recordOps`;列表读取不记(高频)。

**测试**:
- 单测:summary 不含 token/config。
- e2e:worker Agent token GET 名册 → 200 且无 `token` 字段;owner GET → 无 token;rotate-token → 返回一次明文。

---

## 四、P1:产线隔离与物理写安全

### S4 REST 数据面统一产线授权

**目标**:所有以资源 id 定位的读/删/关接口,和列表接口,与服务端工具面同口径。

**改动**:

1. 新增 `server/api/workshop/_line-scope.ts`(或 `permissions.ts` 扩展):
   - `lineOfRecipe(id)` / `lineOfNode(id)` / `lineOfRun(id)` / `lineOfOptimization(id)` / `lineOfArtifact(nodeId)`。
   - `requireResourceRead(user, lineId)` = `requireLineMode(user, lineId, 'readonly')`;`requireResourceOperate` 同理。
   - `filterListByLine(user, items, lineIdOf)` 复用 `permissions.filterByLine`(`permissions.ts:45`)。
2. 逐端点接入(读 → readonly;删/关/发布 → operate):
   - `dcw/recipes/index.get.ts`、`dcw/recipes/[id]/versions.get.ts`
   - `dcw/journal/index.get.ts`、`dcw/[id]/param-ledger.get.ts`
   - `dcw/optimizations/index.get.ts`、`[id].get.ts`、`[id]/series.get.ts`
   - `dcw/mes-artifacts/index.get.ts`、`file.get.ts`
   - `dcw/[id]/read.post.ts`、`dcw/params/[id]/read.post.ts`
   - `daq/alarms.get.ts`、`daq/[id]/samples.get.ts` 等已合规端点不动
   - `dcw/recipes/[id].delete.ts`、`dcw/runs/[id]/close.post.ts` → `operate`;删除配方再加"运行中/被绑定/有在飞审批"拒绝条件
3. 列表接口无 id 时按 `visibleLineIds(user)` 过滤;admin 不过滤(保持现状)。

**测试**:
- 新增 `tests/security-line-scope.test.ts` 单测(纯函数) + `scripts/security-regression.mjs` e2e:
  - 无授权用户:`GET recipes` 返回空/403;`GET dcw/:id/read` → 403;`DELETE recipe` → 403;`POST run/close` → 403。
  - readonly 用户:读 200,删/关 403。
  - admin:全 200。

**风险**:现有"频道绑定产线即只读扩权"的语义需保留 —— `visibleLineIds` 应包含 channel 绑线(现有实现若不含,在此补齐,并与 `daqTargetsOf` 的 v28 扩权同源)。上线前跑全量 `test:unit` + `test:api-live` 回归。

---

### S5 test-driver / reconnect 收敛

**改动**:

1. `daq/test-driver.post.ts`、`dcw/test-driver.post.ts`:
   - `requireRole(event, ['admin', 'editor'])`;若目标是已存在节点,也可放宽为"对该节点产线 operate"(二选一,默认 admin/editor)。
   - `driverConfig.allowPrivateHost` **从请求体中删除/忽略**;私网放行只认服务端配置(`AW_TEST_DRIVER_ALLOW_PRIVATE=1`)且必须 admin。
   - 结果 `recordOps`(谁在何时测试了哪个目标,不含凭据)。
2. `daq/infra/reconnect.post.ts`:`requireRole(['admin','editor'])`;单飞锁(同一时刻仅一个 reconnect,重复请求返回 409);审计。
3. 可选:`aw_mcp` 外部 server 的 `aw_dcw_*` 维持用户 token + REST 权限,不额外改(已过同一咽喉点)。

**测试**:普通用户 test-driver → 403;普通用户 reconnect → 403;admin 重复 reconnect → 第二个 409;`allowPrivateHost` 注入无效(单测断言该键被丢弃)。

---

### S6 保写心跳纳入写咽喉点

**改动**:

1. `dcw-runtime.ts:106-119`:心跳改调新增的 `host.writeHold(node)`:
   - `validateEng` + `assertWithinLimits(node, value, { skipRecipe:false })`(配方窗生效;**不停用**,只是拒绝越界值)。
   - 不进 step/60s/保持窗(保写不是新指令),但**必须**进审计:一次 `hold.skipped` 节流日志 + 节点状态 `hold-blocked`(前端可见)。
   - 失败(限界不满足/驱动报错)→ 跳过本拍,不抛;连续 N 次后把节点置 `offline` 并告警。
2. `crud.patch`:`min/max/transform/driver/driverConfig/lineId` 变更 → `value = null` + `rearm`(与 S2 联动)。
3. `removeLine(purge=false)`:对该线节点 `value = null`(或 `holdSuspended=true`),不再依赖 `!lineId` 豁免。
4. 未分配产线的节点:新增 `allowHoldUnassigned`(默认 false),显式开启才保写。

**测试**:
- 单测:hold 值越界 → 不调用 `executeWrite`,状态 `hold-blocked`。
- e2e:开线写值 → 收窄 min/max 使当前值越界 → 心跳不再写 PLC(用 mock 驱动计数);删线后同样不写。

---

### S7 配方第四层复检 + 审批快照 + 优化器运行门

**改动**:

1. `applyRecipe`:`overrides` 非空(trial)时,在 `writeRecipeParams` 内对每个 override 先跑 `evaluateRecipeParamLimits(node, value, { skipRecipe:false })`,失败记该参数 `ok:false` 并跳过(与现有逐参数容错一致)。纯整批 apply(无 overrides)保持 `skipRecipe:true`(值来自已保存配方)。
2. 审批快照: `recipeApprovalPayload` 增加 `recipeVersion` 与 `windowsHash`(各参数 min/max 的稳定哈希);`revalidateApprovedAction` 在执行前比对,不一致 → 拒绝并提示"配方窗口已变更,请重新提交"。
3. 优化器下发:`optimization/dispatch.service.ts:assertDispatchApprovable` 增加:
   - `const active = getActiveLineRun(spec.lineId)`;必须存在,且 `active.runId === rec.runId`(或 rec 记录的活动批次)、`active.recipeId === recipe.id`、`active.productId` 与建议上下文一致。否则 `DISPATCH_GATE_LINE_NOT_RUNNING`。
   - `optimization/access.ts` 的 dispatch 入口加 `requireLineMode(user, spec.lineId, 'operate')`(现在只 `assertAgentAccess`)。
   - `decideOptimizerDispatch` 执行前再跑一次上述运行门(TOCTOU)。

**测试**:
- 单测:`evaluateRecipeParamLimits(skipRecipe:false)` 对 trial 值越窗 → `ok:false`。
- e2e:trial 值超配方窗 → 400/结果行 failed;停线下发 → 409;卡片挂起期间停线 → 批准被拒。

---

### S8 回退链与 lastGood 修复

**改动**:

1. `rollbackRecord`:只允许 `record.source !== 'rollback'` 的记录(或 `record.rollbackOf == null`);否则 409。
2. `sweep.evaluateOnce`:跳过 `rollbackOf != null` 的 open 记录,避免"回退的回退"。
3. `rollbackNode`:目标从 `lastStableAnchor.prevValue` 改为"最近一次 agent/manual 写之前的稳定值":
   - `repo.lastStableAnchor(nodeId, { excludeSources:['rollback'] })`(新增过滤参数);
   - 若最新锚就是回退锚,回退到更早的 agent/manual 锚,且若该值等于当前值则 409(无可回退)。
4. `markGood(recipeId, runId)`:校验 `run.recipeId === recipeId` 且 `run.lineId === recipe.lineId`;不匹配 400。REST `mark-good` 仍要求 operate,并加"run 必须已结束"。
5. `rollbackNode(toAnchorId)` 校验 `anchor.nodeId === nodeId`。
6. `chainRollbackCount` 改为按 `rollbackOf` 连续链计数(或新写 agent 记录时重置);`MAX_AUTO_ROLLBACKS` 语义随之收紧。

**测试**:
- 单测:40→95→rollback(40) 后第二次 rollback 拒绝或回到 40(不得 95);sweep 不评估 rollback 记录。
- 单测:markGood 跨配方 → 400;`toAnchorId` 跨节点 → 400。

---

### S9 HITL 待批按 Channel 收敛

**改动**:

1. `tool-approvals.listPending(channelId?)`:支持按 `approval.channelId` 过滤(没有该字段则用 `agentId → channelId` 映射补)。
2. `scheduler-loop/tick.ts:70-91`:
   - 只统计**本 Channel** 的 pending(`listPending(this.lead.channelId)`)。
   - 续期只对本 Channel 的 expired roots;不 `return` 整轮(或 `return` 前仍执行本 Channel 的 decide/dispatch 之外逻辑,至少不阻塞其它 Channel —— 因为 tick 是 per-loop 实例,重点是过滤)。
   - 增加 `hitlDeferrals` 计数上限(默认 3 次),超过后恢复 ROOT_TIMEOUT(或转人工标记),避免 hold 模式无限挂起。
3. `security.hitl_timeout_mode=hold`:加"僵尸单收敛"策略 —— 超过 `hitl_hold_max_ms`(默认 24h)转为 rejected 并通知,而不是永久挂起。

**测试**:
- 单测:channel A pending,channel B expired root → B 正常 timeout(不再依赖 A)。
- 单测:deferral 超过上限 → timeout 生效。

---

## 五、P2:数据完整性与可用性

### S10 启动屏障与后端健康

**改动**:

1. `server/plugins/daq.ts`:导出 `globalThis.__daqInfraReady = promise`;`applyInfra` 成功才 resolve,失败 resolve `{degraded:true}`。
2. `server/plugins/workshop.ts:227-241`:`resumeAll()` 前 `await __daqInfraReady`(或 `void promise.then(() => resumeAll())`)。
3. `applyInfra` catch:同步更新 infra status 为 `degraded`、`stopAll()`、保留 30s 重试(现在失败时 degraded 可能为 false → 不重试)。
4. `rebuildTsdb` / `rebuildObjectStore` / `rebuildDaqQueue` 失败:抛给 `applyInfra`,由它降级并暴露 `lastError`;`daqInfraStatus` 增加 `backends: { tsdb:'sqlite-emulated'|'timescale', mqtt:'inproc'|'mqtt', objectStore:'disk'|'minio', initError }`。
5. 换库前 flush:`st.current` 切换前 flush `tsdbBuffer` 到旧库(已尽力)并清空;新库就绪后再接受样本(用一个 `ready` 标志,采样侧 short-circuit)。
6. UI:`DaqInfraBanner` 的显示条件从 `degraded` 扩为 `degraded || warning || initError`。

**测试**:
- e2e:PG 端口开但密码错 → 启动后 status 显示 tsdb=sqlite-emulated + degraded=true + 采样停止;修好密码后 30s 内自动恢复。
- e2e:启动即开线(有活动批次) → 占位库不出现新行(因为采样被阻止),恢复后行数从恢复点开始。

---

### S11 未知驱动 fail-loud

**改动**:

1. `migrateDriverKind`:未知 kind **不再**返回 mock;返回 `{ kind: original, downgraded:false, unknown:true }`,`DaqNodeRepo.load` 保留原 kind 并把节点置为不可用(`enabled` 不变,`state='offline'`,`lastError` 持久化)。
2. `resolveDaqDriver`:继续用 `unavailableDaqDriver`(已存在),采样显式失败,不产数据。
3. `DaqNode.toRow/toView` 增加 `lastError`(当前 `toRow` 未序列化,重启即丢)。
4. 插件驱动时序:启动加载延后到插件宿主 ready(订阅 `initPluginHost` 完成事件再 `getDaqController()` 预热),或在 load 时若 `pluginRegistry` 为空则跳过迁移、等 ready 后重跑一次。
5. 前端:节点卡片展示 `driver 未注册` 状态与"重新配置驱动"入口。

**测试**:
- 单测:`migrateDriverKind('serial')` 在插件未注册时返回 unknown、不返回 mock;注册后返回 serial。
- e2e:构造未知 kind 的 daqs.json → 启动后节点 offline、无样本、`lastError` 保留;配置合法驱动后恢复。

---

### S12 ingest 时间戳与游标

**改动**:

1. `ingest-policy.ts`:新增 `futureSkewMs`(默认 60s);`withinBackfillWindow` 拆为:
   - `atMs <= now + futureSkewMs`(否则 `400 FUTURE_TIMESTAMP`);
   - `now - atMs <= backfillWindowMs`(回填窗,保留)。
2. `daq-runtime.onSample`:`lastIngestAt` 只对 `tsMs <= now + skew` 推进;未来帧直接拒绝且不推进。
3. API 响应:`accepted:false, reason:'future'|'late'`(不再一律 true);文档同步。
4. 回填去重:若表有 `(nodeId, ts)` 主键/唯一约束则允许重复回填(幂等);没有则维持 late 丢弃,但错误可见。

**测试**:
- 单测:now+5min → future;now-10min 且窗 1h → 接受;now-2h → late。
- e2e:先发未来样本(400),再发实时样本 → 仍入库(游标未被污染)。

---

### S13 MQTT 身份与默认鉴权

**改动**:

1. `mqtt.adapter` 的 `message` 回调:从 topic 解析 `nodeId`,与 `env.nodeId` 比对,不一致 → 丢弃 + 计数 `identityMismatch`;envelope 做 `value` 有限、`at` 可解析、node 存在三项校验。
2. `docker-compose.yml`:默认改为带密码的 `mosquitto.conf`(密码文件从 `AW_DAQ_MQTT_PASSWORD` 生成),并把 `1883:1883` 改为 `127.0.0.1:1883:1883`;跨机部署由文档显式给"开放 + TLS + 账号"方案。
3. 多实例(若未来支持):envelope 带 `instanceId` 或按节点归属过滤;当前已有单实例锁,先加注释与启动断言。

**测试**:
- 单测:topic `aw/daq/A/sample` + payload `nodeId=B` → 丢弃。
- e2e(compose):匿名连接被拒(配置后);带账号连接正常。

---

### S14 WS/REST 告警与遥测隔离

**改动**:

1. `sweep-alarms`:raise/recover payload 增加 `lineId: node.lineId ?? null`;`tsdb-twin` 的 `device.updated` 同样补 `lineId`(或按绑定节点过滤)。
2. `daq/alarms.get.ts`:`filterByLine(user, alarms, a => a.lineId)`。
3. WS 撤权刷新:`WsPeer` 记录 `userId`;`permissions.changed` 事件里(服务端)遍历该用户 peer,`setPeerVisibleLines(peer, visibleLineIds(user))`;或在 `peerSeesLine` 每次发送时用缓存的 `permissionRevision` 懒刷新(每 5s 最多一次)。
4. `permissions.changed` 广播保留(前端提示刷新)。

**测试**:
- 单测:payload 无 lineId 时不再视为"线无关"(默认拒绝或按 node 反查)。
- e2e:用户无 line A 授权连 WS → 不收 A 的 alarm/reading;撤权后 5s 内停止接收。

---

### S15 Modbus 原始值范围与失败语义

**改动**:

1. `param-conversion`/`engToRaw`:配置期校验 `rawMin/rawMax` 可被 `dataType` 表示(int16 −32768..32767、uint16 0..65535、int32/uint32/float32 范围),并校验 `engMin/engMax` 与节点 `min/max` 一致(或包含)。
2. `engToRaw` 输出 clamp 或抛 400(推荐:**抛 400,不 clamp**,避免"改写目标值");`encodeWords` 前断言整数且在范围内。
3. 写失败语义:`write.ts` 在 `outcome.ok === false` 时,若驱动已发出写命令(或无法确定),把节点状态置 `unknown`(不是保持旧值),并在 `dcw-tools` 文案改为"写入未获证实,PLC 值可能已变更,请先读取核对";`node.value` 不覆盖但标记 `valueUnknown=true`。
4. 文档:`writeTolerance` 死区说明(0.5% 量程)与安全关键参数建议。

**测试**:
- 单测:int16 配置 rawMax=65535 → 创建/写入 400;eng 越界 → 400 且 `executeWrite` 未被调用。
- 单测:回读不一致 → `node.state==='unknown'` + 文案含"可能已变更"。

---

### S16 单实例锁覆盖确认(降级项)

**改动**:

1. 核对所有启动路径:`.output/server/index.mjs` 直接启动、docker entrypoint、`npm start` 是否都经过 `scripts/start.mjs`。未经过的补 `acquireLock` 或启动时检测 `.runtime/aw.lock` 并拒绝。
2. 文档明确:同一 `configRoot` 单写者;不支持多副本共享 data 目录。

**测试**:直接 `node .output/server/index.mjs` 二次启动 → 退出码 2 / 明确报错。

---

## 六、验收标准

新增统一回归脚本 `scripts/security-regression.mjs`(或 `tests/security-hardening.test.ts` + 少量 e2e),必须覆盖:

**P0(必须全绿)**
1. 普通账号带 `config.command='cmd.exe'` 创建 Channel/Agent → 403,且无子进程。
2. operate 用户 PATCH `driver/driverConfig/min/max` → 403;admin → 200。
3. worker Agent token GET 名册 → 响应不含 `token`;rotate-token 仍能返回一次。

**P1**
4. 无 grant 用户:6 个数据面读端点 → 403;DELETE recipe / close run → 403;readonly → 读 200、写 403。
5. test-driver / reconnect:普通用户 → 403;`allowPrivateHost` 注入无效。
6. 心跳:越界值不写 PLC(计数为 0);删线后不写。
7. trial 值超配方窗 → 结果行 failed 且 PLC 未被写;停线下发 → 409;审批期间窗口变更 → 拒绝。
8. 回退两次不回到坏值;markGood 跨配方 → 400。
9. channel A 有待批、channel B 有超期根 → B 正常 timeout。

**P2**
10. PG 密码错 → degraded + 停采 + 30s 重试;修好后自动恢复,占位库无新增。
11. 未知驱动节点 offline、零样本、`lastError` 重启保留。
12. 未来时间戳 400 且不污染游标;后续实时样本可入库。
13. MQTT topic/payload 不一致丢弃;匿名连接被拒。
14. 无授权用户 WS 不收他线 alarm;撤权后停止。
15. int16 越界 → 400 且驱动未调用;回读不一致 → `unknown` 语义。

**常规门禁**:`npm run typecheck`、`npm run lint`、`npm run test:unit` 全绿;受影响的 `test:api-live`、`test:e2e-line`、`test:e2e-optimizer` 回归。

---

## 七、实施顺序与风险

1. **第一周**:S1 → S2 → S3(P0)。这三条互相独立,可并行开发但建议按序合并(先堵 RCE)。
2. **第二周**:S4 → S5 → S6 → S7(第一批 P1)。S4 面广但模式统一,建议先写助手 + 一个端点做样板,再批量接入。
3. **第三周**:S8 → S9,同步补 S10/S11(P2 的前两条最影响数据可信度)。
4. **第四周**:S12-S16 + 全量回归 + 计划归档。

**主要风险**:
- S1/S2 会改变现有管理员/操作员的使用习惯 → 需要发布说明与迁移清单;灰度开关只保留一个版本周期。
- S4 可能让现有仪表盘对"无产线授权"用户变空 → 上线前用真实账号矩阵回归;文案要明确"联系管理员授权"。
- S7 运行门可能拦住"未开线先下发"的既有用法 → 产品上确认为禁止;若要保留,需显式"预置模式"并加审计,不在本计划内。
- S10 启动屏障会延后首批采样 → 冷启动感知变慢,但换来"不写错库";用日志与状态展示弥补。

---

## 八、非目标

- 不重做权限模型 / 不引入 RBAC 表结构(沿用 `line_grants` + `requireLineMode`)。
- 不改 Agent 工具面七层 dispatch、绑定 v2/v3、MCP 桥协议。
- 不做多实例分布式锁(已有单实例锁;S16 只确认覆盖)。
- 不实现 S7 真驱动 / 不改 recipe 协议下沉设计。
- 不在本计划内处理 1.3 的待复核项(另行实测)。

---

## 九、附:本轮审计方法与证据

- 三个只读代理分别覆盖鉴权/写控/数采,共读取 ~550 文件、仅做静态分析,未启动服务。
- 所有进入本计划的条目均由人工回到源码复核(锚点见 1.1),未复核项列入 1.3。
- 复现方式(批准后):`npm run test:security`(待新增)+ 手工负例清单(第六节);不依赖生产数据。
