# PLC 节点真实模拟器

多协议虚拟工业设备,作为**真实 PLC 的替身**:模拟物理设备中的信号源与数据通信发出,与 AgentWorkShop 全链路对接(数采采集 + 数控写控 + 实时监视 + 故障演练)。

## 一键启动

```bash
npm install
npm run dev          # 服务 http://127.0.0.1:4010 (UI 内置)
# 浏览器打开 http://127.0.0.1:4010 → 点「薄膜产线预设」→ 五协议设备即出数
```

Windows 注意:本机回环连接需 `NO_PROXY=127.0.0.1,localhost`(代理会劫持 fetch/net)。

## 支持的协议(与 AgentWorkShop 全部协议一一对应)

| 协议 | 角色 | 默认端口 | 说明 |
|---|---|---|---|
| Modbus TCP | 从站(ServerTCP) | 16040 | FC03/04/06/16;float32/int16/int32/uint16/uint32;big/little/wordSwap 字节序(与主项目 decodeRegisters 同约定) |
| Modbus RTU over TCP | 从站(手写帧) | 15041 | `mbap` 模式与主项目 `connectTcpRTUBuffered` 互通(事务 id 回显,客户端补 CRC);`raw-rtu` 模式带真 CRC16 供真实网关 |
| OPC UA | 服务器(node-opcua) | 5840 | 自定义命名空间(默认 ns=2,与主项目 nodeId 约定一致);可写 setpoint 节点回灌;可选用户名密码 |
| MQTT | 设备侧 publisher + **内置 mini-broker** | 18830 | 每 tick 发布信号值到任意 broker(默认内置 18830);payload 模板 `{"data":{"temp":${value}}}`(与主项目 jsonPath 兼容);commandTopic 接收 DCW 下行写并回灌 |
| HTTP | GET 端点 | 4010(同 UI) | `/sim-http/{deviceId}{path}` 返回纯数字文本或 JSON 模板 |

## 数据生成引擎(模拟真实物理设备)

每信号独立策略 + 故障注入 + 标定(`输出 = value × scale + offset`):

- **策略**:constant / sine(正弦) / random-walk(随机游走+钳位) / ramp(斜坡+循环) / **first-order(一阶惯性工艺闭环,PV→SP 收敛,抄主项目 dev-plc-simulator 已验证动力学)** / expression(表达式,`[信号名]` 引用其他信号) / manual(手动覆写) / **hook(用户自定义数据产生器,见下节)**
- **数据形态**:scalar(标量,默认)/ **vector(向量帧,≤4096 点)** / **image(图像帧,PNG 二进制直出)** —— 与主项目 v2 帧管线(daq_frames)对齐
- **故障注入**:stuckAt 卡值 / spike 尖峰越限(触发主项目 daq.alarm) / drift 漂移 / disconnect 断链(端口关闭/HTTP 503,窗后自愈)
- **SP→PV 联动**:SP 寄存器地址配 `writebackTarget` → 外部写 SP 同步更新目标回路的 first-order.sp(真实 PLC 控制语义)

## hook:用户自定义数据产生器(代码动态注入)

信号策略配 `{"kind":"hook","code":"…","timegapMs":2000}` 即可用 **JS 代码控制每一拍的数据怎么产生**:

```jsonc
// code 为 producer 函数体,可直接引用:now / dt / prev / state / vars / min / max / rand
"code": "state.t = (state.t ?? 0) + dt; return prev + (sp(state) - prev) * 0.1"
// return number            → 标量
// return {points:[…]}      → vector 向量帧(如厚度轮廓)
// return {png, width, height} → image 图像帧(base64 PNG)
```

- `state` 是该信号私有持久对象(跨拍保留)→ 可写滤波/积分/状态机等任意逻辑
- `vars` 是同设备其他信号当前值 → 信号间联动
- `timegapMs` 是发送节流(如 2000 = 每 2 秒发一次,期间保持)
- 护栏:禁用 import/require/process/globalThis;编译结果按策略对象缓存

## plant-model:挤出流延数字孪生物理引擎(cast-film-physics 预设)

**所有 DAQ 值不再独立随机,而是从物理状态方程组积分产出** —— 数控调参后,数采按真实物理规律联动:

```
控制(6 DCW,五协议)                     物理状态(欧拉积分,可播种)               采集(7 DAQ)
zone1/2/3 SP(MBTCP 40021/23/25) ─→ 加热区一阶惯性+区间热传导(τ=90s) ─→ 熔体温度(MBTCP 40001)
螺杆转速 SP(OPC UA ns=2;s=AW.N.Sp)─→ Arrhenius 粘度 → 流量 → 泵送腔一阶  ─→ 熔体压力(OPC UA)
牵引线速 SP(MQTT aw/sim/lineSp/set)→ 质量守恒 h=Q/(w·v·ρ) + 输送纯滞后 L/v─→ 平均膜厚(MQTT)
模口间隙 SP(HTTP POST)           ─→ CCD 缺陷率/晶点(对 Tm 抛物线敏感)    ─→ 轮廓向量/CCD图像/缺陷率(HTTP)/晶点(RTU)
```

- 噪声全部走 mulberry32 可播种 PRNG(**同 seed 完全可复现**);真值(未加噪)与协议暴露值(加噪)双列 JSONL 落 `data/truth.jsonl` —— 评测用真值当 ground truth,Agent 只能看到加噪后的世界
- `timeScale`(默认 6×)压缩热惯性等待;`dtMs` 积分步长;全部物理参数可配
- REST:`GET /api/plant/state`(瞬时状态)、`GET /api/plant/truth`(真值流)、`POST /api/plant/phase`(warmup/steady/batch/disturb 工况打标 + 扰动注入 heaterDecay/feedTempStep/feedDriftPerMin)、`GET /api/plant/optimum`(**离线网格搜索最优窗口 W***,孪生独有 ground truth)
- 物理一致性断言(`npm test`):阶跃收敛/幅值=解析解±2%/滞后反比/停加热压降先升后降/同 seed 复现/稳态代数解≡积分值

## plant-model kind=biax:双拉薄膜产线数字孪生(biax-line 预设)

**BOPET 类双向拉伸全线**:干燥上料 → 挤出(机筒五区+螺杆) → 熔体计量泵 → T 模头铸片(急冷辊/静电毛贴)
→ 纵拉 MDO(预热辊×3+快慢辊拉伸比) → 横拉 TDO 烘箱(预热/拉伸/定型+轨道展幅) → 在线测厚 → 电晕/表面检测 → 收卷(张力锥度/卷径)。

- 9 设备五协议,**30 DCW + 19 DAQ,每个信号带工艺语义描述(description)**——导出后进主项目 semantics → Agent 语义卡
- 厚度因果链(与真机同向):铸片 h₀=Q/(w·v_cast·ρ) → 纵拉 h₁=h₀/R_md(R_md=快/慢辊速比) → 横拉 h₂=h₁/R_td·(1−松弛)
- 拉伸温度窗(MDO 86~110℃ / TDO 拉伸 98~128℃)跌破 → σ 与缺陷率急剧恶化(冷拉颈缩);定型段温度决定雾度;收卷张力出窗(55~120N)→ 勒痕
- 起始工况次优(厚度 ≈28μm,规格 25.0±0.8)→ 留给 AgentTeam 多节点闭环寻优;`GET /api/plant/optimum` 返回 biax W*(铸速/快辊/轨宽/链速网格,厚度入规格)
- 「探测→补建」式建线:`GET /api/presets/biax-line` 返回**蓝图 dry-run**(期望节点+物理模型配置,不动现场);`POST /api/nodes` 支持固定 id upsert;`PUT /api/plant/config` 只装载/替换物理模型绑定(不动节点)——外部流水线可按差分补建缺失设备

## 命名场景(工况隔离管理)

```bash
curl -X PUT  http://127.0.0.1:4010/api/scenarios/批次A-稳产     # 保存当前全部配置(节点+plantModel)
curl -X POST http://127.0.0.1:4010/api/scenarios/批次A-稳产/apply  # 一键切回(隔离恢复)
curl -X GET  http://127.0.0.1:4010/api/scenarios               # 列表
```

每个场景是完整快照(设备+信号策略+协议映射+工艺模型参数),互不干扰;节点级启停 `POST /api/nodes/:id/start|stop` 随时可用。

## Web UI

- 设备卡片:协议徽章/端点/实时值/迷你趋势,启停
- 编辑器:通信配置 + 寄存器/变量/主题/端点映射表 + 信号策略参数 + 故障注入
- 点击信号数值 → 手动覆写(模拟操作工设定)
- 「薄膜产线预设」一键生成五协议模拟产线(信号语义对齐主项目 DAQ 模板);「挤出流延数字孪生」预设生成 6 DCW + 7 DAQ 物理联动产线;「双拉薄膜产线数字孪生」预设生成 9 设备 30 DCW + 19 DAQ 全线物理联动产线
- **对接导出**:每设备生成主项目 driverConfig JSON + curl(test-driver 两条),消除手工对照
- 配置导入/导出 JSON(data/config.json 原子写,重启不丢)

## 与 AgentWorkShop 对接

1. 主项目 `/daq` 页「添加节点 → 真实协议」→ 按模拟器「对接导出」的 driverConfig 填写(或用其 curl 调 `POST /api/workshop/daq/test-driver` 验证后创建)。
2. 产线开跑 → 采集落 TSDB → WS 实时推送 → DCW 写 SP → 模拟器寄存器更新 → DAQ 回读收敛(真实协议栈闭环)。
3. 全链路集成 e2e:

```bash
# 前置:模拟器运行中 + 已应用 film-line 预设;主项目运行中(env AW_BASE,默认 http://127.0.0.1:3001)
NO_PROXY='*' AW_BASE=http://127.0.0.1:3001 node scripts/e2e-integration.mjs
```

覆盖:五协议连接测试 ×5 → 采样落库 ×5 → DCW 写 SP=182 回读一致 + PV 一阶收敛 → DCW MQTT 下行回灌 → 断链演练(停设备拒/恢复重连)。

## 自测

```bash
npm test   # 引擎 19 + plant-model 物理一致性 18 + modbus 6 + opcua 4 + mqtt 3 + http 3
```

## 端口汇总(全部可配,env)

UI/API `4010`(SIM_PORT)|modbus-tcp `16040`|modbus-rtu `15041`|opcua `5840`|内置 mqtt-broker `18830`(MQTT_BROKER_PORT)|http 端点同 UI

## 架构

```
src/server/
  index.ts            入口:h3(API+HTTP 端点+静态前端)+ WS + broker
  api.ts              REST(设备 CRUD/启停/手动覆写/策略覆写/导出/预设/工况与真值/命名场景)
  store.ts            config.json 原子写
  runtime.ts          每设备 tick:信号推进 + WS 推送
  engine/signals.ts   策略数学(含 hook)+ 故障注入 + 写回灌(纯函数)
  engine/plant-model.ts 挤出流延物理引擎(状态方程/稳态解/W* 网格搜索,纯函数可播种)
  engine/plant-runtime.ts 模型↔信号绑定执行层 + 真值 JSONL 双列导出
  engine/png-enc.ts   最小 PNG 编码器(image 帧)
  engine/registers.ts 编码/解码(与主项目 decodeRegisters 对称)+ CRC16
  protocols/          modbus-tcp / modbus-rtu / opcua / mqtt / http-endpoint / mqtt-broker / registry
web/                  Vue3 + Vite(dark 控制室主题,绿 #3fe4ab / 青 #41c8f4 / 深海军蓝)
tests/                引擎 + 四协议自测(真实客户端库)
scripts/e2e-integration.mjs  跨项目全链路 e2e
```

## Windows 坑规避(沿用主项目经验)

- 回环连接一律 `NO_PROXY=127.0.0.1,localhost`
- 端口清场:`netstat -ano | findstr :PORT | findstr LISTENING` → `taskkill /F /PID`(只杀目标端口,勿全量杀 node)
- 日志落盘审计(确定性验收不依赖时序)
