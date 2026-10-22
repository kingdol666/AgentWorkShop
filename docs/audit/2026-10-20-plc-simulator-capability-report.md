# PLC 模拟器自定义协议 / API / 多源异构数据与 AgentWorkShop 集成核验报告

- 日期:2026-10-20
- 平台实例:AgentWorkShop 0.7.66,dev,`http://127.0.0.1:3001`
- 模拟器:plc-node-simulator,`http://127.0.0.1:4047`(既有实例)+ 4048(本轮全新实例,验证可复现)
- 结论:**能真正实现(模拟器域)**——自定义协议可从蓝图一键生成,平台按导出的 driverConfig 真实接入,写控/数采/配方/多源异构帧/Agent 查询全链跑通。**不是真实 PLC,也不是 Amazon AWS。**

## 1. 能力结论

| 问题 | 结论 | 证据 |
|---|---|---|
| 能否创建自定义协议? | 能。蓝图声明 `modbus-tcp` / `modbus-rtu` / `opcua` / `mqtt` / `http` 五种,`sim-twin.mjs` 自动生成寄存器映射、OPC UA 变量、MQTT 主题、HTTP 端点 | 全新 4048 实例 `6 PASS / 0 FAIL`,5 设备 12 信号 |
| 能否按真实工况模拟? | 能到“工艺因果近似”层:SP=manual 可写,SV/PV 用一阶滞后 hook 跟随同名 SP,带噪声与增益;量程/单位/小数位来自蓝图。**没有对真实设备做动态辨识** | PV 跟随 SP:温度 80→79.9、压力 7→6.99、流量 45→45.1、膜厚 36→36.012 |
| 能否模拟 API? | 能。HTTP 设备自动生成 `/sim-http/<device>/api/<signal>`;标量返回 `{"value":…}`,向量返回 `{"points":[…]}`,图像返回 `image/png` 二进制;SP 端点可 POST 写回 | 12 项平台 `test-driver` 全过(含 vector 8 点、image 68B PNG) |
| 多源异构数据? | 能。标量入 `daq_samples`;8 点向量与 PNG 图像入 `daq_frames` + 对象存储;平台按模板 `signalKind` 正确分流 | 5 个标量节点各有 11+ 样本;向量帧 8 点;图像帧 1×1 PNG/68B,objectKey 已落库 |
| 与 AgentWorkShop 真正集成? | 能。建线/建节点/配方/开跑/频道全部走平台 REST;Agent 的 `daq_query`、`daq_frames`、`line_context` 均可读到该线 | `verify-line` **22 通过 / 0 失败**;Agent 查询 7 节点、向量 P1–P8、图像对象 |
| 通过 skill 创建? | 能。`aw-plc-sim-twin` 全新实例一次生成 5 协议 12 信号并做 tick 活性自检 | `sim-twin: 6 PASS / 0 FAIL`,设备 PV 5/5 在动 |

## 2. 证据链

### 2.1 全新 skill 运行(可复现,4048 隔离实例)

命令:

```bash
node scripts/onboarding/sim-twin.mjs \
  --blueprint docs/audit/2026-10-20-plc-simulator-evidence/reproduce-blueprint-4048.json \
  --sim-port 4048
```

输出(日志 `sim-twin-fresh-run.txt`):

```text
✔ 设备 twin-modbus-tcp(modbus-tcp,2 信号)
✔ 设备 twin-modbus-rtu(modbus-rtu,2 信号)
✔ 设备 twin-opcua(opcua,2 信号)
✔ 设备 twin-mqtt(mqtt,2 信号)
✔ 设备 twin-http(http,4 信号)
✔ 孪生 tick 活性(5/5 设备 PV 在动)
sim-twin:6 PASS / 0 FAIL
```

生成结果:

| 设备 | 协议 | 端点/地址 | 信号 |
|---|---|---|---|
| twin-modbus-tcp | Modbus TCP | 37670, holding 40001/40003 | 线速SP、线速PV |
| twin-modbus-rtu | Modbus RTU-over-TCP | 37671, holding 40001/40003 | 温度SP、温度PV |
| twin-opcua | OPC UA | `opc.tcp://127.0.0.1:4955`,`ns=2;s=twin-opcua.*` | 压力SP、压力PV |
| twin-mqtt | MQTT | broker 56830(4048 实例),`aw/twin/twin-mqtt/*` | 流量SP(命令主题)、流量PV |
| twin-http | HTTP/API | `/sim-http/twin-http/api/*` | 目标SP、膜厚PV(标量)、膜厚断面(向量)、表检图像(图像) |

### 2.2 平台连通性(模拟器 export → 平台 test-driver)

对模拟器 `GET /api/nodes/<id>/export` 取每信号 `driverConfig`,逐项喂给平台
`/api/workshop/daq/test-driver`(PV)与 `/api/workshop/dcw/test-driver`(SP)。

- 4047 实例:`12 pass / 0 fail`(`test-driver-4047.txt`)
- 4048 全新实例:`12 pass / 0 fail`(`test-driver-fresh-4048.txt`)

代表性返回:

```text
PASS modbus-tcp 连接成功,读取 40003 = 47.099998474121094
PASS modbus-rtu 网关连接成功,读取 40003 = 80
PASS opcua     会话建立成功,读取 ns=2;s=twin-opcua.pressure-pv = 7.01
PASS mqtt      Broker 连接成功,收到 aw/twin/twin-mqtt/flow-pv = 45
PASS http      接口可达,取值 = 35.998
PASS http      接口可达,vector 帧 8 点
PASS http      接口可达,image 帧 68B(image/png)
```

### 2.3 平台侧生产线

`provision-line.mjs` 用同一批 export 建线,日志 `provision-multiprotocol.txt`
**17 通过 / 0 失败**:

- 产线:`ln-dd6c9135`「多协议孪生产线-20261020」
- 写控 5 节点:`dw-d0b66f73` 线速SP、`dw-176c4cc2` 温度SP、`dw-0fe4833e` 压力SP、
  `dw-38e28fda` 流量SP、`dw-303456d0` 目标SP
- 数采 7 节点:`dn-6f96cbec` 线速PV、`dn-bcee0027` 温度PV、`dn-bafca691` 压力PV、
  `dn-4de6b1de` 流量PV、`dn-02c099a8` 膜厚PV、`dn-c8279163` 膜厚断面、
  `dn-f0f089f7` 表检图像
- 产品 `pd-f74b5d83`;配方 `rc-2be5c50c` v1(5 参数);活动批次 `rr-b5851dd1`
- 频道 `8bbdd9ae-1737-40ae-b571-82a7d093482e`(绑线,4 成员)
- 自定义向量模板 `ct-a516acc2`(8 点、单位 um、量程 30~40、P1–P8 标签)

### 2.4 多源异构数据落库

`live-snapshot.json` 记录:

- 标量 5 节点:各 11 个降采样点,状态 `ok`,无 `lastError`
- 向量:2 帧,`points` 为 8 个有限数值(如 34.707…35.117),`lineId/recipeId/runId/productId` 均打标
- 图像:2 帧,`kind=image`,`mime=image/png`,`size=68`,`width=1`,`height=1`,
  `objectKey=daq/dn-f0f089f7/2026/10/20/<ts>.png`,`sha256` 已记录

说明:向量/图像**数据形态与管线真实**,但内容是合成占位(8 点正弦断面、1×1 PNG);
不是真实测厚仪/相机的物理数据。

### 2.5 写控与 ACK 分级

`verify-line` 结果 **22 通过 / 0 失败**(`verify-multiprotocol.txt`):

| 节点 | 协议 | 越界拒 | 合法写判定 |
|---|---|---|---|
| 线速SP | Modbus TCP | 64 > 60 拒绝 | readback 47 = 47 |
| 温度SP | Modbus RTU | 130 > 120 拒绝 | readback 80 = 80 |
| 压力SP | OPC UA | 11 > 10 拒绝 | readback 7 = 7 |
| 流量SP | MQTT | 110 > 100 拒绝 | `transport-ack` + 独立 DAQ 观测 45.7→45 |
| 目标SP | HTTP | 41 > 40 拒绝 | readback 36 = 36 |

MQTT 命令主题没有读通道,平台如实返回 `transport-ack`(broker 受理,不冒充设备证实);
验收器用同物理量的 `流量PV` DAQ 样本确认设备侧真的跟随,而不是把链路受理当通过。
模拟器侧同刻 `flow-sp=50, flow-pv=49.1`,DAQ 样本窗口同步抬升,因果链闭合。

### 2.6 Agent 工业工具

以频道 lead 身份经 `/api/workshop/agent-tools/invoke` 调用(`agent-tools-multiprotocol.txt`):

- `daq_query(line_id=ln-dd6c9135)`:返回 7 个节点;自动识别活动批次
  `rr-b5851dd1` / 配方 `rc-2be5c50c`;每节点带单位、量程、状态、样本数、序列与
  “同产线数控设定”工况判读
- `daq_frames(node_id=dn-c8279163, include_points=true)`:向量形态,8 点 P1–P8,
  轴/点单位/物理意义正确
- `daq_frames(node_id=dn-f0f089f7)`:图像形态,1×1 PNG,对象路径与“像素不入上下文”说明
- `line_context()`:产线运行中、活动批次、889 样本打标、5 个配方参数当前 PLC 值

## 3. 本轮发现并修复的问题

1. **验收器把合法 MQTT 写误判为失败**。`verify-line` 的 V3 只认 `outcome.readback`;
   MQTT 命令通道天生无读能力,首轮出现 `21 通过 / 1 失败`。
   修复:V3 新增显式 `ackMode:"transport-ack"` + `observeDaqId` 分支——断言 broker 受理,
   再用独立 DAQ 节点观测物理量跟随;未声明这两个字段时行为不变。修复后 **22/0**。
   同步写入 `aw-line-onboarding` skill 阶段 5 说明。
2. **模拟器 HTTP 导出端口**。`sim-twin` 启动隔离实例时必须把 `SIM_PORT` 传给模拟器进程,
   否则 export 的 HTTP URL 回落到 4010。已在本轮 4048 全新实例验证:12/12 URL 均指向 4048。
3. **蓝图协议生成能力**。`sim-twin` 已覆盖 OPC UA 变量、HTTP 路径/响应模板、
   MQTT 命令主题、向量/图像 hook;本轮用全新蓝图再次验证 6/6。

## 4. 不能宣称的边界(必须如实告知)

- **这是模拟器,不是真实 PLC**。信号是 `manual`/`hook` 生成,动力学是一阶滞后 + 噪声,
  未对真实设备做参数辨识;不能据此宣称“真实工况精度”。
- **“AWS” 指 AgentWorkShop**。仓库依赖中不存在 Amazon AWS SDK / S3 / DynamoDB 连接器
  (`NO_AMAZON_AWS_DEPS`);若需要接 Amazon AWS,需要另做连接器,不在本轮范围。
- **图像/向量内容是合成占位**。管线、元数据、对象存储、Agent 检索都是真的,但 1×1 PNG
  与 8 点正弦断面不代表真实表检/测厚物理数据。
- **MQTT 设备侧证实依赖 DAQ 旁路**。命令通道只有 broker ACK;这是平台 ACK 分级的设计,
  不是模拟器缺陷,但也不能说成“设备回读证实”。
- **故障注入本轮未纳入验收**。模拟器具备 disconnect/stuck 等能力,但本轮只验证正常工况;
  断链/冻结/越界故障演练需单独一轮。

## 5. 复现命令

```bash
# 1. 全新模拟器实例(skill 执行体)
AW_TOKEN=<token> node scripts/onboarding/sim-twin.mjs \
  --blueprint docs/audit/2026-10-20-plc-simulator-evidence/reproduce-blueprint-4048.json \
  --sim-port 4048

# 2. 每设备 export → 平台 test-driver(见 test-driver-fresh-4048.txt)

# 3. 建线/节点/配方/开跑
AW_TOKEN=<token> node scripts/onboarding/provision-line.mjs \
  docs/onboarding/2026-10-20-coating-line/multiprotocol-onboard.json

# 4. 频道
AW_TOKEN=<token> node scripts/onboarding/forge-channel.mjs <channel-config.json>

# 5. 验收
AW_TOKEN=<token> node scripts/onboarding/verify-line.mjs \
  docs/audit/2026-10-20-plc-simulator-evidence/verify-config.json
```

注:`provision-line` 的配置里端口/节点 id 对应 4047 实例;换 4048 端口需同步替换
`driverConfig`,并把 `target-sp` 等 HTTP URL 改为 4048。

## 6. 证据文件

| 文件 | 内容 |
|---|---|
| `sim-twin-fresh-run.txt` | 4048 全新实例 6 PASS / 0 FAIL |
| `reproduce-blueprint-4048.json` | 本轮复现蓝图(端口重映射) |
| `test-driver-4047.txt` / `.json` | 既有实例 12/12 平台连通 |
| `test-driver-fresh-4048.txt` | 全新实例 12/12 平台连通 |
| `provision-multiprotocol.txt` | 建线/节点/配方/开跑 17/0 |
| `channel-multiprotocol.txt` | 频道实例化 2/0 |
| `verify-multiprotocol.txt` | V1–V6 22/0 |
| `agent-tools-multiprotocol.txt` | daq_query / daq_frames / line_context |
| `live-snapshot.json` | 设备、节点、样本、向量/图像帧快照 |
| `verify-config.json` | 验收输入(含 MQTT transport-ack 声明) |
