# AW-IndustrialBench · Integrated Pipeline Scored Report

> Verdict: **PASS** · Score: **98.4** / 100 · Grade: **A**
> Hard gate: no failed checks; every gate green

## Fingerprint

| Field | Value |
|---|---|
| runId | `20260917104058-v4w` |
| seed | 42 |
| harness hash | `5accd020` (over 8 checker sources) |
| git commit | `736e87c` |
| node / platform | v24.19.0 · win32 x64 |
| platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| scenario preset | `cast-film-physics` (second scenario in P8: `film-line`) |
| repro command | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3 --agent omp` |

## KPI Summary

| KPI | Value | Note |
|---|---|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 56 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 29.599 ms | incl. real protocol transactions |
| Closed-loop J/J* | 97.1 % | n=3 seeds · worst 97.0% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| System backstop | fired+restored | window breach → auto-rollback in 120.142s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| LLM agent loop | COMPLETED | omp |
| Checks | 62/63 | warn 1 · fail 0 |

## Phase Scores (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---|---|---|---|---|---|
| P0 | Bootstrap simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
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
| **Overall** | | | | | | **98.4** | 31 |

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
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-17T10:41:01.721Z"}

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass)
  - line=ln-d31b2052 daq=dn-aacf41dc dcw=dw-14fe9543 recipe=rc-a575c74f
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass)
  - line=ln-0d2f2e10 daq=dn-85058932 dcw=dw-4449a304 recipe=rc-408e28a4
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 6.137
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass)
  - line=ln-6f70d9e7 daq=dn-e1ee6505 dcw=dw-67845ead recipe=rc-48320611
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 19.1
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass)
  - line=ln-e405a347 daq=dn-91898148 dcw=dw-6b024163 recipe=rc-eb128dd9
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 99.983
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass)
  - line=ln-e405a347 daq=dn-9ab4b1d9 dcw=✘ recipe=rc-eb128dd9 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 4
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ + governed write + F5 interlock

- ✔ **line-1-io** (pass)
  - ✔ DAQ samples stored 7  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.018ms p95=93.719ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass)
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=20.262ms p95=30.137ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass)
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=18.88ms p95=34.648ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass)
  - ✔ DAQ samples stored 12  points (http real driver）
  - ✔ 约6写 p50=32.237ms p95=33.979ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass)
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass)
  - channel=643642dc-9771-498b-aea2-ace93c1752d4
  - agent=f619d548-8da5-4b99-baa9-7ef834200901
  - harness=opencode
- ✔ **tool-bridge** (pass)
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass)
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.61s
- ✔ **line-2-loop** (pass)
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.3s
- ✔ **line-3-loop** (pass)
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.344s
- ✔ **line-4-loop** (pass)
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.517s
- ✔ **plant-response** (pass)
  - 真值样本 6 → 73
  - plant state: {"enabled":true,"running":true,"phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":219,"defect":5.002}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass)
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-262fb691 verdict keep → 判定已入册:记录 opt-262fb691 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-d040cfd2 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass)
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-db8c83ff）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass)
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass)
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-70589581（detail: L2-DCW-opcua ip16frxb(烘箱温度设定)设定 148.2rpm,配方窗口 141~159rpm）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16frxb(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 12 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass)
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 24 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass)
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-78162df0 → lastGood=rr-78162df0
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass)
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-6cef653a → lastGood=rr-6cef653a
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4m — 

- ✔ **mission-board** (pass)
  - channel=e8d4508f-0194-4ca2-9065-257ea6125a5b parent=50350c5a-d8d6-4960-9eab-8ec554fcfcf9 leadChild=6ee8cb0e-aa4a-418f-8154-e9b4086a6554 assignee=abb2f36c-88dc-489e-acb6-254005ca2ca6
- ✔ **mission-timescale-read** (pass)
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16frxb(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-17T18:36 ~ 2026-09-17T18:41(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass)
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass)
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-d4496a0a [judged-keep] L1-DCW-modbus-tcp ip16frxb: 200 → 204.704,设定 18:41:36,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass)
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass)
  - terminalState=COMPLETED · writes=1 · reached=true

### P5 — 

- ✔ **agent-loop** (pass)
  - 任务终态 COMPLETED（126.263s）
  - ✔ 交付含 INTEGRATED-CLOSEDLOOP-OK
  - harness=omp provider=zhipu-coding-plan model=glm-5.3-flash
  - 过程日志 → bench/results/20260917104058-v4w/agent-loop-omp.log（1 条消息）

### P5b — 

- ▲ **agent-goal** (warn)
  - 任务终态 COMPLETED（1455.237s）
  - ✔ GOAL-OPT-OK · 写≈0/6 · judge≈0 · 配方保存✘
  - 最终厚度 51.633 μm，目标 52±0.8 → 达标
  - 过程日志 → agent-goal-loop-omp.log

### P6 — Closed-loop optimization benchmark (3 seeds)

- ✔ **twin-nodes** (pass)
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-17T10:41:01.721Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass)
  - 预热 0.024s（熔体温度 199.9℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.62μm defect=0.100% P=18.62MPa T=206.8℃ N=150 v=95.0 → J=68.00
  - iter1 下发 N=135 v=95 z=200 → h=49.08μm defect=0.450% P=16.53MPa T=203.0℃ → J=87.60 
  - iter2 下发 N=138 v=95 z=200 → h=50.17μm defect=0.650% P=16.77MPa T=201.0℃ → J=86.82 
- ✔ **seed-43** (pass)
  - 预热 0.022s（熔体温度 200.68℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.57μm defect=0.250% P=18.60MPa T=206.8℃ N=150 v=95.0 → J=67.81
  - iter1 下发 N=135 v=95 z=200 → h=49.07μm defect=0.417% P=16.52MPa T=202.8℃ → J=87.71 
  - iter2 下发 N=138 v=95 z=200 → h=49.97μm defect=0.717% P=16.73MPa T=201.5℃ → J=86.61 
- ✔ **seed-44** (pass)
  - 预热 0.025s（熔体温度 203.06℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.27μm defect=0.350% P=18.72MPa T=207.2℃ N=150 v=95.0 → J=69.15
  - iter1 下发 N=136 v=95 z=200 → h=49.93μm defect=0.400% P=16.65MPa T=202.8℃ → J=87.70 
  - iter2 下发 N=136 v=95 z=200 → h=48.72μm defect=0.617% P=16.53MPa T=201.4℃ → J=87.03 
- ✔ **closedloop-aggregate** (pass)
  - J/J*：min 0.97 · mean 0.971 · max 0.972（J* = 89.894）
  - J start均值 68.321 → end均值 87.244
  - 平均迭代 2  · 总写 5 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.18s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass)
  - ✔ 向量轮廓帧 5 （45.694,46.023,46.325,47.084,46.612,46.393,47.178,47.378,47.077,47.493,47.402,47.033,47.831,47.172,48.475,48.713,48.299,47.993,48.459,48.571,49.035,48.322,48.41,48.648,49.102,48.425,49.189,49.383,49.036,48.414,
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass)
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass)
  - line=ln-9c013535 daq=dn-5913c68d dcw=dw-5814998f
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass)
  - line=ln-5b25159d daq=dn-3bb589a0 dcw=dw-1396fb57
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass)
  - line=ln-a48e305d daq=dn-1be3f227 dcw=dw-79642aef
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass)
  - line=ln-a48e305d daq=dn-61be909d dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass)
  - line=ln-a48e305d daq=dn-5595930c dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass)
  - ✔ DAQ samples 10 pts (modbus-tcp real driver)
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
  - records closed: 1/1
- ✔ **open-record** (pass)
  - 下发成功:L1-DCW-modbus-tcp ip16frxbp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16frxbp8」。写入并回读一致:176.8
- ✔ **freeze** (pass)
  - device=dev-ec2c3cf3 signal=temp-pv
- ✔ **backstop-verdict** (pass)
  - 判定 by=system verdict=rollback · 时延 120.142s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass)
  - rig left as found

### P9 — Platform subsystems (team/memory/registry)

- ✔ **team-dispatch** (pass)
  - 终态 COMPLETED · assignee=429cf656-d46a-4cb2-af6c-4d4ab3fd0f8f（lead 认领父任务） · 子任务派发给 worker: ✔
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
| undefined | approval_latency_ms | 12 | ms | 挂起→批准（含 800ms 轮询粒度） |
| undefined | journal_anchors | 11 |  | 本Line参数变更账本 |
| undefined | audit_entries | 200 |  | 全局审计目 |
| undefined | ops_logs | 200 |  | 全局运维日志 |
| undefined | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| undefined | agent_wall_s | 126.263 | s | omp |
| undefined | agent_oracle_pass | 1 |  | 交付判据命中 |
| undefined | goal_wall_s | 1455.237 | s | omp |
| undefined | goal_attained | 1 |  | 模型自定参数达成目标值 |
| undefined | J_over_Jstar_mean | 0.971 |  | n=3 seeds，写路径=governed |
| undefined | J_over_Jstar_min | 0.97 |  | 最差 seed（保守下界） |
| undefined | J_end_mean | 87.244 |  | J* = 89.894 |
| undefined | cl_iters_mean | 2 |  | 闭环收敛迭代数 |
| undefined | cl_writes_total | 5 |  | 受治理的闭环写总数 |
| undefined | cl_rejected_total | 0 |  | 越界被拒（治理拦截） |
| undefined | vector_frames | 5 |  | 厚度横向轮廓 |
| undefined | image_frames | 5 |  | CCD 表面图像 |
| undefined | scenario2_lines | 3 |  | second preset "film-line" (config-only) |
| undefined | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| undefined | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| undefined | backstop_fired | 1 |  | system-judged rollback on window breach |
| undefined | backstop_restored | 1 |  | auto-restore to record baseline |
| undefined | backstop_latency_s | 120.142 | s | freeze → verdict (environmental) |
| undefined | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| undefined | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| undefined | harness_registry | 14 |  | environment-available 14 |

---
_Scored benchmark report generated by bench/pipeline.mjs (verdict PASS, grade A); the HTML panel is dashboard.html in the same directory. Re-run with the repro command above under the same seed to compare judge-class outcomes; bench/compare.mjs gives the machine verdict against an archived baseline._