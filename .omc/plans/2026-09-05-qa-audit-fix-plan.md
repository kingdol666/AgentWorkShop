# QA 全场景审计修复计划(2026-09-05)

> 定位:测试专家全场景审计 —— 4 路深度代码审查(CLI 启停/服务端运行时/TUI+HITL/DCW 写控驱动)+ 真实复现测试。
> **本清单只收录"已确认"的问题**:标注 `[LIVE]` = 在运行实例/真实环境复现;`[CODE]` = 代码路径确定性闭合(时序类已注明)。
> 审查中被证伪/未复现而剔除的候选:killPort ":1502" 误杀 15030(数字序列不含,实际只影响 15020-15029 等前缀端口)、acquireLock 死锁接管竞态(12 轮×4 进程真并发未击穿,理论窗口存在)。

## 测试环境事实

- 生产实例运行中:3001(pid 58868,mode "prod:home",锁在 `~/.AgentWorkShop/.runtime/aw.lock`)
- 磁盘存在三份 `runtime-settings.json`:`data/`(空 overrides,9/1)、`.AgentWorkShop/`(theme.primaryColor=#41c8f4,9/2)、`.AgentWorkShop/data/`(空,9/1)
- 基线:`test-tui-reducers` ✅ / `test-tui-commands` ✅ / `test-hitl-registry` ✅(需 `--tsconfig .nuxt/tsconfig.server.json`)/ `test-ws-protocol` 需 dev server(环境依赖)

---

## P0 —— 落地即炸/数据丢失/首启安全(必须修)

### P0-1 `[LIVE]` 种子管理员默认密码随源码发布
- 复现:`POST /api/users/login {zhangwei@awshop.io, Awshop@123}` → 200,**role=admin**(`server/repositories/user.repository.ts:44-52,95-104`)。README/npm 公开可得;无首登强制改密。
- 影响:任何能访问 3001 的人拿到 admin(改任意资源/全量 monitor/杀进程)。
- 修复:首启随机生成 admin 密码打印一次(或强制首登改密);`security.ts` 对已知的 6 个种子口令一律拒启;docs 标注。

### P0-2 `[LIVE]` JSON 持久层:非原子写 + 损坏静默清空 + 首写覆盖(数据永久丢失,已端到端复现)
- 复现链(`server/services/workshop/dcw/recipe-rollback.repo.ts`):合法文件加载 ✓ → 人为截断文件 → 新实例 `loadDb` catch 返回空库**无任何报错** → 首次 `appendAnchor` 落盘 → 原记录被覆盖消失。
- 波及面:同构仓库 **14 个 json 仓库**(dcw-line/dcw-node/daq-node/scene-layout/node-bindings/recipe-rollback 等),写入路径全是裸 `writeFileSync`(无 tmp+rename);rollback 仓库另有 1.5s debounce,进程退出丢尾部。
- 修复(统一封装 `loadJsonSafe/saveJsonAtomic`):
  1. 写:`writeFileSync(tmp)` + `renameSync` 原子替换;
  2. 读:JSON.parse 失败 → 把坏文件改名 `.corrupt-<ts>` 保留现场,**拒绝以空库启动**(fail-fast)或明确告警;
  3. debounce 定时器 `unref` 基础上,进程 exit 钩子 flushNow。

### P0-3 `[LIVE-磁盘]` runtime-settings 三文件脑裂:API 写 A,子系统读 B
- 事实:三份文件并存且内容分叉(见测试环境事实)。`PATCH /api/system/settings` 写 `<cwd>/data/runtime-settings.json`(`server/services/system-config.ts:100`),而 `backupSettings/retentionSettings/memorySettings/daqRuntimeSettings` 读 `<configRoot>/runtime-settings.json`;`scripts/dev-guard.mjs:46-51` 又读遗留 `data/` 路径 → **dev 永远应用不到 CLI `aw config set` 写入的覆盖;备份/保留期/记忆维护等运行时覆盖对服务端静默无效**。
- 修复:system-config.ts 与 dev-guard 全部走 `resolveRunMode().configRoot`;启动时把遗留 `data/runtime-settings.json`、`.AgentWorkShop/data/runtime-settings.json` 合并迁移至 `<configRoot>/runtime-settings.json` 后删除(带日志)。

### P0-4 `[LIVE]` `aw stop` 找错配置根,停不掉运行中实例
- 复现:home 模式实例运行中(3001),在 repo(含 `.AgentWorkShop`)内执行 `aw stop` → 只清了一把陈旧 repo 锁,exit 0,对 home 活实例**完全失明**。`cli/commands/stop.mjs:58-60` 硬编码 `join(ctx.root,'.AgentWorkShop')`,无视 `ctx.configRoot`。
- 修复:repo 模式也优先用 `ctx.configRoot`(与 start.mjs:59 一致);`--home` 语义保留。附带:锁内 `port` 字段类型统一为 number(dev 写 string,start 写 number)。

### P0-5 `[LIVE]` `aw tui` 全部 CLI 参数被静默丢弃
- 复现:`node bin/aw.mjs tui --headless --url http://127.0.0.1:59999 --token probe-invalid` → 不报"无凭据:headless 请传 --token"、不用指定 URL,直接落进交互式 readline,stdin 关闭时 unsettled top-level await 挂死。
- 根因:分发器传 parseArgs **对象** `{flags,positionals}`(`cli/aw.mjs:158`),`tui/aw-tui.mjs:25-35` 的 parseArgs 按数组 `argv.length` 遍历 → 循环零次,opts 恒 `{headless:false}`。
- 修复(一行级):`cli/commands/tui.mjs` 传 `argv.positionals`(让 aw-tui 自解析),或 aw-tui.main 接受对象形态。修复后补一条走 CLI 分发器的 e2e(现有 e2e 直接以数组调 main(),绕过了此路径,故未发现)。

### P0-6 `[CODE-确定性]` DCW 节点 `writing` 状态持久化后重启 → 该节点所有写永久 409
- 链路:`dcw-runtime.ts:71-75` 置 `writing`(驱动写最长 3s+)→ 并发 flushNow/防抖把 `state:'writing'` 全量快照进 `dcws.json` → start.mjs 顶替即 `taskkill /T /F` 硬杀 → `fromRow` 原样恢复 → 写 409、保写心跳被挡(dcw-runtime.ts:97),`startAll` 只复位 `offline`(dcw-controller.ts:288),**全库无启动复位路径**。
- 修复:`fromRow` 将 `writing` 归一为 `error`(附 lastError="进程中断于写入,状态待核销");顺带在 `startAll` 做一次性消毒兜底。

### P0-7 `[LIVE]` 窄终端 TUI 进程崩溃(未捕获异常)
- 复现:30 列终端 + 内容变宽后的差分渲染 → pi-tui `tui-main-screen.js:467-491` stop()+throw `Rendered line exceeds terminal width (65 > 30)`,pi-crash.log 落盘。真实 TUI 无 uncaughtException 兜底 → 进程死亡。
- 根源:`tui/components/root.mjs:20-34` Columns 组合行不夹断(MonitorPane 固定 44 列);`chat-log.mjs:28`/`hitl-card.mjs:24,34` 的 `Math.max(width,20)` 硬下限;首渲染不查宽,崩在 resize 后的下一次差分,难定位。
- 修复:所有组件 render 出口统一 `truncateToWidth(line, width)`(wrapTextWithAnsi 路径已防,补 Columns/固定宽度路径);移除 `Math.max(width,20)` 下限。

### P0-8 `[CODE-确定性]` HITL 作答模式劫持斜杠命令 + dcw-approval y/n 语义陷阱
- `tui/aw-tui.mjs:271-274`:`state.hitlAnswering` 分支在斜杠命令之前 return → 作答卡输入 `/hitl off`(卡片提示文案!)被当答案提交:`input/editor` 对话框把字面文本写进 omp stdin;`dcw-approval` 非 y 开头=**静默拒绝**。
- `tui/aw-tui.mjs:223-228` + `hitl-card.mjs:9-14`:dcw 审批无 method 提示,用户不知 y/n 约定;中文确认词("同意/ok/批准")全部落定为拒绝。
- 修复:onSubmit 优先放行 `/` 前缀;dcw-approval 用显式 `y/yes/n/no` 判定(其余回显"请输入 y 或 n");卡片对 dcw-approval 显示"y=批准 / n=拒绝"。

---

## P1 —— 驱动泄漏/静默停采/稳定性(工业落地前修)

### P1-1 `[CODE]` MQTT 写驱动:失败路径泄漏 client + 默认 1s 无限重连风暴
- `server/services/workshop/dcw/drivers.ts:478-516`:`client.end()` 只在 publish 成功后执行;8s 超时/异常路径直接返回,client 永不关闭;`mqtt.connect` 未设 `reconnectPeriod`(默认 1000ms 无限重连)。
- 修复:finally 关闭;`reconnectPeriod:0`(一次性连接);超时 timer clearTimeout+unref。

### P1-2 `[CODE]` MQTT 采集连接池:一次 error 永久打死整池,静默停采
- `server/services/workshop/daq/drivers.ts:666-705,744-765`:池命中不检连接活性;error 事件 `c.end(true)` 后 conn 留池 → sample 空转 3s 返回 null → runtime 当"跳帧",**无错误状态无告警,broker 下全部节点静默停采**。
- 修复:error/close 时从池中驱逐;sample 前检 `c.connected`;null 跳帧升格为节点 lastError + 告警事件。

### P1-3 `[CODE]` Modbus/OPC UA 池并发首建竞态 + OPC UA 写控会话死亡不自愈
- `daq/drivers.ts:249-284,478-521`:无互斥,双建连、先建者泄漏。`dcw/drivers.ts:284-366`:写控路径从不 `errors++`/驱逐,死 session 反复失败直至 10 分钟空闲 sweep。
- 修复:按连接键加 in-flight Promise 互斥;写控复用 OPC UA 数采的 3 错驱逐自愈;`getOpcUaConn` 复用前检 session 有效。

### P1-4 `[LIVE-机理]` node:sqlite 默认 busy_timeout=0 → 并发写锁立即抛错 + WS 帧不回队丢失
- 复现:双连接同库,BEGIN IMMEDIATE 持锁,第二条连接 INSERT 立即 `database is locked`。叠加 `server/api/workshop/ws.ts:211-230` flushDbBuffer 异常帧不回队 → retention/backup 写锁窗口丢事件。
- 修复:所有 `new DatabaseSync` 统一 `open(..., {timeout})`(或 PRAGMA busy_timeout=5000);flush 失败帧回队(带重试上限);backup/retention 错峰。

### P1-5 `[CODE]` "未处理 rejection 即退进程" × floating promise 面
- `server/plugins/dev-stability-guard.ts:29-52` 任何 unhandledRejection → exit(1);配套:`aw-plugins.ts:14` `void initPluginHost().then()` 无 catch;`backup.ts:77-94` 在同步 try/catch 里调 async `backupOnce()`(readdirSync 抛错成 unhandled rejection)。
- 修复:补显式 catch(插件发现/backupOnce);guard 增加 stderr 计数与连续崩溃退避;30+ 处 `void x.catch(()=>{})` 抽查补日志。

### P1-6 `[CODE]` 备份 `db.serialize()` 全库进内存 + 同步写盘阻塞
- `server/plugins/backup.ts:24-33`:数十至数百 MB 库整体入内存再同步写盘,期间全部请求停摆;落盘非原子;Node 23.x 无 `serialize` 时每日备份静默失败。实测当前 node:sqlite 已有异步分页 `backup()`。
- 修复:改用 `sqlite backup()` API(分页异步、不阻塞),落盘 tmp+rename。

### P1-7 `[CODE]` 保写心跳绕过全部门控 + 失败写污染 node.value
- `dcw-runtime.ts:97-101` 心跳直调 host.executeWrite(不经 beforeWrite/联锁/账本锚);`dcw-node.ts:112` 失败仍 `value=目标值` → 心跳把未核销值周期性写向 PLC,且工具回包话术与实际状态相反。
- 修复:失败写不赋值(或置 `state='error', value=回读值`);心跳走 `rt.write()` 统一门控。

### P1-8 `[CODE]` 调控闭环三缺陷
- system 兜底回退乒乓(回退记录的 from=坏值被再次兜底写回,`recipe-rollback-manager.ts:428-473`);`chainRollbackCount` 终生无时间窗(数月后任意 2 次即永久降级 auto);`dcw_rollback` 无 HITL 门控且可回退已 `judged-keep` 记录(`industrial-tools.ts:367-392`,话术与实现不符);`evaluateOnce` 对无法执行的升级判定每 30s 重发(`:414-473`)。
- 修复:system 回退目标用 `lastStableAnchor` 且进入同一冷却;链计数加滚动窗口(如 24h);dcw_rollback 按 node 绑定模式走审批;judge 前查既有 judge 幂等。

### P1-9 `[CODE]` 配方联锁绕过与半套参数
- `applyRecipe` 自带 run.id 绕过活动批次工艺窗口联锁(`dcw-controller.ts:467,598-607`);`lineStart` 先激活批次再逐参写,部分失败无门控回滚(`:696-709`)。
- 修复:applyRecipe 校验同产线活动 run 冲突;lineStart 失败即 `setActiveLineRun(null)` 回滚并整体报错。

---

## P2 —— 多租户/越权面(公网或多人部署前必须修;单用户内网可暂缓)

### P2-1 `[LIVE]` 开放注册 + 普通用户列服务器任意目录
- 复现:注册即得 user token → `GET /api/workshop/fs/dirs?path=C:/` → 返回 31 项根目录。`server/api/workshop/fs/dirs.get.ts:18-21` 任意绝对路径 readdir。
- 修复:path 限定白名单工作区;或关闭自注册(注册改邀请制/admin 开户)。

### P2-2 `[LIVE]` 禁用用户的存量 token 仍有效
- 复现:admin 禁用探针用户后,旧 token 调 `/api/users/me` 仍 code=0。`user.repository.ts:207-220` findByToken 不检 `u.status`。
- 修复:findByToken 校验 status==='active'。

### P2-3 `[LIVE]` WS 未鉴权 peer 收工业遥测(+代码确认 HITL 广播可达)
- 复现:无 token 连 `/api/workshop/ws` 被接受,10s 收 60 帧(daq.reading/dcw.read)。`ws.ts:655-674` registerScenePeer 先于鉴权且失败不注销;HITL 待办广播发全部 peers(载荷含对话框内容)。
- 修复:open() 先鉴权再注册;鉴权失败即刻 close。

### P2-4 `[CODE]` 设置接口向普通用户返回 effective 全量(含密钥字段)
- 本实例密钥值为空,暴露机制确认(`system-config.ts:231-240`)。修复:非 admin 脱敏 secretKey/password/api_key 字段。

### P2-5 `[CODE]` 终端 WS 按 pid 直连无归属校验(可 attach 他人会话并注入输入/代答 HITL);`agent-tools/invoke` 的 agentId 不校验归属(身份冒用);DCW write 端点缺 requireRole。
- 修复:统一资源归属校验中间件;invoke 校验 agent.ownerUserId;write 补角色门控。

### P2-6 `[CODE]` 插件路由面默认无鉴权 + manifest 免鉴权暴露插件清单(`server/api/plugins/[name]/[...path].ts:4`、`manifest.get.ts`)。修复:插件路由默认挂 resolveUser,manifest 需登录。

---

## P3 —— 工程卫生/小缺陷(随手修)

1. `[DOCS]` 文档化测试命令已坏:根 tsconfig 改 solution-style 后 `npx tsx scripts/test-hitl-registry.ts` 报 `@/shared` 解析失败。修复:docs 补 `--tsconfig .nuxt/tsconfig.server.json`,或根 tsconfig 补 paths+package.json scripts 固化(`test:unit`)。
2. `[CODE]` `--home=true` 静默失效(`stop.mjs:56` 用严格 `===true`,args.mjs 有 isTruthy 未用);`--port -1` 被当布尔 → 端口 1(`args.mjs:42`)。
3. `[CODE]` 端口顺延不回写锁/settings → `aw status`/TUI 自动发现失联,锁内 port 为旧值(`scripts/start.mjs:58-87`)。顺延后应回写锁文件并 console 突出显示。
4. `[CODE]` checkPort 把非 EADDRINUSE 一律当空闲(`single-instance.mjs:117-129`;本机保留段实测可绑定,EACCES 未能复现,防御性修复:非 EADDRINUSE 输出警告并按"占用未知"处理)。
5. `[CODE]` TUI 重连/快照四件套:启动不拉 hitlPending 快照(上线前待办不可见);跨频道 `hitl.resolved` seq=0 不重放 + 409 不清条目 → 幽灵待办;submitHitlAnswer 无重入锁(双击双写);terminal 镜像对 4401 token 失效也无限 2s 重试冲刷监控环。
6. `[CODE]` 大小写漂移:`registry.mjs:106-107` 扫描 `.agentworkshop/commands`(小写) vs 实际目录 `.AgentWorkShop` → Linux/macOS 用户级指令静默失效;`help.mjs:40`/`version.mjs:30` 文档路径漂移。
7. `[CODE]` disabled 状态外的杂项:last_used_at 每请求同步写(users.sqlite 无 WAL);request-log 每请求同步 console.log;alarm-notify `list(500).find` 溢出静默丢;mock 写驱动全局 'default' 桶互串;anchors 追加无上限;dcw 周期读对不支持读的驱动每 5s 噪声;dev broker 不支持 QoS2 但驱动允许配 2。
8. `[HYGIENE]` 仓库根 `NUL` 保留名文件(GBK 错误输出,删之,并禁用 cmd 风格 `> NUL` 重定向);`scripts/e2e-plc-scenario.mjs` 名实不符(未传 driver/driverConfig,全链 mock,头注释宣称真实 PLC;断言 `/18[0-9]/` 过宽);`.tmp-e2.txt`/`gui-test-screenshots`/`.e2e-*` 清理与 gitignore。

---

## 建议执行顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| 第 1 批(天级) | P0-1 ~ P0-8 | 全部已复现/确定性;数据丢失(P0-2/P0-3/P0-6)与首启安全(P0-1)是落地拦路石;P0-5/P0-4 一行级修复 |
| 第 2 批 | P1-1 ~ P1-6 | 驱动泄漏与静默停采直接打击"稳定运行"目标;备份/丢帧是长期运行必踩 |
| 第 3 批 | P1-7 ~ P1-9 | 工业语义正确性(心跳/回退/联锁) |
| 第 4 批(按部署形态) | P2 全部 | 单用户内网部署可延后;公网/多人前必须 |
| 随手修 | P3 | 与任意批次搭车 |

## 回归验证清单(修复后必跑)

1. `test-tui-reducers` / `test-tui-commands` / `test-hitl-registry(--tsconfig .nuxt/tsconfig.server.json)` 全绿
2. P0-2:新写 `scripts/test-json-repo-atomicity.mjs`(损坏注入 → 拒启/保留坏文件;并发写无截断)
3. P0-3:`aw config set theme.primaryColor X` 后 dev 与 start 读到同值(两进程打印 settings hash)
4. P0-4/P0-5:home 模式实例运行中,repo 内 `aw stop` 能停掉;`aw tui --headless`(无凭据)立即报错退出
5. P0-6:dcws.json 注入 writing 态 → 启动 → 节点可写、state=error
6. P0-7:30 列 VirtualTerminal 冒烟(复用 probe 脚本)不崩
7. P2:禁用用户 token /me → 401;无 token WS → close;fs/dirs 越界路径 → 4xx
