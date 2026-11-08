# Gate C · 交接声明 —— aw-doc-to-project skill 实测（2026-11-08）

## 实测输入
- 工况文档：`inputs/涂布线工况说明.md`（2# 挤出涂布线 CSL-2，5 点位，目标定量 28±1.5 g/m²）
- skill：`.agents/skills/aw-doc-to-project/SKILL.md`（+ 校验基准副本 `skills/aw-doc-to-project/`）

## 三门 ask 记录（如实）
| 门 | 状态 | 说明 |
| --- | --- | --- |
| Gate A 意图澄清 | 弹窗未应答 | 采用推荐默认：组 Project 跑通协同 / leaderHarness=mock / 非温度点位采样 5000ms / decimals=0.1；范围授权=任务书原文（"先建模拟PLC协议→连接→建Channel→建Project→跑通"） |
| Gate B 蓝图审签 | 弹窗未应答 | 按蓝图五清单执行（节点表/模拟方案/频道/Project 编组/治理档位，见 SKILL 执行记录与 inputs/ 配置）；**呈请追认** |
| Gate C 投用裁决 | 本声明 | 全部资源为模拟孪生测试线，**未投用**；投用由产线负责人裁决 |

## 落袋 id 清单（全部资源均在 :4001 隔离实例）
| 资源 | id |
| --- | --- |
| 孪生模拟设备（影子 :4034，modbus-tcp :37542） | `csl2-s7`（5 信号，tick 活性 ✓） |
| 产线 | `ln-61a4796f`（2#挤出涂布线-DOC2PROJ） |
| 写控节点 | `dw-65640d51` 涂布头温度SP（180~260℃，stepLimit 3，保写 120s）· `dw-a9a8a489` 收卷张力SP（100~400N，stepLimit 10） |
| 数采节点 | `dn-c4ecf149` 温度PV（2s）· `dn-701f9e44` 熔体压力PV（5s）· `dn-5c1c3201` 涂布定量PV（5s，自定义模板 daq-ct-ba82617a） |
| 配方 | `rc-2c5ac25d` 涂布基线配方（温度 210℃ / 张力 250N） |
| 频道 | `4fa3ec4c` 涂布分析频道（diagnose，只读零写，lead 绑 3 daq auto）· `4779bdf4` 涂布调优频道（tuning，hitl_governed，分析师绑 daq / 工艺工程师绑 dcw+recipe manual / **生产主管(lead)绑 dcw+recipe manual（项目内治理写收敛面）**） |
| Project | `b4eba4e5` CSL-2 涂布定量稳定优化（completed） |
| 工作项 | W1=`96978601`（approved）→ W2=`abe30705`（approved，dependsOn W1） |
| 台账 | `ar-b26cc88e` W1 分析报告（append-only） |

## 绑定矩阵与治理档位
- 分析频道 lead：daq×3 auto（只读面，零写工具）
- 调优频道：数据分析师 daq×3 auto；工艺工程师 dcw+recipe manual；生产主管 dcw+recipe manual（项目内 write_intent 消费者，P0-5 意图绑定申请者 + lead-only 工具）
- HITL：所有 SP 首绑 manual，逐动作审批；项目内设备写再叠加 write_intent（owner 批准）双闸
- 插件（调优频道）：idd-closedloop-bridge + rag-bridge；分析频道按模板缺省

## 实测证据链（run 6 = 权威轮，48/48）
1. 阶段 3：sim-twin 模式 B，csl2-s7 设备 5 信号，tick 活性自检 2/2 PASS（影子树 `D:\codes\ABO\plc-node-simulator-twin-4034`，未触碰共享 4010）
2. 阶段 4：provision 11/11（线/5节点/配方/开批/总控）→ forge 分析 5/5 + 调优 7/7 → verify-line **14/14**（V1 数采落库/V2 越界拒 268℃·430N/V3 合法写回环 213→213·260→260/V4 配方/V5 频道/V6 保护线零扰动）
3. 阶段 5：Project 编组（绑定/交付物/W1→W2 dependsOn/激活/plan 批准）
4. 阶段 6：W1 数采取证+台账+approved → W2 handoff 携 W1 真结论 + 无意图阴性(PROJECT_WRITE_INTENT_REQUIRED) + lead 申请/owner 批准 + HITL 卡批准 + **设备证实 SP→209.4℃ [证实✓] + 回读 209.40 收敛** + approved → 项目 completed + 5 类审计事件齐备

## 回退路径（按 id 逆序）
1. 项目 `b4eba4e5` 已 completed（无在飞工作项）；历史 run1-5 的 4 个同名 Project（draft/completed）可保留审计或取消
2. 删除两频道：`DELETE /api/workshop/channels/4fa3ec4c…` / `4779bdf4…`
3. 删配方 rc-2c5ac25d → 节点 dw/dn×5 → 线 ln-61a4796f
4. 影子模拟器：杀 :4034 进程树 + 删 `D:\codes\ABO\plc-node-simulator-twin-4034`
5. 自定义模板：DELETE daq template `ct-ba82617a`

## 投用复核清单（产线负责人裁决前必查）
- [ ] Gate A/B 的默认选择追认（本声明"三门 ask 记录"）
- [ ] 量程/stepLimit 与工艺规程复核（温度 ≤3℃/步、张力 ≤10N/步已按文档配置）
- [ ] driverConfig 当前指向模拟孪生 :4034——**直连真机前**按 aw-line-onboarding「阶段 7 割接六步」执行（只换 driverConfig 端点，治理配置零改动）
- [ ] 调优频道 worker 配置 omp 运行时（provider/model，本测试未启用 LLM 对话腿；编排为 mock 确定性档）
- [ ] 定量目标带 28±1.5 的收敛复测（W2 结论已声明由投用后持续观察承担）

## 过程记录（前 5 轮迭代，全部如实留档）
- run1：W2 治理写失败（project_request_write_intent 误用 worker 身份——lead-only 工具）→ 修正为 lead 申请
- run2：409 频道已被上轮项目占用（星型约束）→ 解绑后重跑
- run3：worker 无项目来源任务被拒（治理设计：执行者需持项目任务上下文）→ lead 补写控绑定
- run4：analysis_save 参数名错（summary 必填）
- run5：HITL 批准后节拍硬闸烧意图（等待重试逻辑只覆盖无卡分支）+ analysis_save 缺 line_id
- run6：**48/48 全绿**
