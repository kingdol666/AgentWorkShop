# P0 优化后全功能大考:多源异构 × MES/PLC × Agent 集成 × 闭环 × IDD/RAG × 稳定微调

- 日期:2026-10-08(版本 v0.7.56-P0 构建 → 发版 v0.7.57)
- 方法:aw-line-onboarding skill 流程;注塑一线 ln-5b12e11a(4 协议族 + 多源异构 + MES 双模式,16 数采 + 6 数控节点);工具桥 Agent 面直调 + REST/SQL 双面核验;verify-line 六组验收
- 前序:[P0 落地轮](2026-10-08-p0-implementation-review.md)(3b908f2)

## 0 结论

**七条测试腿全部通过**(T1-T7,含 3 处测试资产盲区修复)。P0 五项修复在真实闭环里零复发:三方核验(配方|设备|镜像)63.0|63.0|63.0 全程一致;失败写不占位、保写产线门、治理窗落盘、mock 封堵全部在岗。闭环控制达到收敛判据(克重 32.54g,误差 -0.04g ≤ 0.15g),IDD 批筛完成、RAG 入库(A0-A7 全门控)+检索命中。

## 1 测试腿明细

### T1 多源异构镜像入库 ✅(12/12 断言)
开线跑批(rr-b7e6f54e,配方 v13/v15)→ 100s 采样积累:
- 标量 **13/13 节点**有样本(modbus-tcp/modbus-rtu/opcua/http 四协议族,含 MES 镜像 mesMean);Timescale `daq_samples` 2min **2805 行**
- 向量帧(profile 轮廓 + mesProf 镜像向量)**76 帧/3min** 入 `daq_frames`
- 图像帧(ccd)**30 帧/3min**,**20 新帧全部带 sha256+size 完整性指纹**(P0-2 新管线;修复点:`daq-runtime.ts` 信封重建曾丢字段),像素对象 19 个新文件落盘
- 期间修复:mesProf 实为向量形态(jsonPath 指 profile 数组)——T1 首版断言对象搞错,非平台缺陷

### T2 MES API 双模式 ✅
- **镜像路**:`daq_query`(mesMean)从平台时序库读 —— Agent 零 API 感知
- **直取路**:`mes_fetch`(dwMes mes-rest,15min 窗)直调 MES API 历史 —— 内联同步返回

### T3 Agent 集成全链 ✅(8/8)
daq_query 取数(镜像观测 克重 32.48g/缩痕 1.17%)→ 控制律算步(62→63,0.052g/bar)→ **recipe_propose 五要素整包提案**(basis=保压是补缩第一控制量 + exp_ref=KB 实证)→ **HITL 结构化卡含完整推理**(ap-f124e60f)→ 并行批准(附人类反馈 comment)→ trial 整批下发 **1/1 成功(rr-ae5b1a9a)**→ **三方核验 配方=63.0 设备=63.0(OPC UA 直读) 镜像=63.0(dn.spP 采样)** → 审批留痕含人类 comment
- 越权证据:daq_query 传未绑定 id 组合 → fail-closed 拒绝并列出授权面(设计行为)
- 方法论:**并行 HITL 裁决法**——recipe_propose 阻塞等待审批,脚本必须后台轮询 pending 卡并行应答

### T4 闭环控制(第二轮判读)✅
holdP=63 后克重 **32.54g(err -0.04g ≤ 0.15 收敛判据)**、缩痕 1.14% —— 判定达标,**不下发**(避免无谓震荡,如实记录固化建议)。试验节拍 ≥300s 治理在岗。

### T5 IDD + RAG 集成 ✅(4/4)
- `daq_export` merged CSV(daqexp-20261008022516-8ee03c)→ 交换目录
- **IDD `sentinel_watch` 批筛 completed**(60 条筛检发现——处于主动调参窗,含微扰段,符合预期)
- **RAG `kb_agent` 异步入库完成**:kbt_muyfvrr8_6bfc9464,**A0→A7 全门控通过**,路由判中 `aw-industrial` 库
- **RAG 同步检索命中新知**(引用本轮记录回答三方核验与当前保压值)

### T6 稳定微调模式 ✅(5/5)
单变量小步(模温 32→32.5,≤stepLimit)回读一致 → **立即反向写被 429 拦**(保持窗/60s 间隔治理)→ 窗过后回退 32.5→32 回读一致 → 节点值=原值。写控经治理链全程留痕(锚点 8 条,受保护线零溢出)。

### T7 verify-line 六组验收 ✅ **26/26**
V1 数采落库(16 节点,含 3 帧节点回查帧面)/ V2 越界拒(moldT 75→拒,screw 192→拒)/ V3 合法写回环(回读一致)/ V4 配方在册(v15,6 参数)/ V5 频道绑线+成员+双插件 / V6 受保护演示线零扰动(写锚点全落新线)。
- 期间修复 `scripts/onboarding/verify-line.mjs`:V1 对向量/图像节点回查 `daq_frames`(多模态盲区,非平台缺陷);V3 扰动后已恢复设定点(screw 120/moldT 32)

## 2 P0 修复的现场回归证据

| P0 项 | 本轮现场证据 |
| --- | --- |
| 保写心跳根治 | 三方核验全程一致;换配/微调后无陈旧值直发;心跳产线门在岗(停线即挂起) |
| 失败写不占位 | T6 全程节点值只承载确认值;无幻影值入账 |
| mock 封堵 | 13/13 真实协议节点采样;无静默 mock 数据混入 |
| 对象 GC + sha256 | 20 新帧全带指纹;GC 周期在岗(前轮已证旧删新留) |
| OOM 自愈 | 服务以 respawn 监管运行,本轮无退出(水位 <20%) |

## 3 测试资产与产物

- 脚本(tmp-e2e/,不入库):ft-t1-heterogeneous.mjs / ft-t2t3-mes-agent.mjs / ft-t4t5t6.mjs / ft-verify-config.json
- 全程日志:tmp-e2e/ft-fulltest.log
- 导出产物:daqexp-20261008022516-8ee03c(merged CSV)→ IDD 交换目录
- KB 记录:kbt_muyfvrr8_6bfc9464(regime_key=inj-weight-ln5b-ft-fulltest)

## 4 遗留观察

- RAG 后端嵌入 CUDA OOM(已知基建项,不影响入库/检索主路径——外部 LLM 熔断为暂态)
- sentinel 批筛 60 条发现属主动调参窗的正常筛出,产线稳态窗复筛可作后续对照
- P1 剩余(统一 data_query 路由/名义信号点/批次事务/daq 异步数据集)维持独立排期
