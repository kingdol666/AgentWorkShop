# AW-IndustrialBench · Integrated Pipeline Scored Report

> Verdict: **PASS** · Score: **98.3** / 100 · Grade: **A**
> Hard gate: no failed checks; every gate green

## Fingerprint

| Field | Value |
|---|---|
| runId | `20260918013146-4ms` |
| seed | 42 |
| harness hash | `cca84f65` (over 9 checker sources) |
| git commit | `7d4bfc0` |
| node / platform | v24.19.0 · win32 x64 |
| platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| scenario preset | `cast-film-physics` (second scenario in P8: `film-line`) |
| repro command | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3 --agent omp` |

## KPI Summary

| KPI | Value | Note |
|---|---|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 58 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.884 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.0 % | n=3 seeds · worst 96.9% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| System backstop | fired+restored | window breach → auto-rollback in 130.191s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 4 writes → 0.02μm |
| LLM agent loop | COMPLETED | omp |
| Checks | 71/73 | warn 2 · fail 0 |

## Phase Scores (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---|---|---|---|---|---|
| P0 | Bootstrap simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P10 |  | 9 | 1 | 0 | 0 | 95.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ + governed write + F5 interlock | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 7 | 0 | 0 | 0 | 100.0 | 3 |
| P4b | Rollback & optimization records | 4 | 0 | 0 | 0 | 100.0 | 2 |
| P4c | HITL approval gate | 1 | 0 | 0 | 0 | 100.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4m |  | 6 | 0 | 0 | 0 | 100.0 | 1 |
| P5 |  | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P5b |  | 0 | 1 | 0 | 0 | 50.0 | 1 |
| P6 | Closed-loop optimization benchmark (3 seeds) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (I3 dynamic) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P9 | Platform subsystems (team/memory/registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| **Overall** | | | | | | **98.3** | 32 |

## Check Details

### P0 — Bootstrap simulator & platform

- ✔ **platform-reachable** (pass)
  - 平台 http://127.0.0.1:3001：自动分离启动 pid=48952（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass)
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-18T01:31:51.131Z"}

### P10 — 

- ✔ **biax-ensure** (pass)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass)
  - line=ln-0b6ee758 recipe=rc-530deeaa started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass)
  - daq=dn-696ef8c6 · samples=1
- ✔ **biax-agent-cards** (pass)
  - 语义卡长度 22439 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip169drc [id=dw-29cf7f42] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass)
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass)
  - 1. task board: channel=5c4554c1-052d-4c9e-8063-2c587bc2b0c8 parent=97dc24ae-e13f-4e26-9120-f829b5fe0e9d leadChild=63957ab1-e7bf-4123-aa27-8fe212a72d24
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.9,3.5,1.6]
  - 3. initial thickness=27.90 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ record=opt-f45922… · thickness→0.04μm · judge=keep✔
- ▲ **biax-mission-attained** (warn)
  - writes=4/6 · distinctKnobs=3 · final=0.02μm
  - iter6: rail-out-sp 变更量过小(cur=1800),换下一旋钮
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口): - opt-776088ef [judged-keep] 铸片辊速度SP·ip169drc: 33.7 → 10,设定 10:05:46,判定 keep(agent:biax mission ite
  - 5. outcome: writes=4 distinctKnobs=3 final=0.02μm attained=false
- ✔ **biax-mission-journal** (pass)
- ✔ **biax-mission-closed** (pass)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass)
  - rig left as found

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass)
  - line=ln-b9b2cb87 daq=dn-ee98d011 dcw=dw-29cf7f42 recipe=rc-50acc566
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass)
  - line=ln-4075db46 daq=dn-60ee5c85 dcw=dw-9930d906 recipe=rc-f39a731e
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 7.892
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass)
  - line=ln-c78f65a6 daq=dn-998ff76c dcw=dw-747aadab recipe=rc-65706ce3
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 21.9
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass)
  - line=ln-b91a488f daq=dn-27dc691c dcw=dw-c68f7f66 recipe=rc-43071411
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 99.981
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass)
  - line=ln-b91a488f daq=dn-4609500c dcw=✘ recipe=rc-43071411 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 4
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ + governed write + F5 interlock

- ✔ **line-1-io** (pass)
  - ✔ DAQ samples stored 8  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.4ms p95=489.777ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass)
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=19.173ms p95=19.845ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass)
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=19.874ms p95=19.932ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass)
  - ✔ DAQ samples stored 13  points (http real driver）
  - ✔ 约6写 p50=33.088ms p95=37.763ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass)
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass)
  - channel=c3e59640-0fd4-4241-87bd-f0d4eefa1b1c
  - agent=f1ee202f-6185-4825-8305-aaafe4079fca
  - harness=opencode
- ✔ **tool-bridge** (pass)
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass)
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 5.305s
- ✔ **line-2-loop** (pass)
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.414s
- ✔ **line-3-loop** (pass)
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.329s
- ✔ **line-4-loop** (pass)
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.371s
- ✔ **plant-response** (pass)
  - 真值样本 6 → 82
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":246,"defect":3.549}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass)
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-41cd98b2 verdict keep → 判定已入册:记录 opt-41cd98b2 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-4882562d verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass)
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-1f8b90f2）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass)
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass)
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-86fa913b（detail: L2-DCW-opcua ip169drc(烘箱温度设定)设定 148.2rpm,配方窗口 141~159rpm）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip169drc(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 441 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass)
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 112 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass)
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-3cff529e → lastGood=rr-3cff529e
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass)
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-e06d5ebc → lastGood=rr-e06d5ebc
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4m — 

- ✔ **mission-board** (pass)
  - channel=da4f3e20-9ba9-459d-a0e8-0da1f8bbf734 parent=e956bc9e-d4cf-40a6-affa-a325bf6e012e leadChild=0f0837cd-13ec-4103-ae1d-767b8d9e69f6 assignee=0c33f047-78d2-480b-a6d5-ba189b6cda84
- ✔ **mission-timescale-read** (pass)
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip169drc(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-18T09:27 ~ 2026-09-18T09:32(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass)
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass)
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-9f7b40bf [judged-keep] L1-DCW-modbus-tcp ip169drc: 200 → 204.704,设定 09:32:30,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass)
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass)
  - terminalState=COMPLETED · writes=1 · reached=true

### P5 — 

- ✔ **agent-loop** (pass)
  - 任务终态 COMPLETED（114.341s）
  - ✔ 交付含 INTEGRATED-CLOSEDLOOP-OK
  - harness=omp provider=zhipu-coding-plan model=glm-5.3-flash
  - 过程日志 → bench/results/20260918013146-4ms/agent-loop-omp.log（1 条消息）

### P5b — 

- ▲ **agent-goal** (warn)
  - 任务终态 WORKING（1503.213s）
  - ✔ GOAL-OPT-OK · 写≈4/6 · judge≈1 · 配方保存✘
  - 最终厚度 51.917 μm，目标 52±0.8 → 达标
  - 过程日志 → agent-goal-loop-omp.log

### P6 — Closed-loop optimization benchmark (3 seeds)

- ✔ **twin-nodes** (pass)
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-18T01:31:51.131Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass)
  - 预热 3.04s（熔体温度 204.8℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.25μm defect=0.217% P=18.55MPa T=205.7℃ N=150 v=95.0 → J=69.66
  - iter1 下发 N=136 v=95 z=200 → h=49.35μm defect=0.533% P=16.53MPa T=202.7℃ → J=87.29 
  - iter2 下发 N=138 v=95 z=200 → h=49.88μm defect=0.617% P=16.62MPa T=200.9℃ → J=86.92 
- ✔ **seed-43** (pass)
  - 预热 0.018s（熔体温度 200.72℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.42μm defect=0.233% P=18.67MPa T=207.0℃ N=150 v=95.0 → J=68.69
  - iter1 下发 N=135 v=95 z=200 → h=49.10μm defect=0.467% P=16.45MPa T=203.1℃ → J=87.55 
  - iter2 下发 N=137 v=95 z=200 → h=49.60μm defect=0.600% P=16.65MPa T=201.4℃ → J=87.03 
- ✔ **seed-44** (pass)
  - 预热 0.017s（熔体温度 201.38℃，达工艺窗 [195,225]）
  - iter0 起点：h=54.97μm defect=0.100% P=18.62MPa T=207.5℃ N=150 v=95.0 → J=71.58
  - iter1 下发 N=136 v=95 z=200 → h=49.68μm defect=0.433% P=16.63MPa T=203.2℃ → J=87.60 
  - iter2 下发 N=137 v=95 z=200 → h=49.40μm defect=0.750% P=16.65MPa T=201.6℃ → J=86.56 
- ✔ **closedloop-aggregate** (pass)
  - J/J*：min 0.969 · mean 0.97 · max 0.971（J* = 89.894）
  - J start均值 69.974 → end均值 87.157
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.183s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass)
  - ✔ 向量轮廓帧 5 （46.094,46.151,46.968,46.484,47.394,47.181,48.057,47.503,48.106,47.175,48.546,47.973,48.03,48.885,47.948,47.977,48.234,48.396,48.724,48.629,48.728,48.993,48.824,49.551,49.341,49.106,49.459,48.951,49.303,49.498,
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass)
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass)
  - line=ln-d00022b8 daq=dn-f56f0161 dcw=dw-538acc83
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass)
  - line=ln-1749294d daq=dn-ce317b29 dcw=dw-eb188071
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass)
  - line=ln-ac4a4e0a daq=dn-72c21069 dcw=dw-b1f6fe2d
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass)
  - line=ln-ac4a4e0a daq=dn-e5115071 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass)
  - line=ln-ac4a4e0a daq=dn-0049b411 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass)
  - ✔ DAQ samples 8 pts (modbus-tcp real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0.04
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-2-opcua** (pass)
  - ✔ DAQ samples 11 pts (opcua real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-3-mqtt** (pass)
  - ✔ DAQ samples 11 pts (mqtt real driver)
  - ✔ governed write 62.4 → HTTP 200
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-4-modbus-rtu** (pass)
  - ✔ DAQ samples 11 pts (modbus-rtu real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)
- ✔ **port-5-http** (pass)
  - ✔ DAQ samples 11 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (I3 dynamic)

- ✔ **cleanup** (pass)
  - records closed: 1/1
- ✔ **open-record** (pass)
  - 下发成功:L1-DCW-modbus-tcp ip169drcp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip169drcp8」。写入并回读一致:176.8
- ✔ **freeze** (pass)
  - device=dev-e3d4e15b signal=temp-pv
- ✔ **backstop-verdict** (pass)
  - 判定 by=system verdict=rollback · 时延 130.191s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass)
  - rig left as found

### P9 — Platform subsystems (team/memory/registry)

- ✔ **team-dispatch** (pass)
  - 终态 COMPLETED · assignee=e1215bdb-16c4-427d-9f5f-fa97d3237f37（lead 认领父任务） · 子任务派发给 worker: ✔
- ✔ **team-memory** (pass)
  - POST×2 status 200/200 → 列表中匹配 1 条（期望 1）
- ✔ **harness-registry** (pass)
  - 注册 14 引擎（期望 ≥14） · 环境可用 14 · 覆盖 mock/RPC/SDK/CLI 族

## Metric Registry

| Group | Metric | Value | Unit | Note |
|---|---|---|---|---|
| undefined | W_star_objective | 89.894 |  | offline grid-search optimum (benchmark ground truth) |
| undefined | lines_created | 4 |  | 可开跑Line（另有 1 satellite DAQ） |
| undefined | daq_nodes | 5 |  | real-protocol DAQ nodes |
| undefined | intercept_modbus-tcp | 1 |  | governance interception rate |
| undefined | intercept_opcua | 1 |  | governance interception rate |
| undefined | intercept_mqtt | 1 |  | governance interception rate |
| undefined | intercept_http | 1 |  | governance interception rate |
| undefined | lines_sampling | 5 |  | real driver produced samples |
| undefined | intercept_rate_all | 1 |  | 全协议合并 |
| undefined | tool_loops_ok | 4 |  lines | 工具级闭环达成 |
| undefined | mission_writes | 1 |  | AgentTeam 优化任务受治理写次数 |
| undefined | mission_attained | 1 |  | AgentTeam 优化任务达标 |
| undefined | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| undefined | approval_latency_ms | 441 | ms | 挂起→批准（含 800ms 轮询粒度） |
| undefined | journal_anchors | 11 |  | 本Line参数变更账本 |
| undefined | audit_entries | 200 |  | 全局审计目 |
| undefined | ops_logs | 200 |  | 全局运维日志 |
| undefined | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| undefined | agent_wall_s | 114.341 | s | omp |
| undefined | agent_oracle_pass | 1 |  | 交付判据命中 |
| undefined | goal_wall_s | 1503.213 | s | omp |
| undefined | goal_attained | 1 |  | 模型自定参数达成目标值 |
| undefined | J_over_Jstar_mean | 0.97 |  | n=3 seeds，写路径=governed |
| undefined | J_over_Jstar_min | 0.969 |  | 最差 seed（保守下界） |
| undefined | J_end_mean | 87.157 |  | J* = 89.894 |
| undefined | cl_iters_mean | 2 |  | 闭环收敛迭代数 |
| undefined | cl_writes_total | 6 |  | 受治理的闭环写总数 |
| undefined | cl_rejected_total | 0 |  | 越界被拒（治理拦截） |
| undefined | vector_frames | 5 |  | 厚度横向轮廓 |
| undefined | image_frames | 5 |  | CCD 表面图像 |
| undefined | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| undefined | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| undefined | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| undefined | backstop_fired | 1 |  | system-judged rollback on window breach |
| undefined | backstop_restored | 1 |  | auto-restore to record baseline |
| undefined | backstop_latency_s | 130.191 | s | freeze → verdict (environmental) |
| undefined | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| undefined | sp_signals | 30 |  | 可写工艺 SP |
| undefined | created_missing | 9 |  | 本次补建的缺失设备数 |
| undefined | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| undefined | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| undefined | mission_writes | 4 |  | AgentTeam 双拉任务受治理写次数 |
| undefined | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| undefined | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| undefined | mission_final_thickness | 0.020000000000000007 | μm | 终态厚度 |
| undefined | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| undefined | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| undefined | harness_registry | 14 |  | environment-available 14 |

---
_Scored benchmark report generated by bench/pipeline.mjs (verdict PASS, grade A); the HTML panel is dashboard.html in the same directory. Re-run with the repro command above under the same seed to compare judge-class outcomes; bench/compare.mjs gives the machine verdict against an archived baseline._