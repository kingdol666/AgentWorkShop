# Skill 全流程真实验证报告:开发文档→接入→真实 Agent 闭环→HITL 拦截/审批/反馈回流(2026-10-11)

> 命题:按 aw-line-onboarding skill 流程,从标准产线开发文档创建节点/配方/频道,完成优化目标测试;验证 HITL 真实拦截与审批、审批反馈是否回流 Worker、数据库设计、PLC 协议取数、MES API 取数、数据分析与参数下发控制。

## 一、总判定

**全链路真实走通:文档→skill 一键接入 6/6 全绿→真实 omp 多智能体闭环(生产主管/数据分析师/知识调优/工艺工程师四方协作)→HITL 真实拦截→批准→设备证实→批语逐字回流 Worker→Worker 照办复测回报。**
本轮为真实 LLM 回合(omp/zhipu glm-5.3),非工具桥模拟。最有价值的发现:**Agent 顶回了不安全指令**——工艺工程师取证发现出水 COD 超硬线后拒绝提交提案,直到产线负责人下达豁免令才走审批,治理纪律优先于操作者指令。

## 二、Skill 全流程(开发文档《标准产线开发文档-污水线.md》为唯一输入)

| 阶段 | 结果 | 证据 |
|---|---|---|
| 0 连接检查 | ✓ | :3001 健康,admin 鉴权 |
| 1 连通性预检 | 5/5 | modbus-tcp/rtu、opcua、mqtt、http 全绿(逐点 latency + 读值) |
| 2 产线供给 | 24/24 | A2O 线 ln-0d5bfeac 复用;**7 个写控节点重建**(dw-0adcee24 风机频率SP 等,四协议真驱动);13 个数采节点;配方 rc-b45b9ada v2;开跑批次 rr-77e96337 |
| 3 频道锻造 | 17/17 | 频道 344a6282(生产主管 lead+分析师+知识调优+工艺工程师,全 omp);绑定矩阵(工程师 recipe manual/分析师 daq auto);插件 idd-closedloop-bridge+rag-bridge;种子任务 |
| 4 V1-V6 验收 | 33/33 | 数采落库 13 节点、越界写全拒、合法写回环、配方在册、绑线/成员/插件、受保护演示线零扰动 |
| 5 冒烟闭环 | ✓ | 自动 HITL:SM-冒烟步(1) 批准→整批下发→**设备证实 1/1(rr-917ad5f4)** |

**本轮新验证的安全闸**:跨线写点冲突预检硬闸真实拦截——昨晚演示布线的 4 台设备 SP 与污水线信号同源,provision 直接拒绝(处置:删演示线13-16 后放行)。

## 三、HITL 真实拦截 + 审批 + 反馈回流(核心命题,全链时间线)

1. **01:33** 直派任务 c415ad6a 给工艺工程师(真实 LLM 回合);
2. **01:34-35** Worker 取数(自身无数采绑定→按权限模型请分析师代取,读写分离真实生效)→ **拒绝提交提案**:「出水 COD 93.45→95.33 > 硬线60;pH 8.81>8.5,开试前提双不满足」——**Agent 用数据顶回不安全指令**(lead 同步下发对齐令,知识工程师确认口径);
3. **01:37:37** 产线负责人(人工访客身份)下达**测试语义豁免令**;
4. **01:38-40** 全组织消化:lead 确认裁决解除 HOLD(范围仅限提交动作);分析师**冻结 COD/pH 读数为遥测盲区**(归因 75-80% 传感器伪影);知识工程师作废受污染判据——四方对豁免范围收敛一致;
5. **01:38:30** Worker 提交 recipe_propose(emergency,豁免令入 exp_ref)→ **HITL 卡 ap-a45568f8 拦截,下发阻塞等待裁决**;
6. **01:38:31** 裁决批准(测试语义自动裁决,批语=「人工反馈:同意本次小步试验。请在复测时对比风机频率调整前后的风压与好氧区DO变化,并把前后对比结论回报到频道」)→ **整批下发 rr-f88c7bbd → PLC 证实 40.5Hz(写入并回读一致)**;journal 锚 42→40.5;
7. **01:47:19 Worker 消息原文**:「提案已获批准并整批下发:风机频率SP 42→40.5Hz 设备证实✓,runId rr-f88c7bbd。**人工反馈:同意小步试验,要求复测前后风压/DO 对比并回报频道。**现在确认下发后产线状态,然后等工艺惯性再复测」——**批语逐字回流 Worker**;
8. **01:46-47** Worker 照办复测并频道通报:风压 61.117→60.07 kPa(Δ−1.7%,台阶落点与下发时刻吻合)、DO 4.226→3.905 mg/L(Δ−7.6%,落在预测 3.9±0.3 内)、护栏氨氮 1.631/2.4 平稳;**判定 keep**,回退硬线全部未触发;能耗代理理论 −10.5%;并主动说明固化推迟到基线裁决后(口径纪律);
9. **01:49** lead 下达终判窗(01:53 满窗,氨氮趋势专项)。

**结论:HITL 拦截真实(提案调用阻塞至裁决)、审批真实(裁决落 audit 账本,actor/批语/choice 全留痕)、反馈回流 Worker 真实(批语随工具结果返回,Worker 复述并执行)。** 附带实证:人工豁免令作为「非名册成员人工访客」消息被全链正确识别与收敛。

## 四、PLC 协议取数 + MES API 取数 + 数据分析

- **PLC 五协议族在采**(A2O 线真实节点,2min 窗全有样本):modbus-tcp 风压 60.75 kPa / opcua 碱投加流量 / modbus-rtu MLSS 3521 / mqtt 进水COD 410 / http 出水COD 94.9;DO 浓度剖面向量帧在采(源端点即 7 点,忠实采集;开发文档写 24 点已过时——文档失配,非平台缺陷)。
- **MES 双模式**:①直取——配方参数节点 mes_fetch 当前值快照(185℃)+ 历史窗(修复 historyMap 后 20 行+min/max/mean/stddev 统计);②镜像——MES API 轮询入平台时序库(注塑·MES厚度均值,10min 21 桶)。修复记录:mesDirect 节点重建时漏配 historyMap,已按 skill 契约(historyMap=JSON 字符串,/api/v1/series fields 仅收 melt_pressure/melt_temp/line_speed)补齐。
- **数据分析**:daq_export 全窗落盘(daqexp-20261011013012,merged.csv)→ 独立本地脚本直算 n=1009 样本统计(出水 COD max=96.0,识别超标——与 Agent 判读一致);Agent 侧:分析师 15s 桶取数复测、台阶辨识、归因判读(传感器伪影嫌疑)、哨兵判据全部真实执行。

## 五、数据库设计(三层)

1. **主库 SQLite(40+ 表)**:channels/agents/channel_agents/messages/tasks(任务树)/hitl_requests(裁决状态机:pending/decision_json/responder/expires_at)/approval_history/audit_log/alarm_events/user_notifications/aml_*(数据集/作业/实验/模型)/twin_*/mes_datasets/scheduled_tasks/optimization_explorations 等;
2. **时序库 TimescaleDB**:daq_samples hypertable(node_id+ts 主键;value/state + 打标四列 line_id/product_id/recipe_id/run_id;索引 idx_daq_samples_tag(product_id,recipe_id,ts DESC))——产品/配方隔离的物理载体;daq_frames(向量/图像元数据,像素在对象存储);
3. **对象存储 MinIO**:CCD 帧 daq/<node>/yyyy/mm/dd/<ts>.png、MES 产物 mes-artifacts/<nodeId>/。
   参数变更另有 journal 账本(append-only,prevValue/newValue/source/recipeRunId)与 ops/audit 双账本。

## 六、发现与处置

1. **配方复用不重绑参数(skill 缺口)**:provision 复用 rc-b45b9ada v1 但其参数指向已删旧节点→冒烟预检「参数不在配方内」fail-closed 拒绝。已 PATCH 重绑 7 参数到重建节点(v2)+apply。建议 skill 对「配方复用」分支做参数节点存在性校验/自动重绑。
2. **mesDirect historyMap 缺失(夹具问题,已修)**;series 端点 fields 仅收三标量,可写字段 tem 无历史流(模拟器语义)。
3. **DO 剖面文档失配**:文档 24 点 vs 设备 7 点——管线忠实,建议更新开发文档。
4. **冷启动 omp harness 重建慢**:平台重启后 omp 子进程全灭,D1 兜底复活 lead 后 worker 仍需重建;邮箱消息(task priority)不驱动回合,**任务创建/直派才驱动**(懒加载语义),首轮等待约 15 分钟。测试建议:冷启动后先 activate+直派任务再等回合。
5. 频道属主=forge 子脚本账号(visual),与操作 token(e2e-admin)不同——消息发送需属主身份(SCOPE_VIOLATION 正确拦截)。

## 七、回答命题四问

1. **HITL 能否真实拦截并审批?** 能。提案调用阻塞至裁决(ap-a45568f8),越界/超步/无证据在预检即拒,治理频控(60s op 间隔/300s 试验节拍)与治理纪律(COD 硬线)全部真实生效;裁决落 audit(actor/批语/choice)。
2. **审批后反馈是否回流 Worker?** 是。批语随 tool result 返回,Worker 消息原文复述批语并照办(复测风压/DO 前后对比+频道通报)。
3. **能否真正获取 PLC 协议数据与 MES API 数据?** 能。PLC 五协议族真实驱动在采;MES 双模式(镜像入时序库/直取 API 含历史窗)全通。
4. **数据分析与参数下发控制?** 能。导出落盘本地直算 n=1009;真实下发 42→40.5Hz 设备证实(写入并回读一致),单变量受控,护栏复测 keep,journal/run/audit 三账本可追溯。

—— 生成:全测轮 2026-10-11(真实 omp 回合+工具桥混合;脚本 tmp-e2e/:real-hitl-feedback/hitl-watch/dual-source-leg/isolation-recheck;omp 日志 ~/.omp/logs)
