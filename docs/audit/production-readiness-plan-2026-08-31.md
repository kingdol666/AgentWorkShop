# 生产落地与鲁棒性增强计划(2026-08-31)

> 定位:本计划是 2026-08-30 两份已完成计划(docs/audit/hardening-plan-2026-08-30.md 内部质量加固、
> docs/audit/optimization-plan-2026-08-30.md 性能优化,均已执行并终验通过)之后的**下一阶段**——
> 聚焦「离开 dev 环境进入真实工厂」所缺的外围工程设施:安全硬化、运维韧性、合规审计、部署形态。
>
> 方法:对候选问题逐条做了两路并行代码审计核实(安全/鉴权一路、运维/韧性一路),
> 本文档只保留**经 file:line 实证属实**的问题;与代码不符的分析已修正或剔除。

---

## 0. 审计结论修正(相对外部分析的差异)

外部分析方向正确,但个别论断与代码不符,已按下表修正:

| 论断 | 核实结论 | 证据 |
|---|---|---|
| MQTT no-auth | **属实** | docker-compose.yml:14-15 显式 no-auth;mqtt.adapter.ts:46-50 连接选项无 username/password/TLS |
| 全站无 HTTPS/WSS | **属实** | app/config/schema.ts:42-43 security 段仅 sessionPassword;全 server 无 tls/cert 配置 |
| sessionPassword 默认值 | **部分属实**(默认值存在,但缺的是"生产拒绝校验") | config.yml:70 = awshop-dev-secret-change-me-0123456789;schema 仅 min(16),无 NODE_ENV=production 拒绝逻辑 |
| OPC UA 匿名会话 | **部分属实**(能力有,默认不安全) | daq/drivers.ts:350-363 已支持 securityMode(None/Sign/SignAndEncrypt)+用户名密码;但默认解析为 'None',且无证书链/私钥配置项 |
| 角色仅三级 + token 无过期 | **属实** | schemas/user.schema.ts:8;user.repository.ts:117/181 无 expiresAt,仅可吊销(user.service.ts:117-118) |
| HITL 仅覆盖 dcw_control | **属实**(鉴权本身已覆盖:decide.post.ts:11 有 resolveUser;真实缺口是裁决人不留痕 + 审批仅进程内) | agents/tool-approvals.ts:2-37(进程内/180s);approvals/[id]/decide.post.ts:11 已鉴权但丢弃 resolveUser 返回值,裁决不记操作者;ToolApproval 无 decider 字段(tool-approvals.ts:11-22) |
| 无 Prometheus/结构化日志 | **属实** | 全仓无 /metrics;日志为 console.log/error;dropped/lost 仅汇聚在 daq-controller.ts:391-405 |
| LineRun 崩溃恢复缺失 | **不属实(已有恢复,但依赖懒触发)** | dcw/line-run.ts:39-64 line-runs.json 写盘 + 懒恢复;plugins/daq.ts:26 startAll → sweep 触发续跑 |
| 无备份 | **属实** | 全仓无任何定时备份/导出;主库 SQLite WAL(db/database.ts:575;注意 synchronous=NORMAL 只设在 TSDB 仿真库 sqlite.adapter.ts:27,主库未设) |
| TSDB 丢数据 | **属实且无补录** | daq-controller.ts:97,111-113,303-332 重试耗尽计 tsdbDropped;缓冲溢出丢最旧(:224-227);mqtt.adapter.ts:31,76-80 队列层丢弃;丢弃即永久丢失 |

另外核实:外部分析暗示的「审批裁决 API 无鉴权」**不成立**(decide.post.ts:11 已调 resolveUser,无 token 即 401),真实缺口见 S4——是「不留痕」而非「无鉴权」。

与既有已完成工作的边界:WS Hub 协议(seq/ring/续传/1013/HMR 自愈,api/workshop/ws.ts)、
DAQ 背压链(在飞互斥 daq-runtime.ts:52,78,87-88、离线缓冲 mqtt.adapter.ts:21-33、乱序防御 :123-124)、
迁移链与分批清理(db/database.ts:574-591、ws.ts:439-454)均已生产级实现,**本计划不重复覆盖**。

---

## P0 —— 安全硬化(不补无法进真实工厂)

### S1. MQTT 链路鉴权 + TLS + Topic ACL
- **现状**:broker 以 no-auth 配置运行(docker-compose.yml:14-15);客户端连接零凭据(mqtt.adapter.ts:46-50);config.yml:57-59 mqtt 段仅 host/port。
- **风险**:工控网络内任何人可订阅 aw/daq/+/sample 窃取产线数据、伪造采样注入。
- **方案**:
  1. docker-compose 挂载正式 mosquitto.conf:启用 password_file + per-topic ACL(生产网关只读采集主题/只写控制主题)+ listener 8883 TLS。**仓库现无此文件**(docker-compose.yml:11-15 直接用镜像自带 /mosquitto-no-auth.conf),需在 deploy/ 下新增并挂载;
  2. mqtt.adapter.ts 连接选项透传 username/password/ca/cert/rejectUnauthorized。注意:配置是构建期烘焙(nuxt.config.ts:6-7 读 config.yml → runtimeConfig.daq → plugins/daq.ts:33 → infra.ts:110 拼 MQTT URL),改 config.yml 需重启生效;同时保留 DAQ_MQTT_URL 环境变量覆盖能力,并在 adapter 支持 NUXT_ 环境变量传入凭据(缺省行为不变——dev 零配置可用);
  3. config.yml schema(app/config/schema.ts)同步扩展 mqtt 段并写迁移注释。
- **验收**:无凭据客户端被 broker 拒绝;带凭据链路 E2E(scripts/_dbg-full-feature-e2e.mjs 改造为可选 TLS 模式)ALL PASS。
- **量级**:0.5~1 天。

### S2. sessionPassword 生产强制校验 + HTTPS/WSS 部署基线
- **现状**:默认密钥 awshop-dev-secret-change-me-0123456789(config.yml:70)可原样进生产;schema 仅 min(16)(app/config/schema.ts:43);全站无 TLS。
- **方案**:
  1. Nitro 启动插件(server/plugins/,useRuntimeConfig 可用,daq.ts:33 已示范)检测:process.env.NODE_ENV=production 且 runtimeConfig.session.password 命中已知默认值 → throw 拒绝启动(sessionPassword 唯一注入点 nuxt.config.ts:68,消费方为 nuxt-auth-utils 内部签名,server 侧无其他引用,拦截点干净);
  2. 文档(config.yml 注释 + README)给出反向代理(caddy/nginx)终止 TLS + WS 升级 WSS 的最小配置样例——应用内不做 TLS(遵循 12-factor,由代理层承担)。
- **验收**:默认密钥生产启动即失败;dev 不受影响;docs 附部署样例。
- **量级**:0.5 天。

### S3. OPC UA 默认安全策略反转 + 证书配置
- **现状**:驱动已支持 Sign/SignAndEncrypt + Basic256Sha256 + 用户名密码(daq/drivers.ts:350-363),但 securityMode 缺省解析为 'None',且无证书链/私钥文件配置——能力在、默认裸奔。
- **方案**(实施面已核实):
  1. 节点连接参数存 data/daqs.json,driverConfig 为 Record 透传(daq-node.repo.ts:12-13,70),存储层零改动;
  2. shared/daq-protocol.ts:205-215 的 opcua configFields 增加 certificateFile/privateKeyFile 字段(UI 表单按 fields 自动渲染,无需另改 UI);
  3. daq/drivers.ts getOpcUaConn(:342-359)把证书参数传入 OPCUAClient.create,**并将证书路径纳入连接池 key opcuaKey(:338)**——避免不同证书错误复用连接;文档声明默认 None 仅限测试;securityMode=None 连接时打 WARN。
- **验收**:SignAndEncrypt + 证书对真实 OPC UA 模拟服务器(node-opcua 自带 example server)连通;明文连接出现 WARN。
- **量级**:1 天。

### S4. 审批裁决不留痕(无裁决人)+ 审批仅进程内不持久化
- **现状**:鉴权已覆盖(decide.post.ts:11 resolveUser,无 token 401),但 resolveUser 返回值被丢弃——ToolApproval 无 decider 字段(tool-approvals.ts:11-22),decide() 不接收操作者(:63-74),事后无法追责「谁批的」;且审批全部进程内(globalThis 单例 :118-123,history 仅 50 条内存数组 :34,112-115),重启即失忆,不满足工业审计要求。
- **方案**:① ToolApproval 增加 decidedBy 字段,decide.post.ts 传入 resolveUser 结果;② 审批记录落 SQLite 表(结构含 requested/decided/decider/comment/timeout 状态),进程内 Map 仅作 pending 挂起层(与既有 dcws.json 防抖写盘模式一致),历史查询切表读。
- **验收**:HITL E2E 审批记录含裁决人;重启后审批历史可查;未鉴权仍 401(回归)。
- **量级**:1 天。

### S5. 报警外送 + 确认(ack)闭环
- **现状**:报警仅状态派生(daq-node.ts:116-137)+ WS 广播/事件库;全仓无 webhook/smtp/ack 实现——工人不在电脑前 = 报警无效。
- **方案**(落点已按实际代码修正):
  1. **现状无独立 alarm 表**(alarm 只是 DaqNode 派生态 daq-node.ts:118-130;channel_events 是 Agent 频道表,与 DAQ 报警无关)——在 workshop.sqlite 新建 `alarm_events` 表(alarm_id/node/rule/severity/acked_by/acked_at),写入点挂 daq-controller 状态切换处(applyReading/emitNodeChanged :372-374);
  2. 外送通道抽象 AlarmNotifier,首实现 Webhook(通用 POST,兼容钉钉/企微/飞书机器人),挂同一状态切换点(广播已走 setBroadcast 注入回调 daq-controller.ts:381-384,ws.ts:678 接线,Notifier 扩展为监听器列表即可);
  3. 前端报警列表加「确认」按钮(新增 ack 端点写 acked_by/acked_at)+ 15 分钟未确认升级重复通知(escalation 计数存 alarm_events);
  4. 外送失败重试 3 次退避,失败计数入 daq.controller 指标帧。
- **验收**:mock 越限 → webhook 收到 POST → 前端确认 → 不再升级;外送端点不可达时计数增长且不阻塞主链路。
- **量级**:2 天。

### S6. 数据备份定时任务
- **现状**:主库 SQLite 单文件无任何备份;TSDB 丢弃无补录。
- **方案**:
  1. Nitro 定时任务(setInterval + globalThis key 防 HMR 重复 + unref(),即 ws.ts:439-454 保留期清理的现成模式):`VACUUM INTO` 每日快照到 data/backups/(保留 N 份轮转,N 可配)。**主库为 node:sqlite DatabaseSync**(database.ts:16,非 better-sqlite3),路径 resolve(dataDir,'workshop.sqlite')(plugins/workshop.ts:90);**users.sqlite 与 daq-timeseries.sqlite 需一并纳入备份**(同一 VACUUM 模式三库各一份);
  2. 主库补 synchronous=NORMAL(与 TSDB 仿真库对齐,db/database.ts:575 附近);
  3. backfill 不做(丢弃样本缺原始时间线,补录意义有限;tsdbDropped 计数已在,纳入 R4 指标暴露即可)——显式记为「不执行」,理由如前。
- **验收**:人工触发备份 → 停进程 → 用快照恢复启动成功;轮转不超 N 份。
- **量级**:0.5 天。

---

## P1 —— 运维韧性与规模(规模化落地前补齐)

### R1. 结构化审计日志模块
- **现状**:仅 DCW 写历史(dcw-recipe.repo.ts:49,279-281,**不含操作者**)与任务 routeReason(task.ts:40);无通用 audit 模块;且 S4 修复后审批有了裁决人但无统一审计视图。
- **方案**(迁移惯例已核实:无版本号机制,新表直接追加进 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS,initWorkshopDb 幂等,database.ts:25-213,574-591):
  1. 新建 audit 表(actor/actor_kind/action/target_kind/target_id/detail_json/at);
  2. **埋点放路由层**(controller/service 层不接收用户参数):write.post.ts:12、decide.post.ts:11、apply.post.ts:11、dcw/index.post.ts:12 与 [id].delete.ts:11——五处均已调 resolveUser 能直接拿 {id,name,role};DCW 写历史补 operator;
  3. 提供 GET /api/workshop/audit 查询端点(admin 可查全部,editor/user 限自身)。
- **验收**:执行一次「写→批准→配方应用」全链路,audit 表产出完整谁/何时/做了什么记录。
- **量级**:1.5 天。

### R2. Token 过期 + 细粒度 RBAC
- **现状**:token 永不过期(user.repository.ts:117/181),仅可吊销;角色 admin/editor/user 三级,权限粒度止步「管理面/作业面」分域。
- **方案**(渐进,**范围已收敛避免过度设计**):
  1. **后端过期**:users.sqlite user_tokens 加 expires_at 列,过期判断收敛在 findByToken 单点(user.repository.ts:187)即可覆盖 resolveUser/resolveAgentOrUser/me 三处消费;存量 token 宽限 30 天;不做刷新端点/前端静默续期——**已核实前端请求层不统一**(app/plugins/http.ts:42 拦截器只弹提示,TownView.vue:1635 等大量裸 fetch 绕过),静默刷新需先统一请求层,属独立前端工程,不混入本期;到期 401 后用户重新登录即可(量级从 1.5 天降至 0.5 天);
  2. channel 级 RBAC:**需新建「用户×channel」成员表**(现状无 channel_members,workspace_channels 无 role、channel 仅 owner_user_id 单属主,database.ts:190-195),加表 + channel 路由权限判定,2 天;SSO/LDAP/2FA 留待真实客户诉求再排期。
- **量级**:后端过期 0.5 天;channel 级 RBAC 2 天。

### R3. 高危管理操作 maker-checker(双人复核)
- **现状**(复核时发现比原分析更宽的缺口):apply.post.ts:11 与 controller.post.ts:11 **仅 resolveUser——任何登录用户(含 role=user)均可应用配方/启停控制器**,连 owner/admin 判定都没有;节点删除(dcw-controller.ts:314-330)同理。
- **方案**:**不强行复用 tool-approvals**(其 pending Map 是「工具调用方 await」模型,带 180s 超时与 resolve 回调,管理操作无等待方——结构不匹配,硬套属过度设计)。改为:① 先补齐三处端点的基础权限判定(admin/editor 才可执行,一行 requireRole);② 新增独立轻量 approval_requests 表(dangerous 操作经 config 开关默认关,开启后 POST 创建待审记录 → 另一 admin 确认后放行,申请人≠批核人硬校验)——与 S4 的表结构对齐字段以便 R1 统一审计视图。
- **量级**:1 天(基础权限判定 0.25 天 + approval_requests 表与端点 0.75 天;与 S4 仅共享表结构对齐,不依赖实施顺序)。

### R4. 平台自监控(Prometheus + 结构化日志)
- **现状**:无 /metrics;console.log 直出;丢弃/丢失指标只在 daq.controller 帧内(daq-controller.ts:391-405,662-664);WS 落库失败仅 console.error 无计数(ws.ts:213-215)。
- **方案**(范围已按复核收敛,避免全量替换的过度工程):
  1. /api/metrics 端点:鉴权是逐 handler 显式调用、无全局中间件(仅 middleware/request-log.ts 记日志),/api/metrics 不调 resolveUser 即天然免鉴权——文本格式直出,不引依赖:daq 丢弃/迟到/队列积压(daq-controller.ts:391-405,662-664 已有数据)、ws 落库失败计数、审批挂起数、备份时间戳;
  2. 极简 logger(级别 + JSON 行,env 开关):**只替换 server/services/workshop 目录**(~68 处,大头在 manager 11/agent-runtime 10/scheduler-loop 8);request-log、plugins、mcp 的 console 保留——全量 84 处/31 文件替换属过度且徒增回归面;
  3. 平台自身告警:复用 S5 webhook——tsdbDropped 连续增长/队列积压超阈时自报警。
- **量级**:2 天。

### R5. 边缘运行时独立进程(edge-agent)
- **现状**:采集/控制运行时是中心化进程内单例(WorkshopManager plugins/workshop.ts:112、DaqController daq-controller.ts:658-670、DcwController dcw-controller.ts:728-733,均 globalThis);MQTT 队列架构已为「边缘采集 → 中心汇聚」预留,但边缘侧无法独立部署。
- **方案**(分两步):
  1. 本期仅做**可拆性准备**:WS 广播已是注入回调(bindDcwBroadcast,daq-controller.ts:101,381-384)无需动;真正的反向依赖是直接 import device-twin.repo 做遥测回写+失败自愈解绑(:29,346-358)与 dcw/line-run、dcw-recipe.repo 配方窗口耦合(:35-37)——把这两处收敛为接口(上报接口 + 配置注入);
  2. 独立 edge-agent 进程(读同一 config 的 daq 段,经 MQTT 上行)作为后续独立排期——真实工厂多网关场景出现时启动。
- **量级**:本期准备 1.5~2 天(复核原判 1 天偏乐观);独立进程 5+ 天(暂不承诺)。

### R6. 协议广度(按客户协议优先级排期)
- **现状**:modbus-tcp(读写)+ opcua client(读写)+ mock;S7 仅预留(daq/drivers.ts:222,302+;dcw/drivers.ts:166,242,284-285);无 OPC UA Server。
- **方案**:按真实接入需求驱动,预排优先级:S7(西门子 PLC 国内厂覆盖率最高)→ Modbus RTU(串口网关场景)→ EtherNet/IP → OPC UA Server(被第三方 SCADA/MES 集成)。**无真实接入需求时不预做**——驱动接口(daq/drivers.ts 注册表)已为此留好插槽,每个新驱动约 2~3 天。

---

## P2 —— 锦上添花(有需求再做)

| # | 项 | 说明 | 量级 |
|---|---|---|---|
| X1 | 文档定位声明 | README 增补「本平台为监督层(supervisory layer),秒级软实时;时序控制(<10ms)必须在 PLC 内完成」——分析属实:README 无此声明,存在被误用风险 | 0.5h |
| X2 | 非线性标定/what-if | decoder/encoder 线性钩子 → 查表/温漂补偿;机理仿真与预测性 what-if 需真实工艺模型输入,暂不预做 | 按需 |
| X3 | 报表导出 | 五维查询已备 → CSV 导出 + 班次日报定时生成 | 1~2 天 |
| X4 | HA/水平扩展 | 进程内单例架构短中期不改;目标形态是 R5 边缘拆分后中心层再无状态化——属架构演进,单独立项 | 立项级 |

---

## 实施前可行性复核(2026-08-31 第二轮)

计划初稿完成后,又对全部条目做了**落点级可行性复核**(两路并行,只读),修正已直接合入上文各条:关键结论——S1 需新增 mosquitto.conf 文件(仓库现无)且配置为构建期烘焙需重启生效;S3 证书字段走 shared/daq-protocol.ts configFields(UI 自动渲染)且证书路径必须纳入连接池 key;S5 落点修正为新建 alarm_events 表(channel_events 与 DAQ 报警无关);S6 主库实为 node:sqlite DatabaseSync 且需连同 users.sqlite/timeseries 三库齐备;R1 埋点应放路由层(service 层拿不到用户);R2 砍掉前端静默刷新(请求层不统一,独立工程),过期收敛 findByToken 单点;R3 发现比预期更宽的缺口(apply/controller 仅 resolveUser,任何登录用户可操作)且不复用 await 型审批结构;R4 日志替换收敛到 workshop 服务目录(全量 84 处替换属过度);R5 工期上调至 1.5~2 天。回归脚本(test-task-engine.ts/test-scheduler-loop.ts/_dbg-full-feature-e2e.mjs)均已确认真实存在。

---

## 执行顺序与回归基线

**建议批次**(每批独立可验收,互不阻塞):

1. **第一批(安全止血,~2 天)**:S4(审批留痕)→ S2(生产密钥校验)→ S1(MQTT 鉴权)→ S3(OPC UA 默认安全)
2. **第二批(运维闭环,~3 天)**:S6(备份)→ S5(报警外送+ack)→ R4(指标+日志)
3. **第三批(合规与规模,~5 天)**:R1(审计日志)→ R2 前半(后端过期 0.5 天)→ R3(高危判定+双人复核)→ R2 后半(channel RBAC,2 天)
4. **持续项**:R5 第 1 步可拆性准备、R6 按客户协议触发、X1 随手做

**回归基线**(沿用既有验证体系,每批结束全跑):

- pnpm eslint(改动文件 0 错误)+ pnpm build;
- scripts/test-task-engine.ts / test-scheduler-loop.ts ALL PASS;
- scripts/_dbg-full-feature-e2e.mjs 全功能 E2E ALL PASS(含 HITL 链路——S4 改造后必须重验审批流);
- 新增针对性探针:decide 裁决记录含裁决人 / 默认密钥生产拒绝 / 备份恢复演练 / webhook 报警送达。

**原则**:与既有两轮一致——每项以 文件:行号 落点最小化改动,不做顺带重构;凡标注「按需/不执行」的项保留判断理由,避免下一轮重复审计。
