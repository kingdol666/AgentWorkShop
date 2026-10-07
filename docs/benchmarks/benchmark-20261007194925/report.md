# AgentWorkShop 全功能基准报告(benchmark-20261007194925)

- 执行:一键 PIPELINE `node scripts/testing/run-benchmark.mjs`(耗时 5 分钟)
- 系统:**v0.7.57** · 112 活跃频道 · 运行内存水位 0.1106
- 总分:**79 / 79 断言通过**(100 分)

| 阶段 | 内容 | 通过 | 断言 |
|---|---|---|---|
| S0 | 环境预检 | 5/5 | 服务/模拟器/数采/基准产线 |
| S1 | API 全表面功能矩阵 | 45/45 | auth/users/channels/dcw/daq/tools/hitl/ops/memory 负向+正向 |
| S2 | 多源异构 + MES 双模 | 11/11 | 标量/向量/图像(sha256)/镜像路/直取路 |
| S3 | 治理负路径 | 3/3 | 越界拒/mock 兜底封堵 |
| S4 | 闭环优化场景(optimize) | 7/7 | 观测→决策→提案→HITL→下发→三方核验 |
| S5 | 稳定微调场景(tuning) | 4/4 | 小步→频控→回退→复原 |
| S6 | 数据诊断场景(diagnose) | 4/4 | 导出→统计→规格占比 |


> ✅ 全绿:全功能与闭环控制链路在本基准下全部达标。


## S0 环境预检
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 服务健康 | version=0.7.57 uptime=48min |
| ✅ | PLC 模拟器(:4010) |  |
| ✅ | MES 模拟器(:15060) | alive |
| ✅ | DAQ 控制器在采 | nodes=67 |
| ✅ | 基准产线在册 | 注塑一线·克重窗口寻优 |

## S1 API 全表面功能矩阵(45/45)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | auth:错误密码被拒 | code=UNAUTHORIZED |
| ✅ | auth:admin 登录 |  |
| ✅ | auth:/me 身份 | role=admin |
| ✅ | auth:无 token 拒绝 | code=USER_UNAUTHORIZED |
| ✅ | users:列表 | count=20 |
| ✅ | users:建测试用户 | ok |
| ✅ | users:新用户可登录 |  |
| ✅ | channels:admin 全量可见 | count=113 |
| ✅ | permissions:无 grant 用户看不到绑线频道 | visible=1,绑线=0 |
| ✅ | permissions:普通用户禁用户管理 | code=ADMIN_REQUIRED |
| ✅ | permissions:普通用户禁建写控节点 | code=FORBIDDEN_ROLE |
| ✅ | channels:创建 | ok |
| ✅ | channels:读取 |  |
| ✅ | channels:更新 | ok |
| ✅ | messages:发送(或无 lead 频道的明确指引) | ok |
| ✅ | events:事件流端点(空频道允许为空) | count=0 |
| ✅ | tasks:创建 | ok |
| ✅ | tasks:判重或 mock 秒终后新建(均为正确语义) | same=false,tA=COMPLETED |
| ✅ | queue:队列视图 |  |
| ✅ | dcw:节点/配方/批次聚合 | nodes=69,recipes=46 |
| ✅ | dcw:线1运行中(T7 复启批次) | run=rr-7fee6,tagged=92455 |
| ✅ | dcw:重复开线被拒(运行门) | 产线「演示线1·挤出主机PLC(Modbus TCP)」已在运行(批次 rr-7fee6f37),请 |
| ✅ | dcw:写历史留痕 | rows=60 |
| ✅ | dcw:批次台账 | rows=162 |
| ✅ | daq:控制器在线 | nodesOnline=67/82 |
| ✅ | daq:真实时序样本 | points=11,最新=207.81℃ |
| ✅ | daq:告警面 |  |
| ✅ | daq:基础设施(mqtt/tsdb/oss) | {"infra":{"mqttOnline":true,"tsdbOnline":true,"objectStoreOnline":true,"degraded |
| ✅ | daq:不存在节点报错 | {"code":"NOT_FOUND","message":"数采节点不存在: dn-notexist","data": |
| ✅ | tools:my_industrial_nodes 正向 | #### ◇ 演示·挤出主机PLC(Modbus TCP)·熔体温度 [id=dn-0183240d] |
| ✅ | tools:dcw_control 已禁用(v2 守卫) |  |
| ✅ | tools:未知工具报错 |  |
| ✅ | tools:ops_log 运维记录可读 |  |
| ✅ | tools:绑定清单 | count=385 |
| ✅ | hitl:待办快照可用 |  |
| ✅ | ops:运维日志 | count=10 |
| ✅ | audit:审计面 |  |
| ✅ | memory:频道记忆可读 | count=50 |
| ✅ | plugins:插件目录 | count=14,样例=line-sentinel,ops-notifier,sample-insight |
| ✅ | teams:团队面 |  |
| ✅ | notifications:通知面 |  |
| ✅ | memory:语义检索(断流) | hits=5 |
| ✅ | cleanup:删测试频道 | ok |
| ✅ | cleanup:删测试用户 | ok |
| ✅ | 功能矩阵汇总(44 pass / 0 fail) | exit=0 |

## S2 多源异构 + MES 双模式(11/11)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 标量镜像入库(称重克重) | 2min 桶=9 |
| ✅ | 向量帧入库(壁厚轮廓) | 5min 帧=5 |
| ✅ | 图像帧入库(CCD) | 5min 帧=10 |
| ✅ | 图像 sha256 完整性指纹(P0 回归) | 10/10 帧带指纹 |
| ✅ | MES 镜像路(http 数采) | 2min 桶=9 |
| ✅ | MES 直取路(mes_fetch) | MES 历史取数(内联同步,1 个点位,窗口 10-07 19:34:26 ~ 10-07 19:49:26): |
| ✅ | 协议族 modbus-tcp 在采 | 演示·挤出主机PLC(Modbus TCP)·加热区2SP(7 桶/3min) |
| ✅ | 协议族 modbus-rtu 在采 | 演示·晶点计数从站(Modbus RTU)·晶点计数(7 桶/3min) |
| ✅ | 协议族 opcua 在采 | 演示·熔体泵送单元(OPC UA)·MeltPressure(7 桶/3min) |
| ✅ | 协议族 mqtt 在采 | 演示·在线测厚仪(MQTT)·thick(7 桶/3min) |
| ✅ | 协议族 http 在采 | 演示·CCD检测站(HTTP)·defect(7 桶/3min) |

## S3 治理负路径(3/3)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 越界写被拒(工艺安全量程) | 设定值 999bar 超出上限 节点工艺安全量程 的 90bar —— 约束层:节点安全量程(当前有效写入区间 30~90bar;各层限界按安全规约取交集,越界写入已拒绝) |
| ✅ | 未知驱动显式拒绝(mock 封堵,P0 回归) | 服务器内部错误 |
| ✅ | testDriver 未知协议拒绝 | 服务器内部错误 |

## S4 闭环优化场景 · 全过程时间线(7/7)

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 镜像观测有效(克重/缩痕) | weight=32.61g sink=1.14% |
| ✅ | 控制律出步(目标 32.5±0.35) | 64 → 63 |
| ✅ | HITL 卡出现且含推理依据 | card=ap-a5952f8b |
| ✅ | HITL 裁决通过(附裁决意见) | ok |
| ✅ | 提案批准并整批下发 | 方案「BM-保压微降(纠偏步)」已获批准并整批下发(1/1 参数成功,批次 rr-08dcb)。runId:rr-08dcb26f(后续轮次按此回访效果并回写经验) |
| ✅ | 批次台账 holdP 落账 ok | run=rr-08dcb26f |
| ✅ | 三方核验(配方|设备|镜像)一致 | 配方=63 设备=63 镜像=63 |

**过程记录(observation → decision → propose → HITL → dispatch → verify → verdict):**
| 时刻 | 事件 | 明细 |
|---|---|---|
| 19:49:26 | observation | {"holdP":64,"weight":32.61,"sink":1.14,"window":"8min"} |
| 19:49:26 | decision | {"mode":"converged-bounded-zigzag","err":-0.11,"to":63,"rationale":"已收敛,围绕基准设定点 63 做有界激励步以实证闭环下发链路"} |
| 19:49:26 | propose | {"to":63,"package":"BM-保压微降(纠偏步)"} |
| 19:49:28 | hitl_card | {"id":"ap-a5952f8b","reasoning":true,"attempt":1} |
| 19:49:28 | approved | {"id":"ap-a5952f8b","attempt":1} |
| 19:49:28 | cadence-wait | 试验节拍窗未放行(治理在岗)—— 等 218s 后重提(attempt 1 → 2) |
| 19:53:06 | propose | {"to":63,"package":"BM-保压微降(纠偏步)","attempt":2} |
| 19:53:08 | hitl_card | {"id":"ap-1c68c970","reasoning":true,"attempt":2} |
| 19:53:08 | approved | {"id":"ap-1c68c970","attempt":2} |
| 19:53:08 | dispatch | {"runId":"rr-08dcb26f","ok":true,"summary":"方案「BM-保压微降(纠偏步)」已获批准并整批下发(1/1 参数成功,批次 rr-08dcb)。runId:rr-08dcb26f(后续轮次按此回访效果并回写经验)"} |
| 19:53:16 | settle-wait | 等待镜像 SP 采样跟上(15s) |
| 19:53:31 | verify | {"set":63,"device":63,"mirror":63,"threeWay":true} |
| 19:53:31 | verdict | {"converged":true,"dispatchedTo":63,"nextReview":"4min 惯性窗后复测"} |

## S5 稳定微调场景 · 全过程时间线(4/4)

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 单变量小步修正(治理链内) | 42.5 → 43 写入并回读一致:43 → raw 43,回读 43(标定后物理值 43) |
| ✅ | 立即反向写被频控/保持窗拦截 | DCW 节点「注塑·模温机SP」两次在线写入间隔必须至少 60s，当前还需 60s |
| ✅ | 窗后回退到原值 | 43 → 42.5 写入并回读一致:42.5 → raw 42.5,回读 42.5(标定后物理值 42.5) |
| ✅ | 复原判读(节点值=原值) | value=42.5 |

**过程记录:**
| 时刻 | 事件 | 明细 |
|---|---|---|
| 19:53:31 | observation | {"moldT":42.5,"stepLimit":10} |
| 19:53:31 | micro-step | {"from":42.5,"to":43,"ok":true,"readback":43} |
| 19:53:31 | rate-limited | {"blocked":true,"message":"DCW 节点「注塑·模温机SP」两次在线写入间隔必须至少 60s，当前还需 60s"} |
| 19:53:31 | settle-wait | 等待 66s 治理窗放行 |
| 19:54:37 | verdict | {"restored":true,"value":42.5} |

## S6 数据诊断场景(4/4)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | daq_export 全窗宽表 | daqexp-20261008035437-3d7b60 |
| ✅ | 宽表行数达标(≥50 行) | rows=869 cols=14 |
| ✅ | 克重列统计有效 | n=869 mean=32.552 std=1.107 min=0.00 max=32.78 |
| ✅ | 规格内占比 ≥60%(32.5±0.35) | 99.9% (868/869) |

---
*机器可读结果见同目录 benchmark.json 与 timeline.jsonl;PIPELINE 源码 scripts/testing/run-benchmark.mjs。*
