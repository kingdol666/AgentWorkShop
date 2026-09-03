# 数控读写集成

v0.7 起,每个数控(DCW)节点都是一条**读 + 写一体的工艺参数通道**:写,是把工程量
设定值经换算下发到 PLC 并同址回读校验(既有能力);读,是把 PLC 当前值经同一套换算
取回展示 —— 在数控界面、数字孪生面板与 Agent 工具面三处,设定值(SET)与实际读数(ACT)
并排可见。

```
SET(设定值)                          ACT(实际读数)
用户/Recipe/Agent ──写──▶ PLC 寄存器 ──读──▶ 数控页 · 孪生面板 · Agent
      换算/标定/回读校验        解码/标定
```

## 三种读法

| 方式 | 触发 | 适用 |
|---|---|---|
| 周期读 | 节点元数据 `readIntervalMs`(缺省 5000ms;`0` = 关闭) | 产线常态:孪生/数控页持续看到 PLC 当前值 |
| 手动读 | 数控页行内「读取」按钮,或 `POST /api/workshop/dcw/:id/read` | 现场调试、按需核对 |
| Agent 读 | Agent 工具 `dcw_read(node_id)` | 下发前取证、下发后复核 |

读是被动观测:不受控制网关暂停与产线运行门控的限制(任何时候都允许「看表」),
失败只记 `lastReadError` 供悬停查看,绝不污染写状态机,也绝不向 PLC 写任何值。

## SET / ACT 对照

- **数控详情页**:节点表新增「PLC 读数」列 —— 读数 + 最近读取时间 + 「读取」按钮;
  读失败的行显示点线提示,悬停可见原因。
- **数字孪生面板**:每张设备卡的智控通道在 SET 值下新增 **ACT 行**(绿色实时读数),
  与 DAQ 通道同一套控制室视觉。
- **一致性判定**:读回值经与写链路对称的标定解码(transform)换算成物理量;
  Agent 的 `dcw_read` 会直接给出「读数与设定一致 / 存在偏差」的对照结论。

添加节点向导与节点编辑中可设「周期读(ms)」;`mock` 驱动的读数来自模拟 PLC
(掉电保持,与真实寄存器语义一致)。

## Agent 读写一体

```text
dcw_read(node_id)              # 读 PLC 当前值(免审批,被动观测)
dcw_control(node_id, value)    # 下发设定(量程 ∩ 配方窗联锁;manual 模式走 HITL)
```

推荐流程:`my_industrial_nodes` 理解节点 → `dcw_read` 取证 → `dcw_control` 小步下发
→ 等待工艺响应 → `dcw_read` 复核 ACT 是否收敛到 SET。每次成功下发仍会开调控闭环
优化记录,`dcw_read` 是判定 `keep / rollback` 的取证手段之一。

## 驱动支持

| 驱动 | 读 | 写 | 说明 |
|---|---|---|---|
| Modbus TCP / RTU | ✅ | ✅ | 读保持寄存器(数据类型/字节序与写一致),连接池与排队复用 |
| OPC UA | ✅ | ✅ | 读节点值(会话池复用) |
| mock | ✅ | ✅ | 模拟 PLC 掉电保持,验收链路用 |
| MQTT / HTTP | — | ✅ | 单向发布型通道;读请改用同址的数采节点 |

真实链路验收:`scripts/dev-modbus-simulator.mjs`(1502 端口从站,40021+ 为写入即保持的
设定值组)配合 `scripts/_dbg-dcw-read-rest.mjs` 与 `scripts/_dbg-agent-dcw-rw.ts`,
对真实 Modbus TCP 做写→读 roundtrip,不依赖任何 mock。
