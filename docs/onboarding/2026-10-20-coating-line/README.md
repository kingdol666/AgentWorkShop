# 流延膜精密产线 C01 —— 产线控制优化与接入文档（2026-10-20）

> 用途：作为 `aw-line-onboarding` skill 的真实输入文档；同时定义 PLC 协议、MES API、模拟器蓝图与验收标准。
> 测试端口（本机模拟环境）：平台 `127.0.0.1:3021`，PLC Modbus TCP `127.0.0.1:37550`，MES API `127.0.0.1:15062`。
> 生产接入时只替换 host/port 与凭据引用，节点语义、量程、stepLimit、配方与频道绑定不变。

## 1. 产线背景与目标

- 产线：流延膜精密产线 C01（光学级功能膜）
- 产品：光学级流延膜 A
- 工序：熔体挤出 → 模头流延 → 冷却辊定型 → 测厚/表检 → 收卷
- 优化目标：在膜厚均值保持在 **35.0 ± 0.8 µm**、横向均匀性（max-min）**≤ 2.5 µm**、张力不越界的前提下，尽可能提升线速。
- 控制量：线速、熔体温度、模头压力、冷却辊温度（PLC SP）。
- 观测/质量量：线速、熔体温度、模头压力、冷却辊温度、膜厚、横向均匀性、张力（PLC PV）；MES 熔体温度历史、MES 48 点膜厚断面、MES 批次汇总、MES CCD 图像帧。
- 安全/工艺窗口（四层限界中的参数层）：
  - 线速 20~60 m/min，配方窗口 28~48，stepLimit 2；
  - 熔体温度 220~280 ℃，配方窗口 235~265，stepLimit 3；
  - 模头压力 40~100 bar，配方窗口 55~80，stepLimit 3；
  - 冷却辊温度 15~45 ℃，配方窗口 22~34，stepLimit 2。
- 判据：至少连续 3 个复测窗膜厚均值在窗、均匀性不越限；任一步导致膜厚越窗或均匀性 > 2.5 µm，立即 `recipe_rollback(dispatch=true)` 回退。

## 2. PLC 协议（Modbus TCP）

- 设备：流延主机 C01，`host=127.0.0.1`，`port=37550`，`unitId=1`
- 区域：holding register；数据：float32（2 words）；字节序：big；地址基址：40001
- 写点（SP）与读点（PV）必须分开建模；SP 的 `stepLimit`/`holdIntervalMs` 在平台节点元数据中配置。

| 信号 | 类型 | 寄存器 | 单位 | 工程范围 | 初始/基线 | 说明 |
|---|---|---:|---|---:|---:|---|
| 线速SP | SP | 40001 | m/min | 20~60 | 35 | 主产能控制量；写入后线速PV一阶跟随 |
| 熔体温度SP | SP | 40003 | ℃ | 220~280 | 250 | 热工艺主控制量 |
| 模头压力SP | SP | 40005 | bar | 40~100 | 65 | 挤出负荷 |
| 冷却辊温度SP | SP | 40007 | ℃ | 15~45 | 28 | 定型冷却 |
| 线速PV | PV | 40009 | m/min | 20~60 | — | 跟随线速SP（τ≈4s） |
| 熔体温度PV | PV | 40011 | ℃ | 220~280 | — | 跟随熔体温度SP（τ≈12s） |
| 模头压力PV | PV | 40013 | bar | 40~100 | — | 跟随模头压力SP（τ≈8s） |
| 冷却辊温度PV | PV | 40015 | ℃ | 15~45 | — | 跟随冷却辊温度SP（τ≈10s） |
| 膜厚PV | PV | 40017 | µm | 30~40 | 35.2 | 与线速负相关、与熔体温度/模头压力正相关（模拟耦合） |
| 膜厚横向均匀性PV | PV | 40019 | µm | 0.5~5 | 2.0 | 与熔体温度正相关、与模头压力负相关（模拟耦合） |
| 膜张力PV | PV | 40021 | N | 100~200 | 145 | 随线速上升（模拟耦合） |

> 模拟器由蓝图 `blueprint.json` 生成；寄存器由 signal 顺序自动分配（40001 + 2×index），上表与该顺序一致。
> 真实 PLC 割接时以设备导出/寄存器表为准，禁止手抄猜测。

## 3. 自定义 MES API

- Base URL：`http://127.0.0.1:15062`
- 认证：`x-api-token: <token>`；平台侧只存 `secretRef=DEMO`，token 从环境变量 `AW_MES_DEMO_TOKEN` 读取，不落配置。
- 所有历史接口平台注入 `from`/`to`（ISO）与 `pageSize`/`cursor`，分页以 `nextCursor` 耗尽为完成。

### 3.1 当前值 / 历史（标量）

`GET /api/v1/params/melt_temp/current` → `{ data: { value, ts, fields:[{field,label,unit,kind,description}] } }`

`GET /api/v1/params/melt_temp/history?from&to&pageSize&cursor` →
`{ data: { rows:[{ts,value}], nextCursor, fields:[...] } }`

节点映射：`readMap.response.valuePath=data.value`、`tsPath=data.ts`、`dictionaryPath=data.fields`；
`historyMap.response.rowsPath=data.rows[*]`、`valuePath=value`、`tsPath=ts`、`nextCursorPath=data.nextCursor`、`dictionaryPath=data.fields`。

### 3.2 膜厚断面（向量，每帧 48 点）

`GET /api/v1/quality/thickness?from&to&pageSize&cursor` →
`{ data: { rows:[{ts, profile:[48], mean, lane_unit}], nextCursor, lanes:48,
  fields:[{field:'profile', label:'膜厚横向断面', unit:'um', kind:'vector', points:[{index,label,unit}]}, ...] } }`

节点映射：`historyMap.response.format=vector`、`valuesPath=profile`、`tsPath=ts`、`nextCursorPath=data.nextCursor`、`dictionaryPath=data.fields`。

### 3.3 批次汇总（map/table，多加工参数）

`GET /api/v1/batches?from&to&pageSize` →
`{ data: { rows:[{batch_id,start,end,mean_thickness,thickness_sigma,cpk,defect_count,verdict,note}], fields:[...] } }`

节点映射：`format=table`、`rowsPath=data.rows[*]`、`tsPath=start`、`dictionaryPath=data.fields`。

### 3.4 CCD 图像组（图像帧）

`GET /api/v1/vision/ccd?from&to&pageSize` →
`{ data: { frames:[{ts,mime,width,height,data(base64),defects}], fields:[...] } }`

节点映射：`format=image`、`rowsPath=data.frames[*]`、`tsPath=ts`、`dataPath=data`、`mimePath=mime`、`dictionaryPath=data.fields`。

### 3.5 写入面（MES 设定值）

本产线的执行控制走 PLC SP（配方下发）；MES API 本轮作为**质量数据源**接入，不承担写控。
如后续 MES 增加设定点接口，按 `writeMap` 的 `path/bodyTemplate({value})/response.ackPath` 接入，仍需走配方 + HITL。

## 4. 虚拟模拟与因果设计

- PLC 孪生：`blueprint.json`，影子模拟器 `http://127.0.0.1:4046`，Modbus 设备端口 37550。
- 模拟动力学：
  - 线速PV = 线速SP（一阶滞后 τ≈4s）；
  - 熔体温度PV/模头压力PV/冷却辊温度PV 分别跟随各自 SP；
  - 膜厚PV = 35.2 − 0.06×(线速SP−35) + 0.04×(熔体温度SP−250) + 0.08×(模头压力SP−65) + 噪声；
  - 横向均匀性PV = 2.0 + 0.02×(熔体温度SP−250) − 0.03×(模头压力SP−65) + 噪声；
  - 张力PV = 145 + 1.2×(线速SP−35) + 噪声。
- MES 质量数据由 `scripts/dev-mes-simulator.mjs` 生成（确定性伪随机、15min 卷次、90min 异常窗），所有接口带字段字典。
  本线为与文档工况对齐，启动时设置：`MES_THICKNESS_BASE=34.5`、`MES_THICKNESS_CENTER=35`、`MES_THICKNESS_TOL=0.8`、
  `MES_THICKNESS_SHAPE_SCALE=0.3`、`MES_MELT_TEMP_BASE=250`、`MES_MELT_PRESSURE_BASE=6.5`、`MES_LINE_SPEED_BASE=35`；
  默认值保持既有 50µm 模拟不变。
- 模拟是教学级灰箱：用于流程预演/治理演练/数据分析链验证，不宣称物理保真；真实工艺数值以现场为准。

## 5. 接入与作业流程（skill 顺序）

1. **系统能力基线**（先于 skill）：启动平台/PLC 孪生/MES 模拟器，跑 `test-connection.mjs`（Modbus SP/PV + MES readMap）；平台侧单独验证 Modbus 读、合法写回读、越界拒绝、MES `mes_fetch` 向量+字典。
2. **模拟器协议/因果**：`sim-twin.mjs --blueprint` 生成孪生；tick 活性；SP 写入后 PV 方向验证。
3. **调用 aw-line-onboarding**：`onboard.mjs onboard.json --smoke`
   - 若目标线不存在则新建；SP/PV 按 kind 建模；量程/stepLimit/holdIntervalMs 按本文；
   - 主配方含 4 个 PLC SP；MES 直取节点通过 `mesFetchGrants` 生成授权配方并绑定数据分析师；
   - 场景 `optimize` → `chtpl-generic-optimize-default`；绑线、插件、种子任务；
   - V1-V6 + 冒烟步（真实 HITL 批准后 recipe_propose 下发，设备证实）。
4. **人工投用**：本流程只到“可投用”；产线负责人必须 judge & taste 后才可正式投用。

## 6. 复现命令（隔离实例）

```bash
# 1) MES 模拟器（与本线工况对齐）
MES_SIM_PORT=15062 MES_SIM_TOKEN=<来自环境变量> \
MES_THICKNESS_BASE=34.5 MES_THICKNESS_CENTER=35 MES_THICKNESS_TOL=0.8 \
MES_THICKNESS_SHAPE_SCALE=0.3 MES_MELT_TEMP_BASE=250 MES_MELT_PRESSURE_BASE=6.5 \
MES_LINE_SPEED_BASE=35 node scripts/dev-mes-simulator.mjs --port 15062

# 2) PLC 孪生（蓝图模式；Modbus 37550，模拟器 4046）
node scripts/onboarding/sim-twin.mjs \
  --blueprint docs/onboarding/2026-10-20-coating-line/blueprint.json --sim-port 4046

# 3) 隔离平台（示例端口 3021；首次注册管理员后导出 AW_TOKEN）
AW_MODE=home AW_HOME=<隔离配置根> AW_RATE_LIMIT_OFF=1 \
AW_MES_DEMO_TOKEN=<来自环境变量> NUXT_SESSION_PASSWORD=<会话密钥> \
node scripts/start.mjs --port 3021

# 4) 调用 onboarding skill（连通 → 供给 → Channel → V1-V6 → MES 直取 → 冒烟）
AW_BASE=http://127.0.0.1:3021 AW_TOKEN=<管理员token> \
node scripts/onboarding/onboard.mjs \
  docs/onboarding/2026-10-20-coating-line/onboard.json --smoke
```

## 7. 验收矩阵

| 编号 | 验收项 | 通过标准 | 证据 |
|---|---|---|---|
| A1 | 文档与配置完整性 | 点位表/寄存器/量程/stepLimit/MES 端点/字段字典/优化判据齐全；blueprint/onboard JSON 可执行 | 本文件 + `blueprint.json` + `onboard.json` |
| A2 | 系统能力基线 | Modbus 连通、读、合法写回读、越界拒绝；MES readMap 连通、`mes_fetch` 向量+字典 | test-connection 输出 + 平台响应 |
| A3 | 模拟孪生 | tick 活性 PASS；export driverConfig 与本文寄存器一致；SP→PV 因果方向正确 | sim-twin 输出 + 双读/写回读 |
| A4 | skill 自动接入 | onboard 阶段 1-4 全 PASS；V1-V6 全绿 | onboard 输出 |
| A5 | 配方/Channel/HITL | 主配方 4 SP；MES 授权配方可见；optimize 频道绑线/成员/插件/种子任务；冒烟步 HITL 批准 + 设备证实 | onboard 摘要 + runId |
| A6 | 回归与可重复 | unit/typecheck/lint/build 通过；skill 校验通过；重跑 onboard 幂等 | 命令输出 + 报告 |

## 8. 红线

- 受保护演示线 `ln-d7e0a2a2` 及其节点/配方/批次只读，绝不写入或删除。
- 凭据只经环境变量；文档、配置文件、日志不得出现明文 token。
- 配方绑定 manual；未经人工批准不得下发。
- 不猜测缺失量程/单位/SP-PV 方向；文档缺失必须停下来问。
