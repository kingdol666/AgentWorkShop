# AW-IndustrialBench · Integrated Pipeline Scored Report

> Verdict: **FAIL** · Score: **99.7** / 100 · Grade: **F**
> Hard gate: at least one check/phase FAILED — score is informational only, the gate rules

## Fingerprint

| Field | Value |
|---|---|
| runId | `20260917170804-3tg` |
| seed | 42 |
| harness hash | `a362debd` (over 9 checker sources) |
| git commit | `27cb8e0` |
| node / platform | v24.19.0 · win32 x64 |
| platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| scenario preset | `cast-film-physics` (second scenario in P8: `film-line`) |
| repro command | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## KPI Summary

| KPI | Value | Note |
|---|---|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 58 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.388 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.1 % | n=3 seeds · worst 97.0% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| System backstop | fired+restored | window breach → auto-rollback in 120.103s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 3 knobs · 4 writes → 25.26μm ✔ |
| LLM agent loop | off | --agent omp enables |
| Checks | 70/71 | warn 0 · fail 1 |

## Phase Scores (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---|---|---|---|---|---|
| P0 | Bootstrap simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P10 |  | 9 | 0 | 1 | 0 | 90.0 | 1 |
| P2 | Multi-protocol line provisioning | 6 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ + governed write + F5 interlock | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 7 | 0 | 0 | 0 | 100.0 | 3 |
| P4b | Rollback & optimization records | 4 | 0 | 0 | 0 | 100.0 | 2 |
| P4c | HITL approval gate | 1 | 0 | 0 | 0 | 100.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4m |  | 6 | 0 | 0 | 0 | 100.0 | 1 |
| P6 | Closed-loop optimization benchmark (3 seeds) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (I3 dynamic) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P9 | Platform subsystems (team/memory/registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| **Overall** | | | | | | **99.7** | 30 |

## Check Details

### P0 — Bootstrap simulator & platform

- ✔ **platform-reachable** (pass)
  - 平台 http://127.0.0.1:3001：already-up
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass)
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-17T17:08:07.235Z"}

### P10 — 

- ✔ **biax-ensure** (pass)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✘ **biax-provision** (fail)
  - line=ln-7843bb83 recipe=rc-46527ce2 started=true
  - driver tests: dryer✘ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass)
  - daq=dn-c573bf89 · samples=3
- ✔ **biax-agent-cards** (pass)
  - 语义卡长度 22400 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip169kut [id=dw-b7b60010] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass)
  - parent task + lead child: ✔
- ✔ **biax-mission-multinode** (pass)
  - 1. task board: channel=0a47196f-9ef7-4c7e-a436-0b9983f66972 parent=288a6738-64fe-4345-a42b-2b46aabb2f2e leadChild=a89e8b55-016a-46b0-9447-cc01b5d469cb
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[28.1,3.5,1.6]
  - 3. initial thickness=28.03 μm(目标 25±0.7)
  - iter1: cast-spd-sp 32→33.7 ✔ record=opt-ae8c70… · thickness→26.64μm · judge=keep✔
- ✔ **biax-mission-attained** (pass)
  - writes=4/6 · distinctKnobs=3 · final=25.26μm
  -         meltTemp=291.6℃(安全窗 268~300)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(2 条,含参数/判定/窗口): - opt-ce6611c5 [judged-keep] 铸片辊速度SP·ip169kut: 33.7 → 34.3,设定 01:15:50,判定 keep(agent:biax mission i
  - 5. outcome: writes=4 distinctKnobs=3 final=25.26μm attained=true
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
  - line=ln-26bbec36 daq=dn-cd432c41 dcw=dw-b7b60010 recipe=rc-6c1ea165
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass)
  - line=ln-036627ef daq=dn-4fd1460d dcw=dw-f3b3b046 recipe=rc-f8989ec1
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 6.137
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass)
  - line=ln-f7c05d06 daq=dn-d6807de6 dcw=dw-fb13ff37 recipe=rc-44b98590
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 19.1
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass)
  - line=ln-3c45f04c daq=dn-77cefcf7 dcw=dw-9a009017 recipe=rc-059a27c6
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 99.983
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass)
  - line=ln-3c45f04c daq=dn-2712a9aa dcw=✘ recipe=rc-059a27c6 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 6
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ + governed write + F5 interlock

- ✔ **line-1-io** (pass)
  - ✔ DAQ samples stored 9  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.377ms p95=94.816ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass)
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=18.904ms p95=33.033ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass)
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=18.764ms p95=19.562ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass)
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=32.505ms p95=34.292ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass)
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass)
  - channel=70b2b974-e590-40e5-86f3-33f6ce4bf5c0
  - agent=8bbd9c43-67cf-49d0-b5f7-8d660edb887c
  - harness=opencode
- ✔ **tool-bridge** (pass)
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass)
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.521s
- ✔ **line-2-loop** (pass)
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.391s
- ✔ **line-3-loop** (pass)
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.321s
- ✔ **line-4-loop** (pass)
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.346s
- ✔ **plant-response** (pass)
  - 真值样本 6 → 73
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":219,"defect":5.002}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass)
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-35279850 verdict keep → 判定已入册:记录 opt-35279850 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-1849f4ee verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass)
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-89576961）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass)
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass)
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-a2d48756（detail: L2-DCW-opcua ip169kut(烘箱温度设定)设定 148.2rpm,配方窗口 141~159rpm）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip169kut(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 17 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass)
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 83 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass)
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-04ac2320 → lastGood=rr-04ac2320
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass)
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-a5858cf1 → lastGood=rr-a5858cf1
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4m — 

- ✔ **mission-board** (pass)
  - channel=160916a4-1e62-4123-8909-c2c80ee9cdd6 parent=1e8b591e-413e-4c32-91d4-48c43c9bd2f2 leadChild=e4210cbd-8ba8-4370-9947-4a76fc0cd96b assignee=26ef290d-4f88-4a7b-90c0-e71641ce2264
- ✔ **mission-timescale-read** (pass)
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip169kut(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-18T01:03 ~ 2026-09-18T01:08(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass)
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass)
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-8cd2780b [judged-keep] L1-DCW-modbus-tcp ip169kut: 200 → 204.704,设定 01:08:41,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass)
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass)
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (3 seeds)

- ✔ **twin-nodes** (pass)
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-17T17:08:07.235Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass)
  - 预热 3.027s（熔体温度 203.167℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.42μm defect=0.167% P=18.60MPa T=206.0℃ N=150 v=95.0 → J=68.90
  - iter1 下发 N=135 v=95 z=200 → h=48.87μm defect=0.533% P=16.40MPa T=202.8℃ → J=87.34 
  - iter2 下发 N=138 v=95 z=200 → h=49.70μm defect=0.600% P=16.75MPa T=201.4℃ → J=86.97 
- ✔ **seed-43** (pass)
  - 预热 0.017s（熔体温度 201.32℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.57μm defect=0.250% P=18.60MPa T=206.6℃ N=150 v=95.0 → J=67.81
  - iter1 下发 N=135 v=95 z=200 → h=49.57μm defect=0.417% P=16.53MPa T=203.0℃ → J=87.71 
  - iter2 下发 N=136 v=95 z=200 → h=49.13μm defect=0.633% P=16.45MPa T=201.1℃ → J=86.98 
- ✔ **seed-44** (pass)
  - 预热 0.018s（熔体温度 200.94℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.63μm defect=0.100% P=18.72MPa T=207.3℃ N=150 v=95.0 → J=67.91
  - iter1 下发 N=135 v=95 z=200 → h=49.27μm defect=0.400% P=16.50MPa T=202.8℃ → J=87.76 
  - iter2 下发 N=137 v=95 z=200 → h=49.57μm defect=0.717% P=16.63MPa T=201.5℃ → J=86.66 
- ✔ **closedloop-aggregate** (pass)
  - J/J*：min 0.97 · mean 0.971 · max 0.972（J* = 89.894）
  - J start均值 68.206 → end均值 87.236
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.197s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass)
  - ✔ 向量轮廓帧 5 （46.126,46.155,47.343,47.137,47.595,46.752,47.391,47.425,47.164,48.102,48.023,47.138,48.875,48.772,48.388,48.839,49.104,49.191,48.255,48.816,48.695,48.975,49.094,49.214,49.1,49.4,49.67,48.657,48.715,49.45,48.99
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass)
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass)
  - line=ln-9ad41490 daq=dn-d23f69be dcw=dw-cabe18d7
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass)
  - line=ln-9544ca6c daq=dn-6c6e2c54 dcw=dw-9e478f89
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass)
  - line=ln-b02743e8 daq=dn-795a31b9 dcw=dw-2927c289
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass)
  - line=ln-b02743e8 daq=dn-26b59f57 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass)
  - line=ln-b02743e8 daq=dn-a709cd88 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass)
  - ✔ DAQ samples 9 pts (modbus-tcp real driver)
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
  - ✔ DAQ samples 10 pts (http real driver)
  - no SP write point; write/governance sub-checks skipped (satellite DAQ)

### P8b — System backstop drill (I3 dynamic)

- ✔ **cleanup** (pass)
  - records closed: 2/2
- ✔ **open-record** (pass)
  - 下发成功:L1-DCW-modbus-tcp ip169kutp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip169kutp8」。写入并回读一致:176.8
- ✔ **freeze** (pass)
  - device=dev-48a22be3 signal=temp-pv
- ✔ **backstop-verdict** (pass)
  - 判定 by=system verdict=rollback · 时延 120.103s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass)
  - rig left as found

### P9 — Platform subsystems (team/memory/registry)

- ✔ **team-dispatch** (pass)
  - 终态 COMPLETED · assignee=88d7cced-f2ca-4929-86c9-52924374b6f4（lead 认领父任务） · 子任务派发给 worker: ✔
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
| undefined | approval_latency_ms | 17 | ms | 挂起→批准（含 800ms 轮询粒度） |
| undefined | journal_anchors | 11 |  | 本Line参数变更账本 |
| undefined | audit_entries | 200 |  | 全局审计目 |
| undefined | ops_logs | 200 |  | 全局运维日志 |
| undefined | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| undefined | J_over_Jstar_mean | 0.971 |  | n=3 seeds，写路径=governed |
| undefined | J_over_Jstar_min | 0.97 |  | 最差 seed（保守下界） |
| undefined | J_end_mean | 87.236 |  | J* = 89.894 |
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
| undefined | backstop_latency_s | 120.103 | s | freeze → verdict (environmental) |
| undefined | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| undefined | sp_signals | 30 |  | 可写工艺 SP |
| undefined | created_missing | 9 |  | 本次补建的缺失设备数 |
| undefined | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| undefined | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| undefined | mission_writes | 4 |  | AgentTeam 双拉任务受治理写次数 |
| undefined | mission_distinct_knobs | 3 |  | 参与闭环的执行节点数 |
| undefined | mission_attained | 1 |  | 厚度达标 25.0±0.7μm |
| undefined | mission_final_thickness | 25.259999999999998 | μm | 终态厚度 |
| undefined | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| undefined | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| undefined | harness_registry | 14 |  | environment-available 14 |

---
_Scored benchmark report generated by bench/pipeline.mjs (verdict FAIL, grade F); the HTML panel is dashboard.html in the same directory. Re-run with the repro command above under the same seed to compare judge-class outcomes; bench/compare.mjs gives the machine verdict against an archived baseline._