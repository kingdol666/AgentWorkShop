# PLC 连接与参数下发 / 采集文档（模拟孪生）

> 本文件描述本轮演示实际使用的 PLC 连接方式、寄存器映射、参数写入与采集口径。  
> 设备来源：`aw-plc-sim-twin` 生成的独立影子（disposable shadow），不是物理 PLC。  
> 割接真实设备时只替换 `host/port/unitId/register` 等端点字段，语义/量程/stepLimit/绑定/治理不变。

## 1 连接

| 项 | 值 |
| --- | --- |
| 模拟器 API | `http://127.0.0.1:4034` |
| 协议 | Modbus TCP |
| 端点 | `127.0.0.1:37532` |
| Unit ID | `1` |
| 寄存器区 | Holding（4x） |
| 数据类型 | `float32` |
| 字节序 | `big` |
| 设备 | `injection-mold`（注塑机孪生，4 信号） |

> 端点来自模拟器 `GET /api/nodes/injection-mold/export` 的 `items[].driverConfig`，禁止手抄/猜测。

## 2 点位映射

| 平台节点 | 类型 | 信号 | 寄存器 | 单位 | 量程 | 步长/采样 |
| --- | --- | --- | --- | --- | --- | --- |
| 熔体温度SP | DCW（可写） | `meltTemp-sp` | 40001 | ℃ | 150–200 | stepLimit 5；holdIntervalMs 120000 |
| 熔体温度PV | DAQ（只读） | `meltTemp-pv` | 40003 | ℃ | 150–185（warn 158–178） | intervalMs 2000 |
| 保压压力SP | DCW（可写） | `holdPressure-sp` | 40005 | MPa | 20–80 | stepLimit 3；holdIntervalMs 120000 |
| 保压压力PV | DAQ（只读） | `holdPressure-pv` | 40007 | MPa | 20–80 | intervalMs 2000 |

孪生动力学（教学级灰箱）：
- `熔体温度PV` 一阶滞后跟随 `熔体温度SP`（τ≈8s，gain≈0.85，噪声 0.8）；
- `保压压力PV` 一阶滞后跟随 `保压压力SP`（τ≈6s，gain≈0.9，噪声 0.4）；
- 只用于流程/治理/分析链预演，不宣称物理保真。

## 3 参数下发链

```
Agent/HITL 请求
  → 权限校验（agent 成员 + 节点/配方绑定 + 产线/频道 grant）
  → 治理档位（line manual ∪ channel manual ∪ binding manual → HITL 审批卡）
  → 四层限界（节点量程 ∩ 产品限界 ∩ 配方限界 ∩ 活动批次窗口）
  → stepLimit / 频控（recipe opIntervalMs，缺省 60s）
  → 驱动写入（Modbus TCP holding register，float32）
  → 同址回读（readback-verified / transport-ack / unverified 如实分级）
  → intervention_events 台账（from/to/actual/ack/hypothesis/channel/approval）
  → 调控闭环开窗（dcw_judge / 自动回退策略）
```

### 3.1 HITL 审批

- 审批卡 `kind=dcw-approval`，卡片包含：节点/物理量/设定值/有效写入区间/分层限界/Agent 依据 `hypothesis`/上次可辨识性判定与可证伪方式。
- 审批通过才写入；拒绝/取消不落写入，台账不产生 effective 行。
- 审批期间 owner 产线 grant 变化会在批准后复核；失败则拒绝执行。
- 同配方下发频控 60s；`emergency=true` 可豁免频控但审批照挂并标注【应急】。

### 3.2 回读口径

| ACK | 含义 | 可否宣称成功 |
| --- | --- | --- |
| `readback-verified` | 同址回读与目标一致 | 可（设备证实） |
| `transport-ack` | 仅链路受理，无设备回读 | 不可；须 DAQ 独立观测 |
| `unverified` | 无确认通道/回读不一致 | 不可；先核实 PLC 当前值 |

## 4 采集链

```
DAQ controller (start)
  → 按 intervalMs 轮询 Modbus holding register
  → 样本入库（daq_samples），按 line/run/recipe/product 打标
  → /api/workshop/daq/query?line_id=&node_ids=&last_minutes=&bucket_ms=&agg=avg
  → 工业上下文/分析/优化响应窗
```

- 样本窗口参数是 `from/to`（epoch ms）或 `last_minutes`；不是 `fromMs/toMs`。
- 写入后观察窗建议 ≥3×主导扰动周期；本演示 `settle_seconds=45–60`。
- 越界写必须被四层限界拒绝（V2）；合法写回读一致（V3）。
- 采集总控是全局开关；fresh 实例必须先 `POST /api/workshop/daq/controller {"action":"start"}`。

## 5 闭环优化与自动学习

### 5.1 闭环步

`optimization_explore(control_node_id, target_node_id, direction, step, settle_seconds, hypothesis)`：
1. 读目标节点写前窗均值/序列；
2. 依据当前回读值 + 步长/方向生成目标值，clamp 到调试范围；
3. 经 `dcw_control` 全治理链写入（HITL 按档位）；
4. 等待 `settle_seconds`；
5. 读写后窗，交可辨识性引擎判定（IDENTIFIABLE / UNDERPOWERED / CONFOUNDED）；
6. `attachAssessment` 回填 `intervention_events`；
7. 回灌本体证据（已发布本体时幂等）；
8. 反思器蒸馏为 `agent_memories.kind='experience'`（line scope → candidate）。

### 5.2 判读四态

| verdict | 含义 | 学习口径 |
| --- | --- | --- |
| IDENTIFIABLE + significant | 效应可分辨 | 可按符号外推；建议反向步验证 |
| IDENTIFIABLE + 负结论 | Δ 小于 MDE，CI 含 0 | 负结论可入库；不得外推方向 |
| UNDERPOWERED | 响应窗 <3 个主导周期 | 暂定；不得外推 |
| CONFOUNDED | 控制量与自然漂移不可分 | 暂定；随机化相位/ABAB |

### 5.3 人工参与（HITL）

- 参数下发审批（dcw-approval）；
- 经验合并（同结论多任务证据并集）；
- 经验晋升 `candidate → validated`（门判定 + 人工审批）；
- 经验退休 `→ retired`（不物理删除，保留审计）；
- 已发布本体：draft → validate/compile → rule approval → publish（二人规则，solo 例外留痕）。

## 6 安全边界

- 模拟孪生只写影子树，绝不触碰共享 4010 模拟器或其他影子。
- 真实设备割接：停线 → 保存绑定/治理快照 → 开新批次或同步配方基线 → 替换端点 → 只读浸泡 → 人工批准最小步首验 → 三方（配方/设备/镜像）回读核对。
- 物理产线不得运行 V2 越界写或自动 HITL 冒烟。
- 本文件不构成安全认证；软件 PASS ≠ 物理 HIL。
