# AW-IndustrialBench · Integrated Pipeline Report

> **FAIL** — score **94.7**/100, grade **F**. Hard gate tripped: at least one check/phase failed; the score is informational only.

## Fingerprint

| Field | Value |
|---|---|
| Run ID | `20260918040908-1f4o` |
| Seed / preset | 42 / `cast-film-physics` |
| Harness hash | `38b1592b1f6d897c` (sha256 over 9 checker sources) |
| Git commit | `7d4bfc0` |
| Runtime | v24.19.0 · win32 x64 |
| Platform / simulator | http://127.0.0.1:3005 · http://127.0.0.1:4010 |
| Tool harness | opencode (deterministic) · LLM agent: (none) |
| Reproduce | `node bench/pipeline.mjs --profile quick --seed 42 --lines 2` |

## Key indicators

| KPI | Value | Note |
|---|---:|---|
| Provisionable lines | 2 | +0 satellite DAQ · modbus-tcp/opcua |
| DAQ samples total | 11 | 2/2 nodes sampling |
| Governance interception (pooled) | 100.0 % | F5 attacks |
| Write p50 (all protocols) | 35.69 ms | incl. real protocol transactions |
| Closed-loop J/J* | off | --cl-seeds 3 enables |
| Tool-level loops | 2 | dcw→daq→judge ×3 convergence |
| Param-layer governance | 2/4 | semantic surface · 4-layer write limits · agent param_control |
| System backstop | fired+restored | window breach → auto-rollback in 130.149s (env) |
| Scenario portability | film-line | 2nd scenario: 2 lines + 0 sat · F5 6/6 · 0 code changes |
| Biax line (BOPET) | 9 dev / 30 SP | AgentTeam 1 knobs · 1 writes → 0.04μm |
| LLM agent loop | off | --agent omp enables |
| Checks | 51/55 | warn 2 · fail 2 |

## Phase scorecard (weighted)

| Phase | Title | Pass | Warn | Fail | Skip | Score | Weight |
|---|---|---:|---:|---:|---:|---:|---:|
| P0 | Bootstrap · simulator & platform | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P1 | Plant model + offline optimum W* | 2 | 0 | 0 | 0 | 100.0 | 1 |
| P10 |  | 8 | 2 | 0 | 0 | 90.0 | 1 |
| P2 | Multi-protocol line provisioning | 3 | 0 | 0 | 0 | 100.0 | 2 |
| P3 | DAQ · governed write · F5 interlock | 2 | 0 | 0 | 0 | 100.0 | 3 |
| P4 | Agent-tool closed loop (3-cycle convergence) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P4b | Rollback & optimization records | 4 | 0 | 0 | 0 | 100.0 | 2 |
| P4c | HITL approval gate | 1 | 0 | 0 | 0 | 100.0 | 2 |
| P4d | Audit / ledger read surfaces | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P4e | Recipe lifecycle | 2 | 0 | 0 | 0 | 100.0 | 2 |
| P4f | Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits) | 2 | 0 | 2 | 0 | 50.0 | 3 |
| P4m |  | 6 | 0 | 0 | 0 | 100.0 | 1 |
| P7 | Multimodal acquisition (vector/image) | 1 | 0 | 0 | 0 | 100.0 | 1 |
| P8 | Cross-scenario portability | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P8b | System backstop drill (bounded autonomy) | 5 | 0 | 0 | 0 | 100.0 | 3 |
| P9 | Platform subsystems (team / memory / registry) | 3 | 0 | 0 | 0 | 100.0 | 1 |
| **Overall** | | | | | | **94.7** | 30 |

## Execution artifacts (Agent-team trajectory archive)

| Artifact | Size | Contents |
|---|---:|---|
| `agentteam-mission.log` | 1.0 KB | AgentTeam optimization mission — full task-board trajectory |
| `agentteam-biax.log` | 1.3 KB | AgentTeam biax multi-node mission — full trajectory |
| `metrics.csv` | 1.7 KB | Quantitative metrics registry (flat CSV) |
| `run.json` | 39.3 KB | Execution / trajectory log (verbatim archive) |
| `summary.json` | 11.0 KB | Execution / trajectory log (verbatim archive) |

## Check details

### P0 — Bootstrap · simulator & platform

- ✔ **platform-reachable** (pass) — platform reachable & authenticated
  - 平台 http://127.0.0.1:3005：自动分离启动 pid=62528（日志 D:\codes\ABO\aw-bench-platform.log）
  - 鉴权 OK (login)
  - simulator http://127.0.0.1:4010：already up (reused)

### P1 — Plant model + offline optimum W*

- ✔ **preset-applied** (pass) — 预设 cast-film-physics 已应用
  - devices 5 
  - 协议 modbus-tcp, modbus-rtu, opcua, mqtt, http
- ✔ **offline-optimum** (pass) — offline optimum W* (ground truth) available
  - W* = {"zoneTemp":212.5,"screw":55,"lineSpeed":40,"meltTemp":212.5,"pressure":6.961,"thickness":49.18,"defect":0.055,"score":89.894,"computedAt":"2026-09-18T04:09:15.289Z"}

### P10 — 

- ✔ **biax-ensure** (pass) — 节点探测补建(9 建缺失 / 0 修复 / 0 原样)
  - devices 9/9 · signals 49(SP 30 + PV 19) · 协议 opcua/modbus-tcp/modbus-rtu/mqtt/http
  - 描述缺失 0 · 物理引擎 kind=biax thickness=28.02 μm
  - 缺失设备: biax-dryer-opcua, biax-extruder-mbtcp, biax-pump-rtu, biax-casting-mbtcp, biax-mdo-mbtcp, biax-tdo-opcua, biax-gauge-mqtt, biax-inspect-http, biax-winder-mbtcp · 漂移修复: (无)
- ✔ **biax-provision** (pass) — 五协议多节点建线(DCW 30 + DAQ 19,驱动实测 9/9)
  - line=ln-01472c51 recipe=rc-ed39250d started=true
  - driver tests: dryer✔ extruder✔ pump✔ casting✔ mdo✔ tdo✔ gauge✔ inspect✔ winder✔
- ✔ **biax-sampling** (pass) — 测厚仪真实链路采样(2 点)
  - daq=dn-629e0c43 · samples=2
- ✔ **biax-agent-cards** (pass) — Agent 语义卡含双拉工艺描述(semantics 贯通)
  - 语义卡长度 17733 · 关键词命中 铸片辊速度/横向拉伸比/收卷张力
  - sample: #### ◆ L1-DCW-modbus-tcp ip16vsx5 [id=dw-1662a338] - 物理量: 烘箱温度设定,单位 ℃,精度 1 位小数 - 工艺语义: 模拟器设备「挤出主机PLC(Modbus TCP)」的 加热区1SP（真实 modbus-tcp 写控） - 安全量程: [120, 260] ℃
- ✔ **biax-mission-board** (pass) — 任务板:双拉优化任务下达并由 lead 派发
  - parent task + lead child: ✔
- ▲ **biax-mission-multinode** (warn) — 多节点受治理写(1 个执行节点 / 1 写)
  - 1. task board: channel=6a667779-3874-4640-9c37-11fded9f9853 parent=f71ac9ec-3b1e-4390-bc2d-c4b8e8d2a1f0 leadChild=5e3a6827-9acc-40f9-a442-3c66d269b0fd
  - 2. daq_query(测厚仪, from/to/bucket): isError=false · tail=[27.9,3.5,1.6]
  - 3. initial thickness=27.93 μm(目标 25±0.7)
  - iter1: 检出断膜量级读数(-0.10μm << 目标 25μm)——暂停纠偏,重下配方基线恢复
- ▲ **biax-mission-attained** (warn) — 厚度目标达成(|PV−25.0|≤0.7μm,final=0.04)
  - writes=1/6 · distinctKnobs=1 · final=0.04μm
  - iter1: 基线恢复失败,如实终止(植物侧流量/拉伸异常,非治理写路径或任务数学缺陷)
  - 4. journal(铸速节点)归因 Agent: ✔ · 优化记录(1 条,含参数/判定/窗口): - opt-6b2f168b [superseded] 铸片辊速度SP·ip16vsx5: 32 → 33.7,设定 12:12:34,判定 未判定,关闭于 12:13:35(superseded)
  - 5. outcome: writes=1 distinctKnobs=1 final=0.04μm attained=false
- ✔ **biax-mission-journal** (pass) — 参数账本 Agent 归因(铸速节点)
- ✔ **biax-mission-closed** (pass) — 任务收口(父任务 COMPLETED)
  - terminal=COMPLETED
- ✔ **biax-restore** (pass) — 双拉线停止 + 第一场景恢复: cast-film-physics
  - rig left as found

### P2 — Multi-protocol line provisioning

- ✔ **gateway** (pass) — gateway controller start (idempotent)
  - POST /api/workshop/daq/controller {action:start}
  - 采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line
- ✔ **line-1-modbus-tcp** (pass) — Line1 [modbus-tcp] 供给
  - line=ln-97f9ff3a daq=dn-455d9310 dcw=dw-1662a338 recipe=rc-dfd4c500
  - DAQ driver test ✔ 信号「熔体温度」：连接成功,读取 40001 = 31.329999923706055
  - SP 中心 200 窗口 [191.6, 208.4]
- ✔ **line-2-opcua** (pass) — Line2 [opcua] 供给
  - line=ln-3d19dc1b daq=dn-1abb74a6 dcw=dw-32899669 recipe=rc-58384e93
  - DAQ driver test ✔ 信号「MeltPressure」：会话建立成功,读取 ns=2;s=AW.P = 7.397
  - SP 中心 150 窗口 [141, 159]

### P3 — DAQ · governed write · F5 interlock

- ✔ **line-1-io** (pass) — Line1 [modbus-tcp] integration check
  - ✔ DAQ samples stored 2  points (modbus-tcp real driver）
  - ✔ 约6写 p50=47.478ms p95=95.528ms，readback deviation 0.04
  - ✔ Governance F5: 6/6 rejected (modbus-tcp 真实链路），legal write受理
- ✔ **line-2-io** (pass) — Line2 [opcua] integration check
  - ✔ DAQ samples stored 9  points (opcua real driver）
  - ✔ 约6写 p50=23.901ms p95=32.824ms，readback deviation 0
  - ✔ Governance F5: 6/6 rejected (opcua 真实链路），legal write受理

### P4 — Agent-tool closed loop (3-cycle convergence)

- ✔ **tool-loop-setup** (pass) — 闭环夹具（channel+agent）
  - channel=ba4e6892-d0e9-47fd-9d9d-6cfa628f95b8
  - agent=449f0f4e-2b01-46f0-9584-b55fee4aecf9
  - harness=opencode
- ✔ **tool-bridge** (pass) — opencode 的 host 工具直调面可用
  - 探测 my_industrial_nodes → 你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。
- ✔ **line-1-loop** (pass) — Line1 [modbus-tcp] Agent 闭环收敛（3/3 轮）
  - iter1: SP→194.96 ✔ · 回读 195 ✔ · daq ✔ · judge ✔
  - iter2: SP→197.48 ✔ · 回读 197.5 ✔ · daq ✔ · judge ✔
  - iter3: SP→200 ✔ · 回读 200 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 5.1s
- ✔ **line-2-loop** (pass) — Line2 [opcua] Agent 闭环收敛（3/3 轮）
  - iter1: SP→144.6 ✔ · 回读 145 ✔ · daq ✔ · judge ✔
  - iter2: SP→147.3 ✔ · 回读 147 ✔ · daq ✔ · judge ✔
  - iter3: SP→150 ✔ · 回读 150 ✔ · daq ✔ · judge ✔
  - 向窗口中心收敛 ✔ · 耗时 4.348s
- ✔ **plant-response** (pass) — 工艺模型响应（SP→plant truth 随动）
  - 真值样本 6 → 52
  - plant state: {"enabled":true,"running":true,"kind":"castfilm","phase":"steady","disturbances":{"heaterDecay":1,"feedDriftPerMin":0.15},"seed":42,"timeScale":6,"elapsedS":156,"defect":13.23}

### P4b — Rollback & optimization records

- ✔ **line-1-optrecord** (pass) — Line1 优化记录生命周期
  - current 204.6999969482422 → record A writes 208.06 (up)，记录 B writes 201.34 (down); opposite directions to dodge the rollback cooldown
  - ✔ (keep path) record opt-410e8615 verdict keep → 判定已入册:记录 opt-410e8615 → keep(bench: 回读一致，判定 keep)。已定档为已验证经验(配方已标记 last
  - ✔ (rollback path) record opt-88995da6 verdict rollback (recorded only; PLC still 201.3000030517578)
  - ✔ rollback executed (status 200) → readback 208.10000610351562 (expected record B from=208.06)
- ✔ **line-1-rbjudge** (pass) — Line1 撤销记录 opt-6c05c6cb 判定关闭
  - REST judge keep → status 200
- ✔ **line-1-rollback** (pass) — Line1 node-level single-step rollback (undo stack)
  - ✔ write 205.04 effective (readback 205, before 208.10000610351562)
  - ✔ journal rollback 受理（status 200，记录 opt-6c05c6cb）
  - ✔ readback after rollback 208.10000610351562 (expected back to 208.10000610351562, tolerance 0.75)
- ✔ **param-ledger** (pass) — 参数台账（三值对照 + 在册历史）
  - ✔ 参数台账可用（字段：nodeId, nodeName, current, recipeTarget, lastGood, journal, records）

### P4c — HITL approval gate

- ✔ **line-2-hitl** (pass) — Line2 HITL 审批闭环
  - ✔ 下发在人工确认模式下**挂起**，审批面板出现待审项 ap-278e13d8（detail: L2-DCW-opcua ip16vsx5(烘箱温度设定)设定 148.2rpm,有效写入区间 141~159rpm(节点安全量程 ∩ 配方）
  - ✔ verdict approved (status 200) → pending write **unblocked**: 下发成功:L2-DCW-opcua ip16vsx5(烘箱温度设定)设定 148.2rpm → PLC 原始值 148.2;回读 148.2rpm一致。当前活动配方「Integra
  - ✔ post-approval PLC effect: readback 148 (expected 148.2)
  - 审批裁决时延 17 ms（挂起→批准，含轮询周期）

### P4d — Audit / ledger read surfaces

- ✔ **audit-surfaces** (pass) — 治理只读面
  - ✔ 参数变更账本 journal：本产线 11  anchors (source coverage  rollback/manual/agent/recipe）
  - ✔ audit: 200 entries
  - ✔ ops-logs: 200 entries
  - ✔ 报警记录：全局 127 （含历史）

### P4e — Recipe lifecycle

- ✔ **line-1-recipe** (pass) — Line1 [modbus-tcp] recipe lifecycle
  - (1) initial versions 1, current param value 200
  - ✔ (2) versions after edit 2 (+1), param value 201.68 (expected 201.68)
  - ✔ (3) 标记已知良好批次 runId=rr-34f1c0d0 → lastGood=rr-34f1c0d0
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 200 (expected back to 200)
- ✔ **line-2-recipe** (pass) — Line2 [opcua] recipe lifecycle
  - (1) initial versions 1, current param value 150
  - ✔ (2) versions after edit 2 (+1), param value 151.8 (expected 151.8)
  - ✔ (3) 标记已知良好批次 runId=rr-96d456e3 → lastGood=rr-96d456e3
  - ✔ (4) versions after revert-to-v1 3 (+1, non-destructive), param value 150 (expected back to 150)

### P4f — Process-parameter mapping layer (semantic surface · standard conversions · 4-layer write limits)

- ✔ **param-facade** (pass) — Line2 [opcua] 参数面自动生成且无寄存器泄漏
  - param=pp-979cc690 key=temp-sp unit=rpm
  - 含 register/dataType/driverConfig? 无 ✔
- ✔ **param-limits** (pass) — Line2 基准限界 [72.5,177.5] + 产品限界 [93.5,156.5] 设定
  - param 72.5~177.5 · product 93.5~156.5 · node 50~200（四层收窄链：node ∩ param ∩ product ∩ recipe）
- ✘ **param-write-governed** (fail) — Line2 参数面写入联锁（交集内 ✔ · 越产品 ✘ · 越基准 ✘ · 读回 ✔）
  - 115.55 → ✘ 设定值 115.55rpm 低于下限 配方「Integrated工艺2 ip16vsx5」工艺窗口(工艺参数 temp-sp) 的 141rpm —— 约束层:配方「Integrated工艺2 ip16vsx5」工艺窗口(当前有效写入区间 141~156.5rpm;各层限界按安全规约取交集,越界写入已拒绝)
  - 167 → ✔ 产品层拦截
  - 188.75 → ✔ 基准限界层拦截
  - param read → ✔ 150rpm
- ✘ **agent-param-tools** (fail) — Line2 Agent param_control/param_read（语义写 ✔ · 越产品层拒 ✔ · 读 ✔ · 未绑定拒 ✔）
  - param_control 137.6 → ✘ 下发被拒绝:回退冷却中:节点「L2-DCW-opcua ip16vsx5」300s 内禁止同向重写(刚从 148 回退到 150);如确需调整请先 dcw_judge 复盘或反向操
  - param_control 167 → ✔ 产品层拦截
  - param_read → ✔
  - unbound agent → ✔ 权限面拒绝

### P4m — 

- ✔ **mission-board** (pass) — 任务板：优化任务下达并由 lead 派发
  - channel=fa70898e-ba69-4b2a-9d34-724a42c81a2b parent=c5b07fd4-3a08-436e-9ab7-952cceed41b9 leadChild=8becd229-32b8-4a01-9daf-26f38ccca9f4 assignee=de2d12b0-c456-4597-af78-560389f15216
- ✔ **mission-timescale-read** (pass) — 时段数据读取（daq_query from/to/bucket）
  - window 300s · isError=false
  - sample: 数采数据查询结果(1 个节点):  ■ L1-DAQ-modbus-tcp ip16vsx5(熔体/箱体温度)单位 ℃,正常量程 0~400℃,当前状态 alarm,时间窗 2026-09-18T12:04 ~ 2026-09-18T12:09(降采样 1000ms)   样本 
- ✔ **mission-governed-write** (pass) — 受治理参数下发（1 写全开记录+判定）
  - iter1: SP→204.704 ✔ · record=opened+judged · PV≈204.7 ✔
- ✔ **mission-journal** (pass) — 参数账本归因（Agent source 可追溯）
  - journal sample: 优化记录(4 条,含参数/判定/窗口): - opt-4d8c108a [judged-keep] L1-DCW-modbus-tcp ip16vsx5: 200 → 204.704,设定 12:09:39,判定 keep(agent:mission iter 1: PV=204.7 target=
- ✔ **mission-attained** (pass) — 优化目标达成（|PV−204.704|≤0.75）
  - writes=1/3 · finalPV=204.6999969482422 · target=204.704 · tol=0.75
- ✔ **mission-closed** (pass) — 任务收口（lead 派发→worker 剧本完成→父任务聚合）
  - terminalState=COMPLETED · writes=1 · reached=true

### P7 — Multimodal acquisition (vector/image)

- ✔ **frames** (pass) — 多形态数采（向量/图像帧）
  - ✔ 向量轮廓帧 5 （48.248,48.488,48.095,48.089,48.66,49.352,48.758,49.269,49.561,49.53,48.56,49.016,50.226,50.274,50.517,50.579,49.995,50.432,50.965,50.373,49.719,50.301,50.805,50.693,50.39,51.515,50.634,51.034,50.675,50.402,50.563,51.247,50.83,50.
  - ✔ 图像帧 5 （96×32 image/png）

### P8 — Cross-scenario portability

- ✔ **scenario-switch** (pass) — second plant scenario applied: film-line
  - devices 5 · protocols modbus-tcp, modbus-rtu, opcua, mqtt, http
  - 信号域/动力学与第一场景（cast-film-physics）完全不同 —— 框架代码零改动
- ✔ **commission-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] provisioned
  - line=ln-4d7a57f7 daq=dn-70e5332a dcw=dw-aafd8c7e
  - SP window [164.4, 195.6]
- ✔ **commission-2-opcua** (pass) — scenario[film-line] line 2 [opcua] provisioned
  - line=ln-54923034 daq=dn-dccf7251 dcw=dw-c46e2ce5
  - SP window [164.4, 195.6]
- ✔ **port-1-modbus-tcp** (pass) — scenario[film-line] line 1 [modbus-tcp] integration
  - ✔ DAQ samples 7 pts (modbus-tcp real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0.04
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)
- ✔ **port-2-opcua** (pass) — scenario[film-line] line 2 [opcua] integration
  - ✔ DAQ samples 9 pts (opcua real driver)
  - ✔ governed write 186.24 → HTTP 200
  - readback deviation 0
  - ✔ F5 out-of-window 3/3 rejected · legal write accepted (0 false block)

### P8b — System backstop drill (bounded autonomy)

- ✔ **cleanup** (pass) — 遗留 open 记录清场（关闭 2/2 条）
  - records closed: 2/2
- ✔ **open-record** (pass) — 优化记录 opt-67529892 已开（基线 186.1999969482422 → 176.88，auto 策略）
  - 下发成功:L1-DCW-modbus-tcp ip16vsx5p8(烘箱温度设定)设定 176.88℃ → PLC 原始值 176.88;回读 176.89999389648438℃一致。当前活动配方「Integrated工艺1 ip16vsx5p8」。写入并回读一致:176.8
- ✔ **freeze** (pass) — DAQ temp-pv 已冻结至 150（窗外，窗 [164.4, 195.6]）
  - device=dev-2ba17017 signal=temp-pv
- ✔ **backstop-verdict** (pass) — 系统兜底判定回退 + 自动恢复基线
  - 判定 by=system verdict=rollback · 时延 130.149s（环境类，节拍决定）
  - PLC 值 186.1999969482422 → 期望基线 186.1999969482422（±0.75） ✔
- ✔ **restore** (pass) — 过程量解冻 + 第一场景恢复: cast-film-physics
  - rig left as found

### P9 — Platform subsystems (team / memory / registry)

- ✔ **team-dispatch** (pass) — 团队调度（lead 派发 → worker 完成）
  - 终态 COMPLETED · assignee=fa96174d-3a77-4704-bc84-850281df61cc（lead 认领父任务） · 子任务派发给 worker: ✔
- ✔ **team-memory** (pass) — 团队记忆写入 + dedupKey 幂等
  - POST×2 status 200/200 → 列表中匹配 1 条（期望 1）
- ✔ **harness-registry** (pass) — 引擎注册表枚举 + 可用性探测
  - 注册 14 引擎（期望 ≥14） · 环境可用 14 · 覆盖 mock/RPC/SDK/CLI 族

## Metric registry

| Group | Metric | Value | Unit | Note |
|---|---|---:|---|---|
| plant | W_star_objective | 89.894 |  | offline grid-search optimum (benchmark ground truth) |
| provision | lines_created | 2 |  | 可开跑Line（另有 0 satellite DAQ） |
| provision | daq_nodes | 2 |  | real-protocol DAQ nodes |
| gov | intercept_modbus-tcp | 1 |  | governance interception rate |
| gov | intercept_opcua | 1 |  | governance interception rate |
| provision | lines_sampling | 2 |  | real driver produced samples |
| gov | intercept_rate_all | 1 |  | 全协议合并 |
| loop | tool_loops_ok | 2 |  lines | 工具级闭环达成 |
| loop | mission_writes | 1 |  | AgentTeam 优化任务受治理写次数 |
| loop | mission_attained | 1 |  | AgentTeam 优化任务达标 |
| gov | record_keep_rollback_ok | 1 |  | 优化记录判定/执行分离 |
| hitl | approval_latency_ms | 17 | ms | 挂起→批准（含 800ms 轮询粒度） |
| audit | journal_anchors | 11 |  | 本Line参数变更账本 |
| audit | audit_entries | 200 |  | 全局审计目 |
| audit | ops_logs | 200 |  | 全局运维日志 |
| recipe | recipe_lifecycles_ok | 2 |  lines | 版本/回退/基准恢复/下发 全链通过 |
| gov | param_layer_checks_ok | 2 | /4 | 工艺参数映射层全链 |
| daq | vector_frames | 5 |  | 厚度横向轮廓 |
| daq | image_frames | 5 |  | CCD 表面图像 |
| portability | scenario2_lines | 2 |  | second preset "film-line" (config-only) |
| portability | scenario2_intercept_rate | 1 |  | F5 out-of-window interception on second scenario |
| portability | scenario2_false_blocks | 0 |  | legal in-window writes blocked on second scenario |
| gov | backstop_fired | 1 |  | system-judged rollback on window breach |
| gov | backstop_restored | 1 |  | auto-restore to record baseline |
| gov | backstop_latency_s | 130.149 | s | freeze → verdict (environmental) |
| biax | devices | 9 |  | 双拉产线设备节点(探测补建后) |
| biax | sp_signals | 30 |  | 可写工艺 SP |
| biax | created_missing | 9 |  | 本次补建的缺失设备数 |
| biax | platform_dcw | 30 |  | 平台双拉 DCW 节点数 |
| biax | platform_daq | 19 |  | 平台双拉 DAQ 节点数 |
| biax | mission_writes | 1 |  | AgentTeam 双拉任务受治理写次数 |
| biax | mission_distinct_knobs | 1 |  | 参与闭环的执行节点数 |
| biax | mission_attained | 0 |  | 厚度达标 25.0±0.7μm |
| biax | mission_final_thickness | 0.04 | μm | 终态厚度 |
| team | team_dispatch_ok | 1 |  | lead→worker dispatch closed loop |
| memory | team_memory_idempotent | 1 |  | dedupKey idempotent refresh |
| agent | harness_registry | 14 |  | environment-available 14 |

---
_Machine-generated by `bench/pipeline.mjs` (verdict FAIL, grade F). The styled HTML panel is `report.html` in the same directory. Re-run under the same seed and compare judge-class outcomes with `bench/compare.mjs` against an archived baseline._