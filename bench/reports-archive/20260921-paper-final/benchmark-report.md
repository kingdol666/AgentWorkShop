# AW-IndustrialBench · Consolidated Benchmark Report

> **Overall: ALL LAYERS PASS** · seed 42 · git `e692df1` · AgentWorkShop v0.7.45
> Generated 2026-09-21T16:40:16.958Z · platform http://127.0.0.1:3005 · simulator http://127.0.0.1:4011

## 1. Results by layer

| Layer | Run ID | Pass | Warn | Fail | Skip | Score | Verdict |
|---|---|---|---|---|---|---|---|
| Static audit (paper–code consistency) | `20260921151539-w0k` | 3 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| Integrated pipeline (20 phases, real nodes) | `20260921161746-x2w` | 82 | 0 | 0 | 0 | 100 / 100 | **PASS** |
| Real-protocol layer (PLC simulator) | `20260921155208-1ar0` | 13 | 0 | 0 | 0 | 100.0 / 100 | **PASS** |
| E1a 4-arm governance ablation | `20260921155326-e1lite` | 4 | 0 | 0 | 0 | — | **PASS** |
| Full-system API survey (api-live-e2e) | `console` | 60 | 0 | 0 | 0 | — | **PASS** |

## 2. Real PLC node verification (plc-node-simulator, five protocols)

| Check | Result | Evidence |
|---|---|---|
| plc-0-simulator — Simulator ready + film-line preset | PASS | five-protocol devices: modbus-tcp, modbus-rtu, opcua, mqtt, http |
| plc-1-realpath — Five-protocol real connectivity (exported config → test-driver) | PASS | ✔ modbus-tcp live connect ok (16 ms) · ✔ modbus-rtu live connect ok (17 ms) · ✔ opcua live connect ok (18 ms) · ✔ mqtt live connect ok (16 ms) · ✔ http live connect ok (31 ms) |
| plc-2-closedloop — Real sampling + SP→PV physical closed loop + governed write on the live link | PASS | ✔ real Modbus TCP sampling: 9 points (~895 ms cadence) · ✔ real SP write 182℃ → HTTP 200 (26 ms, incl. Modbus transaction) · ✔ governance on the live link: 5/5 attacks rejected (200/400/150/188.1/175.9), legal 180 accepted · ✔ SP→PV physical closed loop converged to \|PV−182\|≤3℃ in 33 s (first-order inertia) · governed write 185℃ (read-back verified, register accepted) while PV frozen at 150℃ (out of window)  · ✔ independent monitoring layer raised the recipe-window alarm within 2 s (defense-in-depth: read-back closure does not cover process response) · time-series DB kept sampling during the loop: 43 points total |
| plc-4-fault — Link-fault & recovery drill (real TCP) | PASS | ✔ after the link break the driver failure was sensed by the main app (test-driver ok=false) · ✔ reconnected successfully after simulator restart (test-driver ok=true) |

All traffic in this layer runs over the real protocol stacks of the PLC node simulator (Modbus TCP and Modbus RTU, OPC UA, MQTT, HTTP; per-instance transport ports). The governed write path (SP write → interlock → physical model → DAQ read-back → F5 interdiction → F2 frozen-alarm) is exercised on the live link, not on mocks.

## 3. Closed-loop optimization on the cast-film twin (governed writes)

Offline optimum W* = 89.894 · 3/3 seeds converged · 6 governed writes · 0 rejected · ratio J/J* ∈ [0.969, 0.971] (mean 0.970)

- seed 42: J0 66.525 → Jend 87.29 · J/J* 0.971 · iters 2 · writes 2 · rejected 0
- seed 43: J0 68.046 → Jend 87.262 · J/J* 0.971 · iters 2 · writes 2 · rejected 0
- seed 44: J0 65.319 → Jend 87.105 · J/J* 0.969 · iters 2 · writes 2 · rejected 0

## 3b. AgentTeam optimization mission (task board → time-range data → governed writes → target attained)

A complete agent-team mission runs against a live line: the optimization goal is filed on the team task board and dispatched to the worker; the worker reads the recent acquisition window through its industrial tool surface (`daq_query` with `from/to/bucket` — time-series/Timescale semantics), computes the corrected setpoint, issues governed writes (`dcw_control`, each opening an auditable optimization record that is then judged), waits for the physical process to follow, verifies attainment against the target, and closes the task with a report artifact. The decision policy is deterministic (no LLM credentials required; the LLM variant is the optional P5), but every path it exercises — task board state machine, host tool bridge, governed write path, physical plant, parameter journal — is the production path.

| Mission check | Result |
|---|---|
| Goal filed on the task board and dispatched to the worker | PASS |
| Time-range data read via daq_query (from/to/bucket) | PASS |
| Governed parameter writes, each with an opened and judged record | PASS |
| Parameter journal shows Agent attribution for the writes | PASS |
| Final process value within tolerance of the optimization target | PASS |
| Task closed (lead dispatch → worker scripted completion → parent aggregation) | PASS |

Mission outcome: target 204.704 · final PV 204.700 · governed writes 1 (≤3) · verdict **ATTAINED**

## 3c. Biaxial (BOPET) full-line mission — nine devices, five protocols, multi-node tuning

The suite's most plant-realistic layer provisions the biaxially oriented film line by differential probe-and-provision (missing devices rebuilt, drifted signals repaired — never a bulk reset), commissions one whole line from real driver configs (9 devices, 49 signals: 30 writable setpoints + 19 acquisition points with process semantics exposed to the agent cards), and dispatches an AgentTeam objective of 25.0 ± 0.7 µm thickness. The worker rotates governed writes across 3 actuation nodes (cast-roll speed / MDO fast-roll / TDO rail over Modbus TCP + OPC UA), the physics follows through transport delay and first-order lag, and the mission closes with journal attribution on every write.

Mission outcome: governed writes 4 · distinct actuation nodes 3 · final thickness 25.32 µm vs target 25.0 ± 0.7 µm · verdict **ATTAINED** (hard gate green). Line profile and per-round trajectory: `Simulated production line profile` / `AgentTeam closed-loop tuning walkthrough` chapters in `bench/results/20260921161746-x2w/report.md`; raw trail in `agentteam-biax.log`.

## 3d. Real-LLM agent closed loops — execution traces

![Goal-driven optimization trajectory](goal-trajectory.svg)

### goal-driven loop (omp) — the model derives its own setpoint from a process objective

````
AW-IndustrialBench · P5b goal-driven closed-loop optimization — execution trace
run: 20260921161746-x2w  harness: omp  provider: zhipu-coding-plan  model: glm-5.3-flash
task: f70667a9-d059-4471-a031-1c3407a1e438  line: ln-f18da1a8 (cast-film twin)  screw-sp: dw-89c97c1f  thick DAQ: dn-83bb103f
target: thickness 52±0.8 um  maxWrites: 6  start point: {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}
started: 2026-09-21T16:19:50.032Z  wall: 498.994s  final state: COMPLETED  oracle GOAL-OPT-OK: yes
tool calls in transcript: dcw_control≈3/6  dcw_judge≈3  recipe_update: yes  final thickness(6-bucket mean): 52.067

== task assignment ==


== channel transcript (chronological) ==
[2026-09-22T00:24:57.336+08:00] ROLE_AGENT: 任务「agentgoal-ip168b09」进度 0% 已 307s 未变化,请确认是否仍在推进;若卡住请说明阻塞并请求协助
[2026-09-22T00:19:50.035+08:00] ROLE_USER: 优化目标（标准工况寻优；流程照做，参数决策完全由你做）：
把厚度过程量（数采节点 dn-83bb103f，单位 μm）稳定优化到 52±0.8 μm。你只能调整螺速设定点（数控节点 dw-89c97c1f）。
标准作业流程（一步一步执行，每步都基于真实数据）：
1. 观测：daq_query 读当前厚度过程量与趋势；line_context 看产线/批次/配方上下文；dcw_journal 查历史设定与在册优化记录（避免重复试错）；
2. 分析：对照当前螺速设定与过程量，推导下一步设定值（声明假设：预期方向与幅度）；
3. 下发：dcw_control 写入（自动开优化记录）；等待 30~60 秒工艺响应；
4. 复测：daq_query 观察过程量响应，未达目标则回到第 2 步继续迭代；
5. 收口：每个由你发起的优化记录用 dcw_judge 依据数采证据落判定（keep/rollback）；
6. 固化：达标后把最佳工艺参数（你的最终设定值）用 recipe_update 存入配方版本化保存，说明这是达标工艺；
7. 交付：结论包含标记 GOAL-OPT-OK、你的最终设定值、达成过程量、迭代写次数、配方版本号，然后调用 complete_task。
约束：dcw_control 最多 6 次；厚度安全范围与配方窗口以 my_industrial_nodes 返回为准，越界会被治理拦截。

== task history (tool-call events, full optimization trail) ==
[] event: 🔧 eval(code=r1 = await tool.search_memory({"query": "厚度 52μm 螺速 CastFil…)
[] event: '记忆检索无命中(query="厚度 52μm 螺速 CastFilm 优化", scope=auto)。可尝试更换关键词或放宽 scope。'
'记忆检索无命中(query="dw-89c97c1f dn-83bb103f 调参 经验", scope=auto)。可尝试更换关键词或放宽 scope。'
[] event: 🔧 read(xd://daq_query)
[] event: 🔧 read(xd://my_industrial_nodes)
[] event: 记忆无历史经验，全新寻优。开始第 1 步「观测」：节点语义卡 + 产线上下文 + 厚度趋势 + 调参历史，并行取证。
[] event: 🔧 write(xd://my_industrial_nodes)
[] event: #### ◆ ScrewSpeedSP ip168b09gl [id=dw-89c97c1f]
- 物理量: 烘箱温度设定,单位 rpm,精度 0 位小数
- 工艺语义: cast-film 执行器 ScrewSpeedSP（rpm），真实 opcua 链路
- 安全量程: [50, 200] rpm(硬联锁,越界即拒)
- 活动配方「CastFilm工艺 ip168b09gl」工艺窗口: [50, 200] rpm(软联锁,配方目标值 150rpm)
- 当前设定: 150rpm,状态 ok,所属产线「CastFilm线 ip168b09gl」
- 操作守则: 单次调幅建议 ≤3rpm(量程 2%);下发后等待工艺响应再评估;目标值必须落在窗口内;驱动 opcua;自动模式,直接执行

#### ◇ thick ip168b09gl [id=dn-83bb103f]
- 物理量: 熔体/箱体温度,单位 μm,正常量程 [0, 400] μm
- 采集语义: cast-film process quantity thick（μm），真实 mqtt 链路
- 预警带: [32, 368] μm(出带=warn,越量程=alarm)
- 实时值: 53.8μm( 1s 前更新),状态 ok,采样 1000ms,驱动 mqtt,所属产线「CastFilm线 ip168b09gl」
- 数据获取: daq_query(node_id='dn-83bb103f');查询自动执行

---
通用规则:
1. 一个 Agent 可绑定多个节点;先读本清单理解每个节点的物理意义与操作守则,再动
[] event: 🔧 write(xd://line_context)
[] event: 你控制的产线全景(1 条):

■ 产线 CastFilm线 ip168b09gl(ln-f18da1a8)· 状态:运行中
  活动批次 rr-d9f5e · 产品「CastFilm产品 ip168b09gl」(pd-34b00b93) · 开跑 00:19:49 · 已打标 94 样本
  我绑定的节点:数控 [ScrewSpeedSP ip168b09gl];数采 [thick ip168b09gl]
  配方「CastFilm工艺 ip168b09gl」(rc-5f23b49b) v1 — closed-loop benchmark start point
    · 加热区1SP ip168b09gl = 200℃(窗口 195~225) | PLC 当前 200℃
    · 加热区2SP ip168b09gl = 200℃(窗口 195~225) | PLC 当前 200℃
    · 加热区3SP ip168b09gl = 200℃(窗口 195~225) | PLC 当前 200℃
    · ScrewSpeedSP ip168b09gl = 150rpm(窗口 50~200) | PLC 当前 150rpm [我负责]
    · lineSpeedSP ip168b09gl = 95m/min(窗口 20~120) | PLC 当前 95m/min
    · dieGapSP ip168b09gl = 1mm(窗口 0.5~2) | PLC 当前 1mm
  已知良好批次:未标记;当前参数版本 v1

说明:配方目标=开跑批次冻结的工艺窗口;PLC 当
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ thick ip168b09gl(熔体/箱体温度)单位 μm,正常量程 0~400μm,当前状态 ok,时间窗 2026-09-21T23:50 ~ 2026-09-22T00:20(降采样 15000ms)
  样本 2 点 | 最新 53.980000000000004μm | 均值 53.762 | 最小 53.544444444444444 | 最大 53.980000000000004
  最近序列: 00:20:00=avg 53.54; 00:19:45=avg 53.98
  工况判读: 同产线数控设定: 加热区1SP ip168b09gl=200℃;加热区2SP ip168b09gl=200℃;加热区3SP ip168b09gl=200℃;ScrewSpeedSP ip168b09gl=150rpm;lineSpeedSP ip168b09gl=95m/min;dieGapSP ip168b09gl=1mm(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: 🔧 write(xd://dcw_journal)
[] event: 窗口内无优化记录(该节点/配方尚无 Agent 调控历史)。
[] event: **观测结论**：当前厚度 53.98 μm（目标 52±0.8，即 [51.2, 52.8]），偏高约 +1.8 μm；螺速 150 rpm（窗口 [50,200]，守则单步 ≤3 rpm）；无历史调控记录，白纸起步。读下发工具文档后进入第 2 步「分析→假设」。
[] event: 🔧 read(xd://dcw_control)
[] event: 🔧 read(xd://dcw_judge)
[] event: 🔧 read(xd://recipe_update)
[] event: **分析/假设**：CastFilm 挤出厚度 ∝ 挤出量/线速，而挤出量近似正比螺速。线性外推达标点 ≈ 150×(52/53.98) ≈ 144.5 rpm；受单步 ≤3 rpm 守则约束，分步逼近。第 1 步 150→147 rpm，预期厚度 ≈53.98×(147/150) ≈ 52.9 μm（进入带宽上沿附近），45 秒后复测定灵敏度。

**下发 #1/6**：
[] event: 🔧 write(xd://dcw_control)
[] event: 下发成功:ScrewSpeedSP ip168b09gl(烘箱温度设定)设定 147rpm → PLC 原始值 147;回读 147rpm一致。当前活动配方「CastFilm工艺 ip168b09gl」。写入并回读一致:147,回读 147(标定后物理值 147)
[调控闭环] 优化记录 opt-cfa6c885 已开窗(观察数采后 dcw_judge 落判定);上一稳定锚:150rpm(可 dcw_rollback 回退);本节点为自动模式:越配方监控窗将触发系统自动回退
[] event: 下发成功（记录 opt-cfa6c885，稳定锚 150rpm）。等待 45 秒工艺响应后复测。
[] event: 🔧 bash(sleep 45)
[] event: (no output)

Wall time: 45.17 seconds
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ thick ip168b09gl(熔体/箱体温度)单位 μm,正常量程 0~400μm,当前状态 ok,时间窗 2026-09-22T00:18 ~ 2026-09-22T00:21(降采样 5000ms)
  样本 22 点 | 最新 54.21999999999999μm | 均值 53.13 | 最小 51.879999999999995 | 最大 54.720000000000006
  最近序列: 00:20:45=avg 53.48; 00:20:40=avg 53.56; 00:20:35=avg 54.72; 00:20:30=avg 53.84; 00:20:25=avg 53.72; 00:20:20=avg 53.58; 00:20:15=avg 53.22; 00:20:10=avg 53.18; 00:20:05=avg 53.72; 00:20:00=avg 53.32; 00:19:55=avg 53.74; 00:19:50=avg 54.22
  工况判读: 同产线数控设定: 加热区1SP ip168b09gl=200℃;加热区2SP ip168b09gl=200℃;加热区3SP ip168b09gl=200℃;ScrewSpeedSP ip168b09gl=147rpm;lineSpeedSP ip168b09gl=95m/min;dieGapSP ip168b09gl=1mm(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_
[] event: 下发 #1 后 45s 复测：整体均值 53.13，但最近 9 点（00:20:05 后）均值 ≈53.67，较变更前 ≈53.9 仅微降；噪声带较宽（51.9~54.7），疑似工艺滞后未走完。再等 40 秒确认稳态再定灵敏度，避免盲调。
[] event: 🔧 bash(sleep 40)
[] event: (no output)

Wall time: 40.11 seconds
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ thick ip168b09gl(熔体/箱体温度)单位 μm,正常量程 0~400μm,当前状态 ok,时间窗 2026-09-22T00:20 ~ 2026-09-22T00:22(降采样 5000ms)
  样本 25 点 | 最新 53.833333333333336μm | 均值 52.588 | 最小 51.879999999999995 | 最大 53.833333333333336
  最近序列: 00:21:40=avg 52.68; 00:21:35=avg 52.56; 00:21:30=avg 53.05; 00:21:25=avg 52.48; 00:21:20=avg 52.2; 00:21:15=avg 53.12; 00:21:10=avg 51.88; 00:21:05=avg 52.58; 00:21:00=avg 52.34; 00:20:55=avg 52.3; 00:20:50=avg 52.22; 00:20:45=avg 53.83
  工况判读: 同产线数控设定: 加热区1SP ip168b09gl=200℃;加热区2SP ip168b09gl=200℃;加热区3SP ip168b09gl=200℃;ScrewSpeedSP ip168b09gl=147rpm;lineSpeedSP ip168b09gl=95m/min;dieGapSP ip168b09gl=1mm(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_
[] event: **复测确认**：147 rpm 下厚度已稳态 ≈52.49 μm（00:20:50~00:21:40 共 11 点均值 52.49），已进入目标带 [51.2, 52.8] 但偏上沿；实测灵敏度 ≈(53.9−52.5)/3 ≈ 0.47 μm/rpm。

**判定 opt-cfa6c885**：keep —— 方向正确、幅度符合预期（预测 52.9 / 实测 52.5），带证据落册：
[] event: 🔧 write(xd://dcw_judge)
[] event: 判定已入册:记录 opt-cfa6c885 → keep(数采证据:变更前(00:19:45~00:20:00)厚度≈53.54~53.98μm;下发147rpm后稳态(00:20:50~00:21:40,11点5s均值)≈52.49μm,降幅≈1.4μm/3rpm(灵敏度≈0.47μm/rpm),与线性假设52.9μm同向且略强。52.49已入目标带[51.2,52.8]但偏上沿,方向经验有效,判keep;继续-1rpm微调对中52.0。)。已定档为已验证经验(配方已标记 lastGood)。
[] event: **下发 #2/6**：147→146 rpm（−1 rpm 精调对中），预期 52.49−0.47 ≈ 52.0 μm，60 秒后复测：
[] event: 🔧 write(xd://dcw_control)
[] event: 下发成功:ScrewSpeedSP ip168b09gl(烘箱温度设定)设定 146rpm → PLC 原始值 146;回读 146rpm一致。当前活动配方「CastFilm工艺 ip168b09gl」。写入并回读一致:146,回读 146(标定后物理值 146)
[调控闭环] 优化记录 opt-169cc465 已开窗(观察数采后 dcw_judge 落判定);上一稳定锚:147rpm(可 dcw_rollback 回退);本节点为自动模式:越配方监控窗将触发系统自动回退
[] event: 🔧 bash(sleep 60)
[] event: Backgrounded as job bg_3; result will be delivered automatically.
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ thick ip168b09gl(熔体/箱体温度)单位 μm,正常量程 0~400μm,当前状态 ok,时间窗 2026-09-22T00:21 ~ 2026-09-22T00:24(降采样 5000ms)
  样本 37 点 | 最新 53.13333333333333μm | 均值 52.587 | 最小 51.98 | 最大 53.21999999999999
  最近序列: 00:22:20=avg 52.54; 00:22:15=avg 52.62; 00:22:10=avg 52.74; 00:22:05=avg 52.68; 00:22:00=avg 52.86; 00:21:55=avg 52.28; 00:21:50=avg 52.68; 00:21:45=avg 53.04; 00:21:40=avg 52.68; 00:21:35=avg 52.56; 00:21:30=avg 53.05; 00:21:25=avg 53.13
  工况判读: 同产线数控设定: 加热区1SP ip168b09gl=200℃;加热区2SP ip168b09gl=200℃;加热区3SP ip168b09gl=200℃;ScrewSpeedSP ip168b09gl=146rpm;lineSpeedSP ip168b09gl=95m/min;dieGapSP ip168b09gl=1mm(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法
[] event: 60 秒等待结束，但该窗口仅覆盖变更后 ~35 秒（00:21:50~00:22:20 均值 ≈52.63），滞后未走完。再等 40 秒取纯稳态窗复测。
[] event: 🔧 bash(sleep 40)
[] event: (no output)

Wall time: 40.11 seconds
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ thick ip168b09gl(熔体/箱体温度)单位 μm,正常量程 0~400μm,当前状态 ok,时间窗 2026-09-22T00:23 ~ 2026-09-22T00:25(降采样 5000ms)
  样本 25 点 | 最新 52.3μm | 均值 52.385 | 最小 51.92 | 最大 52.92
  最近序列: 00:24:15=avg 52.65; 00:24:10=avg 52.44; 00:24:05=avg 52.5; 00:24:00=avg 52.54; 00:23:55=avg 52.44; 00:23:50=avg 52.4; 00:23:45=avg 52.32; 00:23:40=avg 52.6; 00:23:35=avg 52.5; 00:23:30=avg 52.14; 00:23:25=avg 52.34; 00:23:20=avg 52.3
  工况判读: 同产线数控设定: 加热区1SP ip168b09gl=200℃;加热区2SP ip168b09gl=200℃;加热区3SP ip168b09gl=200℃;ScrewSpeedSP ip168b09gl=146rpm;lineSpeedSP ip168b09gl=95m/min;dieGapSP ip168b09gl=1mm(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: **复测（146 rpm 稳态）**：均值 52.39 μm（00:23:20~00:24:15，25 点），min 51.92 / max 52.92，仅 1 个桶轻微擦上沿 52.8，~96% 样本在带内。已达标但均值仍偏带心 +0.39；灵敏度边际趋缓（−1 rpm 实测仅 −0.1）。再做最后一次微调对中带心：判 #2 keep → 下发 #3（145 rpm）。

**判定 opt-169cc465**：
[] event: 🔧 write(xd://dcw_judge)
[] event: 判定已入册:记录 opt-169cc465 → keep(数采证据:147rpm稳态均值52.49μm(00:20:50~00:21:40);下发146rpm后稳态(00:23:20~00:24:15,25点5s桶)均值52.385μm,min 51.92/max 52.92,25桶中24桶在带[51.2,52.8]内。均值向带心52.0收敛且全程在带,边际灵敏度趋缓(实测-0.1μm/rpm vs 先前-0.47),经验有效,判keep。)。已定档为已验证经验(配方已标记 lastGood)。
[] event: 🔧 write(xd://dcw_control)
[] event: 下发成功:ScrewSpeedSP ip168b09gl(烘箱温度设定)设定 145rpm → PLC 原始值 145;回读 145rpm一致。当前活动配方「CastFilm工艺 ip168b09gl」。写入并回读一致:145,回读 145(标定后物理值 145)
[调控闭环] 优化记录 opt-ef79b2ba 已开窗(观察数采后 dcw_judge 落判定);上一稳定锚:146rpm(可 dcw_rollback 回退);本节点为自动模式:越配方监控窗将触发系统自动回退
[] event: 🔧 bash(sleep 60)
[] event: Backgrounded as job bg_5; result will be delivered automatically.
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ thick ip168b09gl(熔体/箱体温度)单位 μm,正常量程 0~400μm,当前状态 ok,时间窗 2026-09-22T00:25 ~ 2026-09-22T00:27(降采样 5000ms)
  样本 24 点 | 最新 52.300000000000004μm | 均值 52.124 | 最小 51.48 | 最大 52.739999999999995
  最近序列: 00:26:15=avg 52.27; 00:26:10=avg 52.24; 00:26:05=avg 52.24; 00:26:00=avg 52.46; 00:25:55=avg 52.34; 00:25:50=avg 51.94; 00:25:45=avg 52.1; 00:25:40=avg 52.46; 00:25:35=avg 52.24; 00:25:30=avg 51.98; 00:25:25=avg 52.38; 00:25:20=avg 52.3
  工况判读: 同产线数控设定: 加热区1SP ip168b09gl=200℃;加热区2SP ip168b09gl=200℃;加热区3SP ip168b09gl=200℃;ScrewSpeedSP ip168b09gl=145rpm;lineSpeedSP ip168b09gl=95m/min;dieGapSP ip168b09gl=1mm(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法
[] event: 145 rpm 稳态窗（00:25:20~00:26:15，变更后 12 桶）均值 ≈52.25，整窗 min 51.48 / max 52.74 **全部落在 [51.2, 52.8] 带内**，窗口均值 52.12，几乎正中带心 52.0。达标，停止调参（共 3 次下发）。落判定 + 固化配方：
[] event: 🔧 write(xd://dcw_judge)
[] event: 判定已入册:记录 opt-ef79b2ba → keep(数采证据:146rpm稳态均值52.385μm;下发145rpm后(00:25:20~00:26:15,变更后12桶5s)均值≈52.25μm,整窗min 51.48/max 52.74,全部桶位于目标带[51.2,52.8]内,窗口总均值52.124μm贴近带心52.0。达标且无擦边,判keep,以145rpm作为达标工艺固化配方。)。已定档为已验证经验(配方已标记 lastGood)。
[] event: 🔧 write(xd://recipe_update)
[] event: 已保存为 v2:「CastFilm工艺 ip168b09gl」参数 ScrewSpeedSP ip168b09gl 145→145;原因:达标工艺固化:厚度目标52±0.8μm。数采证据(00:25:20~00:26:15):145rpm下厚度窗口均值52.124μm、整窗[51.48,52.74]全部在带内;优化记录opt-cfa6c885/opt-169cc465/opt-ef79b2ba三连keep(150→147→146→145rpm,实测灵敏度≈0.47μm/rpm,边际趋缓)。螺速150rpm→145rpm,下一批次生效。。
注意:配方定义已更新,运行中批次仍按开跑时冻结的参数生产,新参数从下次开跑/一键下发生效;要把新值写入运行中的 PLC,用 dcw_control 逐节点下发(走安全联锁)。回退用 recipe_rollback。
[] event: 配方已固化 **v2**（145 rpm）。沉淀团队经验后收口：
[] event: 🔧 eval(code=await tool.save_memory({"title": "CastFilm线厚度寻优:螺速灵敏度与达标工艺"…)
[] event: Traceback (most recent call last):
  File "<cell>", line 2, in <module>
  File "<cell>", line 475, in __call__
  File "D:\anaconda3\Lib\asyncio\threads.py", line 25, in to_thread
    return await loop.run_in_executor(None, func_call)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "D:\anaconda3\Lib\concurrent\futures\thread.py", line 58, in run
    result = self.fn(*self.args, **self.kwargs)
             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "<cell>", line 418, in _bridge_call
RuntimeError: Validation failed for tool "report_progress":
  - progress: is required

Received arguments:
{
  "percent": 100,
  "note": "厚度52±0.8μm达标(52.124),3次下发全keep,配方v2已固化"
}

Command exited with
[] event: 🔧 eval(code=r = await tool.report_progress({"progress": 100, "note": "厚…)
[] event: '进度已上报: 100%'

````

### prescribed-step loop (omp)

````
AW-IndustrialBench · P5 real-LLM agent closed loop — execution trace
run: 20260921161746-x2w  harness: omp  provider: zhipu-coding-plan  model: glm-5.3-flash
task: 47d18ff6-ec98-4263-b080-fcdbe59c0f99  line: L1 (modbus-tcp)  dcw: dw-f3d0038d  daq: dn-f455501b  target SP: 197.48
started: 2026-09-21T16:18:31.355Z  wall: 78.209s  final state: COMPLETED  oracle INTEGRATED-CLOSEDLOOP-OK: yes

== task assignment ==
{"id":"47d18ff6-ec98-4263-b080-fcdbe59c0f99","channelId":"bafd6791-3e47-4eb1-bfeb-2a2b8633587e","assigneeId":"0cc04fe7-86ee-404f-917a-035062e19213","creatorId":"","title":"agentloop-ip168b09","state":"COMPLETED","progress":100,"retryCount":0,"artifacts":[{"artifactId":"40b89cd1-c9b9-421a-a2d5-e970a9bd3957","name":"input","parts":[{"text":"Line闭环调优任务（严格按步骤执行）：\n1. 调用 daq_query(node_id=\"dn-f455501b

== channel transcript (chronological) ==
[2026-09-22T00:18:31.369+08:00] ROLE_USER: Line闭环调优任务（严格按步骤执行）：
1. 调用 daq_query(node_id="dn-f455501b") 读取当前过程量;
2. 调用 dcw_control(node_id="dw-f3d0038d", value=197.48, hypothesis="integrated pipeline闭环验证") 下发设定值;
3. 等待 3 秒后再 daq_query(node_id="dn-f455501b") 观察响应;
4. 调用 dcw_judge 落判定 keep 并附一句证据;
5. 交付中必须原样包含标记 INTEGRATED-CLOSEDLOOP-OK，然后调用 complete_task。

== task history ==
[] event: 执行Line闭环调优任务。步骤1：读取当前过程量。
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ L1-DAQ-modbus-tcp ip168b09(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-21T23:48 ~ 2026-09-22T00:18(降采样 15000ms)
  样本 5 点 | 最新 207.76999999999998℃ | 均值 202.624 | 最小 200.32 | 最大 207.76999999999998
  最近序列: 00:18:45=avg 200.32; 00:18:30=avg 200.45; 00:18:15=avg 201.23; 00:18:00=avg 203.35; 00:17:45=avg 207.77
  工况判读: 活动配方「Integrated工艺1 ip168b09」监控窗口 [191.6, 208.4]:当前 207.76999999999998℃ 窗口内(正常) | 同产线数控设定: L1-DCW-modbus-tcp ip168b09=200℃(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: 步骤1完成：当前过程量 207.77℃（00:18:45），窗口 [191.6, 208.4] 内。步骤2：下发设定值 197.48℃。
[] event: 🔧 write(xd://dcw_control)
[] event: 下发成功:L1-DCW-modbus-tcp ip168b09(烘箱温度设定)设定 197.48℃ → PLC 原始值 197.48;回读 197.5℃一致。当前活动配方「Integrated工艺1 ip168b09」。写入并回读一致:197.48 → raw 197.48,回读 197.5(标定后物理值 197.5)
[调控闭环] 优化记录 opt-52b0d07a 已开窗(观察数采后 dcw_judge 落判定);上一稳定锚:200℃(可 dcw_rollback 回退);本节点为自动模式:越配方监控窗将触发系统自动回退
[] event: 步骤2完成：设定 197.48℃ 写入并回读一致（回读 197.5℃），优化记录 opt-52b0d07a 已开窗。步骤3：等待3秒后复测。
[] event: 🔧 bash(sleep 3)
[] event: (no output)

Wall time: 3.12 seconds
[] event: 🔧 write(xd://daq_query)
[] event: 数采数据查询结果(1 个节点):

■ L1-DAQ-modbus-tcp ip168b09(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 ok,时间窗 2026-09-21T23:49 ~ 2026-09-22T00:19(降采样 15000ms)
  样本 6 点 | 最新 207.76999999999998℃ | 均值 202.194 | 最小 200.1142857142857 | 最大 207.76999999999998
  最近序列: 00:19:00=avg 200.25; 00:18:45=avg 200.11; 00:18:30=avg 200.45; 00:18:15=avg 201.23; 00:18:00=avg 203.35; 00:17:45=avg 207.77
  工况判读: 活动配方「Integrated工艺1 ip168b09」监控窗口 [191.6, 208.4]:当前 207.76999999999998℃ 窗口内(正常) | 同产线数控设定: L1-DCW-modbus-tcp ip168b09=197.5℃(判读时考虑设定↔实际量的耦合与滞后)

数值均为经标定钩子处理后的真实物理量纲;调整工艺前请结合 my_industrial_nodes 的节点判读方法与操作守则。
[] event: 步骤3完成：3秒后复测，最新样本 00:19:00 avg 200.25℃，设定已生效（判读区显示 L1-DCW=197.5℃），全程处于监控窗口 [191.6, 208.4] 内，未触发越限回退。步骤4：落判定 keep。
[] event: 🔧 write(xd://dcw_judge)
[] event: 参数名应为 `reason`，重试。
[] event: 🔧 write(xd://dcw_judge)
[] event: 判定已入册:记录 opt-52b0d07a → keep(下发 197.48℃ 后 3 秒复测（2026-09-22 00:19:00 样本）回读设定 197.5℃ 一致，过程量 avg 200.25℃ 稳定处于配方监控窗口 [191.6, 208.4] 内，无越限报警)。已定档为已验证经验(配方已标记 lastGood)。
[] event: 判定已入册 keep，配方已标记 lastGood。步骤5：交付并完成任务。
[] event: 🔧 write(xd://report_progress)
[] event: 进度已上报: 100%

````

## 3e. Multi-scenario closed-loop optimization benchmark (injection / wwtp / anneal)

Beyond film extrusion and biaxial stretching, the suite benchmarks three distinct default industrial scenarios concurrently (each with an isolated production line, dedicated AgentTeam mission channel, real protocol driver configuration, and underlying ODE physics engine in the simulator):

| Scenario | Work Story | Controlled PV | Target | Attained | Writes | Rounds | Wall (s) | Line Reused |
|---|---|---|---|---|---|---|---|---|
| **injection** (注塑成型质量窗口寻优) | 家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、… | 制品克重 | 32.5±0.35g | **ATTAINED** | 3 | 4 | 34.38 | Yes |
| **wwtp** (A2O 污水生化处理达标降耗) | 城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~… | 好氧池溶解氧 | 3.4±0.6mg/L | **ATTAINED** | 15 | 13 | 181.24 | Yes |
| **anneal** (连续退火质量窗内产能最大化) | 冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷… | 维氏硬度 | 95±6HV | **ATTAINED** | 6 | 7 | 66.74 | Yes |
| **biax** (双拉(BOPET)薄膜产线多节点闭环) | 双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±… | 成品膜厚 | 25±0.7μm | **ATTAINED** | 4 | 4 | — | Yes |

- **injection (注塑成型质量窗口寻优)**: final PV 32.32 g · writes 3 · rounds 4
- **wwtp (A2O 污水生化处理达标降耗)**: final PV 3.53 mg/L · writes 15 · rounds 13
  - Cost reduction: initial compliant 181.5 → final 179.1 (saved 2.4) under discharge constraints
- **anneal (连续退火质量窗内产能最大化)**: final PV 99.70 HV · writes 6 · rounds 7
  - Throughput push: speed 140.06 → 164 m/min (+17.14%) bounded by hardness window
- **biax (双拉(BOPET)薄膜产线多节点闭环)**: final PV 25.32 μm · writes 4 · rounds 4

## 4. Cross-scenario portability (film-line, zero code changes)

Devices 5 · own lines 3/5 · sampling 5/5 · F5 interdicted 9/9 · false blocks 0 · **code changes 0**

## 5. E1a · 4-arm governance ablation (attribution evidence)

| Arm | Interception (per rep) | Window breaches executed | False blocks | Boundary | Write p50 (ms) |
|---|---|---|---|---|---|
| Full (interlock + readback + gate) | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 111.1 / 124.5 / 130.4 |
| No interlock | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 126.8 / 125 / 124.5 |
| No readback | 6/6 / 6/6 / 6/6 | 0 | 0 | 9/9 | 125.5 / 125.2 / 130.9 |
| Ungated (no approval gate) | 4/6 / 4/6 / 4/6 | 6 | 0 | 9/9 | 125.9 / 125.1 / 124.7 |

Reading: interception is provided by the batch-window interlock (Full and No-readback interdict all 6 attacks; removing the interlock lets the two window-class attacks execute and be journaled — attribution ≠ prevention). The hard range is structural: false blocks are 0 in every arm. Latency is statistically indistinguishable across arms.

## 6. Reproducibility matrix (machine verdicts)

### 6.1 This execution

| Comparison | Verdict |
|---|---|
| 20260914-baseline-run-e1lite-4arm vs 20260921155326-e1lite | **REPRODUCIBLE** |
| 20260914-baseline-run-plc-fx0 vs 20260921155208-1ar0 | **REPRODUCIBLE** |
| pipeline: 20260921151620-ykk vs 20260921161746-x2w | **REPRODUCIBLE** |
| Gate selftest (tampered intercept must be rejected) | **PASS** |

### 6.2 Historical archive

Layer comparisons against the frozen 20260914 baseline and cross-run pairs: **6/6 REPRODUCIBLE**. The exceptions are disclosed, evidence-tagged, and none is a governance failure:

Note on comparators: `bench/compare.mjs` judges the layer tiers (plc / static / e1-lite) against the frozen baseline; applied to an integrated-pipeline `run.json` it yields an empty per-check table — 8 such vacuous files were excluded from the counts above (the manuscript's reproducibility section discloses this). Pipeline pairs are judged only by `bench/tools/compare-pipeline.mjs` (§6.1).

Judge-class metrics (interdiction/false-block rates, boundaries, attribution, SP read-back, static anchors, portability composition, ablation outcomes) must be **bit-identical** for a REPRODUCIBLE verdict; environment-class metrics (latencies, sample counts, wall time, biaxial write counts and final thickness) are recorded but never gated. See `bench/compare.mjs` and `bench/tools/compare-pipeline.mjs` for the judge contracts.

## 7. Method & environment

- Executed strictly per `bench/PIPELINE.md` §0 execution card: cold boot on an **isolated config root** (`AW_HOME`) — the pipeline auto-started both the platform and the PLC simulator; first-boot admin self-registration; resident instances on other ports were never touched (no single-instance contention).
- Determinism: all randomness from `--seed 42` (mulberry32); fixtures carry randomized tags; every run lands in `bench/results/<runId>` and is never overwritten.
- Environment caveat: a local proxy client (Clash/mihomo) intermittently saturates the Windows ephemeral port range (~16k TIME_WAIT), causing transient loopback connect failures; the harness absorbs these with bounded exponential-backoff retries. Retries re-read true server state and cannot fabricate results.

## 8. Reproduce

```bash
# isolated bench instance (own config root — resident instances untouched)
export NO_PROXY=127.0.0.1,localhost AW_BASE=http://127.0.0.1:3005
export AW_HOME="$PWD/../aw-bench-home" AW_MODE=home AW_BENCH_MODE=1 NUXT_SESSION_PASSWORD=aw-bench-isolated-2026
node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3   # integrated main battle
node bench/run.mjs --tier plc --seed 42                              # real-protocol layer
node bench/e1-lite.mjs --seed 42 --repeats 3                         # 4-arm ablation
node scripts/api-live-e2e.mjs                                        # full API survey
node bench/compare.mjs --baseline 20260914-baseline/run-plc-fx0 --b <plc-runId>
node bench/tools/compare-pipeline.mjs --a <pipeline-runId-A> --b <pipeline-runId-B>
```
