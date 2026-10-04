# 全功能测试 + 实机演示报告(2026-10-04 晚,追加轮)

## P0 落实核查(运行时):8/8 到位
幻影清账 DB pending=0;凭据脱敏 0 泄漏;覆盖集语义 T6 已证;产线管理工具 T7 已证;判重/严格驱动/工具瘦身/锁心跳见前报告。

## 新测试结果
- **CLI**:aw --help 15 指令;doctor 全绿(唯一"异常"= 3001 被本服务占用,语义正确)
- **SDK**:test-sdk-surface 全过(agentworkshop@0.7.55 出口面完整)
- **插件**:插件清单 API 正常(line-sentinel/ops-notifier/sample-insight… + 内置 rag-bridge/serial-bridge/twin-injection 启动装载 13 个)
- **Channel 三模式**:goal ✅ loop(2轮)✅ pipeline(两阶段,Stage1 完成/Stage2 复核)✅
- **猜数字(HITL question 流)**:二分 7 猜命中 42(50→25→37→43→40→41→42),omp ask 对话框→人工应答全闭环 ✅
- **海龟汤**:6+ 轮是非题问答,COMPLETED ✅
- **AML MPC/贝叶斯**:hybrid_twin 频道注入 16 个孪生工具(vs legacy 60);AML 数据工程师已从真实数采构建数据集(646 行);MPC/贝叶斯被治理闸如实拦下:scene 发现不含配方绑定控制量(SCENE_NO_CONTROLS)→ 快照强制冻结场景(TWIN_CHANNEL_SCENE_NOT_FOUND)= 孪生专家"最后一公里未打通"的精确复现,已立 P1
- **过程控制(精调维持)**:GOAL 204.0±0.3 → worker 提案 z2 203.5→204.0(+0.5 小步,带实测依据)→ HITL 批准(ap-0d9bd6f1)→ 批次 rr-22397 下发 1/1 → COMPLETED;期间模拟器崩溃(数采断流→熔体 82℃ 瞬时)被 worker 如实判读不误动作,重启后自愈恢复 203.3
- **browser-use 实机演示**:登录→产线操作页实拍:统一实时流水(31 写控/42 配方/113 系统)同屏可见「整包方案审批后下发→写控下发→visual 人工批准」与 AML 建模数据集构建(截图 2 张存 artifacts)

## 优化曲线(2min 桶,熔体 dn-0183240d)
203.5 203.4 203.4 203.3 203.3 203.3 | 195.6 82.3(模拟器崩溃窗) | 203.3 → 精调 z2=204 → 惯性爬升至 203.4+
SP 轨迹:z1=200.6 恒定;z2:203.5→204.5(T6 试验)→203.5(开线恢复)→204.0(精调);z3=203.5

## 设计判断:Agent 集成控制是否真正成立?
**成立,且有真实证据**:四线四协议团队并行;worker 经 daq_query 取真实数据→带 basis/exp_ref 提案→人工批准→经治理联锁写 PLC→回读核销→复测判读;lead 有 line_start/stop/status 管理产线;HITL 双形态(审批/问答)都闭环;注入面按角色/绑定裁剪精准(hybrid 16 孪生工具 vs legacy 60)。
**尚不完美的两点(如实)**:①AML MPC/贝叶斯端到端被场景-控制量发现缺口挡住(治理正确但打通未完成,P1);②Channel 页面导航对"协同频道"的入口层级较深(workspace 概念对新用户不直观)。系统设计整体是优质的:安全咽喉点单一、审计四方一致、fail-closed 贯穿。
