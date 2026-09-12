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

## 已知问题

### ① 上一轮报告的诊断是错的(已更正)

原文写的是「`mock` 调度长 + `omp` 工艺员的任务被取消 …… 建议排查 mock lead 下的任务
reclaim 逻辑」。**归因错了**。逐层复现后的真实链条是:

1. 隔离环境把 `HOME`/`USERPROFILE` 指到独立根,而 `omp` 的模型与凭据在
   `~/.omp/agent/{models.yml,.env}` —— 于是 **omp 起来就退出 1**:
   `No models available. Use /login or set an API key environment variable.`
2. worker 秒失败 → 任务 `FAILED` → 规则引擎找不到第二个空闲 worker 重试 → `cancel`。
   (这条路径**不写 task history**,所以现象是"无 spawn、无记录、瞬时 CANCELED"。)
3. 把 `models.yml` / `.env` 放进隔离 home 后 omp 正常,任务随即进入 WORKING。

也就是说:**harness 凭据缺失**,不是 reclaim 逻辑的问题。教训:隔离环境覆盖 HOME 时,
任何把配置放在 `$HOME` 下的 harness CLI 都会失去凭据,而失败现象与"平台 bug"几乎无法区分 ——
`aw doctor` 若能把「harness CLI 可执行但无可用模型/凭据」单独报出来,这类误判会少很多。

### ② lead 组合的真实结论(lead × worker 矩阵)

同任务文案、同服务器,只换 harness 组合(脚本 `scripts/_audit/lead-matrix-test.mjs`):

| 组合 | lead | worker | 结果 |
|---|---|---|---|
| A | **omp** | omp | **✅ COMPLETED / progress=100**(154s) |
| B | mock | omp | ✖ 停在 `WORKING progress=90`,无人收口 |
| C | mock | mock | ✅ COMPLETED(2s) |
| D | omp | mock | ✅ COMPLETED(3s) |

**用户的猜想成立**:换成真实 harness 的 lead,同一个 omp worker 就能跑完。
原因是**直接派发给 worker 的任务由 worker 自己调 `complete_task` 收口**;
它的回合结束时若漏了这一步,`mock` lead 的 `supervise()` **会跳过所有
`assigneeId !== lead` 的任务**(mock-agent.ts:96-97),没人兜住 → 任务永挂 WORKING,
最后由停滞看门狗处理。

### ③ 已修:看门狗不再丢弃已完成的成果

改动 `scheduler-loop.ts` 的 WORKING 停滞裁决:`notify` 一次仍无变化后,旧实现**无条件
`cancel`**,把 `progress=90`、交付物齐全的任务整单作废。现按"有没有真干过活"分流:

- `progress > 0` 或存在 `input` 以外的交付物 → **`complete`**(成果保留);
- 完全没有产出 → 仍然 `cancel`(防永挂)。

这与仓库既有原则一致("已有 COMPLETED 交付的父任务不自动取消")。

### ④ 已修:绑定主体错用 Agent 模板 id 会静默失效

`POST /agent-tools/bindings` 原样接受任何 `agentId`。但运行时持绑定做工具鉴权的是
**频道成员实例**,而 `/api/workshop/agents` 返回的是**模板 id** —— 照它绑定会得到一条
成员侧永远查不到的静默绑定(agent 的工具一律报"尚未绑定节点")。实测踩了两次:
一次是本报告的 P7,一次是矩阵首轮。

现在:
- 传模板 id → `400 AGENT_ID_NOT_MEMBER`,并直接把该模板**已部署实例的 id 与频道名**列出来;
- 传未知 id → `404 NOT_FOUND`,附获取成员 id 的端点;
- 频道成员列表新增 `templateId` 字段,调用方不必再靠名字猜模板→实例的对应关系。

### ⑤ 已修:看门狗不再丢弃已完成的成果(代码级加固,未做端到端复现)

`scheduler-loop.ts` 的 WORKING 停滞裁决:notify 一次仍无变化后,旧实现**无条件 `cancel`**,
会把 `progress>0`、交付物齐全的任务整单作废。现按"有没有真干过活"分流:有产出 →
`complete`(成果保留);完全无产出 → 仍然 `cancel`(防永挂)。

**证据等级说明(不夸大)**:这条改动只做过**代码级推理 + 类型/静态检查**,
没有拿到端到端复现 —— 两次尝试构造"干过活但成员已 idle"的状态都失败了,原因本身值得记录:

1. 看门狗**不回收 busy 成员**(设计如此,避免取消忙碌中的回合)。用 `delayMs=600s` 的 mock
   worker 让任务停在 progress=0 时,成员始终 busy,裁决分支根本不会走到。
2. `report_progress` 是**运行期工具**,参数只有 `{progress, message}`(**没有 task id**),
   脱离回合调用是空操作 —— 无法用它从外部把任务推进到"有产出"。
3. 试图用 `delayMs=1000` 的 mock worker 抢在它收口前打断:它比预期快,1.5s 时任务已经
   COMPLETED,窗口太窄。

要确定性地复现,需要给 mock harness 加一个「只上报进度、不收口」的剧本开关,
或让 `report_progress` 接受显式 task id。两者都属于测试基建,本次未做。

### ⑥ 新发现:`POST /channels/:id/agents/:agentId/stop` 会阻塞数分钟

上一条的尝试中暴露:`stop` 端点在带一个 `delayMs=600s` 的 mock worker 的频道上,
**实测阻塞 308 秒才返回**(服务日志:`... /agents/<id>/stop - 308143ms`),
调用方(UI/脚本)fetch 直接超时。

"立即中断这个成员"是 HITL 控制面的动作,UI 上表现为点击后长时间无响应。
怀疑是 `runtime.stop()` 在等待在飞回合的 abort/收尾,而不是先摘运行态再异步清理。
**未修**(本次无预算验证),建议:停止动作先同步摘除运行态并立刻返回,收尾放后台,
并把"正在中断"作为成员状态广播出去。

### ⑦ 其余

- `stallMs` 原为 `SchedulerLoop` 构造写死的 300000,不可经设置调整 —— 一次停滞回收最长
  10 分钟才可见。现已接入设置面 `workshop.stall_ms`(10s–2h,默认 5 分钟)。
- MinIO 因宿主机与容器时钟偏差自动降级本地磁盘(功能不受影响,但对象存储未走真链路)。
