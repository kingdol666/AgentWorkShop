# AgentWorkShop 全功能基准报告(benchmark-20261008045204)

- 执行:一键 PIPELINE `node scripts/testing/run-benchmark.mjs`(耗时 1 分钟)
- 系统:**v0.7.57** · 113 活跃频道 · 运行内存水位 0.0617
- 总分:**86 / 87 断言通过**(99 分)

| 阶段 | 内容 | 通过 | 断言 |
|---|---|---|---|
| S0 | 环境预检 | 6/6 | 服务/模拟器/数采/基准产线 |
| S1 | API 全表面功能矩阵 | 54/54 | auth/users/channels/dcw/daq/tools/hitl/ops/memory 负向+正向 |
| S2 | 多源异构 + MES 双模 | 11/11 | 标量/向量/图像(sha256)/镜像路/直取路 |
| S3 | 治理负路径 | 3/3 | 越界拒/mock 兜底封堵 |
| S4 | 闭环优化场景(optimize) | 4/5 | 观测→决策→提案→HITL→下发→三方核验 |
| S5 | 稳定微调场景(tuning) | 4/4 | 小步→频控→回退→复原 |
| S6 | 数据诊断场景(diagnose) | 4/4 | 导出→统计→规格占比 |


> ❌ 未通过项:请按下方各表定位;系统缺陷需修复后重跑 PIPELINE。


## S0 环境预检
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 服务健康 | version=0.7.57 uptime=4min |
| ✅ | PLC 模拟器(:4010) |  |
| ✅ | MES 模拟器(:15060) | alive |
| ✅ | DAQ 控制器在采 | nodes=67 |
| ✅ | 基准产线在册 | 注塑一线·克重窗口寻优 |
| ✅ | 基准线总闸切 auto(harness 显式 confirm) | got=auto |

## S1 API 全表面功能矩阵(54/54)
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
| ✅ | dcw:节点/配方/批次聚合 | nodes=77,recipes=52 |
| ✅ | dcw:线1运行中(T7 复启批次) | run=rr-7fee6,tagged=87471 |
| ✅ | dcw:重复开线被拒(运行门) | 产线「演示线1·挤出主机PLC(Modbus TCP)」已在运行(批次 rr-7fee6f37),请 |
| ✅ | dcw:写历史留痕 | rows=60 |
| ✅ | dcw:批次台账 | rows=180 |
| ✅ | dcw:批次 ACK 鉴定汇总(run.ackSummary) | {"verified":6,"unverified":0,"failed":0,"total":6} |
| ✅ | dcw:批次结果行携带 ack/verify 字段 | ack/verify 字段在批 |
| ✅ | dcw:写历史条目携带 ack 字段 | ack 字段在史 |
| ✅ | dcw:ACK 判定审计(recipe.dispatch.ack)落账 | ops 判定条目在账 |
| ✅ | dcw:线视图携带 controlMode(缺省归一 manual) | modes=manual,auto |
| ✅ | dcw:新建线缺省 manual(fail-safe) | got=manual |
| ✅ | dcw:manual→auto 无 confirm 拒绝(400) | MODE_CONFIRM_REQUIRED 切换到 auto 将摘除该节点逐次人工审批闸门,需显式风险确认:请求体须携带 c |
| ✅ | dcw:manual→auto 带 confirm 放行 | got=auto |
| ✅ | daq:控制器在线 | nodesOnline=67/82 |
| ✅ | daq:真实时序样本 | points=9,最新=207.87℃ |
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
| ✅ | auth:防爆破锁定(5 次失败后 429) | code=LOGIN_LOCKED 失败次数过多,账号已临时锁定,请约 15 分钟后再试 |
| ✅ | cleanup:删测试频道 | ok |
| ✅ | cleanup:删测试用户 | ok |
| ✅ | 功能矩阵汇总(53 pass / 0 fail) | exit=0 |

## S2 多源异构 + MES 双模式(11/11)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 标量镜像入库(称重克重) | 2min 桶=9 |
| ✅ | 向量帧入库(壁厚轮廓) | 5min 帧=5 |
| ✅ | 图像帧入库(CCD) | 5min 帧=10 |
| ✅ | 图像 sha256 完整性指纹(P0 回归) | 10/10 帧带指纹 |
| ✅ | MES 镜像路(http 数采) | 2min 桶=9 |
| ✅ | MES 直取路(mes_fetch) | MES 历史取数(内联同步,1 个点位,窗口 10-08 04:37:05 ~ 10-08 04:52:05): |
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

## S4 闭环优化场景 · 全过程时间线(4/5)

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 镜像观测有效(克重/缩痕) | weight=32.48g sink=1.19% |
| ✅ | 控制律出步(目标 32.5±0.35) | 62 → 63 |
| ✅ | HITL 卡出现且含推理依据 | card=ap-5c8bd0be |
| ✅ | HITL 裁决通过(附裁决意见) | ok |
| ❌ | 提案批准并整批下发 | 方案「BM-保压微升(灵敏度激励步)」已获批准并整批下发,全部参数设备证实(1/1,批次 rr-997c9)。runId:rr-997c9c1f(后续轮次按此回访效果并回写经验) |

**过程记录(observation → decision → propose → HITL → dispatch → verify → verdict):**
| 时刻 | 事件 | 明细 |
|---|---|---|
| 04:52:05 | observation | {"holdP":62,"weight":32.48,"sink":1.19,"window":"8min"} |
| 04:52:05 | decision | {"mode":"converged-bounded-zigzag","err":0.016,"to":63,"rationale":"已收敛,围绕基准设定点 63 做有界激励步以实证闭环下发链路"} |
| 04:52:05 | propose | {"to":63,"package":"BM-保压微升(灵敏度激励步)"} |
| 04:52:07 | hitl_card | {"id":"ap-5c8bd0be","reasoning":true,"attempt":1} |
| 04:52:07 | approved | {"id":"ap-5c8bd0be","attempt":1} |
| 04:52:07 | dispatch | {"runId":"rr-997c9c1f","ok":false,"summary":"方案「BM-保压微升(灵敏度激励步)」已获批准并整批下发,全部参数设备证实(1/1,批次 rr-997c9)。runId:rr-997c9c1f(后续轮次按此回访效果并回写经验)"} |

## S5 稳定微调场景 · 全过程时间线(4/4)

**断言:**
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | 单变量小步修正(治理链内) | 32 → 32.5 写入并回读一致:32.5 → raw 32.5,回读 32.5(标定后物理值 32.5) |
| ✅ | 立即反向写被频控/保持窗拦截 | DCW 节点「注塑·模温机SP」两次在线写入间隔必须至少 60s，当前还需 60s |
| ✅ | 窗后回退到原值 | 32.5 → 32 写入并回读一致:32 → raw 32,回读 32(标定后物理值 32) |
| ✅ | 复原判读(节点值=原值) | value=32 |

**过程记录:**
| 时刻 | 事件 | 明细 |
|---|---|---|
| 04:52:07 | observation | {"moldT":32,"stepLimit":10} |
| 04:52:07 | micro-step | {"from":32,"to":32.5,"ok":true,"readback":32.5} |
| 04:52:07 | rate-limited | {"blocked":true,"message":"DCW 节点「注塑·模温机SP」两次在线写入间隔必须至少 60s，当前还需 60s"} |
| 04:52:07 | settle-wait | 等待 66s 治理窗放行 |
| 04:53:14 | verdict | {"restored":true,"value":32} |

## S6 数据诊断场景(4/4)
| 判 | 断言 | 说明 |
|---|---|---|
| ✅ | daq_export 全窗宽表 | daqexp-20261008125314-915673 |
| ✅ | 宽表行数达标(≥50 行) | rows=678 cols=14 |
| ✅ | 克重列统计有效 | n=678 mean=32.492 std=0.042 min=32.37 max=32.62 |
| ✅ | 规格内占比 ≥60%(32.5±0.35) | 100.0% (678/678) |

---
*机器可读结果见同目录 benchmark.json 与 timeline.jsonl;PIPELINE 源码 scripts/testing/run-benchmark.mjs。*
