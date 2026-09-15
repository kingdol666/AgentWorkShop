# AW-IndustrialBench 评测报告 · 20260913154917-bhs
> 总体评分 **100.0/100（A）** · tier=`plc` · seed=42 · 2026-09-13T15:49:53.065Z
> 复现：`node bench/run.mjs --tier plc --seed 42 --base http://127.0.0.1:3001` · configHash=`61e1a1119d6f3ff2` · Node v24.19.0 · win32 x64
通过 13 · 警告 0 · 失败 0 · 跳过 0
## 维度评分
| 维度 | 得分 | 检查数 |
|---|---|---|
| D1 数据采集面 | 100.0 | 7 |
| D2 写控治理面 | 100.0 | 7 |
| D3 智能体面 | 100.0 | 1 |
| D6 互操作面 | 100.0 | 2 |
| D7 审计归因面 | 100.0 | 3 |
| D8 性能伸缩面 | 100.0 | 2 |
| D0 论文-代码一致性 | 100.0 | 1 |
## 检查明细
| 检查 | 层 | 状态 | 得分 | 指标 | 说明 |
|---|---|---|---|---|---|
| s1-inventory 能力清单核查（路由/引擎/工具/表/驱动） | static | ✔ 通过 | 100 | subchecks=&lt;b&gt;9&lt;/b&gt; · ok=&lt;b&gt;9&lt;/b&gt; · routes=&lt;b&gt;208&lt;/b&gt; · mcpTools=&lt;b&gt;25&lt;/b&gt; · engines=&lt;b&gt;14&lt;/b&gt; · tables=&lt;b&gt;22&lt;/b&gt; · tools=&lt;b&gt;10&lt;/b&gt; | 全部能力组件在源码中核实 |
| s2-paper-consistency 论文-代码常量一致性 | static | ✔ 通过 | 100 | anchors=&lt;b&gt;19&lt;/b&gt; · found=&lt;b&gt;19&lt;/b&gt; · missing=&lt;b&gt;0&lt;/b&gt; | 论文全部常量锚点在源码中核实 |
| s3-governance-pipeline 治理管线阶段顺序锚定 | static | ✔ 通过 | 100 | chainsOk=&lt;b&gt;2&lt;/b&gt; · chainTotal=&lt;b&gt;2&lt;/b&gt; | 治理管线六阶段结构与顺序核实（Algorithm 1 的源码对应物） |
| api-0-preflight 实例连通与鉴权 | api | ✔ 通过 | 100 | how=&lt;b&gt;login&lt;/b&gt; · role=&lt;b&gt;admin&lt;/b&gt; | 实例 http://127.0.0.1:3001 可用 |
| api-1-fixture 基准夹具（产线+配方窗+数采） | api | ✔ 通过 | 100 | created=&lt;b&gt;8&lt;/b&gt; · steps=&lt;b&gt;8&lt;/b&gt; · lineId=&lt;b&gt;ln-f8169e67&lt;/b&gt; · window=&lt;b&gt;175-205℃&lt;/b&gt; | 夹具就绪，软联锁窗口已激活 |
| api-2-semantic-card 语义卡字段与账本面 | api | ✔ 通过 | 100 | ok=&lt;b&gt;6&lt;/b&gt; · total=&lt;b&gt;6&lt;/b&gt; | 语义卡=Agent 的物理语义地基（论文 §III-D），缺失即治理失效 |
| api-3-interlock-f5 F5 越界写攻击（联锁拦截率） | api | ✔ 通过 | 100 | intercept_rate=&lt;b&gt;1&lt;/b&gt; · false_block_rate=&lt;b&gt;0&lt;/b&gt; · attacks=&lt;b&gt;6&lt;/b&gt; · intercepted=&lt;b&gt;6&lt;/b&gt; · legit=&lt;b&gt;3&lt;/b&gt; · legit_ok=&lt;b&gt;3&lt;/b&gt; · boundary_cases=&lt;b&gt;3&lt;/b&gt; · boundary_ok=&lt;b&gt;3&lt;/b&gt; · eq1_branch_coverage=&lt;b&gt;pass&lt;/b&gt; | I1 动态成立 + 决策边界覆盖 + Eq.(1) 双分支覆盖 |
| api-4-attribution-readback 回读闭环与写入归因 | api | ✔ 通过 | 100 | writes=&lt;b&gt;3&lt;/b&gt; · readback_ok=&lt;b&gt;3&lt;/b&gt; · readback_rate=&lt;b&gt;1&lt;/b&gt; · new_anchors=&lt;b&gt;3&lt;/b&gt; · attribution_rate=&lt;b&gt;1&lt;/b&gt; · tolerance=&lt;b&gt;0.7&lt;/b&gt; | 回读闭环与全链路归因成立（I2 + 可追溯性） |
| api-5-daq-freshness 数采新鲜度与查询时延 | api | ✔ 通过 | 100 | points=&lt;b&gt;17&lt;/b&gt; · latest_age_s=&lt;b&gt;17.9&lt;/b&gt; · samples_api_p50_ms=&lt;b&gt;21&lt;/b&gt; · samples_api_p95_ms=&lt;b&gt;22&lt;/b&gt; | 采集链路活性与查询面性能抽样 |
| plc-0-simulator PLC 模拟器就绪+薄膜产线预设 | plc | ✔ 通过 | 100 | protocols=&lt;b&gt;5&lt;/b&gt; · sim=&lt;b&gt;http://127.0.0.1:4010&lt;/b&gt; | 模拟器就绪(film-line 预设) |
| plc-1-realpath 五协议真实连通(导出配置→test-driver) | plc | ✔ 通过 | 100 | protocols_ok=&lt;b&gt;5&lt;/b&gt; · total=&lt;b&gt;5&lt;/b&gt; | 五协议真实栈全部连通 |
| plc-2-closedloop 真实采样+SP→PV 物理闭环+真实链路治理 | plc | ✔ 通过 | 100 | real_samples_first_window=&lt;b&gt;9&lt;/b&gt; · real_write_ok=&lt;b&gt;true&lt;/b&gt; · real_write_latency_ms=&lt;b&gt;27&lt;/b&gt; · sp_readback=&lt;b&gt;182&lt;/b&gt; · f5_rejected=&lt;b&gt;5/5&lt;/b&gt; · legal_write_ok=&lt;b&gt;true&lt;/b&gt; · pv_converge_s=&lt;b&gt;3&lt;/b&gt; · pv_final=&lt;b&gt;181.7&lt;/b&gt; · daq_points_total=&lt;b&gt;13&lt;/b&gt; | 真实协议工况闭环: 写控→Modbus→物理引擎→数采回读→治理拦截 |
| plc-4-fault 断链-恢复演练 | plc | ✔ 通过 | 100 | offline_detected=&lt;b&gt;true&lt;/b&gt; · reconnected=&lt;b&gt;true&lt;/b&gt; | 断链演练: 故障被感知且可恢复(F3 微缩版, 真实 TCP) |
## 证据摘录
### s1-inventory 能力清单核查（路由/引擎/工具/表/驱动）
- ✔ REST 路由文件 ≥ 200 — 实际 208
- ✔ MCP 工具 ≥ 25 — 实际 25
- ✔ Harness 引擎 = 14 — 找到 14/14
- ✔ SQLite 表 ≥ 20 — 实际 22
- ✔ FTS5 记忆索引 — agent_memories_fts
- ✔ 协议驱动 = 5 族 (modbus-tcp/rtu/opcua/mqtt/http) — 找到 modbus, rtu, opcua, mqtt, http
- ✔ 治理工具面 ≥ 10 — 10/10
- ✔ audit_log 14 列 schema — ops.repo.ts
- ✔ 审计 8 类事件枚举 — kind ∈ write/manual/alarm/…
### s2-paper-consistency 论文-代码常量一致性
- ✔ sweep 并发配额 64（server/services/workshop/daq/daq-controller.ts · 论文 §III-B2）
- ✔ sweep 周期 250ms（server/services/workshop/daq/daq-controller.ts · 论文 §III-B2）
- ✔ 回退重检周期 30s（server/services/workshop/dcw/recipe-rollback-manager.ts · 论文 §IV-D）
- ✔ 自动回退链上限 K=2（server/services/workshop/dcw/recipe-rollback-manager.ts · 论文 §IV-D / 不变式 I3）
- ✔ 越限判定阈值 B=3（server/services/workshop/dcw/recipe-rollback-manager.ts · 论文 §IV-D）
- ✔ 记忆 RRF k=60（server/services/workshop/runtime/memory.ts · 论文 §V-A）
- ✔ 记忆 MMR λ=0.7（server/services/workshop/runtime/memory.ts · 论文 §V-A）
- ✔ 记忆权重 0.5/0.3/0.2（server/services/workshop/runtime/memory.ts · 论文 §V-A 式(3)）
- ✔ 上下文压缩阈值 70%（app/config/schema.ts · 论文 §V-A）
- ✔ 记录过期接管 30min（app/config/schema.ts · 论文 §IV-B）
- ✔ WS 推送上限 60s（server/services/workshop/daq/daq-runtime.ts · 论文 §III-B1）
- ✔ 报警滞回 2% 量程（server/services/workshop/daq/daq-node.ts · 论文 §III-B3）
- ✔ 报警 warn 带 8% 量程（server/services/workshop/daq/daq-node.ts · 论文 §III-B3）
- ✔ 去抖 3 连续帧（server/services/workshop/daq/daq-node.ts · 论文 §III-B3）
- ✔ 写控账本条目类型（server/services/workshop/dcw/dcw-controller.ts · 论文 §IV-B 阶段5）
- ✔ 回读死区公式（server/services/workshop/dcw/dcw-runtime.ts · 论文 §IV 式(2)）
- ✔ AEP 协议版本 v1（shared/workshop-protocol.ts · 论文 §III-E）
- ✔ 调度空闲退避上限 8s（server/services/workshop/runtime/scheduler-loop.ts · 论文 §V-B）
- ✔ 停滞看门狗 300s（server/services/workshop/runtime/scheduler-loop.ts · 论文 §V-B）
### s3-governance-pipeline 治理管线阶段顺序锚定
- ✔ write() 编排链顺序成立: beforeWrite(护栏) → param.min(软联锁) → rt.write(执行) → afterWrite(闭环入册) → dcw.write.(审计)
- ✔ executeWrite() 执行链顺序成立: inverseTransform(编码) → readback(回读) → DcwWriteHistoryEntry(账本)
- ✔ 回读死区 writeTolerance() 存在（论文式(2)）
### api-0-preflight 实例连通与鉴权
- 登录成功（login，role=admin）
### api-1-fixture 基准夹具（产线+配方窗+数采）
- ✔ 产线 — ok
- ✔ 产品 — ok
- ✔ 数控模板 — ok
- ✔ 数控节点 ×2 — dw-a9b20c00/dw-7b344996
- ✔ 配方（软联锁窗） — ok
- ✔ 数采节点 — ok
- ✔ 采集已启动 — gateway+node start
- ✔ 批次开跑（软联锁激活） — ok
### api-2-semantic-card 语义卡字段与账本面
- ✔ 数控节点可列出 — found
- ✔ 硬联锁量程字段 — min=120 max=260
- ✔ 显示精度字段 — decimals=1
- ✔ 产线归属（五维打标） — ln-f8169e67
- ✔ 写控账本可查询 — anchors=2
- ✔ 数采节点可列出 — found
### api-3-interlock-f5 F5 越界写攻击（联锁拦截率）
- 拦截 below-global(v=107) → HTTP 400 VALIDATION_ERROR 设定值 107℃ 低于当前配方「Bench工艺 awb161ot2u」的工艺下限 175℃(节点全局量程 120~260
- 拦截 above-global(v=269) → HTTP 400 VALIDATION_ERROR 设定值 269℃ 超出当前配方「Bench工艺 awb161ot2u」的工艺上限 205℃(节点全局量程 120~260
- 拦截 above-window(v=219) → HTTP 400 VALIDATION_ERROR 设定值 219℃ 超出当前配方「Bench工艺 awb161ot2u」的工艺上限 205℃(节点全局量程 120~260
- 拦截 below-window(v=163) → HTTP 400 VALIDATION_ERROR 设定值 163℃ 低于当前配方「Bench工艺 awb161ot2u」的工艺下限 175℃(节点全局量程 120~260
- 拦截 extreme(v=1000000) → HTTP 400 VALIDATION_ERROR 设定值 1000000℃ 超出当前配方「Bench工艺 awb161ot2u」的工艺上限 205℃(节点全局量程 120
- 拦截 negative(v=-25) → HTTP 400 VALIDATION_ERROR 设定值 -25℃ 低于当前配方「Bench工艺 awb161ot2u」的工艺下限 175℃(节点全局量程 120~260
- 成功 in-window-low(v=180) → HTTP 200 ok
- 成功 in-window-mid(v=190) → HTTP 200 ok
- 成功 in-window-high(v=200) → HTTP 200 ok
- 符合 边界 edge-max-accept(v=205) 期望accept → HTTP 200
- 符合 边界 above-edge-reject(v=205.1) 期望reject → HTTP 400
- 符合 边界 below-edge-reject(v=174.9) 期望reject → HTTP 400
- 符合 无批次分支: 越全局 300 → HTTP 400（应拒）
- 符合 无批次分支: 窗外全局内 130 → HTTP 200（应受理,全局量程接管）
### api-4-attribution-readback 回读闭环与写入归因
- ✔ 写 v=182 回读(outcome)=182 → read=182 (τ=0.7)
- ✔ 写 v=191 回读(outcome)=191 → read=191 (τ=0.7)
- ✔ 写 v=197 回读(outcome)=197 → read=197 (τ=0.7)
- 账本新增锚点 3 条（四项判据齐全 3）
### api-5-daq-freshness 数采新鲜度与查询时延
- ✔ 时序数据点 17 个（最新距 now 17.9s）
- samples API p50=21ms p95=22ms（20 次抽样）
- 注：API 侧抽样，非 daq_e2e_latency（后者由 E4 对账实验给出）
### plc-0-simulator PLC 模拟器就绪+薄膜产线预设
- 五协议设备: modbus-tcp, modbus-rtu, opcua, mqtt, http
### plc-1-realpath 五协议真实连通(导出配置→test-driver)
- ✔ modbus-tcp 真实连通 ok (25ms)
- ✔ modbus-rtu 真实连通 ok (17ms)
- ✔ opcua 真实连通 ok (18ms)
- ✔ mqtt 真实连通 ok (17ms)
- ✔ http 真实连通 ok (31ms)
### plc-2-closedloop 真实采样+SP→PV 物理闭环+真实链路治理
- ✔ 真实 Modbus TCP 采样落库 9 点(~895ms 节拍)
- ✔ 真实 SP 写 182℃ → HTTP 200 (27ms, 含 Modbus 事务)
- ✔ 真实链路治理: 攻击 5/5 拒绝(200/400/150/188.1/175.9), 合法 180 受理
- ✔ SP→PV 物理闭环收敛 |PV-182|≤3℃ 用时 3s(一阶惯性)
- 闭环期间时序库持续采集: 累计 13 点
### plc-4-fault 断链-恢复演练
- ✔ 断链后主项目驱动失败被感知(test-driver ok=false)
- ✔ 模拟器重启后重连成功(test-driver ok=true)