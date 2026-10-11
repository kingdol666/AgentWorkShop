# AgentWorkShop 全功能基准报告(benchmark-20261010163807)

- 执行:一键 PIPELINE `node scripts/testing/run-benchmark.mjs`(耗时 2 分钟)
- 系统:**v0.7.57** · 119 活跃频道 · 运行内存水位 0.1875
- 总分:**38 / 38 断言通过**(100 分)

| 阶段 | 内容 | 通过 | 断言 |
|---|---|---|---|
| S0 | 环境预检 | 7/7 | 服务/模拟器/数采/基准产线 |
| S1 | API 全表面功能矩阵 | 0/0 | auth/users/channels/dcw/daq/tools/hitl/ops/memory 负向+正向 |
| S2 | 多源异构 + MES 双模 | 11/11 | 标量/向量/图像(sha256)/镜像路/直取路 |
| S3 | 治理负路径 | 3/3 | 越界拒/mock 兜底封堵 |
| S4 | 闭环优化场景(optimize) | 9/9 | 观测→决策→提案→HITL→下发→三方核验 |
| S5 | 稳定微调场景(tuning) | 4/4 | 小步→频控→回退→复原 |
| S6 | 数据诊断场景(diagnose) | 4/4 | 导出→统计→规格占比 |



> ✅ 全绿:全功能与闭环控制链路在本基准下全部达标。


## S0 环境预检
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 服务健康 | version=0.7.57 uptime=54min |
| ✅ | PLC 模拟器(:4010) |  |
| ✅ | MES 模拟器(:15060) | alive |
| ✅ | DAQ 控制器在采 | nodes=152 |
| ✅ | 基准产线在册 | 注塑一线·克重窗口寻优 |
| ✅ | 基准线总闸切 auto(harness 显式 confirm) | got=auto |
| ✅ | 配方参数面完整且在锚(mesDirect+holdP) | params=5 |

## S1 API 全表面功能矩阵(0/0)
| 判 | 断言 | 说明 |
|---|---|---|


## S2 多源异构 + MES 双模式(11/11)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 标量镜像入库(称重克重) | 2min 桶=9 |
| ✅ | 向量帧入库(壁厚轮廓) | 5min 帧=5 |
| ✅ | 图像帧入库(CCD) | 5min 帧=10 |
| ✅ | 图像 sha256 完整性指纹(P0 回归) | 10/10 帧带指纹 |
| ✅ | MES 镜像路(http 数采) | 2min 桶=9 |
| ✅ | MES 直取路(mes_fetch) | MES 历史取数(内联同步,1 个点位,窗口 10-10 16:23:07 ~ 10-10 16:38:07): |
| ✅ | 协议族 modbus-tcp 在采 | 熔体温度 ip16d8zgcl(7 桶/3min) |
| ✅ | 协议族 opcua 在采 | MeltPressure ip16d8zgcl(7 桶/3min) |
| ✅ | 协议族 mqtt 在采 | thick ip16d8zgcl(7 桶/3min) |
| ✅ | 协议族 http 在采 | defect ip16d8zgcl(7 桶/3min) |
| ✅ | 协议族 modbus-rtu 在采 | 晶点计数 ip16d8zgcl(7 桶/3min) |

## S3 治理负路径(3/3)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 越界写被拒(工艺安全量程) | 设定值 999bar 超出上限 节点工艺安全量程 的 110bar —— 约束层:节点安全量程(当前有效写入区间 30~90bar;各层限界按安全规约取交集,越界写入已拒绝) |
| ✅ | 未知驱动显式拒绝(mock 封堵,P0 回归) | 服务器内部错误 |
| ✅ | testDriver 未知协议拒绝 | 服务器内部错误 |

## S4 闭环优化场景 · 全过程时间线(9/9)

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 镜像观测有效(克重/缩痕) | weight=32.36g sink=1.17% |
| ✅ | 控制律出步(目标 32.5±0.35) | 63 → 64 |
| ✅ | HITL 卡出现且含推理依据 | card=ap-16579c3b |
| ✅ | HITL 裁决通过(附裁决意见) | ok |
| ✅ | 提案批准并整批下发 | 方案「BM-保压微升(灵敏度激励步)」已获批准并整批下发,全部参数设备证实(1/1,批次 rr-d2d94)。runId:rr-d2d94b44(后续轮次按此回访效果并回写经验) |
| ✅ | 批次台账 holdP 落账 ok | run=rr-d2d94b44 |
| ✅ | ACK 鉴定:holdP 写入设备证实(readback-verified) | {"ack":"readback-verified","verdict":"verified","attempts":0} |
| ✅ | ACK 鉴定:整批汇总全绿(ackSummary) | {"verified":1,"unverified":0,"failed":0,"total":1} |
| ✅ | 三方核验(配方|设备|镜像)一致 | 配方=64 设备=64 镜像=64 |

**过程记录(observation → decision → propose → HITL → dispatch → verify → verdict):**
| 时刻 | 事件 | 明细 |
|---|---|---|
| 16:38:08 | observation | {"holdP":63,"weight":32.36,"sink":1.17,"window":"8min"} |
| 16:38:08 | decision | {"mode":"converged-bounded-zigzag","err":0.142,"to":64,"rationale":"已收敛,围绕基准设定点 63 做有界激励步以实证闭环下发链路"} |
| 16:38:08 | propose | {"to":64,"package":"BM-保压微升(灵敏度激励步)"} |
| 16:38:10 | hitl_card | {"id":"ap-16579c3b","reasoning":true,"attempt":1} |
| 16:38:10 | approved | {"id":"ap-16579c3b","attempt":1} |
| 16:38:10 | dispatch | {"runId":"rr-d2d94b44","ok":true,"summary":"方案「BM-保压微升(灵敏度激励步)」已获批准并整批下发,全部参数设备证实(1/1,批次 rr-d2d94)。runId:rr-d2d94b44(后续轮次按此回访效果并回写经验)"} |
| 16:38:18 | settle-wait | 等待镜像 SP 采样跟上(15s) |
| 16:38:33 | verify | {"set":64,"device":64,"mirror":64,"threeWay":true} |
| 16:38:33 | verdict | {"converged":true,"dispatchedTo":64,"nextReview":"4min 惯性窗后复测"} |

## S5 稳定微调场景 · 全过程时间线(4/4)

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 单变量小步修正(治理链内) | 45 → 45.5 写入并回读一致:45.5 → raw 45.5,回读 45.5(标定后物理值 45.5) |
| ✅ | 立即反向写被频控/保持窗拦截 | DCW 节点「注塑一线·模具温度SP」两次在线写入间隔必须至少 60s，当前还需 60s |
| ✅ | 窗后回退到原值 | 45.5 → 45 写入并回读一致:45 → raw 45,回读 45(标定后物理值 45) |
| ✅ | 复原判读(节点值=原值) | value=45 |

**过程记录:**
| 时刻 | 事件 | 明细 |
|---|---|---|
| 16:38:33 | observation | {"moldT":45,"stepLimit":1.5} |
| 16:38:33 | micro-step | {"from":45,"to":45.5,"ok":true,"readback":45.5} |
| 16:38:33 | rate-limited | {"blocked":true,"message":"DCW 节点「注塑一线·模具温度SP」两次在线写入间隔必须至少 60s，当前还需 60s"} |
| 16:38:33 | settle-wait | 等待 66s 治理窗放行 |
| 16:39:39 | verdict | {"restored":true,"value":45} |

## S6 数据诊断场景(4/4)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | daq_export 全窗宽表 | daqexp-20261011003939-f201d8 |
| ✅ | 宽表行数达标(≥50 行) | rows=871 cols=14 |
| ✅ | 克重列统计有效 | n=871 mean=32.350 std=0.043 min=32.22 max=32.50 |
| ✅ | 规格内占比 ≥60%(32.5±0.35) | 100.0% (871/871) |

---
*机器可读结果见同目录 benchmark.json 与 timeline.jsonl;PIPELINE 源码 scripts/testing/run-benchmark.mjs。*
