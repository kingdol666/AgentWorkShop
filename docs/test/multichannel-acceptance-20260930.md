# 全功能端到端验收:多 Channel 并行 × 存储审计 × 中间层 × KB/IDD × AML(2026-09-30)

## 验收结论(对照标准)

| 标准 | 结果 | 证据 |
|---|---|---|
| 所有 Channel 按既定逻辑完成任务 | ✅ | 双 Channel 并行(真 omp 四成员×2),`MP-FINAL` 10/10:全部任务终态、闭环收口、根任务 COMPLETED |
| 闭环优化 | ✅ | 双线各走完 recipe_trial(整批 2/2 落 PLC)→ 复测判读「无可测增益」→ **统一回退**(PLC 恢复基线)→ 不虚增版本;审计 `recipe.trial` 带 recipeId+agent 归因,零治理拒绝 |
| 数据分析上传知识库 + 对知识库的使用 | ✅ | ch1 沉淀「tempA −6℃ 单变量试验闭环经验(无可测增益,已统一回退)」;ch2 沉淀两篇(含等价路径变体);检索(kb_agent sync)走 QDCVR 全流程逐字引用作答 |
| IDD 集成 | ✅ | 并行负载下 diag_run 发起→mock IDD 完成→diag_status 给出评分/结论/报告路径与 kb_agent 协同指令(此前一轮已实证报告入库+检索命中) |
| 物理真实模型数据修正 AML 训练和复用 | ✅ | bench P13 全链 23 项全绿:PhysicsSpec 骨架→激励→数据集→**hybrid_residual 训练(物理校准误差 29.1→0.37~0.44;3 成员集成;conformal 覆盖率 0.90=目标;ONNX 导出)**→门禁双过(G1 0.538≤0.60 / G2 0.698≤0.80)→模型注册落盘→**12 组模型背书虚拟试验**→场景门禁→HITL 两段晋升 production→**MPC 自动投用(未传 model_id)**→治理写回(单步限内)→PV 复测 |
| 产线镜像数据入专业时序库 | ✅(已是) | TimescaleDB 真库:`daq_samples` hypertable **15,855,388 行**(2026-09-17 起,每行带 line/product/recipe/run 批次标签)+`daq_frames` 320,078 行;本轮双线并行实时镜像再证(2h 各 4176+ 行) |

---

## ① 产线数据存储审计(SQLite vs Timescale)

**结论:时序镜像数据已经存 TimescaleDB,SQLite 只承担业务/关系数据——架构符合「专业时序库」要求,无需迁移。**

| 层 | 存储 | 内容 |
|---|---|---|
| 时序镜像 | **TimescaleDB**(postgres 127.0.0.1:5432/awshop) | `daq_samples`(hypertable,ts 按天 chunk;node_id/ts/value/state + line_id/product_id/recipe_id/run_id 批次上下文列);`daq_frames`(hypertable,帧元数据+metrics jsonb) |
| 降级仿真 | SQLite `data/daq-timeseries.sqlite` | 仅当 Timescale/infra 不可达时自动降级(storage/index.ts 工厂:DAQ_TSDB_URL/infra 判定,重连自动切回) |
| 业务数据 | SQLite `workshop.sqlite`(46 表)+ JSON 仓库 | agents/channels/tasks/audit_log/aml_*/twin_*/hitl/approval…;dcw-lines/params/recipes/products 等仓库 JSON |
| 帧二进制 | 对象存储(MinIO→本地磁盘 data/daq-objects 降级) | vector/image 帧载荷 |

保留策略:按 `daq.tsRetentionH` 定时清理(30min 周期)。改进建议(非必须):`daq_samples/daq_frames` 未启用 Timescale 原生列压缩(native compression),15.8M 行规模下可进一步压缩 5-10×。

## ② 数控/数采中间层解耦审计

**结论:已实现 PLC 与工艺参数通过中间层的真解耦。**

- `param-map.repo.ts`:工艺参数(语义面:key/单位/工程量/基准限界)→ 写控执行节点(PLC 面)的**显式绑定**;「用户/Agent 只面向参数读写,寄存器/数据类型/字节序等 PLC 细节全部封装在执行节点驱动配置内(单一事实源,参数面不透出)」;节点创建自动生成参数面、删除级联清理、lineId 派生自节点。
- 四层写入限界联锁:节点安全量程 ∩ 参数基准 ∩ 产品限界 ∩ 配方窗口,逐层收窄、拒绝点名约束层(bench P4f 断言无 register/dataType/driverConfig 泄漏 + 三层拦截点名 ✔)。
- 本轮 run4 bench P4f(参数面读写/标准转换/分层联锁/Agent param_control)**全过**。

## ③ 多 Channel 并行实弹(真 omp 引擎)

- 拓扑:2 条独立产线(各 2 数控+1 数采 mock)× 2 个「通用闭环优化频道」(各 4 名真 omp 成员,KB 开、治理全自动),goal 同时下发。
- `MP-FINAL` 10/10:双频道任务全终态;trial 整批落产线;诚实判读后统一回退(最终 PLC 双回 160);配方 id 全程稳定;零越界拒绝;审计归因完整。
- KB 闭环:ch1 一篇、ch2 两篇经验入库(标题含产线 id);kb_agent 检索返回 QDCVR 轨迹(Phase 0 改写→宽网向量→锁定候选→逐字引用)。
- Timescale 镜像:两线并行采样 2h 各 4176/4177 行落 hypertable。
- IDD:并行负载下 diag_run→完成(评分/结论/报告路径)。
- 过程观察(行为质量):ch1 试验假设直接引用知识库经验条目(exp-1c532d9eaee1 稳态偏置 +8.14℃);ch2 自主设计「单变量可回退增益可辨识性试验」并判定「增益不可辨识」——分析↔调整↔响应↔知识沉淀全链真实。

## ④ bench AML 投用链(run4:99 pass / 1 warn / 0 fail ✅)

命令:`AW_BENCH_MODE=1 node bench/pipeline.mjs --aml --base http://127.0.0.1:3998`(隔离 bench-home4)。
P13 23 项全绿(明细见上表);训练数字:seed 作业 done,G1=0.538(≤0.60)、G2=0.698(≤0.80);物理校准 29.1→0.44;复用链=12 组模型背书虚拟试验+场景门禁+HITL 双段晋升+MPC 自动投用+治理写回+PV 复测。

### 本轮排障实录(对复现者重要)

1. **前三次 bench 失败(21 fail)根因 = 未按执行卡设 `AW_BENCH_MODE=1`**:60s 在线写间隔/单步限/写保持窗的 bench 旁路依赖该 env(write.ts:69),且「必须在平台进程启动前存在」(PIPELINE.md §1.3,§169 明言不带它结果作废)。设对后一次全绿。
2. **4010/18830 僵尸模拟器**:残留 PLC 模拟器进程会让 `simUp` 复用旧引擎(预设失配→全写被拒)。重跑前 `taskkill //T` 清场。
3. **P4f 调度竞态护栏(已修)**:P4f 选中线若刚被 P4e 配方生命周期写过,60s 锁未过会误报——bench 已补「等锁清零重试一次」护栏(bench/pipeline.mjs,本轮提交)。
4. **bench 逐 seed 归因报表瑕疵(记录在案)**:双 seed 并行训练时,状态行可能把另一 job 的指标/状态错配(日志与作业工件显示两 job 均 done);门禁判定本身不受影响(以 done 且过门的模型为准)。
5. 训练方差:同配置不同轮 G2 在 0.70~1.32 间波动(torch 非确定性;220 行小数据集),门禁以场景档限为准——本轮过门值为 0.698。

## ⑤ 遗留与建议

- Timescale 原生列压缩未启用(建议项,非缺陷)。
- bench 逐 seed 状态归因错配(测试基建报表,建议后续把状态查询按 jobId 精确配对)。
- AML 训练方差:小数据集下 G2 波动大;生产投用前建议以更大激励批次量(数据集 ≥3 runs 的下限可再收紧)提高门禁裕度。
