# MQTT 协议通信审计与修复报告(2026-10-27)

**结论:MQTT 此前"老是出问题"不是 broker 或外部设备的问题,而是平台把一个推送协议
接到了轮询模型上。** 修复后 MQTT 走真正的被动订阅:报文到达即入库(时间戳=到达时刻),
设备停发不再伪造冻值,查询面返回库内最新段,写控可用状态主题回读判 `readback-verified`。
MQTT 专项 E2E **32/32 通过**,全量单测 **589/589 通过**,模拟器协议自测 **5/5 通过**。

- 复现与验收分支:`fix/mqtt-passive-ingest-20261027`
- 模拟器子模块:`plc-node-simulator@d47eb7c`(分支 `fix/mqtt-passive-ingest-20261027`)
- 验收证据:`docs/audit/evidence/2026-10-27-mqtt-protocol/`(`e2e-run.txt`、`assertions.json`、
  `unit-tests.txt`、`simulator-mqtt-tests.txt`)
- 复跑:`npm run build && node scripts/e2e-mqtt-protocol.mjs`

---

## 1. 修复前的实测现象

在全新隔离 home(独立 AW_HOME)+ 真实模拟器(film-line,内置 broker `:18830`,设备 2s 发布)
上复现,四类问题全部命中:

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
    topic(`fingerprint` 变化)/网关停止时回收;失败 5s 退避重试,不刷爆 broker。
  - 报文路径与轮询完全同源:`publishSample → DAQ 队列 → runtime.onSample → 状态派生/告警/
    批次打标 → 时序库`。产线门控一致(未开跑时不入库,订阅保持在线,开跑即续采)。
  - `checkPushLiveness()`:产线在跑但超过 `driverConfig.staleMs` 无报文 → `offline` +
    可读 `lastError`;**停发期间不写任何样本**。
  - 时间戳 = 报文到达时刻,并对同毫秒多报文做单调递增修正。
- 网关停止(`stopAll`)同时回收全部订阅;恢复时由 sweep 重建。

### 2.2 MQTT 连接管理(平台侧)

- 连接池按 `broker + TLS + 账号 + 密码指纹` 复用(旧键只有 host/port,不同凭据会串连接);
- 断线不再 `end(true)` 驱逐整池:交给 mqtt.js `reconnectPeriod=5000` 自动重连,
  `connect` 事件重放全部 topic 订阅;`close` 时清空报文缓存,恢复后不消费断线前旧值;
- `sample()`/`test()` 在未连接时快速失败,不再拿缓存冒充读数;
- 凭据缺省回落全局 `daq.mqtt.*`(此前只回落 TLS,账号密码各说各话)。

### 2.3 查询取库内最新段(平台侧)

- 新增 `daq/storage/latest-window.ts`:`queryLatest` / `queryTaggedLatest`。旧适配器契约
  **不改**(导出游标续页与 AML 训练集仍依赖"最旧段+升序",单测锁定);
  实时面在服务层两步取数:先按旧语义查一次,未吃满 limit 直接返回(稀疏数据零额外查询);
  吃满则二分出"包含末尾 limit 个桶"的最小 from,再取末尾段。
- `/api/workshop/daq/:id/samples`、Agent `daq_query`、EDA `dataQuery`(图表/看板)全部改走
  tail;`daq_query` 额外输出"数据源=时序库 / 窗口末样本 / 库内最新 / 滞后 Ns"。
- `daq_query` 新增 `agg=avg|min|max`(桶聚合口径),非法值明确报错。

### 2.4 MQTT 写后回读(平台侧 + 模拟器侧)

- DCW MQTT 驱动新增可选 `read`:`readTopic + readJsonPath` 存在时等待**写后**新报文
  (写前会 `invalidateMqttTopic` 清缓存,绝不拿写前旧值当回读);周期读允许复用 4s 内缓存,
  避免长时间占住读锁导致手动读 409。未配置 `readTopic` 时明确回"不支持读取回读",
  网关立即收敛为 `unverified`。
- 批量下发经 `verifyRecipeWrite` 补验后,结果从 `transport-ack` 提升为
  `ack=readback-verified / verify.verdict=verified`。

### 2.5 PLC 模拟器 MQTT(子模块)

- 内置 broker 支持 **retained** 消息(订阅即补发;空载荷清除),晚连的上位机立刻拿到当前值;
- MQTT 设备新增可选 `stateTopic`:按 tick 发布 `{setpoint,value,signalId,at}`(retain),
  收到命令主题写入后**立即回显**(不等下一 tick);
- `/export`:命令信号 driverConfig 带 `readTopic/readJsonPath`;
- film-line / injection / wwtp / anneal / scenario 预设全部补 `stateTopic`;
- 协议自测新增"命令立即回显"与"retained 晚订阅"两条断言(5/5)。

## 3. 验收矩阵(32/32)

E2E 使用**专用影子模拟器**(端口 4021 → broker 29830)+ **全新隔离 home 的生产构建**,
不接触共享实例;外部 broker 使用 Docker mosquitto `:1883`。

| 组 | 断言 | 结果 |
|---|---|---|
| A0–A4 | 平台会话 / 内置 broker 端口 / 写信号导出回读主题 / 设备周期发布 / retained 晚订阅 | 5/5 |
| B0–B7 | 网关启动 / 产线开跑 / **逐条真值对账(7 行 vs 7 条)** / 值一致 / **入库节奏 2000ms(=设备 tick,非 intervalMs)** / 时间戳递增 / 到达→可查 2617ms / **produced=consumed,dropped=0** | 8/8 |
| C1–C3 | 停发 → **0 新增样本** / offline + 可读 lastError / 恢复 → 续采 + 状态自愈 | 3/3 |
| D0–D1 | 同 broker 第二台 MQTT 设备 / 两节点并行入库 | 2/2 |
| E1–E2 | 外部 mosquitto 订阅入库(6 行) / 写回 → 设备回显 → 平台回读 44.4 | 2/2 |
| F1–F4 | 直写落到设备(61.5) / 写后回读=61.5 / 批量下发 `readback-verified` / ACK 汇总 0 未证实 0 失败 | 4/4 |
| G0–G5 | Agent 绑定 / **最新值 = 库内最后一条(77.7)** / 数据源+滞后声明 / agg=min / 非法 agg 报错 / 越权拒绝 | 6/6 |
| H1–H2 | 网关停止 → 0 新增 / 恢复 → 订阅重建续采 | 2/2 |

**合计 32 passed / 0 failed / 0 skipped。**
全量单测 `npm run test:unit`:589 passed / 0 failed(含新增 `tests/tsdb-tail.test.ts` 7 条)。
模拟器 `npm run test:mqtt`:5 passed / 0 failed。

关键对照(修复前 → 修复后):

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 20s 入库行数(设备 2s/tick) | 19(成对重复) | 7–10(与真值逐条一致) |
| 停发 9–12s 新增行数 | 11(冻值伪造) | 0 |
| 停发感知 | 300s 后才报陈值 | `staleMs`(E2E=3s)后 offline + 原因 |
| 20min 窗口 limit=1 | 20 分钟前的点 | 最新桶 |
| MQTT 写后验证 | 恒 `unverified` | 状态主题回读 → `readback-verified` |

## 4. 用户六个问题的直接回答

1. **是否真正支持 MQTT 节点通信?** 支持,但修复前是"轮询订阅缓存"的假推送;修复后是
   常驻订阅 + 到达即入库的真推送。
2. **为什么老是这个协议有问题?** 系统侧:采样模型错配 + 冻值窗过长 + 查询取最旧段 +
   写控无回读。外部 broker/设备在全部复现实验中均正常。
3. **是系统问题还是外部问题?** 系统问题(已修);外部链路在 A3/A4/E1 中独立验证正常。
4. **订阅 broker → 入库是否成立?** 成立:B2/B3/B4/B7 逐条对账,时延 2.6s(含设备 2s
   发布周期与批量刷盘)。
5. **是否读库内最新数据?** `/samples`、`daq_query`、EDA 全部取窗口末尾段;Agent 输出
   带头尾时间与滞后秒数。
6. **模拟器的 MQTT 是否创建 broker 并 publish 给上位机订阅?** 是:内置 broker(默认
   `18830`,影子实例随端口偏移)、设备按 tick publish、状态主题 retain;现已补 retained
   与状态回显,`/export` 同时给出读写配置。

## 5. 边界与未覆盖(不要外推)

- **TLS/鉴权**:代码路径统一支持 `mqtts`、CA、用户名/密码与凭据隔离键,但本轮没有
  可用的 TLS broker/凭据,**未做 mqtts 实测**。
- **broker 进程重启**:设备停发/恢复、网关停止/恢复、平台重启均已覆盖;内置 mini-broker
  与平台同进程,未单独杀 broker 验证重连(外部 mosquitto 仅验证在线链路)。mqtt.js
  `reconnectPeriod + resubscribe` 已实现,但"broker 重启后自动重订阅"仍建议在真机 FAT 中复测。
- **QoS2 / 高频**:只验证 QoS0/1 与 0.5–2s 发布周期;>10Hz 或 QoS2 未压测。
- **设备自带时间戳**:样本时间取平台到达时刻;若设备报文内带采集时间,需再实现
  `timeJsonPath`(未做,避免把时钟不同步引入数据)。
- **多节点共享连接**:同 broker 两节点并行入库已验证,但未对"只建一条 TCP 连接"做进程内
  连接计数断言。
- **安全扫描**:本轮 Mimosa 未给出完整扫描结论(此前 hook 提示 `scanner_enobufs` /
  `library_source_limit_exceeded`),**不得宣称项目已通过安全审计**。

## 6. 建议的现场配置

- 节点 `driverConfig.staleMs` 设为设备发布周期的 2–3 倍(如 2s 发布 → 5000ms),
  停发 5s 内即可在 UI/Agent 侧看到 offline 与原因;
- 设备有状态主题时配置 `readTopic/readJsonPath`,写控即可获得 readback-verified;
- 生产 broker 用独立凭据(平台按凭据指纹隔离连接),需要 TLS 时配 `secure/caFile`;
- 若设备只在变化时发布(retain 状态主题),`staleMs` 需按"最长静默期"设置或设 0 关闭
  (此时依赖 retain 的当前值 + 变更事件,平台不会伪造周期样本)。
