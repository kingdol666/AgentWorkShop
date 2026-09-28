---
name: aw-node-bind
description: AgentWorkShop 真实场景节点参数绑定 skill。当需要为产线创建写控制(DCW)与数采(DAQ)节点、绑定真实/模拟 PLC 执行点、建立工艺参数映射、配置产品与配方并开跑采集窗时使用。通过 aw 工业 MCP 服务(auto 端口发现)执行,覆盖从模拟器蓝图取数到写读回环验收的标准化全流程。
---

# AgentWorkShop 真实场景节点参数绑定

把一个真实(或模拟器)产线场景接入平台:建产线 → 建 DCW 执行节点(绑定 PLC 执行点)→
建 DAQ 观测节点 → 自动生成参数映射 → 配方开跑 → 写读回环验收 → (可选)授权给 Agent。

## 前置条件

- **MCP 集成开关已启用**:平台 Web「系统设置 → MCP 集成 → 启动 MCP 集成」打开(或为 MCP 进程设 env `AW_MCP_ENABLED=true`)。未启用时 `aw_status` 返回 `mcpEnabled=false`,且除 `aw_status` 外所有工具调用都会被拒绝——先引导用户去设置页打开,不要绕过。
- 本机有运行中的 AgentWorkShop 实例(`aw start`),已挂载 aw MCP 服务(见 `aw mcp --print-config`)。
- 已知场景来源:plc-node-simulator 预设(injection/wwtp/anneal/biax/cast-film-physics 等),
  或真实 PLC 的 Modbus/OPC UA/MQTT/HTTP 地址与寄存器规约。
- 凭据:AW_TOKEN 或 AW_EMAIL+AW_PASSWORD 环境变量;否则先调 `aw_login`。

## 工作流程(按序执行,每步验证后再进下一步)

### 0. 连接检查

调 `aw_status`:确认 base/port/发现来源/鉴权状态,并检查 `mcpEnabled=true`(false 则按前置条件引导开启)。
未鉴权先 `aw_login`。
实例从未初始化管理员时,提示用户走 Web /setup(首注册即 admin),不要代注册。

### 1. 获取执行点规约(禁止手抄 driverConfig)

- 模拟器场景:对模拟器 REST(默认 `http://127.0.0.1:4010`,与平台不同端口)调
  `GET /api/presets/:key` 取蓝图(dry-run,不改现场);对每个控制设备调
  `GET /api/nodes/:id/export` 拿 driverConfig。模拟器不在跑时,先在
  `plc-node-simulator/` 下起服务或用 `bench/lib/sim.mjs` 的 ensureSimulator。
- 真实 PLC:按设备规约准备 driverConfig(modbus-tcp: host/port/unitId/register/
  dataType/byteOrder;或 OPC UA endpoint+nodeId 等)。
- 红线:driverConfig 一律取自设备 export 或设备规约,永不手抄猜测。

### 2. 建产线与产品

- `aw_line_create {name}` → lineId
- `aw_product_create {lineId, name}` → productId。
  ⚠️ `paramLimits` 的键引用的是**已存在的工艺参数键**(由节点创建自动生成)——
  产线上还没有节点时传了会 400(「先创建写控节点生成参数面」)。
  顺序二选一:先建节点再补产品限界,或先建不带 paramLimits 的产品、节点建成后再 PATCH 产品。

### 3. 建 DCW 执行节点(每控制点/SP 一个)

`aw_dcw_create`,必填 `templateRef`(模板 ref = `dcw-<key>`,如 dcw-temp-sp /
dcw-speed-sp / dcw-tension-sp / dcw-pressure-sp;全集见 `aw_dcw_snapshot` 的 templates),
并显式传 `lineId`、`driver`、`driverConfig`、`unit`、`min`、`max`、`decimals`
(decimals 决定量化精度,必须显式传)、`holdIntervalMs`(下发保持周期)。
⚠️ `holdIntervalMs` 必须 **≥ 60s 治理间隔(建议 120000+)**:保持写会刷新节点的
60s 写入冷却锚点,设得比 60s 小(如 2s)会让后续所有手动/Agent 治理写入永久 429。

节点创建成功即自动生成同名工艺参数映射(语义面,key=模板 key)——不需要也不应该
再手工建一遍指向同一节点的映射;只有"无节点先建映射"的场景才用
`POST /api/workshop/dcw/params` 的 access 路径(经 `aw_request`,系统自动建执行节点)。

### 4. 建 DAQ 观测节点(每观测点/PV 一个)

`aw_daq_create`:templateRef(如 daq-temp-tc)、lineId、driver/driverConfig、
unit/min/max/decimals、intervalMs,并写 `semantics` 语义标注(场景编译的 target
词表推断依据,写明物理含义,如"…膜厚质量输出")。

### 5. 启动采集

`aw_daq_controller {action:'start'}`。注意:采集器是内存态,实例重启后必须显式拉起;
产线未开跑时不采样是设计行为,不是故障。

### 6. 配方与开跑

- `aw_recipe_create {productId, name, description, params:[{nodeId, value, min?, max?, stepLimit?}],
  daqWindows:[{nodeId, min?, max?}]}`(params 节点级绑定;daqWindows 是批次内越限报警窗;
  **description 是配方元字段**,写明这套参数服务的目标工况,便于多目标多配方时区分)。
- `aw_line_start {lineId, recipeId}`:逐参数下发,返回 run.results 逐条回执——
  逐条检查,任何失败先解决再继续。
- ⚠️ 单步限提醒:配方 `value` 应贴近设备当前值(开跑下发不走单步限,但后续治理写入走);
  运行期每次 `aw_param_write` 相对当前值不得超过 stepLimit(如 zone 2%/5℃),
  大幅调整要分多步、每步间隔 ≥60s 治理间隔。

### 7. 回环验收(硬性)

1. 写读回环:`aw_param_write {id, value}`(工程量纲)→ 等待一个保持周期 →
   `aw_param_read {id}` 回读,偏差应在 decimals 量化精度内。
2. 限界验证:对参数写一个超出四层限界的值,必须 400 且报文点名约束层
   (参数基准/产品限界/配方窗/节点量程之一)。400 是联锁生效的证据,不是故障。
3. 数据落库:`aw_daq_samples {id, bucketMs, limit}`——注意点序**新→旧**,
   判断趋势前先按 at 升序整理。

### 8. (可选)授权给 Agent

- `aw_team_provision {channelId, lead, worker}` → 取 workerInstanceId(频道内**实例 id**;
  模板 agent id 会被 400 拒,这是防静默失效的设计)。
- 对每个节点 `aw_agent_tool_bind {agentId: workerInstanceId, nodeId, kind: dcw|daq, mode: 'auto'}`。
- dcw 绑定需要产线处于可操控模式。

## 治理红线

- 一切写入走 DCW/参数映射治理链(四层限界+写锁+HITL);DAQ 永不下发。
- 语义面不透出寄存器/字节序——需要 PLC 细节时回到执行点规约(第 1 步),不要猜。
- 复用产线前先 `aw_dcw_snapshot` 查现有拓扑,漂移节点先修复或重建,勿盲目叠加。
- 验收未过不宣告完成;`aw_dcw_read` 失败优先查 driverConfig 与连接,而不是重试写。

## 验收清单

- [ ] aw_status 显示实例与鉴权 OK
- [ ] driverConfig 全部来自 export/规约(有据可查)
- [ ] 产线/产品/节点/映射/配方 id 全部落袋(记录到交付说明)
- [ ] line_start 回执逐条成功
- [ ] 参数写→读回环偏差 ≤ decimals 精度
- [ ] 越界写 400 且点名约束层
- [ ] daq_samples 有数据且时序方向理解正确
