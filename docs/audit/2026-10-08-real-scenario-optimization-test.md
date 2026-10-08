# 真实场景优化测试轮报告(2026-10-08)

> 依据 `docs/testing/SYSTEM-TEST-SKILL.md`(v0.7.57+,含 2026-10-08 P0 生产化硬化 L13)执行的真实场景优化测试。
> 主题:真实取数 / 多源异构 / 下发控制(ACK 鉴定)/ recipe 控制与回退 / 全功能验证。
> 铁律遵守:**零系统代码改动**,仅新增测试脚本(`tmp-e2e/l11-live-probe.mjs`)与测试数据。

## 一、结论

**四腿合计 160/160 断言全绿** —— 真实取数、多源异构、下发控制(含 ACK 三级鉴定)、recipe 控制与回退、全功能矩阵在本轮全部实证通过。

| 腿 | 内容 | 结果 | 证据 |
|---|---|---|---|
| L13 | 写控 ACK 鉴定 + HITL 手动总闸专项(七腿) | **34/34** | 本报告 §2 |
| 多任务 | Agent 产线多任务 e2e(T0-T7) | **23/23** | 本报告 §3 |
| L11 | 多源异构取数只读实证(五协议+向量+图像+MES) | **12/12** | 本报告 §4 |
| PIPELINE | 一键基准 S0-S7(S1=API 矩阵 54) | **91/91** | `docs/benchmarks/benchmark-20261008140955/` |

环境:v0.7.57 生产模式 :3001(uptime 551min)· PLC 模拟器 :4010(castfilm)· MES 模拟器 :15060 · DAQ 67 节点在线/82 节点 77 有值。

## 二、L13 写控 ACK 鉴定 + HITL 手动总闸(34/34)

脚本:`node tmp-e2e/hardening-ack-gate.mjs`(自建资源用后清理)。

- **ACK 三级语义实证**:mock 写(transport-ack)经写后验证器 readNow 独立回读 → 升级 `readback-verified`(attempts:1);mqtt 断链 broker → `ok:false, ack:unverified`,不阻塞同批其余参数;mqtt 在线 broker → `ok:true, ack:transport-ack`,无读通道 3 次验证后如实 `unverified`(不虚报成功)。
- **批次三段汇总**:`run.ackSummary` = {verified,unverified,failed,total} 三种形态全部正确;写历史行携带驱动级 ack 字段。
- **判定落账分级**:全证实→ops `recipe.dispatch.ack` level=info;失败≥1→level=error(「证实 1/2,失败 1」);仅未证实→level=warn(「部分参数仅链路受理」)。
- **线级手动总闸**:新建线缺省 manual(fail-safe);manual→auto 无 confirm 拒绝(400 MODE_CONFIRM_REQUIRED),confirm:true 放行,auto→manual 自由;manual 线内 auto 绑定 recipe_apply 挂审批卡不执行,批准=整批下发全证实(6/6),拒绝=意见逐字回流。
- **线域定向触达**:审批卡创建即向该线 operate 用户投递 hitl_request 通知。
- **hold 超时模式**:security.hitl_timeout_mode=hold 时审批卡 expiresAt 为空、不自动拒,人工批准后正常执行;收尾恢复 reject(fail-closed 缺省)。

## 三、Agent 产线多任务 e2e(23/23)

脚本:`node tmp-e2e/agent-line-multitask-e2e.mjs`(真实 omp harness + 并行 HITL 裁决)。

- **T1 闭环优化作业**:line_context 产线全景 → daq_query 镜像观测(8min 窗)→ recipe_propose 五要素提案(带 emergency)→ 审批卡 ap-64809465 获批 → 整批下发**全部设备证实(1/1,批次 rr-ea0386d5)** → 镜像 SP 复测跟上。
- **T2 产线微调作业**:recipe_update 固化 v38(63→64,带原因)→ recipe_apply 人工批准整批下发 **6/6 设备证实**(modbus+mes-rest 混合配方,批次 rr-f8b89…)。
- **T3 回退作业**:recipe_versions 版本史 21 条可读 → recipe_rollback(dispatch=true)统一回退生成 v39 并**整批重下发 5/5 设备证实**。
- **T4 数据分析作业**:daq_export 全窗宽表落盘(daqexp-20261008220840)→ ops_log Agent 自查留痕(提案/下发/回退 20 条可见)→ recipe_log 变更史含 recipe.revert 归因。
- **T5 多协议读面**:双通道有数;五协议族矩阵在采(modbus-tcp 2/2、modbus-rtu 2/2、opcua 1/1、mqtt 1/1、http 1/1)。
- **T6 治理负路径**:不存在配方操作被拒;下发频控早拒(「上一次已批准距现在仅 0s,要求 ≥60s」);越界参数预检剔除(「全部候选方案无一参数通过限界校验,未提交审批、产线无任何变更」)。
- **T7 收尾**:recipe_update 恢复基准锚 63bar + 补回回退剪除的 MES 直取参数 → v40 整批下发 **6/6 设备证实**(批次 rr-5e1ab…)。

## 四、L11 多源异构取数实证(12/12)

脚本:`tmp-e2e/l11-live-probe.mjs`(只读探针,新增测试资产)。

| 断言 | 证据 |
|---|---|
| modbus-tcp 标量 2min 窗 | dn-767cae47 挤出主机 PLC·加热区2SP,25/25 桶,avg=227 |
| modbus-rtu 标量 2min 窗 | dn-a41c49cc 晶点计数从站,25/25 桶,avg=3 |
| opcua 标量 2min 窗 | dn-121838ac 熔体泵送单元·MeltPressure,25/25 桶,avg=18.7 |
| http 标量 2min 窗 | dn-79957615 CCD 检测站·defect,25/25 桶,avg=0.2 |
| mqtt 标量 2min 窗 | dn-b8ee4f86 在线测厚仪·thick,24/25 桶,avg=56.3 |
| 壁厚轮廓向量帧 | dn-f51aa073,48 点/帧,最新 14:07:28 |
| MES 剖面向量帧 | dn-f83d836c,48 点/帧,最新 14:07:27 |
| CCD 图像帧完整性指纹 | sha256=7b784e92… size=198 96×32(P0 回归:信封重建不丢字段) |
| 对象存储 UTC 取日 | daq/dn-2dbe6aa5/2026/10/08/1791468451285.png |
| 图像 content 回取 | 200,image/png(存储链路真可读) |
| MES 镜像路 | dn-954b6d7a 10min 20 桶,avg=52.93 |
| 实时值面 | 82 节点 77 带当前值 |

驱动族分布:modbus-tcp×14、modbus-rtu×13、opcua×14、mqtt×10、http×25、mock×6。MES 直取路(mes_fetch)在多任务腿 T5/PIPELINE S2 覆盖(11/11 含直取路断言)。

## 五、PIPELINE 一键基准(91/91)

产物:`docs/benchmarks/benchmark-20261008140955/`(report.md + benchmark.json + timeline.jsonl,耗时 3 分钟)。

- S0 环境预检 7/7(含基准线总闸 auto 自适应 + 配方参数面完整在锚自愈)
- S1 API 全表面矩阵 54/54(auth/users/channels/dcw/daq/tools/hitl/ops/memory 正负向)
- S2 多源异构+MES 双模 11/11(标量 9 节点/向量 5 帧/图像 10 帧 sha256 10/镜像路/直取路)
- S3 治理负路径 3/3(999bar 越界拒·安全量程 30~90;未知驱动显式拒绝,mock 封堵)
- **S4 闭环优化场景 7/7**:观测 weight=32.38g(误差 0.122 已收敛)→ 有界激励步 63→64 → 首提被频控早拒(**治理在岗,等 58s 重提**)→ HITL 获批 ap-7f3c12f2 → 整批下发 1/1 设备证实(rr-fe9f26f5)→ ACK `readback-verified` + ackSummary 全绿 → **三方核验 配方=64 设备=64 镜像=64** 一致
- **S5 稳定微调场景 4/4**:单变量小步 40→40.5 写入回读一致 → 立即反向写被 60s 频控拦(治理在岗)→ 窗后回退 40 复原
- **S6 数据诊断场景 4/4**:全窗导出 866 行 14 列 → 克重 mean=32.373 std=0.308 → **规格内占比 89.5%**(775/866,32.5±0.35)
- S7 报告落盘 ✓

## 六、发现与处置

1. **探针形状误判(非缺陷)**:samples 点形状为 `{at,avg,min,max,cnt}`(首版探针查 `v` 字段)、图像节点须按名称显式选择(`ccd ip16zqqe` 是标量节点,真图像节点为 dn-2dbe6aa5)。均已修正探针;记录供后续测试参考。
2. **频控早拒属预期治理**:多任务 T1 与 PIPELINE S4 首提均被 60s op-interval 锚早拒,按提示等待后重提成功 —— 治理在岗如实验证,非缺陷。
3. **无新系统缺陷**:本轮四腿零系统代码改动全绿。

## 七、提交

- 本轮新增:`tmp-e2e/l11-live-probe.mjs`(L11 实证探针)、本报告、benchmark 产物 `docs/benchmarks/benchmark-20261008140955/`。
- 前置基线:f8ed20b(多任务大考三件套)、1937a6c(ACK 鉴定+手动总闸实现)。
