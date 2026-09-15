# AW-IndustrialBench · Integrated Pipeline Scored Report

> Verdict: **PASS** · Score: **100.0** / 100 · Grade: **A**
> Hard gate: no failed checks; every gate green

## Fingerprint

| Field | Value |
|---|---|
| runId | `20260914162737-iek` |
| seed | 42 |
| harness hash | `912ec90c` (over 8 checker sources) |
| git commit | `d6c824d` |
| node / platform | v24.19.0 · win32 x64 |
| platform / simulator | http://127.0.0.1:3001 · http://127.0.0.1:4010 |
| scenario preset | `cast-film-physics` (second scenario in P8: `film-line`) |
| repro command | `node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3` |

## KPI Summary

| KPI | Value | Note |
|---|---|---|
| Provisionable lines | 4 | +1 satellite DAQ · modbus-tcp/opcua/mqtt/http/modbus-rtu |
| DAQ samples total | 48 | 5/5 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 30.147 ms | incl. real protocol transactions |
| Closed-loop J/J* | 96.9 % | n=3 seeds · worst 96.5% · J*=89.894 |
| Tool-level loops | 4 | dcw→daq→judge ×3 convergence |
| System backstop | fired+restored | window breach → auto-rollback in 130.177s (env) |
| Scenario portability | film-line | 2nd scenario: 3 lines + 2 sat · F5 9/9 · 0 code changes |
| LLM agent loop | off | --agent omp enables |
| Checks | 55/55 | warn 0 · fail 0 |

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
| P6 | Closed-loop optimization benchmark (3 seeds) | 6 | 0 | 0 | 0 | 100.0 | 3 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 11 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (I3 dynamic) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P9 | Platform subsystems (team/memory/registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| **Overall** | | | | | | **100.0** | 28 |

## Check Details

### P0 — Bootstrap simulator & platform

- ✔ **platform-reachable** (pass)
  - 平台 http://127.0.0.1:3001：自动分离启动 pid=43356（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：自动启动 pid=62520

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass)
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-14T16:27:49.700Z"}

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass)
  - line=ln-6cd472d5 daq=dn-fadf5a22 dcw=dw-8fa7b5a1 recipe=rc-fdd1bf32
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass)
  - line=ln-99ff013b daq=dn-ab9fb840 dcw=dw-740b2751 recipe=rc-1d2eeaa0
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 8.552
  - SP 中心 150 窗口 [141, 159]
- ✔ **line-3-mqtt** (pass)
  - line=ln-7d873e7f daq=dn-f52566fe dcw=dw-145b6958 recipe=rc-727b44d5
  - DAQ driver test ✔ 信号「thick」：Broker 连接成功,收到 aw/sim/thick = 26.94
  - SP 中心 95 窗口 [89, 101]
- ✔ **line-4-http** (pass)
  - line=ln-ef9197d0 daq=dn-4f473f42 dcw=dw-7ae87873 recipe=rc-db4e30e2
  - DAQ driver test ✔ 信号「defect」：接口可达,取值 = 85.463
  - SP 中心 1 窗口 [0.91, 1.09]
- ✔ **line-5-modbus-rtu** (pass)
  - line=ln-ef9197d0 daq=dn-8a3ea02e dcw=✘ recipe=rc-db4e30e2 ↪hosted by line4
  - DAQ driver test ✔ 信号「晶点计数」：网关连接成功,读取 40001 = 4
  - （该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）

### P3 — DAQ + governed write + F5 interlock

- ✔ **line-1-io** (pass)
  - ✔ DAQ samples stored 5  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.587ms p95=321.113ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass)
  - ✔ DAQ samples stored 11  points (opcua real driver）
  - ✔ 约6写 p50=20.544ms p95=27.536ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理
- ✔ **line-3-io** (pass)
  - ✔ DAQ samples stored 12  points (mqtt real driver）
  - ✔ 约6写 p50=19.629ms p95=21.563ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (mqtt 真实链路），legal write受理
- ✔ **line-4-io** (pass)
  - ✔ DAQ samples stored 13  points (http real driver）
  - ✔ 约6写 p50=32.827ms p95=33.127ms，readback deviation null
  - ✔ Governance F5: 6/6 rejected (http 真实链路），legal write受理
- ✔ **line-5-io** (pass)
  - ✔ DAQ samples stored 7  points (modbus-rtu real driver）
  - no SP write point; write/governance sub-checks skipped

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass)
  - channel=13b52824-3848-4565-9623-59310b798441
  - agent=e76168ff-a765-4a01-b938-dc13bce43bcc
  - harness=opencode
- ✔ **tool-bridge** (pass)
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass)
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 5.317s
- ✔ **line-2-loop** (pass)
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.33s
- ✔ **line-3-loop** (pass)
  - iter1: SP→91.4 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→93.2 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→95 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.321s
- ✔ **line-4-loop** (pass)
  - iter1: SP→0.946 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter2: SP→0.973 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - iter3: SP→1 ✔ · 回读 n/a(该驱动不回读) ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.364s
- ✔ **plant-response** (pass)
  - 真值样本 6 → 84
  - plant state: {"enabled":true,"running":true,"phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":252,"defect":3.308}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass)
  - current 200 → record A writes 203.36 (up)，记录 B writes 196.64 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-a7a78ab6 verdict keep → 判定已入册:记录 opt-a7a78ab6 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-cb1da9f0 verdict rollback (recorded only; PLC still 196.60000610351562)
  - ✔ rollback executed (status 200) → readback 203.39999389648438 (expected record B from=203.36)
- ✔ **line-1-rbjudge** (pass)
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass)
  - ✔ write 205.04 effective (readback 205, before 203.39999389648438)
  - ✔ journal rollback 受理（status 200，记录 opt-359db4c9）
  - ✔ readback after rollback 203.39999389648438 (expected back to 203.39999389648438, tolerance 0.75)
- ✔ **param-ledger** (pass)
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass)
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-8be34696（detail: L2-DCW-opcua ip16i7gy(烘箱温度设定)设定 148.2rpm,配方窗口 141~159rpm）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16i7gy(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 18 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass)
  - ✔ 参数变更账本 journal：本产线 10  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 198 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass)
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-29de28fb → lastGood=rr-29de28fb
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass)
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-4f5cdd16 → lastGood=rr-4f5cdd16
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P6 — Closed-loop optimization benchmark (3 seeds)

- ✔ **twin-nodes** (pass)
  - ✔ actuator nodes 6/6：zone1-sp, zone2-sp, zone3-sp, screw-sp, linespeed-sp, diegap-sp
  - ✔ sensor nodes 5/5：melt-temp, melt-pressure, film-thickness, defect-rate, gels-count
- ✔ **w-star** (pass)
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-14T16:27:49.700Z"}
  - 起始工况 {"zone":200,"screw":150,"lineSpeed":95,"dieGap":1}（J 显著低于 W*）
- ✔ **seed-42** (pass)
  - 预热 6.043s（熔体温度 204.5℃，达工艺窗 [195,225]）
  - iter0 起点：h=54.92μm defect=0.333% P=18.45MPa T=206.2℃ N=150 v=95.0 → J=71.13
  - iter1 下发 N=137 v=95 z=200 → h=49.33μm defect=0.583% P=16.67MPa T=202.5℃ → J=87.08 
  - iter2 下发 N=139 v=95 z=200 → h=50.22μm defect=0.733% P=16.83MPa T=201.5℃ → J=86.50 
- ✔ **seed-43** (pass)
  - 预热 0.018s（熔体温度 201.56℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.73μm defect=0.300% P=18.68MPa T=207.4℃ N=150 v=95.0 → J=66.74
  - iter1 下发 N=135 v=95 z=200 → h=48.93μm defect=0.500% P=16.53MPa T=203.2℃ → J=87.45 
  - iter2 下发 N=138 v=95 z=200 → h=49.97μm defect=0.683% P=16.73MPa T=201.6℃ → J=86.71 
- ✔ **seed-44** (pass)
  - 预热 0.017s（熔体温度 201.24℃，达工艺窗 [195,225]）
  - iter0 起点：h=55.67μm defect=0.350% P=18.68MPa T=207.7℃ N=150 v=95.0 → J=66.95
  - iter1 下发 N=135 v=95 z=200 → h=49.15μm defect=0.400% P=16.52MPa T=203.7℃ → J=87.76 
  - iter2 下发 N=137 v=95 z=200 → h=49.37μm defect=0.633% P=16.63MPa T=201.6℃ → J=86.92 
- ✔ **closedloop-aggregate** (pass)
  - J/J*：min 0.965 · mean 0.969 · max 0.972（J* = 89.894）
  - J start均值 68.27 → end均值 87.07
  - 平均迭代 2  · 总写 6 · 越界rejected 0 · 收敛 3/3 · 平均墙钟 36.198s/seed

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass)
  - ✔ 向量轮廓帧 5 （50.648,49.779,50.487,50.552,50.301,51.329,51.272,50.354,52.237,52.155,51.771,52.28,52.591,52.711,51.734,52.362,52.258,52.585,52.74,52.895,52.798,53.146,53.463,52.399,52.487,53.304,52.843,53.003,53.994,53.203,5
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass)
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass)
  - line=ln-d88511c1 daq=dn-cc7872e7 dcw=dw-02a303f1
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass)
  - line=ln-c33945a8 daq=dn-30f7d86a dcw=dw-49bd7a9e
  - SP window [164.4, 195.6]
- ✔ **commission-3-mqtt** (pass)
  - line=ln-f4258803 daq=dn-bf4cf54f dcw=dw-4ddafbdc
  - SP window [54, 66]
- ✔ **commission-4-modbus-rtu** (pass)
  - line=ln-f4258803 daq=dn-e194ee10 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **commission-5-http** (pass)
  - line=ln-f4258803 daq=dn-922eff92 dcw=✘
  - (no SP export → satellite DAQ)
- ✔ **port-1-modbus-tcp** (pass)
  - ✔ DAQ samples 6 pts (modbus-tcp real driver)
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
  - records closed: 3/3
- ✔ **open-record** (pass)
  - 下发成功:L1-DCW-modbus-tcp ip16i7gyp8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16i7gyp8」。写入并回读一致:176.8
- ✔ **freeze** (pass)
  - device=dev-9a843926 signal=temp-pv
- ✔ **backstop-verdict** (pass)
  - 判定 by=system verdict=rollback · 时延 130.177s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass)
  - rig left as found

### P9 — Platform subsystems (team/memory/registry)

- ✔ **team-dispatch** (pass)
  - 终态 COMPLETED · assignee=742499f4-2798-49c5-a77a-03ecf4de4c3c（lead 认领父任务） · 子任务派发给 worker: ✔
- ✔ **team-memory** (pass)
  - POST×2 status 200/200 → 列表中匹配 1 条（期望 1）
- ✔ **harness-registry** (pass)
  - 注册 14 引擎（期望 ≥14） · 环境可用 12 · 覆盖 mock/RPC/SDK/CLI 族

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
| undefined | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| undefined | approval_latency_ms | 18 | ms | 挂起→批准（含 800ms 轮询粒度） |
| undefined | journal_anchors | 10 |  | 本Line参数变更账本 |
| undefined | audit_entries | 200 |  | 全局审计目 |
| undefined | ops_logs | 200 |  | 全局运维日志 |
| undefined | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| undefined | J_over_Jstar_mean | 0.969 |  | n=3 seeds，写路径=governed |
| undefined | J_over_Jstar_min | 0.965 |  | 最差 seed（保守下界） |
| undefined | J_end_mean | 87.07 |  | J* = 89.894 |
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
| undefined | backstop_latency_s | 130.177 | s | freeze → verdict (environmental) |
| undefined | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| undefined | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| undefined | harness_registry | 14 |  | environment-available 12 |

---
_Scored benchmark report generated by bench/pipeline.mjs (verdict PASS, grade A); the HTML panel is dashboard.html in the same directory. Re-run with the repro command above under the same seed to compare judge-class outcomes; bench/compare.mjs gives the machine verdict against an archived baseline._