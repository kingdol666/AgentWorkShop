---
name: aw-plc-sim-twin
description: AgentWorkShop PLC 模拟器孪生生成 skill。当需要根据平台既有产线节点(按线)或文档协议/API 输入输出内容,自动在 plc-node-simulator 中创建模拟孪生节点与模拟生产数据(hook 一阶滞后/因果耦合动力学)时使用;覆盖虚拟环境预演、无预设新场景快速建模拟产线、割接真实设备前的演练。触发词:模拟孪生、孪生节点、虚拟预演、模拟产线、割接前演练、文档建模拟器、模拟生产数据。不适用于:真实设备接入(见 aw-line-onboarding)与内置预设场景(直接 applyPreset)。
---

# AgentWorkShop PLC 模拟器孪生生成

把平台既有节点(或文档提炼的点位蓝图)镜像成 plc-node-simulator 的**模拟孪生设备**:
同一套语义名称/量程/精度,SV 可写、PV 带真实动力学(一阶滞后、因果耦合、噪声)。
虚拟环境跑通后割接真实设备只换 driverConfig 端点,治理面(四层限界/HITL/分级/审计)零改动。

## 前置条件

- **MCP 集成开关已启用**:平台 Web「系统设置 → MCP 集成 → 启动 MCP 集成」打开(或为
  MCP 进程设 env `AW_MCP_ENABLED=true`)。未启用时 `aw_status` 返回 `mcpEnabled=false`,
  除 `aw_status` 外所有工具调用被拒——先引导用户开启,不要绕过。
- AgentWorkShop 实例运行中(`AW_BASE` 缺省 `http://127.0.0.1:3001`);凭据 env
  `AW_TOKEN`(优先)或 `AW_EMAIL`/`AW_PASS`;未鉴权先 `aw_login`。
- 模拟器:脚本自动拉起影子树(缺省 `../plc-node-simulator-twin-<port>`,绝不指向共享
  dev 模拟器 4010 或他人影子树);模拟器 REST 一律带 `/api` 前缀。

### 0. 连接检查

调 `aw_status`:确认 base/port 与 `mcpEnabled=true`;未鉴权先 `aw_login`。
模式 A 前用 `aw_request` GET `/api/workshop/dcw?limit=200` 与 `/api/workshop/daq?limit=300`
确认目标线的节点在册;空线先走 aw-line-onboarding 阶段 3 供给,或改用模式 B 蓝图。

### 1. 模式选择与输入提炼

- **模式 A(从平台节点反向构造,最常用——虚拟预演/割接前演练)**:
  ```bash
  AW_TOKEN=<token> node scripts/onboarding/sim-twin.mjs \
    --from-platform --line <lineId> [--sim-port 4034] [--dynamics <file>] [--restart]
  ```
  拉取该线全部 DCW(SV)+ DAQ(PV),按协议族归并孪生设备(modbus-tcp/modbus-rtu/mqtt;
  mes-rest/http/opcua 族归一到 modbus-tcp——语义与量程保留,协议真实性由模拟器 export
  的 driverConfig 保证)。SV→manual 可写;PV→hook 一阶滞后跟随**同名 SP**(剥
  `PV/实测/实际/回读` 后缀匹配),无 SP → 有界随机游走。`--dynamics <file>` 按文档因果
  覆盖:`{"拉力强度":{"base":18,"tau":8,"noise":1.1,"follows":[{"sp":"超声功率SP","gain":0.55}]}}`。
- **模式 B(从文档蓝图直接构造——文档协议/API 输入输出已提炼成蓝图 JSON)**:
  ```bash
  node scripts/onboarding/sim-twin.mjs --blueprint <blueprint.json> [--sim-port 4034]
  ```
  蓝图形状见 `sim-twin.mjs` 头注:`devices[].signals[]` 每点
  `{id,name,unit,min,max,decimals,kind:'sp'|'pv',format?:'scalar'|'vector'|'image',initial?,code?,dynamics?{base,tau,noise,follows[{sp,gain}]}}`;
  `kind:'sp'` 生成命令主题(MQTT)/保持寄存器(Modbus)/可写 OPC UA 变量/HTTP 写端点 = 模拟生产可下发生效。
  蓝图 `protocol` 支持 **modbus-tcp / modbus-rtu / mqtt / opcua / http** 五族;opcua 自动生成
  `ns=2;s=<设备>.<信号>` 与可写变量,http 自动生成 `/sim-http/<设备>/api/<信号>` 端点;
  `format:'vector'|'image'` + `code` hook(返回 `{points}` / `{png,width,height}`)可模拟数组/图像多源异构数据。
  `config` 可覆盖协议细节(端口/映射/path);真实值仍以 export 的 driverConfig 为准。
- 文档提炼纪律与 aw-line-onboarding 阶段 1 相同:量程/单位/精度只来自文档或用户确认,
  缺失停下来问,禁止猜测;SP/PV 判定不明必问。

### 2. 生成孪生与失败处置

脚本自动完成:就绪轮询 → 逐设备 `POST /api/nodes` → **tick 活性自检**(双读对比,PV 必须
随时间波动)。失败处置:

- 响应 `<!doctype` HTML = 路径缺 `/api` 前缀或路由未就绪(脚本已内置重试);
- 某设备创建 200 但活性自检报**冻结** = 模拟器 tick 静默死亡怪癖,POST 修不了——
  **整树重启模拟器**(kill 4034 端口属主 + 重跑脚本)即恢复;
- MQTT 设备连不上 = broker 端口错:影子偏移惯例 `18830+(sim-port-4010)×1000`,
  以 ensureSimulator 的 brokerGuard 输出为准。

### 3. 孪生验证(工具面抽查)

- `aw_daq_samples`(先在平台建镜像/接入后)或模拟器 export 双读:PV 值随时间推进;
- 单步写验:`aw_dcw_write` 以 ≤ stepLimit 的最小步写一个 SV,`aw_dcw_read` 回读一致,
  且跟随它的 PV 在 τ+10s 内向预期方向移动(因果耦合验证);
- 平台侧量化验收走 aw-line-onboarding 的 verify-line(V1 数采/V2 越界拒/V3 合法写回环)。

### 4. 接入平台(与 onboarding 对接)

对每孪生设备调模拟器 `GET /api/nodes/:id/export` 取 `items[].driverConfig`(**永不手抄**;
脚本末行 JSON 摘要含全部设备 id 与 sourceNodes 溯源)。新线走 aw-line-onboarding 阶段 2-5
(provision-line → forge-channel → verify-line);已存在的来源线改接 = 逐节点 PATCH
driverConfig 指向孪生端口(**治理配置限界/stepLimit/绑定零改动**——这正是虚拟预演的价值)。

### 5. 验收清单

- [ ] 孪生设备全部创建且 tick 活性自检通过(无冻结)
- [ ] 协议矩阵按需覆盖:Modbus TCP/RTU、OPC UA、MQTT、HTTP;HTTP 的 vector/image 端点能落 `daq_frames`
- [ ] SV 写入回读一致;跟随 PV 因果方向正确(有 dynamics 时按预期增益)
- [ ] export driverConfig 已取回并喂给 provision/onboard(平台侧 V1-V6 全绿)
- [ ] 影子树隔离确认(未触碰 4010 共享模拟器与他人影子树)
- [ ] 交付说明含:孪生设备清单、动力学参数、接入的 driverConfig 变更记录

## 纪律

- 只写模拟器影子树,绝不写平台;平台侧接入一律走 onboard.mjs/provision-line.mjs。
- 孪生动力学是**教学级灰箱**(一阶滞后+线性增益):用于流程预演/治理演练/数据分析链验证,
  不宣称物理保真;工艺因果数值以文档与真实产线数据为准。
- 割接真实设备的完整纪律见 aw-line-onboarding「阶段 7:割接真实设备」。
