# AML 训练系统审计报告(2026-10-07)

> 任务:核验 AML 是否满足"训练纯读零下发、历史数据+物理知识训练、训练后模型供其他
> Channel 做 MPC/BO 虚拟试错优化"的生产要求;公开全部作业流程。

## 结论

架构与要求**吻合**,三类关键属性均有代码级与实测证据:

1. **训练纯读零下发(实测)**:数据集构建只调 `tsdb.queryTagged`(批次打标样本只读,
   dataset-builder.ts:179);全 AML 模块与工具对 dcw 下发路径**零调用**(静态扫描);
   训练进程只持数据集路径+作业目录,无产线凭据。真实训练期间对账:dcw 写账本
   3000/3000 条一致、journal 锚一致(期间唯一的 8 条新写 = 遗留活跃批次的**保写心跳**
   基线帧,与训练无关,actor 为空、值不变)。
2. **门禁 fail-closed(实测见证)**:门禁未过 → 作业 failed → **不登记模型实体**
   (models 表无新条目);评估是平台权威(aml_eval.py),不采信 Agent 自报。
3. **MPC/BO 已内置**:`twin_bayes_optimize`(UCB=μ−κσ 多轮收敛)+ `mpc_optimize`
   (候选枚举)+ `twin_trial`;全部经 VirtualTrial **纯仿真**(candidateExecuted:false,
   trial-service.ts:67 明示"simulated, not a sequence of PLC writes"),产出推荐证书,
   执行必回治理写咽喉(HITL+四层限界+频控)。

## 全作业流程(透明)

```
① 建模节点目录  aml_node_catalog → 列 daq 绑定节点(语义/量程/可作 role)
② 数据集构建    aml_dataset_build(spec: 三元组+nodes[{node_id,role}]+beat+窗口)
   └ 只读: tsdb.queryTagged(run 逐批,上限50万点) → 清洗(state/量程/Hampel)
     → beatMs 网格对齐 → 缺失率弃批 → 滑窗(不跨批) → byRun 切分
     → 归一化(train 统计) → 快照落盘+sha256+统计报告(控制→目标滞后互相关)
③ 训练提交      aml_job_submit(train.py 全文,必须 import amlkit;change_note 单组件纪律)
   └ uv python 独立进程;amlkit 唯一平台依赖;工件只许写 artifacts/(路径越界拒绝)
④ 平台评估      第二拍 aml_eval.py:one-step val/test + 闭环滚动 NRMSE(权威,非自报)
⑤ 门禁          G1 单步≤0.1 / G2 滚动≤0.25(mpc) / G3 泛化差≤20% / G4 ≥500行≥3批 / G5 契约ONNX
   └ 未过 → failed + 不登记模型;过 → 登记 candidate + 实验谱系(父实验/单组件标注)
⑥ 晋级投用      candidate →(HITL 人工审批)→ shadow →(影子证据+UQ/OOD+Twin Gate)→ production
   └ hybrid 禁 candidate→production 直跳;每 (product,recipe,purpose) 至多一个 production
⑦ 跨 Channel 消费  channel-profile.boundModelId(optimization_mode=aml)绑定
   └ twin_trial / mpc_optimize / twin_bayes_optimize(UCB 贝叶斯)
     → VirtualTrial: 控制候选校验(量程/步长/maxDelta)→ 模型 rollout → 约束+UQ/OOD 门
     → 基线对比;improvement>0 且全过 → 推荐证书(recommendation only)
⑧ 执行(可选)   推荐设定值 → 治理写咽喉(HITL 审批+四层限界+步长/60s/保持窗+配方频控)
持续学习        training-plans(auto)新批次完成自动重建数据集+训练(仅数据面;磁盘配额护栏)
what-if         POST /aml/models/:id/predict(需产线只读权限;实测 6 拍 forecast 正常)
```

## 输入输出定义(用户要求 vs 现状)

契约(canonical one-step,amlkit.py:11):输入 `history[N,120,nAll]` + 未来控制
`u[N,24,nCtrl]` → 输出 `y_next[N,nTgt]`;多步=闭环滚动(预测回填 history 的 target 列)。

- **输出=数采节点值**:✓ target 角色即数采节点(实测数据集目标=dn-0183240d 厚度)。
- **输入=数控的数值**:control 角色取的是**数采节点观测到的被控量**(如泵压实际值),
  不是 dcw 设定值本身——TSDB 只存数采样本,设定值不入时序库。观测被控量作操作变量
  代理是行业常规,但执行器偏差大时 u≠SP(差距进入残差,hybrid 可吸收)。
- **节点选择是显式的**(aml_dataset_build 传 nodes 数组),未从 Channel 绑定自动派生
  role(aml_node_catalog 辅助选点);Twin 场景层(scene-compile)才有绑定推导。

## 实测记录(本轮,演示线1 数据集 ds-muwa8d5a-o71oy8,18232 窗/4 批次)

- v1 提交:env 契约用错(AML_DATASET_PATH 不存在)→ 秒级失败,日志直指原因 ✓
- v2 提交:输出头导成 [B,24,1] 多步(契约是 [B,nTgt] 单步)→ **评估器拒绝**
  (non-broadcastable,评估门工作正常)✓
- v3 提交:契约正确 → 19s 训练 + 平台评估全产出(单步 val 0.7179/test 0.1893,
  滚动 0.1076@24)→ 门禁 G2✓ G4✓ G5✓ / G1✗(0.1893>0.1) G3✗(73.6%>20%) →
  fail-closed,未登记模型 ✓
- 零写对账:3000/3000+journal 锚一致;8 条新写=保写心跳(见结论 1)✓
- predict:shadow 模型 6 拍 forecast+假设声明 ✓

## 遗留问题与生产启用清单

| # | 问题/限制 | 等级 | 说明 |
|---|-----------|------|------|
| 1 | **Twin 虚拟试错只有 hybrid 模型能驱动**:ModelBackedHybridProvider 强制要求 hybrid_manifest(物理主干+残差集成);纯数据驱动模型在 trial/MPC 回退物理 provider(model_id 仅标签),BO 直接拒绝 | **P1 认知项** | 要走"训练→BO 虚拟试错"路线必须训 `job_kind=hybrid_residual`(平台有内置参考训练器,物理参数校准→残差→UQ);物理知识需求是真实的 |
| 2 | G3 泛化门对少批次 byRun 切分严苛(批次漂移主导时恒挂,本轮 73.6%) | 设计使然 | 宁严勿宽;解法=更多批次或 hybrid 物理主干吸收漂移,不是调阈值 |
| 3 | training-plans 自动重训无每线频次/总量上限(仅磁盘配额) | P2 | 生产开启 auto 策略前建议加节流;历史 F6(旧 plan 烧盘)已有配额+settle 兜底 |
| 4 | 训练 python 进程无网络出口沙箱 | P3 | 无产线凭据+工件路径受限,风险可控;严格隔离可用容器 |
| 5 | I/O 未从 Channel 绑定自动派生 role | P2 | 增强点:scene 绑定(数控→control/数采→target)自动生成 dataset spec 草稿 |
| 6 | 演示数据集 val 切分含最大 run(train 1292/val 16696),泛化评估偏保守 | P3 | byRun 切分按 run 数比例,批长悬殊时窗口分布不均;可加按窗配平 |

**生产启用路径**(回答"是否真正可以训练出可投入使用的模型"):
能,且链路已实证(历史轮:hybrid 模型过 G1-G7+Twin Gate+影子校准;本轮:全管线+fail-closed)。
前提三件:① 批次数据覆盖足够(G4/更多 run);② 用 hybrid_residual 让物理知识进模型
(BO/MPC 驱动的硬要求);③ 门禁+影子+HITL 晋级不跳步。

产物:tmp-e2e/aml-train-e2e.mjs(实测脚本)、aml-predict-probe.mjs、aml-audit-writes-{before,after}.json(对账快照)。
