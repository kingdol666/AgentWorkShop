# PLC 工艺模拟 · 全新环境端到端演练(2026-09-12)

> 复跑:`node scripts/_audit/plc-clean-scenario.mjs --base http://127.0.0.1:3112 --plc 127.0.0.1:<port>`
> 截图:`node scripts/_audit/plc-clean-shots.mjs --base http://127.0.0.1:3112`
> 结果:**45 通过 / 1 失败**(唯一失败是 omp 工人任务被取消,见文末「已知问题」)

## 环境

| 项 | 值 |
|---|---|
| 版本 | agentworkshop **0.7.36** |
| 服务 | 独立根 `D:\codes\ABO\aw-plc-clean`,端口 **3112** |
| PLC 模拟器 | `scripts/dev-plc-simulator.mjs --port 15060`(真实 Modbus TCP 从站) |
| 数据根 | **全新空根**(`needsSetup=true` → 注册首个用户即为管理员) |
| 基础设施 | TimescaleDB 就绪 · MQTT 队列就绪 · MinIO 因时钟偏差自动降级本地磁盘 |

所有测试数据都落在独立根内,未触碰任何既有实例(3001/3002/3080)与用户数据。

## 被模拟的真实工况

`dev-plc-simulator.mjs` 是**涂布产线烘干单元**:三回路(温度/速度/张力),一阶惯性
(`PV' = PV + (SP−PV)·(1−e^(−dt/τ))`)、执行器斜率限制、过程噪声、环境温度漂移:

| 回路 | PV 寄存器 | SP 寄存器 | τ | 斜率 | 初始 PV |
|---|---|---|---|---|---|
| 温度 | 40001 | 40021 | 8s | 5℃/s | 环境温度 ≈25℃ |
| 速度 | 40003 | 40023 | 4s | 8/s | 0 |
| 张力 | 40005 | 40025 | 6s | 3/s | 0 |

状态字 40011 的 bit2 = 温差 >12℃ 报警 —— 启动爬坡阶段必然触发,收敛后自动恢复。

## 流程与结果

| 阶段 | 内容 | 结果 |
|---|---|---|
| P1 | 空根引导,首用户注册 | 管理员 ✅ |
| P2 | 建线 + 3 数采 + 3 数控(全部 `modbus-tcp` 指向模拟器) | 连接测试 18ms 可读 ✅ |
| P3 | 模型库扫描(12 个 GLB)→ 建 6 个设备孪生 → 绑定数采+数控 | ✅ |
| P4 | 产品 + 配方(3 写参数 + 3 数采窗口)+ 开跑 | 配方参数逐节点下发 ✅ |
| P5 | 等工艺收敛 | 温度 **179.6℃** · 速度 **320.00** · 张力 **21.48** ✅ |
| P6 | 参数调优 182→186 / 320→330 / 21.4→22.6,回读校验 | 回读值 = 设定值 ✅ |
| P6′ | PV 跟随调优值 | 184.8 / 328 / 22.20 ✅ |
| P7 | Channel(lead=mock)+ omp 工艺员 + 6 个节点绑定 + 巡检任务 | 绑定 ✅ / 任务 **CANCELED** ✖ |
| P9 | workspace → 挂载 Channel → 铺领地 | ✅ |

## 留痕核查(用户要求的"历史记录与修改记录")

| 项 | 实测 |
|---|---|
| 数采入库 | 原始样本 76+,`samplesStored=228`,**丢弃 0**,越限告警 4 次 |
| 数控写历史 | **6 条**(人工 3 + 配方 3),每条带前值→新值、操作者 id、时间 |
| 节点参数台账 | `current=186` / `recipeTarget=186` / 改动链 2 条(manual 182→186、recipe null→182) |
| Recipe 版本 | **2 个版本**(调优后回写产生 v2) |
| 运维日志 | **18–19 条 / 6 类**(recipe · write · alarm · line · daq),可按产线过滤(本产线 15 条) |
| 批次运行 | 1 个 run,关联产线/产品/配方 |
| 数字孪生实体 | 6 个,全部带 `modelRef`,遥测实时回写(温度 185.5 / 速度 331 / 张力 22.8) |

## 界面取证(9/9 渲染出数据,0 前端/请求错误)

截图目录 `.e2e-shots/plc-clean/`(gitignored,本地留证):

| 页面 | 判据 |
|---|---|
| `/town` 数字孪生 | `__townStats` = **devices 12 · agents 3 · 43 FPS · 215 draw calls**;画面含 6 个工业模型 + 悬浮遥测卡(185.8℃ / 331 m/min / 22.5 kN)+ Agent 名牌 |
| `/daq` 数采中心 | 3 节点在线,实时值 + 迷你趋势,链路 TSDB·MQTT,发布/消费/丢失计数,未确认告警 3 |
| `/dcw` 产线运营 | 产线卡(运行中 / 节点 3 / 产品 1 / 配方 1 / 打标数) |
| `/dcw/:lineId` 产线详情 | **SET vs ACT 三行** + 执行器/驱动/工艺窗口/绑定模型 + 配方 v2 + 批次 + **写在历史 6 条** + 参数台账 |
| `/daq/:nodeId` 数采节点详情 | 实时值 + 时序图 |
| `/logs` 运维日志 | 19 条,含操作者/分类/摘要/归属/详情与筛选 |
| `/workshop/teams` | Channel 与成员 |
| `/plugins` | 内置插件 rag-bridge / diag-bridge |

## 过程中修掉的脚本缺陷(都会导致误判,值得记住)

1. **端口被占却不报错** —— 首次跑在 15041,而该端口被**另一个项目**(`plc-node-simulator`)
   占用;我的模拟器绑定失败但没有可见错误,于是所有读写都打在别人的 PLC 上,
   一度把 FC10 写入"字序损坏"当成仓库驱动 bug。用
   `scripts/_audit/plc-fc10-probe.mjs 15060` 在**自己的**模拟器上复核后确认
   `0xAAAA,0xBBBB` 原样落库 —— **驱动没问题**。教训:起模拟器后必须核验
   `[plc] …就绪 …:<port>` 这行日志,而不是只看端口在监听。
2. **`/samples` 返回的是聚合桶** `{ at, avg, min, max, cnt }`,不是 `{ value }`;
   桶数也不等于样本量(短窗口下会误判成"没数据"),要按需读 `avg`、按 `cnt` 求和。
3. **`/dcw/journal` 的字段是 `data.anchors`**,`/dcw/:id/param-ledger` 是 `data.ledger.journal`;
   猜字段名会得到"0 条历史"的假失败。
4. **`/dcw/:id` 收的是产线 id**,不是节点 id(传节点 id 会渲染出一个空壳页)。
5. **孪生落位用的是世界坐标**:`shared/town-scene-math.ts` 的 `WORLD_CX=1600 / WORLD_CZ=1200`,
   相机看向世界中心。按"米"给 ±14 会让设备落在世界原点那一角,
   `__townStats` 仍报 devices=12 但画面里几乎看不到。
6. **`/town` 只渲染已挂载到 workspace 的频道** —— 不调
   `POST /workspaces/:id/channels/:channelId` 就只显示"还没有挂载任何 Channel"。
7. **脚本收尾用 `process.exit()` 会在 Windows 上触发 `UV_HANDLE_CLOSING` 断言**,
   表现为"打印 ✅ 却退出码 1"。改用 `process.exitCode` 后退出码可信(已修)。

## 已知问题(如实记录,未修)

- **`mock` 调度长 + `omp` 工艺员的任务被取消**:任务 90s 后变 `CANCELED`、
  `progress=0`,且服务日志里**没有任何 spawn / dispatch 记录**(omp 根本没被拉起)。
  单独验证 `omp -p 'reply with exactly: PONG'` 能正常返回,说明 harness 本身可用 ——
  问题出在这套 lead 组合的派发/回收判定上。改用同一 Channel 里的 `mock` 工人后,
  同样的任务路径 **COMPLETED / progress=100**。建议单独排查 mock lead 下的任务 reclaim 逻辑。
- MinIO 因宿主机与容器时钟偏差自动降级本地磁盘(功能不受影响,但对象存储未走真链路)。
