# 闭环调优端到端实测报告 —— 混合产线(PLC 五协议 + MES REST) × 真实 omp harness

- **日期**:2026-10-02 · **平台**:AgentWorkShop v0.7.54(dev) · **执行**:omp lead(GLM-5.3-flash,零脚本剧本,真实 LLM 工具循环)
- **结论**:✅ 全链路打通 —— 多协议数据获取、recipe 提案、HITL 审批、双协议下发、物理响应复测、判读与经验回写,全程无人工干预执行步骤(仅审批卡人工裁决)。
- **配套产物**:优化过程曲线 [`assets/opt-curve-2026-10-02.svg`](./assets/opt-curve-2026-10-02.svg) · 隔离验收 `scripts/perm-isolation-e2e.mjs` · 曲线生成器 `scripts/render-opt-curve.mjs`

---

## 1. 实验环境(全部真实运行)

| 组件 | 端点 | 内容 |
|------|------|------|
| PLC 节点模拟器 | :4010 | `cast-film-physics` 数字孪生产线:5 设备 × 5 协议(Modbus TCP/RTU、OPC UA、MQTT、HTTP),plant-model 物理引擎积分产出 PV(热惯性/波动),内置 MQTT broker :18830 |
| MES REST 模拟器 | :15060 | 标量(melt_pressure/melt_temp/line_speed,1s 拍)/向量/图像/事件/表格全格式,确定性伪随机 + 15min 卷次阶跃,x-api-token 鉴权 |
| 平台 | :3000 | DCW/DAQ 网关、recipe 四层限界联锁、HITL 结构化审批卡、AEP 事件流、审计日志 |

## 2. 接线(节点绑定与授权)

- 演示线1(挤出流延)混合配方 `rc-efd5991e`:**PLC dw-679bb3d2 加热区1SP(193℃,modbus-tcp 写)+ MES dw-05f6ce78 泵转速(55rpm,mes-rest writeMap 单参数)** —— 一条配方同时驱动两类协议。
- omp lead 绑定:6 路 DAQ 观察(modbus×3 / mqtt / opcua / http)+ MES 读点(带 dataHook CSV 下沉)+ 混合配方(recipe 绑定,manual 模式)。
- 全部绑定经权限模型 v3 校验(绑定时点 grant 校验 + 绑线频道一致性);本实验 channel 属主为 admin。

## 3. 实验时间线(AEP 实时录制,2026-10-02 +08)

| 时刻 | 事件 |
|------|------|
| 23:19:28 | 产线切混合配方开跑(批次 rr-06769a7b),SP 基线 193℃ |
| 23:19:57 | R1 任务派发(多协议基线采集 + 整包提案) |
| 23:20:56~23:22:26 | Agent 执行:daq_query×3(modbus/mqtt/opcua)+ mes_fetch(MES REST) 基线采集 |
| 23:23:07 | 🙋 HITL 待办浮现(整包方案 ap-2d9bb1d3) |
| 23:23:08 | ✅ 人工批准 choice=0 → **2/2 参数下发成功,批次 rr-90e5b362**(PLC 193→195℃;MES 55 保持,单变量隔离) |
| 23:25:27 | R1 收口:交付含复测均值与变化方向 |
| 23:26:30~ | R2 任务:复测判读 → dcw_judge → 经验回写 |
| 23:29:5x | R2 收口(3 分钟):判读 **uncertain**(诚实科学)、共享记忆条目落库 |

## 4. 多协议数据获取验证(实验末尾实测,15 分钟窗)

| 协议 | 节点 | 均值 | 样本 |
|------|------|------|------|
| Modbus TCP | 熔体温度 dn-0183240d | 199.736℃ | 50 |
| Modbus TCP | 加热区3SP dn-405269f8 | 200℃ | 50 |
| Modbus RTU | 晶点计数 dn-a41c49cc | 3.866 个/m² | 50 |
| OPC UA | MeltPressure dn-121838ac | 15.914 MPa | 60 |
| MQTT | 测厚 thick dn-b8ee4f86 | 80.37 μm | 60 |
| HTTP | CCD defect dn-79957615 | 0.813 % | 60 |
| MES REST | 熔体压力 dw-1c9e0458 | 8.474 MPa(实时快照) | — |

**7/7 数据通道全部真实出数**;写入侧经审批后双协议落地实测(PLC 寄存器 195℃ + MES REST `multi/set` rot 字段)。

## 5. 优化过程与曲线

见 [`assets/opt-curve-2026-10-02.svg`](./assets/opt-curve-2026-10-02.svg):熔体温度 PV 实采曲线(67 点,15s 降采样)+ SP 配方阶跃线(193→195)+ 三条事件标注线(混合配方开跑/R1 审批发送/R2 复测窗口)。

- 基线(R1 采集,SP=193):熔体温度均值 **199.755℃**(极差 0.54℃);测厚 80.342μm;MES 压力 8.571MPa
- R1 方案(omp 自主提案):SP +2℃(195),单变量隔离;HITL 批准;批次 rr-90e5b362
- 复测(R2,SP=195):熔体温度均值 **199.716℃**(−0.039℃,无可辨识抬升);测厚 80.351μm(稳定);MES 压力 8.424MPa(量程内正常波动)
- 判读:**uncertain** —— 该产线熔体温度对 SP 呈低增益/大惯性特征,5~10 分钟窗不足以观测跟随;质量指标无劣化,不触发回退,保持 195℃ 留更长观察窗

## 6. Agent 行为质量观察(omp 真实 harness)

- 工具循环完全自主:daq_query(带批次口径/工况判读)→ recipe_propose(每参数 basis 引用数采证据、exp_ref 引用历史巡检交叉印证)→ 等待审批 → 复测 → 交付
- **单变量隔离意识**:R1 主动保持 MES 泵速不变以隔离变量,方案里写明理由
- **诚实判读**:R2 数据不支持"进步"即判 uncertain,不虚报 keep;发现下发 runId 无在册 DCW 优化记录(配方层下发不产生 DCW 记录)时**不强造记录**,按频道约定以交付+共享记忆留痕
- **经验回写**:「闭环调优 Round 2 判读:SP+2℃ 温度跟随未证实,质量指标稳定」写入团队共享记忆,供后续轮次检索

## 7. Channel 执行观察(AEP 实时流)

- 任务状态帧(SUBMITTED→COMPLETED)、agent 运行状态帧、HITL 待办/裁决帧全部实时可达(`aep-live.mjs` 捕获,本实验全程录制)
- 单轮任务耗时:R1 ≈5.5 分钟(含 HITL 等待),R2 ≈3 分钟(无审批环节);LLM 为 GLM-5.3-flash max 档,一轮推理 1~2 分钟属正常
- 权限模型 v3 同场验证:R1/R2 审批单按产线锚点定向推送;隔离验收 48 断言另行全绿(见 `scripts/perm-isolation-e2e.mjs`)

## 8. 已知事项(非阻塞)

1. R1 交付第 4 步复测文本在 artifacts 中被平台截断(内容已完整进入 AEP 轨迹与 R2 交付,建议后续核查 artifacts 长度限制)
2. SP→熔体温度增益极低为模拟器物理模型特性(加热区 SP 对熔体温度影响弱),非平台缺陷;如需更显著响应可在模拟器侧调整 plant-model 耦合系数
3. 终端显示中文偶发乱码为 Windows 控制台编码,平台内(审批卡/交付/记忆)均正常

## 9. 结论

**多协议适配(5 现场协议 + MES REST)、数据获取、recipe 提案、HITL 治理、双协议下发、闭环复测、判读与经验沉淀 —— 全部按设计工作。** 平台具备承载"Agent 主导的产线闭环调优"的完整能力面。
