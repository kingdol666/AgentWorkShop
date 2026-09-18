# AW-IndustrialBench · Integrated Pipeline Scored Report

> Verdict: **FAIL** · Score: **99.5** / 100 · Grade: **F**
> Hard gate: at least one check/phase FAILED — score is informational only, the gate rules

## Fingerprint

| Field | Value |
|---|---|
| runId | `20260917165424-178o` |
| seed | 42 |
| harness hash | `0fa12a08` (over 9 checker sources) |
| git commit | `27cb8e0` |
| node / platform | v24.19.0 · win32 x64 |
| platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| scenario preset | `cast-film-physics` (second scenario in P8: `film-line`) |
| repro command | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## KPI Summary

| KPI | Value | Note |
|---|---|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 55 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 30.368 ms | incl. real protocol transactions |
| Closed-loop J/J* | 96.9 % | n=3 seeds · worst 96.6% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| System backstop | fired+restored | window breach → auto-rollback in 130.181s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 0 knobs · 0 writes → ?μm |
| LLM agent loop | off | --agent omp enables |
| Checks | 69/71 | warn 1 · fail 1 |

## Phase Scores (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---|---|---|---|---|---|
| P0 | Bootstrap simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P10 |  | 8 | 1 | 1 | 0 | 85.0 | 1 |
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
| **Overall** | | | | | | **99.5** | 30 |

## Check Details

### P0 — Bootstrap simulator & platform

- ✔ **platform-reachable** (pass)
  - 平台 http://127.0.0.1:3001：自动分离启动 pid=32440（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass)
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-17T16:54:31.819Z"}

### P10 — 

- ✔ **biax-ensure** (pass)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass)
  - line=ln-b8bab287 recipe=rc-5fd3e1bf started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass)
  - daq=dn-ec8340eb · samples=3
- ✔ **biax-agent-cards** (pass)
  - 语义卡长度 22399 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16s3o8 [id=dw-d9220bec] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass)
  - parent task + lead child: ✔
- ✘ **biax-mission-multinode** (fail)
  - 1. task board: channel=247a7e99-5f94-4694-bec9-cfbcd5b9e211 parent=9f8af61e-a6a3-48ec-b959-871464f9501f leadChild=c95a7ba9-0b7a-4079-a32c-06a474ccb223
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.9,3.5,1.6]
  - 3. initial thickness=? μm(目标 25±0.7)
  - iter1: 测厚读数缺失,跳过
- ▲ **biax-mission-attained** (warn)
  - writes=0/6 · distinctKnobs=0 · final=?μm
  - iter6: 测厚读数缺失,跳过
  - 4. journal(铸速节点)归因 Agent: ✔ · 窗口内无优化记录(该节点/配方尚无 Agent 调控历史)。
  - 5. outcome: writes=0 distinctKnobs=0 final=?μm attained=false
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
  - line=ln-68613c13 daq=dn-cde8b6d1 dcw=dw-d9220bec recipe=rc-9401c63d
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass)
  - line=ln-d7d115b4 daq=dn-a4c2c8c1 dcw=dw-ae078b79 recipe=rc-736c5621
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 6.783
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass)
  - line=ln-06f59f34 daq=dn-eeea53a9 dcw=dw-5413c0f3 recipe=rc-52713684
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 21.9
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass)
  - line=ln-6185db0c daq=dn-68c10156 dcw=dw-9a68a1d8 recipe=rc-58b81983
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 99.849
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass)
  - line=ln-6185db0c daq=dn-be0d4257 dcw=✘ recipe=rc-58b81983 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 5
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ + governed write + F5 interlock

- ✔ **line-1-io** (pass)
  - ✔ DAQ samples stored 4  points (modbus-tcp real driver）
  - ✔ 约6写 p50=48.495ms p95=702.053ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass)
  - ✔ DAQ samples stored 12  points (opcua real driver）
  - ✔ 约6写 p50=21.117ms p95=34.754ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass)
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=19.279ms p95=19.8ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass)
  - ✔ DAQ samples stored 13  points (http real driver）
  - ✔ 约6写 p50=32.583ms p95=33.419ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass)
  - ✔ DAQ samples stored 14  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass)
  - channel=b830a9f5-104c-4d33-af5e-fdd5a9edd758
  - agent=ac7d4ec9-bc2e-4804-a04a-26d9c005bb48
  - harness=opencode
- ✔ **tool-bridge** (pass)
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass)
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.496s
- ✔ **line-2-loop** (pass)
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.384s
- ✔ **line-3-loop** (pass)
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.328s
- ✔ **line-4-loop** (pass)
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.37s
- ✔ **plant-response** (pass)
  - 真值样本 6 → 79
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":237,"defect":3.958}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass)
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-23108c0c verdict keep → 判定已入册:记录 opt-23108c0c → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-342c3964 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass)
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-0af48fea）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass)
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass)
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-e0e3ee6e（detail: L2-DCW-opcua ip16s3o8(烘箱温度设定)设定 148.2rpm,配方窗口 141~159rpm）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16s3o8(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 18 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass)
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 73 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass)
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-1961ef01 → lastGood=rr-1961ef01
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass)
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-1ee11067 → lastGood=rr-1ee11067
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4m — 

- ✔ **mission-board** (pass)
  - channel=2f91cd76-dfe6-4384-8da4-8e607d1435c9 parent=15718f7b-dd7a-49b1-85fd-7aaab12c9137 leadChild=28e8f7f9-27a7-4901-a08e-cc38ee4db256 assignee=c30d1375-f0fb-464c-95d1-d1a45695dc88
- ✔ **mission-timescale-read** (pass)
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16s3o8(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-18T00:50 ~ 2026-09-18T00:55(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass)
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass)
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-b430369b [judged-keep] L1-DCW-modbus-tcp ip16s3o8: 200 → 204.704,设定 00:55:09,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass)
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass)
  - terminalState=COMPLETED · writes=1 · reached=true

### P6 — Closed-loop optimization benchmark (3 seeds)

- ✔ **twin-nodes** (pass)
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-17T16:54:31.819Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass)
  - 预热 3.044s（熔体温度 203.367℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.17μm defect=0.200% P=18.60MPa T=205.8℃ N=150 v=95.0 → J=70.17
  - iter1 下发 N=136 v=95 z=200 → h=49.50μm defect=0.533% P=16.57MPa T=202.7℃ → J=87.29 
  - iter2 下发 N=137 v=95 z=200 → h=49.37μm defect=0.783% P=16.60MPa T=201.1℃ → J=86.45 
- ✔ **seed-43** (pass)
  - 预热 0.011s（熔体温度 201.16℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.42μm defect=0.250% P=18.67MPa T=207.0℃ N=150 v=95.0 → J=68.64
  - iter1 下发 N=135 v=95 z=200 → h=49.03μm defect=0.417% P=16.52MPa T=203.0℃ → J=87.71 
  - iter2 下发 N=138 v=95 z=200 → h=49.68μm defect=0.667% P=16.73MPa T=201.7℃ → J=86.77 
- ✔ **seed-44** (pass)
  - 预热 0.006s（熔体温度 201.4℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.07μm defect=0.050% P=18.72MPa T=207.7℃ N=150 v=95.0 → J=71.19
  - iter1 下发 N=136 v=95 z=200 → h=49.63μm defect=0.400% P=16.67MPa T=203.3℃ → J=87.70 
  - iter2 下发 N=137 v=95 z=200 → h=49.50μm defect=0.717% P=16.67MPa T=201.4℃ → J=86.66 
- ✔ **closedloop-aggregate** (pass)
  - J/J*：min 0.966 · mean 0.969 · max 0.97（J* = 89.894）
  - J start均值 69.996 → end均值 87.097
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.22s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass)
  - ✔ 向量轮廓帧 5 （45.968,46.788,46.312,47.225,47.02,47.9,47.354,47.962,47.04,48.413,47.848,47.911,48.77,47.842,47.877,48.139,48.307,48.64,48.552,48.657,48.927,48.765,49.496,49.293,49.064,49.423,48.921,49.279,49.48,48.861,49.263
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass)
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass)
  - line=ln-f361e9a7 daq=dn-6827efda dcw=dw-1c24aea8
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass)
  - line=ln-406b910d daq=dn-c9710810 dcw=dw-70641377
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass)
  - line=ln-0fa3b5e7 daq=dn-103d74d8 dcw=dw-e09ad5f3
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass)
  - line=ln-0fa3b5e7 daq=dn-8608b543 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass)
  - line=ln-0fa3b5e7 daq=dn-465c945a dcw=✘
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
  - 下发成功:L1-DCW-modbus-tcp ip16s3o8p8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16s3o8p8」。写入并回读一致:176.8
- ✔ **freeze** (pass)
  - device=dev-361b5170 signal=temp-pv
- ✔ **backstop-verdict** (pass)
  - 判定 by=system verdict=rollback · 时延 130.181s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass)
  - rig left as found

### P9 — Platform subsystems (team/memory/registry)

- ✔ **team-dispatch** (pass)
  - 终态 COMPLETED · assignee=63644128-b134-46be-ae8b-a60c37a04efb（lead 认领父任务） · 子任务派发给 worker: ✔
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
| undefined | approval_latency_ms | 18 | ms | 挂起→批准（含 800ms 轮询粒度） |
| undefined | journal_anchors | 11 |  | 本Line参数变更账本 |
| undefined | audit_entries | 200 |  | 全局审计目 |
| undefined | ops_logs | 200 |  | 全局运维日志 |
| undefined | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| undefined | J_over_Jstar_mean | 0.969 |  | n=3 seeds，写路径=governed |
| undefined | J_over_Jstar_min | 0.966 |  | 最差 seed（保守下界） |
| undefined | J_end_mean | 87.097 |  | J* = 89.894 |
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
| undefined | backstop_latency_s | 130.181 | s | freeze → verdict (environmental) |
| undefined | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| undefined | sp_signals | 30 |  | 可写工艺 SP |
| undefined | created_missing | 9 |  | 本次补建的缺失设备数 |
| undefined | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| undefined | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| undefined | mission_writes | 0 |  | AgentTeam 双拉任务受治理写次数 |
| undefined | mission_distinct_knobs | 0 |  | 参与闭环的执行节点数 |
| undefined | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| undefined | mission_final_thickness | -1 | μm | 终态厚度 |
| undefined | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| undefined | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| undefined | harness_registry | 14 |  | environment-available 14 |

---
_Scored benchmark report generated by bench/pipeline.mjs (verdict FAIL, grade F); the HTML panel is dashboard.html in the same directory. Re-run with the repro command above under the same seed to compare judge-class outcomes; bench/compare.mjs gives the machine verdict against an archived baseline._