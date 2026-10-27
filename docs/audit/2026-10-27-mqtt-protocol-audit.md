# MQTT 协议通信审计与修复报告(2026-10-27)

**结论:MQTT 此前"老是出问题"不是 broker 或外部设备的问题,而是平台把一个推送协议
接到了轮询模型上。** 修复后 MQTT 走真正的被动订阅:报文到达即入库(时间戳=到达时刻),
设备停发不再伪造冻值,查询面返回库内最新段,写控可用状态主题回读判 `readback-verified`。
MQTT 专项 E2E **41/41 通过**,全量单测 **595/595 通过**,模拟器协议自测 **5/5 通过**。

- 复现与验收分支:`fix/mqtt-passive-ingest-20261027`(PR #13)
- 模拟器子模块:`plc-node-simulator@d47eb7c`(分支 `fix/mqtt-passive-ingest-20261027`,已推送)
- 验收证据:`docs/audit/evidence/2026-10-27-mqtt-protocol/`(`e2e-run.txt`、`assertions.json`、
  `unit-tests.txt`、`simulator-mqtt-tests.txt`)
- 复跑:`npm run build && node scripts/e2e-mqtt-protocol.mjs`

---

## 1. 修复前的实测现象

在全新隔离 home(独立 AW_HOME)+ 真实模拟器(film-line,内置 broker `:18830`,设备 2s 发布)
上复现,四类问题全部命中(下表中的前四项为修复前手工复现记录;修复后的自动化断言见 §3):

| # | 现象 | 实测 |
|---|---|---|
| P1 | 同一条报文被重复入库 | 20s 窗口 19 行,值成对重复;节点 `intervalMs=1000`,设备 `tickMs=2000` |
| P2 | 设备停发后继续造样本 | 停发后 12s 仍新增 11 行,全部是最后一条冻值(陈值保护要 300s 才触发) |
| P3 | "最新"实为最旧 | 20 分钟窗口 `limit=1` 返回 20 分钟前的桶;`daq_query` 把数组末元素当"最新" |
| P4 | 写控无法确证 | `POST /dcw/:id/read` 对 MQTT 恒返回"不支持读取";批量下发只能记 `unverified` |

P1/P2 的机理:DAQ 网关每 250ms 扫描、按节点 `intervalMs` 调 `driver.sample()`,而 MQTT
驱动的 `sample()` 读的是"订阅缓存里的最后一条报文"。等价于**用定时器轮询一个推送缓存**:
- 设备 2s 发一条、平台 1s 采一次 → 每条报文写两行,且时间戳是采样 tick 而不是到达时刻;
- 设备停发后缓存不清,平台继续把最后一条当新值写库,直到 300s 陈值窗到期。

P3 的机理:TSDB 端口契约(被导出分页与 AML 训练集依赖)是"窗口超 limit 取**最旧**段、
升序返回"。实时面复用了同一调用,于是 `limit` 越小、"最新"越旧。

P4 的机理:MQTT 驱动只有 publish,没有 read;设备也没有状态回显主题。

## 2. 修复设计

### 2.1 推送式驱动契约(平台侧)

- `DaqDriver` 新增可选 `subscribe(input)`:常驻订阅,每条报文回调 `onSample({value, atMs})`,
  返回 `stop()`。存在 `subscribe` 的驱动**不再进入采样循环**。
- 新增 `DaqControllerPush` 层(`daq-controller/push.ts`):
  - `syncPushBindings()`:按 `enabled + lineId + 驱动能力` 对账订阅;节点停用/删除/换
    topic/换凭据/换 QoS(`fingerprint` 变化)/网关停止时回收;失败 5s 退避重试。
  - 报文路径与轮询完全同源:`publishSample → DAQ 队列 → runtime.onSample → 状态派生/告警/
    批次打标 → 时序库`。产线门控一致(未开跑时不入库,订阅保持在线,开跑即续采)。
    未开跑期间的最近值缓存在绑定上;新批次开跑时补种一次(≤10 分钟内的值)——
    retained-only 设备整批往往只有这一条状态,否则开跑后没有初始值。
  - `checkPushLiveness()`:产线在跑但超过 `driverConfig.staleMs` 无报文 → `offline` +
    可读 `lastError`;**停发期间不写任何样本**(开跑补种是唯一例外,且只补一次)。
  - 时间戳 = 报文到达时刻,并对同毫秒多报文做单调递增修正。
- 生命周期兜底:网关停止时不仅回收已有绑定,还在建连完成处、报文回调、队列消费三处
  校验 `running` —— 建连中的订阅晚到、队列里在飞的帧都不会在"停止"后继续入库。
  绑定在 `subscribe()` 之前先占位登记:retained 种子报文即使在 SUBACK 后立即到达,
  也能被 `onPushSample` 接收,不会因"绑定尚未登记"丢失。
- retained 语义:每个 topic 订阅 entry 生命周期内**首条** retained 作为设备当前状态
  入库一次(种子);断线重连时 broker 重放的 retained 只刷新缓存、**不再入库**
  (`seeded` 标记)。entry 在节点停用/换 topic/网关重启后重建时重新种子;5s 退订窗口内
  的快速启停复用 entry,不重复种子(新批次开跑会触发上面的"最近值补种")。
  只读订阅(测试连接/readMqttValue)不消耗种子:随后建立的推送绑定会用缓存补一次种子。

### 2.2 MQTT 连接管理(平台侧)

- 连接池键按 `broker + TLS + **有效**账号 + 密码指纹` 复用:有效凭据 = 节点显式配置,
  缺省回落全局 `daq.mqtt.*`,连接与池键同源(旧键包含 username/caFile,但漏了 password);
- 订阅指纹由驱动自报(`fingerprint`):broker/凭据/TLS/主题/jsonPath/QoS 任一变化都重建订阅;
  指纹计算做了**不抛错**保护(CA 文件缺失只编码进键,由 subscribe 阶段给可读错误),
  不会让 250ms sweep 定时器抛出异常触发稳定性守卫退出进程;
- 断线不再 `end(true)` 驱逐整池:交给 mqtt.js `reconnectPeriod=5000` 自动重连,
  `connect` 事件重放全部 topic 订阅;`close` 时清空报文缓存;
- `sample()`/`test()` 在未连接时快速失败;测试失败的 client 显式销毁;
- 最后一个消费者退订时**延迟 5s** 再 `UNSUBSCRIBE`/移除缓存(立即退订会与同 tick 的
  换 topic/停用后启用重建订阅竞争,把新订阅一起取消);并发首订阅共享同一个 `ready`
  Promise,失败不留下已 reject 的 entry。
- 队列消费侧只校验网关 `running`,**不**按产线门控丢弃。外部 `/ingest` 是文档化的显式
  入库入口:网关停止时路由直接返回 **503**(不再 200 却无行);网关运行但产线停跑时,
  外部注入按"显式数据注入"语义入库(样本无批次打标)。产线门控只作用于自动采集来源
  (采样 sweep / 推送回调)。

### 2.3 查询取库内最新段(平台侧)

- 新增 `daq/storage/latest-window.ts`:`queryLatest` / `queryTaggedLatest`。旧适配器契约
  **不改**(导出游标续页与 AML 训练集仍依赖"最旧段+升序",单测锁定);实时面在服务层取尾段:
  1. 从窗口末尾向前以 `桶宽×min(limit,512)` 起步、×4 扩展,直到末尾窗口内桶数 ≥ limit
     或触到 `from` —— **不从头扫全窗口**,`from` 缺省(UI 趋势)也不会退化成 epoch 级二分;
  2. 在末尾窗口内做**桶对齐二分**,求最小 from*,使 [from*,to] 桶数 ≥ limit(终止精度=一个桶宽,
     因此至多比 limit 多 1 个桶);
  3. 取 [from*,to] 全部桶 `slice(-limit)`;适配器单次 5000 行上限时再合并 [from*+桶宽,to],
     保证 `limit=5000` 也能拿到最新桶。
- `/api/workshop/daq/:id/samples`(含 **from 缺省**的 UI 趋势路径)、Agent `daq_query`、
  EDA `dataQuery`(图表/看板)全部改走 tail;`daq_query` 额外输出"数据源=时序库 /
  窗口末样本 / 库内最新 / 滞后 Ns"。
- `daq_query` 新增 `agg=avg|min|max`(桶聚合口径),非法值明确报错;工具 schema 同步。

### 2.4 MQTT 写后回读(平台侧 + 模拟器侧)

- DCW MQTT 驱动新增 `read` + `canRead`:`readTopic + readJsonPath` 存在时才启用回读;
  未配置时网关跳过周期读、不把"无回读通道"记成节点读错误(旧实现会每 5s 一条 lastReadError)。
- 写前顺序严格为 **预热订阅 → 清空缓存 → publish**:预热把 broker 的 retained 旧值读进缓存,
  清空后发布,正常路径的写后回读只可能拿到写后报文;冷连接直接订阅也不会把 retained
  旧值误当本次回读。
  - 残余窄竞态:若 broker 在"清空缓存"之后才投递写前 retained(300ms 预热超时 + 网络抖动),
    同值重复下发仍可能被判 verified;F2/F3 覆盖正常路径(attempts=1),未做穷尽竞态证明。
- 周期读允许复用 4s 内缓存(避免长时间占住读锁导致手动读 409);写后验证清缓存后等待新回显。
- 批量下发经 `verifyRecipeWrite` 补验后,结果从 `transport-ack` 提升为
  `ack=readback-verified / verify.verdict=verified`;无 `readTopic` 时如实保持 `unverified`。

### 2.5 PLC 模拟器 MQTT(子模块)

- 内置 broker 支持 **retained** 消息(订阅即补发;空载荷清除),晚连的上位机立刻拿到当前值;
- MQTT 设备新增可选 `stateTopic`:按 tick 发布 `{setpoint,value,signalId,at}`(retain),
  收到命令主题写入后**立即回显**(不等下一 tick);
- `/export`:命令信号 driverConfig 带 `readTopic/readJsonPath`;
- film-line / injection / wwtp / anneal / scenario 预设全部补 `stateTopic`;
- 协议自测新增"命令立即回显"与"retained 晚订阅"两条断言(5/5)。

### 2.6 独立评审轮(findings 已关闭)

首轮评审判 CHANGES_REQUIRED,以下问题均已修复并由 E2E/单测覆盖:

| 评审问题 | 修复 |
|---|---|
| tail 在 `from` 缺省时二分 24 步不够,仍取到 ~90s 前的桶;`limit=5000` 被适配器上限截断 | 改为"末尾扩展 + 桶对齐二分 + 上限合并";新增 from 缺省/5000/稀疏 3 条单测 |
| `stopAll()` 不能取消建连中的订阅,`onPushSample`/队列消费无 running 校验 | 建连完成、报文回调、队列消费三处校验 `running` |
| retained 重放会按到达时刻重复入库;首条 retained 又可能丢失 | `seeded` 语义:首条种子一次,重放只刷缓存;E2E I1/I2 |
| 连接指纹漏 password/caFile/rejectUnauthorized/qos;池键用显式凭据而非有效凭据 | 驱动自报 `fingerprint`(含池键/QoS/topic),池键使用有效凭据 |
| 写后 readback 可能吃到写前 retained,或丢掉立即回显 | 改为写前预热+清缓存再发布;E2E F2/F3 |
| E2E G1 是常值下的伪通过;G3 只查表头 | 恢复随机游走后对比窗口首/末值;G3 对比库内最小值;新增 B8 覆盖 UI 路径 |
| 无 readTopic 的 MQTT 节点每 5s 记读错误噪音 | `canRead` + 网关跳过周期读 |
| 并发首订阅失败会留下孤儿/死 entry;测试失败 client 泄漏;订阅永不退订 | `ready` 共享 + 失败清理 + 延迟 5s 退订 + 测试 client 销毁 |
| 第二轮:指纹计算遇 CA 缺失会抛错(定时器异常→稳定性守卫退出);订阅成功后才登记绑定导致 retained 种子丢失 | 指纹不抛错(CA 错误编码进键);subscribe 前先占位登记绑定,再替换真实 stop |
| 第二轮:队列消费侧按产线门控丢弃,外部 `/ingest` 返回 accepted 却无行 | 消费侧只校验 `running`;产线门控保留在来源侧与路由自身 |
| 第二轮:retained 种子在 SUBACK 后立即到达时可能被丢;`seeded` 语义表述为"每订阅周期" | 占位绑定 + 只有存在消费者才消耗种子;文档改为"每个 topic entry 生命周期首条" |
| 第二轮:G3 的 dbMin 用整 2 分钟窗口,与 daq_query 的末尾 50 桶窗口不一致 | 改为同窗口 `dbWindow.slice(-50)` 对比 |
| 第三轮:停线期间收到的 retained 种子被 onPushSample 丢弃,开跑后无初始值 | 绑定缓存最近值(≤10 分钟),新批次开跑时补种一次;E2E K1 |
| 第三轮:网关停止时外部 `/ingest` 仍 200 但消费侧丢帧 | 路由在网关停止时直接 503;E2E K2 |

## 3. 验收矩阵(41/41)

E2E 使用**专用影子模拟器**(端口 4021 → broker 29830)+ **全新隔离 home 的生产构建**,
不接触共享实例;外部 broker 使用 Docker mosquitto `:1883`。

| 组 | 断言 | 结果 |
|---|---|---|
| A0–A4 | 平台会话 / 内置 broker 端口 / 写信号导出回读主题 / 设备周期发布 / retained 晚订阅 | 5/5 |
| B0–B8 | 网关启动 / 产线开跑 / **逐条真值对账(7 行 vs 7 条,6/7 值对齐)** / **入库节奏 2000ms(=设备 tick,非 intervalMs)** / 时间戳递增 / 到达→可查 2634ms / **produced=consumed,dropped=0** / **from 缺省 limit=1=最新桶** | 9/9 |
| C1–C3 | 停发 → **0 新增样本** / offline + 可读 lastError / 恢复 → 续采 + 状态自愈 | 3/3 |
| D0–D1 | 同 broker 第二台 MQTT 设备 / 两节点并行入库 | 2/2 |
| E1–E2 | 外部 mosquitto 订阅入库(6 行) / 写回 → 设备回显 → 平台回读 44.4 | 2/2 |
| F1–F4 | 直写落到设备(61.5) / 写后回读=61.5 / 批量下发 `readback-verified`(attempts=1) / ACK 汇总 0 未证实 0 失败 | 4/4 |
| G0–G5 | Agent 绑定 / **最新值=窗口末尾桶(38.6,窗口首值 40.7 可区分)** / 数据源+滞后 / **agg=min 输出 34.3=库内最小 34.3** / 非法 agg 报错 / 越权拒绝 | 6/6 |
| H1–H2 | 网关停止 → 0 新增 / 恢复 → 订阅重建续采 | 2/2 |
| I1–I2 | retained 首订阅种子一次(12.3 可查) / **重放不重复入库(1→1)** | 2/2 |
| J1–J4 | 节点停用→停收/启用→续采 / **topic 变更→指纹重建订阅(新主题 42)** / EDA 查询窗口超 limit 取最新段(末点滞后 2s) / 停线停收→重开续采 | 4/4 |
| K1–K2 | **停线期间的 retained 状态在开跑后补种一次** / 网关停止时外部 `/ingest` 如实 503 | 2/2 |

**合计 41 passed / 0 failed / 0 skipped。**
全量单测 `npm run test:unit`:595 passed / 0 failed(含 tail 10 条 + MQTT 驱动指纹/解析 3 条)。
模拟器 `npm run test:mqtt`:5 passed / 0 failed。

关键对照(修复前 → 修复后):

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 20s 入库行数(设备 2s/tick) | 19(成对重复) | 7–10(与真值逐条一致) |
| 停发 9–12s 新增行数 | 11(冻值伪造) | 0 |
| 停发感知 | 300s 后才报陈值 | `staleMs`(E2E=3s)后 offline + 原因 |
| 20min 窗口 limit=1(from 缺省) | 20 分钟前的点 | 最新桶(B8) |
| MQTT 写后验证 | 恒 `unverified` | 状态主题回读 → `readback-verified` |
| retained 重放 | 每次重连多一行冻值 | 首条种子一次,重放不入库(I1/I2) |

## 4. 用户六个问题的直接回答

1. **是否真正支持 MQTT 节点通信?** 支持,但修复前是"轮询订阅缓存"的假推送;修复后是
   常驻订阅 + 到达即入库的真推送。
2. **为什么老是这个协议有问题?** 系统侧:采样模型错配 + 冻值窗过长 + 查询取最旧段 +
   写控无回读。外部 broker/设备在全部复现实验中均正常。
3. **是系统问题还是外部问题?** 系统问题(已修);外部链路在 A3/A4/E1 中独立验证正常。
4. **订阅 broker → 入库是否成立?** 成立:B2/B3/B4/B7 逐条对账,时延 2.6s(含设备 2s
   发布周期与批量刷盘)。
5. **是否读库内最新数据?** `/samples`(含 from 缺省)、`daq_query`、EDA 全部取窗口末尾段;
   Agent 输出"最新"=窗口末尾桶,并单独给出库内最新样本时间与滞后秒数。
6. **模拟器的 MQTT 是否创建 broker 并 publish 给上位机订阅?** 是:内置 broker(默认
   `18830`,影子实例随端口偏移)、设备按 tick publish、状态主题 retain;现已补 retained
   与状态回显,`/export` 同时给出读写配置。

## 5. 边界与未覆盖(不要外推)

- **TLS/鉴权**:代码路径统一支持 `mqtts`、CA、用户名/密码与凭据隔离键(含有效凭据指纹),
  但本轮没有可用的 TLS broker/凭据,**未做 mqtts 实测**;CA 文件内容变化需重连/重启生效。
- **broker 进程重启**:设备停发/恢复、网关停止/恢复、订阅失败重试均已覆盖;内置 mini-broker
  与模拟器同进程,未单独杀 broker 验证重连(外部 mosquitto 仅验证在线链路)。mqtt.js
  `reconnectPeriod + resubscribe` 已实现,但"broker 重启后自动重订阅"仍建议在真机 FAT 中复测。
- **QoS2 / 高频**:只验证 QoS0/1 与 0.5–2s 发布周期;>10Hz 或 QoS2 未压测;QoS1 重投递
  仍可能按到达时刻形成两行(未做 DUP 去重)。
- **设备自带时间戳**:样本时间取平台到达时刻;若设备报文内带采集时间,需再实现
  `timeJsonPath`(未做,避免把时钟不同步引入数据)。
- **retained 语义**:按"状态快照"处理 —— 每个 topic 订阅 entry 生命周期内首条种子一次,
  重连重放不入库;entry 在节点停用/换 topic/网关重启后重建,新订阅会重新种子。
  若设备把**周期性遥测**也设 `retain=true`,后续更新会被当作重放跳过;周期遥测请用
  `retain=false`,仅状态/设定值回显用 retain。retained-only 设备的后续状态变化不会自动
  变成新样本,需要变更事件(`retain=false`)或由 `readTopic` 读取缓存。
- **外部 /ingest 语义**:网关停止时返回 503(不静默丢帧);网关运行但产线停跑时，外部显式注入会入库为无批次打标样本 —— 它是显式数据注入入口，不参与自动采集的产线门控。
- **多节点共享连接**:同 broker 两节点并行入库已验证,但未对"只建一条 TCP 连接"做进程内
  连接计数断言。
- **安全扫描**:本轮 Mimosa 未给出完整扫描结论(此前 hook 提示 `scanner_enobufs` /
  `library_source_limit_exceeded`),**不得宣称项目已通过安全审计**。

## 6. 建议的现场配置

- 节点 `driverConfig.staleMs` 设为设备发布周期的 2–3 倍(如 2s 发布 → 5000ms),
  停发 5s 内即可在 UI/Agent 侧看到 offline 与原因;
- 设备有状态主题时配置 `readTopic/readJsonPath`,写控即可获得 readback-verified;
- 生产 broker 用独立凭据(平台按有效凭据指纹隔离连接),需要 TLS 时配 `secure/caFile`;
- 周期遥测 `retain=false`;仅"最后状态/设定值"用 `retain=true`;
- 若设备只在变化时发布,`staleMs` 按最长静默期设置或设 0 关闭(此时依赖 retained 当前值
  与变更事件,平台不会伪造周期样本)。
