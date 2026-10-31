# 安全与鲁棒性完整审计 · 修复计划 v2(41 项逐项源码实证)

- v1:2026-10-30 审计产出;**v2 修订:2026-10-28 —— 4 路并行只读源码核查,41 项全部落到 file:line 实证**。
- 核查结论:**33 CONFIRMED / 5 PARTIAL(表述已修正) / 3 REFUTED(已移出修复范围)**。所有"修复方向"均指明可照抄的仓内现成 helper(file:line),验收均为可执行的负向断言。
- 审计证据源:Mimosa 深度扫描(scanId `scan-2026-10-29T09-53-14.219Z-029139366c3f`,seal `sha256:e52169b3…b701`,45 findings,coverage=inconclusive)+ 两路人工深审 + 本轮逐项实证。
- 状态(2026-10-30 实施轮):**B0–B5 六批已实施并验收**,4 项显式延期(P2-4/P2-9/P2-10/P3-4,原因见验收报告 §4)。
  验收报告:`docs/audit/2026-10-30-security-hardening-acceptance.md`(全量单测 835/835;安全批 57 新单测 + 3 套真机 e2e 52 断言全绿;T2 产线治理 44/44、四绑定 19/19、镜像数采 17/17 含真实 Qwen3.5 64k)。
  Mimosa 纪律:静态证据,不据此宣称"系统完全安全"。

---

## 〇、v2 相对 v1 的核实修正(实施者必读)

| 项 | 修正 |
|---|---|
| P0-2 | 消费点是 h3 `getRequestIP(event, { xForwardedFor: true })`(选项式),非裸读 header;修复=去掉选项 + 显式开关 |
| P0-4 | 残留物是 **omp/python 孙进程与 env.lock**,不是服务端口(node 子进程被杀端口即释放);`aw stop` 路径已有正确示范 `terminatePid`(`shared/config/single-instance.mjs:53`),缺口仅 start.mjs 的 killChild/parent-watch/exit 三条路径 |
| P1-3 | `mes.secret` **不在** settings 泄露面(独立仓 mes-secrets.repo,GET 仅 admin 且零明文);实际明文键 = `daq.mqtt.password` / `daq.objectstore.secretKey` / `memory.embed_api_key`(shared/config/schema.json:44/40/71) |
| P1-6 | dcw sweep 是 **500ms**(`SWEEP_MS`,dcw-controller/helpers.ts:22),daq 才是 250ms;存在 `dev-stability-guard` uncaughtException 兜底,但 `classifyFatalCandidate`(server/utils/stability-severity.ts:64-77)只豁免 4 类噪声,**通用错误仍 exit(1)**;另发现独立正确性缺陷:一拍抛错会跳过同拍剩余 runtimes |
| P1-10 | 登录失败 Map(`user.service.ts:36` `_loginFails`)**有界**(5000 条+驱逐+15min 窗),不修;无界的是 rate-guard 自身三 Map |
| P2-5 | **缺口缩窄至 DAQ 自定义模板一处**:channel-templates 已有 `requireWritable(ownerUserId,…)`、EDA 模板已有 owner 校验(eda/template-repo.ts:80,94) |
| P2-12 | 重复实际 **≥4 处**:`dispatch.ts:264` 内联 8 项正是 `tool-classes.ts:30` 注释明令禁止的"第三份";`dispatch.ts:260` observeBlocked 12 项已与 HIGH_RISK 分化;无测试约束同步 |
| P3-5 | **推翻移除**:retryJob 有状态幂等(二次点击 409)+ retryCount≤2 上限(control.ts:42-45) |
| P3-10 | **结论反转**:allowRegistration 默认已是 **false**(schema.json:28);唯一残留是 register.post.ts:13 陈旧注释仍写"默认 true" → 转为一条注释修正 |
| P3-11 | **推翻移除**:omp 聊天侧已有流式 delta(tools-steer.ts:343-350,50ms 批量);所引 core.ts 是 supervise 专用兜底路径 |
| P3-1 | 降为"有意设计":槽位 late-exit 监听会自愈恢复容量(worker-client.ts:307),仅真杀不掉才缩水 → 移出修复,补注释即可 |
| P3-6 | **移除**:dev-stability-guard.ts:39-41 已先经 `captureProcessFault` 入 audit_log;workshop.ts:102 只是冗余后备 |

---

## 一、P0 — 立即修(越权/防线失效,5 项全 CONFIRMED)

### P0-1 Channel 治理档位 PATCH 无属主守卫 ✅
- **实证**:`server/api/workshop/channels/[id]/twin-profile.patch.ts:29` 仅 `resolveUser(event)`(只认证不验属主),`:64` 直接 `setHybridChannelProfile({...next, createdBy:'api'})`,可改 `controlPolicy`(含 `bounded_auto`,schema :23)/objective/`boundModelId`;全局三中间件与 `defineApiHandler` 均无鉴权,`getChannelTwinProfile` 不验归属——无任何缓解。同族 `index.patch.ts:53` 与 `execution-mode.patch.ts:64` 都调 `manager.requireChannelOwner(channelId, user, 'channel')`。
- **修复**(3 行,照抄 index.patch.ts:49-53):路由开头补 `const user = resolveUser(event)` + `manager.requireChannelOwner(channelId, user, 'channel')`(helper 在 `server/services/workshop/runtime/manager/access.ts:201`,owner/admin 放行,遗留 NULL → 403)。
- **验收**:`tests/channel-twin-profile-authz.test.ts`——用户 B 对用户 A 的 channel PATCH twin-profile → **403**;属主 → 200 且档位生效;admin → 200;断言矩阵与 execution-mode 现有测试同构。

### P0-2 X-Forwarded-For 无条件信任 ✅
- **实证**:全仓仅两处消费 + 一处派生:`server/middleware/01-rate-guard.ts:58`、`server/api/users/login.post.ts:10` 均为 `getRequestIP(event, { xForwardedFor: true })`(header 存在即采信);`server/services/user.service.ts:148` 用它构造锁定键。grep `TRUST_PROXY|trustProxy` 全仓零命中,无限流旁路缓解——直连部署时限流桶/404 封锁/登录锁定全部按可伪造 IP 计。
- **修复**:新增开关 `const AW_TRUST_PROXY = process.env.AW_TRUST_PROXY === '1'`;封装 `clientIp(event)`(新 `server/utils/request-ip.ts`,10 行):开关开 → `getRequestIP(event,{xForwardedFor:true})`,否则 `getRequestIP(event)`(socket 地址);两处消费点替换。不自行解析 XFF 链,交反代正确配置。
- **验收**:`tests/trust-proxy.test.ts`——①直连(开关关):两个请求带不同伪造 XFF、同 socket IP → 计入同限流桶并触发 429;伪造 XFF 登录失败 5 次后,**真实 socket IP 的正确密码登录不受影响**(不得锁定);②开关开:按 XFF 值分桶。

### P0-3 优雅停机链被信号处理器短路 ✅
- **实证**:`server/plugins/01-instance-guard.ts:75-81` 对 SIGINT/SIGTERM `process.once(sig, () => { release(); process.exit(0) })`。nitro 的 graceful shutdown(nitropack 2.13.4 runtime/internal/shutdown.mjs)在 **listen 之后**才注册信号监听;guard 在插件阶段(文件名字典序先于 workshop.ts)先注册先执行,`process.exit(0)` 使 `workshop.ts:291-296` 的 close 钩子(`shutdownOrchestrator` 杀 AML 训练树、`manager.shutdown()`、`db.close()`)、`system-config.ts:39` dispose、`aw-plugins.ts:70` shutdownPluginHost 全部成死代码。`process.once('exit', release)` 仍会跑,锁文件不丢,损失在清理链。Windows 下更因 P0-4 连信号都不达——双重死。
- **修复**:guard 删除 SIGINT/SIGTERM handler(保留 `process.once('exit', release)` 兜底);信号交还 nitro graceful shutdown;`release()` 追加到 `workshop.ts` close 钩子末尾双保险;close 链末尾加 5s 强退定时器(`setTimeout(()=>process.exit(0),5000).unref()`)防清理卡死不退出。
- **验收**:`tests/e2e-graceful-shutdown.mjs`——起隔离实例 → 发 SIGTERM → 断言:①日志出现 close 钩子执行输出(`manager.shutdown`/db.close 路径日志);②锁文件(data.lock)被删除;③进程 10s 内退出。

### P0-4 Windows 生产启动强杀 + 孙进程孤儿 ✅(表述已修正)
- **实证**:`scripts/start.mjs:161-168` `killChild` 用 `c.kill('SIGTERM')`,Windows=TerminateProcess,子进程信号处理器不执行;孙进程(omp/AML python,经 `line-spawn.ts:109` 非 detached 拉起,无 Job Object)成孤儿,残留占用 vpip/env.lock(衔接 P1-9)。现有正确示范:`shared/config/single-instance.mjs:53-59` `terminatePid`(taskkill /PID /T /F + 命令行指纹防误杀),仅 `aw stop` 与 start.mjs:83 自动顶替路径在用。parent-watch.ts:12-20 只收口 node 子进程本体(≤5s),不级联孙进程。
- **修复**:`start.mjs` 的 `killChild`/exit 兜底改调 `terminatePid(child.pid)`(树杀,孙进程一并清除);保留 500ms 宽限等待;dev 直启(Ctrl+C 直达 node 信号)路径依赖 P0-3 修复后的优雅停机。
- **验收**:`tests/e2e-start-stop-tree.mjs`——start.mjs 起实例并造一个孙进程(如 AML venv python 常驻脚本或模拟 node 孙进程)→ 触发 stop → `tasklist`/`netstat` 断言:整树(含孙 pid)无残留;重新 start 可立即绑定同端口。

### P0-5 基础设施默认口令 + 全网卡绑定 ✅
- **实证**:`docker-compose.yml:41,55,56` 将 Timescale 5432、MinIO 9000/9001(含 Web 控制台)publish 到 0.0.0.0;`:38` `POSTGRES_PASSWORD: awshop`、`:52-53` `MINIO_ROOT_USER/PASSWORD: awshop/awshop-secret` 字面量入库;`config.yml:70,77` 客户端侧同名口令。对照 `:20` MQTT 已是 `127.0.0.1:1883:1883`。且 `config.yml:62 startInfrastructure: auto` 会在端口不通时自动 `docker compose up` 主动物化这些默认值。deploy/ 无生产覆盖 compose,compose 无 `${VAR}` 注入。
- **修复**:①三行端口改 `127.0.0.1:5432:5432`/`127.0.0.1:9000:9000`,9001 控制台挪 `profiles: ["debug"]`(默认不启);②口令改 env 强注入:`POSTGRES_PASSWORD: ${AW_TIMESCALE_PASSWORD:?set in .env}`、MINIO 同款(MQTT 口令既有口径为准);服务端连接侧走既有三源配置(env > config.yml)用同名 env,config.yml 中口令值清空并注释指向 env;③compose 顶部注释标注生产必须改密。
- **验收**:①`docker compose config` 渲染后 5432/9000/9001 均含 `127.0.0.1:` 前缀、9001 仅 debug profile;②`grep -E "awshop-secret|POSTGRES_PASSWORD: awshop"` 于 compose/config.yml 零命中;③起 compose 后从局域网另一地址探测三端口不可达(手工记录到验收报告)。

---

## 二、P1 — 高优先(9 CONFIRMED + 1 PARTIAL)

### P1-1 omp 子进程全量继承 process.env ✅
- **实证**:`server/services/workshop/agents/adapters/omp-rpc-client/start.ts:17-22` `env: { ...process.env, ...this.options.env }`,且唯一构造点 `omp-agent/client.ts:31-45` 不传 env → 全量继承。omp-rpc-client 是唯一绕过 `spawnLineProcess` 的启动器。仓内已有完整清洗设施但 omp 未用。
- **修复**:从 `line-spawn.ts` 导出白名单 env 构造(以 `jobEnv` 白名单为基,`server/services/workshop/aml/python-runtime.ts:603-630` 模式 + PATH/系统键/代理键/OMP_* 白名单),start.ts 改用;或直接改走 `spawnLineProcess`。
- **验收**:`tests/omp-env.test.ts`——测试内 `process.env.NUXT_SESSION_PASSWORD='x'`、设 provider key → 构造 client 并截取 spawn options → 断言 env 不含该两键、含 PATH。

### P1-2 MES hook 子进程仅剥 10 键 ✅
- **实证**:`server/services/workshop/mes/mes-hook.ts:316` `spawnLineProcess(process.execPath, [moduleFile])` 不传 options → 落 `line-spawn.ts:113` 黑名单分支,仅剥 `PLATFORM_SECRET_ENV` 10 键(line-spawn.ts:24-35:NUXT_SESSION_PASSWORD/AW_ADMIN_PASSWORD/AW_E2E_ADMIN_PASSWORD/AW_E2E_PASSWORD/AW_E2E_TOKEN/AW_E2E_ADMIN_TOKEN/SCHED_E2E_PASSWORD/AW_TUI_PASSWORD/ADMIN_TOKEN/CLOUDFLARE_TUNNEL_TOKEN);引擎 provider key、`DAQ_MQTT_PASSWORD` 等全部可见。hook 跑的是管理员配置的用户 JS(mes-hook.ts:282 写一次性 .mjs),信任级别与 AML 训练器同级——而后者拿白名单 env,同层双标。
- **修复**:mes-hook.ts:316 补 `env: hookEnv()`(jobEnv 同款白名单:系统键 + `AW_MES_*` 显式键 + NODE_OPTIONS 空摆),照抄 `job-orchestrator/process.ts:22-24` 的 `cleanEnv: true` 用法。
- **验收**:`tests/mes-hook-env.test.ts`——伪造秘密 env 触发 hook 执行 → 断言 hook 进程可见 env 无 NUXT_SESSION_PASSWORD/无 provider key、`AW_MES_*` 键保留、hook 功能回调用正常完成。

### P1-3 editor 可读运行时密钥明文 ✅(泄露面已修正)
- **实证**:`server/api/system/settings/index.get.ts:11-13` `requireRole(event, ['admin','editor'])` 后 `snapshot()` 原样返回 effective(`system-config/snapshot.ts:38-48` 无掩码);明文键:`daq.objectstore.secretKey`(schema.json:40)、`daq.mqtt.password`(:44)、`memory.embed_api_key`(:71)。掩码单点已存在但只用于 driverConfig 投影:`shared/daq-protocol.ts:543-551` `SECRET_KEY_RE`+`maskDriverConfigSecrets`,入口防回显 `stripMaskedSecrets`(:560-570)。mes.secret 不在此面(独立仓 admin-only 零明文)。
- **修复**:snapshot.ts 出口对 effective 按 `SECRET_KEY_RE` 扩展键名匹配(扁平键含 password/secret/api_key 后缀)掩码为 `***`;PUT 入口复用 `stripMaskedSecrets` 语义:回传掩码值不落盘覆盖真实值。
- **验收**:`tests/system-settings-masking.test.ts`——editor 与 admin GET 均得 `***` 非明文;PUT 回传掩码值 → 真实值不变;非敏感键原样返回。

### P1-4 Modbus 池并发首连无在飞去重 ✅
- **实证**:`server/services/workshop/daq/drivers/modbus-tcp.ts:106-157`:并发同 key 首连时池中无条目,两调用各自走 `await connect`(≤3s),先后 `modbusPool.set` 后者覆盖前者,前一条 socket 永不 close → 泄漏。OPC UA 已修同型缺陷:`opcua.ts:30` `opcuaInflight Map` + :75-85 去重(注释即本缺陷逐字描述)。
- **修复**:照抄 opcua 模式:`const modbusInflight = new Map<string, Promise<ModbusConn>>()`,命中 pending 直接 return;`finally` 清 inflight;失败时同步从 pool 删除坏条目(现有代码若无,一并补)。
- **验收**:`tests/modbus-pool-inflight.test.ts`——mock connect 延时 100ms,并发 20 个同 key 首连 → 底层 connect 调用恰 1 次、池中 1 条;connect 拒绝时池与 inflight 均无残留、后续调用可重建。

### P1-6 sweep 定时器回调同步段无兜底 ⚠️ PARTIAL(按实际语义修)
- **实证**:daq `daq-controller/state.ts:93` `setInterval(sweep, 250)`;dcw `dcw-controller/state.ts:35` `SWEEP_MS=500`,回调体 :41-46 裸奔且 `rt.tick` 同步 void(dcw-runtime.ts:103)。`dev-stability-guard.ts:42-44` 有 uncaughtException 兜底,但 `classifyFatalCandidate`(stability-severity.ts:64-77)只豁免 socket 噪声/SQLITE_BUSY/上游不可达/引擎边界 4 类,**通用错误仍 process.exit(1)**;即使被吞,同拍剩余 runtimes 被跳过(正确性缺陷)。正确模式:`runtime/manager/state.ts:177-194` 逐任务 try/catch + log.error。
- **修复**:两个 sweep 回调照抄 manager/state.ts 模式:逐 runtime try/catch + `log.error`,`evaluateOpenRecords` 一并包裹。
- **验收**:`tests/sweep-isolation.test.ts`——注册 tick 抛错的 fake runtime → sweep 不抛、其余 runtime tick 仍被调用、错误入日志;daq/dcw 各一断言。

### P1-7 三处出站 fetch 未走 SSRF 护栏 ✅
- **实证**:①`daq/alarm-notify.ts:33` fetch 的 url 来自运行时设置 `alarmWebhookUrl`(:49),连协议校验都没有;②`runtime/embedding-provider.ts:36` 同(baseUrl 来自 `memoryCfg.embed_base_url`);③`sdk/context.mjs:260-265` `safeUrl` 仅协议白名单(拒 file:/data:),无私网校验,rag-bridge/diag-bridge 出站都走它。护栏已存在:`server/services/workshop/net/ssrf.ts:51` `assertSafeHttpUrl`(DNS 全量解析 + isPrivateIp 含 169.254/16),现有调用方 http/dcw/mes-rest 驱动,恰缺这三处;`allowPrivateHost` 选项(:13-16)已支持显式放行内网。
- **修复**:①②入口调 `assertSafeHttpUrl(url, { allowPrivateHost: <运行时设置 net.allowPrivateOutbound,默认 false> })`(新增一个运行时设置项);③ `ctx.http` 的 safeUrl 补私网段拒绝——host 侧注入 `isPrivateIp` 检查(sdk 为独立 .mjs,由 attachOmpPluginBridge 注入而非相对导入)。
- **验收**:`tests/ssrf-outbound.test.ts`——webhook/embedding 指向 `http://169.254.169.254/` 与 `http://127.0.0.1:xxx/` → 拒绝且零 fetch 调用;`net.allowPrivateOutbound=true` → 放行(mock fetch);ctx.http 指内网 → 抛错。

### P1-8 analysis POST / ops-logs POST 缺产线授权 ✅
- **实证**:`analysis/index.post.ts:16-29` 仅 `resolveUser`(任意角色),lineId 不验存在性直接 insert(analysis.repo.ts:129 裸 insert);`ops-logs/index.post.ts:27` 有产线存在性(:51-52)与产品/配方跨线一致性(:58-67)校验,但无 grant 授权——零授权用户可向任意产线写报告/日志,污染审计轨。正确对照:`line-scope.ts:62-75` `requireLineForResource(user, lineId, resourceLabel, 'operate')`(范例 `dcw/params/[id]/read.post.ts:16`)。注意:ops-logs 空 lineId 是刻意的"全局审计台账"语义。
- **修复**:两路由写操作补 `requireLineForResource(user, lineId, '分析报告'/'运行日志', 'operate')`;**空 lineId 旁路收紧为仅 admin**(保留全局台账语义但堵零授权写)。
- **验收**:`tests/analysis-opslog-authz.test.ts`——零授权用户向未授权 line 写 → 403;非 admin 空 lineId → 403;有 grant 用户 → 200;admin 空 lineId → 200。

### P1-9 env.lock 崩溃残留永久锁死 ✅
- **实证**:`aml/env-lease.ts:121-133` `acquireFileLock` 用 `flag:'wx'`,EEXIST 一律 409 `ENV_BUSY`——**无 TTL、无探活、无接管**;锁内 `heartbeatAt` 写一次全仓无消费者(名不副实),`envLockMtime`(:141-148)自认"不参与判定";头注释 :12 明文需人工清理。持有者崩溃(恰是 P0-3/P0-4 的常态产物)→ `env-manager.ts:231` 的 `withEnvExclusiveLock` 此后永久 409,无 API/UI 清理入口。
- **修复**:EEXIST 分支读锁 JSON → `pidAlive(pid)`(helper 在 01-instance-guard.ts:23-32,"EPERM 视为存活",直接搬)→ 活:409 现状;死:log.warn 后以新 token 重写锁接管(重写保持 `owner/pid/heartbeatAt/token` 形状,对齐 releaseFileLock 的 :135-138 双校验)。
- **验收**:`tests/env-lease-takeover.test.ts`——预置锁文件指向死 PID → acquire 成功且 owner 更新为新持有者;指向活 PID(测试内子进程)→ 仍 409;锁内容损坏 → 视为死锁接管。

### P1-10 rate-guard 三 Map 无回收 + chunked 绕过 body 上限 ✅(登录锁定子项剔除)
- **实证**:`01-rate-guard.ts:13-15` `__awRateBuckets/__awScanHits/__awScanBlocked` 只增不清(唯一删除是 :66 对解封 IP 的惰性删),键按唯一 IP 无界增长;`:74-78` body 上限仅看 content-length(代码注释自认 chunked 走 nitro 默认),全仓无其他 body 上限。登录锁定 Map 有界(user.service.ts:150-153),不在此列。
- **修复**:①`bucketOf` 命中过期键时 `delete` 重建;每 200 次请求或 60s 做一次三 Map 过期清扫(惰性,复用现有 `b.reset <= now` 判定);②middleware 对带 `transfer-encoding` 头且非 GET/HEAD 的请求直接 413(平台客户端均为 content-length,语义明确)。
- **验收**:`tests/rate-guard-bounds.test.ts`——模拟 5000 个不同 IP 的过期请求后 Map size 收敛有界;chunked(无 content-length)POST → 413;正常 content-length 路径不受影响。

---

## 三、P2 — 中优先(11 CONFIRMED + 1 PARTIAL)

| # | 实证(已核) | 修复(照抄) | 验收 |
|---|---|---|---|
| P2-1 ingest token 非常量时间比较+全局单凭据 | `daq/ingest-policy.ts:63` `providedToken === configuredToken`;凭据=进程级 env 单键(`AW_DAQ_INGEST_TOKEN`) | 双侧 sha256 后 `timingSafeEqual`(模式:`user.repository.ts:181`);按线凭据**后置**单列 | `tests/ingest-token-consttime.test.ts`:正确/错误 token 行为不变;空 token 拒绝 |
| P2-2 analysis 无长度上限+列表全字段 | `analysis/index.post.ts:34-41` report/metrics/context 原样入库;`analysis.repo.ts:83-89` 全列 list,GET 返回全字段 | 同文件 :30-32 已有 slice 先例,report 截 1MB、metrics/context JSON.stringify 后截 256KB;repo 拆 `LIST_COLS` 列表裁列 | `tests/analysis-limits.test.ts`:2MB report 入库后 ≤1MB;list 响应不含 context 全文;detail 完整 |
| P2-3 CSP 含 unsafe-inline+unsafe-eval | `middleware/00-security-headers.ts:13-14` | 去 `unsafe-eval`(Nuxt4/Vue3 运行时不需要;style inline 保留,antd cssinjs 依赖);script-src nonce 化后置 | `tests/security-headers.test.ts`:CSP 无 unsafe-eval;UI e2e 冒烟 console 无 CSP 违规报错 |
| P2-4 WS token 走 URL+无 Origin 校验 | `ws/hub.ts:77-81` query 取 token,`ws/handlers.ts:52,64`、`terminal/ws.ts:62-63` 同;全仓零 Origin 校验 | 首帧认证(handlers.ts:97 已支持 message 内 token,扩为必须)+ Origin 与 Host 同源校验,不符 close 4403;terminal 同 | `tests/ws-origin-auth.test.ts`:无 token ws → close;跨源 Origin → 4403;同源+首帧 token → 正常 |
| P2-5 DAQ 自定义模板无属主 ⚠️(缺口缩窄) | `daq/templates/index.post.ts:13-15`、`[key].patch.ts`、`[key].delete.ts` 仅 resolveUser;`daq-templates.ts:162-197` 无归属校验;`DaqTemplateDef` 无 owner 字段(daq-protocol.ts:15)。channel-templates/EDA 模板已有属主校验,不修 | `DaqTemplateDef` 加 `ownerUserId`;patch/delete 路由套 `requireWritable(tpl.ownerUserId, user, 'DAQ 模板')`(access.ts:77);builtin/plugin 模板豁免 | `tests/daq-template-owner.test.ts`:用户 A 建模板,B patch/delete → 403;A/admin → 200;builtin 不受影响 |
| P2-6 设备孪生操控/删除、assets 上传仅登录 | `device-twins/[id]/control.post.ts:14`、`[id].delete.ts:15`、`[id].patch.ts:15`、`assets/devices/index.post.ts:19` 均仅 resolveUser | 孪生操控/删除按 `requireLineMode(user, lineId, 'operate')`(permissions.ts:55,dcw write.post.ts:19 在用);assets 上传限 editor+ | `tests/device-twin-authz.test.ts`:零授权 user 操控/删除 → 403;user 上传资产 → 403;editor+ → 200 |
| P2-7 密码 6 位下限 + token 无上限 + 锁定 DoS | `schemas/user.schema.ts:12-17` `.min(6)`;`user.repository.ts:456-458` issueToken 无数量检查且每次登录新发(service:179);`user.service.ts:146-163` 锁键 `ip\|email`、429 在密码校验前,叠加 P0-2 XFF 伪造可锁死受害者 | 默认裁定(批准计划即批准):min 6→**8**(仅新密码生效);每用户 token ≤20 最老失效;锁键改 accountId(全局 5 次/15min)+ IP 维度仅告警;429 移到密码校验之后统一文案 | `tests/account-hardening.test.ts`:7 位新密码 422;第 21 枚 token 最老失效;伪造 XFF 连败 5 次后正确密码仍可登录(联动 P0-2);连败 5 次后错误密码亦 429 |
| P2-8 legacy status Error message 直通 | `utils/response.ts:35-38` 任何带数字 `status` 的裸 Error 的 message 直通;真实使用:crud.ts:61,116,167,179、driver-probe.ts:26、frames.ts:102 的 `Object.assign(new Error(...),{status})` | 上述 6 处迁 `AppError`(server/utils/errors.ts);迁移后删 legacy 分支:非 AppError/H3Error 一律 500 笼统文案 | `tests/response-legacy-error.test.ts`:`Object.assign(new Error('C:\\内部路径'),{status:404})` → 500 笼统;既有 CRUD 测试全绿 |
| P2-9 scryptSync/inflateSync 阻塞事件循环 | `user.repository.ts:171,180` scryptSync;`daq/frames.ts:163` inflateSync(内存炸弹已有 maxOutputLength+MAX_PIXELS 缓解,纯 CPU 阻塞) | promisified `scrypt`;inflate 改 `zlib.inflate` async | 既有登录/注册/帧解析测试全绿;新增 1 断言:async 路径行为等价 |
| P2-10 JSON 仓储先改内存后落盘(18 repo) | `dcw-line.repo.ts:67-85` 原地 mutate 后 `save(this.list)`,save 失败内存盘上分歧;`all()` 返回活引用;同构 18 文件(13 repo + daq-templates/dcw-templates/line-run/gate-persist/recipe-op-anchor) | **单独批次 B5**:copy-mutate → save 成功再 swap 引用(write-then-commit);抽 dcw-line + line-run 两代表 repo 先行,其余机械推广 | 代表 repo 各 1 断言:mock save 抛错 → 内存对象保持原值;全量回归绿 |
| P2-11 AW_BENCH_MODE=1 单 env 解除全部防线 | 消费 6 处:rate-guard.ts:23(整个中间件)、helpers.ts:26-28(限频豁免)、write.ts:102,107,112,152-154,173-174(软联锁/步限/冷却/间隔/保持窗/回读容差)、write.post.ts:22-26;缓解:requireLineMode 仍生效、结构硬量程不可旁路 | 双 env 保险丝:`AW_BENCH_MODE=1` **且** `AW_BENCH_ACK=1` 才生效;单 env 启动大红告警并拒绝旁路 | `tests/bench-mode-fuse.test.ts`:仅 AW_BENCH_MODE=1 → 写间隔仍 60s 生效;双 env → 旁路照旧;启动日志含告警 |
| P2-12 工具白名单 ≥4 处重复漂移 | 单一源 `tool-classes.ts:23-31`;`dispatch.ts:264` 内联重复(注释明令禁止);`dispatch.ts:260` observeBlocked 12 项与 `permission-scope.ts:33-39` HIGH_RISK 已分化;`grant-guard.ts:23-46` 16 项另一套;permission-scope:26-28 注释已失真;无同步测试 | dispatch.ts 改 `import { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES } from '../tool-classes'`;`observeBlocked = DIRECT_WRITE ∪ {optimization_explore, recipe_propose, line_start, line_stop}` 派生;修正 permission-scope 注释 | `tests/tool-list-single-source.test.ts`:断言 DIRECT_WRITE ⊆ observeBlocked ⊆ HIGH_RISK;grep 断言 dispatch.ts 无内联 8 项数组;既有 execution-mode-surface/high-risk-tool-scope 测试全绿 |

---

## 四、P3 — 低优先/批处理(v2 修订后 10 项)

| # | 项 | 实证/修复 |
|---|---|---|
| P3-2 | backupOnce 无并发互斥 | `backup.ts:152-155` 无在飞标志,24h 定时器与 admin API 可重叠。修复:模块级 promise 复用(在飞直接返回同 promise)。验收:并发双调 → 底层执行 1 次 |
| P3-3 | retention 第二 SQLite 连接 | `retention.ts:21-22` `new DatabaseSync` 绕开共享连接与 backupRegistry(仅 busy_timeout=5000 缓解)。修复:注入共享 db 或登记 backupRegistry。验收:grep 断言 retention 不再自建连接 + retention 功能测试绿 |
| P3-4 | steer 失败重投无上限 | `agent-runtime/state.ts:338-348` requeue 无 attempts 计数,持续失败无限循环。修复:消息加 attempts 字段,>5 次转 failed + 错误入账。验收:持续失败桩 5 次后不再重投且有日志 |
| P3-7 | json-store 读失败静默 | `json-store.mjs:46-48` 非 ENOENT 读错误静默返 fallback(损坏路径已有 console.error+.corrupt 留档)。修复:读失败分支补 log.warn(含 errno)。验收:模拟 EACCES → warn 被调 |
| P3-8 | A2A AgentCard 未认证枚举 | `a2a/[agentId]/card/index.get.ts:67-74` 无鉴权,返回 name/description(role+harness)/skills/rpc URL(不泄露 token)。A2A 规范 card 本为公开发现面 → 加开关 `security.a2aCardPublic`(默认 true 兼容),关时 401。验收:开关关 → 未认证 401;开(默认)→ 200 |
| P3-9 | h3 RC 版 | package.json:142 `h3 2.0.1-rc.26`(nuxt ^4.0.0)。随 Nuxt 稳定版升级,单独观察项,不在 B0-B5 |
| P3-10 | 注册默认关闭,仅陈旧注释误导 | schema.json:28 default=false(结论反转);修复=删改 `register.post.ts:13` "默认 true" 注释。验收:grep 无该注释;注册关闭时 403 既有测试绿 |
| P3-12 | dsh/qwen/hermes ACP 适配器零单测 | tests/ 115 文件 grep 三者零命中。修复:各补 ≥3 断言契约单测(spawn 参数/env 清洗/超时形状,mock stdio)。验收:三个新测试文件绿 |
| P3-13 | S7 显式拒绝桩 | `s7-stub.ts:22-28` throw DRIVER_NOT_IMPLEMENTED。**功能项非安全项**,依赖 nodes7 许可,维持另册(daq-dcw-hardening 在册),不占本计划 |
| P3-14 | 超时常量散落 ≥15 处 | agents 目录三份 ACP 适配器互相复制 600_000/60_000 等(settings.ts:276,293,314、各 *-agent.ts、harness-env.ts:47、stdio-jsonrpc.ts:133、worker-client.ts:26)。修复 B5:建 `server/services/workshop/agents/timeouts.ts` 集中派生,先收敛三适配器。验收:grep 三适配器无内联 600_000/60_000;行为不变 |

**移出修复范围(核实推翻/有意设计,防重复立项)**:P3-1(槽位自愈是有意设计,仅补注释)、P3-5(retryJob 已幂等:409+retryCount≤2)、P3-6(unhandledRejection 已先经 dev-stability-guard `captureProcessFault` 入 audit_log)、P3-11(omp 聊天侧已有 50ms 批量 delta 流式)。

---

## 五、Mimosa 45 findings 定性(维持 v1,密封证据 scanId 见头)

- 生产代码命中 2 处均误报:`channel-agent.repo.ts:143` 参数化 prepared statement;`a2a/[agentId]/rpc/index.post.ts:431` 带 Bearer 认证的 JSON-RPC 分发。
- i18n "硬编码凭据" 3 处为 UI 标签文案,误报。
- ~40 处在 paper/test/Agent 生成脚本(data/workspaces 的路径穿越形态并入 P1-7/Agent 脚本执行边界后续议题)。
- 依赖 354 包 0 已知漏洞。报告自评 coverage=inconclusive,不据此宣称"无其他漏洞"。

## 六、已核实为良好的面(v1 基础上新增本轮实证)

v1 清单(SQL 全参数化/导出双路径校验/line-spawn 转义/WS 三重校验/备份 admin-only/token 只存 SHA-256/500 不漏栈/driverConfig 掩码单点/定时器 clear+unref/TSDB retention/审批租约幂等/MQTT 断连缓冲/data-query 钳制)之外,本轮核查新增确认:

- channel-templates 与 EDA 模板**已有**属主校验(`requireWritable` / template-repo.ts:80,94)——v1 误列缺口,已从 P2-5 摘除。
- 登录失败锁定 Map 有界(5000 条+驱逐+15min 窗,user.service.ts:150-153)。
- retryJob 状态幂等 + 次数上限;unhandledRejection 已入 audit_log 台账。
- `aw stop` 与自动顶替路径已有正确的树杀(`terminatePid`,含命令行指纹防误杀)。
- WS 除 query token 外,handlers.ts:97 已支持帧内 token(是 P2-4 修复的现成落点)。
- `dev-stability-guard` 的 uncaughtException 并非无差别吞,4 类豁免+fatal 分级设计完整。

## 七、执行批次(每批独立可交付,验收全绿再进下一批;均 pathspec 分批提交,不卷并行会话文件)

| 批次 | 内容 | 预估 | 批验收 |
|---|---|---|---|
| **B0 止血** | P0-1 + P0-2 + P0-5 | 半天,3 个小 diff | 3 个新测试文件绿;既有 perms/line 套件复跑绿 |
| **B1 停机语义** | P0-3 + P0-4 + P1-5 + P1-9 | 1 天 | graceful-shutdown/start-stop-tree/env-lease-takeover 3 套件绿;instance-guard 双开竞态测试绿(P1-5:`flag:'wx'`+EEXIST 探活,照抄 env-lease.ts:124 与 single-instance.mjs:105) |
| **B2 子进程与密钥** | P1-1 + P1-2 + P1-3 + P2-1 + P2-11 | 1 天 | omp-env/mes-hook-env/system-settings-masking/ingest-token-consttime/bench-mode-fuse 5 套件绿 |
| **B3 授权补口** | P1-8 + P2-5 + P2-6 + P2-7 + P3-8 + P3-10 | 1 天 | 越权 403 矩阵套件绿(analysis-opslog-authz/daq-template-owner/device-twin-authz/account-hardening);既有 tool-verify/perms 回归绿 |
| **B4 韧性** | P1-4 + P1-6 + P1-7 + P1-10 + P2-2 + P2-3 + P2-4 + P2-8 + P2-9 | 1-2 天 | 对应 9 个新测试绿;UI e2e 冒烟(CSP 变更后 console 零违规) |
| **B5 结构债** | P2-10(18 repo 批量,代表先行)+ P2-12 + P3-2/3/4/7/12/14 | 单独排期 | 全量单测回归 + 新增一致性断言绿 |

## 八、统一验收门禁

1. **每项验收 = 上表负向断言测试入 tests/ 并绿 + 受影响既有套件复跑绿**;不允许"改完没测"。
2. B0-B4 每批结束:该批全部新测试 + 既有受影响套件一次跑绿后提交(单批一提交,pathspec 限定)。
3. B0-B4 全部完成后:**全量五层门禁重跑一轮**(单测全量 / e2e 套件矩阵 / tool-verify / 既有 live 套件抽二 / docs:build),作为本计划的最终验收工件。
4. 验收报告落 `docs/audit/2026-10-xx-security-hardening-acceptance.md`,逐项链接测试文件与运行输出。

## 九、如实声明

- 41 项经 4 路并行只读源码核查逐项实证:33 确认 / 5 部分成立(已按实际语义修正修复方案)/ 3 推翻移除;2 项降级为观察项/注释修正。
- Mimosa 封印扫描 coverage=inconclusive;本计划是"已实证缺口的修复计划",不宣称覆盖全部潜在漏洞。
- 实施期间共享树有并行会话在途改动,每批提交严格 pathspec 限定并 `show --stat` 核对。
- 状态:**pending approval** —— 批准后自 B0 开始实施。
